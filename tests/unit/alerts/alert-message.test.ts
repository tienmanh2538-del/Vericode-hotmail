import { describe, it, expect } from 'vitest';
import { formatAlertMessage } from '@/services/alerts/alert-message';
import { TELEGRAM_TEXT_MAX } from '@/services/telegram/telegram-sender.service';
import type { Alert } from '@/services/alerts/alert.types';

const BOT_TOKEN = '123456789:AAFakeBotTokenThatLooksLikeARealTelegramToken';
const FULL_CODE = '654321';

describe('formatAlertMessage', () => {
  it('includes a severity label, the type, and sanitized context lines', () => {
    const alert: Alert = {
      type: 'TELEGRAM_SEND_FAILED',
      severity: 'CRITICAL',
      title: 'Telegram send failed after retries',
      context: { failedChatId: '-100123', attempts: 4, statusCode: 503 },
    };

    const msg = formatAlertMessage(alert);

    expect(msg).toContain('CRITICAL');
    expect(msg).toContain('Telegram send failed after retries');
    expect(msg).toContain('type: TELEGRAM_SEND_FAILED');
    expect(msg).toContain('failedChatId: -100123');
    expect(msg).toContain('attempts: 4');
    expect(msg).toContain('statusCode: 503');
  });

  it('never leaks secrets from the title or context', () => {
    const alert: Alert = {
      type: 'TELEGRAM_SEND_FAILED',
      severity: 'CRITICAL',
      title: `failed sending bot ${BOT_TOKEN}`,
      context: {
        telegramBotToken: BOT_TOKEN,
        verificationCode: FULL_CODE,
        emailBody: `Your code is ${FULL_CODE}`,
      },
    };

    const msg = formatAlertMessage(alert);

    expect(msg).not.toContain(BOT_TOKEN);
    expect(msg).not.toContain(FULL_CODE);
  });

  it('caps the message at the Telegram text limit', () => {
    const alert: Alert = {
      type: 'HEALTH_CRITICAL',
      severity: 'CRITICAL',
      title: 'x'.repeat(TELEGRAM_TEXT_MAX * 2),
    };

    const msg = formatAlertMessage(alert);
    expect(msg.length).toBeLessThanOrEqual(TELEGRAM_TEXT_MAX);
  });

  it('renders an alert with no context without throwing', () => {
    const alert: Alert = {
      type: 'DELTA_POLLING_FAILED',
      severity: 'WARNING',
      title: 'Delta polling failed',
    };

    const msg = formatAlertMessage(alert);
    expect(msg).toContain('WARNING');
    expect(msg).toContain('type: DELTA_POLLING_FAILED');
  });
});
