import { describe, it, expect, vi, beforeEach } from 'vitest';
import { sendAdminAlert, __internal } from '@/services/alerts/alert.service';
import type { Alert } from '@/services/alerts/alert.types';
import { createLogger } from '@/lib/logger';
import { loadEnv, type EnvValues } from '@/lib/env';
import {
  TelegramSendError,
  type SendTelegramMessageInput,
  type SendTelegramMessageResult,
} from '@/services/telegram/telegram-sender.service';

type SendFn = (
  input: SendTelegramMessageInput,
) => Promise<SendTelegramMessageResult>;

const ADMIN_CHAT_ID = '-1009998887776';
const BOT_TOKEN = '123456789:AAFakeBotToken';

function envWith(overrides: Partial<EnvValues>): EnvValues {
  return { ...loadEnv({}).values, ...overrides };
}

const CRITICAL_ALERT: Alert = {
  type: 'TELEGRAM_SEND_FAILED',
  severity: 'CRITICAL',
  title: 'Telegram send failed after retries',
  context: { failedChatId: '-100123', attempts: 4, statusCode: 503 },
};

function okSend(): SendTelegramMessageResult {
  return { ok: true, chatId: ADMIN_CHAT_ID, messageId: 42 };
}

// Cooldown is module-level shared state — reset before every test so cases stay
// isolated and the existing assertions keep their original meaning.
beforeEach(() => {
  __internal.resetCooldown();
});

describe('sendAdminAlert — not configured', () => {
  it('skips (no send) and warns when the admin chat id is missing', async () => {
    const send = vi.fn(async () => okSend());
    const env = envWith({
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
      TELEGRAM_ADMIN_ALERT_CHAT_ID: undefined,
    });

    const result = await sendAdminAlert(CRITICAL_ALERT, { env, send });

    expect(result).toEqual({ delivered: false, reason: 'not_configured' });
    expect(send).not.toHaveBeenCalled();
  });

  it('does not throw — the caller never crashes when alerts are unconfigured', async () => {
    const env = envWith({ TELEGRAM_ADMIN_ALERT_CHAT_ID: undefined });
    await expect(sendAdminAlert(CRITICAL_ALERT, { env })).resolves.toEqual({
      delivered: false,
      reason: 'not_configured',
    });
  });
});

describe('sendAdminAlert — missing bot token', () => {
  it('skips with no_bot_token when the chat id is set but no token', async () => {
    const send = vi.fn(async () => okSend());
    const env = envWith({
      TELEGRAM_ADMIN_ALERT_CHAT_ID: ADMIN_CHAT_ID,
      TELEGRAM_BOT_TOKEN: undefined,
    });

    const result = await sendAdminAlert(CRITICAL_ALERT, { env, send });

    expect(result).toEqual({ delivered: false, reason: 'no_bot_token' });
    expect(send).not.toHaveBeenCalled();
  });
});

describe('sendAdminAlert — delivery', () => {
  it('sends a sanitized message to the admin chat id when configured', async () => {
    const send = vi.fn<SendFn>(async () => okSend());
    const env = envWith({
      TELEGRAM_ADMIN_ALERT_CHAT_ID: ADMIN_CHAT_ID,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    });

    const result = await sendAdminAlert(CRITICAL_ALERT, { env, send });

    expect(result).toEqual({ delivered: true, chatId: ADMIN_CHAT_ID });
    expect(send).toHaveBeenCalledTimes(1);
    const arg = send.mock.calls[0][0] as SendTelegramMessageInput;
    expect(arg.chatId).toBe(ADMIN_CHAT_ID);
    expect(arg.text).toContain('CRITICAL');
    expect(arg.text).toContain('type: TELEGRAM_SEND_FAILED');
  });

  it('returns send_failed and does not throw when the send rejects', async () => {
    const send = vi.fn(async () => {
      throw new TelegramSendError('telegram_api', 'Telegram send failed', {
        statusCode: 500,
      });
    });
    const env = envWith({
      TELEGRAM_ADMIN_ALERT_CHAT_ID: ADMIN_CHAT_ID,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    });

    const result = await sendAdminAlert(CRITICAL_ALERT, { env, send });

    expect(result).toEqual({ delivered: false, reason: 'send_failed' });
    expect(send).toHaveBeenCalledTimes(1); // single attempt — no retry loop
  });

  it('never logs secrets carried in the alert context', async () => {
    const lines: unknown[] = [];
    const sink = {
      debug: (...a: unknown[]) => lines.push(...a),
      info: (...a: unknown[]) => lines.push(...a),
      warn: (...a: unknown[]) => lines.push(...a),
      error: (...a: unknown[]) => lines.push(...a),
    };
    const logger = createLogger({ level: 'debug', sink });
    const send = vi.fn(async () => okSend());
    const env = envWith({
      TELEGRAM_ADMIN_ALERT_CHAT_ID: ADMIN_CHAT_ID,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    });

    await sendAdminAlert(
      {
        type: 'HEALTH_CRITICAL',
        severity: 'CRITICAL',
        title: 'health critical',
        context: { accessToken: 'ya29.superSecretAccessTokenValueLong' },
      },
      { env, send, logger },
    );

    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain('ya29.superSecretAccessTokenValueLong');
  });
});

