import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  runDeltaPollingOnce,
  DELTA_POLLING_HTTP_TIMEOUT_MS,
  type DeltaPollingAccessTokenPort,
  type DeltaPollingDeps,
  type DeltaPollingEnqueuePort,
  type DeltaPollingMailbox,
  type DeltaPollingMailboxRepo,
} from '@/services/microsoft/delta-polling.service';

// TASK-080 — a hung Microsoft Graph delta request must time out (finite) and be
// classified as a controlled TRANSIENT failure: never a 403, never a persistent
// -403 backoff, never a reconnect. The whole cycle must SETTLE (not hang).

interface RepoState {
  recordedErrors: Array<{ mailboxId: string; message: string }>;
  reconnectMarked: string[];
  forbiddenBackoffs: string[];
  savedCursors: string[];
}

function createFakeRepo(mailboxes: DeltaPollingMailbox[]): {
  repo: DeltaPollingMailboxRepo;
  state: RepoState;
} {
  const state: RepoState = {
    recordedErrors: [],
    reconnectMarked: [],
    forbiddenBackoffs: [],
    savedCursors: [],
  };
  const repo: DeltaPollingMailboxRepo = {
    async listActiveMicrosoftMailboxes() {
      return mailboxes;
    },
    async saveDeltaCursor(mailboxId) {
      state.savedCursors.push(mailboxId);
    },
    async recordDeltaError(mailboxId, message) {
      state.recordedErrors.push({ mailboxId, message });
    },
    async resetDeltaCursor() {},
    async markReconnectRequired(mailboxId) {
      state.reconnectMarked.push(mailboxId);
    },
    async recordForbiddenBackoff(mailboxId) {
      state.forbiddenBackoffs.push(mailboxId);
    },
    async clearForbiddenBackoff() {},
  };
  return { repo, state };
}

const accessToken: DeltaPollingAccessTokenPort = {
  async getAccessTokenForMailbox() {
    return 'fake-access-token-do-not-leak';
  },
};

function createEnqueue(): {
  port: DeltaPollingEnqueuePort;
  calls: number;
} {
  const box = { calls: 0 };
  const port: DeltaPollingEnqueuePort = {
    async enqueueMessage() {
      box.calls += 1;
    },
  };
  return { port, get calls() { return box.calls; } };
}

// A fetch that never resolves on its own but rejects when its AbortSignal fires.
function hangingSignalAwareFetch(): typeof fetch {
  return vi.fn((_url: unknown, init?: RequestInit) => {
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        reject(new DOMException('The operation was aborted.', 'AbortError'));
      });
    });
  }) as unknown as typeof fetch;
}

function buildDeps(
  repo: DeltaPollingMailboxRepo,
  fetchImpl: typeof fetch,
  enqueue: DeltaPollingEnqueuePort,
): DeltaPollingDeps {
  return {
    repo,
    accessToken,
    enqueue,
    fetchImpl,
    // Silence the service's info/warn logging noise in this focused test.
    logger: { info() {}, warn() {}, error() {}, debug() {} } as unknown as DeltaPollingDeps['logger'],
  };
}

describe('delta polling — hung Graph request timeout (TASK-080)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('times out a hanging delta request and classifies it as transient (not 403 / not reconnect)', async () => {
    vi.useFakeTimers();
    const mailbox: DeltaPollingMailbox = {
      id: 'mbx-hang-1',
      emailAddress: 'agent@example.test',
      microsoftDeltaCursor: 'https://graph.microsoft.com/v1.0/cursor-abc',
      deltaForbiddenCount: 0,
      deltaForbiddenCooldownUntil: null,
    };
    const { repo, state } = createFakeRepo([mailbox]);
    const enqueue = createEnqueue();
    const deps = buildDeps(repo, hangingSignalAwareFetch(), enqueue.port);

    const runPromise = runDeltaPollingOnce(deps);
    // Drive the finite timeout. Without the fix this promise would never settle.
    await vi.advanceTimersByTimeAsync(DELTA_POLLING_HTTP_TIMEOUT_MS);
    const result = await runPromise;

    // The cycle settled.
    expect(result.checkedMailboxCount).toBe(1);
    expect(result.failedMailboxCount).toBe(1);

    // Recorded as a transient timeout error, NOT a reconnect / forbidden backoff.
    expect(state.recordedErrors).toHaveLength(1);
    expect(state.recordedErrors[0].message).toContain('GRAPH_TIMEOUT');
    expect(state.reconnectMarked).toEqual([]);
    expect(state.forbiddenBackoffs).toEqual([]);
    expect(enqueue.calls).toBe(0);
  });

  it('a normal (fast) delta response still completes and advances the cursor', async () => {
    const mailbox: DeltaPollingMailbox = {
      id: 'mbx-ok-1',
      emailAddress: 'agent2@example.test',
      microsoftDeltaCursor: 'https://graph.microsoft.com/v1.0/cursor-def',
      deltaForbiddenCount: 0,
      deltaForbiddenCooldownUntil: null,
    };
    const { repo, state } = createFakeRepo([mailbox]);
    const enqueue = createEnqueue();
    const fastFetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          value: [],
          '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/cursor-next',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;
    const deps = buildDeps(repo, fastFetch, enqueue.port);

    const result = await runDeltaPollingOnce(deps);

    expect(result.failedMailboxCount).toBe(0);
    expect(state.recordedErrors).toEqual([]);
    expect(state.savedCursors).toEqual(['mbx-ok-1']);
  });
});
