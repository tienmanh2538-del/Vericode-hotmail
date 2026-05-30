// TASK-040 preflight — Prisma-backed audit log.
//
// Shared store so the email worker / renewal worker (separate processes) and
// the admin UI (Next process) see the same audit trail. Sensitive metadata is
// scrubbed upstream by `normalizeAuditLogInput` before it reaches the DB.

import { prisma as defaultPrisma } from '@/lib/prisma';
import { createLogger, type Logger } from '@/lib/logger';
import {
  normalizeAuditLogInput,
  type AuditLogListFilters,
  type AuditLogListItem,
  type AuditLogListResult,
  type AuditLogMetadata,
  type AuditLogAction,
  type AuditLogEntityType,
  type AuditLogSeverity,
  type CreateAuditLogInput,
} from './audit-log.service';

const DEFAULT_LIST_LIMIT = 500;
const MAX_LIST_LIMIT = 1000;

interface AuditLogRow {
  id: string;
  createdAt: Date;
  action: string;
  entityType: string;
  entityId: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  ipAddress: string | null;
  severity: string;
  summary: string | null;
  metadataJson: unknown;
}

export interface AuditLogPrismaClient {
  auditLog: {
    create: (args: { data: Record<string, unknown> }) => Promise<AuditLogRow>;
    findMany: (args: unknown) => Promise<AuditLogRow[]>;
    count: (args: unknown) => Promise<number>;
  };
}

export interface AuditLogDbDeps {
  prisma?: AuditLogPrismaClient;
  logger?: Logger;
}

function resolveClient(deps: AuditLogDbDeps): AuditLogPrismaClient {
  return deps.prisma ?? (defaultPrisma as unknown as AuditLogPrismaClient);
}

function rowToItem(row: AuditLogRow): AuditLogListItem {
  const metadata =
    row.metadataJson && typeof row.metadataJson === 'object'
      ? (row.metadataJson as AuditLogMetadata)
      : null;
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    action: row.action as AuditLogAction,
    entityType: row.entityType as AuditLogEntityType,
    entityId: row.entityId,
    actorUserId: row.actorUserId,
    actorEmail: row.actorEmail,
    ipAddress: row.ipAddress,
    severity: row.severity as AuditLogSeverity,
    summary: row.summary,
    metadata,
  };
}

/**
 * Persist an audit entry. Validation + metadata sanitization is reused from the
 * service. Throws on DB failure (callers that must not fail wrap with .catch).
 */
export async function createAuditLogInDb(
  input: CreateAuditLogInput,
  deps: AuditLogDbDeps = {},
): Promise<AuditLogListItem> {
  const normalized = normalizeAuditLogInput(input);
  const prisma = resolveClient(deps);
  const row = await prisma.auditLog.create({
    data: {
      createdAt: new Date(normalized.createdAt),
      action: normalized.action,
      entityType: normalized.entityType,
      entityId: normalized.entityId,
      actorUserId: normalized.actorUserId,
      actorEmail: normalized.actorEmail,
      ipAddress: normalized.ipAddress,
      severity: normalized.severity,
      summary: normalized.summary,
      metadataJson: normalized.metadata ?? undefined,
    },
  });
  return rowToItem(row);
}

function toDate(value: string | Date | undefined): Date | undefined {
  if (value === undefined || value === null) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function buildWhere(filters: AuditLogListFilters): Record<string, unknown> {
  const where: Record<string, unknown> = {};
  if (filters.action) where.action = filters.action;
  if (filters.entityType) where.entityType = filters.entityType;
  if (filters.entityId) where.entityId = filters.entityId;

  const from = toDate(filters.from);
  const to = toDate(filters.to);
  if (from || to) {
    where.createdAt = {
      ...(from ? { gte: from } : {}),
      ...(to ? { lte: to } : {}),
    };
  }

  const search = typeof filters.search === 'string' ? filters.search.trim() : '';
  if (search.length > 0) {
    const contains = { contains: search, mode: 'insensitive' as const };
    where.OR = [
      { action: contains },
      { entityType: contains },
      { entityId: contains },
      { actorEmail: contains },
      { actorUserId: contains },
      { summary: contains },
      { ipAddress: contains },
    ];
  }
  return where;
}

/**
 * List audit entries from the DB with the same filter contract as the in-memory
 * service. Resilient: returns an empty result if the DB is unreachable.
 */
export async function listAuditLogsFromDb(
  filters: AuditLogListFilters = {},
  deps: AuditLogDbDeps = {},
): Promise<AuditLogListResult> {
  const prisma = resolveClient(deps);
  const logger = deps.logger ?? createLogger();
  const limit =
    typeof filters.limit === 'number' && filters.limit > 0
      ? Math.min(Math.floor(filters.limit), MAX_LIST_LIMIT)
      : DEFAULT_LIST_LIMIT;

  const where = buildWhere(filters);
  try {
    const [rows, total] = await Promise.all([
      prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        take: limit,
      }),
      prisma.auditLog.count({ where }),
    ]);
    return {
      items: rows.map(rowToItem),
      total,
      appliedFilters: { ...filters },
    };
  } catch {
    logger.error('Failed to list audit logs from database');
    return { items: [], total: 0, appliedFilters: { ...filters } };
  }
}
