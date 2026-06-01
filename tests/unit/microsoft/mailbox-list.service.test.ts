import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    mailbox: { findMany },
  },
}));

import { listMailboxesForAdmin } from '@/services/microsoft/mailbox-list.service';

const ROW = {
  id: 'mbx_1',
  emailAddress: 'a@hotmail.com',
  provider: 'MICROSOFT',
  status: 'ACTIVE',
  ownerCustomerName: null,
  lastSuccessfulSyncAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  customer: { name: 'Acme' },
  telegramMappings: [],
  graphSubscriptions: [],
};

beforeEach(() => {
  findMany.mockReset();
});

describe('listMailboxesForAdmin scope (TASK-045)', () => {
  it('does not filter for the unrestricted (OWNER/ADMIN) scope', async () => {
    findMany.mockResolvedValue([ROW]);
    await listMailboxesForAdmin({ kind: 'all' });
    const call = findMany.mock.calls[0]?.[0];
    expect(call.where).toBeUndefined();
  });

  it('does not filter when no scope is passed (system/admin callers)', async () => {
    findMany.mockResolvedValue([ROW]);
    await listMailboxesForAdmin();
    const call = findMany.mock.calls[0]?.[0];
    expect(call.where).toBeUndefined();
  });

  it('constrains to assigned customers for the STAFF scope', async () => {
    findMany.mockResolvedValue([ROW]);
    await listMailboxesForAdmin({ kind: 'assigned', customerIds: ['cus_1', 'cus_2'] });
    const call = findMany.mock.calls[0]?.[0];
    expect(call.where).toEqual({ customerId: { in: ['cus_1', 'cus_2'] } });
  });

  it('an empty assigned scope yields a where that matches nothing', async () => {
    findMany.mockResolvedValue([]);
    await listMailboxesForAdmin({ kind: 'assigned', customerIds: [] });
    const call = findMany.mock.calls[0]?.[0];
    expect(call.where).toEqual({ customerId: { in: [] } });
  });
});
