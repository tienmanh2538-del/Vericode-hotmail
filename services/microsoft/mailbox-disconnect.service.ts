// TASK-052 — Safe mailbox disconnect flow (service layer).
//
// Disconnect strategy: LOCAL DISABLE FIRST, REMOTE CLEANUP SECOND.
//
//   1. Local (atomic, the source of truth for "stop relaying"):
//        - Mailbox.status      -> DISABLED   (skips delta polling, renewal, pipeline)
//        - active TelegramMapping.status -> DISABLED
//        - live GraphSubscription.status -> EXPIRED (renewal worker ignores it)
//      Then a safe MAILBOX_DISCONNECTED audit entry.
//   2. Remote (best-effort): try to DELETE the Graph subscription on Microsoft.
//      If the remote delete fails, we DO NOT roll back the local disconnect —
//      the mailbox is already disabled locally, so nothing is polled, renewed,
//      or relayed regardless of the remote outcome (fail-safe).
//
// No migration: the existing MailboxStatus.DISABLED / TelegramMappingStatus.DISABLED
// / GraphSubscriptionStatus.EXPIRED values already gate every worker and the
// pipeline, so disconnected mailboxes are inert without any schema change.
//
// This service NEVER:
//   - hard-deletes the mailbox, telegram mappings, subscriptions, processed
//     messages, audit logs, or code events (history is preserved for audit);
//   - logs or returns tokens, refresh credentials, verification codes, or email
//     bodies;
//   - rolls local disconnect back because a remote cleanup call failed.

import { prisma as defaultPrisma } from '@/lib/prisma';
import { createLogger, type Logger } from '@/lib/logger';
import { createAuditLogInDb } from '@/services/logs/prisma-audit-log-store';

const MAILBOX_STATUS_DISABLED = 'DISABLED';
const TELEGRAM_MAPPING_STATUS_ACTIVE = 'ACTIVE';
const TELEGRAM_MAPPING_STATUS_DISABLED = 'DISABLED';
const SUBSCRIPTION_STATUS_EXPIRED = 'EXPIRED';
// Subscription statuses that are still "live" on Microsoft's side and therefore
// worth a local mark + best-effort remote delete.
const SUBSCRIPTION_LIVE_STATUSES = ['ACTIVE', 'RENEWING', 'FAILED'] as const;

// ---------------------------------------------------------------------------
// Errors & result
// ---------------------------------------------------------------------------

export type MailboxDisconnectErrorKind = 'validation' | 'not_found' | 'database';

export class MailboxDisconnectError extends Error {
  readonly kind: MailboxDisconnectErrorKind;

  constructor(kind: MailboxDisconnectErrorKind, message: string) {
    super(message);
    this.name = 'MailboxDisconnectError';
    this.kind = kind;
  }
}

export interface MailboxDisconnectRemoteCleanupSummary {
  attempted: number;
  deleted: number;
  failed: number;
}

export interface MailboxDisconnectResult {
  mailboxId: string;
  /** True when the mailbox was already DISABLED before this call (idempotent). */
  alreadyDisconnected: boolean;
  disabledMappingCount: number;
  deactivatedSubscriptionCount: number;
  remoteCleanup: MailboxDisconnectRemoteCleanupSummary;
}

// ---------------------------------------------------------------------------
// Injected ports
// ---------------------------------------------------------------------------

interface MailboxRow {
  id: string;
  status: string;
  customerId: string | null;
  provider: string;
}

interface CountResult {
  count: number;
}

/**
 * Minimal Prisma surface. The array form of `$transaction` runs the three local
 * writes atomically so a partial disconnect can never leave a mailbox half-on.
 */
export interface MailboxDisconnectPrismaClient {
  mailbox: {
    findUnique: (args: {
      where: { id: string };
      select: Record<string, boolean>;
    }) => Promise<MailboxRow | null>;
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<unknown>;
  };
  telegramMapping: {
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<CountResult>;
  };
  graphSubscription: {
    findMany: (args: {
      where: Record<string, unknown>;
      select: Record<string, boolean>;
    }) => Promise<Array<{ subscriptionId: string }>>;
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<CountResult>;
  };
  $transaction: (operations: ReadonlyArray<Promise<unknown>>) => Promise<unknown[]>;
}

