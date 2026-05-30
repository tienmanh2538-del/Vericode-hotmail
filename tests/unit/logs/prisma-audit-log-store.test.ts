import { describe, it, expect, vi } from 'vitest';

import {
  createAuditLogInDb,
  listAuditLogsFromDb,
  type AuditLogPrismaClient,
} from '@/services/logs/prisma-audit-log-store';

function fakeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'al1',
    createdAt: new Date('2026-05-30T10:00:00.000Z'),
    action: 'CODE_SENT',
    entityType: 'code_event',
    entityId: 'mb1',
    actorUserId: null,
    actorEmail: null,
    ipAddress: null,
    severity: 'info',
    summary: 'Verification code sent to Telegram',
    metadataJson: { mailboxId: 'mb1' },
    ...overrides,
  };
}

describe('createAuditLogInDb', () => {
  it('persists a sanitized audit entry (sensitive metadata redacted)', async () => {
    const create = vi.fn(async (_args: { data: Record<string, unknown> }) =>
      fakeRow(),
    );
    const client = {
      auditLog: { create, findMany: vi.fn(), count: vi.fn() },
    } as unknown as AuditLogPrismaClient;

    await createAuditLogInDb(
      {
        action: 'CODE_SENT',
        entityType: 'code_event',
        entityId: 'mb1',
        severity: 'info',
        metadata: { mailboxId: 'mb1', accessToken: 'super-secret-token' },
      },
      { prisma: client },
    );

    const data = create.mock.calls[0]![0].data;
    expect(data.action).toBe('CODE_SENT');
    // The audit service sanitizer redacts secret-like keys before the DB write.
    expect((data.metadataJson as Record<string, unknown>).accessToken).toBe(
      '[REDACTED]',
    );
    expect((data.metadataJson as Record<string, unknown>).mailboxId).toBe('mb1');
  });

  it('rejects an unknown action (validation happens before the DB write)', async () => {
    const create = vi.fn();
    const client: AuditLogPrismaClient = {
      auditLog: { create, findMany: vi.fn(), count: vi.fn() },
    };
    await expect(
      createAuditLogInDb(
        { action: 'NOPE' as never, entityType: 'system' },
        { prisma: client },
      ),
    ).rejects.toThrow();
    expect(create).not.toHaveBeenCalled();
  });
});

describe('listAuditLogsFromDb', () => {
  it('applies the action filter and returns items + total', async () => {
    const findMany = vi.fn(
      async (_args: { where: Record<string, unknown> }) => [fakeRow()],
    );
    const count = vi.fn(async () => 1);
    const client = {
      auditLog: { create: vi.fn(), findMany, count },
    } as unknown as AuditLogPrismaClient;

    const result = await listAuditLogsFromDb(
      { action: 'CODE_SENT', limit: 50 },
      { prisma: client },
    );

    expect(result.total).toBe(1);
    expect(result.items[0].action).toBe('CODE_SENT');
    const where = findMany.mock.calls[0]![0].where;
    expect(where.action).toBe('CODE_SENT');
  });

  it('builds a search OR clause across safe fields', async () => {
    const findMany = vi.fn(
      async (_args: { where: Record<string, unknown> }) =>
        [] as ReturnType<typeof fakeRow>[],
    );
    const count = vi.fn(async () => 0);
    const client = {
      auditLog: { create: vi.fn(), findMany, count },
    } as unknown as AuditLogPrismaClient;

    await listAuditLogsFromDb({ search: 'box@example.com' }, { prisma: client });
    const where = findMany.mock.calls[0]![0].where;
    expect(Array.isArray(where.OR)).toBe(true);
  });

  it('is resilient: returns an empty result when the database throws', async () => {
    const findMany = vi.fn(async () => {
      throw new Error('db down');
    });
    const count = vi.fn(async () => {
      throw new Error('db down');
    });
    const client: AuditLogPrismaClient = {
      auditLog: { create: vi.fn(), findMany, count },
    };
    const result = await listAuditLogsFromDb({}, { prisma: client });
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });
});
