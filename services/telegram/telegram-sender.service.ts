import { requireTelegramEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import {
  fetchWithTimeout,
  HttpTimeoutError,
} from '@/lib/http/fetch-with-timeout';

const logger = createLogger();

export const TELEGRAM_TEXT_MAX = 4096;

// TASK-090 correction — explicit finite ceiling on ONE Telegram HTTP attempt,
// enforced with a REAL AbortController cancellation (TASK-080 helper), never
// the runtime's implicit socket behaviour. A timeout maps to the `network`
// error kind, i.e. RETRYABLE — never permanent, never an auth signal.
//
// The value is derived from the TASK-090 delivery-lease budget, not picked
// arbitrarily. Worst-case duration of one delivery ownership (one worker
// attempt holding the lease) with this ceiling:
//
//   HTTP:      4 attempts × 15s                          =  60s
//              (1 + DEFAULT_TELEGRAM_RETRY_DELAYS_MS.length, TASK-033)
//   backoff:   3 waits × DEFAULT_MAX_RETRY_AFTER_MS(60s) = 180s  (429 worst)
//   pacing:    destination throttle cap 15s + global pacer cap 2s = 17s
//   overhead:  DB CAS/lookup writes — millisecond-scale
//   ------------------------------------------------------------------
//   total ≈ 257s  <  DELIVERY_LEASE_MS (300s), safety margin ≈ 43s (~14%)
//
// A deterministic test pins this inequality against the REAL constants
// (tests/unit/telegram/telegram-sender.timeout.test.ts), so changing any term
// without re-proving the budget fails the suite. Deliberately NOT env-tunable —
// this is a bounded safety constant, same policy as the TASK-080/090 windows.
export const TELEGRAM_HTTP_TIMEOUT_MS = 15_000;

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
  /**
   * TASK-090 (DF-90-4) — final retryability verdict attached by the TASK-033
   * retry adapter when it re-throws after its bounded internal attempts:
   *   false     → permanent/non-retryable (e.g. 400/403/404, validation,
   *               config) — callers must treat delivery as terminally failed
   *               and must NOT schedule any further retry.
   *   true      → transient (429/5xx/network) whose bounded internal retries
   *               were exhausted — a queue-level re-attempt may still help.
   *   undefined → not classified (error thrown below the retry adapter);
   *               callers keep their previous conservative behaviour.
   * The classification itself stays in telegram-error.ts — this field only
   * carries the verdict across the throw boundary.
   */
  readonly retryable?: boolean;

  constructor(
    kind: TelegramErrorKind,
    message: string,
    options?: {
      field?: 'chatId' | 'text' | 'messageThreadId';
      telegramDescription?: string;
      statusCode?: number;
      retryAfterSeconds?: number;
      retryable?: boolean;
    },
  ) {
    super(message);
    this.name = 'TelegramSendError';
    this.kind = kind;
    this.field = options?.field;
    this.telegramDescription = options?.telegramDescription;
    this.statusCode = options?.statusCode;
    this.retryAfterSeconds = options?.retryAfterSeconds;
    this.retryable = options?.retryable;
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
    // TASK-090 correction — finite timeout + real cancellation: on expiry the
    // AbortController tears the request down (the promise settles), so a hung
    // Telegram call can never hold a delivery-lease owner past its budget.
    response = await fetchWithTimeout(
      fetch,
      url,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      { timeoutMs: TELEGRAM_HTTP_TIMEOUT_MS },
    );
  } catch (error) {
    if (error instanceof HttpTimeoutError) {
      // Timeout is a transient outcome: classify as `network` (retryable per
      // telegram-error.ts) — never permanent. NOTE: the request may still have
      // reached Telegram before the abort, so this sits inside the documented
      // ambiguous remote-side-effect window (bounded duplicate risk).
      logger.warn('Telegram request timed out', {
        chatId,
        timeoutMs: TELEGRAM_HTTP_TIMEOUT_MS,
      });
      throw new TelegramSendError('network', 'Telegram request timed out');
    }
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
