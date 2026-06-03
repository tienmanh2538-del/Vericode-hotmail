import { describe, it, expect, vi, beforeEach } from 'vitest';

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
    mailbox: {
      findUnique: mailboxFindUnique,
    },
    telegramDestination: {
      findUnique: destinationFindUnique,
    },
  },
}));

import {
  createTelegramMapping,
  createTelegramMappingFromDestination,
  deleteTelegramMapping,
  disableTelegramMapping,
  findActiveMappingForMailbox,
  getTelegramMappingById,
  listTelegramMappings,
  TelegramDestinationMappingConflictError,
  TelegramMappingConflictError,
  TelegramMappingValidationError,
  updateTelegramMapping,
  updateTelegramMappingFromDestination,
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
  mailboxFindUnique.mockReset();
  destinationFindUnique.mockReset();
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
      destinationId: null,
      destinationName: null,
      destinationStatus: null,
      createdAt: FIXTURE_ROW.createdAt,
      updatedAt: FIXTURE_ROW.updatedAt,
    });
  });

  it('returns [] when there are no rows', async () => {
    findMany.mockResolvedValue([]);
    expect(await listTelegramMappings()).toEqual([]);
  });

  it('constrains to assigned customers for the STAFF scope', async () => {
    findMany.mockResolvedValue([FIXTURE_ROW]);
    await listTelegramMappings({ kind: 'assigned', customerIds: ['cu_1'] });
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { mailbox: { customerId: { in: ['cu_1'] } } },
      }),
    );
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

  it('returns the record when the STAFF scope includes the mapping customer', async () => {
    findUnique.mockResolvedValue(FIXTURE_ROW);
    const result = await getTelegramMappingById('tm_1', {
      kind: 'assigned',
      customerIds: ['cu_1'],
    });
    expect(result?.id).toBe('tm_1');
  });

  it('returns null when the STAFF scope excludes the mapping customer', async () => {
    findUnique.mockResolvedValue(FIXTURE_ROW);
    const result = await getTelegramMappingById('tm_1', {
      kind: 'assigned',
      customerIds: ['cu_other'],
    });
    expect(result).toBeNull();
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

  it('changes the destination of the only active mapping in place (TASK-044)', async () => {
    // TASK-044 scenario 7: editing a mailbox's destination keeps exactly one
    // active mapping. The conflict checks exclude the row being edited, so the
    // mapping can be re-pointed to a new chat id without tripping
    // "already has an active mapping" against itself.
    findFirst.mockResolvedValue(null);
    update.mockResolvedValue({
      ...FIXTURE_ROW,
      telegramChatId: '-1007777777777',
      telegramGroupName: 'Client A — new group',
    });

    const result = await updateTelegramMapping('tm_1', {
      mailboxId: 'mb_1',
      telegramChatId: '-1007777777777',
      telegramGroupName: 'Client A — new group',
      status: 'ACTIVE',
    });

    // Both pre-checks must exclude the edited row so it never conflicts with
    // itself; the final state still has a single active destination.
    expect(findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ NOT: { id: 'tm_1' } }),
      }),
    );
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'tm_1' },
        data: expect.objectContaining({
          telegramChatId: '-1007777777777',
          status: 'ACTIVE',
        }),
      }),
    );
    expect(result.telegramChatId).toBe('-1007777777777');
    expect(result.status).toBe('ACTIVE');
  });

  it('rejects activating a second mapping for a mailbox that already has one (TASK-044)', async () => {
    // No same-(mailbox, chatId) duplicate, but a DIFFERENT active mapping
    // already exists for this mailbox → activating this one would create two
    // active destinations, which the service must refuse.
    findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'other-active' });

    await expect(
      updateTelegramMapping('tm_1', {
        mailboxId: 'mb_1',
        telegramChatId: '-1008888888888',
        telegramGroupName: 'Client A',
        status: 'ACTIVE',
      }),
    ).rejects.toBeInstanceOf(TelegramMappingConflictError);
    expect(update).not.toHaveBeenCalled();
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

  it('resolves chat/thread from the linked destination (TASK-053)', async () => {
    // The mapping snapshot may be stale; the live destination is the source of
    // truth, so the pipeline must route using the destination's chat/thread.
    findFirst.mockResolvedValue({
      ...FIXTURE_ROW,
      destinationId: 'dest_1',
      telegramChatId: '-1000000000000',
      telegramThreadId: null,
      destination: {
        id: 'dest_1',
        displayName: 'Client A group',
        telegramGroupName: 'Client A — live',
        telegramTopicName: 'Codes',
        telegramChatId: '-1001234567890',
        telegramThreadId: '42',
        status: 'ACTIVE',
      },
    });
    const result = await findActiveMappingForMailbox('client-a@hotmail.com');
    expect(result?.telegramChatId).toBe('-1001234567890');
    expect(result?.telegramThreadId).toBe('42');
    expect(result?.telegramGroupName).toBe('Client A — live');
  });

  it('returns null when the linked destination is DISABLED (TASK-053)', async () => {
    // Mapping row is ACTIVE but its destination is disabled → must not deliver.
    findFirst.mockResolvedValue({
      ...FIXTURE_ROW,
      destinationId: 'dest_1',
      destination: {
        id: 'dest_1',
        displayName: 'Client A group',
        telegramGroupName: 'Client A',
        telegramTopicName: null,
        telegramChatId: '-1001234567890',
        telegramThreadId: null,
        status: 'DISABLED',
      },
    });
    const result = await findActiveMappingForMailbox('client-a@hotmail.com');
    expect(result).toBeNull();
  });
});

