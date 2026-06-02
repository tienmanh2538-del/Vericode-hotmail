import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findMany, findUnique, findFirst, create, update } = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    telegramDestination: { findMany, findUnique, findFirst, create, update },
  },
}));

import {
  createTelegramDestination,
  disableTelegramDestination,
  getTelegramDestinationById,
  listTelegramDestinations,
  TelegramDestinationConflictError,
  TelegramDestinationValidationError,
} from '@/services/telegram/telegram-destination.service';

const FIXTURE_ROW = {
  id: 'dest_1',
  customerId: 'cu_1',
  displayName: 'Client A group',
  telegramGroupName: 'Client A verification',
  telegramTopicName: null,
  telegramChatId: '-1001234567890',
  telegramThreadId: null,
  status: 'ACTIVE',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  customer: { name: 'Client A' },
  _count: { mappings: 2 },
};

beforeEach(() => {
  findMany.mockReset();
  findUnique.mockReset();
  findFirst.mockReset();
  create.mockReset();
  update.mockReset();
});

describe('listTelegramDestinations', () => {
  it('maps rows to records and exposes mapping count', async () => {
    findMany.mockResolvedValue([FIXTURE_ROW]);
    const result = await listTelegramDestinations();
    expect(result[0]).toEqual({
      id: 'dest_1',
      customerId: 'cu_1',
      customerName: 'Client A',
      displayName: 'Client A group',
      telegramGroupName: 'Client A verification',
      telegramTopicName: null,
      telegramChatId: '-1001234567890',
      telegramThreadId: null,
      status: 'ACTIVE',
      mappingCount: 2,
      createdAt: FIXTURE_ROW.createdAt,
      updatedAt: FIXTURE_ROW.updatedAt,
    });
  });

  it('constrains to assigned customers for the STAFF scope', async () => {
    findMany.mockResolvedValue([]);
    await listTelegramDestinations({ kind: 'assigned', customerIds: ['cu_1'] });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { customerId: { in: ['cu_1'] } } }),
    );
  });
});

describe('getTelegramDestinationById', () => {
  it('returns null without hitting Prisma when id is empty', async () => {
    expect(await getTelegramDestinationById('')).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('fails closed when the STAFF scope excludes the customer', async () => {
    findUnique.mockResolvedValue(FIXTURE_ROW);
    const result = await getTelegramDestinationById('dest_1', {
      kind: 'assigned',
      customerIds: ['cu_other'],
    });
    expect(result).toBeNull();
  });
});

describe('createTelegramDestination', () => {
  it('rejects invalid input', async () => {
    await expect(createTelegramDestination({})).rejects.toBeInstanceOf(
      TelegramDestinationValidationError,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('creates a plain group destination', async () => {
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue(FIXTURE_ROW);

    await createTelegramDestination({
      customerId: 'cu_1',
      displayName: 'Client A group',
      telegramGroupName: 'Client A verification',
      telegramChatId: '-1001234567890',
      status: 'ACTIVE',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          customerId: 'cu_1',
          telegramChatId: '-1001234567890',
          telegramThreadId: null,
        }),
      }),
    );
  });

  it('creates a topic destination', async () => {
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({
      ...FIXTURE_ROW,
      telegramThreadId: '42',
      telegramTopicName: 'Codes',
    });

    const result = await createTelegramDestination({
      customerId: 'cu_1',
      displayName: 'Client A topic',
      telegramGroupName: 'Client A verification',
      telegramChatId: '-1001234567890',
      telegramThreadId: '42',
      telegramTopicName: 'Codes',
      status: 'ACTIVE',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ telegramThreadId: '42', telegramTopicName: 'Codes' }),
      }),
    );
    expect(result.telegramThreadId).toBe('42');
  });

  it('rejects a duplicate destination (same customer + chat + thread)', async () => {
    findFirst.mockResolvedValue({ id: 'existing' });

    await expect(
      createTelegramDestination({
        customerId: 'cu_1',
        displayName: 'Dup',
        telegramGroupName: 'Client A verification',
        telegramChatId: '-1001234567890',
        status: 'ACTIVE',
      }),
    ).rejects.toBeInstanceOf(TelegramDestinationConflictError);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('disableTelegramDestination', () => {
  it('sets status to DISABLED', async () => {
    update.mockResolvedValue({ ...FIXTURE_ROW, status: 'DISABLED' });
    const result = await disableTelegramDestination('dest_1');
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'dest_1' },
        data: { status: 'DISABLED' },
      }),
    );
    expect(result.status).toBe('DISABLED');
  });
});
