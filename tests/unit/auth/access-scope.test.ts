import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    staffAssignment: { findMany },
  },
}));

import {
  resolveCustomerScope,
  scopeAllowsCustomer,
  isUnrestrictedScope,
  type CustomerScope,
} from '@/lib/auth/access-scope';

beforeEach(() => {
  findMany.mockReset();
});

describe('resolveCustomerScope', () => {
  it('gives OWNER the unrestricted scope without querying assignments', async () => {
    const scope = await resolveCustomerScope({ id: 'u_owner', role: 'OWNER' });
    expect(scope).toEqual({ kind: 'all' });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('gives ADMIN the unrestricted scope without querying assignments', async () => {
    const scope = await resolveCustomerScope({ id: 'u_admin', role: 'ADMIN' });
    expect(scope).toEqual({ kind: 'all' });
    expect(findMany).not.toHaveBeenCalled();
  });

  it('gives STAFF_READ_ONLY only their assigned customer ids', async () => {
    findMany.mockResolvedValue([{ customerId: 'cus_1' }, { customerId: 'cus_2' }]);
    const scope = await resolveCustomerScope({ id: 'u_staff', role: 'STAFF_READ_ONLY' });
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: 'u_staff' },
      select: { customerId: true },
    });
    expect(scope).toEqual({ kind: 'assigned', customerIds: ['cus_1', 'cus_2'] });
  });

  it('fails closed (empty assigned scope) for a staff user with no assignments', async () => {
    findMany.mockResolvedValue([]);
    const scope = await resolveCustomerScope({ id: 'u_new', role: 'STAFF_READ_ONLY' });
    expect(scope).toEqual({ kind: 'assigned', customerIds: [] });
  });

  it('fails closed for a signed-out viewer without querying', async () => {
    const scope = await resolveCustomerScope(null);
    expect(scope).toEqual({ kind: 'assigned', customerIds: [] });
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('scopeAllowsCustomer', () => {
  const assigned: CustomerScope = { kind: 'assigned', customerIds: ['cus_1'] };

  it('allows everything under the unrestricted scope', () => {
    expect(scopeAllowsCustomer({ kind: 'all' }, 'cus_x')).toBe(true);
    expect(scopeAllowsCustomer({ kind: 'all' }, null)).toBe(true);
  });

  it('allows only assigned ids under an assigned scope', () => {
    expect(scopeAllowsCustomer(assigned, 'cus_1')).toBe(true);
    expect(scopeAllowsCustomer(assigned, 'cus_2')).toBe(false);
  });

  it('never allows a null/empty customer under an assigned scope', () => {
    expect(scopeAllowsCustomer(assigned, null)).toBe(false);
    expect(scopeAllowsCustomer(assigned, '')).toBe(false);
  });
});

describe('isUnrestrictedScope', () => {
  it('is true only for the all scope', () => {
    expect(isUnrestrictedScope({ kind: 'all' })).toBe(true);
    expect(isUnrestrictedScope({ kind: 'assigned', customerIds: [] })).toBe(false);
  });
});