describe('createTelegramMappingFromDestination (TASK-053)', () => {
  const ACTIVE_DESTINATION = {
    id: 'dest_1',
    customerId: 'cu_1',
    status: 'ACTIVE',
    telegramChatId: '-1001234567890',
    telegramGroupName: 'Client A group',
    telegramThreadId: '42',
    telegramTopicName: 'Codes',
  };

  it('derives chat/thread from the destination and writes destinationId', async () => {
    mailboxFindUnique.mockResolvedValue({ id: 'mb_1', customerId: 'cu_1' });
    destinationFindUnique.mockResolvedValue(ACTIVE_DESTINATION);
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({
      ...FIXTURE_ROW,
      destinationId: 'dest_1',
      destination: {
        ...ACTIVE_DESTINATION,
        displayName: 'Client A group',
      },
    });

    const result = await createTelegramMappingFromDestination({
      mailboxId: 'mb_1',
      destinationId: 'dest_1',
      status: 'ACTIVE',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          mailboxId: 'mb_1',
          destinationId: 'dest_1',
          telegramChatId: '-1001234567890',
          telegramThreadId: '42',
          telegramTopicName: 'Codes',
          status: 'ACTIVE',
        }),
      }),
    );
    expect(result.destinationId).toBe('dest_1');
  });

  it('rejects mapping a mailbox to a destination of a DIFFERENT customer', async () => {
    mailboxFindUnique.mockResolvedValue({ id: 'mb_1', customerId: 'cu_1' });
    destinationFindUnique.mockResolvedValue({
      ...ACTIVE_DESTINATION,
      customerId: 'cu_other',
    });

    await expect(
      createTelegramMappingFromDestination({
        mailboxId: 'mb_1',
        destinationId: 'dest_1',
        status: 'ACTIVE',
      }),
    ).rejects.toBeInstanceOf(TelegramDestinationMappingConflictError);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects an ACTIVE mapping pointing at a DISABLED destination', async () => {
    mailboxFindUnique.mockResolvedValue({ id: 'mb_1', customerId: 'cu_1' });
    destinationFindUnique.mockResolvedValue({
      ...ACTIVE_DESTINATION,
      status: 'DISABLED',
    });

    await expect(
      createTelegramMappingFromDestination({
        mailboxId: 'mb_1',
        destinationId: 'dest_1',
        status: 'ACTIVE',
      }),
    ).rejects.toBeInstanceOf(TelegramDestinationMappingConflictError);
    expect(create).not.toHaveBeenCalled();
  });

  it('allows a second mailbox of the same customer to share the destination', async () => {
    mailboxFindUnique.mockResolvedValue({ id: 'mb_2', customerId: 'cu_1' });
    destinationFindUnique.mockResolvedValue(ACTIVE_DESTINATION);
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({
      ...FIXTURE_ROW,
      id: 'tm_2',
      mailboxId: 'mb_2',
      destinationId: 'dest_1',
    });

    await createTelegramMappingFromDestination({
      mailboxId: 'mb_2',
      destinationId: 'dest_1',
      status: 'ACTIVE',
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ mailboxId: 'mb_2', destinationId: 'dest_1' }),
      }),
    );
  });

  it('rejects a second ACTIVE mapping for the same mailbox', async () => {
    mailboxFindUnique.mockResolvedValue({ id: 'mb_1', customerId: 'cu_1' });
    destinationFindUnique.mockResolvedValue(ACTIVE_DESTINATION);
    findFirst
      .mockResolvedValueOnce(null) // no same (mailbox, chatId) duplicate
      .mockResolvedValueOnce({ id: 'other-active' }); // existing active mapping

    await expect(
      createTelegramMappingFromDestination({
        mailboxId: 'mb_1',
        destinationId: 'dest_1',
        status: 'ACTIVE',
      }),
    ).rejects.toBeInstanceOf(TelegramDestinationMappingConflictError);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects when the mailbox has no customer', async () => {
    mailboxFindUnique.mockResolvedValue({ id: 'mb_1', customerId: null });
    destinationFindUnique.mockResolvedValue(ACTIVE_DESTINATION);

    await expect(
      createTelegramMappingFromDestination({
        mailboxId: 'mb_1',
        destinationId: 'dest_1',
        status: 'ACTIVE',
      }),
    ).rejects.toBeInstanceOf(TelegramDestinationMappingConflictError);
    expect(create).not.toHaveBeenCalled();
  });
});

