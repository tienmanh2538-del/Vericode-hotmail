// TASK-033 — Telegram retry & failure handling.
//
// Wraps `sendTelegramMessage` with a controlled, bounded retry/backoff loop:
//
//   Initial attempt → retry after 5s → retry after 15s → retry after 30s
//   (1 initial + 3 retries = 4 attempts maximum; never an unbounded loop)
//
// Design contract (see docs/SECURITY_RULES.md + TASK-033):
//   - The SAME `input` (and therefore the SAME chatId) is reused for every
//     attempt. We never refetch the Telegram mapping mid-retry, so a code can
//     never be redirected to a different customer's group.
//   - `sleep` and `retryDelaysMs` are injectable so unit tests run instantly
//     instead of waiting 5/15/30 real seconds.
//   - Logs carry only attempt number, HTTP status, and a failure category.
//     The message text, verification code, and bot token are never logged.
//   - Returns a discriminated result; it never throws on a delivery failure.

import { createLogger, type Logger } from '@/lib/logger';
import { sendAdminAlert } from '@/services/alerts/alert.service';
import type { AlertDeliveryResult } from '@/services/alerts/alert.types';
import {
  sendTelegramMessage,
  TelegramSendError,
  type SendTelegramMessageInput,
  type SendTelegramMessageResult,
} from './telegram-sender.service';
import {
  describeTelegramFailure,
  isRetryableTelegramError,
  resolveDelayMs,
} from './telegram-error';

/** Default backoff schedule: 5s, 15s, 30s (3 retries after the first send). */
export const DEFAULT_TELEGRAM_RETRY_DELAYS_MS: readonly number[] = [
  5_000, 15_000, 30_000,
];

/** Hard cap applied to Telegram's `retry_after` so retries stay bounded. */
export const DEFAULT_MAX_RETRY_AFTER_MS = 60_000;

export type TelegramSendOutcome =
  | {
      ok: true;
      attempts: number;
      telegramMessageId?: number;
      chatId: string;
    }
  | {
      ok: false;
      attempts: number;
      failureReason: string;
      retryable: boolean;
      statusCode?: number;
      chatId: string;
    };

export interface TelegramRetryOptions {
  /** Underlying send implementation. Tests inject a fake. */
  send?: (input: SendTelegramMessageInput) => Promise<SendTelegramMessageResult>;
  /** Backoff delays in ms; length defines the retry count. */
  retryDelaysMs?: readonly number[];
  /** Sleep implementation. Tests inject a fake so no real waiting occurs. */
  sleep?: (ms: number) => Promise<void>;
  /** Upper bound applied to Telegram's retry_after. */
  maxRetryAfterMs?: number;
  /** Logger; defaults to the masking app logger. */
  logger?: Logger;
  /**
   * Extra structured context for logs (e.g. mailboxId, processedMessageId,
   * codeRef). MUST already be safe/masked — it is passed straight to the
   * logger, which also auto-masks sensitive keys.
   */
  logContext?: Record<string, unknown>;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Send a Telegram message with bounded retry/backoff.
 *
 * The returned outcome is always resolved (never rejected): callers inspect
 * `outcome.ok` to branch on success vs. exhausted/permanent failure.
 */
export async function sendTelegramMessageWithRetry(
  input: SendTelegramMessageInput,
  options: TelegramRetryOptions = {},
): Promise<TelegramSendOutcome> {
  const send = options.send ?? sendTelegramMessage;
  const retryDelaysMs = options.retryDelaysMs ?? DEFAULT_TELEGRAM_RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  const maxRetryAfterMs = options.maxRetryAfterMs ?? DEFAULT_MAX_RETRY_AFTER_MS;
  const logger = options.logger ?? createLogger();
  const baseContext = options.logContext ?? {};

  const maxAttempts = retryDelaysMs.length + 1;
  // Capture the chat id once so the result can prove it never changed across
  // retries — the caller resolves the mapping a single time, upstream.
  const chatId = input.chatId;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const result = await send(input);
      if (attempt > 1) {
        logger.info('Telegram send succeeded after retry', {
          ...baseContext,
          attempt,
        });
      }
      return {
        ok: true,
        attempts: attempt,
        telegramMessageId: result.messageId,
        chatId,
      };
    } catch (error: unknown) {
      lastError = error;
      const { failureReason, retryable, statusCode } =
        describeTelegramFailure(error);

      const hasAttemptsLeft = attempt < maxAttempts;
      const willRetry = retryable && hasAttemptsLeft;

      logger.warn('Telegram send attempt failed', {
        ...baseContext,
        attempt,
        maxAttempts,
        statusCode,
        failureReason,
        retryable,
        willRetry,
      });

      if (!willRetry) {
        return {
          ok: false,
          attempts: attempt,
          failureReason,
          retryable,
          statusCode,
          chatId,
        };
      }

      const backoffMs = retryDelaysMs[attempt - 1];
      const delayMs = resolveDelayMs({ error, backoffMs, maxRetryAfterMs });
      await sleep(delayMs);
    }
  }

  // Defensive fallback — the loop always returns inside, but this keeps the
  // function total if maxAttempts were ever miscomputed.
  const description = describeTelegramFailure(lastError);
  return {
    ok: false,
    attempts: maxAttempts,
    failureReason: description.failureReason,
    retryable: description.retryable,
    statusCode: description.statusCode,
    chatId,
  };
}

