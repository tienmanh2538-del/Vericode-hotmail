import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  fetchAndConsumeWithTimeout,
  fetchWithTimeout,
  HttpTimeoutError,
} from '@/lib/http/fetch-with-timeout';

// A fake fetch whose returned promise never settles on its own, but rejects with
// an AbortError as soon as the passed AbortSignal fires — exactly how the native
// fetch behaves. This lets us prove the timeout truly cancels the request.
function hangingSignalAwareFetch(): typeof fetch {
  return vi.fn((_url: unknown, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal) {
        signal.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      }
    });
  }) as unknown as typeof fetch;
}

describe('fetchWithTimeout (TASK-080)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('passes through with no AbortSignal when no timeout is requested', async () => {
    const okResponse = new Response('ok', { status: 200 });
    const fetchImpl = vi.fn(async () => okResponse) as unknown as typeof fetch;

    const init: RequestInit = { method: 'GET' };
    const result = await fetchWithTimeout(fetchImpl, 'https://example.test', init);

    expect(result).toBe(okResponse);
    // Same init object, no injected signal — behaviour identical to a direct fetch.
    const passedInit = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as RequestInit;
    expect(passedInit.signal).toBeUndefined();
  });

  it('resolves normally when the request completes before the timeout', async () => {
    const okResponse = new Response('ok', { status: 200 });
    const fetchImpl = vi.fn(async () => okResponse) as unknown as typeof fetch;

    const result = await fetchWithTimeout(
      fetchImpl,
      'https://example.test',
      { method: 'GET' },
      { timeoutMs: 5_000 },
    );

    expect(result).toBe(okResponse);
  });

  it('aborts and throws HttpTimeoutError when the request hangs past the timeout', async () => {
    vi.useFakeTimers();
    const fetchImpl = hangingSignalAwareFetch();

    const promise = fetchWithTimeout(
      fetchImpl,
      'https://example.test',
      { method: 'GET' },
      { timeoutMs: 1_000 },
    );
    // Attach a catch immediately so the rejection is never unhandled while we
    // advance timers.
    const assertion = expect(promise).rejects.toBeInstanceOf(HttpTimeoutError);

    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('re-throws a non-timeout fetch error unchanged', async () => {
    const boom = new Error('connection refused');
    const fetchImpl = vi.fn(async () => {
      throw boom;
    }) as unknown as typeof fetch;

    await expect(
      fetchWithTimeout(
        fetchImpl,
        'https://example.test',
        { method: 'GET' },
        { timeoutMs: 1_000 },
      ),
    ).rejects.toBe(boom);
  });

  it('does not leave the abort timer pending after a fast success (no late abort)', async () => {
    vi.useFakeTimers();
    const okResponse = new Response('ok', { status: 200 });
    const aborted: boolean[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => aborted.push(true));
      return okResponse;
    }) as unknown as typeof fetch;

    const result = await fetchWithTimeout(
      fetchImpl,
      'https://example.test',
      { method: 'GET' },
      { timeoutMs: 1_000 },
    );
    expect(result).toBe(okResponse);

    // Advancing well past the timeout must NOT fire a late abort — the timer was
    // cleared on success.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(aborted).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// TASK-093 — fetchAndConsumeWithTimeout: ONE absolute deadline across fetch +
// async response consumption, with REAL body-stream cancellation on expiry.
// ---------------------------------------------------------------------------

/** A body-read promise that never settles on its own but rejects on abort. */
function hangingBodyRead(signal: AbortSignal | undefined): Promise<unknown> {
  return new Promise<unknown>((_resolve, reject) => {
    signal?.addEventListener('abort', () => {
      reject(new DOMException('The operation was aborted.', 'AbortError'));
    });
  });
}

describe('fetchAndConsumeWithTimeout (TASK-093)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('passes through with no signal (fetch AND consume) when no timeout is requested', async () => {
    const okResponse = new Response('ok', { status: 200 });
    const fetchImpl = vi.fn(async () => okResponse) as unknown as typeof fetch;
    const seenSignals: Array<AbortSignal | undefined> = [];

    const result = await fetchAndConsumeWithTimeout(
      fetchImpl,
      'https://example.test',
      { method: 'GET' },
      async (response, signal) => {
        seenSignals.push(signal);
        return response.status;
      },
    );

    expect(result).toBe(200);
    const passedInit = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as RequestInit;
    expect(passedInit.signal).toBeUndefined();
    expect(seenSignals).toEqual([undefined]);
  });

  it('resolves a fast headers + body success and never late-aborts (timer cleanup)', async () => {
    vi.useFakeTimers();
    const aborted: boolean[] = [];
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => aborted.push(true));
      return new Response('{"ok":true}', { status: 200 });
    }) as unknown as typeof fetch;

    const result = await fetchAndConsumeWithTimeout(
      fetchImpl,
      'https://example.test',
      { method: 'GET' },
      async (response) => response.json(),
      { timeoutMs: 20_000 },
    );

    expect(result).toEqual({ ok: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(aborted).toHaveLength(0);
  });

  it('one ABSOLUTE deadline from fetch start: headers at 10s + hanging body aborts at 20s total (not 30s)', async () => {
    vi.useFakeTimers();
    let capturedSignal: AbortSignal | undefined;
    // Headers arrive only after 10 seconds of (fake) clock.
    const fetchImpl = vi.fn(
      (_url: unknown, init?: RequestInit) =>
        new Promise<Response>((resolve) => {
          capturedSignal = init?.signal ?? undefined;
          setTimeout(() => resolve(new Response('slow', { status: 200 })), 10_000);
        }),
    ) as unknown as typeof fetch;

    const promise = fetchAndConsumeWithTimeout(
      fetchImpl,
      'https://example.test',
      { method: 'GET' },
      (_response, signal) => hangingBodyRead(signal),
      { timeoutMs: 20_000 },
    );
    let settled = false;
    const captured = promise.then(
      () => 'unexpected-resolve',
      (e: unknown) => e,
    );
    void captured.then(() => {
      settled = true;
    });

    // Headers phase done at t=10s; the timer must NOT reset here.
    await vi.advanceTimersByTimeAsync(10_000);
    expect(settled).toBe(false);

    // t=19.999s — still within the single absolute deadline.
    await vi.advanceTimersByTimeAsync(9_999);
    expect(settled).toBe(false);

    // t=20s exactly — deadline fires: real abort + HttpTimeoutError.
    await vi.advanceTimersByTimeAsync(1);
    const error = await captured;
    expect(settled).toBe(true);
    expect(error).toBeInstanceOf(HttpTimeoutError);
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('normalizes a deadline abort DURING the fetch phase to HttpTimeoutError too', async () => {
    vi.useFakeTimers();
    const fetchImpl = hangingSignalAwareFetch();

    const promise = fetchAndConsumeWithTimeout(
      fetchImpl,
      'https://example.test',
      { method: 'GET' },
      async (response) => response,
      { timeoutMs: 1_000 },
    );
    const assertion = expect(promise).rejects.toBeInstanceOf(HttpTimeoutError);
    await vi.advanceTimersByTimeAsync(1_000);
    await assertion;
  });

  it('re-throws a consumer error unchanged when the deadline has NOT fired (malformed JSON is never a timeout)', async () => {
    const boom = new Error('unexpected token in JSON');
    const fetchImpl = vi.fn(async () =>
      new Response('not-json', { status: 200 }),
    ) as unknown as typeof fetch;

    await expect(
      fetchAndConsumeWithTimeout(
        fetchImpl,
        'https://example.test',
        { method: 'GET' },
        async () => {
          throw boom;
        },
        { timeoutMs: 20_000 },
      ),
    ).rejects.toBe(boom);
  });

  it('re-throws a non-timeout fetch/network error unchanged', async () => {
    const boom = new Error('connection refused');
    const fetchImpl = vi.fn(async () => {
      throw boom;
    }) as unknown as typeof fetch;

    await expect(
      fetchAndConsumeWithTimeout(
        fetchImpl,
        'https://example.test',
        { method: 'GET' },
        async (response) => response,
        { timeoutMs: 1_000 },
      ),
    ).rejects.toBe(boom);
  });
});
