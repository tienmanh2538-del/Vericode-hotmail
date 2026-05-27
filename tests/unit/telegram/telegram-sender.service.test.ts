import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  sendTelegramMessage,
  TelegramSendError,
  TELEGRAM_TEXT_MAX,
} from '@/services/telegram/telegram-sender.service';

const FAKE_TOKEN = '123456:TEST_FAKE_TOKEN';

function stubFetchOk(messageId = 123) {
  const fetchMock = vi.fn(async () =>
    new Response(
      JSON.stringify({ ok: true, result: { message_id: messageId } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function stubFetchTelegramError(description = 'chat not found', status = 400) {
  const fetchMock = vi.fn(async () =>
    new Response(JSON.stringify({ ok: false, description }), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function stubFetchNetworkError() {
  const fetchMock = vi.fn(async () => {
    throw new Error('network down');
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

beforeEach(() => {
  vi.stubEnv('TELEGRAM_BOT_TOKEN', FAKE_TOKEN);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('sendTelegramMessage — success', () => {
  it('returns ok with messageId when Telegram responds ok:true', async () => {
    const fetchMock = stubFetchOk(999);

    const result = await sendTelegramMessage({
      chatId: '-1001234567890',
      text: 'hello',
    });

    expect(result).toEqual({
      ok: true,
      chatId: '-1001234567890',
      messageId: 999,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(calledUrl).toBe(`https://api.telegram.org/bot${FAKE_TOKEN}/sendMessage`);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: '-1001234567890',
      text: 'hello',
    });
  });

  it('trims chatId and text before sending', async () => {
    const fetchMock = stubFetchOk();

    await sendTelegramMessage({ chatId: '  @chan  ', text: '  hi  ' });
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({
      chat_id: '@chan',
      text: 'hi',
    });
  });
});

describe('sendTelegramMessage — validation', () => {
  it('rejects missing chatId without calling fetch', async () => {
    const fetchMock = stubFetchOk();
    await expect(
      sendTelegramMessage({ chatId: '', text: 'hi' }),
    ).rejects.toMatchObject({ kind: 'validation', field: 'chatId' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only chatId', async () => {
    stubFetchOk();
    await expect(
      sendTelegramMessage({ chatId: '   ', text: 'hi' }),
    ).rejects.toBeInstanceOf(TelegramSendError);
  });

  it('rejects empty text', async () => {
    const fetchMock = stubFetchOk();
    await expect(
      sendTelegramMessage({ chatId: '-100', text: '' }),
    ).rejects.toMatchObject({ kind: 'validation', field: 'text' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects text longer than 4096 chars', async () => {
    stubFetchOk();
    await expect(
      sendTelegramMessage({
        chatId: '-100',
        text: 'x'.repeat(TELEGRAM_TEXT_MAX + 1),
      }),
    ).rejects.toMatchObject({ kind: 'validation', field: 'text' });
  });
});

describe('sendTelegramMessage — config', () => {
  it('throws safe config error when TELEGRAM_BOT_TOKEN is missing', async () => {
    vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
    const fetchMock = stubFetchOk();

    try {
      await sendTelegramMessage({ chatId: '-100', text: 'hi' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramSendError);
      const e = err as TelegramSendError;
      expect(e.kind).toBe('config');
      expect(e.message).not.toContain(FAKE_TOKEN);
      expect(e.message).not.toMatch(/api\.telegram\.org/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('sendTelegramMessage — Telegram API failure', () => {
  it('throws safe telegram_api error when Telegram responds ok:false', async () => {
    stubFetchTelegramError('chat not found', 400);

    try {
      await sendTelegramMessage({ chatId: '-100', text: 'hi' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramSendError);
      const e = err as TelegramSendError;
      expect(e.kind).toBe('telegram_api');
      expect(e.message).toBe('Telegram send failed');
      expect(e.message).not.toContain(FAKE_TOKEN);
      expect(e.telegramDescription).toBe('chat not found');
    }
  });

  it('throws network error when fetch itself fails', async () => {
    stubFetchNetworkError();
    try {
      await sendTelegramMessage({ chatId: '-100', text: 'hi' });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TelegramSendError);
      const e = err as TelegramSendError;
      expect(e.kind).toBe('network');
      expect(e.message).not.toContain(FAKE_TOKEN);
    }
  });
});

describe('sendTelegramMessage — never leaks token', () => {
  it('error messages never include the bot token or full URL', async () => {
    stubFetchTelegramError('forbidden', 403);
    try {
      await sendTelegramMessage({ chatId: '-100', text: 'hi' });
    } catch (err) {
      const e = err as TelegramSendError;
      expect(e.message).not.toContain(FAKE_TOKEN);
      expect(e.message).not.toMatch(/bot\d+:/);
      expect(JSON.stringify(e)).not.toContain(FAKE_TOKEN);
    }
  });
});
