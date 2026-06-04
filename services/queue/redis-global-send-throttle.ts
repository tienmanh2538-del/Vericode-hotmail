// TASK-070 — Redis-backed (cross-process) global Telegram bot pacer.
//
// The in-memory global pacer (`createInMemoryGlobalSendThrottle`, TASK-068B) only
// spaces bot sends inside ONE worker process. Once the deployment runs more than
// one email-worker replica, each replica keeps its OWN pacing slot, so the total
// send rate across the bot = sum of every replica and can exceed Telegram's
// ~30 msg/second per-bot ceiling even when each process is "on pace".
//
// This module provides the cross-process equivalent behind the SAME
// `GlobalSendThrottle` interface: every reserve() — from every process — contends
// on a single shared Redis key, so the bot paces against one global slot.
//
// Design:
//   - reserve() = one atomic Lua script ("reserve the next slot"). It mirrors the
//     spacing logic of `createInMemoryDestinationThrottle.reserve` (now / interval
//     / cap) but server-side, so concurrent callers across processes serialise on
//     the same key instead of each computing against private state.
//   - The per-send wait is still capped by `maxWaitMs` (TASK-068B contract) so a
//     single code is never delayed unboundedly.
//   - Fail-safe: if Redis cannot be resolved (or an eval fails), the pacer degrades
//     to an in-process in-memory pacer so a burst is still spaced AND delivery is
//     never blocked. Exactly the fail-open philosophy of the TASK-068A lock.
//
// SECURITY: only an opaque constant key and integer timestamps cross the wire. No
// verification code, email body, token, secret, or Redis URL is ever read, written,
// or logged here — a Redis failure logs a static message with empty context only.

import { createLogger, type Logger } from '@/lib/logger';

import type { DestinationReservation } from './destination-throttle';
import {
  createInMemoryGlobalSendThrottle,
  DEFAULT_GLOBAL_SEND_MAX_WAIT_MS,
  DEFAULT_GLOBAL_SEND_MIN_INTERVAL_MS,
  type GlobalSendThrottle,
} from './global-send-throttle';

/** The single shared Redis key — every process paces against this one slot. */
export const DEFAULT_REDIS_GLOBAL_SEND_KEY = 'telegram-bot::global-pace';

/**
 * Default key TTL. The pacer raises it if needed so the key always outlasts the
 * furthest point it ever schedules (kept active during a burst, self-cleans when
 * the bot goes idle so pacing resets to "send now").
 */
export const DEFAULT_REDIS_GLOBAL_SEND_TTL_MS = 10_000;

/** Default cap on how long resolving the shared Redis client may block a send. */
export const DEFAULT_REDIS_GLOBAL_SEND_CONNECT_TIMEOUT_MS = 2_000;

// Atomic "reserve the next global slot". KEYS[1] = shared key. ARGV = (now,
// interval, maxWait, ttl) in ms. Returns the ms the caller must wait before
// sending. `stored` is the earliest epoch-ms at which the next send may proceed;
// a missing/expired key reads as 0 (send now). This is the in-memory throttle's
// math, executed server-side so cross-process callers converge on one slot.
const RESERVE_LUA = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local interval = tonumber(ARGV[2])
local maxWait = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local stored = tonumber(redis.call('get', key)) or 0
local earliest = stored
if now > earliest then earliest = now end
local waitMs = earliest - now
local scheduledAt = earliest
if waitMs > maxWait then
  waitMs = maxWait
  scheduledAt = now + maxWait
