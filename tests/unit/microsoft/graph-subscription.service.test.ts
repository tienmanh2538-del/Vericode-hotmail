import { describe, it, expect, vi } from 'vitest';
import {
  GraphSubscriptionError,
  __internal,
  buildCreateSubscriptionPayload,
  calculateDefaultSubscriptionExpiration,
  createInboxSubscription,
  deleteGraphSubscription,
  generateClientState,
  hashClientState,
  renewGraphSubscription,
  verifyGraphClientState,
  type GraphSubscriptionStatus,
  type PrismaClientLike,
} from '@/services/microsoft/graph-subscription.service';
import { hashSensitiveValue } from '@/lib/security/redact';

const ACCESS_TOKEN = 'fake-access-token-do-not-leak';
const NOTIFICATION_URL = 'https://example.com/api/webhooks/microsoft/mail';
const LIFECYCLE_URL = 'https://example.com/api/webhooks/microsoft/lifecycle';
const SUBSCRIPTIONS_URL = 'https://graph.microsoft.com/v1.0/subscriptions';

interface StoredSubscription {
  id: string;
  mailboxId: string;
  subscriptionId: string;
  resource: string;
  clientStateHash: string;
  expirationDateTime: Date;
  status: GraphSubscriptionStatus;
  lastRenewedAt: Date | null;
}

function createFakePrisma(): {
  prisma: PrismaClientLike;
  store: StoredSubscription[];
} {
  const store: StoredSubscription[] = [];
  let counter = 0;
  const prisma: PrismaClientLike = {
    graphSubscription: {
      async create({ data }) {
        counter += 1;
        const record: StoredSubscription = {
          id: `sub_${counter}`,
          mailboxId: data.mailboxId,
          subscriptionId: data.subscriptionId,
          resource: data.resource,
          clientStateHash: data.clientStateHash,
          expirationDateTime: data.expirationDateTime,
          status: data.status,
          lastRenewedAt: null,
        };
        store.push(record);
        return { ...record };
      },
      async update({ where, data }) {
        const target = store.find((r) => r.subscriptionId === where.subscriptionId);
        if (!target) throw new Error('not found');
        if (data.expirationDateTime !== undefined) {
          target.expirationDateTime = data.expirationDateTime;
        }
        if (data.status !== undefined) target.status = data.status;
        if (data.lastRenewedAt !== undefined) {
          target.lastRenewedAt = data.lastRenewedAt;
        }
        return { ...target };
      },
      async findUnique({ where }) {
        return (
          store.find((r) => r.subscriptionId === where.subscriptionId) ?? null
        );
      },
    },
  };
  return { prisma, store };
}

function jsonResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function emptyResponse(status = 204) {
  return new Response(null, { status });
}

function captureFirstCall(
  fetchMock: ReturnType<typeof vi.fn>,
): { url: string; init: RequestInit } {
  expect(fetchMock).toHaveBeenCalled();
  const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return { url, init };
}

// ---------------------------------------------------------------------------
// generateClientState / hashClientState / verifyGraphClientState
// ---------------------------------------------------------------------------

describe('generateClientState', () => {
  it('returns a non-empty string within the 128 character cap', () => {
    const value = generateClientState();
    expect(typeof value).toBe('string');
    expect(value.length).toBeGreaterThan(0);
    expect(value.length).toBeLessThanOrEqual(__internal.CLIENT_STATE_MAX_LENGTH);
  });

  it('produces a different value each invocation', () => {
    const values = new Set<string>();
    for (let i = 0; i < 16; i += 1) {
      values.add(generateClientState());
    }
    expect(values.size).toBe(16);
  });
});

