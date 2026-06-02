"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { useFormState, useFormStatus } from "react-dom";
import { TELEGRAM_MAPPING_STATUS_VALUES } from "@/lib/validation/telegram-mapping";
import {
  INITIAL_TELEGRAM_MAPPING_FORM_STATE,
  type TelegramMappingFormState,
} from "@/services/telegram/mapping-form-state";

export interface TelegramMappingFormMailbox {
  id: string;
  emailAddress: string;
  customerId: string | null;
  customerName: string | null;
}

export interface TelegramMappingFormDestination {
  id: string;
  customerId: string;
  displayName: string;
  telegramGroupName: string;
  telegramTopicName: string | null;
  status: string;
}

interface TelegramMappingFormProps {
  action: (
    state: TelegramMappingFormState,
    formData: FormData,
  ) => Promise<TelegramMappingFormState>;
  mailboxes: TelegramMappingFormMailbox[];
  destinations: TelegramMappingFormDestination[];
  initialValues?: {
    mailboxId?: string;
    destinationId?: string;
    status?: string;
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

export function TelegramMappingForm({
  action,
  mailboxes,
  destinations,
  initialValues,
  submitLabel = "Save mapping",
}: TelegramMappingFormProps) {
  const initial: TelegramMappingFormState = initialValues
    ? {
        status: "idle",
        values: {
          mailboxId: initialValues.mailboxId ?? "",
          destinationId: initialValues.destinationId ?? "",
          status: initialValues.status ?? "ACTIVE",
        },
      }
    : INITIAL_TELEGRAM_MAPPING_FORM_STATE;

  const [state, formAction] = useFormState(action, initial);
  // `useFormState` can hand back `undefined` for a tick while a server action
  // that ends in `redirect()` settles. Falling back to the initial state keeps
  // the form from crashing during that transition.
  const safeState = state ?? initial;
  const errors = safeState.errors ?? {};

  // Customer is derived from the chosen mailbox (never selected independently)
  // to avoid a customer/mailbox mismatch.
  const [selectedMailboxId, setSelectedMailboxId] = useState(
    initial.values.mailboxId,
  );
  const [selectedDestinationId, setSelectedDestinationId] = useState(
    initial.values.destinationId,
  );

  const selectedMailbox =
    mailboxes.find((mailbox) => mailbox.id === selectedMailboxId) ?? null;

  // Only destinations of the SAME customer as the chosen mailbox are offered.
  // The service re-checks this — the dropdown filter is UX, not the security
  // boundary.
  const availableDestinations = useMemo(() => {
    if (!selectedMailbox?.customerId) return [];
    return destinations.filter(
      (destination) =>
        destination.customerId === selectedMailbox.customerId &&
        (destination.status === "ACTIVE" ||
          destination.id === selectedDestinationId),
    );
  }, [destinations, selectedMailbox, selectedDestinationId]);

  const selectedDestination =
    availableDestinations.find((d) => d.id === selectedDestinationId) ?? null;

  if (mailboxes.length === 0) {
    return (
      <p className="telegram-form__empty">
        No mailboxes available yet. Add a mailbox first before mapping it to a
        Telegram destination.
      </p>
    );
  }

  return (
    <form action={formAction} className="customer-form" noValidate>
      {safeState.formError && (
        <p className="customer-form__form-error" role="alert">
          {safeState.formError}
        </p>
      )}

      <div className="customer-form__field">
        <label htmlFor="mapping-mailbox" className="customer-form__label">
          Mailbox
        </label>
        <select
          id="mapping-mailbox"
          name="mailboxId"
          value={selectedMailboxId}
          onChange={(event) => {
            setSelectedMailboxId(event.target.value);
            // Reset the destination — the previous pick may belong to another
            // customer once the mailbox changes.
            setSelectedDestinationId("");
          }}
          aria-invalid={errors.mailboxId ? "true" : undefined}
          aria-describedby={errors.mailboxId ? "mapping-mailbox-error" : undefined}
          className="customer-form__input"
          required
        >
          <option value="">Select a mailbox…</option>
          {mailboxes.map((mailbox) => {
            const label = mailbox.customerName
              ? `${mailbox.emailAddress} — ${mailbox.customerName}`
              : mailbox.emailAddress;
            return (
              <option key={mailbox.id} value={mailbox.id}>
                {label}
              </option>
            );
          })}
        </select>
        {errors.mailboxId && (
          <p id="mapping-mailbox-error" className="customer-form__error">
            {errors.mailboxId}
          </p>
        )}
        {selectedMailbox ? (
          selectedMailbox.customerName ? (
            <p className="telegram-form__hint">
              Customer: <strong>{selectedMailbox.customerName}</strong> (tự động
              theo mailbox đã chọn)
            </p>
          ) : (
            <p className="customer-form__error" role="status">
              ⚠ Mailbox này chưa gắn customer. Hãy gán customer cho mailbox
              trước để chọn destination.
            </p>
          )
        ) : null}
      </div>

      <div className="customer-form__field">
        <label htmlFor="mapping-destination" className="customer-form__label">
          Telegram destination
        </label>
        <select
          id="mapping-destination"
          name="destinationId"
          value={selectedDestinationId}
          onChange={(event) => setSelectedDestinationId(event.target.value)}
          aria-invalid={errors.destinationId ? "true" : undefined}
          aria-describedby={
            errors.destinationId
              ? "mapping-destination-error"
              : "mapping-destination-hint"
          }
          className="customer-form__input"
          required
          disabled={!selectedMailbox?.customerId}
        >
          <option value="">
            {selectedMailbox?.customerId
              ? "Select a saved destination…"
              : "Choose a mailbox first"}
          </option>
          {availableDestinations.map((destination) => {
            const label = destination.telegramTopicName
              ? `${destination.displayName} — ${destination.telegramGroupName} / ${destination.telegramTopicName}`
              : `${destination.displayName} — ${destination.telegramGroupName}`;
            return (
              <option key={destination.id} value={destination.id}>
                {destination.status === "ACTIVE" ? label : `${label} (disabled)`}
              </option>
            );
          })}
        </select>
        <p id="mapping-destination-hint" className="telegram-form__hint">
          Pick a destination saved for this customer. No need to re-enter chat or
          topic IDs. Many mailboxes may share the same destination.
        </p>
        {selectedMailbox?.customerId && availableDestinations.length === 0 ? (
          <p className="customer-form__error" role="status">
            No saved destinations for this customer yet. Create one in the
            Destinations section above.
          </p>
        ) : null}
        {errors.destinationId && (
          <p id="mapping-destination-error" className="customer-form__error">
            {errors.destinationId}
          </p>
        )}
        {selectedDestination ? (
          <p className="telegram-form__hint">
            Routing to <strong>{selectedDestination.telegramGroupName}</strong>
            {selectedDestination.telegramTopicName
              ? ` / ${selectedDestination.telegramTopicName}`
              : ""}
            .
          </p>
        ) : null}
      </div>

      <div className="customer-form__field">
        <label htmlFor="mapping-status" className="customer-form__label">
          Status
        </label>
        <select
          id="mapping-status"
          name="status"
          defaultValue={safeState.values.status}
          aria-invalid={errors.status ? "true" : undefined}
          aria-describedby={errors.status ? "mapping-status-error" : undefined}
          className="customer-form__input"
        >
          {TELEGRAM_MAPPING_STATUS_VALUES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        {errors.status && (
          <p id="mapping-status-error" className="customer-form__error">
            {errors.status}
          </p>
        )}
      </div>

      <div className="customer-form__actions">
        <Link href="/admin/telegram" className="customer-form__cancel">
          Cancel
        </Link>
        <SubmitButton label={submitLabel} />
      </div>
    </form>
  );
}
