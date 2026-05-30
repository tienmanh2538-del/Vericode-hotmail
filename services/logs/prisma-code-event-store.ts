// TASK-040 preflight — Prisma-backed code event log.
//
// The Web UI (Next process) reads via `listCodeEventsFromDb`; the email worker
// (separate process) writes via `recordCodeEventToDb`. Both share the single
// `CodeEvent` table, so events produced by the worker are visible in the admin
// UI (the in-memory store could never bridge two processes).
//
// SECURITY: the masked code is validated upstream by `normalizeCodeEventInput`
// (a raw verification code is rejected). No email body / token is ever written.

import { prisma as defaultPrisma } from '@/lib/prisma';
import { createLogger, type Logger } from '@/lib/logger';
import {
  normalizeCodeEventInput,
  type CodeEventLogItem,
  type CodeEventPlatform,
  type CodeEventSource,
  type CodeEventStatus,
  type RecordCodeEventInput,
} from './code-event-log.service';

const DEFAULT_LIST_LIMIT = 200;

interface CodeEventRow {
  id: string;
  createdAt: Date;
  receivedAt: Date | null;
  mailboxEmail: string;
  customerName: string | null;
  platform: string;
  status: string;
  maskedCode: string | null;
  confidence: number | null;
  telegramGroupName: string | null;
  source: string;
  message: string | null;
}

export interface CodeEventPrismaClient {
  codeEvent: {
    create: (args: { data: Record<string, unknown> }) => Promise<CodeEventRow>;
    findMany: (args: unknown) => Promise<CodeEventRow[]>;
  };
}

export interface CodeEventDbDeps {
  prisma?: CodeEventPrismaClient;
  logger?: Logger;
}

function rowToItem(row: CodeEventRow): CodeEventLogItem {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    receivedAt: row.receivedAt ? row.receivedAt.toISOString() : undefined,
    mailboxEmail: row.mailboxEmail,
    customerName: row.customerName ?? undefined,
    platform: row.platform as CodeEventPlatform,
    status: row.status as CodeEventStatus,
    maskedCode: row.maskedCode ?? undefined,
    confidence: row.confidence ?? undefined,
    telegramGroupName: row.telegramGroupName ?? undefined,
    source: row.source as CodeEventSource,
    message: row.message ?? undefined,
  };
}

function resolveClient(deps: CodeEventDbDeps): CodeEventPrismaClient {
  return deps.prisma ?? (defaultPrisma as unknown as CodeEventPrismaClient);
}

/**
 * Persist a code event. Validation/masking is reused from the service, so a raw
 * verification code can never reach the database. Throws on DB failure — the
 * worker calls this fire-and-forget with its own catch.
 */
export async function recordCodeEventToDb(
  input: RecordCodeEventInput,
  deps: CodeEventDbDeps = {},
): Promise<CodeEventLogItem> {
  const normalized = normalizeCodeEventInput(input);
  const prisma = resolveClient(deps);
  const row = await prisma.codeEvent.create({
    data: {
      createdAt: new Date(normalized.createdAt),
      receivedAt: normalized.receivedAt ? new Date(normalized.receivedAt) : null,
      mailboxEmail: normalized.mailboxEmail,
      customerName: normalized.customerName ?? null,
      platform: normalized.platform,
      status: normalized.status,
      maskedCode: normalized.maskedCode ?? null,
      confidence:
        normalized.confidence !== undefined
          ? Math.round(normalized.confidence)
          : null,
      telegramGroupName: normalized.telegramGroupName ?? null,
      source: normalized.source,
      message: normalized.message ?? null,
    },
  });
  return rowToItem(row);
}

/**
 * List recent code events (newest first). Resilient: returns an empty array if
 * the database is unreachable so the admin page renders instead of crashing.
 */
export async function listCodeEventsFromDb(
  deps: CodeEventDbDeps & { limit?: number } = {},
): Promise<CodeEventLogItem[]> {
  const prisma = resolveClient(deps);
  const logger = deps.logger ?? createLogger();
  const take =
    typeof deps.limit === 'number' && deps.limit > 0
      ? Math.min(Math.floor(deps.limit), 1000)
      : DEFAULT_LIST_LIMIT;
  try {
    const rows = await prisma.codeEvent.findMany({
      orderBy: { createdAt: 'desc' },
      take,
    });
    return rows.map(rowToItem);
  } catch {
    logger.error('Failed to list code events from database');
    return [];
  }
}
