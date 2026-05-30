// TASK-034 — Health dashboard service (server-side).
//
// Aggregates operational status from existing DB models (Mailbox,
// TelegramMapping, GraphSubscription, ProcessedMessage) and from static repo
// wiring (email worker entrypoint). It is strictly READ-ONLY: it never mutates
// any mailbox/subscription/worker state and never starts a worker.
//
// SECURITY (docs/SECURITY_RULES.md + TASK-034):
//   - Whitelisted Prisma selects only. encryptedRefreshToken, microsoftUserId,
//     GraphSubscription.clientStateHash / subscriptionId / resource and any
//     token/secret are NEVER selected.
//   - Last error strings are redacted + truncated before they reach the UI.
//   - `.env` / `.env.local` are never read. Only package.json + scripts/ dir
//     are inspected to detect the email-worker production entrypoint.

import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { prisma } from '@/lib/prisma';
import { loadEnv, type AppEnv } from '@/lib/env';
import { redactSensitiveText } from '@/lib/security/redact';
import type {
  GraphSubscriptionStatusValue,
  MailboxProviderValue,
  MailboxStatusValue,
  TelegramMappingStatusValue,
} from '@/services/microsoft/mailbox-list.service';
import type {
  HealthDashboardData,
  HealthLevel,
  HealthLoadResult,
  HealthOverview,
  MailboxHealthRow,
  OperationalCheck,
  OperationalCheckStatus,
} from './health.types';

// ---------------------------------------------------------------------------
// Thresholds (named constants — no magic numbers)
// ---------------------------------------------------------------------------

const ONE_MINUTE_MS = 60_000;
const ONE_HOUR_MS = 60 * ONE_MINUTE_MS;

/** Subscription is "expiring soon" when under this window. */
export const SUBSCRIPTION_EXPIRING_SOON_MS = 24 * ONE_HOUR_MS;

/**
 * Delta polling is a *backup* worker (webhook is primary), so the stale window
 * is generous. A mailbox polled longer ago than this is flagged WARNING, never
 * CRITICAL on its own.
 */
export const DELTA_POLLING_STALE_MS = 15 * ONE_MINUTE_MS;

/** Window used to decide whether a Telegram failure is "recent". */
export const TELEGRAM_FAILURE_RECENT_MS = 24 * ONE_HOUR_MS;

/** A burst of recent Telegram failures escalates the check to CRITICAL. */
export const TELEGRAM_FAILURE_CRITICAL_COUNT = 5;

const LAST_ERROR_MAX_LENGTH = 160;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function isOlderThan(date: Date | null, ageMs: number, now: Date): boolean {
  if (!date) return false;
  return now.getTime() - date.getTime() > ageMs;
}

function sanitizeErrorMessage(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const redacted = redactSensitiveText(String(raw)).trim();
  if (redacted.length === 0) return null;
  if (redacted.length <= LAST_ERROR_MAX_LENGTH) return redacted;
  return `${redacted.slice(0, LAST_ERROR_MAX_LENGTH - 1)}…`;
}

function deriveTokenStatus(status: MailboxStatusValue): string {
  switch (status) {
    case 'RECONNECT_REQUIRED':
      return 'Reconnect required';
    case 'ERROR':
      return 'Error';
    case 'WEBHOOK_FAILED':
      return 'Webhook failed';
    case 'SUBSCRIPTION_EXPIRED':
      return 'Subscription expired';
    case 'DISABLED':
      return 'Disabled';
    default:
      return 'OK';
  }
}

// ---------------------------------------------------------------------------
// Pure classifiers (unit-tested independently of Prisma)
// ---------------------------------------------------------------------------

export interface MailboxHealthInput {
  status: MailboxStatusValue;
  provider: MailboxProviderValue;
  hasActiveTelegramMapping: boolean;
  subscriptionStatus: GraphSubscriptionStatusValue | null;
  subscriptionExpiresAt: Date | null;
  lastPolledAt: Date | null;
  deltaLastErrorAt: Date | null;
  recentTelegramFailureCount: number;
  now: Date;
}

/**
 * Classify a single mailbox. Precedence is CRITICAL > WARNING > OK; UNKNOWN is
 * reserved for "intentionally off" (DISABLED) or "not enough data to judge".
 */
