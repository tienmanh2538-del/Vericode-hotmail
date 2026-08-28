// TASK-086 — conflict classification at the Graph service boundary.
//
// Two failure classes must never be confused:
//   * a LOCAL unique-constraint violation on the live-per-mailbox partial index
//     → ownership loss (our remote subscription is released, the winner is not
//     touched, and the caller gets a controlled outcome);
//   * anything else that breaks the local persist → generic database failure,
//     keeping TASK-081's compensation + fail-open semantics.
//
// Microsoft's documented 409 for duplicate subscriptions is classified too, but
// only as DEFENSIVE handling — local uniqueness is the correctness boundary.
//
// The Prisma error used here is the REAL `Prisma.PrismaClientKnownRequestError`
// from the generated client, so the recognition helpers are proven against the
// actual error shape of the Prisma version this repo pins — not a hand-made
// look-alike.

import { describe, it, expect, vi } from 'vitest';
import { Prisma } from '@prisma/client';

import {
  createInboxSubscription,
  GRAPH_SUBSCRIPTION_LIVE_UNIQUE_INDEX,
  type PrismaClientLike,
} from '@/services/microsoft/graph-subscription.service';
import {
  isUniqueConstraintError,
  uniqueConstraintTargetIncludes,
} from '@/lib/db/prisma-error';

const ACCESS_TOKEN = 'fake-access-token-do-not-leak';
const NOTIFICATION_URL = 'https://example.com/api/webhooks/microsoft/mail';
const SUBSCRIPTIONS_URL = 'https://graph.microsoft.com/v1.0/subscriptions';
const REMOTE_SUB_ID = 'graph-sub-loser-1';

function knownRequestError(target: string | string[]) {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed',
    {
      code: 'P2002',
      clientVersion: Prisma.prismaVersion.client,
      meta: { target },
    },
  );
}

/** Prisma fake whose INSERT always fails with the supplied error. */
function persistFailsWith(error: unknown): PrismaClientLike {
  return {
    graphSubscription: {
      async create() {
        throw error;
      },
      async update() {
        return null as never;
      },
      async findUnique() {
        return null;
      },
    },
  };
}

interface RecordedCall {
  method: string;
  url: string;
}

function subscriptionFetch(postStatus: number) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    if (method === 'POST') {
      if (postStatus !== 201) {
        return new Response(
          JSON.stringify({ error: { code: 'ObjectAlreadyExists' } }),
          { status: postStatus, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response(
        JSON.stringify({
          id: REMOTE_SUB_ID,
          resource: "/me/mailFolders('Inbox')/messages",
          expirationDateTime: new Date(
            Date.now() + 6 * 24 * 60 * 60 * 1000,
          ).toISOString(),
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }
    if (method === 'DELETE') return new Response(null, { status: 204 });
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
  return { fetchMock, calls };
}

describe('TASK-086 — Prisma error recognition helpers (actual Prisma error)', () => {
  it('recognises a real P2002 carrying the live-slot index name', () => {
    const err = knownRequestError(GRAPH_SUBSCRIPTION_LIVE_UNIQUE_INDEX);
    expect(isUniqueConstraintError(err)).toBe(true);
    expect(
      uniqueConstraintTargetIncludes(err, GRAPH_SUBSCRIPTION_LIVE_UNIQUE_INDEX),
    ).toBe(true);
  });

  it('does not confuse a subscriptionId unique violation with the live-slot index', () => {
    const err = knownRequestError(['subscriptionId']);
    expect(isUniqueConstraintError(err)).toBe(true);
    expect(
      uniqueConstraintTargetIncludes(err, GRAPH_SUBSCRIPTION_LIVE_UNIQUE_INDEX),
    ).toBe(false);
  });

  it('a non-P2002 Prisma error is not a unique violation', () => {
    const err = new Prisma.PrismaClientKnownRequestError('timeout', {
      code: 'P2024',
      clientVersion: Prisma.prismaVersion.client,
    });
    expect(isUniqueConstraintError(err)).toBe(false);
  });
});

describe('createInboxSubscription — local live-slot conflict (TASK-086)', () => {
  it('P2002 on the live-slot index → ownership_conflict, exactly one DELETE of OUR subscription', async () => {
    const { fetchMock, calls } = subscriptionFetch(201);

    await expect(
      createInboxSubscription(
        {
          mailboxId: 'mb_loser',
          accessToken: ACCESS_TOKEN,
          notificationUrl: NOTIFICATION_URL,
        },
        {
          prisma: persistFailsWith(
            knownRequestError(GRAPH_SUBSCRIPTION_LIVE_UNIQUE_INDEX),
          ),
          fetchImpl: fetchMock as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ kind: 'ownership_conflict' });

    // POST + exactly one compensating DELETE, targeting our own id only.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls[0]).toEqual({ method: 'POST', url: SUBSCRIPTIONS_URL });
    expect(calls[1]).toEqual({
      method: 'DELETE',
      url: `${SUBSCRIPTIONS_URL}/${encodeURIComponent(REMOTE_SUB_ID)}`,
    });
  });

  it('P2002 on subscriptionId is a generic database failure, not ownership loss', async () => {
    const { fetchMock } = subscriptionFetch(201);

    await expect(
      createInboxSubscription(
        {
          mailboxId: 'mb_dup_id',
          accessToken: ACCESS_TOKEN,
          notificationUrl: NOTIFICATION_URL,
        },
        {
          prisma: persistFailsWith(knownRequestError(['subscriptionId'])),
          fetchImpl: fetchMock as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ kind: 'database' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a non-unique DB failure keeps the TASK-081 database semantics', async () => {
    const { fetchMock } = subscriptionFetch(201);

    await expect(
      createInboxSubscription(
        {
          mailboxId: 'mb_generic',
          accessToken: ACCESS_TOKEN,
          notificationUrl: NOTIFICATION_URL,
        },
        {
          prisma: persistFailsWith(new Error('connection reset')),
          fetchImpl: fetchMock as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ kind: 'database' });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not leak the access token or the raw DB error when losing the slot', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const { fetchMock } = subscriptionFetch(201);

    await expect(
      createInboxSubscription(
        {
          mailboxId: 'mb_quiet',
          accessToken: ACCESS_TOKEN,
          notificationUrl: NOTIFICATION_URL,
        },
        {
          prisma: persistFailsWith(
            knownRequestError(GRAPH_SUBSCRIPTION_LIVE_UNIQUE_INDEX),
          ),
          fetchImpl: fetchMock as unknown as typeof fetch,
        },
      ),
    ).rejects.toBeTruthy();

    const serialized = JSON.stringify([
      ...errorSpy.mock.calls,
      ...warnSpy.mock.calls,
      ...infoSpy.mock.calls,
      ...logSpy.mock.calls,
    ]);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain('Unique constraint failed');
    vi.restoreAllMocks();
  });
});

describe('createInboxSubscription — Microsoft 409 (defensive classification)', () => {
  it('maps HTTP 409 to kind=conflict and never attempts a delete', async () => {
    const { fetchMock, calls } = subscriptionFetch(409);

    await expect(
      createInboxSubscription(
        {
          mailboxId: 'mb_409',
          accessToken: ACCESS_TOKEN,
          notificationUrl: NOTIFICATION_URL,
        },
        {
          prisma: persistFailsWith(new Error('must not be reached')),
          fetchImpl: fetchMock as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ kind: 'conflict', httpStatus: 409 });

    // No subscription was created remotely, so there is nothing to compensate.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
});