/**
 * Best-effort remote cleanup. Implementations attempt to DELETE the Graph
 * subscription on Microsoft. Errors MUST be thrown so the service can count a
 * failure — it never rolls back the local disconnect on a remote failure.
 */
export interface MailboxDisconnectRemoteCleanup {
  deleteRemoteSubscription(input: {
    mailboxId: string;
    subscriptionId: string;
  }): Promise<void>;
}

export interface MailboxDisconnectAuditInput {
  mailboxId: string;
  customerId: string | null;
  disabledMappingCount: number;
  deactivatedSubscriptionCount: number;
  remoteCleanup: MailboxDisconnectRemoteCleanupSummary;
  actorUserId?: string | null;
  actorEmail?: string | null;
}

export interface MailboxDisconnectAuditPort {
  recordDisconnected(input: MailboxDisconnectAuditInput): Promise<void> | void;
}

export interface MailboxDisconnectDeps {
  prisma?: MailboxDisconnectPrismaClient;
  /** Omit to skip remote cleanup entirely (local-only disconnect). */
  remoteCleanup?: MailboxDisconnectRemoteCleanup;
  audit?: MailboxDisconnectAuditPort;
  logger?: Logger;
  actor?: { userId?: string | null; email?: string | null };
}

// ---------------------------------------------------------------------------
// Default audit port (DB-backed, shared with the workers + admin UI)
// ---------------------------------------------------------------------------

