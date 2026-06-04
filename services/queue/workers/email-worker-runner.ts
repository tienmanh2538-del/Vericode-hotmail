// TASK-040 preflight — production wiring for the email worker pipeline.
//
// TASK-027 built `processGraphMessageJob` (the real load→fetch→detect→extract→
// dedupe→Telegram pipeline) but never wired its production dependencies, so the
// BullMQ worker had no real pipeline to run. This module supplies that wiring:
// Prisma-backed mailbox lookup, an access-token port that decrypts + refreshes
// the Microsoft token (and persists a rotated refresh token exactly like the
// delta-polling / renewal workers), the Graph fetch, the Telegram mapping +
// retrying sender, and DB-backed audit/code-event persistence.
//
// Importing this module has NO side effects (no Redis/DB/Graph I/O at import).

import { prisma as defaultPrisma } from '@/lib/prisma';
import { decryptSecret } from '@/lib/security/encryption';
import { createLogger, type Logger } from '@/lib/logger';
import { refreshMicrosoftAccessToken } from '@/services/microsoft/refresh-access-token.service';
import { persistRotatedRefreshToken } from '@/services/microsoft/refresh-token-rotation.service';
import { getMessageById } from '@/services/microsoft/graph-mail.service';
import { findActiveMappingForMailbox } from '@/services/telegram/telegram-mapping.service';
import { createRetryingTelegramSendPort } from '@/services/telegram/telegram-retry.service';
import { createPrismaProcessedMessageStore } from '@/services/email/prisma-processed-message-store';
import {
  processGraphMessageJob,
  type AccessTokenPort,
  type AuditPort,
  type GraphMessageFetchPort,
  type GraphMessagePipelineDeps,
  type MailboxLookupPort,
  type MailboxLookupRecord,
  type TelegramMappingPort,
} from '@/services/email/graph-message-pipeline.service';
import { recordCodeEventToDb } from '@/services/logs/prisma-code-event-store';
import { createAuditLogInDb } from '@/services/logs/prisma-audit-log-store';
import { type MailboxProcessingLock } from '@/services/queue/mailbox-processing-lock';
import { createMailboxProcessingLock } from '@/services/queue/mailbox-lock-factory';
import {
  createInMemoryDestinationThrottle,
  type DestinationThrottle,
} from '@/services/queue/destination-throttle';
import {
  createInMemoryGlobalSendThrottle,
  type GlobalSendThrottle,
} from '@/services/queue/global-send-throttle';
import { getWorkerMetricsRecorder } from '@/services/observability/redis-worker-metrics';
import type { EmailWorkerPipeline } from './email-worker';

const MAILBOX_STATUS_RECONNECT_REQUIRED = 'RECONNECT_REQUIRED';

// TASK-055 — process-wide singletons shared across every job the worker runs, so
// the per-mailbox lock map and the per-destination spacing map are shared state.
// Building them here (not per job) is what makes the guards effective. Both are
// pure in-memory structures with no import-time I/O.
// TASK-068A — built via the factory so the lock backend is a single switch. With
// no Redis client supplied it returns the in-memory lock (unchanged production
// behaviour, single-worker baseline). To enable cross-process serialisation for
// multiple worker replicas, pass a shared Redis client:
//   createMailboxProcessingLock({ redisClient: <shared ioredis client> })
// (the client is intentionally NOT auto-created here — see mailbox-lock-factory).
const sharedMailboxProcessingLock: MailboxProcessingLock =
  createMailboxProcessingLock();
const sharedDestinationThrottle: DestinationThrottle =
  createInMemoryDestinationThrottle();
// TASK-068B — one process-wide bot pacer shared across every job so all sends
// pace against the same global slot (Telegram's ~30/s per-bot ceiling), on top
// of the per-destination spacing above. Defaults are conservative and capped.
const sharedGlobalSendThrottle: GlobalSendThrottle =
  createInMemoryGlobalSendThrottle();

