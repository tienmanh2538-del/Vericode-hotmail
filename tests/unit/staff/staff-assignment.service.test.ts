import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findMany, upsert, deleteMany } = vi.hoisted(() => ({
  findMany: vi.fn(),
  upsert: vi.fn(),
  deleteMany: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    staffAssignment: { findMany, upsert, deleteMany },
  },
}));

import {
  assignCustomerToStaff,
  listAssignedCustomerIds,
  listAssignmentsForUser,
  removeStaffAssignment,
} from '@/services/staff/staff-assignment.service';

beforeEach(() => {
  findMany.mockReset();
  upsert.mockReset();
  deleteMany.mockReset();
});

describe('listAssignedCustomerIds', () => {
  it('returns the customer ids for a user', async () => {
    findMany.mockResolvedValue([{ customerId: 'cus_1' }, { customerId: 'cus_2' }]);
    const ids = await listAssignedCustomerIds('u_staff');
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'u_staff' },
      select: { customerId: true },
    });
    expect(ids).toEqual(['cus_1', 'cus_2']);
  });

  it('returns [] for an empty user id without hitting Prisma', async () => {
    const ids = await listAssignedCustomerIds('');
    expect(ids).toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('listAssignmentsForUser', () => {
  it('maps rows newest first', async () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    findMany.mockResolvedValue([
      { id: 'sa_1', userId: 'u_1', customerId: 'cus_1', assignedById: 'u_admin', createdAt },
    ]);
    const result = await listAssignmentsForUser('u_1');
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'u_1' },
      orderBy: { createdAt: 'desc' },
    });
    expect(result).toEqual([
      { id: 'sa_1', userId: 'u_1', customerId: 'cus_1', assignedById: 'u_admin', createdAt },
    ]);
  });
});

describe('assignCustomerToStaff', () => {
  it('upserts on the (userId, customerId) unique key (idempotent)', async () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    upsert.mockResolvedValue({
      id: 'sa_1',
      userId: 'u_1',
      customerId: 'cus_1',
      assignedById: 'u_admin',
      createdAt,
    });
    const result = await assignCustomerToStaff({
      userId: 'u_1',
      customerId: 'cus_1',
      assignedById: 'u_admin',
    });
    expect(upsert).toHaveBeenCalledWith({
      where: { userId_customerId: { userId: 'u_1', customerId: 'cus_1' } },
      update: {},
      create: { userId: 'u_1', customerId: 'cus_1', assignedById: 'u_admin' },
    });
    expect(result.id).toBe('sa_1');
  });

  it('throws when userId or customerId is missing', async () => {
    await expect(
      assignCustomerToStaff({ userId: '', customerId: 'cus_1' }),
    ).rejects.toThrow();
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe('removeStaffAssignment', () => {
  it('deletes the matching assignment', async () => {
    deleteMany.mockResolvedValue({ count: 1 });
    await removeStaffAssignment({ userId: 'u_1', customerId: 'cus_1' });
    expect(deleteMany).toHaveBeenCalledWith({
      where: { userId: 'u_1', customerId: 'cus_1' },
    });
  });

  it('is a no-op for missing ids', async () => {
    await removeStaffAssignment({ userId: '', customerId: '' });
    expect(deleteMany).not.toHaveBeenCalled();
  });
});
