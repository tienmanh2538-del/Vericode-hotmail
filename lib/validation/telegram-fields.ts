// TASK-053 — shared Telegram field validators.
//
// Both the Telegram mapping input (lib/validation/telegram-mapping.ts) and the
// reusable Telegram destination input (lib/validation/telegram-destination.ts)
// validate the same chat/group/thread/topic shapes. Keeping the rules in one
// place avoids drift (DRY) and guarantees a destination and a mapping reject the
// exact same suspicious values (e.g. a pasted bot token).

export const CHAT_ID_MAX = 64;
export const NAME_MAX = 200;
export const THREAD_ID_MAX = 32;

// Numeric chat id (e.g. -1001234567890) or a @channel handle.
export const CHAT_ID_PATTERN = /^-?[0-9]+$|^@[A-Za-z0-9_]{4,}$/;
// Telegram forum topic / message_thread_id is a positive integer (a message id).
export const THREAD_ID_PATTERN = /^[1-9][0-9]*$/;
// Bot tokens look like "123456:AAA..." — reject them so they never get stored as
// a chat id or leaked into a human label through a copy/paste mistake.
export const BOT_TOKEN_LIKE = /\d+:[A-Za-z0-9_-]{10,}/;
export const SUSPICIOUS_TEXT = /\b(bot[_-]?token|token|secret|api[_-]?key)\b/i;

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export interface FieldResult<T> {
  value: T;
  error?: string;
}

export function validateChatId(raw: unknown): FieldResult<string> {
  const chatId = asString(raw)?.trim() ?? '';
  if (chatId.length === 0) {
    return { value: '', error: 'Telegram chat ID is required.' };
  }
  if (chatId.length > CHAT_ID_MAX) {
    return {
      value: chatId,
      error: `Telegram chat ID must be ${CHAT_ID_MAX} characters or fewer.`,
    };
  }
  if (BOT_TOKEN_LIKE.test(chatId)) {
    return { value: chatId, error: 'Telegram chat ID must not contain a bot token.' };
  }
  if (!CHAT_ID_PATTERN.test(chatId)) {
    return {
      value: chatId,
      error:
        'Telegram chat ID must be a numeric ID (e.g. -1001234567890) or @channel handle.',
    };
  }
  return { value: chatId };
}

export function validateRequiredName(
  raw: unknown,
  label: string,
): FieldResult<string> {
  const name = asString(raw)?.trim() ?? '';
  if (name.length === 0) {
    return { value: '', error: `${label} is required.` };
  }
  if (name.length > NAME_MAX) {
    return { value: name, error: `${label} must be ${NAME_MAX} characters or fewer.` };
  }
  if (BOT_TOKEN_LIKE.test(name) || SUSPICIOUS_TEXT.test(name)) {
    return { value: name, error: `${label} must not contain secrets or tokens.` };
  }
  return { value: name };
}

// Optional forum-topic thread id. Empty/undefined → null (plain group send).
export function validateOptionalThreadId(raw: unknown): FieldResult<string | null> {
  const value = asString(raw)?.trim() ?? '';
  if (value.length === 0) return { value: null };
  if (value.length > THREAD_ID_MAX) {
    return {
      value: null,
      error: `Telegram topic ID must be ${THREAD_ID_MAX} characters or fewer.`,
    };
  }
  if (!THREAD_ID_PATTERN.test(value)) {
    return {
      value: null,
      error: 'Telegram topic ID must be a positive number (the topic/thread message id).',
    };
  }
  return { value };
}

// Optional human-readable topic label. Display only — it never routes.
export function validateOptionalTopicName(raw: unknown): FieldResult<string | null> {
  const value = asString(raw)?.trim() ?? '';
  if (value.length === 0) return { value: null };
  if (value.length > NAME_MAX) {
    return {
      value: null,
      error: `Telegram topic name must be ${NAME_MAX} characters or fewer.`,
    };
  }
  if (BOT_TOKEN_LIKE.test(value) || SUSPICIOUS_TEXT.test(value)) {
    return { value: null, error: 'Telegram topic name must not contain secrets or tokens.' };
  }
  return { value };
}
