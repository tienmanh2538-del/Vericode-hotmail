import { describe, it, expect, vi, beforeEach } from 'vitest';

// TASK-068A — the one-active-mapping DB backstop (M2 / TOCTOU). The service
// pre-check (assertNoConflictForDestination) cannot fully close a check-then-write
// race, so a PARTIAL unique index on (mailboxId) WHERE status = 'ACTIVE' rejects
// the racing second writer with P2002. These tests prove the service translates
// that P2002 into a friendly conflict instead of leaking a 500 — i.e. you can
// never end up with two ACTIVE mappings for one mailbox, even under a race.
//
// All ids are synthetic. The chat id "-1001234567890" is a fake Telegram group id.

const {
  findMany,
  findUnique,
  findFirst,
  create,
  update,
  deleteFn,
  mailboxFindUnique,
  destinationFindUnique,
} = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  findFirst: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  deleteFn: vi.fn(),
  mailboxFindUnique: vi.fn(),
  destinationFindUnique: vi.fn(),
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
    mailbox: { findUnique: mailboxFindUnique },
    telegramDestination: { findUnique: destinationFindUnique },
  },
}));

import {
  createTelegramMappingFromDestination,
  updateTelegramMappingFromDestination,
  TelegramDestinationMappingConflictError,
} from '@/services/telegram/telegram-mapping.service';

const MAILBOX = { id: 'mb_1', customerId: 'cu_1', status: 'ACTIVE' };
const DESTINATION = {
  id: 'dest_1',
  customerId: 'cu_1',
  status: 'ACTIVE',
  telegramChatId: '-1001234567890',
  telegramGroupName: 'Client A',
  telegramThreadId: null,
  telegramTopicName: null,
};

const ACTIVE_INPUT = { mailboxId: 'mb_1', destinationId: 'dest_1', status: 'ACTIVE' };

// A Prisma-shaped P2002 with a chosen index/constraint target.
function p2002(target: string[] | string) {
  return { code: 'P2002', meta: { target } };
}

beforeEach(() => {
  vi.clearAllMocks();
  mailboxFindUnique.mockResolvedValue(MAILBOX);
  destinationFindUnique.mockResolvedValue(DESTINATION);
  // Pre-check passes (the race window): no existing conflicting row is seen.
  findFirst.mockResolvedValue(null);
});

describe('one-active-mapping DB backstop on create', () => {
  it('maps the partial-active unique violation to a mailbox conflict (no double ACTIVE)', async () => {
    create.mockRejectedValueOnce(p2002(['TelegramMapping_mailboxId_active_unique']));

    const err = await createTelegramMappingFromDestination(ACTIVE_INPUT).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TelegramDestinationMappingConflictError);
    expect((err as TelegramDestinationMappingConflictError).field).toBe('mailboxId');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('maps the (mailbox, chat) unique violation to a destination conflict', async () => {
    create.mockRejectedValueOnce(p2002(['mailboxId', 'telegramChatId']));

    const err = await createTelegramMappingFromDestination(ACTIVE_INPUT).catch(
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(TelegramDestinationMappingConflictError);
    expect((err as TelegramDestinationMappingConflictError).field).toBe(
      'destinationId',
    );
  });

  it('still succeeds on the happy path (no race)', async () => {
    create.mockResolvedValueOnce({
      id: 'tm_1',
      mailboxId: 'mb_1',
      telegramChatId: DESTINATION.telegramChatId,
      telegramGroupName: DESTINATION.telegramGroupName,
      telegramThreadId: null,
      telegramTopicName: null,
      status: 'ACTIVE',
      destinationId: 'dest_1',
      createdAt: new Date('2026-06-04T00:00:00.000Z'),
      updatedAt: new Date('2026-06-04T00:00:00.000Z'),
      mailbox: { emailAddress: 'a@example.test', customerId: 'cu_1', customer: { id: 'cu_1', name: 'Client A' } },
      destination: { ...DESTINATION, displayName: 'Client A group' },
    });

    const record = await createTelegramMappingFromDestination(ACTIVE_INPUT);
    expect(record.status).toBe('ACTIVE');
    expect(record.mailboxId).toBe('mb_1');
  });

  it('propagates non-P2002 errors unchanged', async () => {
    create.mockRejectedValueOnce(new Error('database unreachable'));
    await expect(
      createTelegramMappingFromDestination(ACTIVE_INPUT),
    ).rejects.toThrow('database unreachable');
  });
});

describe('one-active-mapping DB backstop on update', () => {
  it('maps the partial-active unique violation to a mailbox conflict', async () => {
    update.mockRejectedValueOnce(p2002('TelegramMapping_mailboxId_active_unique'));

    const err = await updateTelegramMappingFromDestination(
      'tm_other',
      ACTIVE_INPUT,
    ).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(TelegramDestinationMappingConflictError);
    expect((err as TelegramDestinationMappingConflictError).field).toBe('mailboxId');
    expect(update).toHaveBeenCalledTimes(1);
  });
});