describe('disconnected-mailbox guard on the destination path (TASK-067)', () => {
  const ACTIVE_DESTINATION = {
    id: 'dest_1',
    customerId: 'cu_1',
    status: 'ACTIVE',
    telegramChatId: '-1001234567890',
    telegramGroupName: 'Client A group',
    telegramThreadId: '42',
    telegramTopicName: 'Codes',
  };

  it('rejects creating an ACTIVE mapping for a DISABLED (disconnected) mailbox', async () => {
    mailboxFindUnique.mockResolvedValue({
      id: 'mb_1',
      customerId: 'cu_1',
      status: 'DISABLED',
    });
    destinationFindUnique.mockResolvedValue(ACTIVE_DESTINATION);

    await expect(
      createTelegramMappingFromDestination({
        mailboxId: 'mb_1',
        destinationId: 'dest_1',
        status: 'ACTIVE',
      }),
    ).rejects.toBeInstanceOf(TelegramDestinationMappingConflictError);
    expect(create).not.toHaveBeenCalled();
  });

  it('rejects updating a mapping to ACTIVE for a DISABLED mailbox', async () => {
    mailboxFindUnique.mockResolvedValue({
      id: 'mb_1',
      customerId: 'cu_1',
      status: 'DISABLED',
    });
    destinationFindUnique.mockResolvedValue(ACTIVE_DESTINATION);

    await expect(
      updateTelegramMappingFromDestination('tm_1', {
        mailboxId: 'mb_1',
        destinationId: 'dest_1',
        status: 'ACTIVE',
      }),
    ).rejects.toBeInstanceOf(TelegramDestinationMappingConflictError);
    expect(update).not.toHaveBeenCalled();
  });

  it('allows a DISABLED (pre-staged) mapping for a DISABLED mailbox without re-enabling it', async () => {
    mailboxFindUnique.mockResolvedValue({
      id: 'mb_1',
      customerId: 'cu_1',
      status: 'DISABLED',
    });
    destinationFindUnique.mockResolvedValue(ACTIVE_DESTINATION);
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({
      ...FIXTURE_ROW,
      destinationId: 'dest_1',
      status: 'DISABLED',
      destination: { ...ACTIVE_DESTINATION, displayName: 'Client A group' },
    });

    await createTelegramMappingFromDestination({
      mailboxId: 'mb_1',
      destinationId: 'dest_1',
      status: 'DISABLED',
    });

    // The mapping is written as DISABLED; the service never touches mailbox state.
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DISABLED' }),
      }),
    );
    expect(mailboxFindUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'mb_1' } }),
    );
  });

  it('still allows an ACTIVE mapping for an ACTIVE mailbox', async () => {
    mailboxFindUnique.mockResolvedValue({
      id: 'mb_1',
      customerId: 'cu_1',
      status: 'ACTIVE',
    });
    destinationFindUnique.mockResolvedValue(ACTIVE_DESTINATION);
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({
      ...FIXTURE_ROW,
      destinationId: 'dest_1',
      destination: { ...ACTIVE_DESTINATION, displayName: 'Client A group' },
    });

    await createTelegramMappingFromDestination({
      mailboxId: 'mb_1',
      destinationId: 'dest_1',
      status: 'ACTIVE',
    });

    expect(create).toHaveBeenCalled();
  });
});

