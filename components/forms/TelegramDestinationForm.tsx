"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { TELEGRAM_MAPPING_STATUS_VALUES } from "@/lib/validation/telegram-mapping";
import {
  INITIAL_TELEGRAM_DESTINATION_FORM_STATE,
  type TelegramDestinationFormState,
} from "@/services/telegram/destination-form-state";

export interface TelegramDestinationFormCustomer {
  id: string;
  name: string;
}

interface TelegramDestinationFormProps {
  action: (
    state: TelegramDestinationFormState,
    formData: FormData,
  ) => Promise<TelegramDestinationFormState>;
  customers: TelegramDestinationFormCustomer[];
  initialValues?: {
    customerId?: string;
    displayName?: string;
    telegramGroupName?: string;
    telegramChatId?: string;
    telegramTopicName?: string;
    telegramThreadId?: string;
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

export function TelegramDestinationForm({
  action,
  customers,
  initialValues,
  submitLabel = "Save destination",
}: TelegramDestinationFormProps) {
  const initial: TelegramDestinationFormState = initialValues
    ? {
        status: "idle",
        values: {
          customerId: initialValues.customerId ?? "",
          displayName: initialValues.displayName ?? "",
          telegramGroupName: initialValues.telegramGroupName ?? "",
          telegramChatId: initialValues.telegramChatId ?? "",
          telegramTopicName: initialValues.telegramTopicName ?? "",
          telegramThreadId: initialValues.telegramThreadId ?? "",
          status: initialValues.status ?? "ACTIVE",
        },
      }
    : INITIAL_TELEGRAM_DESTINATION_FORM_STATE;

  const [state, formAction] = useFormState(action, initial);
  const safeState = state ?? initial;
  const errors = safeState.errors ?? {};

  if (customers.length === 0) {
    return (
      <p className="telegram-form__empty">
        No customers available yet. Create a customer first before adding a
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
        <label htmlFor="destination-customer" className="customer-form__label">
          Customer
        </label>
        <select
          id="destination-customer"
          name="customerId"
          defaultValue={safeState.values.customerId}
          aria-invalid={errors.customerId ? "true" : undefined}
          aria-describedby={
            errors.customerId ? "destination-customer-error" : undefined
          }
          className="customer-form__input"
          required
        >
          <option value="">Select a customer…</option>
          {customers.map((customer) => (
            <option key={customer.id} value={customer.id}>
              {customer.name}
            </option>
          ))}
        </select>
        {errors.customerId && (
          <p id="destination-customer-error" className="customer-form__error">
            {errors.customerId}
          </p>
        )}
      </div>

      <div className="customer-form__field">
        <label htmlFor="destination-display-name" className="customer-form__label">
          Display name
        </label>
        <input
          id="destination-display-name"
          name="displayName"
          type="text"
          defaultValue={safeState.values.displayName}
          placeholder="Client A — main verification group"
          aria-invalid={errors.displayName ? "true" : undefined}
          aria-describedby={
            errors.displayName ? "destination-display-name-error" : undefined
          }
          className="customer-form__input"
          required
          maxLength={200}
        />
        {errors.displayName && (
          <p id="destination-display-name-error" className="customer-form__error">
            {errors.displayName}
          </p>
        )}
      </div>

      <div className="customer-form__field">
        <label htmlFor="destination-group-name" className="customer-form__label">
          Telegram group name
        </label>
        <input
          id="destination-group-name"
          name="telegramGroupName"
          type="text"
          defaultValue={safeState.values.telegramGroupName}
          placeholder="Client A verification group"
          aria-invalid={errors.telegramGroupName ? "true" : undefined}
          aria-describedby={
            errors.telegramGroupName ? "destination-group-name-error" : undefined
          }
          className="customer-form__input"
          required
          maxLength={200}
        />
        {errors.telegramGroupName && (
          <p id="destination-group-name-error" className="customer-form__error">
            {errors.telegramGroupName}
          </p>
        )}
      </div>

      <div className="customer-form__field">
        <label htmlFor="destination-chat-id" className="customer-form__label">
          Telegram chat ID
        </label>
        <input
          id="destination-chat-id"
          name="telegramChatId"
          type="text"
          defaultValue={safeState.values.telegramChatId}
          placeholder="-1001234567890 or @channelusername"
          aria-invalid={errors.telegramChatId ? "true" : undefined}
          aria-describedby={
            errors.telegramChatId
              ? "destination-chat-id-error"
              : "destination-chat-id-hint"
          }
          className="customer-form__input"
          required
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
        />
        <p id="destination-chat-id-hint" className="telegram-form__hint">
          Use the numeric chat ID from Telegram. Never paste a bot token here.
        </p>
        {errors.telegramChatId && (
          <p id="destination-chat-id-error" className="customer-form__error">
            {errors.telegramChatId}
          </p>
        )}
      </div>

      <div className="customer-form__field">
        <label htmlFor="destination-topic-name" className="customer-form__label">
          Telegram topic name{" "}
          <span className="telegram-form__optional">(optional)</span>
        </label>
        <input
          id="destination-topic-name"
          name="telegramTopicName"
          type="text"
          defaultValue={safeState.values.telegramTopicName}
          placeholder="Client A — verification topic"
          aria-invalid={errors.telegramTopicName ? "true" : undefined}
          aria-describedby={
            errors.telegramTopicName ? "destination-topic-name-error" : undefined
          }
          className="customer-form__input"
          maxLength={200}
        />
        {errors.telegramTopicName && (
          <p id="destination-topic-name-error" className="customer-form__error">
            {errors.telegramTopicName}
          </p>
        )}
      </div>

      <div className="customer-form__field">
        <label htmlFor="destination-thread-id" className="customer-form__label">
          Telegram topic ID{" "}
          <span className="telegram-form__optional">(optional)</span>
        </label>
        <input
          id="destination-thread-id"
          name="telegramThreadId"
          type="text"
          inputMode="numeric"
          defaultValue={safeState.values.telegramThreadId}
          placeholder="e.g. 42"
          aria-invalid={errors.telegramThreadId ? "true" : undefined}
          aria-describedby={
            errors.telegramThreadId
              ? "destination-thread-id-error"
              : "destination-thread-id-hint"
          }
          className="customer-form__input"
          maxLength={32}
          autoComplete="off"
          spellCheck={false}
        />
        <p id="destination-thread-id-hint" className="telegram-form__hint">
          Leave blank for the main group. Set the topic (thread) ID to route into
          a specific forum topic.
        </p>
        {errors.telegramThreadId && (
          <p id="destination-thread-id-error" className="customer-form__error">
            {errors.telegramThreadId}
          </p>
        )}
      </div>

      <div className="customer-form__field">
        <label htmlFor="destination-status" className="customer-form__label">
          Status
        </label>
        <select
          id="destination-status"
          name="status"
          defaultValue={safeState.values.status}
          aria-invalid={errors.status ? "true" : undefined}
          aria-describedby={errors.status ? "destination-status-error" : undefined}
          className="customer-form__input"
        >
          {TELEGRAM_MAPPING_STATUS_VALUES.map((value) => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        {errors.status && (
          <p id="destination-status-error" className="customer-form__error">
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
