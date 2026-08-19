// TASK-031 — Scheduler + Prisma-backed adapters for the delta polling
// backup worker. Importing this module does NOT start any timers or open any
// Redis connections; the CLI entry (or future server instrumentation) must
// call `startDeltaPollingScheduler()` explicitly.

import { prisma as defaultPrisma } from '@/lib/prisma';
import { decryptSecret } from '@/lib/security/encryption';
import { createLogger, type Logger } from '@/lib/logger';
import { loadDeltaPollingEnv } from '@/lib/env';
import { refreshMicrosoftAccessToken } from '@/services/microsoft/refresh-access-token.service';
import { persistRotatedRefreshToken } from '@/services/microsoft/refresh-token-rotation.service';
import {
  classifyRefreshTokenError,
  type RefreshTokenFailureKind,
} from '@/services/microsoft/refresh-token-failure';
import {
  runDeltaPollingOnce,
  DELTA_POLLING_HTTP_TIMEOUT_MS,
  type DeltaPollingAccessTokenPort,
  type DeltaPollingAlertPort,
  type DeltaPollingDeps,
  type DeltaPollingEnqueuePort,
  type DeltaPollingMailbox,
  type DeltaPollingMailboxRepo,
  type DeltaPollingRunResult,
} from '@/services/microsoft/delta-polling.service';
import { enqueueDeltaPollingMessageJob } from '@/services/queue/delta-polling-queue';
import { sendAdminAlert } from '@/services/alerts/alert.service';

const MAILBOX_STATUS_ACTIVE = 'ACTIVE';
const MAILBOX_STATUS_RECONNECT_REQUIRED = 'RECONNECT_REQUIRED';
const SAFE_ERROR_MESSAGE_LIMIT = 256;

// ---------------------------------------------------------------------------
// Prisma-backed adapters
// ---------------------------------------------------------------------------

interface MailboxDeltaSlice {
  id: string;
  emailAddress: string;
  microsoftDeltaCursor: string | null;
  // TASK-075 — persistent forbidden backoff state.
  deltaForbiddenCount: number;
  deltaForbiddenCooldownUntil: Date | null;
}

interface MailboxDeltaPrismaClient {
  mailbox: {
    findMany: (args: unknown) => Promise<MailboxDeltaSlice[]>;
    update: (args: unknown) => Promise<unknown>;
  };
}

function truncateForDb(message: string): string {
  if (message.length <= SAFE_ERROR_MESSAGE_LIMIT) return message;
  return `${message.slice(0, SAFE_ERROR_MESSAGE_LIMIT - 1)}…`;
}

