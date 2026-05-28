import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import { GET } from '@/app/api/microsoft/oauth/callback/route';
import { MICROSOFT_OAUTH_STATE_COOKIE } from '@/services/microsoft/oauth-connect-url.service';

const CLIENT_ID = 'fake-client-id-1234';
const CLIENT_SECRET = 'fake-client-secret-do-not-leak';
const TENANT_ID = 'common';
const REDIRECT_URI = 'http://localhost:3000/api/microsoft/oauth/callback';

const FAKE_ACCESS_TOKEN = 'fake-access-token-xyz';
const FAKE_REFRESH_TOKEN = 'fake-refresh-token-xyz';
const FAKE_ID_TOKEN = 'fake-id-token-xyz';
const FAKE_CODE = 'fake-authorization-code-abc';
const FAKE_STATE = 'fake-state-token-1234567890';
const CALLBACK_BASE = 'http://localhost:3000/api/microsoft/oauth/callback';

function stubMicrosoftEnv() {
  vi.stubEnv('MICROSOFT_CLIENT_ID', CLIENT_ID);
  vi.stubEnv('MICROSOFT_CLIENT_SECRET', CLIENT_SECRET);
  vi.stubEnv('MICROSOFT_TENANT_ID', TENANT_ID);
  vi.stubEnv('MICROSOFT_REDIRECT_URI', REDIRECT_URI);
}

function makeRequest(qs: string, cookieValue?: string): NextRequest {
  const url = `${CALLBACK_BASE}?${qs}`;
  const headers: Record<string, string> = {};
  if (cookieValue !== undefined) {
    headers['cookie'] = `${MICROSOFT_OAUTH_STATE_COOKIE}=${cookieValue}`;
  }
  return new NextRequest(url, { headers });
}

function stubFetchTokenSuccess() {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          token_type: 'Bearer',
          expires_in: 3599,
          scope: 'Mail.Read offline_access User.Read',
          access_token: FAKE_ACCESS_TOKEN,
          refresh_token: FAKE_REFRESH_TOKEN,
          id_token: FAKE_ID_TOKEN,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function stubFetchTokenError(status = 400) {
  const fetchMock = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          error: 'invalid_grant',
          error_description: 'Authorization code expired',
        }),
        { status, headers: { 'content-type': 'application/json' } },
      ),
  );
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

function parseLocation(loc: string | null): URL {
  expect(loc).toBeTruthy();
  return new URL(loc as string);
}

function expectClearedCookie(response: Response): void {
  const setCookie = response.headers.get('set-cookie') ?? '';
  expect(setCookie).toContain(`${MICROSOFT_OAUTH_STATE_COOKIE}=`);
  expect(setCookie.toLowerCase()).toContain('max-age=0');
  expect(setCookie.toLowerCase()).toContain('path=/');
  expect(setCookie.toLowerCase()).toContain('httponly');
  expect(setCookie.toLowerCase()).toContain('samesite=lax');
}

