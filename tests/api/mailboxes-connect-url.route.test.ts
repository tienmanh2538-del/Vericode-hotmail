import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET } from '@/app/api/mailboxes/connect-url/route';
import {
  MICROSOFT_OAUTH_RECONNECT_COOKIE,
  MICROSOFT_OAUTH_STATE_COOKIE,
} from '@/services/microsoft/oauth-connect-url.service';

const CLIENT_ID = 'fake-client-id-1234';
const CLIENT_SECRET = 'fake-client-secret-do-not-leak';
const TENANT_ID = 'common';
const REDIRECT_URI = 'http://localhost:3000/api/microsoft/oauth/callback';

// Next.js always invokes route handlers with a Request. A bare fresh-connect
// request (no mailboxId) stands in for the default "Connect" button.
function connectRequest(query = ''): Request {
  return new Request(
    `http://localhost:3000/api/mailboxes/connect-url${query}`,
  );
}

function stubMicrosoftEnv() {
  vi.stubEnv('MICROSOFT_CLIENT_ID', CLIENT_ID);
  vi.stubEnv('MICROSOFT_CLIENT_SECRET', CLIENT_SECRET);
  vi.stubEnv('MICROSOFT_TENANT_ID', TENANT_ID);
  vi.stubEnv('MICROSOFT_REDIRECT_URI', REDIRECT_URI);
}

function clearMicrosoftEnv() {
  vi.stubEnv('MICROSOFT_CLIENT_ID', '');
  vi.stubEnv('MICROSOFT_CLIENT_SECRET', '');
  vi.stubEnv('MICROSOFT_TENANT_ID', '');
  vi.stubEnv('MICROSOFT_REDIRECT_URI', '');
}

beforeEach(() => {
  stubMicrosoftEnv();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /api/mailboxes/connect-url — success', () => {
  it('returns a Microsoft v2 authorize URL with required parameters', async () => {
    const response = await GET(connectRequest());
    expect(response.status).toBe(200);

    const body = (await response.json()) as { ok: boolean; url: string };
    expect(body.ok).toBe(true);
    expect(typeof body.url).toBe('string');

    const url = new URL(body.url);
    expect(url.origin).toBe('https://login.microsoftonline.com');
    expect(url.pathname).toBe(`/${TENANT_ID}/oauth2/v2.0/authorize`);
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(url.searchParams.get('response_mode')).toBe('query');
    expect(url.searchParams.get('scope')).toBe(
      'Mail.Read offline_access User.Read',
    );
    expect(url.searchParams.get('prompt')).toBe('select_account');
    const stateParam = url.searchParams.get('state');
    expect(typeof stateParam).toBe('string');
    expect((stateParam ?? '').length).toBeGreaterThanOrEqual(16);
  });

  it('sets an HTTP-only state cookie matching the URL state', async () => {
    const response = await GET(connectRequest());
    const body = (await response.json()) as { url: string };
    const expectedState = new URL(body.url).searchParams.get('state');

    const cookie = response.cookies.get(MICROSOFT_OAUTH_STATE_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie?.value).toBe(expectedState);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('lax');
    expect(cookie?.path).toBe('/');
    expect(cookie?.maxAge).toBeGreaterThan(0);
  });

  it('does not leak the client secret in the response body or cookie', async () => {
    const response = await GET(connectRequest());
    const bodyText = await response.text();
    expect(bodyText).not.toContain(CLIENT_SECRET);

    const setCookieHeader = response.headers.get('set-cookie') ?? '';
    expect(setCookieHeader).not.toContain(CLIENT_SECRET);
  });

  it('issues a new state on each request', async () => {
    const a = await GET(connectRequest());
    const b = await GET(connectRequest());
    const stateA = new URL(((await a.json()) as { url: string }).url)
      .searchParams.get('state');
    const stateB = new URL(((await b.json()) as { url: string }).url)
      .searchParams.get('state');
    expect(stateA).not.toBe(stateB);
  });
});

describe('GET /api/mailboxes/connect-url — reconnect target (TASK-069B)', () => {
  it('sets an httpOnly reconnect cookie carrying the mailboxId when provided', async () => {
    const request = new Request(
      'http://localhost:3000/api/mailboxes/connect-url?mailboxId=mbx_reconnect_1',
    );
    const response = await GET(request);
    expect(response.status).toBe(200);

    const cookie = response.cookies.get(MICROSOFT_OAUTH_RECONNECT_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie?.value).toBe('mbx_reconnect_1');
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.sameSite).toBe('lax');
    expect(cookie?.path).toBe('/');
    expect(cookie?.maxAge).toBeGreaterThan(0);
  });

  it('clears any stale reconnect cookie on a fresh connect (no mailboxId)', async () => {
    const response = await GET(connectRequest());
    const cookie = response.cookies.get(MICROSOFT_OAUTH_RECONNECT_COOKIE);
    expect(cookie).toBeDefined();
    expect(cookie?.value).toBe('');
    expect(cookie?.maxAge).toBe(0);
  });

  it('ignores a blank mailboxId and does not set a reconnect target', async () => {
    const request = new Request(
      'http://localhost:3000/api/mailboxes/connect-url?mailboxId=',
    );
    const response = await GET(request);
    const cookie = response.cookies.get(MICROSOFT_OAUTH_RECONNECT_COOKIE);
    expect(cookie?.value).toBe('');
    expect(cookie?.maxAge).toBe(0);
  });
});

describe('GET /api/mailboxes/connect-url — config error', () => {
  it('returns 500 with a safe error when Microsoft env is missing', async () => {
    clearMicrosoftEnv();
    const response = await GET(connectRequest());
    expect(response.status).toBe(500);
    const body = (await response.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('Microsoft OAuth is not configured');
    expect(body.error).not.toContain(CLIENT_ID);
    expect(body.error).not.toContain(REDIRECT_URI);
  });
});
