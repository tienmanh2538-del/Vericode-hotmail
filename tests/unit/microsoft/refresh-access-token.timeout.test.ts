import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  refreshMicrosoftAccessToken,
  RefreshAccessTokenError,
} from '@/services/microsoft/refresh-access-token.service';
import { classifyRefreshTokenError } from '@/services/microsoft/refresh-token-failure';
import { loadEnv } from '@/lib/env';

// TASK-080 — the token-endpoint request on the delta path must honour a finite
// timeout so a hung token refresh cannot wedge the delta cycle. A timeout is
// reported as a `network` error, which classifies as TRANSIENT (never reconnect).

// Synthetic, obviously-fake OAuth config — no real client secret / tenant.
const env = loadEnv({
  MICROSOFT_CLIENT_ID: 'test-client-id',
  MICROSOFT_CLIENT_SECRET: 'test-client-secret-placeholder',
  MICROSOFT_TENANT_ID: 'common',
  MICROSOFT_REDIRECT_URI: 'https://app.example.test/api/microsoft/oauth/callback',
}).values;

function hangingSignalAwareFetch(): typeof fetch {
  return vi.fn((_url: unknown, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
  }) as unknown as typeof fetch;
}

describe('refreshMicrosoftAccessToken timeout on the delta path (TASK-080)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('times out a hung token request as a network error (→ transient, not reconnect)', async () => {
    vi.useFakeTimers();
    const fetchImpl = hangingSignalAwareFetch();

    const promise = refreshMicrosoftAccessToken('refresh-token-placeholder', {
      env,
      fetchImpl,
      timeoutMs: 1_000,
    });
    const captured = promise.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(1_000);
    const error = await captured;

    expect(error).toBeInstanceOf(RefreshAccessTokenError);
    expect((error as RefreshAccessTokenError).kind).toBe('network');
    // Crucially: a timeout must NEVER be treated as a dead grant.
    expect(classifyRefreshTokenError(error)).toBe('transient');
  });

  it('leaves behaviour unchanged (no timeout applied) when timeoutMs is omitted', async () => {
    const okBody = JSON.stringify({
      token_type: 'Bearer',
      expires_in: 3600,
      access_token: 'fresh-access-token',
    });
    const fetchImpl = vi.fn(async () =>
      new Response(okBody, {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ) as unknown as typeof fetch;

    const result = await refreshMicrosoftAccessToken('refresh-token-placeholder', {
      env,
      fetchImpl,
    });

    expect(result.accessToken).toBe('fresh-access-token');
    // No AbortSignal is injected when no timeout is requested.
    const passedInit = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock
      .calls[0][1] as RequestInit;
    expect(passedInit.signal).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// TASK-093 — end-to-end body deadline opt-in (`deadlineCoversBodyRead`).
// ---------------------------------------------------------------------------

/**
 * A fetch whose HEADERS resolve immediately, with a controllable body: 'hang'
 * settles only when the request signal aborts; 'malformed' rejects like a JSON
 * parse failure; otherwise resolves the given payload object.
 */
function fetchWithBody(options: {
  status?: number;
  bodyMode: 'hang' | 'malformed' | 'ok';
  payload?: unknown;
}): typeof fetch {
  return vi.fn(async (_url: unknown, init?: RequestInit) => {
    const signal = init?.signal;
    return {
      ok: (options.status ?? 200) >= 200 && (options.status ?? 200) < 300,
      status: options.status ?? 200,
      headers: new Headers(),
      json: () => {
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
        return Promise.resolve(options.payload);
      },
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

describe('refreshMicrosoftAccessToken body-deadline opt-in (TASK-093)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('opt-in: hanging SUCCESS body aborts at the same absolute deadline → network → transient', async () => {
    vi.useFakeTimers();
    const fetchImpl = fetchWithBody({ bodyMode: 'hang' });

    const promise = refreshMicrosoftAccessToken('refresh-token-placeholder', {
      env,
      fetchImpl,
      timeoutMs: 1_000,
      deadlineCoversBodyRead: true,
    });
    const captured = promise.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(1_000);
    const error = await captured;

    expect(error).toBeInstanceOf(RefreshAccessTokenError);
    expect((error as RefreshAccessTokenError).kind).toBe('network');
    expect(classifyRefreshTokenError(error)).toBe('transient');
  });

  it('opt-in: hanging OAuth ERROR body (400) is transient — never reconnect without a readable code', async () => {
    vi.useFakeTimers();
    const fetchImpl = fetchWithBody({ status: 400, bodyMode: 'hang' });

    const promise = refreshMicrosoftAccessToken('refresh-token-placeholder', {
      env,
      fetchImpl,
      timeoutMs: 1_000,
      deadlineCoversBodyRead: true,
    });
    const captured = promise.catch((e: unknown) => e);

    await vi.advanceTimersByTimeAsync(1_000);
    const error = await captured;

    expect(error).toBeInstanceOf(RefreshAccessTokenError);
    // The revoke code was never readable ⇒ network, NOT token_endpoint(+code).
    expect((error as RefreshAccessTokenError).kind).toBe('network');
    expect((error as RefreshAccessTokenError).microsoftErrorCode).toBeUndefined();
    expect(classifyRefreshTokenError(error)).toBe('transient');
  });

  it('opt-in: a READABLE invalid_grant error body still classifies reconnect_required', async () => {
    const fetchImpl = fetchWithBody({
      status: 400,
      bodyMode: 'ok',
      payload: { error: 'invalid_grant' },
    });

    const error = await refreshMicrosoftAccessToken('refresh-token-placeholder', {
      env,
      fetchImpl,
      timeoutMs: 1_000,
      deadlineCoversBodyRead: true,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RefreshAccessTokenError);
    expect((error as RefreshAccessTokenError).kind).toBe('token_endpoint');
    expect((error as RefreshAccessTokenError).microsoftErrorCode).toBe(
      'invalid_grant',
    );
    expect(classifyRefreshTokenError(error)).toBe('reconnect_required');
  });

  it('opt-in: malformed JSON before the deadline keeps the token_endpoint classification (never timeout)', async () => {
    const fetchImpl = fetchWithBody({ bodyMode: 'malformed' });

    const error = await refreshMicrosoftAccessToken('refresh-token-placeholder', {
      env,
      fetchImpl,
      timeoutMs: 1_000,
      deadlineCoversBodyRead: true,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RefreshAccessTokenError);
    // Same outcome as the legacy swallow: ok-status + unreadable JSON ⇒
    // token_endpoint ("response was not JSON"), which classifies transient.
    expect((error as RefreshAccessTokenError).kind).toBe('token_endpoint');
    expect(classifyRefreshTokenError(error)).toBe('transient');
  });

  it('compatibility: timeoutMs WITHOUT the opt-in keeps headers-only semantics (body read NOT aborted after the deadline)', async () => {
    vi.useFakeTimers();
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

    const promise = refreshMicrosoftAccessToken('refresh-token-placeholder', {
      env,
      fetchImpl,
      timeoutMs: 1_000,
    });
    const captured = promise.then(
      (r) => r,
      (e: unknown) => e,
    );

    // Far past the deadline: pre-TASK-093 (delta/reconciliation) semantics —
    // the body read is NOT aborted.
    await vi.advanceTimersByTimeAsync(30_000);
    expect(bodyAborted).toBe(false);

    // Manually complete the body so the test settles cleanly (no leaked handle).
    finishBody({
      token_type: 'Bearer',
      expires_in: 3600,
      access_token: 'fresh-access-token',
    });
    const result = await captured;
    expect((result as { accessToken: string }).accessToken).toBe(
      'fresh-access-token',
    );
  });
});
