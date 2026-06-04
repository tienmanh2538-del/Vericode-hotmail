import { describe, it, expect, vi } from 'vitest';

import type { Logger } from '@/lib/logger';
import {
  createRedisGlobalSendThrottle,
  DEFAULT_REDIS_GLOBAL_SEND_KEY,
  type RedisGlobalThrottleClient,
} from '@/services/queue/redis-global-send-throttle';

// A clearly-fake Redis URL used ONLY to prove it never leaks into logs. It is not
// a real connection string and is never used to connect.
const FAKE_REDIS_URL = 'redis://fake-user:fake-pass@fake-host:6379/0';

/**
 * In-memory Redis fake whose `eval` replays the pacer's Lua math in JS, keyed on
 * the Redis key. Two throttles pointed at the SAME fake share its `store`, which
 * is exactly how two worker processes share one Redis key.
 */
function createFakeRedis(): RedisGlobalThrottleClient & {
  store: Map<string, number>;
} {
  const store = new Map<string, number>();
  return {
    store,
    async eval(_script, _numKeys, ...args): Promise<number> {
      const [key, nowStr, intervalStr, maxWaitStr] = args as string[];
      const now = Number(nowStr);
      const interval = Number(intervalStr);
      const maxWait = Number(maxWaitStr);
      const stored = store.get(String(key)) ?? 0;
      let earliest = Math.max(now, stored);
      let waitMs = earliest - now;
      let scheduledAt = earliest;
      if (waitMs > maxWait) {
        waitMs = maxWait;
        scheduledAt = now + maxWait;
      }
      store.set(String(key), scheduledAt + interval);
      return waitMs;
    },
  };
}

function recordingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const record =
    (level: string) => (msg: string, ctx?: Record<string, unknown>) => {
      lines.push(`${level} ${msg} ${ctx ? JSON.stringify(ctx) : ''}`);
    };
  return {
    lines,
    logger: {
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
    },
  };
}

describe('createRedisGlobalSendThrottle — TASK-070 cross-process bot pacing', () => {
  it('serialises callers sharing one Redis key by the same interval', async () => {
    const redis = createFakeRedis();
    const getClient = async () => redis;

    // Two independent throttles = two worker processes contending on one key.
    const procA = createRedisGlobalSendThrottle({
      getClient,
      minIntervalMs: 40,
      now: () => 1_000,
    });
    const procB = createRedisGlobalSendThrottle({
      getClient,
      minIntervalMs: 40,
      now: () => 1_000,
    });

    // Interleaved sends across the two processes still pace one interval apart,
    // because the slot lives in the shared Redis key — not in per-process state.
    expect((await procA.reserve()).waitMs).toBe(0);
    expect((await procB.reserve()).waitMs).toBe(40);
    expect((await procA.reserve()).waitMs).toBe(80);
    expect((await procB.reserve()).waitMs).toBe(120);

    // All sends contended on the single shared key.
    expect([...redis.store.keys()]).toEqual([DEFAULT_REDIS_GLOBAL_SEND_KEY]);
  });

  it('caps a single send wait so a code is never delayed unboundedly', async () => {
    const redis = createFakeRedis();
    const throttle = createRedisGlobalSendThrottle({
      getClient: async () => redis,
      minIntervalMs: 10_000,
      maxWaitMs: 500,
      now: () => 0,
    });

    await throttle.reserve(); // schedules far ahead (10s)
    // Natural wait would be 10s, but it is capped at the configured max.
    expect((await throttle.reserve()).waitMs).toBe(500);
  });

  it('clamps a malformed Lua reply to a safe, capped wait', async () => {
    const client: RedisGlobalThrottleClient = {
      eval: vi.fn(async () => 'not-a-number'),
    };
    const throttle = createRedisGlobalSendThrottle({
      getClient: async () => client,
      maxWaitMs: 2_000,
    });
    expect((await throttle.reserve()).waitMs).toBe(0);
  });

  it('never lets the wait exceed maxWait even if Redis returns a huge value', async () => {
    const client: RedisGlobalThrottleClient = {
      eval: vi.fn(async () => 999_999),
    };
    const throttle = createRedisGlobalSendThrottle({
      getClient: async () => client,
      maxWaitMs: 2_000,
    });
    expect((await throttle.reserve()).waitMs).toBe(2_000);
  });

  it('fails safe (in-process pacing) when an eval errors — no secret/URL leak', async () => {
    const { logger, lines } = recordingLogger();
    const client: RedisGlobalThrottleClient = {
      // Throw an error whose message embeds a fake connection string; the pacer
      // must NOT log the error object, so it can never escape.
      eval: vi.fn(async () => {
        throw new Error(`ECONNREFUSED ${FAKE_REDIS_URL}`);
      }),
    };
    const throttle = createRedisGlobalSendThrottle({
      getClient: async () => client,
      minIntervalMs: 40,
      now: () => 0,
      logger,
    });

    // Delivery is never blocked: a numeric, in-bounds wait still comes back.
    const first = await throttle.reserve();
    const second = await throttle.reserve();
    expect(first.waitMs).toBe(0);
    expect(second.waitMs).toBe(40); // degraded to the in-process fallback pacer

    const joined = lines.join('\n');
    expect(joined).not.toContain('redis://');
    expect(joined).not.toContain('fake-pass');
    expect(joined).not.toContain('fake-host');
    expect(joined).not.toContain('ECONNREFUSED');
    // It still logs a static, safe warning (empty context).
    expect(joined).toContain('Redis global send pacer reserve failed');
  });

  it('falls back to in-process pacing when the client cannot be resolved', async () => {
    const { logger, lines } = recordingLogger();
    const throttle = createRedisGlobalSendThrottle({
      getClient: async () => {
        throw new Error(`auth failed for ${FAKE_REDIS_URL}`);
      },
      minIntervalMs: 40,
      now: () => 0,
      logger,
    });

    expect((await throttle.reserve()).waitMs).toBe(0);
    expect((await throttle.reserve()).waitMs).toBe(40);

    const joined = lines.join('\n');
    expect(joined).not.toContain(FAKE_REDIS_URL);
    expect(joined).not.toContain('fake-pass');
    expect(joined).toContain(
      'Redis global send pacer client unavailable',
    );
  });

  it('falls back when client resolution times out (never blocks delivery)', async () => {
    const throttle = createRedisGlobalSendThrottle({
      // A provider that never resolves must not wedge the delivery path.
      getClient: () => new Promise<RedisGlobalThrottleClient>(() => {}),
      minIntervalMs: 40,
      maxWaitMs: 2_000,
      connectTimeoutMs: 20,
      now: () => 0,
    });

    const first = await throttle.reserve();
    expect(first.waitMs).toBe(0);
    expect(first.waitMs).toBeLessThanOrEqual(2_000);
  });

  it('resolves the shared client only once across many sends', async () => {
    const redis = createFakeRedis();
    const getClient = vi.fn(async () => redis);
    const throttle = createRedisGlobalSendThrottle({
      getClient,
      minIntervalMs: 40,
      now: () => 0,
    });

    await throttle.reserve();
    await throttle.reserve();
    await throttle.reserve();

    // One resolution, reused — no reconnect storm on the hot delivery path.
    expect(getClient).toHaveBeenCalledTimes(1);
  });
});