end
redis.call('set', key, scheduledAt + interval, 'PX', ttl)
return waitMs
`;

/**
 * Minimal Redis surface this pacer needs. Declared locally so the module has NO
 * hard dependency on `ioredis` (only a nested dependency of bullmq). Any client
 * exposing `eval` — including a fake in tests — satisfies it.
 */
export interface RedisGlobalThrottleClient {
  eval(
    script: string,
    numKeys: number,
    ...keysAndArgs: (string | number)[]
  ): Promise<unknown>;
}

export type RedisGlobalThrottleClientProvider =
  () => Promise<RedisGlobalThrottleClient>;

export interface RedisGlobalSendThrottleOptions {
  /** Lazy provider for the shared Redis client (resolved on first reserve()). */
  getClient: RedisGlobalThrottleClientProvider;
  /** Minimum gap between any two bot sends. Defaults to 40ms (TASK-068B). */
  minIntervalMs?: number;
  /** Upper bound on a single reservation's wait. Defaults to 2s (TASK-068B). */
  maxWaitMs?: number;
  /** Shared-key TTL in ms. Raised if below the furthest scheduled point. */
  ttlMs?: number;
  /** Shared Redis key. Defaults to a single constant so ALL sends share it. */
  key?: string;
  /** Cap on the one-time client resolution so a send is never blocked forever. */
  connectTimeoutMs?: number;
  /** Clock source in epoch ms. Injectable so tests run deterministically. */
  now?: () => number;
  logger?: Logger;
}

function positiveOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && value > 0 ? value : fallback;
}

function nonNegativeOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && value >= 0 ? value : fallback;
}

/** Coerce the Lua reply into a safe, capped, non-negative integer wait. */
function clampWaitMs(raw: unknown, maxWaitMs: number): number {
  const parsed = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.floor(parsed), maxWaitMs);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('redis global pacer client resolution timed out'));
    }, ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Build a Redis-backed global send pacer. Share ONE instance across every job so
 * all sends (within and across processes) contend on the same Redis key.
 */
export function createRedisGlobalSendThrottle(
  options: RedisGlobalSendThrottleOptions,
): GlobalSendThrottle {
  const minIntervalMs = positiveOr(
    options.minIntervalMs,
    DEFAULT_GLOBAL_SEND_MIN_INTERVAL_MS,
  );
  const maxWaitMs = nonNegativeOr(
    options.maxWaitMs,
    DEFAULT_GLOBAL_SEND_MAX_WAIT_MS,
  );
  const key = options.key ?? DEFAULT_REDIS_GLOBAL_SEND_KEY;
  const now = options.now ?? (() => Date.now());
  const logger = options.logger ?? createLogger();
  const connectTimeoutMs = positiveOr(
    options.connectTimeoutMs,
    DEFAULT_REDIS_GLOBAL_SEND_CONNECT_TIMEOUT_MS,
  );
  // The TTL must outlast the furthest point we ever schedule (now + maxWait +
  // interval) so an active key is never evicted mid-burst.
  const ttlMs = Math.max(
    positiveOr(options.ttlMs, DEFAULT_REDIS_GLOBAL_SEND_TTL_MS),
    maxWaitMs + minIntervalMs + 1_000,
  );

  // Degraded mode when Redis is unavailable: still pace per-process (never leave a
  // burst completely unspaced) and never block delivery.
  const fallback = createInMemoryGlobalSendThrottle({
    minIntervalMs,
    maxWaitMs,
    now,
  });

  // Resolve the shared client once. ioredis auto-reconnects internally, so a single
  // resolution is enough; if it never resolves we remember that and stay on the
  // local fallback rather than re-attempting (and re-timing-out) on every send.
  let clientPromise: Promise<RedisGlobalThrottleClient> | null = null;
  let clientUnavailable = false;

  async function resolveClient(): Promise<RedisGlobalThrottleClient | null> {
    if (clientUnavailable) return null;
    if (clientPromise === null) {
      clientPromise = withTimeout(options.getClient(), connectTimeoutMs);
    }
    try {
      return await clientPromise;
    } catch {
      clientUnavailable = true;
      clientPromise = null;
      logger.warn(
        'Redis global send pacer client unavailable — using in-process pacing',
        {},
      );
      return null;
    }
  }

  return {
    async reserve(): Promise<DestinationReservation> {
      const client = await resolveClient();
      if (client === null) {
        return fallback.reserve();
      }
      try {
        const raw = await client.eval(
          RESERVE_LUA,
          1,
          key,
          String(now()),
          String(minIntervalMs),
          String(maxWaitMs),
          String(ttlMs),
        );
        return { waitMs: clampWaitMs(raw, maxWaitMs) };
      } catch {
        // SECURITY: never log the error object or any connection detail — a Redis
        // URL/password could ride along. Static message + empty context only.
        logger.warn(
          'Redis global send pacer reserve failed — using in-process pacing for this send',
          {},
        );
        return fallback.reserve();
      }
    },
  };
}
