// TASK-032 — Scheduler + Prisma-backed adapters for the subscription renewal
// worker. Importing this module does NOT start any timers or open any
// connections; the CLI entry (or future server instrumentation) must call
// `startSubscriptionRenewalScheduler()` explicitly.

import { prisma as defaultPrisma } from '@/lib/prisma';
import { decryptSecret } from '@/lib/security/encryption';
import { createLogger, type Logger } from '@/lib/logger';
import { loadSubscriptionRenewalEnv } from '@/lib/env';
import {
  RefreshAccessTokenError,
  refreshMicrosoftAccessToken,
} from '@/services/microsoft/refresh-access-token.service';
import { renewGraphSubscription } from '@/services/microsoft/graph-subscription.service';
import { createAuditLog } from '@/services/logs/audit-log.service';
import {
  runSubscriptionRenewalOnce,
  SubscriptionRenewalTokenError,
  type RenewSubscriptionPort,
  type RenewableSubscriptionCandidate,
  type RenewalAccessTokenPort,
  type RenewalAuditPort,
  type SubscriptionRenewalDeps,
  type SubscriptionRenewalRepo,
  type SubscriptionRenewalRunResult,
} from '@/services/microsoft/subscription-renewal.service';

const MAILBOX_STATUS_RECONNECT_REQUIRED = 'RECONNECT_REQUIRED';
const MAILBOX_STATUS_SUBSCRIPTION_EXPIRED = 'SUBSCRIPTION_EXPIRED';
const SUBSCRIPTION_STATUS_ACTIVE = 'ACTIVE';
const SUBSCRIPTION_STATUS_RENEWING = 'RENEWING';
const SUBSCRIPTION_STATUS_FAILED = 'FAILED';
const SUBSCRIPTION_STATUS_EXPIRED = 'EXPIRED';
const MAILBOX_STATUS_DISABLED = 'DISABLED';

// Microsoft returns invalid_grant when the refresh token has been revoked or
// expired — the only fix is a human re-consent, so we surface it as
// reconnect-required rather than retrying.
const REVOKED_GRANT_ERROR_CODES = new Set(['invalid_grant', 'interaction_required']);

// ---------------------------------------------------------------------------
// Prisma-backed repo
// ---------------------------------------------------------------------------

interface GraphSubscriptionCandidateRow {
  id: string;
  mailboxId: string;
  subscriptionId: string;
  expirationDateTime: Date;
  mailbox: { status: string; emailAddress: string } | null;
}

interface SubscriptionRenewalPrismaClient {
  graphSubscription: {
    findMany: (args: unknown) => Promise<GraphSubscriptionCandidateRow[]>;
    update: (args: unknown) => Promise<unknown>;
  };
  mailbox: {
    update: (args: unknown) => Promise<unknown>;
  };
}

