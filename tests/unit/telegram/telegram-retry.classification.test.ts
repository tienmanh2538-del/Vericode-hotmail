import { describe, it, expect } from 'vitest';

import { createRetryingTelegramSendPort } from '@/services/telegram/telegram-retry.service';
import { TelegramSendError } from '@/services/telegram/telegram-sender.service';

// TASK-090 (DF-90-4) — the retrying send port must carry the retryability
// verdict across its throw boundary so the pipeline can split permanent vs
// retryable delivery failures. Classification itself (telegram-error.ts,
// TASK-033) is unchanged and already covered by telegram-retry.service.test.ts;
// this file only pins the NEW `retryable` field on the re-thrown error.
//
// All inputs are synthetic; no real chat id or bot token appears.

const INPUT = { chatId: '-1009999999999', text: 'test message' };
const instantSleep = async () => {};
const noAlert = { onExhaustedFailure: () => {} };

function apiError(statusCode: number, retryAfterSeconds?: number) {
  return new TelegramSendError('telegram_api', 'Telegram send failed', {
    statusCode,
    retryAfterSeconds,
  });
}

async function thrownFromPort(sendError: TelegramSendError) {
  const port = createRetryingTelegramSendPort(
    {
      send: async () => {
        throw sendError;
      },
      sleep: instantSleep,
      retryDelaysMs: [1, 1, 1],
    },
    noAlert,
  );
  return port.sendTelegramMessage(INPUT).then(
    () => null,
    (err: unknown) => err,
  );
}

describe('TASK-090 — retry port attaches the retryability verdict', () => {
  it('HTTP 400 (permanent 4xx) → retryable === false, no internal retry', async () => {
    let calls = 0;
    const port = createRetryingTelegramSendPort(
      {
        send: async () => {
          calls += 1;
          throw apiError(400);
        },
        sleep: instantSleep,
        retryDelaysMs: [1, 1, 1],
      },
      noAlert,
    );
    const err = (await port
      .sendTelegramMessage(INPUT)
      .catch((e: unknown) => e)) as TelegramSendError;

    expect(calls).toBe(1); // permanent → no pointless internal retries
    expect(err).toBeInstanceOf(TelegramSendError);
    expect(err.retryable).toBe(false);
    expect(err.statusCode).toBe(400);
  });

  it('HTTP 403 and 404 → retryable === false', async () => {
    for (const status of [403, 404]) {
      const err = (await thrownFromPort(apiError(status))) as TelegramSendError;
      expect(err.retryable).toBe(false);
    }
  });

  it('HTTP 429 is NOT permanent just because it is a 4xx: retryable === true after exhaustion', async () => {
    const err = (await thrownFromPort(apiError(429, 0))) as TelegramSendError;
    expect(err).toBeInstanceOf(TelegramSendError);
    expect(err.retryable).toBe(true);
    expect(err.statusCode).toBe(429);
  });

  it('HTTP 5xx → retryable === true after exhaustion', async () => {
    const err = (await thrownFromPort(apiError(502))) as TelegramSendError;
    expect(err.retryable).toBe(true);
  });

  it('network failure → retryable === true after exhaustion', async () => {
    const err = (await thrownFromPort(
      new TelegramSendError('network', 'Telegram request failed'),
    )) as TelegramSendError;
    expect(err.retryable).toBe(true);
  });

  it('validation error → retryable === false (retrying the same broken payload cannot help)', async () => {
    const err = (await thrownFromPort(
      new TelegramSendError('validation', 'text is required', { field: 'text' }),
    )) as TelegramSendError;
    expect(err.retryable).toBe(false);
  });
});
