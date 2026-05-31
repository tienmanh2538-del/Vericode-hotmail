"use client";

import { useState, type FormEvent } from "react";
import type {
  MockEmailFieldErrors,
  MockEmailSafePreview,
} from "@/lib/validation/mock-email";

interface MockEmailFormValues {
  mailboxEmail: string;
  fromEmail: string;
  fromName: string;
  subject: string;
  receivedAt: string;
  bodyPreview: string;
  body: string;
}

const EMPTY_VALUES: MockEmailFormValues = {
  mailboxEmail: "",
  fromEmail: "",
  fromName: "",
  subject: "",
  receivedAt: "",
  bodyPreview: "",
  body: "",
};

interface ApiErrorResponse {
  ok: false;
  error: string;
  fields?: MockEmailFieldErrors;
}

interface ApiSuccessResponse {
  ok: true;
  data: MockEmailSafePreview;
}

type ApiResponse = ApiErrorResponse | ApiSuccessResponse;

type ProcessStatus =
  | "SENT"
  | "SKIPPED_NOT_FACEBOOK_VERIFICATION"
  | "SKIPPED_LOW_CONFIDENCE"
  | "SKIPPED_NO_CODE"
  | "SKIPPED_DUPLICATE"
  | "SKIPPED_NO_TELEGRAM_MAPPING"
  | "FAILED_TELEGRAM_SEND"
  | "FAILED_UNEXPECTED";

interface ProcessResult {
  status: ProcessStatus;
  success: boolean;
  platform?: string;
  confidence?: number;
  maskedCode?: string;
  reason?: string;
}

interface ProcessSuccessResponse {
  ok: true;
  data: ProcessResult;
}

type ProcessResponse = ApiErrorResponse | ProcessSuccessResponse;

const PROCESS_STATUS_LABELS: Record<ProcessStatus, string> = {
  SENT: "✅ Sent to Telegram",
  SKIPPED_NOT_FACEBOOK_VERIFICATION:
    "🚫 Skipped — not a Facebook/Meta verification email",
  SKIPPED_LOW_CONFIDENCE: "⚠️ Skipped — code confidence too low",
  SKIPPED_NO_CODE: "⚠️ Skipped — no verification code found",
  SKIPPED_DUPLICATE: "↩️ Skipped — duplicate (already processed)",
  SKIPPED_NO_TELEGRAM_MAPPING:
    "⚠️ Skipped — no active Telegram mapping for this mailbox",
  FAILED_TELEGRAM_SEND: "❌ Telegram send failed",
  FAILED_UNEXPECTED: "❌ Unexpected error",
};

function processResultTone(status: ProcessStatus): "success" | "warn" | "error" {
  if (status === "SENT") return "success";
  if (status === "FAILED_TELEGRAM_SEND" || status === "FAILED_UNEXPECTED") {
    return "error";
  }
  return "warn";
}

function buildPayload(values: MockEmailFormValues) {
  return {
    mailboxEmail: values.mailboxEmail.trim(),
    fromEmail: values.fromEmail.trim(),
    fromName: values.fromName.trim() || undefined,
    subject: values.subject.trim(),
    receivedAt: values.receivedAt.trim(),
    bodyPreview: values.bodyPreview.trim() || undefined,
    body: values.body,
  };
}

