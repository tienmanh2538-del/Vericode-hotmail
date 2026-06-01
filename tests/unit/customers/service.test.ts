import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findMany, findUnique, create, update } = vi.hoisted(() => ({
  findMany: vi.fn(),
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    customer: { findMany, findUnique, create, update },
  },
}));

import {
  listCustomers,
  getCustomerById,
  createCustomer,
  updateCustomer,
} from '@/services/customers/customer.service';

const FIXTURE_ROW = {
  id: 'cus_1',
  name: 'Acme',
  status: 'ACTIVE',
  notes: null as string | null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
};

beforeEach(() => {
  findMany.mockReset();
  findUnique.mockReset();
  create.mockReset();
  update.mockReset();
});

describe('listCustomers', () => {
  it('returns mapped records ordered by createdAt desc', async () => {
    findMany.mockResolvedValue([FIXTURE_ROW]);
    const result = await listCustomers();
    expect(findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' } });
    expect(result).toEqual([
      {
        id: 'cus_1',
        name: 'Acme',
        status: 'ACTIVE',
        notes: null,
        createdAt: FIXTURE_ROW.createdAt,
        updatedAt: FIXTURE_ROW.updatedAt,
      },
    ]);
  });

  it('returns [] when there are no rows', async () => {
    findMany.mockResolvedValue([]);
    expect(await listCustomers()).toEqual([]);
  });

  it('does not filter for the unrestricted (OWNER/ADMIN) scope', async () => {
    findMany.mockResolvedValue([FIXTURE_ROW]);
    await listCustomers({ kind: 'all' });
    expect(findMany).toHaveBeenCalledWith({ orderBy: { createdAt: 'desc' } });
  });

  it('constrains to assigned ids for the STAFF scope', async () => {
    findMany.mockResolvedValue([FIXTURE_ROW]);
    await listCustomers({ kind: 'assigned', customerIds: ['cus_1'] });
    expect(findMany).toHaveBeenCalledWith({
      orderBy: { createdAt: 'desc' },
      where: { id: { in: ['cus_1'] } },
    });
  });
});

describe('getCustomerById', () => {
  it('returns null when id is empty without hitting Prisma', async () => {
    const result = await getCustomerById('');
    expect(result).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns null when row is not found', async () => {
    findUnique.mockResolvedValue(null);
    const result = await getCustomerById('missing');
    expect(findUnique).toHaveBeenCalledWith({ where: { id: 'missing' } });
    expect(result).toBeNull();
  });

  it('returns mapped record when row exists', async () => {
    findUnique.mockResolvedValue(FIXTURE_ROW);
    const result = await getCustomerById('cus_1');
    expect(result?.id).toBe('cus_1');
    expect(result?.status).toBe('ACTIVE');
  });

  it('returns the record when the STAFF scope includes it', async () => {
    findUnique.mockResolvedValue(FIXTURE_ROW);
    const result = await getCustomerById('cus_1', {
      kind: 'assigned',
      customerIds: ['cus_1'],
    });
    expect(result?.id).toBe('cus_1');
  });

  it('returns null when the STAFF scope excludes the customer', async () => {
    findUnique.mockResolvedValue(FIXTURE_ROW);
    const result = await getCustomerById('cus_1', {
      kind: 'assigned',
      customerIds: ['cus_other'],
    });
    expect(result).toBeNull();
  });
});

describe('createCustomer', () => {
  it('forwards validated input to prisma.customer.create', async () => {
    create.mockResolvedValue({ ...FIXTURE_ROW, name: 'New Co', notes: 'hi' });
    const result = await createCustomer({
      name: 'New Co',
      status: 'PAUSED',
      notes: 'hi',
    });
    expect(create).toHaveBeenCalledWith({
      data: { name: 'New Co', status: 'PAUSED', notes: 'hi' },
    });
    expect(result.name).toBe('New Co');
  });
});

describe('updateCustomer', () => {
  it('forwards id + validated input to prisma.customer.update', async () => {
    update.mockResolvedValue({ ...FIXTURE_ROW, status: 'ARCHIVED' });
    const result = await updateCustomer('cus_1', {
      name: 'Acme',
      status: 'ARCHIVED',
      notes: null,
    });
    expect(update).toHaveBeenCalledWith({
      where: { id: 'cus_1' },
      data: { name: 'Acme', status: 'ARCHIVED', notes: null },
    });
    expect(result.status).toBe('ARCHIVED');
  });
});
