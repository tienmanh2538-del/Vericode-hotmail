// TASK-086 — provisioning concurrency guard.
//
// The correctness model is deliberately the STRONGEST one: two concurrent
// creates may BOTH get 201 from Microsoft, so nothing here relies on the
// documented 409. Local state is the serialisation point:
//
//   STEP A  normalise rows that are live by status but expired by time
//           (conditional writes only; a FRESH TASK-084 claim is never stolen)
//   STEP B  ANY remaining ACTIVE/RENEWING/FAILED row blocks provisioning
//           (no time predicate — expiration was resolved in STEP A)
//
// All Microsoft/DB surfaces are injected fakes: no real network, no real Prisma,
// no real secret.

import { describe, it, expect, vi } from 'vitest';

import { ensureInboxSubscriptionForConnectedMailbox } from '@/services/microsoft/mailbox-subscription-provisioning.service';
import {
  GraphSubscriptionError,
  type GraphSubscriptionStatus,
} from '@/services/microsoft/graph-subscription.service';
import { STALE_CLAIM_CUTOFF_MS } from '@/services/microsoft/subscription-claim-window';

const ACCESS_TOKEN = 'fake-access-token-do-not-leak';
const MAILBOX = 'mb_1';

const NOW = new Date('2026-08-29T10:00:00.000Z');
const FUTURE = new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000);
const PAST = new Date(NOW.getTime() - 60 * 60 * 1000);
/** A claim generation still inside the TASK-084 stale window → fresh. */
const FRESH_CLAIM = new Date(NOW.getTime() - 60 * 1000);
/** A claim generation older than the TASK-084 stale window → reclaimable. */
const STALE_CLAIM = new Date(NOW.getTime() - STALE_CLAIM_CUTOFF_MS - 60 * 1000);

interface StoreRow {
  id: string;
  mailboxId: string;
  subscriptionId: string;
  status: GraphSubscriptionStatus;
  expirationDateTime: Date;
  updatedAt: Date;
}

type SeedRow = Partial<StoreRow> & { status: GraphSubscriptionStatus };

interface StoreOptions {
  /**
   * Runs immediately BEFORE each conditional normalisation write, so a test can
   * simulate a concurrent writer (renewal claim / stale reclaim) landing first.
   */
  beforeUpdate?: (rows: StoreRow[]) => void;
  /**
   * Runs after the normalisation pass, before the STEP B re-read, so a test can
   * simulate a concurrent row appearing in that window.
   */
  beforeReRead?: (rows: StoreRow[]) => void;
}

function makeStore(seed: SeedRow[], options: StoreOptions = {}) {
  const rows: StoreRow[] = seed.map((r, i) => ({
    id: r.id ?? `row_${i}`,
    mailboxId: r.mailboxId ?? MAILBOX,
    subscriptionId: r.subscriptionId ?? `sub_${i}`,
    status: r.status,
    expirationDateTime: r.expirationDateTime ?? FUTURE,
    updatedAt: r.updatedAt ?? NOW,
  }));

  let findManyCalls = 0;
  const findManyWheres: unknown[] = [];
  const updateManyWheres: Array<Record<string, unknown>> = [];

  const findMany = vi.fn(
    async ({
      where,
    }: {
      where: { mailboxId: string; status: { in: GraphSubscriptionStatus[] } };
    }) => {
      findManyCalls += 1;
      findManyWheres.push(where);
      // The second read is STEP B; give tests a hook to race a writer into it.
      if (findManyCalls === 2) options.beforeReRead?.(rows);
      return rows
        .filter(
          (r) =>
            r.mailboxId === where.mailboxId && where.status.in.includes(r.status),
        )
        .sort(
          (a, b) => b.expirationDateTime.getTime() - a.expirationDateTime.getTime(),
        )
        .map((r) => ({ ...r }));
    },
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
      options.beforeUpdate?.(rows);
      updateManyWheres.push(where as unknown as Record<string, unknown>);
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
      row.updatedAt = NOW;
      return { count: 1 };
    },
  );

  return {
    prisma: { graphSubscription: { findMany, updateMany } },
    rows,
    findMany,
    updateMany,
    findManyWheres,
    updateManyWheres,
  };
}

