import { prisma } from '@/lib/prisma';

// TASK-051 — assign (or clear) the Customer of an already-connected mailbox.
// `Mailbox.customerId` already exists in the schema, so this only writes an
// existing column — no migration is required. Onboarding readiness and the
// STAFF visibility scope both derive from this link, so being able to set it
// from the UI is what unblocks the staging live E2E workflow.

export type MailboxCustomerAssignmentErrorKind = 'validation' | 'database';

export class MailboxCustomerAssignmentError extends Error {
  readonly kind: MailboxCustomerAssignmentErrorKind;

  constructor(kind: MailboxCustomerAssignmentErrorKind, message: string) {
    super(message);
    this.name = 'MailboxCustomerAssignmentError';
    this.kind = kind;
  }
}

export interface AssignMailboxCustomerResult {
  mailboxId: string;
  customerId: string | null;
}

function normalizeId(value: string | null | undefined): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/**
 * Link a mailbox to a customer (or unassign with `null`/empty). Returns the
 * normalized assignment. Throws `MailboxCustomerAssignmentError` on a missing
 * mailbox id or a database failure so the caller can surface a safe message.
 */
export async function assignMailboxCustomer(
  mailboxId: string,
  customerId: string | null,
): Promise<AssignMailboxCustomerResult> {
  const id = normalizeId(mailboxId);
  if (!id) {
    throw new MailboxCustomerAssignmentError('validation', 'mailboxId is required');
  }
  const normalizedCustomerId = normalizeId(customerId);

  try {
    await prisma.mailbox.update({
      where: { id },
      data: { customerId: normalizedCustomerId },
    });
  } catch {
    // Never echo the underlying Prisma error: it can include row data. A failed
    // assignment is reported as a generic database error.
    throw new MailboxCustomerAssignmentError(
      'database',
      'failed to assign customer to mailbox',
    );
  }

  return { mailboxId: id, customerId: normalizedCustomerId };
}
