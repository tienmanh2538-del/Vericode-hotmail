// TASK-033 — Telegram error classification for the retry layer.
//
// This module decides whether a failed `sendTelegramMessage` attempt is worth
// retrying. It contains NO secrets and NO network logic — it only inspects the
// safe metadata already carried by `TelegramSendError` (kind + HTTP status +
// retry_after). Keeping classification pure makes the retry policy trivially
// unit-testable.
//
// Policy (see TASK-033 §4.2):
//   Retry      → HTTP 429, any HTTP 5xx (500/502/503/504), network, timeout
//   Do NOT     → HTTP 400/401/403/404 (and any other 4xx), validation, config

import { TelegramSendError } from './telegram-sender.service';

/** HTTP statuses Telegram returns that are worth retrying. */
export const RETRYABLE_HTTP_STATUS: ReadonlySet<number> = new Set([
  429, 500, 502, 503, 504,
]);

/** HTTP statuses that are permanent — retrying cannot help. */
export const NON_RETRYABLE_HTTP_STATUS: ReadonlySet<number> = new Set([
  400, 401, 403, 404,
]);

function isRetryableStatus(status: number): boolean {
  if (NON_RETRYABLE_HTTP_STATUS.has(status)) return false;
  if (RETRYABLE_HTTP_STATUS.has(status)) return true;
  // Treat any other 5xx as transient; any other 4xx as permanent.
  if (status >= 500 && status <= 599) return true;
  return false;
}

/**
 * Decide whether a thrown error should trigger another Telegram send attempt.
 * Defaults to NOT retrying anything unexpected so genuine bugs surface fast
 * instead of being masked by silent retries.
 */
export function isRetryableTelegramError(error: unknown): boolean {
  if (!(error instanceof TelegramSendError)) return false;
  switch (error.kind) {
    case 'network':
      // Covers transient network failures and timeouts.
      return true;
    case 'telegram_api':
      return typeof error.statusCode === 'number'
        ? isRetryableStatus(error.statusCode)
        : false;
    case 'validation':
    case 'config':
      // Bad payload / missing token — retrying sends the same broken request.
      return false;
    default:
      return false;
  }
}

export interface TelegramFailureDescription {
  failureReason: string;
  retryable: boolean;
  statusCode?: number;
}

/**
 * Produce a safe, human-readable failure summary for the send result and logs.
 * The returned `failureReason` deliberately contains only the error category
 * and HTTP status — never the message text, verification code, or token.
 */
export function describeTelegramFailure(
  error: unknown,
): TelegramFailureDescription {
  const retryable = isRetryableTelegramError(error);
  if (error instanceof TelegramSendError) {
    const statusPart =
      typeof error.statusCode === 'number' ? `_${error.statusCode}` : '';
    return {
      failureReason: `${error.kind}${statusPart}`,
      retryable,
      statusCode: error.statusCode,
    };
  }
  return { failureReason: 'unknown_error', retryable: false };
}

/**
 * Resolve how long to wait before the next attempt, in milliseconds.
 *
 * If Telegram supplied `retry_after` (HTTP 429 throttling), honour it but cap
 * it at `maxRetryAfterMs` so a hostile or buggy server can never stall the
 * worker — and so unit tests using a fake clock stay bounded. Otherwise fall
 * back to the configured backoff delay for this retry.
 */
export function resolveDelayMs(args: {
  error: unknown;
  backoffMs: number;
  maxRetryAfterMs: number;
}): number {
  const { error, backoffMs, maxRetryAfterMs } = args;
  if (error instanceof TelegramSendError) {
    const seconds = error.retryAfterSeconds;
    if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, maxRetryAfterMs);
    }
  }
  return backoffMs;
}
