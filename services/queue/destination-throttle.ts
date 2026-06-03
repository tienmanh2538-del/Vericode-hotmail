// TASK-055 — Shared Telegram destination burst guard.
//
// Many mailboxes may route to the SAME reusable Telegram destination
// (group/topic) — see TASK-053. Without a guard, a burst of verification codes
// across those mailboxes would all fire at the same chat/topic at once and trip
// Telegram's per-chat flood limits. This module spaces sends to the same
// destination by a minimum interval.
//
// Design (minimal, per TASK-055):
//   - `reserve(key)` returns how long the caller should wait (`waitMs`) before
//     sending to that destination. It NEVER causes a queue-level retry, so it can
//     never collide with the pipeline's dedup-claim (a deferred-then-retried job
//     would otherwise be swallowed as a duplicate and the code lost). The caller
//     simply sleeps the returned `waitMs` in-line and then sends.
//   - Per-hop wait is capped (`maxWaitMs`) so a single code is never delayed
//     unboundedly. Under extreme burst the spacing degrades gracefully toward the
//     cap instead of blocking delivery.
//   - It does NOT change routing, does not broadcast, and does not look at the
//     code or message body. Only the opaque destination key is used.

/** Default minimum spacing between two sends to the same destination. */
export const DEFAULT_DESTINATION_MIN_INTERVAL_MS = 1_000;

/** Default hard cap on how long one send may be delayed by the throttle. */
export const DEFAULT_DESTINATION_MAX_WAIT_MS = 15_000;

export interface DestinationReservation {
  /** Milliseconds the caller should wait before sending. 0 = send now. */
  waitMs: number;
}

export interface DestinationThrottle {
  /** Reserve the next spaced send slot for `destinationKey`. */
  reserve(destinationKey: string): DestinationReservation;
}

export interface InMemoryDestinationThrottleOptions {
  /** Minimum gap between sends to one destination. Defaults to 1s. */
  minIntervalMs?: number;
  /** Upper bound on a single reservation's wait. Defaults to 15s. */
  maxWaitMs?: number;
  /** Clock source in epoch ms. Injectable so tests run deterministically. */
  now?: () => number;
}

/**
 * Build a stable destination key from the chat id and optional forum topic id.
 * Two mailboxes sharing the same group/topic produce the same key (and are thus
 * spaced together); a different topic on the same group is a different key.
 */
export function buildDestinationKey(
  chatId: string,
  threadId?: string | null,
): string {
  const chat = typeof chatId === 'string' ? chatId.trim() : '';
  const thread =
    typeof threadId === 'string' && threadId.trim().length > 0
      ? threadId.trim()
      : '';
  return `${chat}::${thread}`;
}

/**
 * Build an in-memory destination throttle. Share ONE instance across every job
 * so the `destinationKey → nextAvailableAt` map is shared and bursts across
 * mailboxes that target the same destination are spaced together.
 */
export function createInMemoryDestinationThrottle(
  options: InMemoryDestinationThrottleOptions = {},
): DestinationThrottle {
  const minIntervalMs =
    typeof options.minIntervalMs === 'number' && options.minIntervalMs > 0
      ? options.minIntervalMs
      : DEFAULT_DESTINATION_MIN_INTERVAL_MS;
  const maxWaitMs =
    typeof options.maxWaitMs === 'number' && options.maxWaitMs >= 0
      ? options.maxWaitMs
      : DEFAULT_DESTINATION_MAX_WAIT_MS;
  const now = options.now ?? (() => Date.now());

  // destinationKey → earliest epoch ms at which the next send may proceed.
  const nextAvailableAt = new Map<string, number>();

  return {
    reserve(destinationKey: string): DestinationReservation {
      const key = typeof destinationKey === 'string' ? destinationKey : '';
      const current = now();
      const earliest = Math.max(current, nextAvailableAt.get(key) ?? 0);

      let scheduledAt = earliest;
      let waitMs = earliest - current;
      if (waitMs > maxWaitMs) {
        // Cap the wait for this single send; schedule from the capped point so
        // accounting stays consistent with what the caller will actually wait.
        waitMs = maxWaitMs;
        scheduledAt = current + maxWaitMs;
      }

      nextAvailableAt.set(key, scheduledAt + minIntervalMs);
      return { waitMs };
    },
  };
}
