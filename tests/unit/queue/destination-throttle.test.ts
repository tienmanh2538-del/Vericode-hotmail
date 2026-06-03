import { describe, it, expect } from 'vitest';

import {
  buildDestinationKey,
  createInMemoryDestinationThrottle,
} from '@/services/queue/destination-throttle';

// Synthetic chat ids/topics only — no real Telegram chat id or bot token.
const CHAT = '-1009999999999';
const OTHER_CHAT = '-1008888888888';

describe('buildDestinationKey', () => {
  it('separates a forum topic from the plain group on the same chat', () => {
    expect(buildDestinationKey(CHAT, '42')).not.toBe(buildDestinationKey(CHAT));
  });

  it('is stable for the same chat + topic (shared destination → same key)', () => {
    expect(buildDestinationKey(CHAT, '42')).toBe(buildDestinationKey(CHAT, '42'));
  });

  it('treats empty/blank thread id as no topic', () => {
    expect(buildDestinationKey(CHAT, '')).toBe(buildDestinationKey(CHAT));
    expect(buildDestinationKey(CHAT, '   ')).toBe(buildDestinationKey(CHAT));
    expect(buildDestinationKey(CHAT, null)).toBe(buildDestinationKey(CHAT));
  });
});

describe('createInMemoryDestinationThrottle', () => {
  it('allows the first send immediately and spaces the next sends', () => {
    const nowMs = 1_000;
    const throttle = createInMemoryDestinationThrottle({
      minIntervalMs: 1_000,
      now: () => nowMs,
    });
    const key = buildDestinationKey(CHAT);

    // First send: no wait.
    expect(throttle.reserve(key).waitMs).toBe(0);
    // Second send at the same instant: must wait one interval.
    expect(throttle.reserve(key).waitMs).toBe(1_000);
    // Third send at the same instant: two intervals.
    expect(throttle.reserve(key).waitMs).toBe(2_000);
  });

  it('keeps a burst to the SAME shared destination from going out too densely', () => {
    const nowMs = 0;
    const throttle = createInMemoryDestinationThrottle({
      minIntervalMs: 1_000,
      now: () => nowMs,
    });
    const key = buildDestinationKey(CHAT, '7');

    // Five different mailboxes routing to the same reusable destination/topic all
    // fire at the same instant. The guard spaces them ≥ minInterval apart.
    const waits = [0, 0, 0, 0, 0].map(() => throttle.reserve(key).waitMs);
    expect(waits).toEqual([0, 1_000, 2_000, 3_000, 4_000]);

    // Each consecutive scheduled send is at least minInterval after the prior.
    const scheduled = waits.map((w) => nowMs + w);
    for (let i = 1; i < scheduled.length; i += 1) {
      expect(scheduled[i] - scheduled[i - 1]).toBeGreaterThanOrEqual(1_000);
    }
  });

  it('throttles each shared destination independently (no cross-destination block)', () => {
    const nowMs = 0;
    const throttle = createInMemoryDestinationThrottle({
      minIntervalMs: 1_000,
      now: () => nowMs,
    });

    // Different destinations never wait on each other.
    expect(throttle.reserve(buildDestinationKey(CHAT)).waitMs).toBe(0);
    expect(throttle.reserve(buildDestinationKey(OTHER_CHAT)).waitMs).toBe(0);
  });

  it('caps a single send wait so a code is never delayed unboundedly', () => {
    const nowMs = 0;
    const throttle = createInMemoryDestinationThrottle({
      minIntervalMs: 10_000,
      maxWaitMs: 5_000,
      now: () => nowMs,
    });
    const key = buildDestinationKey(CHAT);

    throttle.reserve(key); // schedules far ahead
    // The next reservation would naturally wait 10s, but is capped at 5s.
    expect(throttle.reserve(key).waitMs).toBe(5_000);
  });

  it('lets the interval pass without piling up wait once traffic spaces out', () => {
    let nowMs = 0;
    const throttle = createInMemoryDestinationThrottle({
      minIntervalMs: 1_000,
      now: () => nowMs,
    });
    const key = buildDestinationKey(CHAT);

    expect(throttle.reserve(key).waitMs).toBe(0);
    // Caller already waited the interval before the next code arrives.
    nowMs += 1_000;
    expect(throttle.reserve(key).waitMs).toBe(0);
  });
});