export function classifyMailboxHealth(input: MailboxHealthInput): {
  level: HealthLevel;
  reasons: string[];
} {
  const reasons: string[] = [];
  const isMicrosoft = input.provider === 'MICROSOFT';
  const subscriptionExpired =
    input.subscriptionStatus === 'EXPIRED' ||
    (input.subscriptionExpiresAt !== null &&
      input.subscriptionExpiresAt.getTime() <= input.now.getTime());
  const subscriptionExpiringSoon =
    !subscriptionExpired &&
    input.subscriptionExpiresAt !== null &&
    input.subscriptionExpiresAt.getTime() - input.now.getTime() <
      SUBSCRIPTION_EXPIRING_SOON_MS;

  // --- CRITICAL signals ---
  if (input.status === 'RECONNECT_REQUIRED') reasons.push('Reconnect required');
  if (input.status === 'ERROR') reasons.push('Mailbox in ERROR state');
  if (input.status === 'WEBHOOK_FAILED') reasons.push('Webhook failed');
  if (input.status === 'SUBSCRIPTION_EXPIRED' || subscriptionExpired) {
    reasons.push('Graph subscription expired');
  }
  if (input.recentTelegramFailureCount > 0) {
    reasons.push(
      `${input.recentTelegramFailureCount} recent Telegram send failure(s)`,
    );
  }
  const hasCritical =
    input.status === 'RECONNECT_REQUIRED' ||
    input.status === 'ERROR' ||
    input.status === 'WEBHOOK_FAILED' ||
    input.status === 'SUBSCRIPTION_EXPIRED' ||
    subscriptionExpired ||
    input.recentTelegramFailureCount > 0;
  if (hasCritical) return { level: 'CRITICAL', reasons };

  // DISABLED is an intentional admin state, not a fault.
  if (input.status === 'DISABLED') {
    return { level: 'UNKNOWN', reasons: ['Mailbox disabled'] };
  }

  // --- WARNING signals ---
  if (subscriptionExpiringSoon) reasons.push('Subscription expiring within 24h');
  if (!input.hasActiveTelegramMapping) reasons.push('No active Telegram mapping');
  if (isMicrosoft && input.subscriptionStatus === null) {
    reasons.push('No Graph subscription');
  }
  if (isMicrosoft && isOlderThan(input.lastPolledAt, DELTA_POLLING_STALE_MS, input.now)) {
    reasons.push('Delta polling stale');
  }
  if (input.deltaLastErrorAt !== null) reasons.push('Recent delta polling error');

  const hasWarning =
    subscriptionExpiringSoon ||
    !input.hasActiveTelegramMapping ||
    (isMicrosoft && input.subscriptionStatus === null) ||
    (isMicrosoft && isOlderThan(input.lastPolledAt, DELTA_POLLING_STALE_MS, input.now)) ||
    input.deltaLastErrorAt !== null;
  if (hasWarning) return { level: 'WARNING', reasons };

  return { level: 'OK', reasons };
}

export interface EmailWorkerWiringEvidence {
  /** Whether repo wiring could be inspected at all (fs reachable). */
  canInspect: boolean;
  /** A package.json script that starts an email worker exists. */
  hasNpmScript: boolean;
  /** A scripts/ runner file for the email worker exists. */
  hasRunnerFile: boolean;
}

/**
 * Classify whether the production email worker is actually wired to run.
 *
 * The `createEmailWorker` factory + the real `processGraphMessageJob` pipeline
 * both exist, but a factory that nothing starts processes zero jobs. We treat
 * the presence of a production entrypoint (npm script + runner file) as the
 * evidence of a real wiring — and refuse to report PASS without it.
 */
export function classifyEmailWorkerWiring(
  evidence: EmailWorkerWiringEvidence,
): { status: OperationalCheckStatus; detail: string } {
  if (!evidence.canInspect) {
    return {
      status: 'UNKNOWN',
      detail:
        'Could not inspect repository wiring to confirm the email worker entrypoint.',
    };
  }
  if (evidence.hasNpmScript && evidence.hasRunnerFile) {
    return {
      status: 'PASS',
      detail:
        'Email worker has a production entrypoint (npm script + runner) wired to the Graph message pipeline.',
    };
  }
  if (evidence.hasNpmScript || evidence.hasRunnerFile) {
    return {
      status: 'WARNING',
      detail:
        'Email worker wiring is incomplete: factory exists but the production entrypoint (npm script + runner) is only partially present.',
    };
  }
  return {
    status: 'CRITICAL',
    detail:
      'createEmailWorker exists but has no production entrypoint (no worker:email npm script / runner). Webhook & delta-polling jobs are enqueued but no running worker consumes them.',
  };
}

