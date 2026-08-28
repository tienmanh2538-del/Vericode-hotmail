// TASK-081 — connect-time Graph subscription provisioning (ensure semantics,
// fail-open, finite timeout). All Microsoft/DB surfaces are injected fakes; no
// real network, no real Prisma.

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  CONNECT_SUBSCRIPTION_HTTP_TIMEOUT_MS,
  ensureInboxSubscriptionForConnectedMailbox,
} from '@/services/microsoft/mailbox-subscription-provisioning.service';
import {
  GraphSubscriptionError,
  type GraphSubscriptionStatus,
} from '@/services/microsoft/graph-subscription.service';
import { classifySubscription } from '@/services/microsoft/subscription-renewal.service';

const ACCESS_TOKEN = 'fake-access-token-do-not-leak';
const NOTIFICATION_URL = 'https://example.com/api/webhooks/microsoft/mail';

const NOW = new Date('2026-08-20T10:00:00.000Z');
const FUTURE = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000);
const PAST = new Date(NOW.getTime() - 60 * 60 * 1000);

interface FakeRow {
  id?: string;
  mailboxId: string;
  subscriptionId: string;
  status: GraphSubscriptionStatus;
  expirationDateTime: Date;
  /** TASK-084 claim generation; only meaningful for RENEWING rows. */
  updatedAt?: Date;
}

// TASK-086 — interprets the exact Prisma-shaped calls the service issues (the
// live-row read and the conditional normalisation writes) so the whole
// normalise → re-read → create policy is exercised end to end.
function fakeEnsurePrisma(input: FakeRow[]) {
  const rows = input.map((r, index) => ({
    id: r.id ?? `row_${index}`,
    mailboxId: r.mailboxId,
    subscriptionId: r.subscriptionId,
    status: r.status,
    expirationDateTime: r.expirationDateTime,
    updatedAt: r.updatedAt ?? NOW,
  }));

  const findMany = vi.fn(
    async ({
      where,
    }: {
      where: { mailboxId: string; status: { in: GraphSubscriptionStatus[] } };
    }) =>
      rows
        .filter(
          (r) =>
            r.mailboxId === where.mailboxId && where.status.in.includes(r.status),
        )
        .sort(
          (a, b) => b.expirationDateTime.getTime() - a.expirationDateTime.getTime(),
        )
        .map((r) => ({ ...r })),
  );

  const updateMany = vi.fn(
    async ({
      where,
      data,
    }: {
      where: {
        id: string;
        status: GraphSubscriptionStatus;
        expirationDateTime: { lte: Date };
        updatedAt?: { lt: Date };
      };
      data: { status: GraphSubscriptionStatus };
    }) => {
      const row = rows.find(
        (r) =>
          r.id === where.id &&
          r.status === where.status &&
          r.expirationDateTime.getTime() <= where.expirationDateTime.lte.getTime() &&
          (where.updatedAt === undefined ||
            r.updatedAt.getTime() < where.updatedAt.lt.getTime()),
      );
      if (!row) return { count: 0 };
      row.status = data.status;
      return { count: 1 };
    },
  );

  return {
    prisma: { graphSubscription: { findMany, updateMany } },
    findMany,
    updateMany,
    rows,
  };
}

