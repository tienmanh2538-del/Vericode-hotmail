// TASK-089 — Option B++ sync-state recovery (replace-on-success) tests.
//
// HTTP 410 (e.g. SyncStateNotFound) on a CURSOR request must:
//   - classify as its own sync-state-lost kind (by HTTP status alone);
//   - NEVER reset the persisted cursor to null (no resetDeltaCursor call);
//   - NEVER touch mailbox status / forbidden counters / cooldown / alert;
//   - run exactly ONE bounded recovery enumeration in the SAME cycle, with a
//     lookback derived from the shared relay-freshness policy (30 minutes);
//   - on success: saveDeltaCursor(C-new) replaces C-invalid directly;
//   - on failure (second 410 / timeout / 429 / 5xx / page cap): keep C-invalid
//     persisted, record a sanitized marker, settle; the next tick retries.
//
// Delivery-semantics wording (locked in Phase 1): claim-before-send prevents
// duplicate replay for the same claimed message identity, with pre-existing
// at-most-once-after-claim failure semantics — the queue jobId dedup, pipeline
// early dedup, TASK-080 stale guard and ProcessedMessage claim sit downstream
// of the enqueue calls asserted here (see pipeline/dedup test suites).

import { describe, it, expect, vi, afterEach } from 'vitest';

import {
  runDeltaPollingOnce,
  DELTA_POLLING_HTTP_TIMEOUT_MS,
  __internal,
  type DeltaPollingAccessTokenPort,
  type DeltaPollingAlertPort,
  type DeltaPollingDeps,
  type DeltaPollingEnqueuePort,
  type DeltaPollingMailbox,
  type DeltaPollingMailboxRepo,
} from '@/services/microsoft/delta-polling.service';
import {
  MAX_RELAY_MESSAGE_AGE_MINUTES,
  MAX_RELAY_MESSAGE_AGE_MS,
} from '@/services/email/relay-freshness-policy';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-30T10:00:00.000Z');
const C_INVALID = 'https://graph.microsoft.com/v1.0/cursor-INVALID-410';
const C_NEW = 'https://graph.microsoft.com/v1.0/cursor-RECOVERED-new';
const FAKE_TOKEN = 'fake-access-token-never-logged';

interface FakeRepoState {
  mailboxes: DeltaPollingMailbox[];
  savedCursors: Array<{ mailboxId: string; cursorUrl: string; polledAt: Date }>;
  recordedErrors: Array<{ mailboxId: string; message: string; occurredAt: Date }>;
  reconnectMarked: string[];
  cursorResets: string[];
  forbiddenBackoffs: Array<{ mailboxId: string; count: number }>;
  forbiddenClears: string[];
  saveImpl?: () => Promise<void>;
}

function createFakeRepo(initial: DeltaPollingMailbox[]): {
  repo: DeltaPollingMailboxRepo;
  state: FakeRepoState;
} {
  const state: FakeRepoState = {
    mailboxes: [...initial],
    savedCursors: [],
    recordedErrors: [],
    reconnectMarked: [],
    cursorResets: [],
    forbiddenBackoffs: [],
    forbiddenClears: [],
  };
  const repo: DeltaPollingMailboxRepo = {
    async listActiveMicrosoftMailboxes() {
      return state.mailboxes;
    },
    async saveDeltaCursor(mailboxId, cursorUrl, polledAt) {
      if (state.saveImpl) await state.saveImpl();
      state.savedCursors.push({ mailboxId, cursorUrl, polledAt });
    },
    async recordDeltaError(mailboxId, message, occurredAt) {
      state.recordedErrors.push({ mailboxId, message, occurredAt });
    },
    async resetDeltaCursor(mailboxId) {
      state.cursorResets.push(mailboxId);
    },
    async markReconnectRequired(mailboxId) {
      state.reconnectMarked.push(mailboxId);
    },
    async recordForbiddenBackoff(mailboxId, count) {
      state.forbiddenBackoffs.push({ mailboxId, count });
    },
    async clearForbiddenBackoff(mailboxId) {
      state.forbiddenClears.push(mailboxId);
    },
  };
  return { repo, state };
}

const accessToken: DeltaPollingAccessTokenPort = {
  async getAccessTokenForMailbox() {
    return FAKE_TOKEN;
  },
};