describe('hashClientState / verifyGraphClientState', () => {
  it('produces a SHA-256 hash that matches the project-wide helper', () => {
    const plain = 'top-secret-client-state';
    expect(hashClientState(plain)).toBe(hashSensitiveValue(plain));
  });

  it('verifies a matching plaintext against its stored hash', () => {
    const plain = generateClientState();
    const hash = hashClientState(plain);
    expect(verifyGraphClientState(plain, hash)).toBe(true);
  });

  it('rejects a non-matching plaintext', () => {
    const stored = hashClientState('expected-value');
    expect(verifyGraphClientState('something-else', stored)).toBe(false);
  });

  it('rejects empty or malformed input safely', () => {
    expect(verifyGraphClientState('', 'anything')).toBe(false);
    expect(verifyGraphClientState('value', '')).toBe(false);
  });

  it('throws validation error if hashing an empty string is attempted', () => {
    expect(() => hashClientState('')).toThrow(GraphSubscriptionError);
  });
});

// ---------------------------------------------------------------------------
// calculateDefaultSubscriptionExpiration
// ---------------------------------------------------------------------------

describe('calculateDefaultSubscriptionExpiration', () => {
  it('returns a date in the future', () => {
    const now = new Date('2026-05-29T00:00:00.000Z');
    const expiration = calculateDefaultSubscriptionExpiration(now);
    expect(expiration.getTime()).toBeGreaterThan(now.getTime());
  });

  it('stays within the safe 7-day Outlook ceiling', () => {
    const now = new Date('2026-05-29T00:00:00.000Z');
    const expiration = calculateDefaultSubscriptionExpiration(now);
    const diffMs = expiration.getTime() - now.getTime();
    const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
    expect(diffMs).toBeLessThanOrEqual(sevenDaysMs);
    // And it should be meaningfully buffered below the ceiling.
    expect(diffMs).toBeLessThan(sevenDaysMs);
  });

  it('toISOString of the result is a valid ISO UTC string', () => {
    const now = new Date('2026-05-29T00:00:00.000Z');
    const iso = calculateDefaultSubscriptionExpiration(now).toISOString();
    expect(iso).toMatch(/Z$/);
    expect(Number.isNaN(new Date(iso).getTime())).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildCreateSubscriptionPayload
// ---------------------------------------------------------------------------

describe('buildCreateSubscriptionPayload', () => {
  const baseInput = {
    notificationUrl: NOTIFICATION_URL,
    expirationDateTime: new Date('2026-06-04T00:00:00.000Z'),
    clientState: 'state-1234',
  };

  it('produces the exact Microsoft Graph payload shape', () => {
    const payload = buildCreateSubscriptionPayload(baseInput);
    expect(payload).toEqual({
      changeType: 'created',
      notificationUrl: NOTIFICATION_URL,
      resource: "/me/mailFolders('Inbox')/messages",
      expirationDateTime: '2026-06-04T00:00:00.000Z',
      clientState: 'state-1234',
    });
  });

  it('includes lifecycleNotificationUrl when provided', () => {
    const payload = buildCreateSubscriptionPayload({
      ...baseInput,
      lifecycleNotificationUrl: LIFECYCLE_URL,
    });
    expect(payload.lifecycleNotificationUrl).toBe(LIFECYCLE_URL);
  });

  it('omits lifecycleNotificationUrl when empty', () => {
    const payload = buildCreateSubscriptionPayload({
      ...baseInput,
      lifecycleNotificationUrl: '',
    });
    expect(payload.lifecycleNotificationUrl).toBeUndefined();
  });

  it('throws config error when notificationUrl is missing', () => {
    expect(() =>
      buildCreateSubscriptionPayload({ ...baseInput, notificationUrl: '' }),
    ).toThrowError(GraphSubscriptionError);
  });

  it('throws validation error when clientState is too long', () => {
    const oversized = 'x'.repeat(__internal.CLIENT_STATE_MAX_LENGTH + 1);
    expect(() =>
      buildCreateSubscriptionPayload({ ...baseInput, clientState: oversized }),
    ).toThrowError(GraphSubscriptionError);
  });
});

// ---------------------------------------------------------------------------
// createInboxSubscription
// ---------------------------------------------------------------------------

describe('createInboxSubscription — happy path', () => {
  it('POSTs to /subscriptions with Bearer auth and JSON body', async () => {
    const { prisma, store } = createFakePrisma();
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          id: 'graph-sub-1',
          resource: "/me/mailFolders('Inbox')/messages",
          expirationDateTime: '2026-06-04T00:00:00.000Z',
          changeType: 'created',
        },
        201,
      ),
    );

    const result = await createInboxSubscription(
      {
        mailboxId: 'mb_1',
        accessToken: ACCESS_TOKEN,
        notificationUrl: NOTIFICATION_URL,
        now: new Date('2026-05-29T00:00:00.000Z'),
      },
      { prisma, fetchImpl: fetchMock as unknown as typeof fetch },
    );

    const { url, init } = captureFirstCall(fetchMock);
    expect(url).toBe(SUBSCRIPTIONS_URL);
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headers['content-type']).toBe('application/json');

    const body = JSON.parse(init.body as string);
    expect(body.changeType).toBe('created');
    expect(body.resource).toBe("/me/mailFolders('Inbox')/messages");
    expect(body.notificationUrl).toBe(NOTIFICATION_URL);
    expect(typeof body.expirationDateTime).toBe('string');
    expect(typeof body.clientState).toBe('string');
    expect(body.clientState.length).toBeGreaterThan(0);
    expect(body.clientState.length).toBeLessThanOrEqual(
      __internal.CLIENT_STATE_MAX_LENGTH,
    );

    expect(result.subscriptionId).toBe('graph-sub-1');
    expect(result.status).toBe('ACTIVE');
    expect(store).toHaveLength(1);
    expect(store[0].subscriptionId).toBe('graph-sub-1');
    expect(store[0].resource).toBe("/me/mailFolders('Inbox')/messages");
    expect(store[0].status).toBe('ACTIVE');
  });

  it('persists clientStateHash and never stores the plaintext clientState', async () => {
    const { prisma, store } = createFakePrisma();
    let sentClientState = '';
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      sentClientState = body.clientState;
      return jsonResponse({ id: 'graph-sub-2' }, 201);
    });

    await createInboxSubscription(
      {
        mailboxId: 'mb_2',
        accessToken: ACCESS_TOKEN,
        notificationUrl: NOTIFICATION_URL,
      },
      { prisma, fetchImpl: fetchMock as unknown as typeof fetch },
    );

    expect(sentClientState.length).toBeGreaterThan(0);
    const saved = store[0];
    expect(saved.clientStateHash).toBe(hashSensitiveValue(sentClientState));
    expect(saved.clientStateHash).not.toBe(sentClientState);

    const serializedStore = JSON.stringify(store);
    expect(serializedStore).not.toContain(sentClientState);
  });

  it('falls back to env-provided notificationUrl when input does not set it', async () => {
    const { prisma } = createFakePrisma();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.notificationUrl).toBe(NOTIFICATION_URL);
      expect(body.lifecycleNotificationUrl).toBe(LIFECYCLE_URL);
      return jsonResponse({ id: 'graph-sub-3' }, 201);
    });

    await createInboxSubscription(
      { mailboxId: 'mb_3', accessToken: ACCESS_TOKEN },
      {
        prisma,
        fetchImpl: fetchMock as unknown as typeof fetch,
        env: {
          APP_ENV: 'test',
          APP_URL: 'http://localhost:3000',
          LOG_LEVEL: 'info',
          MICROSOFT_GRAPH_NOTIFICATION_URL: NOTIFICATION_URL,
          MICROSOFT_GRAPH_LIFECYCLE_NOTIFICATION_URL: LIFECYCLE_URL,
        },
      },
    );
  });

  it('sends expirationDateTime as an ISO UTC string', async () => {
    const { prisma } = createFakePrisma();
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      expect(body.expirationDateTime).toMatch(/T.*Z$/);
      return jsonResponse({ id: 'graph-sub-4' }, 201);
    });

    await createInboxSubscription(
      {
        mailboxId: 'mb_4',
        accessToken: ACCESS_TOKEN,
        notificationUrl: NOTIFICATION_URL,
        now: new Date('2026-05-29T00:00:00.000Z'),
      },
      { prisma, fetchImpl: fetchMock as unknown as typeof fetch },
    );
  });
});

