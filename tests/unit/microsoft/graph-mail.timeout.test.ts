import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  getMessageById,
  GraphMailError,
} from '@/services/microsoft/graph-mail.service';

// TASK-092 — the Graph message fetch on the email-worker path must honour a
// finite timeout with REAL cancellation: on timeout the AbortController signal
// reaches the exact fetch call and the request settles as a `network`
// GraphMailError (transient/retryable — never auth/permission). Without
// `timeoutMs` the behaviour is a plain pass-through (no signal injected), so
// non-worker callers are unchanged.

const MESSAGE_BODY = JSON.stringify({
  id: 'msg-1',
  subject: 'hello',
  receivedDateTime: '2026-09-01T00:00:00Z',
});

function okResponse(): Response {
  return new Response(MESSAGE_BODY, {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** A fetch that never resolves on its own but rejects when its signal aborts. */
function hangingSignalAwareFetch(): typeof fetch {
  return vi.fn((_url: unknown, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
  }) as unknown as typeof fetch;
}

function capturedInit(fetchImpl: typeof fetch): RequestInit {
  return (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
    .calls[0][1] as RequestInit;
}

describe('getMessageById timeout on the email-worker path (TASK-092)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('passes an AbortSignal to the exact fetch and clears the timer on fast success', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;

    const message = await getMessageById('access-token-placeholder', 'msg-1', {
      timeoutMs: 20_000,
      fetchImpl,
    });

    expect(message.id).toBe('msg-1');
    const init = capturedInit(fetchImpl);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);

    // Timer cleanup: advancing far past the ceiling must NOT late-abort the
    // already-completed request.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(init.signal?.aborted).toBe(false);
  });

  it('times out a hung fetch at exactly the ceiling with a REAL abort (network kind)', async () => {
    vi.useFakeTimers();
    const fetchImpl = hangingSignalAwareFetch();

    const promise = getMessageById('access-token-placeholder', 'msg-1', {
      timeoutMs: 20_000,
      fetchImpl,
    });
    let settled = false;
    const captured = promise.then(
      () => 'unexpected-resolve',
      (e: unknown) => e,
    );
    void captured.then(() => {
      settled = true;
    });

    // No infinite pending — but also no premature settle before the ceiling.
    await vi.advanceTimersByTimeAsync(19_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const error = await captured;
    expect(settled).toBe(true);

    // Classified as transient network — NEVER auth (401) / permission (403),
    // so no reconnect flag and no persistent-403/quota behaviour can trigger.
    expect(error).toBeInstanceOf(GraphMailError);
    expect((error as GraphMailError).kind).toBe('network');
    expect((error as GraphMailError).httpStatus).toBeUndefined();

    // The cancellation is real: the signal handed to the exact fetch aborted.
    const init = capturedInit(fetchImpl);
    expect(init.signal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('keeps pass-through behaviour when timeoutMs is omitted (no signal injected)', async () => {
    const fetchImpl = vi.fn(async () => okResponse()) as unknown as typeof fetch;

    const message = await getMessageById('access-token-placeholder', 'msg-1', {
      fetchImpl,
    });

    expect(message.id).toBe('msg-1');
    const init = capturedInit(fetchImpl);
    expect(init.signal).toBeUndefined();
  });
});