export interface SubscriptionInfo {
  status: GraphSubscriptionStatusValue;
  expiresAt: Date;
}

export function classifySubscriptionRenewal(
  subscriptions: readonly SubscriptionInfo[],
  now: Date,
): { status: OperationalCheckStatus; detail: string } {
  if (subscriptions.length === 0) {
    return {
      status: 'UNKNOWN',
      detail: 'No Graph subscriptions recorded yet.',
    };
  }
  const expired = subscriptions.filter(
    (s) => s.status === 'EXPIRED' || s.expiresAt.getTime() <= now.getTime(),
  );
  if (expired.length > 0) {
    return {
      status: 'CRITICAL',
      detail: `${expired.length} subscription(s) expired.`,
    };
  }
  const expiringSoon = subscriptions.filter(
    (s) => s.expiresAt.getTime() - now.getTime() < SUBSCRIPTION_EXPIRING_SOON_MS,
  );
  if (expiringSoon.length > 0) {
    return {
      status: 'WARNING',
      detail: `${expiringSoon.length} subscription(s) expiring within 24h.`,
    };
  }
  return {
    status: 'PASS',
    detail: 'All subscriptions are active with more than 24h remaining.',
  };
}

export interface PollingInfo {
  provider: MailboxProviderValue;
  lastPolledAt: Date | null;
}

export function classifyDeltaPolling(
  mailboxes: readonly PollingInfo[],
  now: Date,
): { status: OperationalCheckStatus; detail: string } {
  const microsoftBoxes = mailboxes.filter((m) => m.provider === 'MICROSOFT');
  if (microsoftBoxes.length === 0) {
    return {
      status: 'UNKNOWN',
      detail: 'No Microsoft mailboxes to poll.',
    };
  }
  const polled = microsoftBoxes.filter((m) => m.lastPolledAt !== null);
  if (polled.length === 0) {
    return {
      status: 'WARNING',
      detail:
        'No delta polling activity recorded for any Microsoft mailbox — the backup poller may not be running.',
    };
  }
  const recentlyPolled = polled.some(
    (m) => !isOlderThan(m.lastPolledAt, DELTA_POLLING_STALE_MS, now),
  );
  if (recentlyPolled) {
    return {
      status: 'PASS',
      detail: 'At least one mailbox was delta-polled recently.',
    };
  }
  return {
    status: 'WARNING',
    detail: 'All Microsoft mailboxes are overdue for delta polling.',
  };
}

export function classifyTelegramReliability(
  recentFailureCount: number,
  everSent: boolean,
): { status: OperationalCheckStatus; detail: string } {
  if (recentFailureCount >= TELEGRAM_FAILURE_CRITICAL_COUNT) {
    return {
      status: 'CRITICAL',
      detail: `${recentFailureCount} Telegram send failures in the last 24h.`,
    };
  }
  if (recentFailureCount > 0) {
    return {
      status: 'WARNING',
      detail: `${recentFailureCount} Telegram send failure(s) in the last 24h.`,
    };
  }
  if (!everSent) {
    return {
      status: 'UNKNOWN',
      detail: 'No Telegram sends recorded yet.',
    };
  }
  return {
    status: 'PASS',
    detail: 'No recent Telegram send failures.',
  };
}

/**
 * Classify the BullMQ queue / Redis configuration. Presence-only: we never open
 * a socket here (a health page must not block) and never print the URL (it may
 * contain a password).
 */
export function classifyQueueRedis(
  redisConfigured: boolean,
  appEnv: AppEnv,
): { status: OperationalCheckStatus; detail: string } {
  if (redisConfigured) {
    return {
      status: 'PASS',
      detail:
        'REDIS_URL is configured for the BullMQ email queue (connectivity is not actively probed here).',
    };
  }
  if (appEnv === 'staging' || appEnv === 'production') {
    return {
      status: 'WARNING',
      detail:
        'REDIS_URL is not set — the email queue is falling back to a localhost default that will not work on staging/production.',
    };
  }
  return {
    status: 'UNKNOWN',
    detail: 'REDIS_URL is not set; using the localhost default for local development.',
  };
}

export function classifyWebhookHealth(
  mailboxStatuses: readonly MailboxStatusValue[],
): { status: OperationalCheckStatus; detail: string } {
  const failed = mailboxStatuses.filter((s) => s === 'WEBHOOK_FAILED').length;
  if (failed > 0) {
    return {
      status: 'CRITICAL',
      detail: `${failed} mailbox(es) in WEBHOOK_FAILED state.`,
    };
  }
  // There is no webhook-receipt log to confirm deliveries, so we cannot honestly
  // claim PASS — only that no mailbox is currently flagged as webhook-failed.
  return {
    status: 'UNKNOWN',
    detail:
      'No webhook-failed mailboxes, but receipt history is not tracked — delivery health cannot be confirmed.',
  };
}

