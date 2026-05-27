"use client";

import { useFormState, useFormStatus } from "react-dom";
import Link from "next/link";
import {
  CUSTOMER_STATUS_VALUES,
  type CustomerStatus,
} from "@/lib/validation/customer";
import {
  INITIAL_FORM_STATE,
  type CustomerFormState,
} from "@/services/customers/form-state";

interface CustomerFormProps {
  action: (
    state: CustomerFormState,
    formData: FormData,
  ) => Promise<CustomerFormState>;
  initialValues?: {
    name?: string;
    status?: CustomerStatus;
    notes?: string | null;
  };
  submitLabel?: string;
}

function SubmitButton({ label }: { label: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className="customer-form__submit" disabled={pending}>
      {pending ? "Saving…" : label}
    </button>
  );
}

export function CustomerForm({
  action,
  initialValues,
  submitLabel = "Save customer",
}: CustomerFormProps) {
  const initial: CustomerFormState = initialValues
    ? {
        status: "idle",
        values: {
          name: initialValues.name ?? "",
          status: initialValues.status ?? "ACTIVE",
          notes: initialValues.notes ?? "",
        },
      }
    : INITIAL_FORM_STATE;

  const [state, formAction] = useFormState(action, initial);
  const errors = state.errors ?? {};

  return (
    <form action={formAction} className="customer-form" noValidate>
      {state.formError && (
        <p className="customer-form__form-error" role="alert">
          {state.formError}
        </p>
      )}

      <div className="customer-form__field">
        <label htmlFor="customer-name" className="customer-form__label">
          Name
        </label>
        <input
          id="customer-name"
          name="name"
          type="text"
          defaultValue={state.values.name}
          aria-invalid={errors.name ? "true" : undefined}
          aria-describedby={errors.name ? "customer-name-error" : undefined}
          className="customer-form__input"
          required
          maxLength={120}
        />
        {errors.name && (
          <p id="customer-name-error" className="customer-form__error">
            {errors.name}
          </p>
        )}
      </div>

      <div className="customer-form__field">
        <label htmlFor="customer-status" className="customer-form__label">
          Status
        </label>
        <select
          id="customer-status"
          name="status"
          defaultValue={state.values.status}
          aria-invalid={errors.status ? "true" : undefined}
          aria-describedby={errors.status ? "customer-status-error" : undefined}
          className="customer-form__input"
        >
          {CUSTOMER_STATUS_VALUES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        {errors.status && (
          <p id="customer-status-error" className="customer-form__error">
            {errors.status}
          </p>
        )}
      </div>

      <div className="customer-form__field">
        <label htmlFor="customer-notes" className="customer-form__label">
          Notes (optional)
        </label>
        <textarea
          id="customer-notes"
          name="notes"
          defaultValue={state.values.notes}
          aria-invalid={errors.notes ? "true" : undefined}
          aria-describedby={errors.notes ? "customer-notes-error" : undefined}
          className="customer-form__input customer-form__input--textarea"
          rows={4}
          maxLength={2000}
        />
        {errors.notes && (
          <p id="customer-notes-error" className="customer-form__error">
            {errors.notes}
          </p>
        )}
      </div>

      <div className="customer-form__actions">
        <Link href="/admin/customers" className="customer-form__cancel">
          Cancel
        </Link>
        <SubmitButton label={submitLabel} />
      </div>
    </form>
  );
}
