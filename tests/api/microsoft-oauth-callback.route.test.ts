import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes } from 'node:crypto';
import { NextRequest } from 'next/server';

const mailboxStore: Array<{
  id: string;
  emailAddress: string;
  provider: string;
  microsoftUserId: string;
  encryptedRefreshToken: string;
  status: string;
  tokenLastRefreshedAt: Date | null;
  createdById: string | null;
  // TASK-069B — present so reconnect tests can assert it survives.
  customerId?: string | null;
}> = [];
let mailboxIdCounter = 0;
// TASK-081 — simulates a DB failure during the mailbox save so tests can prove
// that subscription provisioning is never reached when the save fails.
let failMailboxWrites = false;

// TASK-081 — GraphSubscription rows persisted by connect-time provisioning.
const subscriptionStore: Array<{
  id: string;
  mailboxId: string;
  subscriptionId: string;
  resource: string;
  clientStateHash: string;
  expirationDateTime: Date;
  status: string;
  lastRenewedAt: Date | null;
}> = [];
let subscriptionIdCounter = 0;

vi.mock('@/lib/prisma', () => ({
  prisma: {
    graphSubscription: {
      async findFirst({
        where,
      }: {
        where: {
          mailboxId: string;
          status: { in: string[] };
          expirationDateTime: { gt: Date };
        };
      }) {
        const matches = subscriptionStore
          .filter(
            (s) =>
              s.mailboxId === where.mailboxId &&
              where.status.in.includes(s.status) &&
              s.expirationDateTime.getTime() >
                where.expirationDateTime.gt.getTime(),
          )
          .sort(
            (a, b) =>
              b.expirationDateTime.getTime() - a.expirationDateTime.getTime(),
          );
        return matches[0] ? { ...matches[0] } : null;
      },
      async create({ data }: { data: Record<string, unknown> }) {
        subscriptionIdCounter += 1;
        const record = {
          id: `gsub_${subscriptionIdCounter}`,
          mailboxId: data.mailboxId as string,
          subscriptionId: data.subscriptionId as string,
          resource: data.resource as string,
          clientStateHash: data.clientStateHash as string,
          expirationDateTime: data.expirationDateTime as Date,
          status: data.status as string,
          lastRenewedAt: null,
        };
        subscriptionStore.push(record);
        return { ...record };
      },
      async update({
        where,
        data,
      }: {
        where: { subscriptionId: string };
        data: Record<string, unknown>;
      }) {
        const target = subscriptionStore.find(
          (s) => s.subscriptionId === where.subscriptionId,
        );
        if (!target) throw new Error('not found');
        Object.assign(target, data);
        return { ...target };
      },
    },
    mailbox: {
      async findFirst({
        where,
      }: {
        where: { provider: string; microsoftUserId: string };
      }) {
        return (
          mailboxStore.find(
            (m) =>
              m.provider === where.provider &&
              m.microsoftUserId === where.microsoftUserId,
          ) ?? null
        );
      },
      async findUnique({ where }: { where: { emailAddress: string } }) {
        return (
          mailboxStore.find((m) => m.emailAddress === where.emailAddress) ?? null
        );
      },
      async update({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) {
        if (failMailboxWrites) throw new Error('simulated db failure');
        const target = mailboxStore.find((m) => m.id === where.id);
        if (!target) throw new Error('not found');
        Object.assign(target, data);
        return { ...target };
      },
      async create({ data }: { data: Record<string, unknown> }) {
        if (failMailboxWrites) throw new Error('simulated db failure');
        mailboxIdCounter += 1;
        const record = {
          id: `mb_${mailboxIdCounter}`,
          emailAddress: data.emailAddress as string,
          provider: data.provider as string,
          microsoftUserId: data.microsoftUserId as string,
          encryptedRefreshToken: data.encryptedRefreshToken as string,
          status: data.status as string,
          tokenLastRefreshedAt: (data.tokenLastRefreshedAt as Date) ?? null,
          createdById: (data.createdById as string | null) ?? null,
        };
        mailboxStore.push(record);
        return { ...record };
      },
    },
  },
}));

// Import route AFTER vi.mock so the mocked prisma is wired in.
const { GET } = await import('@/app/api/microsoft/oauth/callback/route');
const { MICROSOFT_OAUTH_STATE_COOKIE, MICROSOFT_OAUTH_RECONNECT_COOKIE } =
  await import('@/services/microsoft/oauth-connect-url.service');

const CLIENT_ID = 'fake-client-id-1234';
const CLIENT_SECRET = 'fake-client-secret-do-not-leak';
const TENANT_ID = 'common';
const REDIRECT_URI = 'http://localhost:3000/api/microsoft/oauth/callback';

const FAKE_ACCESS_TOKEN = 'fake-access-token-xyz';
const FAKE_REFRESH_TOKEN = 'fake-refresh-token-xyz';
const FAKE_ID_TOKEN = 'fake-id-token-xyz';
const FAKE_CODE = 'fake-authorization-code-abc';
const FAKE_STATE = 'fake-state-token-1234567890';
const FAKE_MS_USER_ID = 'ms-user-callback-001';
const FAKE_MAILBOX_EMAIL = 'callback-mailbox@example.com';
const CALLBACK_BASE = 'http://localhost:3000/api/microsoft/oauth/callback';

const TOKEN_ENDPOINT = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`;
const GRAPH_ME_URL =
  'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName';
// TASK-081 — connect-time subscription provisioning surfaces.
const GRAPH_SUBSCRIPTIONS_URL = 'https://graph.microsoft.com/v1.0/subscriptions';
const FAKE_NOTIFICATION_URL = 'https://example.com/api/webhooks/microsoft/mail';
const FAKE_GRAPH_SUB_ID = 'graph-sub-cb-001';

function generateEncryptionKey(): string {
  return randomBytes(32).toString('base64');
}

function stubMicrosoftEnv() {
  vi.stubEnv('MICROSOFT_CLIENT_ID', CLIENT_ID);
  vi.stubEnv('MICROSOFT_CLIENT_SECRET', CLIENT_SECRET);
  vi.stubEnv('MICROSOFT_TENANT_ID', TENANT_ID);
  vi.stubEnv('MICROSOFT_REDIRECT_URI', REDIRECT_URI);
  vi.stubEnv('ENCRYPTION_KEY', generateEncryptionKey());
}

function makeRequest(
  qs: string,
  cookieValue?: string,
  reconnectMailboxId?: string,
): NextRequest {
  const url = `${CALLBACK_BASE}?${qs}`;
  const cookies: string[] = [];
  if (cookieValue !== undefined) {
    cookies.push(`${MICROSOFT_OAUTH_STATE_COOKIE}=${cookieValue}`);
  }
  if (reconnectMailboxId !== undefined) {
    cookies.push(`${MICROSOFT_OAUTH_RECONNECT_COOKIE}=${reconnectMailboxId}`);
  }
  const headers: Record<string, string> = {};
  if (cookies.length > 0) headers['cookie'] = cookies.join('; ');
  return new NextRequest(url, { headers });
}

interface FetchRouteOptions {
  tokenStatus?: number;
  tokenPayload?: Record<string, unknown>;
  graphStatus?: number;
  graphPayload?: Record<string, unknown>;
  // TASK-081 — POST /subscriptions behaviour for provisioning tests.
  subscriptionsStatus?: number;
  subscriptionsPayload?: Record<string, unknown>;
}

function stubFetchRouter(options: FetchRouteOptions = {}) {
  const tokenPayload = options.tokenPayload ?? {
    token_type: 'Bearer',
    expires_in: 3599,
    scope: 'Mail.Read offline_access User.Read',
    access_token: FAKE_ACCESS_TOKEN,
    refresh_token: FAKE_REFRESH_TOKEN,
    id_token: FAKE_ID_TOKEN,
  };
  const graphPayload = options.graphPayload ?? {
    id: FAKE_MS_USER_ID,
    mail: FAKE_MAILBOX_EMAIL,
    userPrincipalName: 'callback-mailbox@example.onmicrosoft.com',
    displayName: 'Callback Mailbox',
  };

  const subscriptionsPayload = options.subscriptionsPayload ?? {
    id: FAKE_GRAPH_SUB_ID,
    resource: "/me/mailFolders('Inbox')/messages",
    expirationDateTime: new Date(
      Date.now() + 6 * 24 * 60 * 60 * 1000,
    ).toISOString(),
  };

  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url === TOKEN_ENDPOINT) {
      return new Response(JSON.stringify(tokenPayload), {
        status: options.tokenStatus ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === GRAPH_ME_URL) {
      return new Response(JSON.stringify(graphPayload), {
        status: options.graphStatus ?? 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === GRAPH_SUBSCRIPTIONS_URL) {
      return new Response(JSON.stringify(subscriptionsPayload), {
        status: options.subscriptionsStatus ?? 201,
        headers: { 'content-type': 'application/json' },
      });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function stubFetchTokenSuccess() {
  return stubFetchRouter();
}

function stubFetchTokenError(status = 400) {
  return stubFetchRouter({
    tokenStatus: status,
    tokenPayload: {
      error: 'invalid_grant',
      error_description: 'Authorization code expired',
    },
  });
}

beforeEach(() => {
  stubMicrosoftEnv();
  // TASK-081 — default to "not configured" so provisioning behaviour never
  // depends on the shell environment; tests that exercise provisioning stub the
  // real value explicitly. Empty string counts as missing for loadEnv.
  vi.stubEnv('MICROSOFT_GRAPH_NOTIFICATION_URL', '');
  mailboxStore.length = 0;
  mailboxIdCounter = 0;
  subscriptionStore.length = 0;
  subscriptionIdCounter = 0;
  failMailboxWrites = false;
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
  it('redirects to /admin/mailboxes?oauth=success and never leaks tokens', async () => {
    const fetchMock = stubFetchTokenSuccess();
    const request = makeRequest(
      `code=${FAKE_CODE}&state=${FAKE_STATE}`,
      FAKE_STATE,
    );
    const response = await GET(request);

    expect([302, 303, 307, 308]).toContain(response.status);
    const loc = parseLocation(response.headers.get('location'));
    expect(loc.pathname).toBe('/admin/mailboxes');
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

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [tokenUrl, tokenInit] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(tokenUrl).toBe(
      `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`,
    );
    const parsed = new URLSearchParams(tokenInit.body as string);
    expect(parsed.get('code')).toBe(FAKE_CODE);
    expect(parsed.get('grant_type')).toBe('authorization_code');

    const [graphUrl, graphInit] = fetchMock.mock.calls[1] as unknown as [
      string,
      RequestInit,
    ];
    expect(graphUrl).toBe(GRAPH_ME_URL);
    expect((graphInit.headers as Record<string, string>).authorization).toBe(
      `Bearer ${FAKE_ACCESS_TOKEN}`,
    );

    expect(mailboxStore).toHaveLength(1);
    const saved = mailboxStore[0];
    expect(saved.emailAddress).toBe(FAKE_MAILBOX_EMAIL);
    expect(saved.provider).toBe('MICROSOFT');
    expect(saved.microsoftUserId).toBe(FAKE_MS_USER_ID);
    expect(saved.status).toBe('ACTIVE');
    expect(saved.encryptedRefreshToken).not.toBe(FAKE_REFRESH_TOKEN);
    expect(saved.encryptedRefreshToken).not.toContain(FAKE_REFRESH_TOKEN);

    expectClearedCookie(response);
  });
});

describe('GET callback — mailbox save behavior', () => {
  it('falls back to userPrincipalName when Graph /me returns mail=null', async () => {
    stubFetchRouter({
      graphPayload: {
        id: 'ms-user-upn-fallback',
        mail: null,
        userPrincipalName: 'fallback@hotmail.com',
        displayName: 'Fallback User',
      },
    });

    const request = makeRequest(
      `code=${FAKE_CODE}&state=${FAKE_STATE}`,
      FAKE_STATE,
    );
    const response = await GET(request);
    const loc = parseLocation(response.headers.get('location'));
    expect(loc.searchParams.get('oauth')).toBe('success');

    expect(mailboxStore).toHaveLength(1);
    expect(mailboxStore[0].emailAddress).toBe('fallback@hotmail.com');
  });

  it('redirects with reason=token_exchange_failed when refresh_token is missing', async () => {
    stubFetchRouter({
      tokenPayload: {
        token_type: 'Bearer',
        expires_in: 3599,
        access_token: FAKE_ACCESS_TOKEN,
        // no refresh_token — offline_access scope was not granted
      },
    });
    const request = makeRequest(
      `code=${FAKE_CODE}&state=${FAKE_STATE}`,
      FAKE_STATE,
    );
    const response = await GET(request);
    const loc = parseLocation(response.headers.get('location'));
    expect(loc.searchParams.get('reason')).toBe('token_exchange_failed');
    expect(mailboxStore).toHaveLength(0);
  });

  it('redirects with reason=mailbox_save_failed when Graph /me fails', async () => {
    stubFetchRouter({
      graphStatus: 401,
      graphPayload: { error: { code: 'unauthorized' } },
    });
    const request = makeRequest(
      `code=${FAKE_CODE}&state=${FAKE_STATE}`,
      FAKE_STATE,
    );
    const response = await GET(request);
    const loc = parseLocation(response.headers.get('location'));
    expect(loc.searchParams.get('reason')).toBe('mailbox_save_failed');
    expect(mailboxStore).toHaveLength(0);
  });

  it('redirects with reason=mailbox_save_failed when profile lacks any email surface', async () => {
    stubFetchRouter({
      graphPayload: {
        id: 'ms-user-no-email',
        mail: null,
        userPrincipalName: null,
        displayName: null,
      },
    });
    const request = makeRequest(
      `code=${FAKE_CODE}&state=${FAKE_STATE}`,
      FAKE_STATE,
    );
    const response = await GET(request);
    const loc = parseLocation(response.headers.get('location'));
    expect(loc.searchParams.get('reason')).toBe('mailbox_save_failed');
    expect(mailboxStore).toHaveLength(0);
  });

  it('does not leak refresh or access tokens in response when save succeeds', async () => {
    stubFetchRouter();
    const request = makeRequest(
      `code=${FAKE_CODE}&state=${FAKE_STATE}`,
      FAKE_STATE,
    );
    const response = await GET(request);

    const bodyText = await response.text();
    const fullSerialized = JSON.stringify({
      headers: Object.fromEntries(response.headers.entries()),
      body: bodyText,
    });
    expect(fullSerialized).not.toContain(FAKE_ACCESS_TOKEN);
    expect(fullSerialized).not.toContain(FAKE_REFRESH_TOKEN);
    expect(fullSerialized).not.toContain(FAKE_ID_TOKEN);
  });
});

describe('GET callback — reconnect target (TASK-069B)', () => {
  it('reconnects the targeted mailbox and preserves its customer assignment', async () => {
    stubFetchTokenSuccess();
    // Seed the broken mailbox the operator is reconnecting. Same identity as the
    // Graph profile the stub returns, so the account legitimately matches.
    mailboxStore.push({
      id: 'mb_target',
      emailAddress: FAKE_MAILBOX_EMAIL,
      provider: 'MICROSOFT',
      microsoftUserId: FAKE_MS_USER_ID,
      encryptedRefreshToken: 'stale-encrypted',
      status: 'RECONNECT_REQUIRED',
      tokenLastRefreshedAt: null,
      createdById: null,
      customerId: 'cust_keep_me',
    });

    const request = makeRequest(
      `code=${FAKE_CODE}&state=${FAKE_STATE}`,
      FAKE_STATE,
      'mb_target',
    );
    const response = await GET(request);

    const loc = parseLocation(response.headers.get('location'));
    expect(loc.searchParams.get('oauth')).toBe('success');

    expect(mailboxStore).toHaveLength(1);
    expect(mailboxStore[0].id).toBe('mb_target');
    expect(mailboxStore[0].status).toBe('ACTIVE');
    // Reconnect must not wipe the customer assignment or duplicate the mailbox.
    expect(mailboxStore[0].customerId).toBe('cust_keep_me');
    expect(mailboxStore[0].encryptedRefreshToken).not.toBe('stale-encrypted');
  });

  it('refuses with reason=mailbox_mismatch when a different account signs in, leaving the mailbox untouched', async () => {
    stubFetchTokenSuccess(); // Graph returns FAKE_MS_USER_ID / FAKE_MAILBOX_EMAIL
    // The mailbox being reconnected belongs to a DIFFERENT Microsoft account.
    mailboxStore.push({
      id: 'mb_other',
      emailAddress: 'different-owner@example.com',
      provider: 'MICROSOFT',
      microsoftUserId: 'ms-user-different',
      encryptedRefreshToken: 'original-encrypted',
      status: 'RECONNECT_REQUIRED',
      tokenLastRefreshedAt: null,
      createdById: null,
      customerId: 'cust_other',
    });

    const request = makeRequest(
      `code=${FAKE_CODE}&state=${FAKE_STATE}`,
      FAKE_STATE,
      'mb_other',
    );
    const response = await GET(request);

    const loc = parseLocation(response.headers.get('location'));
    expect(loc.pathname).toBe('/admin');
    expect(loc.searchParams.get('oauth')).toBe('error');
    expect(loc.searchParams.get('reason')).toBe('mailbox_mismatch');

    // The targeted mailbox is untouched and no stray mailbox was created.
    expect(mailboxStore).toHaveLength(1);
    expect(mailboxStore[0].id).toBe('mb_other');
    expect(mailboxStore[0].status).toBe('RECONNECT_REQUIRED');
    expect(mailboxStore[0].encryptedRefreshToken).toBe('original-encrypted');
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

describe('GET callback — Graph subscription provisioning (TASK-081)', () => {
  function stubNotificationUrlEnv() {
    vi.stubEnv('MICROSOFT_GRAPH_NOTIFICATION_URL', FAKE_NOTIFICATION_URL);
  }

  it('A. fresh connect provisions a subscription after the mailbox is saved', async () => {
    stubNotificationUrlEnv();
    const fetchMock = stubFetchRouter();
    const request = makeRequest(
      `code=${FAKE_CODE}&state=${FAKE_STATE}`,
      FAKE_STATE,
    );
    const response = await GET(request);

    const loc = parseLocation(response.headers.get('location'));
    expect(loc.searchParams.get('oauth')).toBe('success');

    // token exchange + /me + exactly ONE subscriptions POST.
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [subUrl, subInit] = fetchMock.mock.calls[2] as unknown as [
      string,
      RequestInit,
    ];
    expect(subUrl).toBe(GRAPH_SUBSCRIPTIONS_URL);
    expect(subInit.method).toBe('POST');
    expect((subInit.headers as Record<string, string>).authorization).toBe(
      `Bearer ${FAKE_ACCESS_TOKEN}`,
    );

    // Persisted row is renewal-compatible and stores only the hash.
    const sentClientState = (
      JSON.parse(subInit.body as string) as { clientState: string }
    ).clientState;
    expect(sentClientState.length).toBeGreaterThan(0);
    expect(mailboxStore).toHaveLength(1);
    expect(subscriptionStore).toHaveLength(1);
    const sub = subscriptionStore[0];
    expect(sub.mailboxId).toBe(mailboxStore[0].id);
    expect(sub.subscriptionId).toBe(FAKE_GRAPH_SUB_ID);
    expect(sub.status).toBe('ACTIVE');
    expect(sub.expirationDateTime.getTime()).toBeGreaterThan(Date.now());
    expect(sub.clientStateHash.length).toBeGreaterThan(0);
    expect(sub.clientStateHash).not.toBe(sentClientState);
    expect(sub.clientStateHash).not.toContain(sentClientState);
  });

  it('B. reconnect with a still-usable subscription does not create a duplicate', async () => {
    stubNotificationUrlEnv();
    const fetchMock = stubFetchRouter();
    mailboxStore.push({
      id: 'mb_target',
      emailAddress: FAKE_MAILBOX_EMAIL,
      provider: 'MICROSOFT',
      microsoftUserId: FAKE_MS_USER_ID,
      encryptedRefreshToken: 'stale-encrypted',
      status: 'RECONNECT_REQUIRED',
      tokenLastRefreshedAt: null,
      createdById: null,
    });
    subscriptionStore.push({
      id: 'gsub_seed',
      mailboxId: 'mb_target',
      subscriptionId: 'graph-sub-live',
      resource: "/me/mailFolders('Inbox')/messages",
      clientStateHash: 'seed-hash',
      expirationDateTime: new Date(Date.now() + 3 * 24 * 60 * 60 * 1000),
      status: 'ACTIVE',
      lastRenewedAt: null,
    });

    const request = makeRequest(
      `code=${FAKE_CODE}&state=${FAKE_STATE}`,
      FAKE_STATE,
      'mb_target',
    );
    const response = await GET(request);

    const loc = parseLocation(response.headers.get('location'));
    expect(loc.searchParams.get('oauth')).toBe('success');
    // No subscriptions POST — only token exchange + /me.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(subscriptionStore).toHaveLength(1);
    expect(subscriptionStore[0].subscriptionId).toBe('graph-sub-live');
  });

  it('G. provisioning failure is fail-open: connect still succeeds, mailbox intact', async () => {
    stubNotificationUrlEnv();
    stubFetchRouter({
      subscriptionsStatus: 403,
      subscriptionsPayload: { error: { code: 'AccessDenied' } },
    });
    const request = makeRequest(
      `code=${FAKE_CODE}&state=${FAKE_STATE}`,
      FAKE_STATE,
    );
    const response = await GET(request);

    // The connect is still a success — no rollback, no error reason.
    const loc = parseLocation(response.headers.get('location'));
    expect(loc.pathname).toBe('/admin/mailboxes');
    expect(loc.searchParams.get('oauth')).toBe('success');
    expect(loc.searchParams.get('reason')).toBeNull();

    expect(mailboxStore).toHaveLength(1);
    expect(mailboxStore[0].status).toBe('ACTIVE');
    expect(mailboxStore[0].encryptedRefreshToken.length).toBeGreaterThan(0);
    expect(subscriptionStore).toHaveLength(0);
  });

  it('fail-open also when the notification URL is not configured', async () => {
    // No MICROSOFT_GRAPH_NOTIFICATION_URL stub — provisioning fails at config.
    const fetchMock = stubFetchRouter();
    const request = makeRequest(
      `code=${FAKE_CODE}&state=${FAKE_STATE}`,
      FAKE_STATE,
    );
    const response = await GET(request);

    const loc = parseLocation(response.headers.get('location'));
    expect(loc.searchParams.get('oauth')).toBe('success');
    // Config failure happens before any subscriptions HTTP call.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mailboxStore).toHaveLength(1);
    expect(subscriptionStore).toHaveLength(0);
  });

  it('E. mailbox save failure → provisioning is never attempted', async () => {
    stubNotificationUrlEnv();
    const fetchMock = stubFetchRouter();
    failMailboxWrites = true;

    const request = makeRequest(
      `code=${FAKE_CODE}&state=${FAKE_STATE}`,
      FAKE_STATE,
    );
    const response = await GET(request);

    const loc = parseLocation(response.headers.get('location'));
    expect(loc.searchParams.get('oauth')).toBe('error');
    expect(loc.searchParams.get('reason')).toBe('mailbox_save_failed');
    // token exchange + /me only — no subscriptions POST.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(subscriptionStore).toHaveLength(0);
  });

  it('F. wrong-account reconnect fails before provisioning — no subscription call', async () => {
    stubNotificationUrlEnv();
    const fetchMock = stubFetchRouter(); // Graph /me returns FAKE_MS_USER_ID
    mailboxStore.push({
      id: 'mb_other',
      emailAddress: 'different-owner@example.com',
      provider: 'MICROSOFT',
      microsoftUserId: 'ms-user-different',
      encryptedRefreshToken: 'original-encrypted',
      status: 'RECONNECT_REQUIRED',
      tokenLastRefreshedAt: null,
      createdById: null,
    });

    const request = makeRequest(
      `code=${FAKE_CODE}&state=${FAKE_STATE}`,
      FAKE_STATE,
      'mb_other',
    );
    const response = await GET(request);

    const loc = parseLocation(response.headers.get('location'));
    expect(loc.searchParams.get('reason')).toBe('mailbox_mismatch');
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(subscriptionStore).toHaveLength(0);
    // The targeted mailbox is untouched.
    expect(mailboxStore[0].encryptedRefreshToken).toBe('original-encrypted');
    expect(mailboxStore[0].status).toBe('RECONNECT_REQUIRED');
  });
});