const CHECK_TO_LEVEL: Record<OperationalCheckStatus, HealthLevel> = {
  PASS: 'OK',
  WARNING: 'WARNING',
  CRITICAL: 'CRITICAL',
  UNKNOWN: 'UNKNOWN',
};

/** Worst-wins aggregation: CRITICAL > WARNING > OK > UNKNOWN. */
export function aggregateOverallHealth(
  mailboxLevels: readonly HealthLevel[],
  checkStatuses: readonly OperationalCheckStatus[],
): HealthLevel {
  const levels: HealthLevel[] = [
    ...mailboxLevels,
    ...checkStatuses.map((s) => CHECK_TO_LEVEL[s]),
  ];
  if (levels.some((l) => l === 'CRITICAL')) return 'CRITICAL';
  if (levels.some((l) => l === 'WARNING')) return 'WARNING';
  if (levels.some((l) => l === 'OK')) return 'OK';
  return 'UNKNOWN';
}

// ---------------------------------------------------------------------------
// Email worker wiring evidence (impure — reads package.json + scripts/)
// ---------------------------------------------------------------------------

const EMAIL_WORKER_NAME_PATTERN = /(worker.*email|email.*worker)/i;
const EMAIL_WORKER_RUNNER_PATTERN = /(run-email-worker|email-worker.*runner)/i;

export function gatherEmailWorkerWiringEvidence(
  rootDir: string = process.cwd(),
): EmailWorkerWiringEvidence {
  try {
    const pkgRaw = readFileSync(join(rootDir, 'package.json'), 'utf8');
    const pkg = JSON.parse(pkgRaw) as { scripts?: Record<string, string> };
    const scripts = pkg.scripts ?? {};
    const hasNpmScript = Object.entries(scripts).some(
      ([name, cmd]) =>
        EMAIL_WORKER_NAME_PATTERN.test(name) ||
        EMAIL_WORKER_RUNNER_PATTERN.test(String(cmd)),
    );

    const scriptsDir = join(rootDir, 'scripts');
    let hasRunnerFile = false;
    if (existsSync(scriptsDir)) {
      hasRunnerFile = readdirSync(scriptsDir).some((file) =>
        EMAIL_WORKER_RUNNER_PATTERN.test(file),
      );
    }

    return { canInspect: true, hasNpmScript, hasRunnerFile };
  } catch {
    return { canInspect: false, hasNpmScript: false, hasRunnerFile: false };
  }
}

// ---------------------------------------------------------------------------
// DB aggregation
// ---------------------------------------------------------------------------

// Whitelisted projection. No token/secret/clientState fields are selected.
const MAILBOX_HEALTH_SELECT = {
  id: true,
  emailAddress: true,
  provider: true,
  status: true,
  ownerCustomerName: true,
  tokenLastRefreshedAt: true,
  lastSuccessfulSyncAt: true,
  deltaLastPolledAt: true,
  deltaLastErrorAt: true,
  deltaLastErrorMessage: true,
  customer: { select: { name: true } },
  telegramMappings: {
    select: { status: true },
  },
  graphSubscriptions: {
    orderBy: { expirationDateTime: 'desc' },
    take: 1,
    select: { status: true, expirationDateTime: true },
  },
} as const;

interface OverviewRuntimeSignals {
  lastProcessedEmailAt: Date | null;
  lastPollingRunAt: Date | null;
  lastRenewalRunAt: Date | null;
  lastErrorShort: string | null;
}

