// TASK-068A — Redis-backed (cross-process) per-mailbox processing lock.
//
// The in-memory lock (`createInMemoryMailboxProcessingLock`) only serialises jobs
// inside ONE worker process. Once the deployment runs more than one email worker
// replica, two replicas can each hold their own in-memory lock for the same
// mailbox and hammer Microsoft Graph / Telegram in parallel. This module provides
// the cross-process equivalent backed by the Redis infrastructure the queue
// already uses, behind the SAME `MailboxProcessingLock` interface.
//
// Design:
//   - Acquire = `SET key token PX ttl NX`. The `NX` makes it a one-winner claim;
//     the `PX` lease means a crashed/hung holder cannot wedge the mailbox forever.
//   - Release = a Lua compare-and-delete: delete the key ONLY if it still holds
//     OUR token. If our lease already expired and another process re-claimed it,
//     release is a no-op — we never delete someone else's lock.
//   - Fail-safe: if Redis is unreachable, acquire returns a no-op handle so the
//     job still proceeds. Exactly-once delivery is guaranteed by the
//     ProcessedMessage unique constraint (see deduplication.service), NOT by this
//     lock, so degrading to "no cross-process serialisation" is safe for
//     correctness — it only loses burst smoothing, never causes a double-send.
//
// SECURITY: only an opaque `mailboxId` and a random token are written to Redis.
// No verification code, email body, token, or secret is ever stored or logged.

import { randomUUID } from 'node:crypto';

import { createLogger, type Logger } from '@/lib/logger';
import type {
  MailboxLockHandle,
  MailboxProcessingLock,
} from './mailbox-processing-lock';

/** Default lease length for a Redis-held lock. Matches the in-memory default. */
export const DEFAULT_REDIS_MAILBOX_LOCK_TTL_MS = 60_000;

const DEFAULT_KEY_PREFIX = 'mailbox-lock:';

// Compare-and-delete: only release the lock if the stored value is still ours.
const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/**
 * Minimal slice of an ioredis-style client this lock needs. Declared locally so
 * the module has NO hard dependency on `ioredis` (it is only a nested dependency
 * of bullmq and is not resolvable at the top level). Any client exposing these
 * two methods — including a fake in tests — satisfies it.
 */
export interface RedisLockClient {
  /** `SET key value PX ttlMs NX` → `'OK'` when acquired, `null` when held. */
  set(
    key: string,
    value: string,
    expiryMode: 'PX',
    ttlMs: number,
    setMode: 'NX',
  ): Promise<'OK' | null>;
  /** Evaluate a Lua script (used for the compare-and-delete release). */
  eval(
    script: string,
    numKeys: number,
    ...keysAndArgs: (string | number)[]
  ): Promise<unknown>;
}

export interface RedisMailboxLockOptions {
  /** Lease length in ms. Defaults to 60s. */
  ttlMs?: number;
  /** Redis key namespace. Defaults to `mailbox-lock:`. */
  keyPrefix?: string;
  logger?: Logger;
  /** Token generator. Injectable for deterministic tests; defaults to a UUID. */
  generateToken?: () => string;
}

// A handle that does nothing — returned when Redis is unreachable so the job can
// still proceed (fail-open). Releasing it is a no-op.
const NOOP_HANDLE: MailboxLockHandle = {
  release(): void {
    /* nothing held */
  },
};

/**
 * Build a Redis-backed per-mailbox processing lock. Pass the SAME client to every
 * job so all jobs (across processes) contend on the same Redis keys.
 */
export function createRedisMailboxProcessingLock(
  client: RedisLockClient,
  options: RedisMailboxLockOptions = {},
): MailboxProcessingLock {
  const ttlMs =
    typeof options.ttlMs === 'number' && options.ttlMs > 0
      ? options.ttlMs
      : DEFAULT_REDIS_MAILBOX_LOCK_TTL_MS;
  const keyPrefix = options.keyPrefix ?? DEFAULT_KEY_PREFIX;
  const logger = options.logger ?? createLogger();
  const generateToken = options.generateToken ?? (() => randomUUID());

  return {
    async acquire(mailboxId: string): Promise<MailboxLockHandle | null> {
      const id = typeof mailboxId === 'string' ? mailboxId.trim() : '';
      // An empty key cannot be serialised safely — refuse rather than collapse
      // every empty-id job onto one lock (mirrors the in-memory lock).
      if (id.length === 0) return null;

      const key = `${keyPrefix}${id}`;
      const token = generateToken();

      let acquired: 'OK' | null;
      try {
        acquired = await client.set(key, token, 'PX', ttlMs, 'NX');
      } catch {
        // Fail-open: Redis hiccup must not block verification-code delivery.
        logger.warn(
          'Redis mailbox lock acquire failed — proceeding without distributed lock',
          { mailboxId: id },
        );
        return NOOP_HANDLE;
      }

      if (acquired !== 'OK') {
        // Another process holds a live lease → busy.
        return null;
      }

      let released = false;
      return {
        async release(): Promise<void> {
          if (released) return;
          released = true;
          try {
            await client.eval(RELEASE_LUA, 1, key, token);
          } catch {
            // The lease will expire on its own via the TTL; do not throw.
            logger.warn(
              'Redis mailbox lock release failed — lease will expire via TTL',
              { mailboxId: id },
            );
          }
        },
      };
    },
  };
}
