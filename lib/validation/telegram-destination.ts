// TASK-053 — reusable Telegram destination input validation.
//
// A destination is a saved Telegram group (or forum topic) scoped to a customer.
// It reuses the shared chat/group/thread/topic validators so a destination
// rejects the exact same suspicious values (pasted bot tokens, secrets) as a
// mapping. SECURITY: only chat/thread ids and human labels are accepted here —
// never a bot token.

import {
  asString,
  validateChatId,
  validateOptionalThreadId,
  validateOptionalTopicName,
  validateRequiredName,
} from './telegram-fields';
import {
  isTelegramMappingStatus,
  type TelegramMappingStatus,
} from './telegram-mapping';

export interface TelegramDestinationInput {
  customerId: string;
  displayName: string;
  telegramGroupName: string;
  telegramChatId: string;
  telegramThreadId: string | null;
  telegramTopicName: string | null;
  status: TelegramMappingStatus;
}

export interface RawTelegramDestinationInput {
  customerId?: unknown;
  displayName?: unknown;
  telegramGroupName?: unknown;
  telegramChatId?: unknown;
  telegramThreadId?: unknown;
  telegramTopicName?: unknown;
  status?: unknown;
}

export type TelegramDestinationFieldErrors = Partial<
  Record<keyof TelegramDestinationInput, string>
>;

export type TelegramDestinationValidationResult =
  | { ok: true; data: TelegramDestinationInput }
  | { ok: false; errors: TelegramDestinationFieldErrors };

export function validateTelegramDestinationInput(
  raw: RawTelegramDestinationInput,
): TelegramDestinationValidationResult {
  const errors: TelegramDestinationFieldErrors = {};

  const customerId = asString(raw.customerId)?.trim() ?? '';
  if (customerId.length === 0) {
    errors.customerId = 'Customer is required.';
  }

  const displayName = validateRequiredName(raw.displayName, 'Display name');
  if (displayName.error) errors.displayName = displayName.error;

  const groupName = validateRequiredName(
    raw.telegramGroupName,
    'Telegram group name',
  );
  if (groupName.error) errors.telegramGroupName = groupName.error;

  const chatId = validateChatId(raw.telegramChatId);
  if (chatId.error) errors.telegramChatId = chatId.error;

  const threadId = validateOptionalThreadId(raw.telegramThreadId);
  if (threadId.error) errors.telegramThreadId = threadId.error;

  const topicName = validateOptionalTopicName(raw.telegramTopicName);
  if (topicName.error) errors.telegramTopicName = topicName.error;

  let status: TelegramMappingStatus = 'ACTIVE';
  if (raw.status === undefined || raw.status === '' || raw.status === null) {
    status = 'ACTIVE';
  } else if (isTelegramMappingStatus(raw.status)) {
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
      customerId,
      displayName: displayName.value,
      telegramGroupName: groupName.value,
      telegramChatId: chatId.value,
      telegramThreadId: threadId.value,
      telegramTopicName: topicName.value,
      status,
    },
  };
}