describe('GET callback — Microsoft error param', () => {
  it('redirects to /admin?oauth=error&reason=access_denied without calling fetch', async () => {
    const fetchMock = stubFetchTokenSuccess();
    const request = makeRequest(
      'error=access_denied&error_description=User%20denied',
      FAKE_STATE,
    );

    const response = await GET(request);
    expect([302, 303, 307, 308]).toContain(response.status);

    const loc = parseLocation(response.headers.get('location'));
    expect(loc.pathname).toBe('/admin');
    expect(loc.searchParams.get('oauth')).toBe('error');
    expect(loc.searchParams.get('reason')).toBe('access_denied');

    expect(fetchMock).not.toHaveBeenCalled();
    expectClearedCookie(response);
  });

  it('maps unknown Microsoft error code to oauth_error', async () => {
    const fetchMock = stubFetchTokenSuccess();
    const request = makeRequest('error=server_error', FAKE_STATE);
    const response = await GET(request);
    const loc = parseLocation(response.headers.get('location'));
    expect(loc.searchParams.get('reason')).toBe('oauth_error');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET callback — missing code', () => {
  it('redirects with reason=missing_code without calling fetch', async () => {
    const fetchMock = stubFetchTokenSuccess();
    const request = makeRequest(`state=${FAKE_STATE}`, FAKE_STATE);
    const response = await GET(request);

    const loc = parseLocation(response.headers.get('location'));
    expect(loc.pathname).toBe('/admin');
    expect(loc.searchParams.get('oauth')).toBe('error');
    expect(loc.searchParams.get('reason')).toBe('missing_code');
    expect(fetchMock).not.toHaveBeenCalled();
    expectClearedCookie(response);
  });
});

describe('GET callback — invalid state', () => {
  it('rejects when query state differs from cookie state', async () => {
    const fetchMock = stubFetchTokenSuccess();
    const request = makeRequest(
      `code=${FAKE_CODE}&state=different-state-value`,
      FAKE_STATE,
    );
    const response = await GET(request);

    const loc = parseLocation(response.headers.get('location'));
    expect(loc.searchParams.get('reason')).toBe('invalid_state');
    expect(fetchMock).not.toHaveBeenCalled();
    expectClearedCookie(response);
  });

  it('rejects when cookie is missing entirely', async () => {
    const fetchMock = stubFetchTokenSuccess();
    const request = makeRequest(`code=${FAKE_CODE}&state=${FAKE_STATE}`);
    const response = await GET(request);

    const loc = parseLocation(response.headers.get('location'));
    expect(loc.searchParams.get('reason')).toBe('invalid_state');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects when state query is missing but cookie is set', async () => {
    const fetchMock = stubFetchTokenSuccess();
    const request = makeRequest(`code=${FAKE_CODE}`, FAKE_STATE);
    const response = await GET(request);

    const loc = parseLocation(response.headers.get('location'));
    expect(loc.searchParams.get('reason')).toBe('invalid_state');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET callback — token exchange success', () => {
  it('redirects to /admin?oauth=success and never leaks tokens', async () => {
    const fetchMock = stubFetchTokenSuccess();
    const request = makeRequest(
      `code=${FAKE_CODE}&state=${FAKE_STATE}`,
      FAKE_STATE,
    );
    const response = await GET(request);

    expect([302, 303, 307, 308]).toContain(response.status);
    const loc = parseLocation(response.headers.get('location'));
    expect(loc.pathname).toBe('/admin');
    expect(loc.searchParams.get('oauth')).toBe('success');
    expect(loc.searchParams.get('reason')).toBeNull();

    const bodyText = await response.text();
    expect(bodyText).not.toContain(FAKE_ACCESS_TOKEN);
    expect(bodyText).not.toContain(FAKE_REFRESH_TOKEN);
    expect(bodyText).not.toContain(FAKE_ID_TOKEN);
    expect(bodyText).not.toContain(CLIENT_SECRET);
    expect(bodyText).not.toContain(FAKE_CODE);

    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).not.toContain(FAKE_ACCESS_TOKEN);
    expect(setCookie).not.toContain(FAKE_REFRESH_TOKEN);
    expect(setCookie).not.toContain(FAKE_ID_TOKEN);

    const fullSerializedHeaders = JSON.stringify(
      Object.fromEntries(response.headers.entries()),
    );
    expect(fullSerializedHeaders).not.toContain(FAKE_ACCESS_TOKEN);
    expect(fullSerializedHeaders).not.toContain(FAKE_REFRESH_TOKEN);
    expect(fullSerializedHeaders).not.toContain(FAKE_ID_TOKEN);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe(
      `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    );
    const parsed = new URLSearchParams(init.body as string);
    expect(parsed.get('code')).toBe(FAKE_CODE);
    expect(parsed.get('grant_type')).toBe('authorization_code');

    expectClearedCookie(response);
  });
});

describe('GET callback — token exchange failure', () => {
  it('redirects with reason=token_exchange_failed when Microsoft rejects the code', async () => {
    stubFetchTokenError(400);
    const request = makeRequest(
      `code=${FAKE_CODE}&state=${FAKE_STATE}`,
      FAKE_STATE,
    );
    const response = await GET(request);

    const loc = parseLocation(response.headers.get('location'));
    expect(loc.pathname).toBe('/admin');
    expect(loc.searchParams.get('oauth')).toBe('error');
    expect(loc.searchParams.get('reason')).toBe('token_exchange_failed');

    const bodyText = await response.text();
    expect(bodyText).not.toContain(FAKE_CODE);
    expect(bodyText).not.toContain(CLIENT_SECRET);
    expectClearedCookie(response);
  });
});
