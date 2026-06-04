import { describe, it, expect } from 'vitest';

import {
  aggregateBuckets,
  buildJobResultMutations,
  bucketKeysForWindow,
  classifyWorkerStatus,
  WORKER_METRICS_BUCKET_MS,
  WORKER_METRICS_DEFAULT_WINDOW_MS,
  WORKER_METRIC_FIELDS,
} from '@/services/observability/worker-metrics';
import {
  createRedisWorkerMetricsRecorder,
  readWorkerMetricsViaRedis,
  type RedisMetricsClient,
} from '@/services/observability/redis-worker-metrics';

const NOW_MS = Date.parse('2026-06-04T12:00:00.000Z');

/** Flush the recorder's fire-and-forget microtasks. */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * In-memory Redis double that replays the same incr/max + per-bucket semantics
 * as the production Lua script, so writer + reader can be tested round-trip.
 */
function createFakeRedis(): RedisMetricsClient & {
  store: Map<string, Map<string, number>>;
} {
  const store = new Map<string, Map<string, number>>();
  return {
    store,
    async eval(_script, _numKeys, ...args) {
      const key = String(args[0]);
      const hash = store.get(key) ?? new Map<string, number>();
      for (let i = 2; i + 2 <= args.length; i += 3) {
        const field = String(args[i]);
        const op = String(args[i + 1]);
        const value = Number(args[i + 2]);
        if (op === 'incr') {
          hash.set(field, (hash.get(field) ?? 0) + value);
        } else if (op === 'max') {
          hash.set(field, Math.max(hash.get(field) ?? 0, value));
        }
      }
      store.set(key, hash);
      return 1;
    },
    async hgetall(key) {
      const hash = store.get(key);
      if (!hash) return {};
      const out: Record<string, string> = {};
      for (const [field, value] of hash) out[field] = String(value);
      return out;
    },
  };
}

describe('buildJobResultMutations', () => {
  it('records the result counter and rounds latency, omitting null durations', () => {
    const mutations = buildJobResultMutations({
      result: 'completed',
      queueWaitMs: 1000.4,
      processingDurationMs: null,
    });

    expect(mutations).toContainEqual({
      field: WORKER_METRIC_FIELDS.jobsCompleted,
      op: 'incr',
      value: 1,
    });
    expect(mutations).toContainEqual({
      field: WORKER_METRIC_FIELDS.queueWaitSum,
      op: 'incr',
      value: 1000,
    });
    expect(mutations).toContainEqual({
      field: WORKER_METRIC_FIELDS.queueWaitMax,
      op: 'max',
      value: 1000,
    });
    // processingDurationMs was null → no processing fields emitted.
    expect(
      mutations.some((m) => m.field === WORKER_METRIC_FIELDS.processingCount),
    ).toBe(false);
  });
});

describe('bucketKeysForWindow', () => {
  it('covers both ends of the window inclusively', () => {
    const keys = bucketKeysForWindow(NOW_MS, WORKER_METRICS_BUCKET_MS);
    expect(keys.length).toBe(2);
    keys.forEach((key) => expect(key.startsWith('obs:wm:')).toBe(true));
  });
});

describe('classifyWorkerStatus', () => {
  it('is UNKNOWN with no jobs in the window', () => {
    expect(
      classifyWorkerStatus(
        { completed: 0, failed: 0, skipped: 0, deferred: 0 },
        null,
      ),
    ).toBe('UNKNOWN');
  });

  it('is WARN when a job failed', () => {
    expect(
      classifyWorkerStatus(
        { completed: 5, failed: 1, skipped: 0, deferred: 0 },
        { count: 5, totalMs: 100, maxMs: 100, avgMs: 20 },
      ),
    ).toBe('WARN');
  });

  it('is CRITICAL on extreme queue wait', () => {
    expect(
      classifyWorkerStatus(
        { completed: 5, failed: 0, skipped: 0, deferred: 0 },
        { count: 5, totalMs: 0, maxMs: 200_000, avgMs: 0 },
      ),
    ).toBe('CRITICAL');
  });
});

describe('Redis worker metrics — writer + reader round trip', () => {
  it('aggregates job results, latency, defers, and throttle waits', async () => {
    const redis = createFakeRedis();
    const recorder = createRedisWorkerMetricsRecorder({
      getClient: async () => redis,
      now: () => NOW_MS,
    });

    recorder.recordJobResult({
      result: 'completed',
      queueWaitMs: 1000,
      processingDurationMs: 200,
    });
    recorder.recordJobResult({
      result: 'failed',
      queueWaitMs: 3000,
      processingDurationMs: 500,
    });
    recorder.recordMailboxBusyDefer();
    recorder.recordDestinationThrottleWait(1000);
    recorder.recordGlobalThrottleWait(40);
    await flush();

    const snapshot = await readWorkerMetricsViaRedis(
      redis,
      NOW_MS,
      WORKER_METRICS_DEFAULT_WINDOW_MS,
    );

    expect(snapshot.availability).toBe('AVAILABLE');
    expect(snapshot.jobs).toEqual({
      completed: 1,
      failed: 1,
      skipped: 0,
      deferred: 0,
    });
    expect(snapshot.queueWait).toMatchObject({
      count: 2,
      totalMs: 4000,
      maxMs: 3000,
      avgMs: 2000,
    });
    expect(snapshot.mailboxBusyDefer?.count).toBe(1);
    expect(snapshot.destinationThrottle?.count).toBe(1);
    expect(snapshot.globalThrottle?.count).toBe(1);
    // failed >= 1 ⇒ WARN.
    expect(snapshot.status).toBe('WARN');
  });

  it('never throws when the Redis client is unavailable (best-effort)', async () => {
    const recorder = createRedisWorkerMetricsRecorder({
      getClient: async () => {
        throw new Error('redis down');
      },
      now: () => NOW_MS,
    });

    expect(() => recorder.recordMailboxBusyDefer()).not.toThrow();
    expect(() =>
      recorder.recordJobResult({
        result: 'completed',
        queueWaitMs: 10,
        processingDurationMs: 10,
      }),
    ).not.toThrow();
    await flush();
  });

  it('reports an idle window as UNKNOWN status with zeroed aggregates', () => {
    const snapshot = aggregateBuckets([{}], WORKER_METRICS_DEFAULT_WINDOW_MS, new Date(NOW_MS));
    expect(snapshot.availability).toBe('AVAILABLE');
    expect(snapshot.jobs).toEqual({
      completed: 0,
      failed: 0,
      skipped: 0,
      deferred: 0,
    });
    expect(snapshot.status).toBe('UNKNOWN');
  });
});