// TASK-068B — conservative bounded fairness for a busy per-mailbox lock. Instead
// of immediately deferring (→ a queue re-attempt with backoff, burning an
// attempt), a job waits briefly in place so a quickly-finishing in-flight job
// for the same mailbox lets it proceed. Strictly bounded: at most 2 retries and
// at most 1s total wait, then it defers as before. Never infinite, never holds a
// worker slot longer than the cap, never claims while busy (exactly-once intact).
const DEFAULT_BUSY_DEFER_RETRY = {
  maxRetries: 2,
  delayMs: 250,
  maxTotalWaitMs: 1_000,
} as const;

// ---------------------------------------------------------------------------
// Mailbox lookup port
// ---------------------------------------------------------------------------

interface MailboxLookupRow {
  id: string;
  emailAddress: string;
  status: string;
  ownerCustomerName: string | null;
  customer: { name: string } | null;
}

interface MailboxLookupPrismaClient {
  mailbox: {
    findUnique: (args: unknown) => Promise<MailboxLookupRow | null>;
    update: (args: unknown) => Promise<unknown>;
  };
}

export function createPrismaMailboxLookupPort(
  client: MailboxLookupPrismaClient = defaultPrisma as unknown as MailboxLookupPrismaClient,
): MailboxLookupPort {
  return {
    async findById(mailboxId): Promise<MailboxLookupRecord | null> {
      const row = await client.mailbox.findUnique({
        where: { id: mailboxId },
        select: {
          id: true,
          emailAddress: true,
          status: true,
          ownerCustomerName: true,
          customer: { select: { name: true } },
        },
      });
      if (!row) return null;
      return {
        id: row.id,
        emailAddress: row.emailAddress,
        status: row.status,
        customerName: row.customer?.name ?? row.ownerCustomerName ?? null,
      };
    },
    async markReconnectRequired(mailboxId): Promise<void> {
      await client.mailbox.update({
        where: { id: mailboxId },
        data: { status: MAILBOX_STATUS_RECONNECT_REQUIRED },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Access-token port (decrypt → refresh → persist rotated token)
// ---------------------------------------------------------------------------

interface MailboxRefreshTokenRow {
  encryptedRefreshToken: string | null;
}

interface MailboxRefreshTokenPrismaClient {
  mailbox: {
    findUnique: (args: unknown) => Promise<MailboxRefreshTokenRow | null>;
    update: (args: unknown) => Promise<unknown>;
  };
}

export class EmailWorkerTokenError extends Error {
  readonly kind: 'missing_refresh_token' | 'refresh_failed';
  constructor(kind: 'missing_refresh_token' | 'refresh_failed', message: string) {
    super(message);
    this.name = 'EmailWorkerTokenError';
    this.kind = kind;
  }
}

export function createPrismaEmailAccessTokenPort(
  client: MailboxRefreshTokenPrismaClient = defaultPrisma as unknown as MailboxRefreshTokenPrismaClient,
): AccessTokenPort {
  return {
    async getAccessTokenForMailbox(mailbox): Promise<string> {
      const row = await client.mailbox.findUnique({
        where: { id: mailbox.id },
        select: { encryptedRefreshToken: true },
      });
      if (!row || !row.encryptedRefreshToken) {
        throw new EmailWorkerTokenError(
          'missing_refresh_token',
          'mailbox has no encrypted refresh token',
        );
      }
      let plaintextRefreshToken: string;
      try {
        plaintextRefreshToken = decryptSecret(row.encryptedRefreshToken);
      } catch {
        // Never include the underlying error — it may leak ciphertext/key context.
        throw new EmailWorkerTokenError(
          'refresh_failed',
          'failed to decrypt refresh token',
        );
      }
      let exchanged: { accessToken: string; refreshToken?: string };
      try {
        exchanged = await refreshMicrosoftAccessToken(plaintextRefreshToken);
      } catch {
        throw new EmailWorkerTokenError(
          'refresh_failed',
          'failed to exchange refresh token',
        );
      }
      // Microsoft may rotate the refresh token — persist the new (encrypted)
      // token so the next cycle does not fail with invalid_grant. No-op when no
      // new token is returned (the existing one is kept). Same contract as the
      // delta-polling and subscription-renewal workers.
      await persistRotatedRefreshToken(mailbox.id, exchanged.refreshToken, {
        prisma: client,
      });
      return exchanged.accessToken;
    },
  };
}

// ---------------------------------------------------------------------------
// Graph fetch + Telegram mapping ports
// ---------------------------------------------------------------------------

export const graphMessageFetchPort: GraphMessageFetchPort = {
  fetchMessage(accessToken, graphMessageId) {
    return getMessageById(accessToken, graphMessageId);
  },
};

export function createPrismaTelegramMappingPort(): TelegramMappingPort {
  return {
    async findActiveMappingForMailboxId(mailboxId) {
      const mapping = await findActiveMappingForMailbox(mailboxId);
      if (!mapping) return null;
      return {
        telegramChatId: mapping.telegramChatId,
        telegramGroupName: mapping.telegramGroupName,
        telegramThreadId: mapping.telegramThreadId,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// DB-backed audit/code-event port (fire-and-forget so logging never blocks or
// fails the delivery path).
// ---------------------------------------------------------------------------

export function createDbAuditPort(logger: Logger): AuditPort {
  return {
    recordCodeEvent(input) {
      void recordCodeEventToDb(input).catch(() => {
        logger.warn('Failed to persist code event to database', {
          status: input.status,
        });
      });
    },
    createAuditLog(input) {
      void createAuditLogInDb(input).catch(() => {
        logger.warn('Failed to persist audit log to database', {
          action: input.action,
        });
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Default dependency wiring
// ---------------------------------------------------------------------------

export function buildDefaultEmailPipelineDeps(
  overrides: Partial<GraphMessagePipelineDeps> = {},
): GraphMessagePipelineDeps {
  const logger = overrides.logger ?? createLogger();
  return {
    store: overrides.store ?? createPrismaProcessedMessageStore(),
    mailboxes: overrides.mailboxes ?? createPrismaMailboxLookupPort(),
    accessToken: overrides.accessToken ?? createPrismaEmailAccessTokenPort(),
    graphMail: overrides.graphMail ?? graphMessageFetchPort,
    telegramMapping: overrides.telegramMapping ?? createPrismaTelegramMappingPort(),
    telegramSender: overrides.telegramSender ?? createRetryingTelegramSendPort(),
    audit: overrides.audit ?? createDbAuditPort(logger),
    logger,
    now: overrides.now,
    // TASK-055 — production guards: serialize per-mailbox processing and space
    // sends to a shared reusable destination. Shared singletons so their state
    // spans every job; still overridable for tests.
    lock: overrides.lock ?? sharedMailboxProcessingLock,
    destinationThrottle:
      overrides.destinationThrottle ?? sharedDestinationThrottle,
    // TASK-068B — global bot pacing + bounded busy-defer fairness. Both are
    // overridable for tests; production uses the shared singletons/defaults.
    globalSendThrottle:
      overrides.globalSendThrottle ?? sharedGlobalSendThrottle,
    busyDeferRetry: overrides.busyDeferRetry ?? DEFAULT_BUSY_DEFER_RETRY,
    sleep: overrides.sleep,
    // TASK-068C — record aggregate throttle/defer signals to the shared Redis
    // store (same store the worker latency metrics use) for cross-process
    // visibility on the health dashboard. Best-effort; never affects delivery.
    metrics: overrides.metrics ?? getWorkerMetricsRecorder(),
  };
}

/**
 * Build the production pipeline function the BullMQ worker invokes per job.
 * This is the real load→fetch→detect→extract→dedupe→Telegram pipeline — never a
 * type-only cast or no-op.
 */
export function buildDefaultEmailPipeline(
  overrides: Partial<GraphMessagePipelineDeps> = {},
): EmailWorkerPipeline {
  const deps = buildDefaultEmailPipelineDeps(overrides);
  return (job) => processGraphMessageJob(job, deps);
}