describe('createInboxSubscription — validation and config', () => {
  it('throws config error when notificationUrl is missing in input AND env', async () => {
    const { prisma, store } = createFakePrisma();
    const fetchMock = vi.fn(async () => jsonResponse({}, 201));

    await expect(
      createInboxSubscription(
        { mailboxId: 'mb_5', accessToken: ACCESS_TOKEN },
        {
          prisma,
          fetchImpl: fetchMock as unknown as typeof fetch,
          env: {
            APP_ENV: 'test',
            APP_URL: 'http://localhost:3000',
            LOG_LEVEL: 'info',
          },
        },
      ),
    ).rejects.toMatchObject({ kind: 'config' });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(store).toHaveLength(0);
  });

  it('throws validation error when mailboxId is empty', async () => {
    const { prisma } = createFakePrisma();
    const fetchMock = vi.fn(async () => jsonResponse({}, 201));
    await expect(
      createInboxSubscription(
        {
          mailboxId: '',
          accessToken: ACCESS_TOKEN,
          notificationUrl: NOTIFICATION_URL,
        },
        { prisma, fetchImpl: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ kind: 'validation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws validation error when access token is empty', async () => {
    const { prisma } = createFakePrisma();
    const fetchMock = vi.fn(async () => jsonResponse({}, 201));
    await expect(
      createInboxSubscription(
        {
          mailboxId: 'mb_6',
          accessToken: '',
          notificationUrl: NOTIFICATION_URL,
        },
        { prisma, fetchImpl: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ kind: 'validation' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('createInboxSubscription — Graph HTTP errors map to safe kinds', () => {
  it('401 → kind=auth without leaking the access token', async () => {
    const { prisma } = createFakePrisma();
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: { code: 'InvalidAuthenticationToken' } }, 401),
    );
    try {
      await createInboxSubscription(
        {
          mailboxId: 'mb_7',
          accessToken: ACCESS_TOKEN,
          notificationUrl: NOTIFICATION_URL,
        },
        { prisma, fetchImpl: fetchMock as unknown as typeof fetch },
      );
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GraphSubscriptionError);
      const e = err as GraphSubscriptionError;
      expect(e.kind).toBe('auth');
      expect(e.httpStatus).toBe(401);
      const serialized = JSON.stringify({
        message: e.message,
        kind: e.kind,
        httpStatus: e.httpStatus,
        graphErrorCode: e.graphErrorCode,
      });
      expect(serialized).not.toContain(ACCESS_TOKEN);
    }
  });

  it('403 → kind=permission', async () => {
    const { prisma } = createFakePrisma();
    const fetchMock = vi.fn(async () => jsonResponse({}, 403));
    await expect(
      createInboxSubscription(
        {
          mailboxId: 'mb_8',
          accessToken: ACCESS_TOKEN,
          notificationUrl: NOTIFICATION_URL,
        },
        { prisma, fetchImpl: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ kind: 'permission', httpStatus: 403 });
  });

  it('400 + InvalidRequest → kind=webhook_validation', async () => {
    const { prisma } = createFakePrisma();
    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          error: {
            code: 'InvalidRequest',
            message: 'Subscription validation request failed',
          },
        },
        400,
      ),
    );
    await expect(
      createInboxSubscription(
        {
          mailboxId: 'mb_9',
          accessToken: ACCESS_TOKEN,
          notificationUrl: NOTIFICATION_URL,
        },
        { prisma, fetchImpl: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({
      kind: 'webhook_validation',
      httpStatus: 400,
    });
  });

  it('500 → kind=temporary', async () => {
    const { prisma } = createFakePrisma();
    const fetchMock = vi.fn(async () => jsonResponse({}, 500));
    await expect(
      createInboxSubscription(
        {
          mailboxId: 'mb_10',
          accessToken: ACCESS_TOKEN,
          notificationUrl: NOTIFICATION_URL,
        },
        { prisma, fetchImpl: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ kind: 'temporary', httpStatus: 500 });
  });

  it('network error → kind=network and does not leak the token', async () => {
    const { prisma } = createFakePrisma();
    const fetchMock = vi.fn(async () => {
      throw new Error(`underlying transport failure with ${ACCESS_TOKEN}`);
    });

    try {
      await createInboxSubscription(
        {
          mailboxId: 'mb_11',
          accessToken: ACCESS_TOKEN,
          notificationUrl: NOTIFICATION_URL,
        },
        { prisma, fetchImpl: fetchMock as unknown as typeof fetch },
      );
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as GraphSubscriptionError;
      expect(e.kind).toBe('network');
      expect(JSON.stringify({ msg: e.message })).not.toContain(ACCESS_TOKEN);
    }
  });

  it('throws parse error when 201 response has no subscription id', async () => {
    const { prisma } = createFakePrisma();
    const fetchMock = vi.fn(async () => jsonResponse({ noId: true }, 201));
    await expect(
      createInboxSubscription(
        {
          mailboxId: 'mb_12',
          accessToken: ACCESS_TOKEN,
          notificationUrl: NOTIFICATION_URL,
        },
        { prisma, fetchImpl: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ kind: 'parse' });
  });
});

describe('createInboxSubscription — secret hygiene', () => {
  it('does not log the access token or the clientState plaintext on success', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const consoleInfoSpy = vi
      .spyOn(console, 'info')
      .mockImplementation(() => undefined);
    const consoleDebugSpy = vi
      .spyOn(console, 'debug')
      .mockImplementation(() => undefined);

    const { prisma } = createFakePrisma();
    let sentClientState = '';
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(init.body as string);
      sentClientState = body.clientState;
      return jsonResponse({ id: 'graph-sub-secret' }, 201);
    });

    await createInboxSubscription(
      {
        mailboxId: 'mb_secret',
        accessToken: ACCESS_TOKEN,
        notificationUrl: NOTIFICATION_URL,
      },
      { prisma, fetchImpl: fetchMock as unknown as typeof fetch },
    );

    const serialized = JSON.stringify([
      ...consoleErrorSpy.mock.calls,
      ...consoleWarnSpy.mock.calls,
      ...consoleInfoSpy.mock.calls,
      ...consoleDebugSpy.mock.calls,
    ]);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(sentClientState);

    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
    consoleInfoSpy.mockRestore();
    consoleDebugSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// renewGraphSubscription
// ---------------------------------------------------------------------------

describe('renewGraphSubscription (TASK-084 — thin PATCH adapter, no DB writes)', () => {
  it('PATCHes the subscription and returns the remote expiration without touching the DB', async () => {
    const { prisma, store } = createFakePrisma();
    store.push({
      id: 'sub_seed',
      mailboxId: 'mb_renew',
      subscriptionId: 'graph-sub-renew',
      resource: "/me/mailFolders('Inbox')/messages",
      clientStateHash: hashSensitiveValue('seed-state'),
      expirationDateTime: new Date('2026-05-30T00:00:00.000Z'),
      status: 'ACTIVE',
      lastRenewedAt: null,
    });

    const fetchMock = vi.fn(async () =>
      jsonResponse(
        {
          id: 'graph-sub-renew',
          expirationDateTime: '2026-06-04T00:00:00.000Z',
        },
        200,
      ),
    );

    const now = new Date('2026-05-29T00:00:00.000Z');
    const result = await renewGraphSubscription(
      {
        mailboxId: 'mb_renew',
        subscriptionId: 'graph-sub-renew',
        accessToken: ACCESS_TOKEN,
        now,
      },
      { prisma, fetchImpl: fetchMock as unknown as typeof fetch },
    );

    const { url, init } = captureFirstCall(fetchMock);
    expect(url).toBe(`${SUBSCRIPTIONS_URL}/graph-sub-renew`);
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(init.body as string);
    expect(typeof body.expirationDateTime).toBe('string');

    // Returns the parsed remote expiration; ownership/state persistence is the
    // renewal repository layer's job now (CAS), so the DB row is left untouched.
    expect(result).toEqual({
      subscriptionId: 'graph-sub-renew',
      expirationDateTime: new Date('2026-06-04T00:00:00.000Z'),
    });
    expect(store[0].status).toBe('ACTIVE');
    expect(store[0].lastRenewedAt).toBeNull();
  });

  it('propagates the classified Graph error without writing FAILED locally', async () => {
    const { prisma, store } = createFakePrisma();
    store.push({
      id: 'sub_seed_fail',
      mailboxId: 'mb_renew_fail',
      subscriptionId: 'graph-sub-fail',
      resource: "/me/mailFolders('Inbox')/messages",
      clientStateHash: hashSensitiveValue('seed-state'),
      expirationDateTime: new Date('2026-05-30T00:00:00.000Z'),
      status: 'ACTIVE',
      lastRenewedAt: null,
    });

    const fetchMock = vi.fn(async () => jsonResponse({}, 401));

    await expect(
      renewGraphSubscription(
        {
          mailboxId: 'mb_renew_fail',
          subscriptionId: 'graph-sub-fail',
          accessToken: ACCESS_TOKEN,
        },
        { prisma, fetchImpl: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toMatchObject({ kind: 'auth' });

    // No local FAILED write — the service classifies the error and applies the
    // CAS completion instead.
    expect(store[0].status).toBe('ACTIVE');
  });
});

// ---------------------------------------------------------------------------
// deleteGraphSubscription
// ---------------------------------------------------------------------------

describe('deleteGraphSubscription', () => {
  it('DELETEs the subscription and marks DB as EXPIRED', async () => {
    const { prisma, store } = createFakePrisma();
    store.push({
      id: 'sub_del',
      mailboxId: 'mb_del',
      subscriptionId: 'graph-sub-del',
      resource: "/me/mailFolders('Inbox')/messages",
      clientStateHash: hashSensitiveValue('seed-state'),
      expirationDateTime: new Date('2026-05-30T00:00:00.000Z'),
      status: 'ACTIVE',
      lastRenewedAt: null,
    });

    const fetchMock = vi.fn(async () => emptyResponse(204));

    await deleteGraphSubscription(
      {
        mailboxId: 'mb_del',
        subscriptionId: 'graph-sub-del',
        accessToken: ACCESS_TOKEN,
      },
      { prisma, fetchImpl: fetchMock as unknown as typeof fetch },
    );

    const { url, init } = captureFirstCall(fetchMock);
    expect(url).toBe(`${SUBSCRIPTIONS_URL}/graph-sub-del`);
    expect(init.method).toBe('DELETE');
    expect(store[0].status).toBe('EXPIRED');
  });

  it('converges to EXPIRED even when Graph already 404s the subscription', async () => {
    const { prisma, store } = createFakePrisma();
    store.push({
      id: 'sub_gone',
      mailboxId: 'mb_gone',
      subscriptionId: 'graph-sub-gone',
      resource: "/me/mailFolders('Inbox')/messages",
      clientStateHash: hashSensitiveValue('seed-state'),
      expirationDateTime: new Date('2026-05-30T00:00:00.000Z'),
      status: 'ACTIVE',
      lastRenewedAt: null,
    });

    const fetchMock = vi.fn(async () => jsonResponse({}, 404));

    await deleteGraphSubscription(
      {
        mailboxId: 'mb_gone',
        subscriptionId: 'graph-sub-gone',
        accessToken: ACCESS_TOKEN,
      },
      { prisma, fetchImpl: fetchMock as unknown as typeof fetch },
    );

    expect(store[0].status).toBe('EXPIRED');
  });
});