export function createPrismaDeltaPollingRepo(
  client: MailboxDeltaPrismaClient = defaultPrisma as unknown as MailboxDeltaPrismaClient,
): DeltaPollingMailboxRepo {
  return {
    async listActiveMicrosoftMailboxes(): Promise<DeltaPollingMailbox[]> {
      const rows = await client.mailbox.findMany({
        where: { provider: 'MICROSOFT', status: MAILBOX_STATUS_ACTIVE },
        select: {
          id: true,
          emailAddress: true,
          microsoftDeltaCursor: true,
          deltaForbiddenCount: true,
          deltaForbiddenCooldownUntil: true,
        },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((row) => ({
        id: row.id,
        emailAddress: row.emailAddress,
        microsoftDeltaCursor: row.microsoftDeltaCursor ?? null,
        deltaForbiddenCount: row.deltaForbiddenCount ?? 0,
        deltaForbiddenCooldownUntil: row.deltaForbiddenCooldownUntil ?? null,
      }));
    },
    async saveDeltaCursor(mailboxId, cursorUrl, polledAt) {
      await client.mailbox.update({
        where: { id: mailboxId },
        data: {
          microsoftDeltaCursor: cursorUrl,
          deltaLastPolledAt: polledAt,
          deltaLastErrorAt: null,
          deltaLastErrorMessage: null,
        },
      });
    },
    async recordDeltaError(mailboxId, safeMessage, occurredAt) {
      await client.mailbox.update({
        where: { id: mailboxId },
        data: {
          deltaLastPolledAt: occurredAt,
          deltaLastErrorAt: occurredAt,
          deltaLastErrorMessage: truncateForDb(safeMessage),
        },
      });
    },
    async resetDeltaCursor(mailboxId) {
      // TASK-071 — clear only the stored deltaLink so the next cycle bootstraps a
      // fresh cursor. Status and error fields are left to the normal record path.
      await client.mailbox.update({
        where: { id: mailboxId },
        data: { microsoftDeltaCursor: null },
      });
    },
    async markReconnectRequired(mailboxId) {
      await client.mailbox.update({
        where: { id: mailboxId },
        data: { status: MAILBOX_STATUS_RECONNECT_REQUIRED },
      });
    },
    async recordForbiddenBackoff(
      mailboxId,
      count,
      cooldownUntil,
      occurredAt,
      safeMessage,
    ) {
      // TASK-075 — persist the forbidden streak + cooldown alongside the error
      // metadata in one write. Status is intentionally NOT touched (a 403 is not
      // a dead grant); the cooldown alone throttles the next cycle.
      await client.mailbox.update({
        where: { id: mailboxId },
        data: {
          deltaForbiddenCount: count,
          deltaForbiddenCooldownUntil: cooldownUntil,
          deltaLastPolledAt: occurredAt,
          deltaLastErrorAt: occurredAt,
          deltaLastErrorMessage: truncateForDb(safeMessage),
        },
      });
    },
    async clearForbiddenBackoff(mailboxId) {
      // TASK-075/080 — a successful poll resolved the streak: reset the counter +
      // cooldown and clear the now-stale delta error metadata.
      await client.mailbox.update({
        where: { id: mailboxId },
        data: {
          deltaForbiddenCount: 0,
          deltaForbiddenCooldownUntil: null,
          deltaLastErrorAt: null,
          deltaLastErrorMessage: null,
        },
      });
    },
  };
}

interface MailboxRefreshTokenSlice {
  encryptedRefreshToken: string | null;
}

interface MailboxRefreshTokenPrismaClient {
  mailbox: {
    findUnique: (args: unknown) => Promise<MailboxRefreshTokenSlice | null>;
    update: (args: unknown) => Promise<unknown>;
  };
}

export class DeltaPollingTokenError extends Error {
  readonly kind: 'missing_refresh_token' | 'refresh_failed';
  // TASK-069C — drives whether delta polling flips the mailbox to
  // RECONNECT_REQUIRED. `transient` (network/429/5xx) keeps the mailbox ACTIVE so
  // the next cycle retries instead of forcing a manual reconnect.
  readonly classification: RefreshTokenFailureKind;
  constructor(
    kind: 'missing_refresh_token' | 'refresh_failed',
    message: string,
    classification: RefreshTokenFailureKind,
  ) {
    super(message);
    this.name = 'DeltaPollingTokenError';
    this.kind = kind;
    this.classification = classification;
  }
}

export function createPrismaAccessTokenPort(
  client: MailboxRefreshTokenPrismaClient = defaultPrisma as unknown as MailboxRefreshTokenPrismaClient,
): DeltaPollingAccessTokenPort {
  return {
    async getAccessTokenForMailbox(mailbox): Promise<string> {
      const row = await client.mailbox.findUnique({
        where: { id: mailbox.id },
        select: { encryptedRefreshToken: true },
      });
      if (!row || !row.encryptedRefreshToken) {
        // No stored credential at all — only a reconnect can fix this.
        throw new DeltaPollingTokenError(
          'missing_refresh_token',
          'mailbox has no encrypted refresh token',
          'reconnect_required',
        );
      }
      let plaintextRefreshToken: string;
      try {
        plaintextRefreshToken = decryptSecret(row.encryptedRefreshToken);
      } catch {
        // Never include the underlying error message — it may leak ciphertext
        // or key context. The stored token is unusable → reconnect required.
        throw new DeltaPollingTokenError(
          'refresh_failed',
          'failed to decrypt refresh token',
          'reconnect_required',
        );
      }
      let exchanged: { accessToken: string; refreshToken?: string };
      try {
        // TASK-080 — bound the token-endpoint request with the same finite timeout
        // used for the Graph delta request, so a hung token refresh can never wedge
        // the delta cycle. A timeout surfaces as a `network` error → transient.
        exchanged = await refreshMicrosoftAccessToken(plaintextRefreshToken, {
          timeoutMs: DELTA_POLLING_HTTP_TIMEOUT_MS,
        });
      } catch (error) {
        // TASK-069C — classify: only a revoked/interaction grant marks reconnect;
        // network/429/5xx (and TASK-080 timeout) stays transient so the next poll
        // cycle retries.
        throw new DeltaPollingTokenError(
          'refresh_failed',
          'failed to exchange refresh token',
          classifyRefreshTokenError(error),
        );
      }
      // TASK-036 — Microsoft may rotate the refresh token. Persist the new
      // (encrypted) token so the next refresh does not fail with invalid_grant.
      // When no new token is returned, the existing one is kept untouched.
      await persistRotatedRefreshToken(mailbox.id, exchanged.refreshToken, {
        prisma: client,
      });
      return exchanged.accessToken;
    },
  };
}

export const prismaDeltaPollingEnqueuePort: DeltaPollingEnqueuePort = {
  async enqueueMessage(input) {
    await enqueueDeltaPollingMessageJob({
      mailboxId: input.mailboxId,
      graphMessageId: input.graphMessageId,
      queuedAt: input.queuedAt,
    });
  },
};

// TASK-075 — admin alert port for persistent 403 escalation. Routes through the
// existing TASK-035 admin alert channel (Telegram), which is configured for
// OWNER/ADMIN and self-skips when no admin channel/bot token is set. Only safe,
// already-masked fields are passed; the alert sanitizer is a second line of
// defence. Reuses the `DELTA_POLLING_FAILED` alert type to avoid widening the
// alert taxonomy for this single escalation.
export const adminAlertDeltaPollingAlertPort: DeltaPollingAlertPort = {
  async raisePersistentForbidden(input) {
    await sendAdminAlert({
      type: 'DELTA_POLLING_FAILED',
      severity: 'WARNING',
      title: 'Delta polling: persistent 403 (forbidden) for a mailbox',
      context: {
        source: 'delta-polling',
        reason: 'persistent_forbidden',
        mailboxId: input.mailboxId,
        mailbox: input.emailAddressMasked,
        consecutiveForbidden: input.consecutiveForbiddenCount,
        cooldownUntil: input.cooldownUntil.toISOString(),
        diagnostics: input.safeDiagnostics,
      },
    });
  },
};

// ---------------------------------------------------------------------------
// Default dependency wiring
// ---------------------------------------------------------------------------

export function buildDefaultDeltaPollingDeps(
  overrides: Partial<DeltaPollingDeps> = {},
): DeltaPollingDeps {
  const env = loadDeltaPollingEnv();
  return {
    repo: overrides.repo ?? createPrismaDeltaPollingRepo(),
    accessToken: overrides.accessToken ?? createPrismaAccessTokenPort(),
    enqueue: overrides.enqueue ?? prismaDeltaPollingEnqueuePort,
    alert: overrides.alert ?? adminAlertDeltaPollingAlertPort,
    fetchImpl: overrides.fetchImpl,
    logger: overrides.logger,
    now: overrides.now,
    maxPagesPerMailbox: overrides.maxPagesPerMailbox ?? env.maxPagesPerMailbox,
    bootstrapLookbackHours:
      overrides.bootstrapLookbackHours ?? env.bootstrapLookbackHours,
    forbiddenBackoffThreshold: overrides.forbiddenBackoffThreshold,
  };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export interface DeltaPollingSchedulerOptions {
  intervalMs?: number;
  deps?: DeltaPollingDeps;
  logger?: Logger;
}

export interface DeltaPollingSchedulerHandle {
  stop: () => Promise<void>;
}

/**
 * Start a setInterval loop that runs the delta polling cycle every
 * `intervalMs`. Each tick is awaited so cycles do not overlap. Calling `stop()`
 * clears the interval and waits for any in-flight tick.
 *
 * The scheduler is NOT started on import — it must be invoked explicitly by
 * a worker entry script (e.g. `scripts/run-delta-polling-worker.ts`).
 */
export function startDeltaPollingScheduler(
  options: DeltaPollingSchedulerOptions = {},
): DeltaPollingSchedulerHandle {
  const env = loadDeltaPollingEnv();
  const intervalMs = options.intervalMs ?? env.intervalSeconds * 1_000;
  const deps = options.deps ?? buildDefaultDeltaPollingDeps();
  const logger = options.logger ?? createLogger();

  let stopped = false;
  let inflight: Promise<DeltaPollingRunResult> | null = null;

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (inflight !== null) {
      // Skip overlapping ticks. The interval covers the next opportunity.
      logger.warn('Delta polling skipping tick — previous tick still running');
      return;
    }
    inflight = runDeltaPollingOnce(deps).catch((error) => {
      logger.error('Delta polling tick raised unexpectedly', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      return {
        checkedMailboxCount: 0,
        bootstrappedMailboxCount: 0,
        enqueuedMessageCount: 0,
        failedMailboxCount: 0,
        cooldownSkippedMailboxCount: 0,
      };
    });
    try {
      await inflight;
    } finally {
      inflight = null;
    }
  };

  // Kick off the first tick immediately, then on every interval.
  void tick();
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  logger.info('Delta polling scheduler started', {
    intervalSeconds: Math.round(intervalMs / 1_000),
    maxPagesPerMailbox: deps.maxPagesPerMailbox,
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
      logger.info('Delta polling scheduler stopped');
    },
  };
}
