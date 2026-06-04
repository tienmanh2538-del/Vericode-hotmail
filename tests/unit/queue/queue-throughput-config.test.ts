import { describe, it, expect } from 'vitest';

import {
  loadEmailWorkerRateLimitEnv,
  loadQueueEnv,
  MAX_EMAIL_WORKER_CONCURRENCY,
  loadEnv,
  type EnvValues,
} from '@/lib/env';

// Build a fully-resolved EnvValues from a raw source map so each case is
// deterministic and never reads the ambient process.env.
function envFrom(source: Record<string, string | undefined>): EnvValues {
  return loadEnv(source).values;
}

describe('loadQueueEnv — TASK-068B email worker concurrency clamp', () => {
  it('defaults to the safe baseline (2) when unset', () => {
    expect(loadQueueEnv(envFrom({})).emailWorkerConcurrency).toBe(2);
  });

  it('honours a valid in-range override', () => {
    expect(
      loadQueueEnv(envFrom({ EMAIL_WORKER_CONCURRENCY: '6' }))
        .emailWorkerConcurrency,
    ).toBe(6);
  });

  it('clamps an excessive value down to the upper cap', () => {
    expect(
      loadQueueEnv(envFrom({ EMAIL_WORKER_CONCURRENCY: '999' }))
        .emailWorkerConcurrency,
    ).toBe(MAX_EMAIL_WORKER_CONCURRENCY);
  });

  it('allows exactly the cap', () => {
    expect(
      loadQueueEnv(
        envFrom({
          EMAIL_WORKER_CONCURRENCY: String(MAX_EMAIL_WORKER_CONCURRENCY),
        }),
      ).emailWorkerConcurrency,
    ).toBe(MAX_EMAIL_WORKER_CONCURRENCY);
  });

  it('falls back to the default for zero / negative / non-numeric input', () => {
    expect(
      loadQueueEnv(envFrom({ EMAIL_WORKER_CONCURRENCY: '0' }))
        .emailWorkerConcurrency,
    ).toBe(2);
    expect(
      loadQueueEnv(envFrom({ EMAIL_WORKER_CONCURRENCY: '-4' }))
        .emailWorkerConcurrency,
    ).toBe(2);
    expect(
      loadQueueEnv(envFrom({ EMAIL_WORKER_CONCURRENCY: 'lots' }))
        .emailWorkerConcurrency,
    ).toBe(2);
  });
});

describe('loadEmailWorkerRateLimitEnv — TASK-068B queue rate limiter', () => {
  it('uses conservative defaults when unset', () => {
    const { max, durationMs } = loadEmailWorkerRateLimitEnv(envFrom({}));
    expect(max).toBe(20);
    expect(durationMs).toBe(1_000);
  });

  it('honours valid overrides', () => {
    const { max, durationMs } = loadEmailWorkerRateLimitEnv(
      envFrom({
        EMAIL_WORKER_RATE_MAX: '5',
        EMAIL_WORKER_RATE_DURATION_MS: '2000',
      }),
    );
    expect(max).toBe(5);
    expect(durationMs).toBe(2_000);
  });

  it('clamps values below the safe minimum (rate stays bounded, never zero)', () => {
    const { max, durationMs } = loadEmailWorkerRateLimitEnv(
      envFrom({
        EMAIL_WORKER_RATE_MAX: '0',
        EMAIL_WORKER_RATE_DURATION_MS: '1',
      }),
    );
    // max < 1 → clamped to 1; duration < 100ms → clamped to 100ms.
    expect(max).toBe(1);
    expect(durationMs).toBe(100);
  });

  it('falls back to defaults for non-numeric input', () => {
    const { max, durationMs } = loadEmailWorkerRateLimitEnv(
      envFrom({
        EMAIL_WORKER_RATE_MAX: 'fast',
        EMAIL_WORKER_RATE_DURATION_MS: 'soon',
      }),
    );
    expect(max).toBe(20);
    expect(durationMs).toBe(1_000);
  });
});
