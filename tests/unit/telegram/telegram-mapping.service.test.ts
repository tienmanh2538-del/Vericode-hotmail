import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  findMany,
  findUnique,
  findFirst,
  create,
  update,
  deleteFn,
} = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteFn: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    telegramMapping: {
      findMany,
      findUnique,
      findFirst,
      create,
      update,
      delete: deleteFn,
    },
  },
}));

import {
  createTelegramMapping,
  deleteTelegramMapping,
  disableTelegramMapping,
  findActiveMappingForMailbox,
  getTelegramMappingById,
  listTelegramMappings,
  TelegramMappingConflictError,
  TelegramMappingValidationError,
  updateTelegramMapping,
} from '@/services/telegram/telegram-mapping.service';

const FIXTURE_ROW = {
  id: 'tm_1',
  mailboxId: 'mb_1',
  telegramChatId: '-1001234567890',
  telegramGroupName: 'Client A',
  telegramThreadId: null,
  telegramTopicName: null,
  status: 'ACTIVE',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  mailbox: {
    emailAddress: 'client-a@hotmail.com',
    customerId: 'cu_1',
    customer: { id: 'cu_1', name: 'Client A' },
  },
};

beforeEach(() => {
  findMany.mockReset();
  findUnique.mockReset();
  findFirst.mockReset();
  create.mockReset();
  update.mockReset();
  deleteFn.mockReset();
});

describe('listTelegramMappings', () => {
  it('maps rows to records ordered by createdAt desc', async () => {
    findMany.mockResolvedValue([FIXTURE_ROW]);
    const result = await listTelegramMappings();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { createdAt: 'desc' } }),
    );
    expect(result[0]).toEqual({
      id: 'tm_1',
      mailboxId: 'mb_1',
      mailboxEmail: 'client-a@hotmail.com',
      customerId: 'cu_1',
      customerName: 'Client A',
      telegramChatId: '-1001234567890',
      telegramGroupName: 'Client A',
      telegramThreadId: null,
      telegramTopicName: null,
      status: 'ACTIVE',
      createdAt: FIXTURE_ROW.createdAt,
      updatedAt: FIXTURE_ROW.updatedAt,
    });
  });

  it('returns [] when there are no rows', async () => {
    findMany.mockResolvedValue([]);
    expect(await listTelegramMappings()).toEqual([]);
  });
});

describe('getTelegramMappingById', () => {
  it('returns null when id is empty without hitting Prisma', async () => {
    const result = await getTelegramMappingById('');
    expect(result).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns mapped record when row exists', async () => {
    findUnique.mockResolvedValue(FIXTURE_ROW);
    const result = await getTelegramMappingById('tm_1');
    expect(result?.id).toBe('tm_1');
    expect(result?.mailboxEmail).toBe('client-a@hotmail.com');
  });
});

