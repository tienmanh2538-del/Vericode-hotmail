// TASK-068A — selects the per-mailbox processing lock implementation.
//
// Policy (matches the task contract):
//   - No shared Redis lock client provided  → in-memory lock (local/test, and the
//     current single-worker baseline). Behaviour is unchanged from TASK-055.
//   - A shared Redis lock client provided    → Redis-backed cross-process lock,
//     so multiple worker replicas serialise per mailbox.
//
// The factory deliberately does NOT construct a Redis client itself: `ioredis`
// is only a nested dependency of bullmq and is not resolvable at the top level,
// and auto-opening a socket would change production behaviour before the lock has
// been validated against a real shared Redis. Instead the operator/worker entry
// injects a client when the deployment is ready (see the seam in
// email-worker-runner). Until then production keeps the in-memory lock — i.e. no
// production behaviour change unless a Redis client is explicitly wired in.

import {
  createInMemoryMailboxProcessingLock,
  type MailboxProcessingLock,
} from './mailbox-processing-lock';
import {
  createRedisMailboxProcessingLock,
  type RedisLockClient,
} from './redis-mailbox-lock';
import type { Logger } from '@/lib/logger';

export interface MailboxLockFactoryOptions {
  /**
   * Shared Redis client for the cross-process lock. When omitted/null the
   * in-memory lock is returned (no cross-process serialisation).
   */
  redisClient?: RedisLockClient | null;
  /** Lease length in ms applied to whichever backend is selected. */
  ttlMs?: number;
  logger?: Logger;
}

/**
 * Build the per-mailbox processing lock for the current deployment. Returns the
 * Redis-backed lock when a shared client is supplied, otherwise the in-memory
 * lock. Both satisfy `MailboxProcessingLock`, so callers never branch.
 */
export function createMailboxProcessingLock(
  options: MailboxLockFactoryOptions = {},
): MailboxProcessingLock {
  if (options.redisClient) {
    return createRedisMailboxProcessingLock(options.redisClient, {
      ttlMs: options.ttlMs,
      logger: options.logger,
    });
  }
  return createInMemoryMailboxProcessingLock(
    options.ttlMs !== undefined ? { ttlMs: options.ttlMs } : {},
  );
}
