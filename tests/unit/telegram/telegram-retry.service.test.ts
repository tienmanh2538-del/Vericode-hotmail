import { describe, it, expect, vi } from 'vitest';
import {
  sendTelegramMessageWithRetry,
  createRetryingTelegramSendPort,
  DEFAULT_TELEGRAM_RETRY_DELAYS_MS,
} from '@/services/telegram/telegram-retry.service';
import {
  TelegramSendError,
  type SendTelegramMessageInput,
  type SendTelegramMessageResult,
} from '@/services/telegram/telegram-sender.service';
import { createLogger } from '@/lib/logger';

type SendFn = (
  input: SendTelegramMessageInput,
) => Promise<SendTelegramMessageResult>;

const CHAT_ID = '-1001234567890';
const FAKE_TOKEN = '123456:TEST_FAKE_TOKEN';
const FULL_CODE = '654321';

// Small delays keep any accidental real sleep instant; tests also inject a fake
// sleep so no waiting happens at all.
const FAST_DELAYS = [1, 1, 1];

function okResult(messageId = 999): SendTelegramMessageResult {
  return { ok: true, chatId: CHAT_ID, messageId };
}

function apiError(statusCode: number, retryAfterSeconds?: number): TelegramSendError {
  return new TelegramSendError('telegram_api', 'Telegram send failed', {
    statusCode,
    retryAfterSeconds,
  });
}

function networkError(): TelegramSendError {
  return new TelegramSendError('network', 'Telegram request failed');
}

/** Records every delay it was asked to wait, but never actually waits. */
function makeFakeSleep() {
  const delays: number[] = [];
  const sleep = vi.fn(async (ms: number) => {
    delays.push(ms);
  });
  return { sleep, delays };
}