describe('customer-scope guard on the destination path (TASK-065)', () => {
  const ACTIVE_DESTINATION = {
    id: 'dest_1',
    customerId: 'cu_1',
    status: 'ACTIVE',
    telegramChatId: '-1001234567890',
    telegramGroupName: 'Client A group',
    telegramThreadId: '42',
    telegramTopicName: 'Codes',
  };

  it('rejects creating a mapping when the scope excludes the mailbox customer', async () => {
    // Fail-closed: a restricted viewer (assigned to cu_other) must not be able
    // to create a mapping for a mailbox belonging to cu_1, even though the
    // mailbox and destination share a customer.
    mailboxFindUnique.mockResolvedValue({ id: 'mb_1', customerId: 'cu_1' });
    destinationFindUnique.mockResolvedValue(ACTIVE_DESTINATION);

    await expect(
      createTelegramMappingFromDestination(
        { mailboxId: 'mb_1', destinationId: 'dest_1', status: 'ACTIVE' },
        { kind: 'assigned', customerIds: ['cu_other'] },
      ),
    ).rejects.toBeInstanceOf(TelegramDestinationMappingConflictError);
    // Fail before even loading the destination.
    expect(destinationFindUnique).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('allows creating a mapping when the assigned scope includes the customer', async () => {
    mailboxFindUnique.mockResolvedValue({ id: 'mb_1', customerId: 'cu_1' });
    destinationFindUnique.mockResolvedValue(ACTIVE_DESTINATION);
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({
      ...FIXTURE_ROW,
      destinationId: 'dest_1',
      destination: { ...ACTIVE_DESTINATION, displayName: 'Client A group' },
    });

    await createTelegramMappingFromDestination(
      { mailboxId: 'mb_1', destinationId: 'dest_1', status: 'ACTIVE' },
      { kind: 'assigned', customerIds: ['cu_1'] },
    );

    expect(create).toHaveBeenCalled();
  });

  it('allows the unrestricted (OWNER/ADMIN "all") scope', async () => {
    mailboxFindUnique.mockResolvedValue({ id: 'mb_1', customerId: 'cu_1' });
    destinationFindUnique.mockResolvedValue(ACTIVE_DESTINATION);
    findFirst.mockResolvedValue(null);
    create.mockResolvedValue({
      ...FIXTURE_ROW,
      destinationId: 'dest_1',
      destination: { ...ACTIVE_DESTINATION, displayName: 'Client A group' },
    });

    await createTelegramMappingFromDestination(
      { mailboxId: 'mb_1', destinationId: 'dest_1', status: 'ACTIVE' },
      { kind: 'all' },
    );

    expect(create).toHaveBeenCalled();
  });

  it('rejects updating a mapping onto an out-of-scope mailbox', async () => {
    mailboxFindUnique.mockResolvedValue({ id: 'mb_1', customerId: 'cu_1' });
    destinationFindUnique.mockResolvedValue(ACTIVE_DESTINATION);

    await expect(
      updateTelegramMappingFromDestination(
        'tm_1',
        { mailboxId: 'mb_1', destinationId: 'dest_1', status: 'ACTIVE' },
        { kind: 'assigned', customerIds: ['cu_other'] },
      ),
    ).rejects.toBeInstanceOf(TelegramDestinationMappingConflictError);
    expect(update).not.toHaveBeenCalled();
  });
});
