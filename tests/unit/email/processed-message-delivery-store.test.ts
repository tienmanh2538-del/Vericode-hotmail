import { describe, it, expect, vi } from 'vitest';

import {
  createInMemoryProcessedMessageStore,
  acquireDeliveryOwnership,
  isDeliveryRecoverableRow,
} from '@/services/email/deduplication.service';
import { createPrismaProcessedMessageStore } from '@/services/email/prisma-processed-message-store';
import {
  DELIVERY_LEASE_MS,
  MAX_DELIVERY_ATTEMPTS,
} from '@/services/email/delivery-ownership-policy';

// TASK-090 — delivery-ownership store semantics. All identifiers synthetic.

const MAILBOX_ID = 'mailbox_test_alpha';
const NOW = new Date('2026-09-01T10:00:00.000Z');

async function seed(
  store = createInMemoryProcessedMessageStore(),
  overrides: {
    deliveryOwner?: string | null;
    deliveryLeaseUntil?: Date | null;
    deliveryAttempts?: number;
  } = {},
) {
  const row = await store.create({
    mailboxId: MAILBOX_ID,
    graphMessageId: 'graph-msg-test-090-store',
    internetMessageId: null,
    codeHash: null,
    receivedAt: NOW,
    receivedAtBucket: null,
    senderEmail: null,
    subjectHash: null,
    ...overrides,
  });
  return { store, row };
}

describe('in-memory store — delivery ownership CAS semantics', () => {
  it('claimDelivery refuses non-DETECTED rows and exhausted budgets', async () => {
    const { store, row } = await seed(undefined, { deliveryAttempts: MAX_DELIVERY_ATTEMPTS });
    expect(
      await store.claimDelivery({
        processedMessageId: row.id,
        ownerToken: 'w1',
        now: NOW,
        leaseUntil: new Date(NOW.getTime() + DELIVERY_LEASE_MS),
        maxAttempts: MAX_DELIVERY_ATTEMPTS,
      }),
    ).toBe(false);

    const { store: s2, row: r2 } = await seed();
    await s2.markSent(r2.id, NOW);
    expect(
      await s2.claimDelivery({
        processedMessageId: r2.id,
        ownerToken: 'w1',
        now: NOW,
        leaseUntil: new Date(NOW.getTime() + DELIVERY_LEASE_MS),
        maxAttempts: MAX_DELIVERY_ATTEMPTS,
      }),
    ).toBe(false);
  });

  it('releaseDelivery only works for the current owner of a DETECTED row', async () => {
    const { store, row } = await seed(undefined, {
      deliveryOwner: 'owner-a',
      deliveryLeaseUntil: new Date(NOW.getTime() + DELIVERY_LEASE_MS),
      deliveryAttempts: 1,
    });
    expect(await store.releaseDelivery(row.id, 'owner-b')).toBe(false);
    expect(await store.releaseDelivery(row.id, 'owner-a')).toBe(true);
    const after = await store.findById(row.id);
    expect(after?.deliveryOwner).toBeNull();
    expect(after?.deliveryLeaseUntil).toBeNull();
    expect(after?.deliveryAttempts).toBe(1); // budget stays consumed
  });

  it('markFailedIfUnclaimed refuses a row with an ACTIVE lease and honours minAttempts', async () => {
    const { store, row } = await seed(undefined, {
      deliveryOwner: 'owner-a',
      deliveryLeaseUntil: new Date(NOW.getTime() + DELIVERY_LEASE_MS),
      deliveryAttempts: 1,
    });
    // Live owner → never steal.
    expect(
      await store.markFailedIfUnclaimed({
        processedMessageId: row.id,
        reason: 'delivery_attempts_exhausted',
        now: NOW,
      }),
    ).toBe(false);

    // Lease expired but attempts below the floor → no budget terminalization.
    expect(
      await store.markFailedIfUnclaimed({
        processedMessageId: row.id,
        reason: 'delivery_attempts_exhausted',
        now: new Date(NOW.getTime() + DELIVERY_LEASE_MS + 1),
        minAttempts: MAX_DELIVERY_ATTEMPTS,
      }),
    ).toBe(false);

    // Lease expired, no floor → terminal FAILED.
    expect(
      await store.markFailedIfUnclaimed({
        processedMessageId: row.id,
        reason: 'stale_before_delivery',
        now: new Date(NOW.getTime() + DELIVERY_LEASE_MS + 1),
      }),
    ).toBe(true);
    const after = await store.findById(row.id);
    expect(after?.status).toBe('FAILED');
    expect(after?.deliveryFailureReason).toBe('stale_before_delivery');
  });

  it('isDeliveryRecoverableRow: only SENT/FAILED are terminal', () => {
    expect(isDeliveryRecoverableRow({ status: 'DETECTED' })).toBe(true);
    expect(isDeliveryRecoverableRow({ status: 'SENT' })).toBe(false);
    expect(isDeliveryRecoverableRow({ status: 'FAILED' })).toBe(false);
  });
});

