import { describe, it, expect } from 'vitest';
import {
  sanitizeAlertText,
  sanitizeAlertContext,
} from '@/services/alerts/alert-sanitizer';

const ACCESS_TOKEN = 'ya29.aAbBcCdDeEfFgGhHiIjJkKlLmMnNoOpPqQrRsStTuUvV';
const REFRESH_TOKEN = '1//refreshTokenValueThatIsDefinitelyLongerThanThirtyTwoChars';
const BOT_TOKEN = '123456789:AAFakeBotTokenThatLooksLikeARealTelegramToken';
const FULL_CODE = '654321';

describe('sanitizeAlertText', () => {
  it('redacts key=value secret pairs', () => {
    const out = sanitizeAlertText('client_secret=superSecretValue and ok');
    expect(out).not.toContain('superSecretValue');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts long token-shaped runs', () => {
    expect(sanitizeAlertText(`token is ${ACCESS_TOKEN}`)).not.toContain(
      ACCESS_TOKEN,
    );
  });

  it('returns an empty string for nullish input', () => {
    // @ts-expect-error — exercising defensive runtime behavior
    expect(sanitizeAlertText(undefined)).toBe('');
    // @ts-expect-error — exercising defensive runtime behavior
    expect(sanitizeAlertText(null)).toBe('');
  });

  it('leaves safe operational text untouched', () => {
    expect(sanitizeAlertText('mailbox mbx_1 failed after 4 attempts')).toBe(
      'mailbox mbx_1 failed after 4 attempts',
    );
  });
});

describe('sanitizeAlertContext', () => {
  it('returns an empty object for undefined context', () => {
    expect(sanitizeAlertContext(undefined)).toEqual({});
  });

  it('masks values under sensitive keys', () => {
    const scrubbed = sanitizeAlertContext({
      accessToken: ACCESS_TOKEN,
      refreshToken: REFRESH_TOKEN,
      clientSecret: 'aShortishSecret',
      telegramBotToken: BOT_TOKEN,
      password: 'hunter2hunter2',
      verificationCode: FULL_CODE,
    });

    const serialized = JSON.stringify(scrubbed);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(REFRESH_TOKEN);
    expect(serialized).not.toContain('aShortishSecret');
    expect(serialized).not.toContain(BOT_TOKEN);
    expect(serialized).not.toContain('hunter2hunter2');
    expect(serialized).not.toContain(FULL_CODE);
  });

  it('keeps safe operational fields intact', () => {
    const scrubbed = sanitizeAlertContext({
      mailboxId: 'mbx_1',
      attempts: 4,
      statusCode: 503,
      failureReason: 'telegram_api_503',
    });

    expect(scrubbed).toEqual({
      mailboxId: 'mbx_1',
      attempts: 4,
      statusCode: 503,
      failureReason: 'telegram_api_503',
    });
  });

  it('omits email-body fields entirely (never previews raw bodies)', () => {
    const body = `Your Facebook code is ${FULL_CODE}. ${'x'.repeat(200)}`;
    const scrubbed = sanitizeAlertContext({ emailBody: body });
    expect(scrubbed).toEqual({ emailBody: '[omitted]' });
    expect(JSON.stringify(scrubbed)).not.toContain(FULL_CODE);
  });

  it('does not mutate the input object (immutability)', () => {
    const input = { accessToken: ACCESS_TOKEN, mailboxId: 'mbx_1' };
    sanitizeAlertContext(input);
    expect(input.accessToken).toBe(ACCESS_TOKEN);
  });
});