function createFakeEnqueue(): {
  port: DeltaPollingEnqueuePort;
  calls: Array<{ mailboxId: string; graphMessageId: string; queuedAt: string }>;
} {
  const calls: Array<{ mailboxId: string; graphMessageId: string; queuedAt: string }> = [];
  const port: DeltaPollingEnqueuePort = {
    async enqueueMessage(input) {
      calls.push({ ...input });
    },
  };
  return { port, calls };
}

function createFakeAlert(): {
  port: DeltaPollingAlertPort;
  calls: number;
} {
  const box = { calls: 0 };
  const port: DeltaPollingAlertPort = {
    async raisePersistentForbidden() {
      box.calls += 1;
    },
  };
  return {
    port,
    get calls() {
      return box.calls;
    },
  };
}

interface GraphResponseShape {
  value?: Array<Record<string, unknown>>;
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

function jsonResponse(payload: GraphResponseShape, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Graph-style error response carrying an error code in the JSON body. */
function graphErrorResponse(status: number, code?: string): Response {
  const body = code ? { error: { code } } : { error: {} };
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type ScriptedFetchEntry = Response | 'hang' | (() => Promise<Response>);

/**
 * Scripted fetch: shifts one entry per call. 'hang' returns a promise that
 * only rejects when the request's AbortSignal fires (TASK-080 timeout seam).
 */
function fetchStub(scripted: ScriptedFetchEntry[]): {
  fetch: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  const remaining = [...scripted];
  const fn = vi.fn((input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push(url);
    const next = remaining.shift();
    if (next === undefined) {
      return Promise.reject(new Error(`fetchStub: unexpected extra call to ${url}`));
    }
    if (next === 'hang') {
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      });
    }
    return typeof next === 'function' ? next() : Promise.resolve(next);
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function silentLogger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeMailbox(overrides: Partial<DeltaPollingMailbox> = {}): DeltaPollingMailbox {
  return {
    id: 'mbx-410',
    emailAddress: 'sync@example.test',
    microsoftDeltaCursor: C_INVALID,
    deltaForbiddenCount: 0,
    deltaForbiddenCooldownUntil: null,
    ...overrides,
  };
}

function buildDeps(
  repo: DeltaPollingMailboxRepo,
  fetchImpl: typeof fetch,
  enqueue: DeltaPollingEnqueuePort,
  extra: Partial<DeltaPollingDeps> = {},
): DeltaPollingDeps {
  return {
    repo,
    accessToken,
    enqueue,
    fetchImpl,
    logger: silentLogger() as unknown as DeltaPollingDeps['logger'],
    now: () => NOW,
    ...extra,
  };
}

/** The exact recovery enumeration URL the service must use (shared policy lookback). */
function expectedRecoveryUrl(): string {
  return __internal.buildInitialDeltaUrl(
    new Date(NOW.getTime() - __internal.SYNC_STATE_RECOVERY_LOOKBACK_MS),
  );
}

// ---------------------------------------------------------------------------
// Shared freshness policy (HD-3)
// ---------------------------------------------------------------------------

describe('relay freshness policy (shared leaf module)', () => {
  it('keeps the TASK-080 threshold at exactly 30 minutes', () => {
    expect(MAX_RELAY_MESSAGE_AGE_MINUTES).toBe(30);
    expect(MAX_RELAY_MESSAGE_AGE_MS).toBe(30 * 60 * 1000);
  });

  it('derives the recovery lookback from the shared policy (single source of truth)', () => {
    expect(__internal.SYNC_STATE_RECOVERY_LOOKBACK_MS).toBe(MAX_RELAY_MESSAGE_AGE_MS);
  });
});

// ---------------------------------------------------------------------------
// 410 classification + replace-on-success
// ---------------------------------------------------------------------------

describe('delta polling — 410 sync-state recovery (TASK-089, Option B++)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('valid cursor normal path is unchanged (no recovery involvement)', async () => {
    const { repo, state } = createFakeRepo([makeMailbox()]);
    const enqueue = createFakeEnqueue();
    const stub = fetchStub([
      jsonResponse({ value: [{ id: 'msg-1' }], '@odata.deltaLink': C_NEW }),
    ]);
    const result = await runDeltaPollingOnce(buildDeps(repo, stub.fetch, enqueue.port));

    expect(result.failedMailboxCount).toBe(0);
    expect(enqueue.calls.map((c) => c.graphMessageId)).toEqual(['msg-1']);
    expect(state.savedCursors).toEqual([
      { mailboxId: 'mbx-410', cursorUrl: C_NEW, polledAt: NOW },
    ]);
    expect(state.cursorResets).toEqual([]);
    expect(state.recordedErrors).toEqual([]);
  });

  it('410 → sync-state-lost marker recorded, then same-cycle recovery succeeds and C-new replaces C-invalid directly', async () => {
    const { repo, state } = createFakeRepo([makeMailbox()]);
    const enqueue = createFakeEnqueue();
    const stub = fetchStub([
      graphErrorResponse(410, 'SyncStateNotFound'),
      jsonResponse({ value: [{ id: 'fresh-msg-1' }], '@odata.deltaLink': C_NEW }),
    ]);
    const result = await runDeltaPollingOnce(buildDeps(repo, stub.fetch, enqueue.port));

    // Probe used the stored (invalid) cursor; recovery used the bounded
    // freshness-policy lookback URL — not the 24h bootstrap window.
    expect(stub.calls).toEqual([C_INVALID, expectedRecoveryUrl()]);

    // Marker was persisted at detection time (before the recovery ran).
    expect(state.recordedErrors).toHaveLength(1);
    expect(state.recordedErrors[0].message).toContain('GRAPH_SYNC_STATE_LOST');
    expect(state.recordedErrors[0].message).toContain('http=410');
    expect(state.recordedErrors[0].message).toContain('code=SyncStateNotFound');

    // Replace-on-success: direct overwrite, NEVER a reset-to-null.
    expect(state.savedCursors).toEqual([
      { mailboxId: 'mbx-410', cursorUrl: C_NEW, polledAt: NOW },
    ]);
    expect(state.cursorResets).toEqual([]);

    // Recovery candidates were enqueued through the existing flow.
    expect(enqueue.calls.map((c) => c.graphMessageId)).toEqual(['fresh-msg-1']);
    expect(result.enqueuedMessageCount).toBe(1);

    // Not a failed mailbox; no status / forbidden side effects.
    expect(result.failedMailboxCount).toBe(0);
    expect(state.reconnectMarked).toEqual([]);
    expect(state.forbiddenBackoffs).toEqual([]);
  });

  it('410 without a parseable Graph error code still recovers (HTTP status is the trigger)', async () => {
    const { repo, state } = createFakeRepo([makeMailbox()]);
    const enqueue = createFakeEnqueue();
    const stub = fetchStub([
      new Response('gone', { status: 410 }),
      jsonResponse({ value: [], '@odata.deltaLink': C_NEW }),
    ]);
    const result = await runDeltaPollingOnce(buildDeps(repo, stub.fetch, enqueue.port));

    expect(result.failedMailboxCount).toBe(0);
    expect(state.savedCursors.map((s) => s.cursorUrl)).toEqual([C_NEW]);
    expect(state.cursorResets).toEqual([]);
  });

  it('multi-page recovery success: all candidate pages enqueued, only the final deltaLink saved', async () => {
    const { repo, state } = createFakeRepo([makeMailbox()]);
    const enqueue = createFakeEnqueue();
    const nextLink = 'https://graph.microsoft.com/v1.0/recovery-page-2';
    const stub = fetchStub([
      graphErrorResponse(410, 'SyncStateNotFound'),
      jsonResponse({ value: [{ id: 'm-a' }], '@odata.nextLink': nextLink }),
      jsonResponse({ value: [{ id: 'm-b' }], '@odata.deltaLink': C_NEW }),
    ]);
    const result = await runDeltaPollingOnce(buildDeps(repo, stub.fetch, enqueue.port));

    expect(enqueue.calls.map((c) => c.graphMessageId)).toEqual(['m-a', 'm-b']);
    expect(state.savedCursors.map((s) => s.cursorUrl)).toEqual([C_NEW]);
    expect(result.failedMailboxCount).toBe(0);
  });

  it('successful recovery clears a prior forbidden streak like any successful poll', async () => {
    const { repo, state } = createFakeRepo([
      makeMailbox({ deltaForbiddenCount: 2, deltaForbiddenCooldownUntil: null }),
    ]);
    const enqueue = createFakeEnqueue();
    const stub = fetchStub([
      graphErrorResponse(410, 'SyncStateNotFound'),
      jsonResponse({ value: [], '@odata.deltaLink': C_NEW }),
    ]);
    await runDeltaPollingOnce(buildDeps(repo, stub.fetch, enqueue.port));

    expect(state.forbiddenClears).toEqual(['mbx-410']);
  });

  // -------------------------------------------------------------------------
  // Recovery failure paths — C-invalid must stay persisted, no reset ever
  // -------------------------------------------------------------------------

  it('recovery second 410: exactly one attempt, no recursion, no reset, C-invalid stays', async () => {
    const { repo, state } = createFakeRepo([makeMailbox()]);
    const enqueue = createFakeEnqueue();
    const stub = fetchStub([
      graphErrorResponse(410, 'SyncStateNotFound'),
      graphErrorResponse(410, 'SyncStateNotFound'),
    ]);
    const result = await runDeltaPollingOnce(buildDeps(repo, stub.fetch, enqueue.port));

    // Exactly two Graph calls: one probe + ONE recovery attempt. Nothing more.
    expect(stub.calls).toHaveLength(2);
    expect(result.failedMailboxCount).toBe(1);
    expect(state.savedCursors).toEqual([]);
    expect(state.cursorResets).toEqual([]);
    expect(state.reconnectMarked).toEqual([]);
    expect(state.forbiddenBackoffs).toEqual([]);
    const messages = state.recordedErrors.map((e) => e.message);
    expect(messages[0]).toContain('GRAPH_SYNC_STATE_LOST');
    expect(messages[1]).toContain('SYNC_STATE_RECOVERY_FAILED:');
    expect(messages[1]).toContain('http=410');
  });

  it('recovery 429 → transient failure, C-invalid stays, no reconnect/forbidden side effects', async () => {
    const { repo, state } = createFakeRepo([makeMailbox()]);
    const enqueue = createFakeEnqueue();
    const stub = fetchStub([
      graphErrorResponse(410, 'SyncStateNotFound'),
      graphErrorResponse(429),
    ]);
    const result = await runDeltaPollingOnce(buildDeps(repo, stub.fetch, enqueue.port));

    expect(result.failedMailboxCount).toBe(1);
    expect(state.savedCursors).toEqual([]);
    expect(state.cursorResets).toEqual([]);
    expect(state.reconnectMarked).toEqual([]);
    expect(state.forbiddenBackoffs).toEqual([]);
    expect(state.recordedErrors[1].message).toContain('SYNC_STATE_RECOVERY_FAILED:');
    expect(state.recordedErrors[1].message).toContain('http=429');
  });

  it('recovery 5xx → transient failure, C-invalid stays', async () => {
    const { repo, state } = createFakeRepo([makeMailbox()]);
    const enqueue = createFakeEnqueue();
    const stub = fetchStub([
      graphErrorResponse(410, 'SyncStateNotFound'),
      graphErrorResponse(503),
    ]);
    const result = await runDeltaPollingOnce(buildDeps(repo, stub.fetch, enqueue.port));

    expect(result.failedMailboxCount).toBe(1);
    expect(state.savedCursors).toEqual([]);
    expect(state.cursorResets).toEqual([]);
    expect(state.recordedErrors[1].message).toContain('http=503');
  });

  it('recovery timeout (TASK-080 seam preserved): aborts finitely, C-invalid stays, cycle settles', async () => {
    vi.useFakeTimers();
    const { repo, state } = createFakeRepo([makeMailbox()]);
    const enqueue = createFakeEnqueue();
    const stub = fetchStub([graphErrorResponse(410, 'SyncStateNotFound'), 'hang']);
    const runPromise = runDeltaPollingOnce(buildDeps(repo, stub.fetch, enqueue.port));
    await vi.advanceTimersByTimeAsync(DELTA_POLLING_HTTP_TIMEOUT_MS);
    const result = await runPromise;

    expect(result.checkedMailboxCount).toBe(1);
    expect(result.failedMailboxCount).toBe(1);
    expect(state.savedCursors).toEqual([]);
    expect(state.cursorResets).toEqual([]);
    expect(state.reconnectMarked).toEqual([]);
    expect(state.forbiddenBackoffs).toEqual([]);
    expect(state.recordedErrors[1].message).toContain('SYNC_STATE_RECOVERY_FAILED:GRAPH_TIMEOUT');
  });

  it('MANDATORY page-cap guard: cap reached without deltaLink → recovery FAIL, no fabricated cursor, C-invalid stays', async () => {
    const { repo, state } = createFakeRepo([makeMailbox()]);
    const enqueue = createFakeEnqueue();
    const nextA = 'https://graph.microsoft.com/v1.0/recovery-next-a';
    const nextB = 'https://graph.microsoft.com/v1.0/recovery-next-b';
    const stub = fetchStub([
      graphErrorResponse(410, 'SyncStateNotFound'),
      jsonResponse({ value: [{ id: 'p1' }], '@odata.nextLink': nextA }),
      jsonResponse({ value: [{ id: 'p2' }], '@odata.nextLink': nextB }),
    ]);
    const result = await runDeltaPollingOnce(
      buildDeps(repo, stub.fetch, enqueue.port, { maxPagesPerMailbox: 2 }),
    );

    // 1 probe + exactly maxPagesPerMailbox recovery pages — then stop.
    expect(stub.calls).toHaveLength(3);
    expect(result.failedMailboxCount).toBe(1);
    // Partial enumeration is NOT success: nothing saved, nothing reset.
    expect(state.savedCursors).toEqual([]);
    expect(state.cursorResets).toEqual([]);
    expect(
      state.recordedErrors.some((e) =>
        e.message.includes('SYNC_STATE_RECOVERY_INCOMPLETE:page_cap_before_deltaLink'),
      ),
    ).toBe(true);
    // Messages seen before the cap were still enqueued (at-least-once; the
    // pipeline's dedup layers make the next-tick replay safe).
    expect(enqueue.calls.map((c) => c.graphMessageId)).toEqual(['p1', 'p2']);
  });

  it('multi-page recovery partial failure: page-1 candidates enqueued, no intermediate cursor persisted', async () => {
    const { repo, state } = createFakeRepo([makeMailbox()]);
    const enqueue = createFakeEnqueue();
    const nextLink = 'https://graph.microsoft.com/v1.0/recovery-page-2';
    const stub = fetchStub([
      graphErrorResponse(410, 'SyncStateNotFound'),
      jsonResponse({ value: [{ id: 'm-a' }], '@odata.nextLink': nextLink }),
      graphErrorResponse(500),
    ]);
    const result = await runDeltaPollingOnce(buildDeps(repo, stub.fetch, enqueue.port));

    expect(enqueue.calls.map((c) => c.graphMessageId)).toEqual(['m-a']);
    expect(state.savedCursors).toEqual([]);
    expect(state.cursorResets).toEqual([]);
    expect(result.failedMailboxCount).toBe(1);
  });

  it('next tick after a failed recovery runs one probe + one NEW recovery attempt (durable trigger)', async () => {
    const { repo, state } = createFakeRepo([makeMailbox()]);
    const enqueue = createFakeEnqueue();

    // Tick 1: probe 410 → recovery 410 (fail). C-invalid stays.
    const stub1 = fetchStub([
      graphErrorResponse(410, 'SyncStateNotFound'),
      graphErrorResponse(410, 'SyncStateNotFound'),
    ]);
    await runDeltaPollingOnce(buildDeps(repo, stub1.fetch, enqueue.port));
    expect(state.savedCursors).toEqual([]);

    // Tick 2 (same persisted mailbox state): probe 410 → recovery SUCCEEDS.
    const stub2 = fetchStub([
      graphErrorResponse(410, 'SyncStateNotFound'),
      jsonResponse({ value: [{ id: 'late-fresh' }], '@odata.deltaLink': C_NEW }),
    ]);
    const result2 = await runDeltaPollingOnce(buildDeps(repo, stub2.fetch, enqueue.port));

    expect(stub2.calls).toEqual([C_INVALID, expectedRecoveryUrl()]);
    expect(state.savedCursors.map((s) => s.cursorUrl)).toEqual([C_NEW]);
    expect(state.cursorResets).toEqual([]);
    expect(result2.failedMailboxCount).toBe(0);
    expect(enqueue.calls.map((c) => c.graphMessageId)).toContain('late-fresh');
  });

  it('saveDeltaCursor failure after a converged recovery: C-invalid untouched, self-heals next tick', async () => {
    const { repo, state } = createFakeRepo([makeMailbox()]);
    state.saveImpl = async () => {
      throw new Error('db-write-failed');
    };
    const enqueue = createFakeEnqueue();
    const stub = fetchStub([
      graphErrorResponse(410, 'SyncStateNotFound'),
      jsonResponse({ value: [], '@odata.deltaLink': C_NEW }),
    ]);
    const result = await runDeltaPollingOnce(buildDeps(repo, stub.fetch, enqueue.port));

    expect(state.savedCursors).toEqual([]);
    expect(state.cursorResets).toEqual([]);
    expect(result.failedMailboxCount).toBe(1);
  });

  // -------------------------------------------------------------------------
  // 401 / 403 semantics preserved (also inside recovery)
  // -------------------------------------------------------------------------

  it('401 during recovery keeps existing auth semantics: RECONNECT_REQUIRED', async () => {
    const { repo, state } = createFakeRepo([makeMailbox()]);
    const enqueue = createFakeEnqueue();
    const stub = fetchStub([
      graphErrorResponse(410, 'SyncStateNotFound'),
      graphErrorResponse(401),
    ]);
    const result = await runDeltaPollingOnce(buildDeps(repo, stub.fetch, enqueue.port));

    expect(state.reconnectMarked).toEqual(['mbx-410']);
    expect(state.cursorResets).toEqual([]);
    expect(result.failedMailboxCount).toBe(1);
  });

  it('403 during recovery delegates verbatim to TASK-071/075: cursor reset + forbidden counter, never reconnect', async () => {
    const alert = createFakeAlert();
    const { repo, state } = createFakeRepo([makeMailbox()]);
    const enqueue = createFakeEnqueue();
    const stub = fetchStub([
      graphErrorResponse(410, 'SyncStateNotFound'),
      graphErrorResponse(403, 'ErrorAccessDenied'),
    ]);
    const result = await runDeltaPollingOnce(
      buildDeps(repo, stub.fetch, enqueue.port, { alert: alert.port }),
    );

    // TASK-071 self-heal owns the forbidden regime (stored cursor → reset).
    expect(state.cursorResets).toEqual(['mbx-410']);
    expect(state.forbiddenBackoffs).toEqual([{ mailboxId: 'mbx-410', count: 1 }]);
    expect(state.reconnectMarked).toEqual([]);
    expect(result.failedMailboxCount).toBe(1);
  });

  it('normal (non-recovery) 403 still resets the cursor exactly as TASK-071 (regression)', async () => {
    const { repo, state } = createFakeRepo([makeMailbox()]);
    const enqueue = createFakeEnqueue();
    const stub = fetchStub([graphErrorResponse(403, 'ErrorAccessDenied')]);
    await runDeltaPollingOnce(buildDeps(repo, stub.fetch, enqueue.port));

    expect(state.cursorResets).toEqual(['mbx-410']);
    expect(state.forbiddenBackoffs).toEqual([{ mailboxId: 'mbx-410', count: 1 }]);
    expect(state.reconnectMarked).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Bootstrap semantics preserved
  // -------------------------------------------------------------------------

  it('first-ever bootstrap (cursor null) still enumerates WITHOUT enqueueing (regression)', async () => {
    const { repo, state } = createFakeRepo([makeMailbox({ microsoftDeltaCursor: null })]);
    const enqueue = createFakeEnqueue();
    const stub = fetchStub([
      jsonResponse({ value: [{ id: 'old-1' }, { id: 'old-2' }], '@odata.deltaLink': C_NEW }),
    ]);
    const result = await runDeltaPollingOnce(buildDeps(repo, stub.fetch, enqueue.port));

    expect(enqueue.calls).toEqual([]);
    expect(result.bootstrappedMailboxCount).toBe(1);
    expect(state.savedCursors.map((s) => s.cursorUrl)).toEqual([C_NEW]);
  });

  it('410 while the cursor is already null (initial bootstrap) records the marker only — no recovery, no reset', async () => {
    const { repo, state } = createFakeRepo([makeMailbox({ microsoftDeltaCursor: null })]);
    const enqueue = createFakeEnqueue();
    const stub = fetchStub([graphErrorResponse(410, 'SyncStateNotFound')]);
    const result = await runDeltaPollingOnce(buildDeps(repo, stub.fetch, enqueue.port));

    // Exactly one Graph call — no recovery enumeration was attempted.
    expect(stub.calls).toHaveLength(1);
    expect(result.failedMailboxCount).toBe(1);
    expect(state.recordedErrors).toHaveLength(1);
    expect(state.recordedErrors[0].message).toContain('GRAPH_SYNC_STATE_LOST');
    expect(state.cursorResets).toEqual([]);
    expect(state.savedCursors).toEqual([]);
    expect(state.reconnectMarked).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Status / isolation / sanitization
  // -------------------------------------------------------------------------

  it('recovery of one mailbox does not disturb the other mailboxes in the same cycle', async () => {
    const other = makeMailbox({
      id: 'mbx-healthy',
      emailAddress: 'ok@example.test',
      microsoftDeltaCursor: 'https://graph.microsoft.com/v1.0/cursor-healthy',
    });
    const { repo, state } = createFakeRepo([makeMailbox(), other]);
    const enqueue = createFakeEnqueue();
    const stub = fetchStub([
      graphErrorResponse(410, 'SyncStateNotFound'),
      graphErrorResponse(410, 'SyncStateNotFound'),
      jsonResponse({ value: [{ id: 'healthy-msg' }], '@odata.deltaLink': 'https://graph.microsoft.com/v1.0/cursor-healthy-next' }),
    ]);
    const result = await runDeltaPollingOnce(buildDeps(repo, stub.fetch, enqueue.port));

    expect(result.checkedMailboxCount).toBe(2);
    expect(result.failedMailboxCount).toBe(1);
    expect(state.savedCursors.map((s) => s.mailboxId)).toEqual(['mbx-healthy']);
    expect(enqueue.calls.map((c) => c.graphMessageId)).toEqual(['healthy-msg']);
  });

  it('410/recovery paths never write mailbox status (no resurrect surface): only 401 marks reconnect', async () => {
    // Covers success, second-410 failure and page-cap failure in one sweep:
    // none of them may touch markReconnectRequired.
    const cases: ScriptedFetchEntry[][] = [
      [graphErrorResponse(410, 'SyncStateNotFound'), jsonResponse({ value: [], '@odata.deltaLink': C_NEW })],
      [graphErrorResponse(410, 'SyncStateNotFound'), graphErrorResponse(410, 'SyncStateNotFound')],
      [graphErrorResponse(410, 'SyncStateNotFound'), graphErrorResponse(429)],
    ];
    for (const scripted of cases) {
      const { repo, state } = createFakeRepo([makeMailbox()]);
      const enqueue = createFakeEnqueue();
      const stub = fetchStub(scripted);
      await runDeltaPollingOnce(buildDeps(repo, stub.fetch, enqueue.port));
      expect(state.reconnectMarked).toEqual([]);
    }
  });

  it('sanitization: persisted markers and logs never contain the cursor URLs or the access token', async () => {
    const logger = silentLogger();
    const { repo, state } = createFakeRepo([makeMailbox()]);
    const enqueue = createFakeEnqueue();
    const stub = fetchStub([
      graphErrorResponse(410, 'SyncStateNotFound'),
      graphErrorResponse(410, 'SyncStateNotFound'),
    ]);
    await runDeltaPollingOnce(
      buildDeps(repo, stub.fetch, enqueue.port, {
        logger: logger as unknown as DeltaPollingDeps['logger'],
      }),
    );

    const persisted = JSON.stringify(state.recordedErrors);
    expect(persisted).not.toContain(C_INVALID);
    expect(persisted).not.toContain(FAKE_TOKEN);
    expect(persisted).not.toContain('Location');

    const logged = JSON.stringify([
      ...logger.info.mock.calls,
      ...logger.warn.mock.calls,
      ...logger.error.mock.calls,
    ]);
    expect(logged).not.toContain(C_INVALID);
    expect(logged).not.toContain(FAKE_TOKEN);
  });
});