function buildOverview(
  rows: readonly MailboxHealthRow[],
  subscriptions: readonly SubscriptionInfo[],
  recentTelegramFailures: number,
  now: Date,
  overall: HealthLevel,
  runtime: OverviewRuntimeSignals,
): HealthOverview {
  const lastCodeSentAt = rows.reduce<Date | null>((latest, row) => {
    if (!row.lastCodeSentAt) return latest;
    if (!latest || row.lastCodeSentAt.getTime() > latest.getTime()) {
      return row.lastCodeSentAt;
    }
    return latest;
  }, null);

  const subscriptionExpired = subscriptions.filter(
    (s) => s.status === 'EXPIRED' || s.expiresAt.getTime() <= now.getTime(),
  ).length;
  const subscriptionExpiringSoon = subscriptions.filter(
    (s) =>
      s.status !== 'EXPIRED' &&
      s.expiresAt.getTime() > now.getTime() &&
      s.expiresAt.getTime() - now.getTime() < SUBSCRIPTION_EXPIRING_SOON_MS,
  ).length;

  return {
    totalMailboxes: rows.length,
    activeMailboxes: rows.filter((r) => r.mailboxStatus === 'ACTIVE').length,
    reconnectRequired: rows.filter(
      (r) => r.mailboxStatus === 'RECONNECT_REQUIRED',
    ).length,
    disabledOrError: rows.filter(
      (r) => r.mailboxStatus === 'DISABLED' || r.mailboxStatus === 'ERROR',
    ).length,
    subscriptionExpired,
    subscriptionExpiringSoon,
    missingTelegramMapping: rows.filter(
      (r) => r.telegramMappingStatus !== 'ACTIVE',
    ).length,
    pollingStale: rows.filter(
      (r) =>
        r.provider === 'MICROSOFT' &&
        isOlderThan(r.lastPolledAt, DELTA_POLLING_STALE_MS, now),
    ).length,
    recentTelegramFailures,
    lastCodeSentAt,
    lastProcessedEmailAt: runtime.lastProcessedEmailAt,
    lastPollingRunAt: runtime.lastPollingRunAt,
    lastRenewalRunAt: runtime.lastRenewalRunAt,
    lastErrorShort: runtime.lastErrorShort,
    overall,
  };
}

/**
 * Load the full health dashboard. Returns a discriminated result so the page
 * can render a safe error state instead of crashing if the DB is unreachable.
 */
