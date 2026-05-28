import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  MicrosoftOAuthTokenExchangeError,
  exchangeAuthorizationCodeForTokens,
} from '@/services/microsoft/oauth-token-exchange.service';

const CLIENT_ID = 'fake-client-id-1234';
const CLIENT_SECRET = 'fake-client-secret-do-not-leak';
const TENANT_ID = 'common';
const REDIRECT_URI = 'http://localhost:3000/api/microsoft/oauth/callback';

const FAKE_ACCESS_TOKEN = 'fake-access-token-xyz';
const FAKE_REFRESH_TOKEN = 'fake-refresh-token-xyz';
const FAKE_ID_TOKEN = 'fake-id-token-xyz';
const FAKE_CODE = 'fake-authorization-code-abc';

function stubMicrosoftEnv() {
  vi.stubEnv('MICROSOFT_CLIENT_ID', CLIENT_ID);
  vi.stubEnv('MICROSOFT_CLIENT_SECRET', CLIENT_SECRET);
  vi.stubEnv('MICROSOFT_TENANT_ID', TENANT_ID);
  vi.stubEnv('MICROSOFT_REDIRECT_URI', REDIRECT_URI);
}

function stubFetchSuccess(payload: Record<string, unknown>) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function stubFetchError(status: number, payload: Record<string, unknown>) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify(payload), {
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
  stubMicrosoftEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('exchangeAuthorizationCodeForTokens — success', () => {
  it('posts to the v2 token endpoint with form-encoded body', async () => {
    const fetchMock = stubFetchSuccess({
      token_type: 'Bearer',
      expires_in: 3599,
      scope: 'Mail.Read offline_access User.Read',
      access_token: FAKE_ACCESS_TOKEN,
      refresh_token: FAKE_REFRESH_TOKEN,
      id_token: FAKE_ID_TOKEN,
    });

    const result = await exchangeAuthorizationCodeForTokens({ code: FAKE_CODE });

    expect(result.tokenType).toBe('Bearer');
    expect(result.expiresIn).toBe(3599);
    expect(result.scope).toBe('Mail.Read offline_access User.Read');
    expect(result.accessToken).toBe(FAKE_ACCESS_TOKEN);
    expect(result.refreshToken).toBe(FAKE_REFRESH_TOKEN);
    expect(result.idToken).toBe(FAKE_ID_TOKEN);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe(
      `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    );
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');

    const parsed = new URLSearchParams(init.body as string);
    expect(parsed.get('client_id')).toBe(CLIENT_ID);
    expect(parsed.get('client_secret')).toBe(CLIENT_SECRET);
    expect(parsed.get('code')).toBe(FAKE_CODE);
    expect(parsed.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(parsed.get('grant_type')).toBe('authorization_code');
  });

  it('returns success when refresh_token and id_token are absent', async () => {
    stubFetchSuccess({
      token_type: 'Bearer',
      expires_in: 3599,
      access_token: FAKE_ACCESS_TOKEN,
    });

    const result = await exchangeAuthorizationCodeForTokens({ code: FAKE_CODE });
    expect(result.accessToken).toBe(FAKE_ACCESS_TOKEN);
    expect(result.refreshToken).toBeUndefined();
    expect(result.idToken).toBeUndefined();
    expect(result.scope).toBeUndefined();
  });
});

describe('exchangeAuthorizationCodeForTokens — validation', () => {
  it('rejects empty code without calling fetch', async () => {
    const fetchMock = stubFetchSuccess({});
    await expect(
      exchangeAuthorizationCodeForTokens({ code: '' }),
    ).rejects.toMatchObject({ kind: 'validation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects whitespace-only code', async () => {
    const fetchMock = stubFetchSuccess({});
    await expect(
      exchangeAuthorizationCodeForTokens({ code: '   ' }),
    ).rejects.toBeInstanceOf(MicrosoftOAuthTokenExchangeError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('exchangeAuthorizationCodeForTokens — config error', () => {
  it('throws config error when env is missing', async () => {
    vi.stubEnv('MICROSOFT_CLIENT_ID', '');
    vi.stubEnv('MICROSOFT_CLIENT_SECRET', '');
    vi.stubEnv('MICROSOFT_TENANT_ID', '');
    vi.stubEnv('MICROSOFT_REDIRECT_URI', '');
    const fetchMock = stubFetchSuccess({});

    try {
      await exchangeAuthorizationCodeForTokens({ code: FAKE_CODE });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MicrosoftOAuthTokenExchangeError);
      const e = err as MicrosoftOAuthTokenExchangeError;
      expect(e.kind).toBe('config');
      expect(e.message).not.toContain(CLIENT_ID);
      expect(e.message).not.toContain(CLIENT_SECRET);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('exchangeAuthorizationCodeForTokens — token endpoint error', () => {
  it('throws token_endpoint error with microsoftErrorCode on invalid_grant', async () => {
    stubFetchError(400, {
      error: 'invalid_grant',
      error_description: 'Authorization code expired',
    });

    try {
      await exchangeAuthorizationCodeForTokens({ code: FAKE_CODE });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MicrosoftOAuthTokenExchangeError);
      const e = err as MicrosoftOAuthTokenExchangeError;
      expect(e.kind).toBe('token_endpoint');
      expect(e.microsoftErrorCode).toBe('invalid_grant');
      expect(e.httpStatus).toBe(400);
      expect(e.message).not.toContain(CLIENT_SECRET);
      expect(e.message).not.toContain(FAKE_CODE);
    }
  });

  it('throws token_endpoint error when success body misses access_token', async () => {
    stubFetchSuccess({
      token_type: 'Bearer',
      expires_in: 3599,
    });
    await expect(
      exchangeAuthorizationCodeForTokens({ code: FAKE_CODE }),
    ).rejects.toMatchObject({ kind: 'token_endpoint' });
  });
});

describe('exchangeAuthorizationCodeForTokens — network error', () => {
  it('throws network error when fetch itself fails', async () => {
    stubFetchNetworkError();
    try {
      await exchangeAuthorizationCodeForTokens({ code: FAKE_CODE });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MicrosoftOAuthTokenExchangeError);
      const e = err as MicrosoftOAuthTokenExchangeError;
      expect(e.kind).toBe('network');
      expect(e.message).not.toContain(CLIENT_SECRET);
      expect(e.message).not.toContain(FAKE_CODE);
    }
  });
});

describe('exchangeAuthorizationCodeForTokens — secret hygiene', () => {
  it('never includes client secret, code, or tokens in thrown error fields', async () => {
    stubFetchError(401, { error: 'invalid_client' });
    try {
      await exchangeAuthorizationCodeForTokens({ code: FAKE_CODE });
    } catch (err) {
      const e = err as MicrosoftOAuthTokenExchangeError;
      const serialized = JSON.stringify({
        message: e.message,
        kind: e.kind,
        microsoftErrorCode: e.microsoftErrorCode,
        httpStatus: e.httpStatus,
      });
      expect(serialized).not.toContain(CLIENT_SECRET);
      expect(serialized).not.toContain(FAKE_CODE);
      expect(serialized).not.toContain(FAKE_ACCESS_TOKEN);
      expect(serialized).not.toContain(FAKE_REFRESH_TOKEN);
    }
  });
});
