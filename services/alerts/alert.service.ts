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

  const text = formatAlertMessage(alert);
  const send = options.send ?? sendTelegramMessage;

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
