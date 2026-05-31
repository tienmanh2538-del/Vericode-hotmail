import { requireTelegramEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';

const logger = createLogger();

export const TELEGRAM_TEXT_MAX = 4096;

export type TelegramParseMode = 'HTML' | 'MarkdownV2';

export interface SendTelegramMessageInput {
  chatId: string;
  text: string;
  /**
   * TASK-041 — optional Telegram forum topic. When set, it is sent as
   * `message_thread_id` so the message lands in a specific topic inside the
   * group. Omit it (or pass undefined) for plain group delivery.
   */
  messageThreadId?: string;
  parseMode?: TelegramParseMode;
  disableNotification?: boolean;
}

export interface SendTelegramMessageResult {
  ok: true;
  chatId: string;
  messageId?: number;
}

export type TelegramErrorKind =
  | 'validation'
  | 'config'
  | 'network'
  | 'telegram_api';

export class TelegramSendError extends Error {
  readonly kind: TelegramErrorKind;
  readonly field?: 'chatId' | 'text' | 'messageThreadId';
  readonly telegramDescription?: string;
  /**
   * HTTP status returned by the Telegram Bot API (only set for `telegram_api`
   * failures). Used by the retry layer (TASK-033) to classify retryable vs
   * permanent errors. Never carries token/code material.
   */
  readonly statusCode?: number;
  /**
   * `parameters.retry_after` (seconds) when Telegram throttles with HTTP 429.
   * The retry layer caps this before sleeping so it can never hang a test or
   * stall the worker indefinitely.
   */
  readonly retryAfterSeconds?: number;

  constructor(
    kind: TelegramErrorKind,
    message: string,
    options?: {
      field?: 'chatId' | 'text' | 'messageThreadId';
      telegramDescription?: string;
      statusCode?: number;
      retryAfterSeconds?: number;
    },
  ) {
    super(message);
    this.name = 'TelegramSendError';
    this.kind = kind;
    this.field = options?.field;
    this.telegramDescription = options?.telegramDescription;
    this.statusCode = options?.statusCode;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

interface TelegramApiResponse {
  ok: boolean;
  result?: { message_id?: number };
  description?: string;
  parameters?: { retry_after?: number };
}

function readRetryAfterSeconds(payload: unknown): number | undefined {
  if (!isTelegramApiResponse(payload)) return undefined;
  const value = payload.parameters?.retry_after;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? value
    : undefined;
}

// Telegram forum topic id (`message_thread_id`) is a positive integer.
const THREAD_ID_PATTERN = /^[1-9][0-9]*$/;

function validate(input: SendTelegramMessageInput): {
  chatId: string;
  text: string;
  messageThreadId?: number;
} {
  if (typeof input.chatId !== 'string') {
    throw new TelegramSendError('validation', 'chatId is required', { field: 'chatId' });
  }
  const chatId = input.chatId.trim();
  if (chatId.length === 0) {
    throw new TelegramSendError('validation', 'chatId is required', { field: 'chatId' });
  }

  if (typeof input.text !== 'string') {
    throw new TelegramSendError('validation', 'text is required', { field: 'text' });
  }
  const text = input.text.trim();
  if (text.length === 0) {
    throw new TelegramSendError('validation', 'text is required', { field: 'text' });
  }
  if (text.length > TELEGRAM_TEXT_MAX) {
    throw new TelegramSendError(
      'validation',
      `text must be ${TELEGRAM_TEXT_MAX} characters or fewer`,
      { field: 'text' },
    );
  }

  // Optional forum topic. Undefined/empty → plain group delivery (unchanged).
  let messageThreadId: number | undefined;
  if (input.messageThreadId !== undefined && input.messageThreadId !== null) {
    if (typeof input.messageThreadId !== 'string') {
      throw new TelegramSendError('validation', 'messageThreadId is invalid', {
        field: 'messageThreadId',
      });
    }
    const trimmed = input.messageThreadId.trim();
    if (trimmed.length > 0) {
      if (!THREAD_ID_PATTERN.test(trimmed)) {
        throw new TelegramSendError(
          'validation',
          'messageThreadId must be a positive integer',
          { field: 'messageThreadId' },
        );
      }
      messageThreadId = Number(trimmed);
    }
  }

  return { chatId, text, messageThreadId };
}

function isTelegramApiResponse(value: unknown): value is TelegramApiResponse {
  return typeof value === 'object' && value !== null && 'ok' in value;
}

export async function sendTelegramMessage(
  input: SendTelegramMessageInput,
): Promise<SendTelegramMessageResult> {
  const { chatId, text, messageThreadId } = validate(input);

  let botToken: string;
  try {
    botToken = requireTelegramEnv().botToken;
  } catch {
    throw new TelegramSendError('config', 'Telegram bot token is not configured');
  }

  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const body: Record<string, unknown> = { chat_id: chatId, text };
  if (messageThreadId !== undefined) body.message_thread_id = messageThreadId;
  if (input.parseMode) body.parse_mode = input.parseMode;
  if (input.disableNotification) body.disable_notification = true;

  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    logger.error('Telegram network call failed', { chatId });
    throw new TelegramSendError('network', 'Telegram request failed');
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Telegram returned non-JSON; treat as API failure.
  }

  if (!response.ok || !isTelegramApiResponse(payload) || payload.ok !== true) {
    const description =
      isTelegramApiResponse(payload) && typeof payload.description === 'string'
        ? payload.description
        : undefined;
    const retryAfterSeconds = readRetryAfterSeconds(payload);
    logger.warn('Telegram API rejected sendMessage', {
      chatId,
      status: response.status,
      description,
    });
    throw new TelegramSendError('telegram_api', 'Telegram send failed', {
      telegramDescription: description,
      statusCode: response.status,
      retryAfterSeconds,
    });
  }

  const messageId =
    typeof payload.result?.message_id === 'number' ? payload.result.message_id : undefined;

  return { ok: true, chatId, messageId };
}