export function MockEmailForm() {
  const [values, setValues] = useState<MockEmailFormValues>(EMPTY_VALUES);
  const [errors, setErrors] = useState<MockEmailFieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [preview, setPreview] = useState<MockEmailSafePreview | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sending, setSending] = useState(false);
  const [processResult, setProcessResult] = useState<ProcessResult | null>(null);
  const [processError, setProcessError] = useState<string | null>(null);

  function update<K extends keyof MockEmailFormValues>(
    key: K,
    value: MockEmailFormValues[K],
  ) {
    setValues((previous) => ({ ...previous, [key]: value }));
  }

  function reset() {
    setValues(EMPTY_VALUES);
    setErrors({});
    setFormError(null);
    setPreview(null);
    setProcessResult(null);
    setProcessError(null);
  }

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setErrors({});
    setFormError(null);
    setPreview(null);

    try {
      const response = await fetch("/api/mock-email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildPayload(values)),
      });
      const json = (await response.json()) as ApiResponse;

      if (!json.ok) {
        if (json.fields) {
          setErrors(json.fields);
        }
        setFormError(json.error);
        return;
      }

      setPreview(json.data);
    } catch (error: unknown) {
      const message =
        error instanceof Error ? error.message : "Could not validate mock email";
      setFormError(message);
    } finally {
      setSubmitting(false);
    }
  }

  async function onProcess() {
    setSending(true);
    setErrors({});
    setFormError(null);
    setProcessResult(null);
    setProcessError(null);

    try {
      const response = await fetch("/api/mock-email/process", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(buildPayload(values)),
      });
      const json = (await response.json()) as ProcessResponse;

      if (!json.ok) {
        if (json.fields) {
          setErrors(json.fields);
        }
        setProcessError(json.error);
        return;
      }

      setProcessResult(json.data);
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : "Could not process mock email";
      setProcessError(message);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mock-email-layout">
      <form className="customer-form" noValidate onSubmit={onSubmit}>
        {formError && (
          <p className="customer-form__form-error" role="alert">
            {formError}
          </p>
        )}

        <div className="customer-form__field">
          <label htmlFor="mock-mailbox-email" className="customer-form__label">
            Mailbox email
          </label>
          <input
            id="mock-mailbox-email"
            name="mailboxEmail"
            type="email"
            value={values.mailboxEmail}
            onChange={(event) => update("mailboxEmail", event.target.value)}
            aria-invalid={errors.mailboxEmail ? "true" : undefined}
            aria-describedby={
              errors.mailboxEmail ? "mock-mailbox-email-error" : undefined
            }
            className="customer-form__input"
            placeholder="customer-mailbox@example.com"
            autoComplete="off"
            required
            maxLength={254}
          />
          {errors.mailboxEmail && (
            <p id="mock-mailbox-email-error" className="customer-form__error">
              {errors.mailboxEmail}
            </p>
          )}
        </div>

        <div className="customer-form__field">
          <label htmlFor="mock-from-email" className="customer-form__label">
            From email
          </label>
          <input
            id="mock-from-email"
            name="fromEmail"
            type="email"
            value={values.fromEmail}
            onChange={(event) => update("fromEmail", event.target.value)}
            aria-invalid={errors.fromEmail ? "true" : undefined}
            aria-describedby={
              errors.fromEmail ? "mock-from-email-error" : undefined
            }
            className="customer-form__input"
            placeholder="security@facebookmail.example"
            autoComplete="off"
            required
            maxLength={254}
          />
          {errors.fromEmail && (
            <p id="mock-from-email-error" className="customer-form__error">
              {errors.fromEmail}
            </p>
          )}
        </div>

        <div className="customer-form__field">
          <label htmlFor="mock-from-name" className="customer-form__label">
            From name (optional)
          </label>
          <input
            id="mock-from-name"
            name="fromName"
            type="text"
            value={values.fromName}
            onChange={(event) => update("fromName", event.target.value)}
            aria-invalid={errors.fromName ? "true" : undefined}
            aria-describedby={
              errors.fromName ? "mock-from-name-error" : undefined
            }
            className="customer-form__input"
            placeholder="Facebook"
            maxLength={200}
          />
          {errors.fromName && (
            <p id="mock-from-name-error" className="customer-form__error">
              {errors.fromName}
            </p>
          )}
        </div>

        <div className="customer-form__field">
          <label htmlFor="mock-subject" className="customer-form__label">
            Subject
          </label>
          <input
            id="mock-subject"
            name="subject"
            type="text"
            value={values.subject}
            onChange={(event) => update("subject", event.target.value)}
            aria-invalid={errors.subject ? "true" : undefined}
            aria-describedby={
              errors.subject ? "mock-subject-error" : undefined
            }
            className="customer-form__input"
            placeholder="Your verification code"
            required
            maxLength={500}
          />
          {errors.subject && (
            <p id="mock-subject-error" className="customer-form__error">
              {errors.subject}
            </p>
          )}
        </div>

        <div className="customer-form__field">
          <label htmlFor="mock-received-at" className="customer-form__label">
            Received at (ISO 8601)
          </label>
          <input
            id="mock-received-at"
            name="receivedAt"
            type="text"
            value={values.receivedAt}
            onChange={(event) => update("receivedAt", event.target.value)}
            aria-invalid={errors.receivedAt ? "true" : undefined}
            aria-describedby={
              errors.receivedAt ? "mock-received-at-error" : "mock-received-at-hint"
            }
            className="customer-form__input"
            placeholder="2025-01-15T08:30:00Z"
            required
            maxLength={40}
            spellCheck={false}
          />
          <p id="mock-received-at-hint" className="telegram-form__hint">
            Use ISO 8601 format. Example: 2025-01-15T08:30:00Z.
          </p>
          {errors.receivedAt && (
            <p id="mock-received-at-error" className="customer-form__error">
              {errors.receivedAt}
            </p>
          )}
        </div>

        <div className="customer-form__field">
          <label htmlFor="mock-body-preview" className="customer-form__label">
            Body preview (optional)
          </label>
          <textarea
            id="mock-body-preview"
            name="bodyPreview"
            value={values.bodyPreview}
            onChange={(event) => update("bodyPreview", event.target.value)}
            aria-invalid={errors.bodyPreview ? "true" : undefined}
            aria-describedby={
              errors.bodyPreview ? "mock-body-preview-error" : undefined
            }
            className="customer-form__input customer-form__input--textarea"
            rows={2}
            maxLength={500}
          />
          {errors.bodyPreview && (
            <p id="mock-body-preview-error" className="customer-form__error">
              {errors.bodyPreview}
            </p>
          )}
        </div>

        <div className="customer-form__field">
          <label htmlFor="mock-body" className="customer-form__label">
            Body
          </label>
          <textarea
            id="mock-body"
            name="body"
            value={values.body}
            onChange={(event) => update("body", event.target.value)}
            aria-invalid={errors.body ? "true" : undefined}
            aria-describedby={errors.body ? "mock-body-error" : undefined}
            className="customer-form__input customer-form__input--textarea"
            rows={10}
            required
            maxLength={50000}
          />
          {errors.body && (
            <p id="mock-body-error" className="customer-form__error">
              {errors.body}
            </p>
          )}
        </div>

        <div className="customer-form__actions">
          <button
            type="button"
            className="customer-form__cancel"
            onClick={reset}
            disabled={submitting || sending}
          >
            Reset
          </button>
          <button
            type="submit"
            className="customer-form__submit"
            disabled={submitting || sending}
          >
            {submitting ? "Validating…" : "Validate mock email"}
          </button>
          <button
            type="button"
            className="customer-form__submit mock-email-form__send"
            onClick={onProcess}
            disabled={submitting || sending}
          >
            {sending ? "Processing…" : "Process & send to Telegram"}
          </button>
        </div>

        {processError && (
          <p className="customer-form__form-error" role="alert">
            {processError}
          </p>
        )}

        {processResult && (
          <div
            className={`mock-email-result mock-email-result--${processResultTone(
              processResult.status,
            )}`}
            role="status"
            aria-live="polite"
          >
            <p className="mock-email-result__status">
              {PROCESS_STATUS_LABELS[processResult.status]}
            </p>
            <dl className="mock-email-result__meta">
              {processResult.platform && (
                <div className="mock-email-result__row">
                  <dt>Platform</dt>
                  <dd>{processResult.platform}</dd>
                </div>
              )}
              {typeof processResult.confidence === "number" && (
                <div className="mock-email-result__row">
                  <dt>Confidence</dt>
                  <dd>{processResult.confidence}</dd>
                </div>
              )}
              {processResult.maskedCode && (
                <div className="mock-email-result__row">
                  <dt>Code (masked)</dt>
                  <dd>{processResult.maskedCode}</dd>
                </div>
              )}
              {processResult.reason && (
                <div className="mock-email-result__row">
                  <dt>Detail</dt>
                  <dd>{processResult.reason}</dd>
                </div>
              )}
            </dl>
          </div>
        )}
      </form>

      <aside
        className="mock-email-preview"
        aria-label="Safe JSON preview"
        aria-live="polite"
      >
        <h3 className="mock-email-preview__heading">Safe JSON preview</h3>
        {preview ? (
          <pre className="mock-email-preview__pre">
            {JSON.stringify(preview, null, 2)}
          </pre>
        ) : (
          <p className="mock-email-preview__empty">
            Submit a mock email to see the server-validated, safe JSON preview.
            The full body is never echoed back — only a short snippet and its
            length.
          </p>
        )}
      </aside>
    </div>
  );
}
