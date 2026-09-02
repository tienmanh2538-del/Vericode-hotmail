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

// ---------------------------------------------------------------------------
// TASK-093 — end-to-end body deadline opt-in (`deadlineCoversBodyRead`).
// ---------------------------------------------------------------------------

/**
 * A fetch whose HEADERS resolve immediately, but whose success body (`json()`)
 * behaves per `bodyMode`: 'hang' never settles until the request signal aborts
 * (undici contract); 'malformed' rejects like a JSON parse failure; a value
 * resolves normally. `status` drives the non-2xx path.
 */
function fetchWithControllableBody(options: {
  status?: number;
  bodyMode: 'hang' | 'malformed' | 'ok';
}): { fetchImpl: typeof fetch; jsonCalls: number[] } {
  const jsonCalls: number[] = [];
  const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    return {
      ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
      status: options.status ?? 200,
      headers: new Headers(),
      json: () => {
        jsonCalls.push(1);
        if (options.bodyMode === 'malformed') {
          return Promise.reject(new SyntaxError('Unexpected token'));
        }
        if (options.bodyMode === 'hang') {
          return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => {
              reject(new DOMException('The operation was aborted.', 'AbortError'));
            });
          });
        }
        return Promise.resolve(JSON.parse(MESSAGE_BODY));
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, jsonCalls };
}

describe('getMessageById end-to-end body deadline opt-in (TASK-093)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('opt-in: hanging success body aborts at the SAME absolute 20s deadline → network kind', async () => {
    vi.useFakeTimers();
    const { fetchImpl } = fetchWithControllableBody({ bodyMode: 'hang' });

    const promise = getMessageById('access-token-placeholder', 'msg-1', {
      timeoutMs: 20_000,
      deadlineCoversBodyRead: true,
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

    await vi.advanceTimersByTimeAsync(19_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    const error = await captured;

    expect(error).toBeInstanceOf(GraphMailError);
    expect((error as GraphMailError).kind).toBe('network');
    const init = capturedInit(fetchImpl);
    expect(init.signal?.aborted).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('opt-in: malformed success JSON before the deadline keeps the parse classification (never timeout)', async () => {
    const { fetchImpl } = fetchWithControllableBody({ bodyMode: 'malformed' });

    const error = await getMessageById('access-token-placeholder', 'msg-1', {
      timeoutMs: 20_000,
      deadlineCoversBodyRead: true,
      fetchImpl,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GraphMailError);
    expect((error as GraphMailError).kind).toBe('parse');
  });

  it('opt-in: real 401 classifies from response.status WITHOUT reading the error body', async () => {
    const { fetchImpl, jsonCalls } = fetchWithControllableBody({
      status: 401,
      bodyMode: 'hang',
    });

    const error = await getMessageById('access-token-placeholder', 'msg-1', {
      timeoutMs: 20_000,
      deadlineCoversBodyRead: true,
      fetchImpl,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(GraphMailError);
    expect((error as GraphMailError).kind).toBe('auth');
    expect((error as GraphMailError).httpStatus).toBe(401);
    // The (hanging) error body was never awaited — status decides, exactly as
    // before, so a hanging error body cannot wedge nor fake a timeout.
    expect(jsonCalls).toHaveLength(0);
  });

  it('compatibility: timeoutMs WITHOUT the opt-in keeps headers-only semantics (body read NOT aborted after the deadline)', async () => {
    vi.useFakeTimers();
    // Body read is controllable so the test can finish it manually — the legacy
    // window never aborts it, and we must not leak a pending handle.
    let finishBody: (value: unknown) => void = () => undefined;
    let bodyAborted = false;
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      init?.signal?.addEventListener('abort', () => {
        bodyAborted = true;
      });
      return {
        ok: true,
        status: 200,
        headers: new Headers(),
        json: () =>
          new Promise((resolve) => {
            finishBody = resolve;
          }),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const promise = getMessageById('access-token-placeholder', 'msg-1', {
      timeoutMs: 20_000,
      fetchImpl,
    });
    const captured = promise.then(
      (m) => m,
      (e: unknown) => e,
    );

    // Far past the deadline: pre-TASK-093 semantics — no abort of the body.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(bodyAborted).toBe(false);

    // Manually complete the body so the test settles cleanly (no leaked handle).
    finishBody(JSON.parse(MESSAGE_BODY));
    const message = await captured;
    expect((message as { id: string }).id).toBe('msg-1');
  });
});
