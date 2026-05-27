export interface MockEmailInput {
  mailboxEmail: string;
  fromEmail: string;
  fromName?: string;
  subject: string;
  receivedAt: string;
  bodyPreview?: string;
  body: string;
}

export interface RawMockEmailInput {
  mailboxEmail?: unknown;
  fromEmail?: unknown;
  fromName?: unknown;
  subject?: unknown;
  receivedAt?: unknown;
  bodyPreview?: unknown;
  body?: unknown;
}

export type MockEmailFieldErrors = Partial<
  Record<keyof MockEmailInput, string>
>;

export type MockEmailValidationResult =
  | { ok: true; data: MockEmailInput }
  | { ok: false; errors: MockEmailFieldErrors };

const EMAIL_MAX = 254;
const NAME_MAX = 200;
const SUBJECT_MAX = 500;
const BODY_PREVIEW_MAX = 500;
const BODY_MAX = 50_000;

const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
const SUSPICIOUS_SECRET = /\b(bot[_-]?token|client[_-]?secret|api[_-]?key|password)\b/i;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isValidIsoDate(value: string): boolean {
  if (value.length === 0) return false;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().startsWith(value.slice(0, 10));
}

export function validateMockEmailInput(
  raw: RawMockEmailInput,
): MockEmailValidationResult {
  const errors: MockEmailFieldErrors = {};

  const mailboxEmail = asString(raw.mailboxEmail)?.trim() ?? '';
  if (mailboxEmail.length === 0) {
    errors.mailboxEmail = 'Mailbox email is required.';
  } else if (mailboxEmail.length > EMAIL_MAX) {
    errors.mailboxEmail = `Mailbox email must be ${EMAIL_MAX} characters or fewer.`;
  } else if (!EMAIL_PATTERN.test(mailboxEmail)) {
    errors.mailboxEmail = 'Mailbox email must be a valid email address.';
  }

  const fromEmail = asString(raw.fromEmail)?.trim() ?? '';
  if (fromEmail.length === 0) {
    errors.fromEmail = 'From email is required.';
  } else if (fromEmail.length > EMAIL_MAX) {
    errors.fromEmail = `From email must be ${EMAIL_MAX} characters or fewer.`;
  } else if (!EMAIL_PATTERN.test(fromEmail)) {
    errors.fromEmail = 'From email must be a valid email address.';
  }

  const fromNameRaw = asString(raw.fromName)?.trim() ?? '';
  let fromName: string | undefined;
  if (fromNameRaw.length === 0) {
    fromName = undefined;
  } else if (fromNameRaw.length > NAME_MAX) {
    errors.fromName = `From name must be ${NAME_MAX} characters or fewer.`;
  } else if (SUSPICIOUS_SECRET.test(fromNameRaw)) {
    errors.fromName = 'From name must not contain secrets or tokens.';
  } else {
    fromName = fromNameRaw;
  }

  const subject = asString(raw.subject)?.trim() ?? '';
  if (subject.length === 0) {
    errors.subject = 'Subject is required.';
  } else if (subject.length > SUBJECT_MAX) {
    errors.subject = `Subject must be ${SUBJECT_MAX} characters or fewer.`;
  } else if (SUSPICIOUS_SECRET.test(subject)) {
    errors.subject = 'Subject must not contain secrets or tokens.';
  }

  const receivedAt = asString(raw.receivedAt)?.trim() ?? '';
  if (receivedAt.length === 0) {
    errors.receivedAt = 'Received at is required.';
  } else if (!isValidIsoDate(receivedAt)) {
    errors.receivedAt = 'Received at must be an ISO 8601 date (e.g. 2025-01-15T08:30:00Z).';
  }

  const bodyPreviewRaw = asString(raw.bodyPreview)?.trim() ?? '';
  let bodyPreview: string | undefined;
  if (bodyPreviewRaw.length === 0) {
    bodyPreview = undefined;
  } else if (bodyPreviewRaw.length > BODY_PREVIEW_MAX) {
    errors.bodyPreview = `Body preview must be ${BODY_PREVIEW_MAX} characters or fewer.`;
  } else {
    bodyPreview = bodyPreviewRaw;
  }

  const body = asString(raw.body) ?? '';
  if (body.trim().length === 0) {
    errors.body = 'Body is required.';
  } else if (body.length > BODY_MAX) {
    errors.body = `Body must be ${BODY_MAX} characters or fewer.`;
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  const data: MockEmailInput = {
    mailboxEmail,
    fromEmail,
    subject,
    receivedAt,
    body,
  };
  if (fromName !== undefined) data.fromName = fromName;
  if (bodyPreview !== undefined) data.bodyPreview = bodyPreview;

  return { ok: true, data };
}

const PREVIEW_BODY_LIMIT = 200;

export interface MockEmailSafePreview {
  mailboxEmail: string;
  fromEmail: string;
  fromName?: string;
  subject: string;
  receivedAt: string;
  bodyPreview?: string;
  bodyLength: number;
  bodySnippet: string;
}

export function toSafePreview(input: MockEmailInput): MockEmailSafePreview {
  const snippet = input.body.slice(0, PREVIEW_BODY_LIMIT);
  const preview: MockEmailSafePreview = {
    mailboxEmail: input.mailboxEmail,
    fromEmail: input.fromEmail,
    subject: input.subject,
    receivedAt: input.receivedAt,
    bodyLength: input.body.length,
    bodySnippet: snippet,
  };
  if (input.fromName !== undefined) preview.fromName = input.fromName;
  if (input.bodyPreview !== undefined) preview.bodyPreview = input.bodyPreview;
  return preview;
}
