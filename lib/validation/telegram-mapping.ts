import {
  asString,
  validateChatId,
  validateOptionalThreadId,
  validateOptionalTopicName,
  validateRequiredName,
} from './telegram-fields';

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

export function isTelegramMappingStatus(
  value: unknown,
): value is TelegramMappingStatus {
  return (
    typeof value === 'string' &&
    (TELEGRAM_MAPPING_STATUS_VALUES as readonly string[]).includes(value)
  );
}

function readStatus(
  raw: unknown,
): { value: TelegramMappingStatus; error?: string } {
  if (raw === undefined || raw === '' || raw === null) {
    return { value: 'ACTIVE' };
  }
  if (isTelegramMappingStatus(raw)) {
    return { value: raw };
  }
  return { value: 'ACTIVE', error: 'Status must be ACTIVE or DISABLED.' };
}

export function validateTelegramMappingInput(
  raw: RawTelegramMappingInput,
): TelegramMappingValidationResult {
  const errors: TelegramMappingFieldErrors = {};

  const mailboxId = asString(raw.mailboxId)?.trim() ?? '';
  if (mailboxId.length === 0) {
    errors.mailboxId = 'Mailbox is required.';
  }

  const chatId = validateChatId(raw.telegramChatId);
  if (chatId.error) errors.telegramChatId = chatId.error;

  const groupName = validateRequiredName(
    raw.telegramGroupName,
    'Telegram group name',
  );
  if (groupName.error) errors.telegramGroupName = groupName.error;

  const threadId = validateOptionalThreadId(raw.telegramThreadId);
  if (threadId.error) errors.telegramThreadId = threadId.error;

  const topicName = validateOptionalTopicName(raw.telegramTopicName);
  if (topicName.error) errors.telegramTopicName = topicName.error;

  const status = readStatus(raw.status);
  if (status.error) errors.status = status.error;

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: {
      mailboxId,
      telegramChatId: chatId.value,
      telegramGroupName: groupName.value,
      telegramThreadId: threadId.value,
      telegramTopicName: topicName.value,
      status: status.value,
    },
  };
}

// ---------------------------------------------------------------------------
// TASK-053 — destination-based mapping input.
//
// The new UI no longer asks the operator to re-type chat/thread details: they
// pick a mailbox and a saved TelegramDestination. The chat/group/thread/topic
// are derived server-side from the destination, so this input only carries the
// three fields the operator actually chooses.
// ---------------------------------------------------------------------------

export interface TelegramDestinationMappingInput {
  mailboxId: string;
  destinationId: string;
  status: TelegramMappingStatus;
}

export interface RawTelegramDestinationMappingInput {
  mailboxId?: unknown;
  destinationId?: unknown;
  status?: unknown;
}

export type TelegramDestinationMappingFieldErrors = Partial<
  Record<keyof TelegramDestinationMappingInput, string>
>;

export type TelegramDestinationMappingValidationResult =
  | { ok: true; data: TelegramDestinationMappingInput }
  | { ok: false; errors: TelegramDestinationMappingFieldErrors };

export function validateTelegramDestinationMappingInput(
  raw: RawTelegramDestinationMappingInput,
): TelegramDestinationMappingValidationResult {
  const errors: TelegramDestinationMappingFieldErrors = {};

  const mailboxId = asString(raw.mailboxId)?.trim() ?? '';
  if (mailboxId.length === 0) {
    errors.mailboxId = 'Mailbox is required.';
  }

  const destinationId = asString(raw.destinationId)?.trim() ?? '';
  if (destinationId.length === 0) {
    errors.destinationId = 'Telegram destination is required.';
  }

  const status = readStatus(raw.status);
  if (status.error) errors.status = status.error;

  if (Object.keys(errors).length > 0) {
    return { ok: false, errors };
  }

  return {
    ok: true,
    data: { mailboxId, destinationId, status: status.value },
  };
}
