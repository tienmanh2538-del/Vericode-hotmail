// TASK-081 — remote/local consistency: when Microsoft creates the subscription
// but the local DB persist fails, createInboxSubscription must attempt exactly
// one best-effort compensating remote DELETE and then surface the database
// error. No retries, no fake local ACTIVE row, sanitized logging only.

import { describe, it, expect, vi } from 'vitest';
import {
  createInboxSubscription,
  type PrismaClientLike,
} from '@/services/microsoft/graph-subscription.service';

const ACCESS_TOKEN = 'fake-access-token-do-not-leak';
const NOTIFICATION_URL = 'https://example.com/api/webhooks/microsoft/mail';
const SUBSCRIPTIONS_URL = 'https://graph.microsoft.com/v1.0/subscriptions';
const REMOTE_SUB_ID = 'graph-sub-orphan-1';

// Prisma fake where create always fails and no row ever exists (so the delete
// path's local status update also fails — mirroring the real orphan scenario).
function failingPersistPrisma(): PrismaClientLike {
  return {
    graphSubscription: {
      async create() {
        throw new Error('db write failed');
      },
      async update() {
        throw new Error('record not found');
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

function subscriptionFetch(deleteStatus: number) {
  const calls: RecordedCall[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ method, url });
    if (method === 'POST' && url === SUBSCRIPTIONS_URL) {
      return new Response(
        JSON.stringify({
          id: REMOTE_SUB_ID,
          resource: "/me/mailFolders('Inbox')/messages",
          expirationDateTime: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000).toISOString(),
        }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      );
    }
    if (method === 'DELETE') {
      return new Response(null, { status: deleteStatus });
    }
    throw new Error(`unexpected fetch ${method} ${url}`);
  });
  return { fetchMock, calls };
}

describe('createInboxSubscription — compensating remote delete (TASK-081)', () => {
  it('I. remote create success + local persist failure → one remote DELETE, database error thrown', async () => {
    const { fetchMock, calls } = subscriptionFetch(204);

    await expect(
      createInboxSubscription(
        {
          mailboxId: 'mb_comp',
          accessToken: ACCESS_TOKEN,
          notificationUrl: NOTIFICATION_URL,
        },
        {
          prisma: failingPersistPrisma(),
          fetchImpl: fetchMock as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ kind: 'database' });

    // Exactly two HTTP calls: the create POST and one compensating DELETE.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(calls[0]).toEqual({ method: 'POST', url: SUBSCRIPTIONS_URL });
    expect(calls[1].method).toBe('DELETE');
    expect(calls[1].url).toBe(
      `${SUBSCRIPTIONS_URL}/${encodeURIComponent(REMOTE_SUB_ID)}`,
    );
  });

  it('J. compensating DELETE also fails → attempted once, still terminates with the database error', async () => {
    const { fetchMock, calls } = subscriptionFetch(500);

    await expect(
      createInboxSubscription(
        {
          mailboxId: 'mb_comp2',
          accessToken: ACCESS_TOKEN,
          notificationUrl: NOTIFICATION_URL,
        },
        {
          prisma: failingPersistPrisma(),
          fetchImpl: fetchMock as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ kind: 'database' });

    // The DELETE is best-effort and exactly once — a 500 must not retry.
    const deletes = calls.filter((c) => c.method === 'DELETE');
    expect(deletes).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not log the access token or clientState during the compensation path', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    let sentClientState = '';
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? 'GET') === 'POST') {
        sentClientState = (JSON.parse(init?.body as string) as { clientState: string })
          .clientState;
        return new Response(JSON.stringify({ id: REMOTE_SUB_ID }), {
          status: 201,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(null, { status: 204 });
    });

    await expect(
      createInboxSubscription(
        {
          mailboxId: 'mb_comp3',
          accessToken: ACCESS_TOKEN,
          notificationUrl: NOTIFICATION_URL,
        },
        {
          prisma: failingPersistPrisma(),
          fetchImpl: fetchMock as unknown as typeof fetch,
        },
      ),
    ).rejects.toMatchObject({ kind: 'database' });

    const serialized = JSON.stringify([
      ...errorSpy.mock.calls,
      ...warnSpy.mock.calls,
    ]);
    expect(sentClientState.length).toBeGreaterThan(0);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    expect(serialized).not.toContain(sentClientState);

    errorSpy.mockRestore();
    warnSpy.mockRestore();
  });
});
