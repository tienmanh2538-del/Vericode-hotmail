import { describe, it, expect } from 'vitest';

import {
  createRedisMailboxProcessingLock,
  DEFAULT_REDIS_MAILBOX_LOCK_TTL_MS,
  type RedisLockClient,
} from '@/services/queue/redis-mailbox-lock';

// TASK-068A — cross-process lock behaviour, exercised against a fake Redis that
// models SET NX PX (one-winner claim + TTL lease) and a compare-and-delete eval.
// All ids are synthetic ("mailbox_test_*"); no real data is used.
const MAILBOX_A = 'mailbox_test_alpha';
const MAILBOX_B = 'mailbox_test_beta';

interface FakeRedis extends RedisLockClient {
  size(): number;
}

function createFakeRedis(now: () => number): FakeRedis {
  const store = new Map<string, { value: string; expiresAt: number }>();
  const purge = (key: string) => {
    const entry = store.get(key);
    if (entry && entry.expiresAt <= now()) store.delete(key);
  };
  return {
    async set(key, value, _expiryMode, ttlMs, _setMode) {
      purge(key);
      if (store.has(key)) return null;
      store.set(key, { value, expiresAt: now() + ttlMs });
      return 'OK';
    },
    async eval(_script, _numKeys, ...keysAndArgs) {
      const key = String(keysAndArgs[0]);
      const token = String(keysAndArgs[1]);
      purge(key);
      const entry = store.get(key);
      if (entry && entry.value === token) {
        store.delete(key);
        return 1;
      }
      return 0;
    },
    size: () => store.size,
  };
}

// Deterministic token generator so racing holders get distinct, predictable tokens.
function sequentialTokens(): () => string {
  let n = 0;
  return () => `token-${(n += 1)}`;
}

describe('createRedisMailboxProcessingLock', () => {
  it('grants a free lock and refuses a second concurrent acquire', async () => {
    const lock = createRedisMailboxProcessingLock(createFakeRedis(() => 1_000), {
      generateToken: sequentialTokens(),
    });

    const first = await lock.acquire(MAILBOX_A);
    expect(first).not.toBeNull();

    const second = await lock.acquire(MAILBOX_A);
    expect(second).toBeNull();
  });

  it('lets the next acquirer in after the holder releases', async () => {
    const lock = createRedisMailboxProcessingLock(createFakeRedis(() => 1_000), {
      generateToken: sequentialTokens(),
    });

    const first = await lock.acquire(MAILBOX_A);
    expect(first).not.toBeNull();
    await first?.release();

    const second = await lock.acquire(MAILBOX_A);
    expect(second).not.toBeNull();
  });

  it('does not serialize different mailboxes against each other', async () => {
    const lock = createRedisMailboxProcessingLock(createFakeRedis(() => 1_000), {
      generateToken: sequentialTokens(),
    });

    const a = await lock.acquire(MAILBOX_A);
    const b = await lock.acquire(MAILBOX_B);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it('auto-expires a never-released lease after the TTL (crash safety)', async () => {
    let nowMs = 1_000;
    const lock = createRedisMailboxProcessingLock(
      createFakeRedis(() => nowMs),
      { ttlMs: 5_000, generateToken: sequentialTokens() },
    );

    expect(await lock.acquire(MAILBOX_A)).not.toBeNull();

    nowMs += 4_999; // still within TTL → busy
    expect(await lock.acquire(MAILBOX_A)).toBeNull();

    nowMs += 2; // past TTL → reclaimable even without a release
    expect(await lock.acquire(MAILBOX_A)).not.toBeNull();
  });

  it('release is compare-and-delete: a stale holder never frees a newer lease', async () => {
    let nowMs = 0;
    const fake = createFakeRedis(() => nowMs);
    const lock = createRedisMailboxProcessingLock(fake, {
      ttlMs: 100,
      generateToken: sequentialTokens(), // stale=token-1, fresh=token-2
    });

    const stale = await lock.acquire(MAILBOX_A);
    expect(stale).not.toBeNull();

    nowMs += 200; // stale lease expires
    const fresh = await lock.acquire(MAILBOX_A);
    expect(fresh).not.toBeNull();

    // The stale holder finally releases — it must NOT delete the fresh holder's
    // key (different token). The mailbox stays busy for anyone else.
    await stale?.release();
    await stale?.release(); // idempotent
    expect(await lock.acquire(MAILBOX_A)).toBeNull();
    expect(fake.size()).toBe(1);
  });

  it('refuses to lock an empty mailbox id', async () => {
    const lock = createRedisMailboxProcessingLock(createFakeRedis(() => 0), {
      generateToken: sequentialTokens(),
    });
    expect(await lock.acquire('')).toBeNull();
    expect(await lock.acquire('   ')).toBeNull();
  });

  it('fails open when Redis is unreachable (acquire returns a no-op handle)', async () => {
    const brokenClient: RedisLockClient = {
      async set() {
        throw new Error('ECONNREFUSED');
      },
      async eval() {
        throw new Error('ECONNREFUSED');
      },
    };
    const lock = createRedisMailboxProcessingLock(brokenClient);

    // Delivery must not be blocked by a Redis outage — exactly-once is guaranteed
    // by the ProcessedMessage unique constraint, not by this lock.
    const handle = await lock.acquire(MAILBOX_A);
    expect(handle).not.toBeNull();
    // Releasing the no-op handle must not throw even though eval would reject.
    await expect(
      Promise.resolve(handle?.release()),
    ).resolves.not.toThrow();
  });

  it('exposes a sane default TTL', () => {
    expect(DEFAULT_REDIS_MAILBOX_LOCK_TTL_MS).toBeGreaterThan(0);
  });
});
