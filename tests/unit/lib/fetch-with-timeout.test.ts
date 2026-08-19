import { describe, it, expect, vi, afterEach } from 'vitest';

import {
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
