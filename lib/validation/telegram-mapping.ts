export const TELEGRAM_MAPPING_STATUS_VALUES = ['ACTIVE', 'DISABLED'] as const;
export type TelegramMappingStatus = (typeof TELEGRAM_MAPPING_STATUS_VALUES)[number];

export interface TelegramMappingInput {
  mailboxId: string;
  telegramChatId: string;
  telegramGroupName: string;
  // TASK-041 — optional forum-topic routing. `null` (not undefined) means "no
  // topic", which keeps the persisted/serialised shape stable and explicit.
  telegramThreadId: string | null;
  telegramTopicName: string | null;
  status: TelegramMappingStatus;
}

export interface RawTelegramMappingInput {
  mailboxId?: unknown;
  telegramChatId?: unknown;
  telegramGroupName?: unknown;
  telegramThreadId?: unknown;
  telegramTopicName?: unknown;
  status?: unknown;
}

export type TelegramMappingFieldErrors = Partial<
  Record<keyof TelegramMappingInput, string>
>;

export type TelegramMappingValidationResult =
  | { ok: true; data: TelegramMappingInput }
  | { ok: false; errors: TelegramMappingFieldErrors };

const CHAT_ID_MAX = 64;
const GROUP_NAME_MAX = 200;
const TOPIC_NAME_MAX = 200;
const THREAD_ID_MAX = 32;
const CHAT_ID_PATTERN = /^-?[0-9]+$|^@[A-Za-z0-9_]{4,}$/;
// Telegram forum topic / message_thread_id is a positive integer (a message id).
const THREAD_ID_PATTERN = /^[1-9][0-9]*$/;
// Bot tokens look like "123456:AAA..." — reject them so they never end up
// stored as a chat ID through a copy/paste mistake.
const BOT_TOKEN_LIKE = /\d+:[A-Za-z0-9_-]{10,}/;
const SUSPICIOUS_GROUP_NAME = /\b(bot[_-]?token|token|secret|api[_-]?key)\b/i;

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function isStatus(value: unknown): value is TelegramMappingStatus {
  return (
    typeof value === 'string' &&
    (TELEGRAM_MAPPING_STATUS_VALUES as readonly string[]).includes(value)
  );
}

export function validateTelegramMappingInput(
  raw: RawTelegramMappingInput,
): TelegramMappingValidationResult {
  const errors: TelegramMappingFieldErrors = {};

  const mailboxId = asString(raw.mailboxId)?.trim() ?? '';
  if (mailboxId.length === 0) {
    errors.mailboxId = 'Mailbox is required.';
  }

  const chatId = asString(raw.telegramChatId)?.trim() ?? '';
  if (chatId.length === 0) {
    errors.telegramChatId = 'Telegram chat ID is required.';
  } else if (chatId.length > CHAT_ID_MAX) {
    errors.telegramChatId = `Telegram chat ID must be ${CHAT_ID_MAX} characters or fewer.`;
  } else if (BOT_TOKEN_LIKE.test(chatId)) {
    errors.telegramChatId = 'Telegram chat ID must not contain a bot token.';
  } else if (!CHAT_ID_PATTERN.test(chatId)) {
    errors.telegramChatId =
      'Telegram chat ID must be a numeric ID (e.g. -1001234567890) or @channel handle.';
  }

  const groupName = asString(raw.telegramGroupName)?.trim() ?? '';
  if (groupName.length === 0) {
    errors.telegramGroupName = 'Telegram group name is required.';
  } else if (groupName.length > GROUP_NAME_MAX) {
    errors.telegramGroupName = `Telegram group name must be ${GROUP_NAME_MAX} characters or fewer.`;
  } else if (BOT_TOKEN_LIKE.test(groupName) || SUSPICIOUS_GROUP_NAME.test(groupName)) {
    errors.telegramGroupName = 'Telegram group name must not contain secrets or tokens.';
  }

  // Optional forum-topic thread id. Empty/undefined → null (plain group send).
  let threadId: string | null = null;
  const rawThreadId = asString(raw.telegramThreadId)?.trim() ?? '';
  if (rawThreadId.length > 0) {
    if (rawThreadId.length > THREAD_ID_MAX) {
      errors.telegramThreadId = `Telegram topic ID must be ${THREAD_ID_MAX} characters or fewer.`;
    } else if (!THREAD_ID_PATTERN.test(rawThreadId)) {
      errors.telegramThreadId =
        'Telegram topic ID must be a positive number (the topic/thread message id).';
    } else {
      threadId = rawThreadId;
    }
  }

  // Optional human-readable topic label. Display only — it never routes.
  let topicName: string | null = null;
  const rawTopicName = asString(raw.telegramTopicName)?.trim() ?? '';
  if (rawTopicName.length > 0) {
    if (rawTopicName.length > TOPIC_NAME_MAX) {
      errors.telegramTopicName = `Telegram topic name must be ${TOPIC_NAME_MAX} characters or fewer.`;
    } else if (
      BOT_TOKEN_LIKE.test(rawTopicName) ||
      SUSPICIOUS_GROUP_NAME.test(rawTopicName)
    ) {
      errors.telegramTopicName =
        'Telegram topic name must not contain secrets or tokens.';
    } else {
      topicName = rawTopicName;
    }
  }

  let status: TelegramMappingStatus = 'ACTIVE';
  if (raw.status === undefined || raw.status === '' || raw.status === null) {
    status = 'ACTIVE';
  } else if (isStatus(raw.status)) {
    status = raw.status;
  } else {
    errors.status = 'Status must be ACTIVE or DISABLED.';
  }

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: {
      mailboxId,
      telegramChatId: chatId,
      telegramGroupName: groupName,
      telegramThreadId: threadId,
      telegramTopicName: topicName,
      status,
    },
  };
}
