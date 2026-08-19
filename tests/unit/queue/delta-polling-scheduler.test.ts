import { describe, it, expect, vi, afterEach } from 'vitest';

import { startDeltaPollingScheduler } from '@/services/queue/workers/delta-polling-runner';
import type {
  DeltaPollingDeps,
  DeltaPollingMailboxRepo,
} from '@/services/microsoft/delta-polling.service';

// TASK-080 — the scheduler's non-overlap guard must (a) skip a tick while the
// previous cycle is still in flight, and (b) release once that cycle SETTLES so
// the next tick runs. Combined with the per-request timeouts (which guarantee a
// cycle always settles), this rules out the permanent "previous tick still
// running" wedge that TASK-079 confirmed.

const silentLogger = {
  info() {},
  warn() {},
  error() {},
  debug() {},
} as unknown as DeltaPollingDeps['logger'];

const noopEnqueue: DeltaPollingDeps['enqueue'] = {
  async enqueueMessage() {},
};

const noopAccessToken: DeltaPollingDeps['accessToken'] = {
  async getAccessTokenForMailbox() {
    return 'fake-access-token-do-not-leak';
  },
};

function buildControllableRepo(): {
  repo: DeltaPollingMailboxRepo;
  listCallCount: () => number;
  releaseCurrentCycle: () => void;
} {
  let listCallCount = 0;
  let gate: Promise<void> = Promise.resolve();
  let release: () => void = () => {};

  const repo: DeltaPollingMailboxRepo = {
    async listActiveMicrosoftMailboxes() {
      listCallCount += 1;
      // The FIRST cycle blocks on a manual gate so we can hold it "in flight";
      // later cycles resolve immediately.
      const current = gate;
      await current;
      return [];
    },
    async saveDeltaCursor() {},
    async recordDeltaError() {},
    async resetDeltaCursor() {},
    async markReconnectRequired() {},
    async recordForbiddenBackoff() {},
    async clearForbiddenBackoff() {},
  };

  // Arm the gate so the first cycle blocks until released.
  gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  return {
    repo,
    listCallCount: () => listCallCount,
    releaseCurrentCycle: () => {
      release();
      gate = Promise.resolve();
    },
  };
}

describe('startDeltaPollingScheduler — non-overlap + release (TASK-080)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('skips a tick while a cycle is in flight, then runs again after it settles', async () => {
    vi.useFakeTimers();
    const { repo, listCallCount, releaseCurrentCycle } = buildControllableRepo();

    const deps: DeltaPollingDeps = {
      repo,
      accessToken: noopAccessToken,
      enqueue: noopEnqueue,
      logger: silentLogger,
    };

    const handle = startDeltaPollingScheduler({
      intervalMs: 1_000,
      deps,
      logger: silentLogger,
    });

    // The immediate first tick started cycle #1 (now blocked on the gate).
    await Promise.resolve();
    await Promise.resolve();
    expect(listCallCount()).toBe(1);

    // A second interval tick fires while cycle #1 is still in flight → SKIPPED,
    // no second cycle is started.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listCallCount()).toBe(1);

    // Release cycle #1 → the inflight guard clears.
    releaseCurrentCycle();
    await Promise.resolve();
    await Promise.resolve();

    // The next tick now runs a fresh cycle #2.
    await vi.advanceTimersByTimeAsync(1_000);
    expect(listCallCount()).toBe(2);

    await handle.stop();
  });
});