export function createPrismaSubscriptionRenewalRepo(
  client: SubscriptionRenewalPrismaClient = defaultPrisma as unknown as SubscriptionRenewalPrismaClient,
): SubscriptionRenewalRepo {
  return {
    async listRenewableCandidates(): Promise<RenewableSubscriptionCandidate[]> {
      // Pre-filter in SQL for efficiency: usable statuses + a mailbox that is
      // not disabled. The service re-validates the expiration window so the
      // selection rules stay testable without a database.
      const rows = await client.graphSubscription.findMany({
        where: {
          status: {
            in: [
              SUBSCRIPTION_STATUS_ACTIVE,
              SUBSCRIPTION_STATUS_RENEWING,
              SUBSCRIPTION_STATUS_FAILED,
            ],
          },
          mailbox: { is: { status: { not: MAILBOX_STATUS_DISABLED } } },
        },
        select: {
          id: true,
          mailboxId: true,
          subscriptionId: true,
          expirationDateTime: true,
          mailbox: { select: { status: true, emailAddress: true } },
        },
        orderBy: { expirationDateTime: 'asc' },
      });
      return rows.map((row) => ({
        id: row.id,
        mailboxId: row.mailboxId,
        subscriptionId: row.subscriptionId,
        emailAddress: row.mailbox?.emailAddress ?? '',
        mailboxStatus: row.mailbox?.status ?? MAILBOX_STATUS_DISABLED,
        expirationDateTime: row.expirationDateTime,
      }));
    },
    async markSubscriptionExpired(subscriptionId) {
      await client.graphSubscription.update({
        where: { subscriptionId },
        data: { status: SUBSCRIPTION_STATUS_EXPIRED },
      });
    },
    async markSubscriptionFailed(subscriptionId) {
      await client.graphSubscription.update({
        where: { subscriptionId },
        data: { status: SUBSCRIPTION_STATUS_FAILED },
      });
    },
    async markMailboxReconnectRequired(mailboxId) {
      await client.mailbox.update({
        where: { id: mailboxId },
        data: { status: MAILBOX_STATUS_RECONNECT_REQUIRED },
      });
    },
    async markMailboxSubscriptionExpired(mailboxId) {
      await client.mailbox.update({
        where: { id: mailboxId },
        data: { status: MAILBOX_STATUS_SUBSCRIPTION_EXPIRED },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Access token port (decrypt + refresh, classify revoke vs transient)
// ---------------------------------------------------------------------------

interface MailboxRefreshTokenSlice {
  encryptedRefreshToken: string | null;
}

interface MailboxRefreshTokenPrismaClient {
  mailbox: {
    findUnique: (args: unknown) => Promise<MailboxRefreshTokenSlice | null>;
  };
}

export function createPrismaRenewalAccessTokenPort(
  client: MailboxRefreshTokenPrismaClient = defaultPrisma as unknown as MailboxRefreshTokenPrismaClient,
): RenewalAccessTokenPort {
  return {
    async getAccessTokenForMailbox(mailboxId): Promise<string> {
      const row = await client.mailbox.findUnique({
        where: { id: mailboxId },
        select: { encryptedRefreshToken: true },
      });
      if (!row || !row.encryptedRefreshToken) {
        // No usable credential — the mailbox must be reconnected.
        throw new SubscriptionRenewalTokenError(
          'reconnect_required',
          'mailbox has no encrypted refresh token',
        );
      }

      let plaintextRefreshToken: string;
      try {
        plaintextRefreshToken = decryptSecret(row.encryptedRefreshToken);
      } catch {
        // Never include the underlying error — it may leak ciphertext/key
        // context. A decrypt failure means the stored token is unusable.
        throw new SubscriptionRenewalTokenError(
          'reconnect_required',
          'failed to decrypt refresh token',
        );
      }

      try {
        const exchanged = await refreshMicrosoftAccessToken(plaintextRefreshToken);
        return exchanged.accessToken;
      } catch (error) {
        if (error instanceof RefreshAccessTokenError) {
          if (
            error.kind === 'token_endpoint' &&
            error.microsoftErrorCode !== undefined &&
            REVOKED_GRANT_ERROR_CODES.has(error.microsoftErrorCode)
          ) {
            throw new SubscriptionRenewalTokenError(
              'reconnect_required',
              'refresh token revoked',
            );
          }
          if (error.kind === 'config') {
            throw new SubscriptionRenewalTokenError(
              'config',
              'Microsoft OAuth is not configured',
            );
          }
          if (error.kind === 'network') {
            throw new SubscriptionRenewalTokenError(
              'transient',
              'token endpoint network error',
            );
          }
        }
        // Unknown token_endpoint failures: treat as transient so the next tick
        // retries instead of permanently disabling a possibly-fine mailbox.
        throw new SubscriptionRenewalTokenError(
          'transient',
          'failed to exchange refresh token',
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Renew port (delegates to the existing graph-subscription service)
// ---------------------------------------------------------------------------

export function createGraphRenewSubscriptionPort(): RenewSubscriptionPort {
  return {
    async renew({ mailboxId, subscriptionId, accessToken, now }) {
      // renewGraphSubscription performs the PATCH /subscriptions/{id} with
      // expirationDateTime = now + 6 days (its DEFAULT_EXPIRATION_MS) and
      // persists expirationDateTime / status=ACTIVE / lastRenewedAt. We do not
      // re-implement any of that here.
      const result = await renewGraphSubscription({
        mailboxId,
        subscriptionId,
        accessToken,
        now,
      });
      return { newExpirationDateTime: result.expirationDateTime };
    },
  };
}

// ---------------------------------------------------------------------------
// Audit port
// ---------------------------------------------------------------------------

export const prismaRenewalAuditPort: RenewalAuditPort = {
  recordRenewed(input) {
    // Metadata is intentionally limited to non-sensitive identifiers; the audit
    // service additionally sanitizes any secret-like keys.
    createAuditLog({
      action: 'SUBSCRIPTION_RENEWED',
      entityType: 'subscription',
      entityId: input.graphSubscriptionId,
      severity: 'info',
      metadata: {
        mailboxId: input.mailboxId,
        graphSubscriptionId: input.graphSubscriptionId,
        oldExpirationDateTime: input.oldExpirationDateTime.toISOString(),
        newExpirationDateTime: input.newExpirationDateTime.toISOString(),
      },
    });
  },
};

// ---------------------------------------------------------------------------
// Default dependency wiring
// ---------------------------------------------------------------------------

export function buildDefaultSubscriptionRenewalDeps(
  overrides: Partial<SubscriptionRenewalDeps> = {},
): SubscriptionRenewalDeps {
  const env = loadSubscriptionRenewalEnv();
  return {
    repo: overrides.repo ?? createPrismaSubscriptionRenewalRepo(),
    accessToken: overrides.accessToken ?? createPrismaRenewalAccessTokenPort(),
    renew: overrides.renew ?? createGraphRenewSubscriptionPort(),
    audit: overrides.audit ?? prismaRenewalAuditPort,
    logger: overrides.logger,
    now: overrides.now,
    renewWithinMs: overrides.renewWithinMs ?? env.renewWithinMs,
    maxRenewAttempts: overrides.maxRenewAttempts,
    sleep: overrides.sleep,
  };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export interface SubscriptionRenewalSchedulerOptions {
  intervalMs?: number;
  deps?: SubscriptionRenewalDeps;
  logger?: Logger;
}

export interface SubscriptionRenewalSchedulerHandle {
  stop: () => Promise<void>;
}

/**
 * Start a setInterval loop that runs the renewal cycle every `intervalMs`. Each
 * tick is awaited so cycles never overlap. Calling `stop()` clears the interval
 * and waits for any in-flight tick.
 *
 * NOT started on import — invoke explicitly from a worker entry script.
 */
export function startSubscriptionRenewalScheduler(
  options: SubscriptionRenewalSchedulerOptions = {},
): SubscriptionRenewalSchedulerHandle {
  const env = loadSubscriptionRenewalEnv();
  const intervalMs = options.intervalMs ?? env.intervalSeconds * 1_000;
  const deps = options.deps ?? buildDefaultSubscriptionRenewalDeps();
  const logger = options.logger ?? createLogger();

  let stopped = false;
  let inflight: Promise<SubscriptionRenewalRunResult> | null = null;

  const emptyResult: SubscriptionRenewalRunResult = {
    checkedCount: 0,
    renewedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    reconnectRequiredCount: 0,
    expiredCount: 0,
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (inflight !== null) {
      logger.warn('Subscription renewal skipping tick — previous still running');
      return;
    }
    inflight = runSubscriptionRenewalOnce(deps).catch((error) => {
      logger.error('Subscription renewal tick raised unexpectedly', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      return emptyResult;
    });
    try {
      await inflight;
    } finally {
      inflight = null;
    }
  };

  void tick();
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  logger.info('Subscription renewal scheduler started', {
    intervalSeconds: Math.round(intervalMs / 1_000),
  });

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      if (inflight !== null) {
        try {
          await inflight;
        } catch {
          // Already logged in tick().
        }
      }
      logger.info('Subscription renewal scheduler stopped');
    },
  };
}
