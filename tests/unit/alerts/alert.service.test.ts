import { describe, it, expect, vi } from 'vitest';
import { sendAdminAlert } from '@/services/alerts/alert.service';
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