describe('sendAdminAlert — cooldown / anti-spam', () => {
  const configuredEnv = () =>
    envWith({
      TELEGRAM_ADMIN_ALERT_CHAT_ID: ADMIN_CHAT_ID,
      TELEGRAM_BOT_TOKEN: BOT_TOKEN,
    });

  it('sends the first alert (telegram called once)', async () => {
    const send = vi.fn<SendFn>(async () => okSend());
    const now = () => 1_000;

    const result = await sendAdminAlert(CRITICAL_ALERT, {
      env: configuredEnv(),
      send,
      now,
    });

    expect(result).toEqual({ delivered: true, chatId: ADMIN_CHAT_ID });
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('skips a repeat of the same alert inside the 5-minute window', async () => {
    const send = vi.fn<SendFn>(async () => okSend());
    let currentTime = 1_000;
    const now = () => currentTime;
    const env = configuredEnv();

    const first = await sendAdminAlert(CRITICAL_ALERT, { env, send, now });
    expect(first).toEqual({ delivered: true, chatId: ADMIN_CHAT_ID });

    // 4m59s later — still inside the default 5-minute cooldown.
    currentTime += 5 * 60 * 1000 - 1;
    const second = await sendAdminAlert(CRITICAL_ALERT, { env, send, now });

    expect(second).toEqual({ delivered: false, reason: 'cooldown' });
    expect(send).toHaveBeenCalledTimes(1); // not sent again
  });

  it('sends the same alert again after the window elapses', async () => {
    const send = vi.fn<SendFn>(async () => okSend());
    let currentTime = 1_000;
    const now = () => currentTime;
    const env = configuredEnv();

    await sendAdminAlert(CRITICAL_ALERT, { env, send, now });

    // Past the 5-minute window — a fresh page is allowed.
    currentTime += 5 * 60 * 1000 + 1;
    const result = await sendAdminAlert(CRITICAL_ALERT, { env, send, now });

    expect(result).toEqual({ delivered: true, chatId: ADMIN_CHAT_ID });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('still sends a different alert key during another alert’s cooldown', async () => {
    const send = vi.fn<SendFn>(async () => okSend());
    const now = () => 1_000;
    const env = configuredEnv();

    await sendAdminAlert(CRITICAL_ALERT, { env, send, now });

    const otherAlert: Alert = {
      type: 'SUBSCRIPTION_RENEWAL_FAILED',
      severity: 'WARNING',
      title: 'Subscription renewal failed',
      context: { mailboxId: 'mbx-123' },
    };
    const result = await sendAdminAlert(otherAlert, { env, send, now });

    expect(result).toEqual({ delivered: true, chatId: ADMIN_CHAT_ID });
    expect(send).toHaveBeenCalledTimes(2); // distinct key — not throttled
  });

  it('does not leak secrets when skipping due to cooldown', async () => {
    const lines: unknown[] = [];
    const sink = {
      debug: (...a: unknown[]) => lines.push(...a),
      info: (...a: unknown[]) => lines.push(...a),
      warn: (...a: unknown[]) => lines.push(...a),
      error: (...a: unknown[]) => lines.push(...a),
    };
    const logger = createLogger({ level: 'debug', sink });
    const send = vi.fn<SendFn>(async () => okSend());
    const now = () => 1_000;
    const env = configuredEnv();

    const secretAlert: Alert = {
      type: 'HEALTH_CRITICAL',
      severity: 'CRITICAL',
      title: 'health critical',
      context: { accessToken: 'ya29.superSecretAccessTokenValueLong' },
    };

    await sendAdminAlert(secretAlert, { env, send, now, logger });
    // Second call hits the cooldown branch and logs a debug skip line.
    const skipped = await sendAdminAlert(secretAlert, { env, send, now, logger });

    expect(skipped).toEqual({ delivered: false, reason: 'cooldown' });
    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain('ya29.superSecretAccessTokenValueLong');
  });
});