/** Safe metadata describing an exhausted/permanent Telegram delivery failure. */
export interface TelegramExhaustedFailure {
  chatId: string;
  attempts: number;
  failureReason: string;
  statusCode?: number;
}

export interface RetryingPortAlertOptions {
  /**
   * Called once when delivery is permanently exhausted, just before the adapter
   * throws. Injectable so tests can assert the alert fires without a network
   * send. Defaults to emitting a CRITICAL `TELEGRAM_SEND_FAILED` admin alert.
   * Must never throw — the adapter guards it regardless.
   */
  onExhaustedFailure?: (
    failure: TelegramExhaustedFailure,
  ) => void | Promise<void>;
  /**
   * Extra pre-masked context merged into the alert (e.g. mailboxId). Passed to
   * the logger/formatter, which also mask sensitive keys.
   */
  alertContext?: Record<string, unknown>;
}

/**
 * Adapter that exposes the retrying sender as a drop-in for the email
 * pipeline's `TelegramSendPort` (which expects `sendTelegramMessage` to resolve
 * on success and throw on failure). This lets production wiring add retry
 * without touching the pipeline body. On exhausted/permanent failure it throws
 * a `TelegramSendError` carrying the safe failure category + status code, so
 * the pipeline keeps recording its existing `FAILED_TELEGRAM_SEND` /
 * `TELEGRAM_SEND_FAILED` status unchanged.
 *
 * TASK-035: on exhausted/permanent failure it ALSO emits an admin alert (the
 * clearest critical-failure integration point) before throwing. Alerting is
 * fully guarded — it never throws, never blocks the original failure, and never
 * loops (the default alert sender reuses the same low-level `send` and performs
 * a single attempt, so a Telegram outage cannot trigger an alert storm).
 */
export function createRetryingTelegramSendPort(
  options: TelegramRetryOptions = {},
  alertOptions: RetryingPortAlertOptions = {},
): {
  sendTelegramMessage: (
    input: SendTelegramMessageInput,
  ) => Promise<SendTelegramMessageResult>;
} {
  const emitFailureAlert =
    alertOptions.onExhaustedFailure ??
    ((failure: TelegramExhaustedFailure): Promise<AlertDeliveryResult> =>
      sendAdminAlert(
        {
          type: 'TELEGRAM_SEND_FAILED',
          severity: 'CRITICAL',
          title: 'Telegram send failed after retries',
          context: {
            failedChatId: failure.chatId,
            attempts: failure.attempts,
            failureReason: failure.failureReason,
            statusCode: failure.statusCode,
            ...alertOptions.alertContext,
          },
        },
        // Reuse the same low-level send so unit tests never touch the network.
        { send: options.send },
      ));

  return {
    async sendTelegramMessage(
      input: SendTelegramMessageInput,
    ): Promise<SendTelegramMessageResult> {
      const outcome = await sendTelegramMessageWithRetry(input, options);
      if (outcome.ok) {
        return {
          ok: true,
          chatId: outcome.chatId,
          messageId: outcome.telegramMessageId,
        };
      }

      try {
        await emitFailureAlert({
          chatId: outcome.chatId,
          attempts: outcome.attempts,
          failureReason: outcome.failureReason,
          statusCode: outcome.statusCode,
        });
      } catch {
        // Alerting must never mask or replace the original delivery failure.
      }

      throw new TelegramSendError('telegram_api', 'Telegram send failed', {
        statusCode: outcome.statusCode,
      });
    },
  };
}
