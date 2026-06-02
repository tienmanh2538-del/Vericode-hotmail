'use client';

import Link from 'next/link';
import { useFormState, useFormStatus } from 'react-dom';
import {
  INITIAL_ASSIGN_MAILBOX_CUSTOMER_STATE,
  type AssignMailboxCustomerState,
} from '@/services/microsoft/mailbox-assign-form-state';

export interface MailboxCustomerAssignOption {
  id: string;
  name: string;
}

interface MailboxCustomerAssignFormProps {
  action: (
    state: AssignMailboxCustomerState,
    formData: FormData,
  ) => Promise<AssignMailboxCustomerState>;
  customers: MailboxCustomerAssignOption[];
  currentCustomerId: string | null;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="customer-form__submit" disabled={pending}>
      {pending ? 'Đang lưu…' : 'Gán customer'}
    </button>
  );
}

// TASK-051 — minimal control to set `Mailbox.customerId` from the detail page so
// the live E2E workflow can attach a connected mailbox to a customer. Customer
// is the only selectable field; the mailbox is fixed (bound server-side).
export function MailboxCustomerAssignForm({
  action,
  customers,
  currentCustomerId,
}: MailboxCustomerAssignFormProps) {
  const initial: AssignMailboxCustomerState = {
    ...INITIAL_ASSIGN_MAILBOX_CUSTOMER_STATE,
    customerId: currentCustomerId ?? '',
  };
  const [state, formAction] = useFormState(action, initial);
  const safeState = state ?? initial;

  if (customers.length === 0) {
    return (
      <p className="mailbox-detail__muted">
        Chưa có customer nào.{' '}
        <Link href="/admin/customers/new" className="customers-table__action">
          Tạo customer trước →
        </Link>
      </p>
    );
  }

  return (
    <form action={formAction} className="customer-form mailbox-assign-form" noValidate>
      {safeState.status === 'error' && safeState.error ? (
        <p className="customer-form__form-error" role="alert">
          {safeState.error}
        </p>
      ) : null}
      {safeState.status === 'success' ? (
        <p className="mailbox-assign-form__success" role="status">
          Đã cập nhật customer cho mailbox.
        </p>
      ) : null}

      <div className="customer-form__field">
        <label htmlFor="assign-customer" className="customer-form__label">
          Customer
        </label>
        <select
          id="assign-customer"
          name="customerId"
          defaultValue={safeState.customerId}
          className="customer-form__input"
        >
          <option value="">— Chưa gán —</option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </select>
      </div>

      <div className="customer-form__actions">
        <SubmitButton />
      </div>
    </form>
  );
}
