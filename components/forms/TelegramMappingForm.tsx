"use client";

import Link from "next/link";
import { useFormState, useFormStatus } from "react-dom";
import { TELEGRAM_MAPPING_STATUS_VALUES } from "@/lib/validation/telegram-mapping";
import {
  INITIAL_TELEGRAM_MAPPING_FORM_STATE,
  type TelegramMappingFormState,
} from "@/services/telegram/mapping-form-state";

export interface TelegramMappingFormMailbox {
  id: string;
  emailAddress: string;
  customerName: string | null;
}

interface TelegramMappingFormProps {
  action: (
    state: TelegramMappingFormState,
    formData: FormData,
  ) => Promise<TelegramMappingFormState>;
  mailboxes: TelegramMappingFormMailbox[];
  initialValues?: {
    mailboxId?: string;
    telegramChatId?: string;
    telegramGroupName?: string;
    telegramThreadId?: string;
    telegramTopicName?: string;
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
  initialValues,
  submitLabel = "Save mapping",
}: TelegramMappingFormProps) {
  const initial: TelegramMappingFormState = initialValues
    ? {
        status: "idle",
        values: {
          mailboxId: initialValues.mailboxId ?? "",
          telegramChatId: initialValues.telegramChatId ?? "",
          telegramGroupName: initialValues.telegramGroupName ?? "",
          telegramThreadId: initialValues.telegramThreadId ?? "",
          telegramTopicName: initialValues.telegramTopicName ?? "",
          status: initialValues.status ?? "ACTIVE",
        },
      }
    : INITIAL_TELEGRAM_MAPPING_FORM_STATE;

  const [state, formAction] = useFormState(action, initial);
  // `useFormState` can hand back `undefined` for a tick while a server action
  // that ends in `redirect()` settles (the success path here). Falling back to
  // the initial state keeps the form from crashing during that transition and
  // lets the redirect/list refresh finish cleanly.
  const safeState = state ?? initial;
  const errors = safeState.errors ?? {};

  if (mailboxes.length === 0) {
    return (
      <p className="telegram-form__empty">
        No mailboxes available yet. Add a mailbox first before mapping it to a Telegram group.
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
          defaultValue={safeState.values.mailboxId}
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
      </div>

      <div className="customer-form__field">
        <label htmlFor="mapping-group-name" className="customer-form__label">
          Telegram group name
        </label>
        <input
          id="mapping-group-name"
          name="telegramGroupName"
          type="text"
          defaultValue={safeState.values.telegramGroupName}
          placeholder="Client A verification group"
          aria-invalid={errors.telegramGroupName ? "true" : undefined}
          aria-describedby={
            errors.telegramGroupName ? "mapping-group-name-error" : undefined
          }
          className="customer-form__input"
          required
          maxLength={200}
        />
        {errors.telegramGroupName && (
          <p id="mapping-group-name-error" className="customer-form__error">
            {errors.telegramGroupName}
          </p>
        )}
      </div>

      <div className="customer-form__field">
        <label htmlFor="mapping-chat-id" className="customer-form__label">
          Telegram chat ID
        </label>
        <input
          id="mapping-chat-id"
          name="telegramChatId"
          type="text"
          defaultValue={safeState.values.telegramChatId}
          placeholder="-1001234567890 or @channelusername"
          aria-invalid={errors.telegramChatId ? "true" : undefined}
          aria-describedby={
            errors.telegramChatId
              ? "mapping-chat-id-error"
              : "mapping-chat-id-hint"
          }
          className="customer-form__input"
          required
          maxLength={64}
          autoComplete="off"
          spellCheck={false}
        />
        <p id="mapping-chat-id-hint" className="telegram-form__hint">
          Use the numeric chat ID from Telegram. Never paste a bot token here.
        </p>
        {errors.telegramChatId && (
          <p id="mapping-chat-id-error" className="customer-form__error">
            {errors.telegramChatId}
          </p>
        )}
      </div>

      <div className="customer-form__field">
        <label htmlFor="mapping-topic-name" className="customer-form__label">
          Telegram topic name <span className="telegram-form__optional">(optional)</span>
        </label>
        <input
          id="mapping-topic-name"
          name="telegramTopicName"
          type="text"
          defaultValue={safeState.values.telegramTopicName}
          placeholder="Client A — verification topic"
          aria-invalid={errors.telegramTopicName ? "true" : undefined}
          aria-describedby={
            errors.telegramTopicName ? "mapping-topic-name-error" : undefined
          }
          className="customer-form__input"
          maxLength={200}
        />
        {errors.telegramTopicName && (
          <p id="mapping-topic-name-error" className="customer-form__error">
            {errors.telegramTopicName}
          </p>
        )}
      </div>

      <div className="customer-form__field">
        <label htmlFor="mapping-thread-id" className="customer-form__label">
          Telegram topic ID <span className="telegram-form__optional">(optional)</span>
        </label>
        <input
          id="mapping-thread-id"
          name="telegramThreadId"
          type="text"
          inputMode="numeric"
          defaultValue={safeState.values.telegramThreadId}
          placeholder="e.g. 42"
          aria-invalid={errors.telegramThreadId ? "true" : undefined}
          aria-describedby={
            errors.telegramThreadId
              ? "mapping-thread-id-error"
              : "mapping-thread-id-hint"
          }
          className="customer-form__input"
          maxLength={32}
          autoComplete="off"
          spellCheck={false}
        />
        <p id="mapping-thread-id-hint" className="telegram-form__hint">
          Leave blank to deliver to the main group. Set the topic (thread) ID to
          route into a specific forum topic. Many mailboxes may share the same
          group and topic.
        </p>
        {errors.telegramThreadId && (
          <p id="mapping-thread-id-error" className="customer-form__error">
            {errors.telegramThreadId}
          </p>
        )}
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