describe('acquireDeliveryOwnership — bounded loop', () => {
  it('is hard-bounded even when the injected clock never advances (defensive cap)', async () => {
    const { store, row } = await seed(undefined, {
      deliveryOwner: 'stuck-owner',
      deliveryLeaseUntil: new Date(NOW.getTime() + DELIVERY_LEASE_MS),
      deliveryAttempts: 1,
    });

    let sleeps = 0;
    const result = await acquireDeliveryOwnership(row.id, store, {
      now: () => NOW, // frozen clock — worst case for the loop
      sleep: async () => {
        sleeps += 1;
      },
    });

    expect(result.kind).toBe('owned_elsewhere');
    // Never unbounded: the defensive iteration cap reaps a non-advancing clock.
    expect(sleeps).toBeLessThanOrEqual(
      Math.ceil((DELIVERY_LEASE_MS + 5_000) / 5_000) + 8,
    );
  });

  it('returns already_sent / terminal_failed without ever attempting a CAS', async () => {
    const { store, row } = await seed();
    await store.markSent(row.id, NOW);
    const sent = await acquireDeliveryOwnership(row.id, store, {
      now: () => NOW,
      sleep: async () => {},
    });
    expect(sent.kind).toBe('already_sent');

    const { store: s2, row: r2 } = await seed(undefined, {
      deliveryOwner: 'o',
      deliveryAttempts: 1,
    });
    await s2.markFailedByOwner(r2.id, 'o', 'telegram_api_400');
    const failed = await acquireDeliveryOwnership(r2.id, s2, {
      now: () => NOW,
      sleep: async () => {},
    });
    expect(failed.kind).toBe('terminal_failed');
  });
});

describe('Prisma store — conditional (CAS) write shapes', () => {
  function makeCapturingClient() {
    const updateManyMock = vi.fn(async (_args: unknown) => ({ count: 1 }));
    const client = {
      processedMessage: {
        findUnique: async () => null,
        findFirst: async () => null,
        create: async () => {
          throw new Error('unused');
        },
        updateMany: updateManyMock,
      },
    };
    return { client: client as never, updateManyMock };
  }

  it('claimDelivery conditions on DETECTED + free/expired lease + attempt budget, and increments attempts', async () => {
    const { client, updateManyMock } = makeCapturingClient();
    const store = createPrismaProcessedMessageStore(client);

    const leaseUntil = new Date(NOW.getTime() + DELIVERY_LEASE_MS);
    const claimed = await store.claimDelivery({
      processedMessageId: 'pm_1',
      ownerToken: 'w1',
      now: NOW,
      leaseUntil,
      maxAttempts: MAX_DELIVERY_ATTEMPTS,
    });
    expect(claimed).toBe(true);

    const arg = updateManyMock.mock.calls[0][0] as {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    };
    expect(arg.where).toMatchObject({
      id: 'pm_1',
      status: 'DETECTED',
      deliveryAttempts: { lt: MAX_DELIVERY_ATTEMPTS },
    });
    expect(arg.where.OR).toEqual([
      { deliveryLeaseUntil: null },
      { deliveryLeaseUntil: { lte: NOW } },
    ]);
    expect(arg.data).toMatchObject({
      deliveryOwner: 'w1',
      deliveryLeaseUntil: leaseUntil,
      deliveryAttempts: { increment: 1 },
    });
  });

  it('markSent with a token fences on the current owner; without a token it stays keyed by id (legacy mock flow)', async () => {
    const { client, updateManyMock } = makeCapturingClient();
    const store = createPrismaProcessedMessageStore(client);

    await store.markSent('pm_1', NOW, 'w1');
    expect(updateManyMock.mock.calls[0][0]).toMatchObject({
      where: { id: 'pm_1', status: 'DETECTED', deliveryOwner: 'w1' },
      data: { status: 'SENT', sentToTelegramAt: NOW, deliveryLeaseUntil: null },
    });

    await store.markSent('pm_1', NOW);
    expect(updateManyMock.mock.calls[1][0]).toMatchObject({
      where: { id: 'pm_1' },
    });
  });

  it('markFailedByOwner and markFailedIfUnclaimed write terminal FAILED with a sanitized reason under the right predicates', async () => {
    const { client, updateManyMock } = makeCapturingClient();
    const store = createPrismaProcessedMessageStore(client);

    await store.markFailedByOwner('pm_1', 'w1', 'telegram_api_403');
    expect(updateManyMock.mock.calls[0][0]).toMatchObject({
      where: { id: 'pm_1', status: 'DETECTED', deliveryOwner: 'w1' },
      data: { status: 'FAILED', deliveryFailureReason: 'telegram_api_403' },
    });

    await store.markFailedIfUnclaimed({
      processedMessageId: 'pm_1',
      reason: 'delivery_attempts_exhausted',
      now: NOW,
      minAttempts: MAX_DELIVERY_ATTEMPTS,
    });
    const arg = updateManyMock.mock.calls[1][0] as {
      where: Record<string, unknown>;
    };
    expect(arg.where).toMatchObject({
      id: 'pm_1',
      status: 'DETECTED',
      deliveryAttempts: { gte: MAX_DELIVERY_ATTEMPTS },
    });
    expect(arg.where.OR).toEqual([
      { deliveryLeaseUntil: null },
      { deliveryLeaseUntil: { lte: NOW } },
    ]);
  });

  it('releaseDelivery clears owner+lease only for the current owner of a DETECTED row', async () => {
    const { client, updateManyMock } = makeCapturingClient();
    const store = createPrismaProcessedMessageStore(client);

    await store.releaseDelivery('pm_1', 'w1');
    expect(updateManyMock.mock.calls[0][0]).toMatchObject({
      where: { id: 'pm_1', status: 'DETECTED', deliveryOwner: 'w1' },
      data: { deliveryOwner: null, deliveryLeaseUntil: null },
    });
  });
});
