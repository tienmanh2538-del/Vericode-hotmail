import { describe, it, expect, vi } from 'vitest';

import {
  recordCodeEventToDb,
  listCodeEventsFromDb,
  type CodeEventPrismaClient,
} from '@/services/logs/prisma-code-event-store';

function fakeRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'ce1',
    createdAt: new Date('2026-05-30T10:00:00.000Z'),
    receivedAt: null,
    mailboxEmail: 'box@example.com',
    customerName: null,
    platform: 'Facebook/Meta',
    status: 'CODE_SENT',
    maskedCode: '82****',
    confidence: 91,
    telegramGroupName: null,
    source: 'webhook',
    message: null,
    ...overrides,
  };
}

describe('recordCodeEventToDb', () => {
  it('persists a masked code event and maps the row back to an item', async () => {
    const create = vi.fn(async (_args: { data: Record<string, unknown> }) =>
      fakeRow(),
    );
    const client = {
      codeEvent: { create, findMany: vi.fn() },
    } as unknown as CodeEventPrismaClient;

    const item = await recordCodeEventToDb(
      {
        mailboxEmail: 'box@example.com',
        status: 'CODE_SENT',
        maskedCode: '82****',
        confidence: 91,
        source: 'webhook',
      },
      { prisma: client },
    );

    expect(create).toHaveBeenCalledTimes(1);
    const data = create.mock.calls[0]![0].data;
    expect(data.maskedCode).toBe('82****');
    expect(data.status).toBe('CODE_SENT');
    expect(item.id).toBe('ce1');
    expect(item.createdAt).toBe('2026-05-30T10:00:00.000Z');
  });

  it('refuses to persist a raw verification code', async () => {
    const create = vi.fn();
    const client: CodeEventPrismaClient = {
      codeEvent: { create, findMany: vi.fn() },
    };

    await expect(
      recordCodeEventToDb(
        {
          mailboxEmail: 'box@example.com',
          status: 'CODE_SENT',
          maskedCode: '123456',
        },
        { prisma: client },
      ),
    ).rejects.toThrow(/full verification code/);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('listCodeEventsFromDb', () => {
  it('returns mapped events newest-first', async () => {
    const findMany = vi.fn(async () => [fakeRow(), fakeRow({ id: 'ce2' })]);
    const client: CodeEventPrismaClient = {
      codeEvent: { create: vi.fn(), findMany },
    };

    const items = await listCodeEventsFromDb({ prisma: client });
    expect(items).toHaveLength(2);
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
    );
  });

  it('is resilient: returns [] when the database throws', async () => {
    const findMany = vi.fn(async () => {
      throw new Error('db down');
    });
    const client: CodeEventPrismaClient = {
      codeEvent: { create: vi.fn(), findMany },
    };
    const items = await listCodeEventsFromDb({ prisma: client });
    expect(items).toEqual([]);
  });
});