export function createDefaultMailboxDisconnectAuditPort(): MailboxDisconnectAuditPort {
  return {
    async recordDisconnected(input) {
      // Metadata is intentionally limited to non-sensitive identifiers; the
      // audit service additionally scrubs any secret-like keys. No token,
      // refresh credential, verification code, or email body is ever included.
      await createAuditLogInDb({
        action: 'MAILBOX_DISCONNECTED',
        entityType: 'mailbox',
        entityId: input.mailboxId,
        actorUserId: input.actorUserId ?? null,
        actorEmail: input.actorEmail ?? null,
        severity: 'warning',
        summary: 'Mailbox disconnected by admin',
        metadata: {
          mailboxId: input.mailboxId,
          customerId: input.customerId,
          disabledMappingCount: input.disabledMappingCount,
          deactivatedSubscriptionCount: input.deactivatedSubscriptionCount,
          remoteSubscriptionsAttempted: input.remoteCleanup.attempted,
          remoteSubscriptionsDeleted: input.remoteCleanup.deleted,
          remoteSubscriptionsFailed: input.remoteCleanup.failed,
        },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

function normalizeId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Disconnect a mailbox safely. Idempotent: calling it on an already-disconnected
 * mailbox is a safe no-op that still returns a result. Throws
 * `MailboxDisconnectError` for an empty id, a missing mailbox, or a failure of
 * the local (atomic) disable — never for a remote cleanup failure.
 *
 * Permission enforcement (OWNER/ADMIN only) lives in the server action / API
 * layer that calls this; the service itself performs no auth so it stays a pure
 * data operation, but it also never exposes anything role-sensitive.
 */
export async function disconnectMailbox(
  mailboxId: string,
  deps: MailboxDisconnectDeps = {},
): Promise<MailboxDisconnectResult> {
  const id = normalizeId(mailboxId);
  if (!id) {
    throw new MailboxDisconnectError('validation', 'mailboxId is required');
  }

  const client = deps.prisma ?? (defaultPrisma as unknown as MailboxDisconnectPrismaClient);
  const logger = deps.logger ?? createLogger();
  const audit = deps.audit ?? createDefaultMailboxDisconnectAuditPort();

  let mailbox: MailboxRow | null;
  try {
    mailbox = await client.mailbox.findUnique({
      where: { id },
      select: { id: true, status: true, customerId: true, provider: true },
    });
  } catch {
    // Never echo the underlying Prisma error — it can include row data.
    throw new MailboxDisconnectError('database', 'failed to load mailbox');
  }

  // Fail closed: a missing (or out-of-scope) mailbox is reported as not_found so
  // existence is never leaked through a different error shape.
  if (!mailbox) {
    throw new MailboxDisconnectError('not_found', 'mailbox not found');
  }

  const alreadyDisconnected = mailbox.status === MAILBOX_STATUS_DISABLED;

  // Snapshot the still-live subscriptions BEFORE we mark them, so we know which
  // ones to attempt a best-effort remote delete on.
  let liveSubscriptionIds: string[] = [];
  try {
    const liveSubs = await client.graphSubscription.findMany({
      where: { mailboxId: id, status: { in: [...SUBSCRIPTION_LIVE_STATUSES] } },
      select: { subscriptionId: true },
    });
    liveSubscriptionIds = liveSubs
      .map((row) => row.subscriptionId)
      .filter((value): value is string => typeof value === 'string' && value.length > 0);
  } catch {
    // A read failure here only costs us the remote-delete attempt; the local
    // disconnect below is what actually makes the mailbox safe.
    logger.warn('Mailbox disconnect could not list live subscriptions', {
      mailboxId: id,
    });
  }

  // --- Step 1: local disable first (atomic) ---------------------------------
  let disabledMappingCount = 0;
  let deactivatedSubscriptionCount = 0;
  try {
    const results = await client.$transaction([
      client.mailbox.update({
        where: { id },
        data: { status: MAILBOX_STATUS_DISABLED },
      }),
      client.telegramMapping.updateMany({
        where: { mailboxId: id, status: TELEGRAM_MAPPING_STATUS_ACTIVE },
        data: { status: TELEGRAM_MAPPING_STATUS_DISABLED },
      }),
      client.graphSubscription.updateMany({
        where: { mailboxId: id, status: { in: [...SUBSCRIPTION_LIVE_STATUSES] } },
        data: { status: SUBSCRIPTION_STATUS_EXPIRED },
      }),
    ]);
    disabledMappingCount = (results[1] as CountResult | undefined)?.count ?? 0;
    deactivatedSubscriptionCount = (results[2] as CountResult | undefined)?.count ?? 0;
  } catch {
    throw new MailboxDisconnectError('database', 'failed to disconnect mailbox');
  }

  // --- Step 2: best-effort remote cleanup -----------------------------------
  const remoteCleanup: MailboxDisconnectRemoteCleanupSummary = {
    attempted: 0,
    deleted: 0,
    failed: 0,
  };
  if (deps.remoteCleanup && liveSubscriptionIds.length > 0) {
    for (const subscriptionId of liveSubscriptionIds) {
      remoteCleanup.attempted += 1;
      try {
        await deps.remoteCleanup.deleteRemoteSubscription({
          mailboxId: id,
          subscriptionId,
        });
        remoteCleanup.deleted += 1;
      } catch (error) {
        // Fail-safe: a remote delete failure does NOT undo the local disconnect.
        remoteCleanup.failed += 1;
        logger.warn('Mailbox disconnect remote subscription delete failed', {
          mailboxId: id,
          errorName: error instanceof Error ? error.name : 'UnknownError',
        });
      }
    }
  }

  // --- Step 3: audit (best-effort; never undoes the disconnect) -------------
  try {
    await audit.recordDisconnected({
      mailboxId: id,
      customerId: mailbox.customerId,
      disabledMappingCount,
      deactivatedSubscriptionCount,
      remoteCleanup,
      actorUserId: deps.actor?.userId ?? null,
      actorEmail: deps.actor?.email ?? null,
    });
  } catch {
    logger.warn('Mailbox disconnect could not write audit log', { mailboxId: id });
  }

  logger.info('Mailbox disconnected', {
    mailboxId: id,
    alreadyDisconnected,
    disabledMappingCount,
    deactivatedSubscriptionCount,
    remoteSubscriptionsAttempted: remoteCleanup.attempted,
    remoteSubscriptionsFailed: remoteCleanup.failed,
  });

  return {
    mailboxId: id,
    alreadyDisconnected,
    disabledMappingCount,
    deactivatedSubscriptionCount,
    remoteCleanup,
  };
}

export const __internal = {
  MAILBOX_STATUS_DISABLED,
  TELEGRAM_MAPPING_STATUS_DISABLED,
  SUBSCRIPTION_STATUS_EXPIRED,
  SUBSCRIPTION_LIVE_STATUSES,
};
