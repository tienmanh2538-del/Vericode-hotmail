// TASK-027 — Prisma-backed implementation of `ProcessedMessageStore` used by
// the email worker pipeline. The schema's ProcessedMessage table already exists
// (TASK-004); this adapter only translates between the dedup service shape and
// the Prisma row layout. No schema changes are introduced.

import type { Prisma, PrismaClient } from '@prisma/client';

import { prisma as defaultPrisma } from '@/lib/prisma';
import { isUniqueConstraintError } from '@/lib/db/prisma-error';
import {
  DEFAULT_BUCKET_MINUTES,
  ProcessedMessageDuplicateError,
  type CreateProcessedMessageInput,
  type ProcessedMessageRecord,
  type ProcessedMessageStatus,
  type ProcessedMessageStore,
} from './deduplication.service';

type ProcessedMessageDelegate = Pick<
  PrismaClient['processedMessage'],
  // TASK-090 — `updateMany` carries every conditional (CAS) delivery-state
  // write: its WHERE encodes the ownership/lease/status predicate and Postgres
  // row-level update atomicity makes it the single serialisation point.
  'findFirst' | 'findUnique' | 'create' | 'updateMany'
>;

export interface ProcessedMessagePrismaClient {
  processedMessage: ProcessedMessageDelegate;
}

const STATUS_VALUES: Record<string, ProcessedMessageStatus> = {
  DETECTED: 'DETECTED',
  SENT: 'SENT',
  FAILED: 'FAILED',
  SKIPPED_LOW_CONFIDENCE: 'SKIPPED_LOW_CONFIDENCE',
  DUPLICATE: 'DUPLICATE',
};

interface MinimalPrismaRow {
  id: string;
  mailboxId: string;
  graphMessageId: string;
  internetMessageId: string | null;
  codeHash: string | null;
  receivedAt: Date;
  senderEmail: string;
  subjectHash: string | null;
  status: string;
  sentToTelegramAt: Date | null;
  deliveryAttempts: number;
  deliveryLeaseUntil: Date | null;
  deliveryOwner: string | null;
  deliveryFailureReason: string | null;
  createdAt: Date;
}

function toRecord(row: MinimalPrismaRow): ProcessedMessageRecord {
  return {
    id: row.id,
    mailboxId: row.mailboxId,
    graphMessageId: row.graphMessageId,
    internetMessageId: row.internetMessageId,
    codeHash: row.codeHash,
    receivedAt: row.receivedAt,
    // Schema has no receivedAtBucket column; dedup contract allows null.
    receivedAtBucket: null,
    senderEmail: row.senderEmail.length > 0 ? row.senderEmail : null,
    subjectHash: row.subjectHash,
    status: STATUS_VALUES[row.status] ?? 'DETECTED',
    sentToTelegramAt: row.sentToTelegramAt,
    deliveryAttempts: row.deliveryAttempts,
    deliveryLeaseUntil: row.deliveryLeaseUntil,
    deliveryOwner: row.deliveryOwner,
    deliveryFailureReason: row.deliveryFailureReason,
    createdAt: row.createdAt,
  };
}

// TASK-090 — WHERE fragment: "the delivery lease is absent or expired at
// `now`". Shared by the CAS claim and the unclaimed-terminalisation writes.
function leaseFreeWhere(now: Date): Prisma.ProcessedMessageWhereInput {
  return {
    OR: [
      { deliveryLeaseUntil: null },
      { deliveryLeaseUntil: { lte: now } },
    ],
  };
}

function bucketWindow(bucketIso: string): { gte: Date; lt: Date } | null {
  const start = new Date(bucketIso);
  if (Number.isNaN(start.getTime())) return null;
  const end = new Date(start.getTime() + DEFAULT_BUCKET_MINUTES * 60_000);
  return { gte: start, lt: end };
}

