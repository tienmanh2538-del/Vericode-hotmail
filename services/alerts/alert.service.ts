// TASK-035 — Alert service.
//
// Delivers an operational Alert to the admin Telegram group when one is
// configured. This is the only place that knows alerts travel over Telegram.
//
// Contract (docs/SECURITY_RULES.md + TASK-035):
//   - Reads only env *values* (never `.env` / `.env.local` files). The bot
//     token is never read here directly — the underlying sender pulls it from
//     env at call time, so no token ever passes through this module.
//   - If TELEGRAM_ADMIN_ALERT_CHAT_ID is unset, it logs a safe warning and
//     returns a skip result — it NEVER throws and NEVER crashes the caller.
//   - It NEVER re-alerts on a failed alert send: an alert about a Telegram
//     outage must not trigger another Telegram send in a loop.
//   - The outgoing message is sanitized by the formatter before it is sent.

import { loadEnv, type EnvValues } from '@/lib/env';
import { createLogger, type Logger } from '@/lib/logger';
import {
  sendTelegramMessage,
  type SendTelegramMessageInput,
  type SendTelegramMessageResult,
} from '@/services/telegram/telegram-sender.service';
import type { Alert, AlertDeliveryResult } from './alert.types';
import { formatAlertMessage } from './alert-message';

/** Default anti-spam window: identical alerts inside this window are skipped. */
export const DEFAULT_ALERT_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * In-memory map of `cooldownKey → last-send timestamp (ms)`.
 *
 * Module-level on purpose: alert callers are spread across the app (retry port,
 * workers, …) and must share one cooldown window so a single failure that fans
 * out into many call sites still pages the admin only once per window. It is the
 * only mutable module state here; tests reset it via `__internal.resetCooldown`.
 */
const lastSentByKey = new Map<string, number>();

export interface SendAdminAlertOptions {
  /** Pre-resolved env values; defaults to `loadEnv().values`. */
  env?: EnvValues;
  /** Logger; defaults to the masking app logger. */
  logger?: Logger;
  /**
   * Underlying send implementation. Tests inject a fake; the retry-port
   * integration injects the same send port it already uses, so unit tests of
   * callers never touch the network. Defaults to `sendTelegramMessage` (a
   * single attempt — the alert path deliberately does not retry, to stay
   * bounded and loop-free).
   */
  send?: (input: SendTelegramMessageInput) => Promise<SendTelegramMessageResult>;
  /**
   * Clock used for the cooldown window. Injectable so tests advance time
   * deterministically instead of waiting. Defaults to `Date.now`.
   */
  now?: () => number;
  /** Anti-spam window in ms. Defaults to {@link DEFAULT_ALERT_COOLDOWN_MS}. */
  cooldownMs?: number;
}

/**
 * Stable cooldown key for an alert. Built from operational fields that identify
 * "the same failure", never from secret-shaped material:
 *   - with a mailboxId: `type | severity | mailboxId | source`
 *   - otherwise:        `type | severity | source | title`
 * `mailboxId` / `source` are read from the alert context when present.
 */
function buildCooldownKey(alert: Alert): string {
  const context = alert.context ?? {};
  const mailboxId =
    typeof context.mailboxId === 'string' ? context.mailboxId : undefined;
  const source = typeof context.source === 'string' ? context.source : '';

  return mailboxId
    ? `${alert.type}|${alert.severity}|${mailboxId}|${source}`
    : `${alert.type}|${alert.severity}|${source}|${alert.title}`;
}

/**
 * Send an operational alert to the admin Telegram group.
 *
 * Always resolves (never rejects): callers inspect the discriminated result.
 */
export async function sendAdminAlert(
  alert: Alert,
  options: SendAdminAlertOptions = {},
): Promise<AlertDeliveryResult> {
  const logger = options.logger ?? createLogger();
  const env = options.env ?? loadEnv().values;

  const adminChatId = env.TELEGRAM_ADMIN_ALERT_CHAT_ID;
  if (!adminChatId) {
    // Expected in local/dev/CI where no admin channel is wired — warn, don't crash.
    logger.warn(
      'Admin alert skipped: TELEGRAM_ADMIN_ALERT_CHAT_ID is not configured',
      { alertType: alert.type, severity: alert.severity },
    );
    return { delivered: false, reason: 'not_configured' };
  }

  if (!env.TELEGRAM_BOT_TOKEN) {
    logger.warn('Admin alert skipped: Telegram bot token is not configured', {
      alertType: alert.type,
      severity: alert.severity,
    });
    return { delivered: false, reason: 'no_bot_token' };
  }

  // Anti-spam: drop an identical alert seen again inside the cooldown window.
  // Checked here (after config gates, before any send) so a recurring failure
  // pages the admin once per window instead of on every call. The key carries
  // no secret material and the debug log goes through the masking logger.
  const now = options.now ?? Date.now;
  const cooldownMs = options.cooldownMs ?? DEFAULT_ALERT_COOLDOWN_MS;
  const cooldownKey = buildCooldownKey(alert);
  const lastSentAt = lastSentByKey.get(cooldownKey);
  const currentTime = now();

  if (lastSentAt !== undefined && currentTime - lastSentAt < cooldownMs) {
    logger.debug('Admin alert skipped: within cooldown window', {
      alertType: alert.type,
      severity: alert.severity,
    });
    return { delivered: false, reason: 'cooldown' };
  }

  const text = formatAlertMessage(alert);
  const send = options.send ?? sendTelegramMessage;

  // Record the attempt before sending: even a failed send counts toward the
  // cooldown so a Telegram outage cannot turn into an alert storm.
  lastSentByKey.set(cooldownKey, currentTime);

  try {
    const result = await send({ chatId: adminChatId, text });
    logger.info('Admin alert delivered', {
      alertType: alert.type,
      severity: alert.severity,
    });
    return { delivered: true, chatId: result.chatId };
  } catch (error) {
    // Swallow: alerting must never throw into the caller, and we must NOT
    // recursively alert about a failed alert send.
    logger.warn('Admin alert delivery failed', {
      alertType: alert.type,
      severity: alert.severity,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    return { delivered: false, reason: 'send_failed' };
  }
}

// ---------------------------------------------------------------------------
// Test-facing internals (not a public API — mirrors the project convention)
// ---------------------------------------------------------------------------

export const __internal = {
  DEFAULT_ALERT_COOLDOWN_MS,
  buildCooldownKey,
  /** Clear the in-memory cooldown so tests start from a known state. */
  resetCooldown(): void {
    lastSentByKey.clear();
  },
};