describe('createTelegramMapping', () => {
  it('rejects invalid input with a validation error', async () => {
    await expect(createTelegramMapping({})).rejects.toBeInstanceOf(
      TelegramMappingValidationError,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects duplicate (mailbox, chatId) pair', async () => {
    findFirst.mockResolvedValueOnce({ id: 'existing' });
    await expect(
      createTelegramMapping({
        mailboxId: 'mb_1',
        telegramChatId: '-1001234567890',
        telegramGroupName: 'Client A',
        status: 'ACTIVE',
      }),
    ).rejects.toBeInstanceOf(TelegramMappingConflictError);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects another ACTIVE mapping for the same mailbox', async () => {
    findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'existing-active' });

    await expect(
      createTelegramMapping({
        mailboxId: 'mb_1',
        telegramChatId: '-1009999999999',
        telegramGroupName: 'Client A',
        status: 'ACTIVE',
      }),
    ).rejects.toBeInstanceOf(TelegramMappingConflictError);
    expect(create).not.toHaveBeenCalled();
  });

  it('writes validated input to prisma.telegramMapping.create', async () => {
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({
      ...FIXTURE_ROW,
      telegramGroupName: 'New Group',
    });

    const result = await createTelegramMapping({
      mailboxId: 'mb_1',
      telegramChatId: '-1001234567890',
      telegramGroupName: 'New Group',
      status: 'ACTIVE',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          mailboxId: 'mb_1',
          telegramChatId: '-1001234567890',
          telegramGroupName: 'New Group',
          telegramThreadId: null,
          telegramTopicName: null,
          status: 'ACTIVE',
        },
      }),
    );
    expect(result.telegramGroupName).toBe('New Group');
  });

  it('allows two different mailboxes to share the same chat id', async () => {
    // No (mailbox, chatId) duplicate and no other ACTIVE mapping for THIS
    // mailbox → the shared chat id must be accepted (TASK-041).
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({
      ...FIXTURE_ROW,
      id: 'tm_2',
      mailboxId: 'mb_2',
    });

    await createTelegramMapping({
      mailboxId: 'mb_2',
      telegramChatId: '-1001234567890',
      telegramGroupName: 'Client A',
      status: 'ACTIVE',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          mailboxId: 'mb_2',
          telegramChatId: '-1001234567890',
        }),
      }),
    );
  });

  it('allows two different mailboxes to share the same chat id AND topic', async () => {
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({
      ...FIXTURE_ROW,
      id: 'tm_3',
      mailboxId: 'mb_3',
      telegramThreadId: '42',
      telegramTopicName: 'Shared topic',
    });

    const result = await createTelegramMapping({
      mailboxId: 'mb_3',
      telegramChatId: '-1001234567890',
      telegramGroupName: 'Client A',
      telegramThreadId: '42',
      telegramTopicName: 'Shared topic',
      status: 'ACTIVE',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          mailboxId: 'mb_3',
          telegramChatId: '-1001234567890',
          telegramThreadId: '42',
          telegramTopicName: 'Shared topic',
        }),
      }),
    );
    expect(result.telegramThreadId).toBe('42');
    expect(result.telegramTopicName).toBe('Shared topic');
  });
});

describe('updateTelegramMapping', () => {
  it('rejects when id is empty', async () => {
    await expect(updateTelegramMapping('', {})).rejects.toBeInstanceOf(
      TelegramMappingValidationError,
    );
  });

  it('forwards validated input to prisma.telegramMapping.update', async () => {
    findFirst.mockResolvedValue(null);
    update.mockResolvedValue({
      ...FIXTURE_ROW,
      status: 'DISABLED',
    });

    const result = await updateTelegramMapping('tm_1', {
      mailboxId: 'mb_1',
      telegramChatId: '-1001234567890',
      telegramGroupName: 'Client A',
      status: 'DISABLED',
    });

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tm_1' },
        data: {
          mailboxId: 'mb_1',
          telegramChatId: '-1001234567890',
          telegramGroupName: 'Client A',
          telegramThreadId: null,
          telegramTopicName: null,
          status: 'DISABLED',
        },
      }),
    );
    expect(result.status).toBe('DISABLED');
  });
});

describe('disableTelegramMapping', () => {
  it('sets status to DISABLED', async () => {
    update.mockResolvedValue({ ...FIXTURE_ROW, status: 'DISABLED' });
    const result = await disableTelegramMapping('tm_1');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tm_1' },
        data: { status: 'DISABLED' },
      }),
    );
    expect(result.status).toBe('DISABLED');
  });
});

describe('deleteTelegramMapping', () => {
  it('calls prisma.telegramMapping.delete', async () => {
    deleteFn.mockResolvedValue(undefined);
    await deleteTelegramMapping('tm_1');
    expect(deleteFn).toHaveBeenCalledWith({ where: { id: 'tm_1' } });
  });

  it('rejects when id is empty', async () => {
    await expect(deleteTelegramMapping('')).rejects.toBeInstanceOf(
      TelegramMappingValidationError,
    );
    expect(deleteFn).not.toHaveBeenCalled();
  });
});

describe('findActiveMappingForMailbox', () => {
  it('returns null for empty input without hitting Prisma', async () => {
    expect(await findActiveMappingForMailbox('')).toBeNull();
    expect(findFirst).not.toHaveBeenCalled();
  });

  it('queries only ACTIVE mappings', async () => {
    findFirst.mockResolvedValue(FIXTURE_ROW);
    const result = await findActiveMappingForMailbox('client-a@hotmail.com');
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'ACTIVE' }),
      }),
    );
    expect(result?.id).toBe('tm_1');
  });
});