export function createPrismaProcessedMessageStore(
  client: ProcessedMessagePrismaClient = defaultPrisma as unknown as ProcessedMessagePrismaClient,
): ProcessedMessageStore {
  return {
    async findById(processedMessageId) {
      const row = await client.processedMessage.findUnique({
        where: { id: processedMessageId },
      });
      return row ? toRecord(row as MinimalPrismaRow) : null;
    },
    async findByGraphMessageId(mailboxId, graphMessageId) {
      const row = await client.processedMessage.findUnique({
        where: {
          mailboxId_graphMessageId: { mailboxId, graphMessageId },
        } as Prisma.ProcessedMessageWhereUniqueInput,
      });
      return row ? toRecord(row as MinimalPrismaRow) : null;
    },
    async findByInternetMessageId(mailboxId, internetMessageId) {
      const row = await client.processedMessage.findFirst({
        where: { mailboxId, internetMessageId },
      });
      return row ? toRecord(row as MinimalPrismaRow) : null;
    },
    async findByCodeBucket(mailboxId, codeHash, receivedAtBucket) {
      const window = bucketWindow(receivedAtBucket);
      if (!window) return null;
      const row = await client.processedMessage.findFirst({
        where: {
          mailboxId,
          codeHash,
          receivedAt: { gte: window.gte, lt: window.lt },
        },
      });
      return row ? toRecord(row as MinimalPrismaRow) : null;
    },
    async create(input: CreateProcessedMessageInput) {
      try {
        const row = await client.processedMessage.create({
          data: {
            mailboxId: input.mailboxId,
            graphMessageId: input.graphMessageId,
            internetMessageId: input.internetMessageId,
            codeHash: input.codeHash,
            receivedAt: input.receivedAt,
            // Schema requires senderEmail; persist an empty marker when callers
            // omit it (e.g. mock flows) rather than failing the dedup claim.
            senderEmail: input.senderEmail ?? '',
            subjectHash: input.subjectHash,
            // TASK-090 — initial delivery ownership, atomic with the INSERT.
            deliveryOwner: input.deliveryOwner ?? null,
            deliveryLeaseUntil: input.deliveryLeaseUntil ?? null,
            deliveryAttempts: input.deliveryAttempts ?? 0,
          },
        });
        return toRecord(row as MinimalPrismaRow);
      } catch (err) {
        // TASK-068A — the @@unique([mailboxId, graphMessageId]) rejected a racing
        // insert (P2002). Surface it as a typed duplicate so the dedup claim can
        // treat it as a clean skip instead of letting BullMQ retry the message a
        // sibling flow already claimed. Other errors propagate unchanged.
        if (isUniqueConstraintError(err)) {
          throw new ProcessedMessageDuplicateError();
        }
        throw err;
      }
    },
    async markSent(processedMessageId, sentAt, ownerToken) {
      // TASK-090 — conditional completion. With a token the WHERE fences on the
      // CURRENT owner of a still-DETECTED row, so a stale owner (whose lease was
      // taken over after a crash/hang) can never overwrite the newer owner's
      // state. Without a token (legacy mock flow — no concurrent delivery
      // claimants exist there) the write stays keyed by id only.
      const where: Prisma.ProcessedMessageWhereInput =
        ownerToken !== undefined
          ? { id: processedMessageId, status: 'DETECTED', deliveryOwner: ownerToken }
          : { id: processedMessageId };
      const result = await client.processedMessage.updateMany({
        where,
        data: {
          status: 'SENT',
          sentToTelegramAt: sentAt,
          deliveryLeaseUntil: null,
        },
      });
      return result.count > 0;
    },
    async claimDelivery(input) {
      // TASK-090 — THE atomic delivery-ownership CAS. Postgres applies the
      // UPDATE row-atomically: of two concurrent claimants, exactly one
      // matches the WHERE (status still DETECTED, lease absent/expired,
      // budget left) and flips owner+lease+attempts in the same statement.
      const result = await client.processedMessage.updateMany({
        where: {
          id: input.processedMessageId,
          status: 'DETECTED',
          deliveryAttempts: { lt: input.maxAttempts },
          ...leaseFreeWhere(input.now),
        },
        data: {
          deliveryOwner: input.ownerToken,
          deliveryLeaseUntil: input.leaseUntil,
          deliveryAttempts: { increment: 1 },
        },
      });
      return result.count > 0;
    },
    async releaseDelivery(processedMessageId, ownerToken) {
      const result = await client.processedMessage.updateMany({
        where: {
          id: processedMessageId,
          status: 'DETECTED',
          deliveryOwner: ownerToken,
        },
        data: {
          deliveryOwner: null,
          deliveryLeaseUntil: null,
        },
      });
      return result.count > 0;
    },
    async markFailedByOwner(processedMessageId, ownerToken, reason) {
      const result = await client.processedMessage.updateMany({
        where: {
          id: processedMessageId,
          status: 'DETECTED',
          deliveryOwner: ownerToken,
        },
        data: {
          status: 'FAILED',
          deliveryFailureReason: reason,
          deliveryLeaseUntil: null,
        },
      });
      return result.count > 0;
    },
    async markFailedIfUnclaimed(input) {
      const result = await client.processedMessage.updateMany({
        where: {
          id: input.processedMessageId,
          status: 'DETECTED',
          ...(input.minAttempts !== undefined
            ? { deliveryAttempts: { gte: input.minAttempts } }
            : {}),
          ...leaseFreeWhere(input.now),
        },
        data: {
          status: 'FAILED',
          deliveryFailureReason: input.reason,
          deliveryLeaseUntil: null,
        },
      });
      return result.count > 0;
    },
  };
}
