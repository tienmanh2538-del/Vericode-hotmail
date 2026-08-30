import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import {
  sendTelegramMessage,
  TelegramSendError,
  TELEGRAM_HTTP_TIMEOUT_MS,
} from '@/services/telegram/telegram-sender.service';
import {
  isRetryableTelegramError,
  describeTelegramFailure,
} from '@/services/telegram/telegram-error';
import {
  DEFAULT_TELEGRAM_RETRY_DELAYS_MS,
  DEFAULT_MAX_RETRY_AFTER_MS,
} from '@/services/telegram/telegram-retry.service';
import { DELIVERY_LEASE_MS } from '@/services/email/delivery-ownership-policy';
import { DEFAULT_DESTINATION_MAX_WAIT_MS } from '@/services/queue/destination-throttle';
import { DEFAULT_GLOBAL_SEND_MAX_WAIT_MS } from '@/services/queue/global-send-throttle';

// TASK-090 correction — explicit finite Telegram HTTP timeout + real
// cancellation, and the delivery-lease budget inequality pinned against the
// REAL constants. All identifiers are synthetic; the bot token is a fake.

const FAKE_TOKEN = '123456:TEST_FAKE_TOKEN';
const INPUT = { chatId: '-1009999999999', text: 'test message' };

beforeEach(() => {
  vi.stubEnv('TELEGRAM_BOT_TOKEN', FAKE_TOKEN);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/**
 * A fetch stub that NEVER resolves on its own — it only settles when the
 * AbortSignal fires. This proves the timeout performs a REAL cancellation
 * (the underlying request promise settles), not a Promise.race that leaves
 * the old promise running in the background.
 */
function stubHangingFetch() {
  const state = { aborted: false, sawSignal: false };
  const fetchMock = vi.fn(
    (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        if (signal) {
          state.sawSignal = true;
          signal.addEventListener('abort', () => {
            state.aborted = true;
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, state };
}

describe('sendTelegramMessage — finite timeout + real cancellation', () => {
  it('a hung Telegram request is aborted at TELEGRAM_HTTP_TIMEOUT_MS and surfaces as a RETRYABLE network error', async () => {
    const { state } = stubHangingFetch();

    const pending = sendTelegramMessage(INPUT);
    const assertion = expect(pending).rejects.toBeInstanceOf(TelegramSendError);
    await vi.advanceTimersByTimeAsync(TELEGRAM_HTTP_TIMEOUT_MS + 1);
    await assertion;

    // The AbortSignal genuinely fired: the underlying promise settled.
    expect(state.sawSignal).toBe(true);
    expect(state.aborted).toBe(true);

    const err = (await pending.catch((e: unknown) => e)) as TelegramSendError;
    expect(err.kind).toBe('network');
    // Retryable classification — a timeout is transient, never permanent.
    expect(isRetryableTelegramError(err)).toBe(true);
    expect(describeTelegramFailure(err).retryable).toBe(true);
    // No secret material in the surfaced error.
    expect(JSON.stringify({ message: err.message })).not.toContain(FAKE_TOKEN);
  });

  it('just before the timeout the request is still pending — the ceiling is the explicit constant, not a runtime default', async () => {
    const { state } = stubHangingFetch();
    const pending = sendTelegramMessage(INPUT);
    const assertion = expect(pending).rejects.toBeInstanceOf(TelegramSendError);

    await vi.advanceTimersByTimeAsync(TELEGRAM_HTTP_TIMEOUT_MS - 1);
    expect(state.aborted).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    await assertion;
    expect(state.aborted).toBe(true);
  });

  it('normal fast success is never late-aborted and leaves no dangling timer', async () => {
    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => {
      capturedSignal = init?.signal ?? undefined;
      return new Response(
        JSON.stringify({ ok: true, result: { message_id: 42 } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await sendTelegramMessage(INPUT);
    expect(result.ok).toBe(true);
    expect(result.messageId).toBe(42);

    // Timer cleaned up on success — nothing left to fire a late abort.
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(TELEGRAM_HTTP_TIMEOUT_MS * 2);
    expect(capturedSignal?.aborted).toBe(false);
  });

  it('permanent 4xx and 429 semantics are untouched by the timeout seam', async () => {
    // 400 → telegram_api, permanent (classification unchanged).
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, description: 'chat not found' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    );
    const err400 = (await sendTelegramMessage(INPUT).catch(
      (e: unknown) => e,
    )) as TelegramSendError;
    expect(err400.kind).toBe('telegram_api');
    expect(err400.statusCode).toBe(400);
    expect(isRetryableTelegramError(err400)).toBe(false);
    expect(vi.getTimerCount()).toBe(0); // timer cleaned up on failure too

    // 429 → retryable with retry_after preserved.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ ok: false, parameters: { retry_after: 7 } }),
          { status: 429, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    const err429 = (await sendTelegramMessage(INPUT).catch(
      (e: unknown) => e,
    )) as TelegramSendError;
    expect(err429.statusCode).toBe(429);
    expect(err429.retryAfterSeconds).toBe(7);
    expect(isRetryableTelegramError(err429)).toBe(true);
  });
});

describe('TASK-090 — delivery-lease budget inequality (pinned to real constants)', () => {
  it('maximum normal ownership duration stays under DELIVERY_LEASE_MS with a healthy safety margin', () => {
    // One delivery ownership = one worker attempt holding the lease:
    //   - internal Telegram retry: (1 + retryDelays.length) HTTP attempts, each
    //     bounded by the explicit timeout;
    //   - between attempts: retryDelays.length waits, each capped by
    //     DEFAULT_MAX_RETRY_AFTER_MS (the 429 retry_after ceiling);
    //   - before the send port: destination-throttle cap + global-pacer cap;
    //   - DB CAS/lookup overhead: millisecond-scale, budgeted at 3s here.
    const maxHttpAttempts = 1 + DEFAULT_TELEGRAM_RETRY_DELAYS_MS.length;
    const maxHttpMs = maxHttpAttempts * TELEGRAM_HTTP_TIMEOUT_MS;
    const maxBackoffMs =
      DEFAULT_TELEGRAM_RETRY_DELAYS_MS.length * DEFAULT_MAX_RETRY_AFTER_MS;
    const maxPacingMs =
      DEFAULT_DESTINATION_MAX_WAIT_MS + DEFAULT_GLOBAL_SEND_MAX_WAIT_MS;
    const overheadBudgetMs = 3_000;

    const maxOwnershipMs =
      maxHttpMs + maxBackoffMs + maxPacingMs + overheadBudgetMs;

    // Documented numbers (task file §20 / policy module): 60s + 180s + 17s.
    expect(maxHttpAttempts).toBe(4);
    expect(maxHttpMs).toBe(60_000);
    expect(maxBackoffMs).toBe(180_000);
    expect(maxPacingMs).toBe(17_000);

    // The inequality itself, with an explicit ≥30s safety margin. Changing any
    // term (timeout, retry count, retry_after cap, pacer caps, lease) without
    // re-proving the budget fails this test.
    expect(maxOwnershipMs).toBeLessThan(DELIVERY_LEASE_MS);
    expect(DELIVERY_LEASE_MS - maxOwnershipMs).toBeGreaterThanOrEqual(30_000);
  });
});
