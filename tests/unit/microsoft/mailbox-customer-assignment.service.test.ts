import { describe, it, expect, vi, beforeEach } from 'vitest';

const { update } = vi.hoisted(() => ({ update: vi.fn() }));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    mailbox: { update },
  },
}));

import {
  assignMailboxCustomer,
  MailboxCustomerAssignmentError,
} from '@/services/microsoft/mailbox-customer-assignment.service';

beforeEach(() => {
  update.mockReset();
});

describe('assignMailboxCustomer', () => {
  it('links the mailbox to the given customer', async () => {
    update.mockResolvedValue({ id: 'mbx_1' });
    const result = await assignMailboxCustomer('mbx_1', 'cus_1');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'mbx_1' },
      data: { customerId: 'cus_1' },
    });
    expect(result).toEqual({ mailboxId: 'mbx_1', customerId: 'cus_1' });
  });

  it('normalizes an empty customerId to null (unassign)', async () => {
    update.mockResolvedValue({ id: 'mbx_1' });
    const result = await assignMailboxCustomer('mbx_1', '   ');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'mbx_1' },
      data: { customerId: null },
    });
    expect(result.customerId).toBeNull();
  });

  it('trims surrounding whitespace from both ids', async () => {
    update.mockResolvedValue({ id: 'mbx_1' });
    await assignMailboxCustomer('  mbx_1  ', '  cus_9  ');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'mbx_1' },
      data: { customerId: 'cus_9' },
    });
  });

  it('throws a validation error when mailboxId is empty, without hitting Prisma', async () => {
    await expect(assignMailboxCustomer('', 'cus_1')).rejects.toBeInstanceOf(
      MailboxCustomerAssignmentError,
    );
    expect(update).not.toHaveBeenCalled();
  });

  it('wraps Prisma failures in a database-kind error', async () => {
    update.mockRejectedValue(new Error('P2025'));
    await expect(
      assignMailboxCustomer('mbx_1', 'cus_1'),
    ).rejects.toMatchObject({ kind: 'database' });
  });
});
