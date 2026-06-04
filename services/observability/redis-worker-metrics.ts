// TASK-068C — Redis-backed worker metrics (writer + reader).
//
// Cross-process visibility: the email worker writes aggregate counters into
// short-TTL Redis hash buckets and the web/health process reads them back. We
// reuse the BullMQ queue's existing ioredis client (no extra top-level ioredis
// dependency, matching `redis-connection.ts`) so no new socket/connection is
// introduced for metrics.
//
// SECURITY: only opaque field names + integer counts/durations cross the wire.
// No code, email body, token, or Redis URL is ever read or written here.

import {
  aggregateBuckets,
  bucketKeyForEpoch,
  bucketKeysForWindow,
  buildDestinationThrottleMutations,
  buildGlobalThrottleMutations,
  buildJobResultMutations,
  buildMailboxBusyDeferMutations,
  createNoopWorkerMetricsRecorder,
  WORKER_METRICS_DEFAULT_WINDOW_MS,
  WORKER_METRICS_RETENTION_MS,
  type MetricMutation,
  type RecordJobResultInput,
  type WorkerMetricsRecorder,
} from './worker-metrics';
import type { WorkerMetricsSnapshot } from './observability.types';

/**
 * Minimal Redis command surface we use. Declared locally (not imported from
 * ioredis/bullmq) so we depend on behaviour, not a specific client version.
 */
export interface RedisMetricsClient {
  eval(
    script: string,
    numKeys: number,
    ...args: Array<string | number>
  ): Promise<unknown>;
  hgetall(key: string): Promise<Record<string, string>>;
}

export type RedisMetricsClientProvider = () => Promise<RedisMetricsClient>;

// Atomic per-event update: apply incr/max field ops, then refresh the bucket
// TTL. KEYS[1] = bucket key. ARGV[1] = ttl(ms). ARGV[2..] = (field, op, value)
// triples. A 'max' op only raises the stored value, so out-of-order writes from
// concurrent workers still converge to the true maximum.
const UPDATE_SCRIPT = `
local key = KEYS[1]
local ttl = tonumber(ARGV[1])
local i = 2
while i + 2 <= #ARGV do
  local field = ARGV[i]
  local op = ARGV[i + 1]
  local val = tonumber(ARGV[i + 2])
  if val ~= nil then
    if op == 'incr' then
      redis.call('HINCRBY', key, field, val)
    elseif op == 'max' then
      local cur = tonumber(redis.call('HGET', key, field))
      if cur == nil or val > cur then
        redis.call('HSET', key, field, val)
      end
    end
  end
  i = i + 3
end
if ttl ~= nil and ttl > 0 then
  redis.call('PEXPIRE', key, ttl)
end
return 1
`;

function mutationArgs(mutations: ReadonlyArray<MetricMutation>): Array<string | number> {
  const args: Array<string | number> = [];
  for (const mutation of mutations) {
    args.push(mutation.field, mutation.op, String(mutation.value));
  }
  return args;
}

export interface RedisWorkerMetricsOptions {
  getClient: RedisMetricsClientProvider;
  /** Epoch-ms clock. Injectable for deterministic tests. */
  now?: () => number;
  ttlMs?: number;
}

/**
 * Build a Redis-backed recorder. Every method is fire-and-forget: it resolves
 * the client and EVALs the update on a detached promise whose rejection is
 * swallowed, so a Redis hiccup can never throw into — or even slow — the worker
 * or the delivery pipeline.
 */
export function createRedisWorkerMetricsRecorder(
  options: RedisWorkerMetricsOptions,
): WorkerMetricsRecorder {
  const now = options.now ?? (() => Date.now());
  const ttlMs = options.ttlMs ?? WORKER_METRICS_RETENTION_MS;

  function dispatch(mutations: MetricMutation[]): void {
    if (mutations.length === 0) return;
    const key = bucketKeyForEpoch(now());
    void (async () => {
      try {
        const client = await options.getClient();
        await client.eval(UPDATE_SCRIPT, 1, key, String(ttlMs), ...mutationArgs(mutations));
      } catch {
        // Best-effort by contract — never surface a metrics write failure.
      }
    })();
  }

  return {
    recordJobResult(input: RecordJobResultInput) {
      dispatch(buildJobResultMutations(input));
    },
    recordMailboxBusyDefer() {
      dispatch(buildMailboxBusyDeferMutations());
    },
    recordDestinationThrottleWait(waitMs: number) {
      dispatch(buildDestinationThrottleMutations(waitMs));
    },
    recordGlobalThrottleWait(waitMs: number) {
      dispatch(buildGlobalThrottleMutations(waitMs));
    },
  };
}

/**
 * Read and aggregate the buckets covering the window. May reject if Redis is
 * unreachable — callers (the infra loader) wrap this with a timeout and fall
 * back to an UNKNOWN snapshot so the health page never crashes.
 */
export async function readWorkerMetricsViaRedis(
  client: RedisMetricsClient,
  nowMs: number,
  windowMs: number,
): Promise<WorkerMetricsSnapshot> {
  const keys = bucketKeysForWindow(nowMs, windowMs);
  const hashes = await Promise.all(keys.map((key) => client.hgetall(key)));
  const normalized = hashes.map((hash) => hash ?? {});
  return aggregateBuckets(normalized, windowMs, new Date(nowMs));
}

// ---------------------------------------------------------------------------
// Production singletons (lazy — no Redis connection opened at import time)
// ---------------------------------------------------------------------------

let cachedClientPromise: Promise<RedisMetricsClient> | null = null;

/**
 * Resolve the shared BullMQ queue's ioredis client. Lazy so importing this
 * module opens no socket; cached so we reuse one connection. On failure the
 * cache is cleared so a later call can retry.
 */
async function getDefaultMetricsClient(): Promise<RedisMetricsClient> {
  if (cachedClientPromise === null) {
    cachedClientPromise = (async () => {
      const { getEmailQueue } = await import('@/services/queue/email-queue');
      const client = await getEmailQueue().client;
      return client as unknown as RedisMetricsClient;
    })().catch((error: unknown) => {
      cachedClientPromise = null;
      throw error;
    });
  }
  return cachedClientPromise;
}

let cachedRecorder: WorkerMetricsRecorder | null = null;

/**
 * The process-wide production recorder. If the Redis client cannot be resolved
 * the recorder still no-ops safely (the dispatch swallows the error). Tests
 * never call this — they construct a recorder with an injected client.
 */
export function getWorkerMetricsRecorder(): WorkerMetricsRecorder {
  if (cachedRecorder === null) {
    try {
      cachedRecorder = createRedisWorkerMetricsRecorder({
        getClient: getDefaultMetricsClient,
      });
    } catch {
      cachedRecorder = createNoopWorkerMetricsRecorder();
    }
  }
  return cachedRecorder;
}

/**
 * Read the production worker-metrics snapshot. Resolves the shared client and
 * aggregates the window. Rejects on Redis failure (the infra loader handles the
 * fallback) — it never returns a partially-true snapshot.
 */
export async function readWorkerMetricsSnapshot(
  nowMs: number,
  windowMs: number = WORKER_METRICS_DEFAULT_WINDOW_MS,
): Promise<WorkerMetricsSnapshot> {
  const client = await getDefaultMetricsClient();
  return readWorkerMetricsViaRedis(client, nowMs, windowMs);
}
