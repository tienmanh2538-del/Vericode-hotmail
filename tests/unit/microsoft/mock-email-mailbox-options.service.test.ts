import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    mailbox: { findMany },
  },
}));

import {
  listMockEmailMailboxOptions,
  toMockEmailMailboxOption,
} from '@/services/microsoft/mock-email-mailbox-options.service';

beforeEach(() => {
  findMany.mockReset();
});

describe('toMockEmailMailboxOption', () => {
  it('reports an active mapping with a plain group destination', () => {
    const option = toMockEmailMailboxOption({
      emailAddress: 'a@hotmail.com',
      customer: { name: 'Acme' },
      telegramMappings: [
        {
          telegramGroupName: 'Acme codes',
          telegramChatId: '-1001234567890',
          telegramTopicName: null,
          telegramThreadId: null,
        },
      ],
    });
    expect(option).toEqual({
      emailAddress: 'a@hotmail.com',
      customerName: 'Acme',
      hasActiveMapping: true,
      destinationLabel: 'Acme codes',
    });
  });

  it('includes the forum topic in the destination label when present', () => {
    const option = toMockEmailMailboxOption({
      emailAddress: 'a@hotmail.com',
      customer: { name: 'Acme' },
      telegramMappings: [
        {
          telegramGroupName: 'Acme codes',
          telegramChatId: '-1001234567890',
          telegramTopicName: 'Verify',
          telegramThreadId: '42',
        },
      ],
    });
    expect(option.destinationLabel).toBe('Acme codes › Verify (#42)');
  });

  it('falls back to a masked chat id when no group name is set', () => {
    const option = toMockEmailMailboxOption({
      emailAddress: 'a@hotmail.com',
      customer: null,
      telegramMappings: [
        {
          telegramGroupName: null,
          telegramChatId: '-1001234567890',
          telegramTopicName: null,
          telegramThreadId: null,
        },
      ],
    });
    expect(option.customerName).toBeNull();
    expect(option.destinationLabel).toBe('••••7890');
  });

  it('marks a mailbox with no active mapping as needing mapping', () => {
    const option = toMockEmailMailboxOption({
      emailAddress: 'a@hotmail.com',
      customer: { name: 'Acme' },
      telegramMappings: [],
    });
    expect(option.hasActiveMapping).toBe(false);
    expect(option.destinationLabel).toBeNull();
  });
});

describe('listMockEmailMailboxOptions scope', () => {
  it('does not filter for unscoped (OWNER/ADMIN) callers', async () => {
    findMany.mockResolvedValue([]);
    await listMockEmailMailboxOptions();
    expect(findMany.mock.calls[0]?.[0].where).toBeUndefined();
  });

  it('constrains to assigned customers for the STAFF scope', async () => {
    findMany.mockResolvedValue([]);
    await listMockEmailMailboxOptions({
      kind: 'assigned',
      customerIds: ['cus_1'],
    });
    expect(findMany.mock.calls[0]?.[0].where).toEqual({
      customerId: { in: ['cus_1'] },
    });
  });

  it('only selects ACTIVE telegram mappings', async () => {
    findMany.mockResolvedValue([]);
    await listMockEmailMailboxOptions();
    const select = findMany.mock.calls[0]?.[0].select;
    expect(select.telegramMappings.where).toEqual({ status: 'ACTIVE' });
  });
});