function createPort(impl?: () => Promise<never>) {
  return vi.fn(async () => {
    if (impl) return impl();
    return {
      id: 'row_new',
      mailboxId: MAILBOX,
      subscriptionId: 'graph-sub-new',
      resource: "/me/mailFolders('Inbox')/messages",
      expirationDateTime: FUTURE,
      status: 'ACTIVE' as const,
    };
  });
}

function run(
  store: ReturnType<typeof makeStore>,
  create: ReturnType<typeof createPort>,
) {
  return ensureInboxSubscriptionForConnectedMailbox(
    { mailboxId: MAILBOX, accessToken: ACCESS_TOKEN },
    { prisma: store.prisma, createSubscription: create, now: () => NOW },
  );
}

// ---------------------------------------------------------------------------
// STEP A — expired-state normalisation
// ---------------------------------------------------------------------------

describe('TASK-086 — expired-state normalisation', () => {
  it('ACTIVE expired-by-time → conditional transition to EXPIRED, then create', async () => {
    const store = makeStore([{ status: 'ACTIVE', expirationDateTime: PAST }]);
    const create = createPort();

    const result = await run(store, create);

    expect(result).toEqual({ outcome: 'created', subscriptionId: 'graph-sub-new' });
    expect(store.rows[0].status).toBe('EXPIRED');
    expect(create).toHaveBeenCalledTimes(1);
    // Conditional, pinned to the exact row + observed status + time predicate.
    expect(store.updateManyWheres).toHaveLength(1);
    expect(store.updateManyWheres[0]).toMatchObject({
      id: 'row_0',
      status: 'ACTIVE',
      expirationDateTime: { lte: NOW },
    });
    expect(store.updateManyWheres[0].updatedAt).toBeUndefined();
  });

  it('FAILED expired-by-time → conditional transition to EXPIRED, then create', async () => {
    const store = makeStore([{ status: 'FAILED', expirationDateTime: PAST }]);
    const create = createPort();

    const result = await run(store, create);

    expect(result.outcome).toBe('created');
    expect(store.rows[0].status).toBe('EXPIRED');
    expect(store.updateManyWheres[0]).toMatchObject({ status: 'FAILED' });
  });

  it('stale RENEWING expired-by-time → transitions with the TASK-084 stale predicate', async () => {
    const store = makeStore([
      { status: 'RENEWING', expirationDateTime: PAST, updatedAt: STALE_CLAIM },
    ]);
    const create = createPort();

    const result = await run(store, create);

    expect(result.outcome).toBe('created');
    expect(store.rows[0].status).toBe('EXPIRED');
    expect(store.updateManyWheres[0]).toMatchObject({
      id: 'row_0',
      status: 'RENEWING',
      expirationDateTime: { lte: NOW },
      updatedAt: { lt: new Date(NOW.getTime() - STALE_CLAIM_CUTOFF_MS) },
    });
  });

  it('FRESH RENEWING expired-by-time → temporarily blocked, no write, no Graph call', async () => {
    const store = makeStore([
      { status: 'RENEWING', expirationDateTime: PAST, updatedAt: FRESH_CLAIM },
    ]);
    const create = createPort();

    const result = await run(store, create);

    expect(result).toEqual({ outcome: 'blocked_renewing' });
    expect(create).not.toHaveBeenCalled();
    expect(store.updateMany).not.toHaveBeenCalled();
    expect(store.rows[0].status).toBe('RENEWING');
  });

  it('renewal claim wins first → normalisation affects 0 rows and provisioning backs off', async () => {
    // The row is ACTIVE + expired when read, but TASK-084 claims it before our
    // conditional write lands: status is no longer ACTIVE, so we match nothing.
    const store = makeStore([{ status: 'ACTIVE', expirationDateTime: PAST }], {
      beforeUpdate: (rows) => {
        rows[0].status = 'RENEWING';
        rows[0].updatedAt = FRESH_CLAIM;
      },
    });
    const create = createPort();

    const result = await run(store, create);

    expect(result).toEqual({ outcome: 'skipped_existing', existingStatus: 'RENEWING' });
    expect(create).not.toHaveBeenCalled();
    expect(store.rows[0].status).toBe('RENEWING');
  });

  it('normalisation wins first → a later TASK-084 claim can no longer match the row', async () => {
    const store = makeStore([{ status: 'ACTIVE', expirationDateTime: PAST }]);
    const create = createPort();

    await run(store, create);

    // TASK-084 claims with `status IN (ACTIVE, FAILED)` (fresh) or
    // `status = RENEWING AND updatedAt < cutoff` (stale reclaim). An EXPIRED row
    // matches neither, so the claim affects 0 rows and never resurrects it.
    expect(store.rows[0].status).toBe('EXPIRED');
    expect(['ACTIVE', 'FAILED', 'RENEWING']).not.toContain(store.rows[0].status);
  });

  it('TASK-084 stale reclaim wins → stale normalisation loses and provisioning backs off', async () => {
    const store = makeStore(
      [{ status: 'RENEWING', expirationDateTime: PAST, updatedAt: STALE_CLAIM }],
      {
        // Another worker reclaims the stale claim and stamps a fresh generation
        // between our read and our conditional write.
        beforeUpdate: (rows) => {
          rows[0].updatedAt = FRESH_CLAIM;
        },
      },
    );
    const create = createPort();

    const result = await run(store, create);

    expect(result).toEqual({ outcome: 'skipped_existing', existingStatus: 'RENEWING' });
    expect(create).not.toHaveBeenCalled();
    expect(store.rows[0].status).toBe('RENEWING');
  });

  it('never writes to the mailbox row during normalisation', async () => {
    const mailbox = { update: vi.fn(), updateMany: vi.fn() };
    const store = makeStore([{ status: 'ACTIVE', expirationDateTime: PAST }]);
    const prismaWithMailbox = { ...store.prisma, mailbox };
    const create = createPort();

    await ensureInboxSubscriptionForConnectedMailbox(
      { mailboxId: MAILBOX, accessToken: ACCESS_TOKEN },
      { prisma: prismaWithMailbox, createSubscription: create, now: () => NOW },
    );

    expect(mailbox.update).not.toHaveBeenCalled();
    expect(mailbox.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// STEP B — blocking definition
// ---------------------------------------------------------------------------

describe('TASK-086 — blocking definition after normalisation', () => {
  it('the live-row read carries no expiration predicate (index parity)', async () => {
    const store = makeStore([]);
    await run(store, createPort());

    for (const where of store.findManyWheres) {
      expect(where).toEqual({
        mailboxId: MAILBOX,
        status: { in: ['ACTIVE', 'RENEWING', 'FAILED'] },
      });
    }
  });

  it('any remaining live row blocks the create', async () => {
    const store = makeStore([{ status: 'ACTIVE', expirationDateTime: FUTURE }]);
    const create = createPort();

    const result = await run(store, create);

    expect(result).toEqual({ outcome: 'skipped_existing', existingStatus: 'ACTIVE' });
    expect(create).not.toHaveBeenCalled();
  });

  it('a live row appearing between normalisation and the re-read still blocks', async () => {
    const store = makeStore([], {
      beforeReRead: (rows) => {
        rows.push({
          id: 'row_winner',
          mailboxId: MAILBOX,
          subscriptionId: 'sub_winner',
          status: 'ACTIVE',
          expirationDateTime: FUTURE,
          updatedAt: NOW,
        });
      },
    });
    const create = createPort();

    const result = await run(store, create);

    expect(result).toEqual({ outcome: 'skipped_existing', existingStatus: 'ACTIVE' });
    expect(create).not.toHaveBeenCalled();
  });

  it('multiple EXPIRED rows for the same mailbox never block', async () => {
    const store = makeStore([
      { id: 'e1', status: 'EXPIRED', expirationDateTime: PAST },
      { id: 'e2', status: 'EXPIRED', expirationDateTime: FUTURE },
      { id: 'e3', status: 'EXPIRED', expirationDateTime: PAST },
    ]);
    const create = createPort();

    const result = await run(store, create);

    expect(result.outcome).toBe('created');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('a live row belonging to a different mailbox never blocks', async () => {
    const store = makeStore([
      { mailboxId: 'mb_other', status: 'ACTIVE', expirationDateTime: FUTURE },
    ]);
    const create = createPort();

    const result = await run(store, create);

    expect(result.outcome).toBe('created');
  });

  it('no live row → exactly one create attempt', async () => {
    const store = makeStore([]);
    const create = createPort();

    await run(store, create);

    expect(create).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Conflict classification (both creates got 201, or Microsoft answered 409)
// ---------------------------------------------------------------------------

function throwing(error: GraphSubscriptionError) {
  return createPort(async () => {
    throw error;
  });
}

describe('TASK-086 — local unique-conflict ownership loss', () => {
  const ownershipConflict = new GraphSubscriptionError(
    'ownership_conflict',
    'GRAPH_SUBSCRIPTION_LIVE_SLOT_TAKEN',
  );

  it('loser re-reads the winner and reports lost_ownership without retrying', async () => {
    // Both operations got 201; ours lost the local INSERT. The create seam has
    // already released OUR remote subscription. The winner row becomes visible
    // exactly when the winner's INSERT commits — i.e. after our create attempt,
    // so only the conflict re-read can see it.
    const store = makeStore([]);
    const create = createPort(async () => {
      store.rows.push({
        id: 'row_winner',
        mailboxId: MAILBOX,
        subscriptionId: 'sub_winner',
        status: 'ACTIVE',
        expirationDateTime: FUTURE,
        updatedAt: NOW,
      });
      throw ownershipConflict;
    });

    const result = await ensureInboxSubscriptionForConnectedMailbox(
      { mailboxId: MAILBOX, accessToken: ACCESS_TOKEN },
      { prisma: store.prisma, createSubscription: create, now: () => NOW },
    );

    expect(result).toEqual({ outcome: 'lost_ownership', existingStatus: 'ACTIVE' });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('conflict with no local live owner → conflict_unowned, nothing fabricated', async () => {
    const store = makeStore([]);
    const create = throwing(ownershipConflict);

    const result = await run(store, create);

    expect(result).toEqual({
      outcome: 'conflict_unowned',
      source: 'local_unique_conflict',
    });
    expect(create).toHaveBeenCalledTimes(1);
    // No row invented, no lifecycle write.
    expect(store.rows).toHaveLength(0);
    expect(store.updateMany).not.toHaveBeenCalled();
  });
});

describe('TASK-086 — Microsoft 409 (defensive only)', () => {
  const conflict409 = new GraphSubscriptionError(
    'conflict',
    'GRAPH_SUBSCRIPTION_CONFLICT',
    { httpStatus: 409 },
  );

  it('409 with a local live winner → conflict_existing, no retry', async () => {
    const store = makeStore([]);
    const create = createPort(async () => {
      store.rows.push({
        id: 'row_winner',
        mailboxId: MAILBOX,
        subscriptionId: 'sub_winner',
        status: 'RENEWING',
        expirationDateTime: FUTURE,
        updatedAt: NOW,
      });
      throw conflict409;
    });

    const result = await run(store, create);

    expect(result).toEqual({
      outcome: 'conflict_existing',
      existingStatus: 'RENEWING',
    });
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('409 without a local live winner → conflict_unowned, no fabrication, no retry', async () => {
    const store = makeStore([]);
    const create = throwing(conflict409);

    const result = await run(store, create);

    expect(result).toEqual({
      outcome: 'conflict_unowned',
      source: 'remote_conflict',
    });
    expect(create).toHaveBeenCalledTimes(1);
    expect(store.rows).toHaveLength(0);
  });

  it('a generic create failure stays a fail-open failure (not an ownership loss)', async () => {
    const store = makeStore([]);
    const create = throwing(
      new GraphSubscriptionError('database', 'failed to persist Graph subscription'),
    );

    const result = await run(store, create);

    expect(result.outcome).toBe('failed');
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('never leaks the access token through any conflict path', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => undefined);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const store = makeStore([]);

    await run(store, throwing(conflict409));

    const serialized = JSON.stringify([
      ...warnSpy.mock.calls,
      ...infoSpy.mock.calls,
      ...logSpy.mock.calls,
    ]);
    expect(serialized).not.toContain(ACCESS_TOKEN);
    vi.restoreAllMocks();
  });
});
