// TASK-031 — Scheduler + Prisma-backed adapters for the delta polling
// backup worker. Importing this module does NOT start any timers or open any
// Redis connections; the CLI entry (or future server instrumentation) must
// call `startDeltaPollingScheduler()` explicitly.

import { prisma as defaultPrisma } from '@/lib/prisma';
import { decryptSecret } from '@/lib/security/encryption';
import { createLogger, type Logger } from '@/lib/logger';
import { loadDeltaPollingEnv } from '@/lib/env';
import { refreshMicrosoftAccessToken } from '@/services/microsoft/refresh-access-token.service';
import {
  runDeltaPollingOnce,
  type DeltaPollingAccessTokenPort,
  type DeltaPollingDeps,
  type DeltaPollingEnqueuePort,
  type DeltaPollingMailbox,
  type DeltaPollingMailboxRepo,
  type DeltaPollingRunResult,
} from '@/services/microsoft/delta-polling.service';
import { enqueueDeltaPollingMessageJob } from '@/services/queue/delta-polling-queue';

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
        },
        orderBy: { createdAt: 'asc' },
      });
      return rows.map((row) => ({
        id: row.id,
        emailAddress: row.emailAddress,
        microsoftDeltaCursor: row.microsoftDeltaCursor ?? null,
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
    async markReconnectRequired(mailboxId) {
      await client.mailbox.update({
        where: { id: mailboxId },
        data: { status: MAILBOX_STATUS_RECONNECT_REQUIRED },
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
  constructor(kind: 'missing_refresh_token' | 'refresh_failed', message: string) {
    super(message);
    this.name = 'DeltaPollingTokenError';
    this.kind = kind;
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
        throw new DeltaPollingTokenError(
          'missing_refresh_token',
          'mailbox has no encrypted refresh token',
        );
      }
      let plaintextRefreshToken: string;
      try {
        plaintextRefreshToken = decryptSecret(row.encryptedRefreshToken);
      } catch {
        // Never include the underlying error message — it may leak ciphertext
        // or key context.
        throw new DeltaPollingTokenError(
          'refresh_failed',
          'failed to decrypt refresh token',
        );
      }
      let exchanged: { accessToken: string; refreshToken?: string };
      try {
        exchanged = await refreshMicrosoftAccessToken(plaintextRefreshToken);
      } catch {
        throw new DeltaPollingTokenError(
          'refresh_failed',
          'failed to exchange refresh token',
        );
      }
      // Microsoft may rotate the refresh token. Storing the new ciphertext is
      // outside TASK-031's scope (TASK-020 owns encrypted persistence) — we
      // only consume the access token here.
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
    fetchImpl: overrides.fetchImpl,
    logger: overrides.logger,
    now: overrides.now,
    maxPagesPerMailbox: overrides.maxPagesPerMailbox ?? env.maxPagesPerMailbox,
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
