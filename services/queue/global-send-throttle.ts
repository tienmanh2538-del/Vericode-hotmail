// TASK-068B — Global Telegram bot send pacing.
//
// TASK-055 added a per-destination burst guard (space sends to the SAME
// chat/topic). But Telegram also rate-limits at the BOT level: across ALL chats
// a bot may send only ~30 messages/second before it is throttled. At ~100
// mailboxes a burst spread across many DIFFERENT destinations would slip past
// the per-destination guard yet still trip the global bot limit.
//
// This module adds a single, process-wide pacing slot in front of every send,
// independent of destination. It deliberately reuses the same interval-spacing
// primitive as the destination throttle (one tested implementation) but keys it
// on a single constant so ALL sends share one slot.
//
// Design (minimal, per TASK-068B):
//   - `reserve()` returns how long the caller should wait before sending. Like
//     the destination throttle it NEVER triggers a queue retry — the caller just
//     sleeps the returned `waitMs` in-line, so it cannot collide with the dedup
//     claim and cannot re-deliver a code.
//   - The per-send wait is capped (`maxWaitMs`) so a single code is never delayed
//     unboundedly; under extreme burst the pacing degrades toward the cap.
//   - It does NOT change routing, does not broadcast, and never reads the code or
//     message body — it only spaces the bot's outbound calls in time.

import {
  createInMemoryDestinationThrottle,
  type DestinationReservation,
} from './destination-throttle';

/**
 * Default minimum spacing between two bot sends. 40ms ⇒ ≤ 25 sends/second,
 * comfortably under Telegram's ~30/second global bot ceiling.
 */
export const DEFAULT_GLOBAL_SEND_MIN_INTERVAL_MS = 40;

/** Default hard cap on how long one send may be delayed by the global pacer. */
export const DEFAULT_GLOBAL_SEND_MAX_WAIT_MS = 2_000;

/** The single shared key — every send paces against the same global slot. */
const GLOBAL_SEND_KEY = 'telegram-bot::global';

export interface GlobalSendThrottle {
  /**
   * Reserve the next globally-paced send slot.
   *
   * TASK-070 — the result may be a Promise: the in-memory pacer resolves
   * synchronously (unchanged), but a cross-process Redis-backed pacer must do a
   * round-trip. Callers `await` the result, which is a no-op for the sync case.
   */
  reserve(): DestinationReservation | Promise<DestinationReservation>;
}

/**
 * Narrower variant whose `reserve()` is always synchronous. The in-memory pacer
 * returns this so existing synchronous callers/tests keep working; it is still
 * assignable to {@link GlobalSendThrottle}.
 */
export interface SyncGlobalSendThrottle extends GlobalSendThrottle {
  reserve(): DestinationReservation;
}

export interface InMemoryGlobalSendThrottleOptions {
  /** Minimum gap between any two bot sends. Defaults to 40ms. */
  minIntervalMs?: number;
  /** Upper bound on a single reservation's wait. Defaults to 2s. */
  maxWaitMs?: number;
  /** Clock source in epoch ms. Injectable so tests run deterministically. */
  now?: () => number;
}

/**
 * Build an in-memory global send pacer. Share ONE instance across every job so
 * all sends pace against the same slot. Backed by the destination-throttle
 * primitive pinned to a single key, so the spacing/cap semantics are identical
 * and already covered by tests.
 */
export function createInMemoryGlobalSendThrottle(
  options: InMemoryGlobalSendThrottleOptions = {},
): SyncGlobalSendThrottle {
  const minIntervalMs =
    typeof options.minIntervalMs === 'number' && options.minIntervalMs > 0
      ? options.minIntervalMs
      : DEFAULT_GLOBAL_SEND_MIN_INTERVAL_MS;
  const maxWaitMs =
    typeof options.maxWaitMs === 'number' && options.maxWaitMs >= 0
      ? options.maxWaitMs
      : DEFAULT_GLOBAL_SEND_MAX_WAIT_MS;

  const inner = createInMemoryDestinationThrottle({
    minIntervalMs,
    maxWaitMs,
    now: options.now,
  });

  return {
    reserve(): DestinationReservation {
      return inner.reserve(GLOBAL_SEND_KEY);
    },
  };
}