function fakeCreatePort(
  impl?: () => Promise<{ subscriptionId: string }>,
) {
  const create = vi.fn(async () => {
    if (impl) return impl() as never;
    return {
      id: 'row_1',
      mailboxId: 'mb_1',
      subscriptionId: 'graph-sub-new',
      resource: "/me/mailFolders('Inbox')/messages",
      expirationDateTime: FUTURE,
      status: 'ACTIVE' as const,
    };
  });
  return create;
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('ensure semantics', () => {
  it('A. no usable local subscription → creates exactly once', async () => {
    const { prisma } = fakeEnsurePrisma([]);
    const create = fakeCreatePort();

    const result = await ensureInboxSubscriptionForConnectedMailbox(
      { mailboxId: 'mb_1', accessToken: ACCESS_TOKEN },
      { prisma, createSubscription: create, now: () => NOW },
    );

    expect(result).toEqual({ outcome: 'created', subscriptionId: 'graph-sub-new' });
    expect(create).toHaveBeenCalledTimes(1);
    const [input] = create.mock.calls[0] as unknown as [
      { mailboxId: string; accessToken: string },
    ];
    expect(input.mailboxId).toBe('mb_1');
    expect(input.accessToken).toBe(ACCESS_TOKEN);
  });

  it('B. ACTIVE subscription still in the future → no-op, no duplicate', async () => {
    const { prisma } = fakeEnsurePrisma([
      {
        mailboxId: 'mb_1',
        subscriptionId: 'graph-sub-live',
        status: 'ACTIVE',
        expirationDateTime: FUTURE,
      },
    ]);
    const create = fakeCreatePort();

    const result = await ensureInboxSubscriptionForConnectedMailbox(
      { mailboxId: 'mb_1', accessToken: ACCESS_TOKEN },
      { prisma, createSubscription: create, now: () => NOW },
    );

    expect(result).toEqual({
      outcome: 'skipped_existing',
      existingStatus: 'ACTIVE',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('B. RENEWING subscription still in the future → no-op', async () => {
    const { prisma } = fakeEnsurePrisma([
      {
        mailboxId: 'mb_1',
        subscriptionId: 'graph-sub-renewing',
        status: 'RENEWING',
        expirationDateTime: FUTURE,
      },
    ]);
    const create = fakeCreatePort();

    const result = await ensureInboxSubscriptionForConnectedMailbox(
      { mailboxId: 'mb_1', accessToken: ACCESS_TOKEN },
      { prisma, createSubscription: create, now: () => NOW },
    );

    expect(result.outcome).toBe('skipped_existing');
    expect(create).not.toHaveBeenCalled();
  });

  it('C. clearly expired ACTIVE row does not block a new subscription', async () => {
    const { prisma } = fakeEnsurePrisma([
      {
        mailboxId: 'mb_1',
        subscriptionId: 'graph-sub-old',
        status: 'ACTIVE',
        expirationDateTime: PAST,
      },
    ]);
    const create = fakeCreatePort();

    const result = await ensureInboxSubscriptionForConnectedMailbox(
      { mailboxId: 'mb_1', accessToken: ACCESS_TOKEN },
      { prisma, createSubscription: create, now: () => NOW },
    );

    expect(result.outcome).toBe('created');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('C. EXPIRED status row does not block a new subscription', async () => {
    const { prisma } = fakeEnsurePrisma([
      {
        mailboxId: 'mb_1',
        subscriptionId: 'graph-sub-expired',
        status: 'EXPIRED',
        expirationDateTime: FUTURE,
      },
    ]);
    const create = fakeCreatePort();

    const result = await ensureInboxSubscriptionForConnectedMailbox(
      { mailboxId: 'mb_1', accessToken: ACCESS_TOKEN },
      { prisma, createSubscription: create, now: () => NOW },
    );

    expect(result.outcome).toBe('created');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('D. FAILED row with a future expiration (remote may still be live) → no blind create', async () => {
    const { prisma } = fakeEnsurePrisma([
      {
        mailboxId: 'mb_1',
        subscriptionId: 'graph-sub-failed',
        status: 'FAILED',
        expirationDateTime: FUTURE,
      },
    ]);
    const create = fakeCreatePort();

    const result = await ensureInboxSubscriptionForConnectedMailbox(
      { mailboxId: 'mb_1', accessToken: ACCESS_TOKEN },
      { prisma, createSubscription: create, now: () => NOW },
    );

    expect(result).toEqual({
      outcome: 'skipped_existing',
      existingStatus: 'FAILED',
    });
    expect(create).not.toHaveBeenCalled();
  });

  it('only considers rows of the connected mailbox', async () => {
    const { prisma } = fakeEnsurePrisma([
      {
        mailboxId: 'mb_other',
        subscriptionId: 'graph-sub-other',
        status: 'ACTIVE',
        expirationDateTime: FUTURE,
      },
    ]);
    const create = fakeCreatePort();

    const result = await ensureInboxSubscriptionForConnectedMailbox(
      { mailboxId: 'mb_1', accessToken: ACCESS_TOKEN },
      { prisma, createSubscription: create, now: () => NOW },
    );

    expect(result.outcome).toBe('created');
  });
});

describe('fail-open behavior (never throws, no retry)', () => {
  const graphErrorCases: Array<[string, GraphSubscriptionError]> = [
    ['400 http', new GraphSubscriptionError('http', 'GRAPH_REQUEST_FAILED', { httpStatus: 400 })],
    ['401 auth', new GraphSubscriptionError('auth', 'GRAPH_AUTH_FAILED', { httpStatus: 401 })],
    ['403 permission', new GraphSubscriptionError('permission', 'GRAPH_PERMISSION_DENIED', { httpStatus: 403 })],
    ['429 rate_limited', new GraphSubscriptionError('rate_limited', 'GRAPH_RATE_LIMITED', { httpStatus: 429 })],
    ['500 temporary', new GraphSubscriptionError('temporary', 'GRAPH_TEMPORARY_ERROR', { httpStatus: 503 })],
    ['network failure', new GraphSubscriptionError('network', 'GRAPH_NETWORK_ERROR')],
  ];

  for (const [label, error] of graphErrorCases) {
    it(`G. create fails with ${label} → outcome failed, single attempt, no throw`, async () => {
      const { prisma } = fakeEnsurePrisma([]);
      const create = fakeCreatePort(async () => {
        throw error;
      });

      const result = await ensureInboxSubscriptionForConnectedMailbox(
        { mailboxId: 'mb_1', accessToken: ACCESS_TOKEN },
        { prisma, createSubscription: create, now: () => NOW },
      );

      expect(result.outcome).toBe('failed');
      expect(create).toHaveBeenCalledTimes(1);
    });
  }

  it('local read failure (prisma throws) → outcome failed, create never called', async () => {
    const create = fakeCreatePort();
    const prisma = {
      graphSubscription: {
        findMany: vi.fn(async () => {
          throw new Error('db unreachable');
        }),
        updateMany: vi.fn(async () => ({ count: 0 })),
      },
    };

    const result = await ensureInboxSubscriptionForConnectedMailbox(
      { mailboxId: 'mb_1', accessToken: ACCESS_TOKEN },
      { prisma, createSubscription: create },
    );

    expect(result.outcome).toBe('failed');
    expect(create).not.toHaveBeenCalled();
  });

  it('missing mailboxId or accessToken → outcome failed without any side effect', async () => {
    const create = fakeCreatePort();
    const { prisma, findMany } = fakeEnsurePrisma([]);

    const noMailbox = await ensureInboxSubscriptionForConnectedMailbox(
      { mailboxId: '  ', accessToken: ACCESS_TOKEN },
      { prisma, createSubscription: create },
    );
    const noToken = await ensureInboxSubscriptionForConnectedMailbox(
      { mailboxId: 'mb_1', accessToken: '' },
      { prisma, createSubscription: create },
    );

    expect(noMailbox.outcome).toBe('failed');
    expect(noToken.outcome).toBe('failed');
    expect(create).not.toHaveBeenCalled();
    expect(findMany).not.toHaveBeenCalled();
  });

  it('does not log the access token on failure', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { prisma } = fakeEnsurePrisma([]);
    const create = fakeCreatePort(async () => {
      throw new Error(`transport failure carrying ${ACCESS_TOKEN}`);
    });

    await ensureInboxSubscriptionForConnectedMailbox(
      { mailboxId: 'mb_1', accessToken: ACCESS_TOKEN },
      { prisma, createSubscription: create },
    );

    const serialized = JSON.stringify([
      ...warnSpy.mock.calls,
      ...errorSpy.mock.calls,
    ]);
    expect(serialized).not.toContain(ACCESS_TOKEN);
  });
});

describe('H. hanging Graph create — finite timeout with real cancellation', () => {
  it('aborts the underlying request after the ceiling and settles as failed', async () => {
    vi.useFakeTimers();
    vi.stubEnv('MICROSOFT_GRAPH_NOTIFICATION_URL', NOTIFICATION_URL);

    // Signal-aware hanging fetch: never resolves unless aborted.
    const hangingFetch = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    );

    const { prisma } = fakeEnsurePrisma([]);
    // No createSubscription override: the REAL createInboxSubscription runs with
    // the timeout-wrapped fetch, proving the production seam is capped.
    const pending = ensureInboxSubscriptionForConnectedMailbox(
      { mailboxId: 'mb_hang', accessToken: ACCESS_TOKEN },
      { prisma, fetchImpl: hangingFetch as unknown as typeof fetch, now: () => NOW },
    );

    await vi.advanceTimersByTimeAsync(CONNECT_SUBSCRIPTION_HTTP_TIMEOUT_MS);
    const result = await pending;

    expect(result.outcome).toBe('failed');
    expect(hangingFetch).toHaveBeenCalledTimes(1);
    const [, init] = hangingFetch.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    // Real cancellation: the request's signal was aborted, not raced-and-forgotten.
    expect(init.signal?.aborted).toBe(true);
  });
});

describe('L. renewal-worker compatibility of the provisioned row', () => {
  it('a freshly created subscription is a valid renewal candidate shape', () => {
    // Shape the ensure path persists (via createInboxSubscription): status
    // ACTIVE, expiration ~6 days out, non-empty subscriptionId.
    const persisted = {
      id: 'row_1',
      mailboxId: 'mb_1',
      subscriptionId: 'graph-sub-new',
      emailAddress: 'mailbox@example.com',
      mailboxStatus: 'ACTIVE',
      expirationDateTime: new Date(NOW.getTime() + 6 * 24 * 60 * 60 * 1000),
    };
    const renewWindowMs = 24 * 60 * 60 * 1000;

    // Fresh subscription: not yet due.
    expect(classifySubscription(persisted, NOW, renewWindowMs)).toBe('skip');

    // Once inside the 24h renewal window the existing worker picks it up.
    const nearExpiry = new Date(
      persisted.expirationDateTime.getTime() - 60 * 60 * 1000,
    );
    expect(classifySubscription(persisted, nearExpiry, renewWindowMs)).toBe('renew');
  });
});
