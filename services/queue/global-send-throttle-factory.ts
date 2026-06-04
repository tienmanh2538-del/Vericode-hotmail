// TASK-070 — selects the global Telegram bot pacer implementation.
//
// Policy (mirrors `mailbox-lock-factory` from TASK-068A):
//   - No shared Redis client provider  → in-memory pacer (local/test, and the
//     current single-process baseline). Behaviour is unchanged from TASK-068B.
//   - A shared Redis client provider    → Redis-backed cross-process pacer, so
//     every worker replica paces against one global slot.
//
// The factory deliberately does NOT construct a Redis client itself: the caller
// (the worker entry) injects a lazy provider only when the deployment is ready
// (see the seam in `email-worker-runner`). Both backends satisfy
// `GlobalSendThrottle`, so the pipeline never branches on the backend.

import type { Logger } from '@/lib/logger';

import {
  createInMemoryGlobalSendThrottle,
  type GlobalSendThrottle,
  type InMemoryGlobalSendThrottleOptions,
} from './global-send-throttle';
import {
  createRedisGlobalSendThrottle,
  type RedisGlobalThrottleClientProvider,
} from './redis-global-send-throttle';

export interface GlobalSendThrottleFactoryOptions
  extends InMemoryGlobalSendThrottleOptions {
  /**
   * Lazy provider for the shared Redis client. When omitted/null the in-memory
   * pacer is returned (no cross-process pacing).
   */
  getRedisClient?: RedisGlobalThrottleClientProvider | null;
  /** Shared-key TTL applied to the Redis backend. */
  ttlMs?: number;
  /** Shared Redis key applied to the Redis backend. */
  key?: string;
  /** Client-resolution timeout applied to the Redis backend. */
  connectTimeoutMs?: number;
  logger?: Logger;
}

/**
 * Build the global send pacer for the current deployment. Returns the Redis-backed
 * pacer when a client provider is supplied, otherwise the in-memory pacer.
 */
export function createGlobalSendThrottle(
  options: GlobalSendThrottleFactoryOptions = {},
): GlobalSendThrottle {
  if (options.getRedisClient) {
    return createRedisGlobalSendThrottle({
      getClient: options.getRedisClient,
      minIntervalMs: options.minIntervalMs,
      maxWaitMs: options.maxWaitMs,
      ttlMs: options.ttlMs,
      key: options.key,
      connectTimeoutMs: options.connectTimeoutMs,
      now: options.now,
      logger: options.logger,
    });
  }
  return createInMemoryGlobalSendThrottle({
    minIntervalMs: options.minIntervalMs,
    maxWaitMs: options.maxWaitMs,
    now: options.now,
  });
}
