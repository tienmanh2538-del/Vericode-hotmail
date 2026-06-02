'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/guards';
import {
  assignMailboxCustomer,
  MailboxCustomerAssignmentError,
} from './mailbox-customer-assignment.service';
import type { AssignMailboxCustomerState } from './mailbox-assign-form-state';

// TASK-051 — assigning a mailbox to a customer is a MANAGE_MAILBOXES action, so
// STAFF_READ_ONLY is fail-closed (redirected to /login). `mailboxId` is bound by
// the page so the client form only ever submits the chosen `customerId`.
export async function assignMailboxCustomerAction(
  mailboxId: string,
  _prev: AssignMailboxCustomerState,
  formData: FormData,
): Promise<AssignMailboxCustomerState> {
  await requirePermission('MANAGE_MAILBOXES');
  const customerId = (formData.get('customerId') ?? '').toString();

  try {
    await assignMailboxCustomer(mailboxId, customerId);
  } catch (error) {
    const message =
      error instanceof MailboxCustomerAssignmentError
        ? 'Không gán được customer cho mailbox. Vui lòng thử lại.'
        : 'Lỗi không mong muốn khi gán customer.';
    return { status: 'error', error: message, customerId };
  }

  revalidatePath(`/admin/mailboxes/${mailboxId}`);
  revalidatePath('/admin/mailboxes');
  return { status: 'success', customerId };
}
