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
  'findFirst' | 'findUnique' | 'create' | 'update'
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
    createdAt: row.createdAt,
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
    async markSent(processedMessageId, sentAt) {
      await client.processedMessage.update({
        where: { id: processedMessageId },
        data: {
          status: 'SENT',
          sentToTelegramAt: sentAt,
        },
      });
    },
  };
}
