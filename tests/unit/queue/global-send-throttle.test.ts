import { describe, it, expect } from 'vitest';

import {
  createInMemoryGlobalSendThrottle,
  DEFAULT_GLOBAL_SEND_MAX_WAIT_MS,
  DEFAULT_GLOBAL_SEND_MIN_INTERVAL_MS,
} from '@/services/queue/global-send-throttle';

describe('createInMemoryGlobalSendThrottle — TASK-068B global bot pacing', () => {
  it('allows the first send immediately and paces subsequent sends', () => {
    const throttle = createInMemoryGlobalSendThrottle({
      minIntervalMs: 40,
      now: () => 1_000,
    });

    // First send: no wait. Two more at the same instant pace one interval apart.
    expect(throttle.reserve().waitMs).toBe(0);
    expect(throttle.reserve().waitMs).toBe(40);
    expect(throttle.reserve().waitMs).toBe(80);
  });

  it('paces ALL sends against one global slot regardless of destination', () => {
    // Unlike the per-destination throttle, every reserve() shares the same slot,
    // so a burst across many different destinations is still spaced.
    const throttle = createInMemoryGlobalSendThrottle({
      minIntervalMs: 40,
      now: () => 0,
    });
    const waits = [0, 0, 0, 0].map(() => throttle.reserve().waitMs);
    expect(waits).toEqual([0, 40, 80, 120]);
  });

  it('caps a single send wait so a code is never delayed unboundedly', () => {
    const throttle = createInMemoryGlobalSendThrottle({
      minIntervalMs: 10_000,
      maxWaitMs: 500,
      now: () => 0,
    });

    throttle.reserve(); // schedules far ahead
    // Natural wait would be 10s, but it is capped at the configured max.
    expect(throttle.reserve().waitMs).toBe(500);
  });

  it('never returns a wait above the default cap under heavy burst', () => {
    const throttle = createInMemoryGlobalSendThrottle({ now: () => 0 });
    // Fire a large burst; every individual wait stays within the hard cap.
    for (let i = 0; i < 1_000; i += 1) {
      expect(throttle.reserve().waitMs).toBeLessThanOrEqual(
        DEFAULT_GLOBAL_SEND_MAX_WAIT_MS,
      );
    }
  });

  it('exposes sane default constants (≤ ~25/s, with a wait cap)', () => {
    expect(DEFAULT_GLOBAL_SEND_MIN_INTERVAL_MS).toBeGreaterThan(0);
    expect(DEFAULT_GLOBAL_SEND_MAX_WAIT_MS).toBeGreaterThan(0);
    // 40ms interval ⇒ ≤ 25 sends/second, under Telegram's ~30/s bot ceiling.
    expect(1_000 / DEFAULT_GLOBAL_SEND_MIN_INTERVAL_MS).toBeLessThanOrEqual(30);
  });
});
