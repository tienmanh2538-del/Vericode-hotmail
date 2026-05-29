import type { RedisOptions } from 'bullmq';

import { loadQueueEnv } from '@/lib/env';

/**
 * BullMQ connection options derived from `REDIS_URL`. Returning options
 * instead of a live Redis client is deliberate:
 *   1. No socket is opened at import time.
 *   2. BullMQ creates and owns its own Redis client per Queue/Worker, so
 *      shutdown is well-defined (`queue.close()`/`worker.close()`).
 *   3. We avoid an explicit top-level `ioredis` dependency that conflicts
 *      with BullMQ's bundled version (different sub-paths in TypeScript).
 *
 * The URL is parsed lazily on each call. We never log the URL because it
 * may contain a password.
 */
export function getRedisConnectionOptions(): RedisOptions {
  const { redisUrl } = loadQueueEnv();
  const parsed = new URL(redisUrl);

  const port = parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : 6379;
  const password = parsed.password.length > 0 ? parsed.password : undefined;
  const username = parsed.username.length > 0 ? parsed.username : undefined;

  const options: RedisOptions = {
    host: parsed.hostname,
    port: Number.isFinite(port) ? port : 6379,
    password,
    username,
    // BullMQ requires this to be null for Worker connections; safe for Queue.
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
  };

  if (parsed.pathname.length > 1) {
    const db = Number.parseInt(parsed.pathname.slice(1), 10);
    if (Number.isFinite(db) && db >= 0) {
      (options as RedisOptions & { db?: number }).db = db;
    }
  }

  return options;
}