describe('sendTelegramMessageWithRetry — success on first attempt', () => {
  it('returns ok with attempts=1 and never sleeps (6.1)', async () => {
    const send = vi.fn(async () => okResult(111));
    const { sleep, delays } = makeFakeSleep();

    const outcome = await sendTelegramMessageWithRetry(
      { chatId: CHAT_ID, text: 'hello' },
      { send, sleep, retryDelaysMs: FAST_DELAYS },
    );

    expect(outcome).toEqual({
      ok: true,
      attempts: 1,
      telegramMessageId: 111,
      chatId: CHAT_ID,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(delays).toEqual([]);
  });
});

describe('sendTelegramMessageWithRetry — retryable then success', () => {
  it('retries after HTTP 500 and succeeds (6.2)', async () => {
    const send = vi
      .fn<SendFn>()
      .mockRejectedValueOnce(apiError(500))
      .mockResolvedValueOnce(okResult(222));
    const { sleep } = makeFakeSleep();

    const outcome = await sendTelegramMessageWithRetry(
      { chatId: CHAT_ID, text: 'hello' },
      { send, sleep, retryDelaysMs: FAST_DELAYS },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.attempts).toBe(2);
    expect(send).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
  });

  it('retries on HTTP 503 then succeeds', async () => {
    const send = vi
      .fn<SendFn>()
      .mockRejectedValueOnce(apiError(503))
      .mockResolvedValueOnce(okResult());
    const { sleep } = makeFakeSleep();

    const outcome = await sendTelegramMessageWithRetry(
      { chatId: CHAT_ID, text: 'hi' },
      { send, sleep, retryDelaysMs: FAST_DELAYS },
    );

    expect(outcome.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('retries on a network error then succeeds', async () => {
    const send = vi
      .fn<SendFn>()
      .mockRejectedValueOnce(networkError())
      .mockResolvedValueOnce(okResult());
    const { sleep } = makeFakeSleep();

    const outcome = await sendTelegramMessageWithRetry(
      { chatId: CHAT_ID, text: 'hi' },
      { send, sleep, retryDelaysMs: FAST_DELAYS },
    );

    expect(outcome.ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe('sendTelegramMessageWithRetry — 429 retry_after', () => {
  it('honours retry_after and succeeds on next attempt (6.3)', async () => {
    const send = vi
      .fn<SendFn>()
      .mockRejectedValueOnce(apiError(429, 3)) // retry_after = 3 seconds
      .mockResolvedValueOnce(okResult(333));
    const { sleep, delays } = makeFakeSleep();

    const outcome = await sendTelegramMessageWithRetry(
      { chatId: CHAT_ID, text: 'hi' },
      { send, sleep, retryDelaysMs: FAST_DELAYS },
    );

    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(outcome.attempts).toBe(2);
    // Used retry_after (3000ms) rather than the configured backoff (1ms).
    expect(delays).toEqual([3000]);
  });

  it('caps a hostile retry_after at maxRetryAfterMs', async () => {
    const send = vi
      .fn<SendFn>()
      .mockRejectedValueOnce(apiError(429, 99999)) // ~27 hours
      .mockResolvedValueOnce(okResult());
    const { sleep, delays } = makeFakeSleep();

    await sendTelegramMessageWithRetry(
      { chatId: CHAT_ID, text: 'hi' },
      { send, sleep, retryDelaysMs: FAST_DELAYS, maxRetryAfterMs: 60_000 },
    );

    expect(delays).toEqual([60_000]);
  });
});

describe('sendTelegramMessageWithRetry — non-retryable errors', () => {
  it('does not retry on HTTP 400 (6.4)', async () => {
    const send = vi.fn(async () => {
      throw apiError(400);
    });
    const { sleep } = makeFakeSleep();

    const outcome = await sendTelegramMessageWithRetry(
      { chatId: CHAT_ID, text: 'hi' },
      { send, sleep, retryDelaysMs: FAST_DELAYS },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.attempts).toBe(1);
      expect(outcome.retryable).toBe(false);
      expect(outcome.statusCode).toBe(400);
    }
    expect(send).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it.each([401, 403, 404])(
    'does not retry on HTTP %i (6.5)',
    async (status) => {
      const send = vi.fn(async () => {
        throw apiError(status);
      });
      const { sleep } = makeFakeSleep();

      const outcome = await sendTelegramMessageWithRetry(
        { chatId: CHAT_ID, text: 'hi' },
        { send, sleep, retryDelaysMs: FAST_DELAYS },
      );

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.attempts).toBe(1);
        expect(outcome.retryable).toBe(false);
      }
      expect(send).toHaveBeenCalledTimes(1);
      expect(sleep).not.toHaveBeenCalled();
    },
  );
});

describe('sendTelegramMessageWithRetry — retries exhausted', () => {
  it('returns a clear failure after 4 attempts of HTTP 503 (6.6)', async () => {
    const send = vi.fn(async () => {
      throw apiError(503);
    });
    const { sleep, delays } = makeFakeSleep();

    const outcome = await sendTelegramMessageWithRetry(
      { chatId: CHAT_ID, text: 'hi' },
      { send, sleep, retryDelaysMs: FAST_DELAYS },
    );

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.attempts).toBe(4); // 1 initial + 3 retries
      expect(outcome.retryable).toBe(true);
      expect(outcome.statusCode).toBe(503);
      expect(outcome.failureReason).toContain('503');
    }
    expect(send).toHaveBeenCalledTimes(4);
    expect(delays).toHaveLength(3); // slept before each of the 3 retries
  });

  it('uses the default 5s/15s/30s schedule when delays are not overridden', async () => {
    const send = vi.fn(async () => {
      throw apiError(500);
    });
    const { sleep, delays } = makeFakeSleep();

    const outcome = await sendTelegramMessageWithRetry(
      { chatId: CHAT_ID, text: 'hi' },
      { send, sleep }, // no retryDelaysMs override
    );

    expect(outcome.ok).toBe(false);
    expect(delays).toEqual([...DEFAULT_TELEGRAM_RETRY_DELAYS_MS]);
    expect(delays).toEqual([5_000, 15_000, 30_000]);
  });
});

describe('sendTelegramMessageWithRetry — chat id stability', () => {
  it('uses the same chatId for every attempt and never refetches (6.7)', async () => {
    const seenChatIds: string[] = [];
    const send = vi.fn(async (input: { chatId: string }) => {
      seenChatIds.push(input.chatId);
      if (seenChatIds.length < 3) throw apiError(503);
      return okResult();
    });
    const { sleep } = makeFakeSleep();

    const outcome = await sendTelegramMessageWithRetry(
      { chatId: CHAT_ID, text: 'hi' },
      { send, sleep, retryDelaysMs: FAST_DELAYS },
    );

    expect(outcome.ok).toBe(true);
    expect(seenChatIds).toEqual([CHAT_ID, CHAT_ID, CHAT_ID]);
    if (outcome.ok) expect(outcome.chatId).toBe(CHAT_ID);
  });
});

describe('sendTelegramMessageWithRetry — safe logging (6.8)', () => {
  it('never logs the bot token, full code, or email body', async () => {
    const lines: unknown[] = [];
    const sink = {
      debug: (...args: unknown[]) => lines.push(...args),
      info: (...args: unknown[]) => lines.push(...args),
      warn: (...args: unknown[]) => lines.push(...args),
      error: (...args: unknown[]) => lines.push(...args),
    };
    const logger = createLogger({ level: 'debug', sink });

    const send = vi.fn(async () => {
      throw apiError(503);
    });
    const { sleep } = makeFakeSleep();

    await sendTelegramMessageWithRetry(
      { chatId: CHAT_ID, text: `Your Facebook code is ${FULL_CODE}` },
      {
        send,
        sleep,
        retryDelaysMs: FAST_DELAYS,
        logger,
        logContext: {
          mailboxId: 'mbx_1',
          processedMessageId: 'pm_1',
          codeRef: 'sha256:abcdef012345',
          // Sensitive keys must be masked by the logger, not leaked verbatim.
          token: FAKE_TOKEN,
          verificationCode: FULL_CODE,
        },
      },
    );

    const serialized = JSON.stringify(lines);
    expect(serialized).not.toContain(FAKE_TOKEN);
    expect(serialized).not.toContain(FULL_CODE);
    expect(serialized).not.toContain('Your Facebook code is');
    // Safe metadata is still present for operability.
    expect(serialized).toContain('mbx_1');
    expect(serialized).toContain('503');
  });
});

describe('createRetryingTelegramSendPort — pipeline adapter', () => {
  it('resolves with a SendTelegramMessageResult on success', async () => {
    const send = vi.fn(async () => okResult(777));
    const { sleep } = makeFakeSleep();

    const port = createRetryingTelegramSendPort({
      send,
      sleep,
      retryDelaysMs: FAST_DELAYS,
    });
    const result = await port.sendTelegramMessage({
      chatId: CHAT_ID,
      text: 'hi',
    });

    expect(result).toEqual({ ok: true, chatId: CHAT_ID, messageId: 777 });
  });

  it('throws a token-free TelegramSendError once retries are exhausted', async () => {
    const send = vi.fn(async () => {
      throw apiError(503);
    });
    const { sleep } = makeFakeSleep();

    const port = createRetryingTelegramSendPort({
      send,
      sleep,
      retryDelaysMs: FAST_DELAYS,
    });

    await expect(
      port.sendTelegramMessage({ chatId: CHAT_ID, text: 'hi' }),
    ).rejects.toMatchObject({
      name: 'TelegramSendError',
      kind: 'telegram_api',
      statusCode: 503,
    });
  });

  it('emits an exhausted-failure alert before throwing (TASK-035)', async () => {
    const send = vi.fn(async () => {
      throw apiError(503);
    });
    const { sleep } = makeFakeSleep();
    const onExhaustedFailure = vi.fn();

    const port = createRetryingTelegramSendPort(
      { send, sleep, retryDelaysMs: FAST_DELAYS },
      { onExhaustedFailure, alertContext: { mailboxId: 'mbx_1' } },
    );

    await expect(
      port.sendTelegramMessage({ chatId: CHAT_ID, text: 'hi' }),
    ).rejects.toMatchObject({ name: 'TelegramSendError', statusCode: 503 });

    expect(onExhaustedFailure).toHaveBeenCalledTimes(1);
    expect(onExhaustedFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        chatId: CHAT_ID,
        attempts: 4,
        statusCode: 503,
      }),
    );
  });

  it('does not emit an alert on success', async () => {
    const send = vi.fn(async () => okResult());
    const { sleep } = makeFakeSleep();
    const onExhaustedFailure = vi.fn();

    const port = createRetryingTelegramSendPort(
      { send, sleep, retryDelaysMs: FAST_DELAYS },
      { onExhaustedFailure },
    );

    await port.sendTelegramMessage({ chatId: CHAT_ID, text: 'hi' });
    expect(onExhaustedFailure).not.toHaveBeenCalled();
  });

  it('still throws even if the alert hook itself throws', async () => {
    const send = vi.fn(async () => {
      throw apiError(503);
    });
    const { sleep } = makeFakeSleep();
    const onExhaustedFailure = vi.fn(() => {
      throw new Error('alert backend down');
    });

    const port = createRetryingTelegramSendPort(
      { send, sleep, retryDelaysMs: FAST_DELAYS },
      { onExhaustedFailure },
    );

    await expect(
      port.sendTelegramMessage({ chatId: CHAT_ID, text: 'hi' }),
    ).rejects.toMatchObject({ name: 'TelegramSendError', statusCode: 503 });
    expect(onExhaustedFailure).toHaveBeenCalledTimes(1);
  });
});