export async function loadHealthDashboard(
  now: Date = new Date(),
): Promise<HealthLoadResult> {
  try {
    const [
      mailboxRows,
      sentGroups,
      failedGroups,
      processedAgg,
      renewalAgg,
    ] = await Promise.all([
      prisma.mailbox.findMany({
        orderBy: { createdAt: 'desc' },
        select: MAILBOX_HEALTH_SELECT,
      }),
      prisma.processedMessage.groupBy({
        by: ['mailboxId'],
        where: { status: 'SENT', sentToTelegramAt: { not: null } },
        _max: { sentToTelegramAt: true },
      }),
      prisma.processedMessage.groupBy({
        by: ['mailboxId'],
        where: {
          status: 'FAILED',
          createdAt: { gte: new Date(now.getTime() - TELEGRAM_FAILURE_RECENT_MS) },
        },
        _count: { _all: true },
      }),
      // Most recent email the pipeline processed (any status).
      prisma.processedMessage.aggregate({ _max: { createdAt: true } }),
      // Most recent subscription renewal across all subscriptions.
      prisma.graphSubscription.aggregate({ _max: { lastRenewedAt: true } }),
    ]);

    const lastSentByMailbox = new Map<string, Date | null>();
    for (const group of sentGroups) {
      lastSentByMailbox.set(group.mailboxId, group._max.sentToTelegramAt ?? null);
    }
    const failuresByMailbox = new Map<string, number>();
    for (const group of failedGroups) {
      failuresByMailbox.set(group.mailboxId, group._count._all);
    }

    const subscriptions: SubscriptionInfo[] = [];

    const mailboxes: MailboxHealthRow[] = mailboxRows.map((row) => {
      const subscription = row.graphSubscriptions[0] ?? null;
      const subscriptionStatus = subscription
        ? (subscription.status as GraphSubscriptionStatusValue)
        : null;
      const subscriptionExpiresAt = subscription?.expirationDateTime ?? null;
      if (subscription) {
        subscriptions.push({
          status: subscription.status as GraphSubscriptionStatusValue,
          expiresAt: subscription.expirationDateTime,
        });
      }

      const hasActiveTelegramMapping = row.telegramMappings.some(
        (m) => m.status === 'ACTIVE',
      );
      const telegramMappingStatus: TelegramMappingStatusValue | null =
        row.telegramMappings.length === 0
          ? null
          : hasActiveTelegramMapping
            ? 'ACTIVE'
            : 'DISABLED';

      const recentTelegramFailureCount = failuresByMailbox.get(row.id) ?? 0;
      const mailboxStatus = row.status as MailboxStatusValue;
      const provider = row.provider as MailboxProviderValue;

      const { level, reasons } = classifyMailboxHealth({
        status: mailboxStatus,
        provider,
        hasActiveTelegramMapping,
        subscriptionStatus,
        subscriptionExpiresAt,
        lastPolledAt: row.deltaLastPolledAt,
        deltaLastErrorAt: row.deltaLastErrorAt,
        recentTelegramFailureCount,
        now,
      });

      return {
        id: row.id,
        emailAddress: row.emailAddress,
        ownerCustomerName: row.ownerCustomerName,
        customerName: row.customer?.name ?? null,
        mailboxStatus,
        provider,
        tokenStatus: deriveTokenStatus(mailboxStatus),
        telegramMappingStatus,
        subscriptionStatus,
        subscriptionExpiresAt,
        lastSuccessfulSyncAt: row.lastSuccessfulSyncAt,
        lastPolledAt: row.deltaLastPolledAt,
        lastCodeSentAt: lastSentByMailbox.get(row.id) ?? null,
        lastErrorShort: sanitizeErrorMessage(row.deltaLastErrorMessage),
        level,
        reasons,
      };
    });

    const totalRecentFailures = Array.from(failuresByMailbox.values()).reduce(
      (sum, count) => sum + count,
      0,
    );
    const everSent = lastSentByMailbox.size > 0;

    // Runtime "last run" signals (read-only aggregates).
    const lastProcessedEmailAt = processedAgg._max.createdAt ?? null;
    const lastRenewalRunAt = renewalAgg._max.lastRenewedAt ?? null;
    const lastPollingRunAt = mailboxRows.reduce<Date | null>((latest, row) => {
      const polled = row.deltaLastPolledAt;
      if (!polled) return latest;
      return !latest || polled.getTime() > latest.getTime() ? polled : latest;
    }, null);
    const latestErrorRow = mailboxRows.reduce<
      { at: Date; message: string | null } | null
    >((latest, row) => {
      if (!row.deltaLastErrorAt) return latest;
      if (!latest || row.deltaLastErrorAt.getTime() > latest.at.getTime()) {
        return { at: row.deltaLastErrorAt, message: row.deltaLastErrorMessage };
      }
      return latest;
    }, null);
    const lastErrorShort = latestErrorRow
      ? sanitizeErrorMessage(latestErrorRow.message)
      : null;

    const { values: envValues } = loadEnv();
    const redisConfigured =
      typeof envValues.REDIS_URL === 'string' && envValues.REDIS_URL.length > 0;

    const emailWorker = classifyEmailWorkerWiring(
      gatherEmailWorkerWiringEvidence(),
    );
    const subscriptionCheck = classifySubscriptionRenewal(subscriptions, now);
    const pollingCheck = classifyDeltaPolling(
      mailboxes.map((m) => ({ provider: m.provider, lastPolledAt: m.lastPolledAt })),
      now,
    );
    const queueCheck = classifyQueueRedis(redisConfigured, envValues.APP_ENV);
    const telegramCheck = classifyTelegramReliability(totalRecentFailures, everSent);
    const webhookCheck = classifyWebhookHealth(
      mailboxes.map((m) => m.mailboxStatus),
    );

    const operationalChecks: OperationalCheck[] = [
      { id: 'EMAIL_WORKER_PIPELINE', label: 'Email worker pipeline', ...emailWorker },
      { id: 'DELTA_POLLING', label: 'Delta polling', ...pollingCheck },
      { id: 'SUBSCRIPTION_RENEWAL', label: 'Subscription renewal', ...subscriptionCheck },
      { id: 'QUEUE_REDIS', label: 'Queue / Redis', ...queueCheck },
      { id: 'TELEGRAM_RELIABILITY', label: 'Telegram send reliability', ...telegramCheck },
      { id: 'WEBHOOK_HEALTH', label: 'Webhook health', ...webhookCheck },
    ];

    const overall = aggregateOverallHealth(
      mailboxes.map((m) => m.level),
      operationalChecks.map((c) => c.status),
    );

    const overview = buildOverview(
      mailboxes,
      subscriptions,
      totalRecentFailures,
      now,
      overall,
      {
        lastProcessedEmailAt,
        lastPollingRunAt,
        lastRenewalRunAt,
        lastErrorShort,
      },
    );

    const data: HealthDashboardData = {
      overview,
      mailboxes,
      operationalChecks,
      generatedAt: now,
    };
    return { ok: true, data };
  } catch {
    // Never surface raw DB/driver errors (may contain connection strings).
    return {
      ok: false,
      message: 'Không thể tải health dashboard lúc này.',
    };
  }
}
