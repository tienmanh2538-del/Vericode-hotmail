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
