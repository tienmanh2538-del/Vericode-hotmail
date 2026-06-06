import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  runDeltaPollingOnce,
  __internal,
  type DeltaPollingAccessTokenPort,
  type DeltaPollingDeps,
  type DeltaPollingEnqueuePort,
  type DeltaPollingMailbox,
  type DeltaPollingMailboxRepo,
} from '@/services/microsoft/delta-polling.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface FakeRepoState {
  mailboxes: DeltaPollingMailbox[];
  savedCursors: Array<{ mailboxId: string; cursorUrl: string; polledAt: Date }>;
  recordedErrors: Array<{
    mailboxId: string;
    message: string;
    occurredAt: Date;
  }>;
  reconnectMarked: string[];
  cursorResets: string[];
  listImpl?: () => Promise<DeltaPollingMailbox[]>;
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
  };
  const repo: DeltaPollingMailboxRepo = {
    async listActiveMicrosoftMailboxes() {
      if (state.listImpl) return state.listImpl();
      return state.mailboxes;
    },
    async saveDeltaCursor(mailboxId, cursorUrl, polledAt) {
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
  };
  return { repo, state };
}

function createFakeAccessToken(
  tokenByMailboxId: Record<string, string | (() => Promise<string>)>,
): DeltaPollingAccessTokenPort {
  return {
    async getAccessTokenForMailbox(mailbox) {
      const entry = tokenByMailboxId[mailbox.id];
      if (entry === undefined) {
        throw new Error(`no token configured for mailbox ${mailbox.id}`);
      }
      if (typeof entry === 'function') return entry();
      return entry;
    },
  };
}

function createFakeEnqueue(): {
  port: DeltaPollingEnqueuePort;
  calls: Array<{ mailboxId: string; graphMessageId: string; queuedAt: string }>;
} {
  const calls: Array<{
    mailboxId: string;
    graphMessageId: string;
    queuedAt: string;
  }> = [];
  const port: DeltaPollingEnqueuePort = {
    async enqueueMessage(input) {
      calls.push({ ...input });
    },
  };
  return { port, calls };
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

function errorResponse(status: number): Response {
  return new Response('error', { status });
}

/**
 * Build a fetch stub that returns a queue of responses keyed by sequence of
 * call. Each call shifts the next response off the list; throws if calls
 * outlive the queue.
 */
function fetchStub(
  scripted: Array<Response | (() => Promise<Response>)>,
): {
  fetch: typeof fetch;
  calls: Array<{ url: string; init?: RequestInit }>;
} {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const remaining = [...scripted];
  const fn = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : String(input);
    calls.push({ url, init });
    const next = remaining.shift();
    if (next === undefined) {
      throw new Error(`fetchStub: unexpected extra call to ${url}`);
    }
    return typeof next === 'function' ? await next() : next;
  });
  return { fetch: fn as unknown as typeof fetch, calls };
}

function fixedNow(iso: string): () => Date {
  return () => new Date(iso);
}

function silentLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

function buildDeps(overrides: Partial<DeltaPollingDeps>): DeltaPollingDeps {
  if (!overrides.repo) throw new Error('repo is required');
  if (!overrides.accessToken) throw new Error('accessToken is required');
  if (!overrides.enqueue) throw new Error('enqueue is required');
  return {
    repo: overrides.repo,
    accessToken: overrides.accessToken,
    enqueue: overrides.enqueue,
    fetchImpl: overrides.fetchImpl,
    logger: overrides.logger ?? silentLogger(),
    now: overrides.now ?? fixedNow('2026-05-29T12:00:00.000Z'),
    maxPagesPerMailbox: overrides.maxPagesPerMailbox,
    bootstrapLookbackHours: overrides.bootstrapLookbackHours,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('runDeltaPollingOnce — bootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not enqueue any historical messages on first run and saves the deltaLink as cursor', async () => {
    const mailbox: DeltaPollingMailbox = {
      id: 'mb_bootstrap',
      emailAddress: 'alpha@example.com',
      microsoftDeltaCursor: null,
    };
    const { repo, state } = createFakeRepo([mailbox]);
    const accessToken = createFakeAccessToken({ mb_bootstrap: 'token-A' });
    const { port: enqueue, calls: enqueueCalls } = createFakeEnqueue();
    const deltaLink =
      'https://graph.microsoft.com/v1.0/me/mailFolders(%27inbox%27)/messages/delta?$deltatoken=abc';
    const { fetch: stub, calls: fetchCalls } = fetchStub([
      jsonResponse({
        // Bootstrap response carries existing messages — must NOT be enqueued.
        value: [{ id: 'old-1' }, { id: 'old-2' }],
        '@odata.deltaLink': deltaLink,
      }),
    ]);

    const result = await runDeltaPollingOnce(
      buildDeps({ repo, accessToken, enqueue, fetchImpl: stub }),
    );

    expect(enqueueCalls).toEqual([]);
    expect(state.savedCursors).toHaveLength(1);
    expect(state.savedCursors[0]).toMatchObject({
      mailboxId: 'mb_bootstrap',
      cursorUrl: deltaLink,
    });
    expect(state.recordedErrors).toEqual([]);
    expect(result.bootstrappedMailboxCount).toBe(1);
    expect(result.enqueuedMessageCount).toBe(0);
    expect(result.failedMailboxCount).toBe(0);

    // First call must hit the initial delta URL with $select=id and a
    // Bearer token in the header — no plaintext token in URL. TASK-036: the
    // bootstrap URL is time-bounded (now - default 24h lookback).
    expect(fetchCalls).toHaveLength(1);
    const expectedFromDate = new Date('2026-05-28T12:00:00.000Z');
    expect(fetchCalls[0].url).toBe(
      __internal.buildInitialDeltaUrl(expectedFromDate),
    );
    const headers = (fetchCalls[0].init?.headers ?? {}) as Record<string, string>;
    expect(headers.authorization).toBe('Bearer token-A');
  });

  it('TASK-036: bounds the first bootstrap scan with a receivedDateTime filter', async () => {
    const mailbox: DeltaPollingMailbox = {
      id: 'mb_big',
      emailAddress: 'huge@example.com',
      microsoftDeltaCursor: null,
    };
    const { repo, state } = createFakeRepo([mailbox]);
    const accessToken = createFakeAccessToken({ mb_big: 'token-big' });
    const { port: enqueue, calls: enqueueCalls } = createFakeEnqueue();
    const deltaLink = 'https://graph.example.com/delta-after-bootstrap';
    const { fetch: stub, calls: fetchCalls } = fetchStub([
      jsonResponse({
        value: [{ id: 'recent-1' }],
        '@odata.deltaLink': deltaLink,
      }),
    ]);

    await runDeltaPollingOnce(
      buildDeps({
        repo,
        accessToken,
        enqueue,
        fetchImpl: stub,
        // 6h lookback → from 2026-05-29T06:00:00Z.
        bootstrapLookbackHours: 6,
        now: fixedNow('2026-05-29T12:00:00.000Z'),
      }),
    );

    // The bootstrap URL must carry a receivedDateTime ge filter so a very large
    // mailbox is not scanned from the beginning of time. (URLSearchParams encodes
    // the spaces as '+', so compare against the canonical builder output.)
    const firstUrl = fetchCalls[0].url;
    expect(firstUrl).toContain('messages/delta');
    expect(firstUrl).toBe(
      __internal.buildInitialDeltaUrl(new Date('2026-05-29T06:00:00.000Z')),
    );
    expect(decodeURIComponent(firstUrl)).toContain(
      'receivedDateTime+ge+2026-05-29T06:00:00.000Z',
    );
    // Still does not enqueue historical messages, and converges to a cursor.
    expect(enqueueCalls).toEqual([]);
    expect(state.savedCursors[0].cursorUrl).toBe(deltaLink);
  });

  it('TASK-036: an unbounded mailbox stops at the page cap and never fetches forever', async () => {
    const mailbox: DeltaPollingMailbox = {
      id: 'mb_no_converge',
      emailAddress: 'forever@example.com',
      microsoftDeltaCursor: null,
    };
    const { repo, state } = createFakeRepo([mailbox]);
    const accessToken = createFakeAccessToken({ mb_no_converge: 'token-x' });
    const { port: enqueue } = createFakeEnqueue();
    // Bootstrap pages that never reach a deltaLink.
    const looping = async (): Promise<Response> =>
      jsonResponse({
        value: [{ id: 'old' }],
        '@odata.nextLink': 'https://graph.example.com/next',
      });
    const { fetch: stub, calls: fetchCalls } = fetchStub(
      Array.from({ length: 20 }, () => looping),
    );

    await runDeltaPollingOnce(
      buildDeps({ repo, accessToken, enqueue, fetchImpl: stub, maxPagesPerMailbox: 4 }),
    );

    // Hard bound: never exceeds the page cap, even with no deltaLink in sight.
    expect(fetchCalls.length).toBe(4);
    // No cursor saved on a non-converging bootstrap (no deltaLink reached).
    expect(state.savedCursors).toEqual([]);
  });
});

describe('runDeltaPollingOnce — subsequent polls', () => {
  it('enqueues every new message id returned from the saved cursor URL', async () => {
    const savedCursor =
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=old';
    const mailbox: DeltaPollingMailbox = {
      id: 'mb_active',
      emailAddress: 'beta@example.com',
      microsoftDeltaCursor: savedCursor,
    };
    const { repo, state } = createFakeRepo([mailbox]);
    const accessToken = createFakeAccessToken({ mb_active: 'token-B' });
    const { port: enqueue, calls: enqueueCalls } = createFakeEnqueue();
    const nextDeltaLink =
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=new';
    const { fetch: stub, calls: fetchCalls } = fetchStub([
      jsonResponse({
        value: [{ id: 'new-1' }, { id: 'new-2' }],
        '@odata.deltaLink': nextDeltaLink,
      }),
    ]);

    const result = await runDeltaPollingOnce(
      buildDeps({
        repo,
        accessToken,
        enqueue,
        fetchImpl: stub,
        now: fixedNow('2026-05-29T13:00:00.000Z'),
      }),
    );

    // Polls the saved cursor URL, not a freshly built initial URL.
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe(savedCursor);

    expect(enqueueCalls).toEqual([
      {
        mailboxId: 'mb_active',
        graphMessageId: 'new-1',
        queuedAt: '2026-05-29T13:00:00.000Z',
      },
      {
        mailboxId: 'mb_active',
        graphMessageId: 'new-2',
        queuedAt: '2026-05-29T13:00:00.000Z',
      },
    ]);
    expect(state.savedCursors).toHaveLength(1);
    expect(state.savedCursors[0].cursorUrl).toBe(nextDeltaLink);
    expect(result.enqueuedMessageCount).toBe(2);
    expect(result.bootstrappedMailboxCount).toBe(0);
    expect(result.failedMailboxCount).toBe(0);
  });

  it('follows @odata.nextLink across pages and saves the FINAL @odata.deltaLink', async () => {
    const savedCursor = 'https://graph.example.com/page-0';
    const mailbox: DeltaPollingMailbox = {
      id: 'mb_pages',
      emailAddress: 'gamma@example.com',
      microsoftDeltaCursor: savedCursor,
    };
    const { repo, state } = createFakeRepo([mailbox]);
    const accessToken = createFakeAccessToken({ mb_pages: 'token-C' });
    const { port: enqueue, calls: enqueueCalls } = createFakeEnqueue();
    const intermediateNextLink = 'https://graph.example.com/page-1';
    const finalDeltaLink = 'https://graph.example.com/delta-final';

    const { fetch: stub, calls: fetchCalls } = fetchStub([
      jsonResponse({
        value: [{ id: 'p1-m1' }, { id: 'p1-m2' }],
        '@odata.nextLink': intermediateNextLink,
      }),
      jsonResponse({
        value: [{ id: 'p2-m1' }],
        '@odata.deltaLink': finalDeltaLink,
      }),
    ]);

    const result = await runDeltaPollingOnce(
      buildDeps({ repo, accessToken, enqueue, fetchImpl: stub }),
    );

    expect(fetchCalls.map((c) => c.url)).toEqual([
      savedCursor,
      intermediateNextLink,
    ]);
    expect(enqueueCalls.map((c) => c.graphMessageId)).toEqual([
      'p1-m1',
      'p1-m2',
      'p2-m1',
    ]);
    expect(state.savedCursors).toHaveLength(1);
    expect(state.savedCursors[0].cursorUrl).toBe(finalDeltaLink);
    expect(result.enqueuedMessageCount).toBe(3);
  });

  it('skips @removed items and items without an id', async () => {
    const savedCursor = 'https://graph.example.com/cursor';
    const mailbox: DeltaPollingMailbox = {
      id: 'mb_filter',
      emailAddress: 'delta@example.com',
      microsoftDeltaCursor: savedCursor,
    };
    const { repo } = createFakeRepo([mailbox]);
    const accessToken = createFakeAccessToken({ mb_filter: 'token-D' });
    const { port: enqueue, calls: enqueueCalls } = createFakeEnqueue();
    const { fetch: stub } = fetchStub([
      jsonResponse({
        value: [
          { id: 'good-1' },
          { id: 'removed-1', '@removed': { reason: 'deleted' } },
          { id: '' },
          {},
          { id: '   ' },
          { id: 'good-2' },
        ],
        '@odata.deltaLink': 'https://graph.example.com/delta',
      }),
    ]);

    await runDeltaPollingOnce(
      buildDeps({ repo, accessToken, enqueue, fetchImpl: stub }),
    );

    expect(enqueueCalls.map((c) => c.graphMessageId)).toEqual(['good-1', 'good-2']);
  });
});

describe('runDeltaPollingOnce — isolation & errors', () => {
  it('one mailbox failing does not stop other mailboxes from being polled', async () => {
    const mailboxes: DeltaPollingMailbox[] = [
      {
        id: 'mb_broken',
        emailAddress: 'epsilon@example.com',
        microsoftDeltaCursor: 'https://graph.example.com/cursor-broken',
      },
      {
        id: 'mb_healthy',
        emailAddress: 'zeta@example.com',
        microsoftDeltaCursor: 'https://graph.example.com/cursor-healthy',
      },
    ];
    const { repo, state } = createFakeRepo(mailboxes);
    const accessToken = createFakeAccessToken({
      mb_broken: 'token-broken',
      mb_healthy: 'token-healthy',
    });
    const { port: enqueue, calls: enqueueCalls } = createFakeEnqueue();
    const healthyDelta = 'https://graph.example.com/delta-healthy';
    const { fetch: stub } = fetchStub([
      // First mailbox call → Graph 500
      errorResponse(500),
      // Second mailbox call → success
      jsonResponse({
        value: [{ id: 'healthy-1' }],
        '@odata.deltaLink': healthyDelta,
      }),
    ]);

    const result = await runDeltaPollingOnce(
      buildDeps({ repo, accessToken, enqueue, fetchImpl: stub }),
    );

    expect(result.checkedMailboxCount).toBe(2);
    expect(result.failedMailboxCount).toBe(1);
    expect(enqueueCalls).toEqual([
      {
        mailboxId: 'mb_healthy',
        graphMessageId: 'healthy-1',
        queuedAt: '2026-05-29T12:00:00.000Z',
      },
    ]);
    expect(state.savedCursors).toEqual([
      {
        mailboxId: 'mb_healthy',
        cursorUrl: healthyDelta,
        polledAt: new Date('2026-05-29T12:00:00.000Z'),
      },
    ]);
    // The broken mailbox's cursor must NOT have been overwritten.
    expect(
      state.savedCursors.find((c) => c.mailboxId === 'mb_broken'),
    ).toBeUndefined();
    expect(
      state.recordedErrors.find((e) => e.mailboxId === 'mb_broken'),
    ).toBeDefined();
    // 500 is transient — should NOT trigger reconnect.
    expect(state.reconnectMarked).not.toContain('mb_broken');
  });

  it('marks mailbox RECONNECT_REQUIRED when Graph returns 401', async () => {
    const mailbox: DeltaPollingMailbox = {
      id: 'mb_auth_fail',
      emailAddress: 'eta@example.com',
      microsoftDeltaCursor: 'https://graph.example.com/cursor',
    };
    const { repo, state } = createFakeRepo([mailbox]);
    const accessToken = createFakeAccessToken({ mb_auth_fail: 'token-stale' });
    const { port: enqueue, calls: enqueueCalls } = createFakeEnqueue();
    const { fetch: stub } = fetchStub([errorResponse(401)]);

    const result = await runDeltaPollingOnce(
      buildDeps({ repo, accessToken, enqueue, fetchImpl: stub }),
    );

    expect(result.failedMailboxCount).toBe(1);
    expect(enqueueCalls).toEqual([]);
    expect(state.savedCursors).toEqual([]);
    expect(state.reconnectMarked).toEqual(['mb_auth_fail']);
    expect(state.recordedErrors).toHaveLength(1);
    expect(state.recordedErrors[0].message).toMatch(/GRAPH_REQUEST_FAILED/);
  });

  it('TASK-071 — Graph 403 on a data request does NOT mark RECONNECT_REQUIRED', async () => {
    const mailbox: DeltaPollingMailbox = {
      id: 'mb_403',
      emailAddress: 'forbidden@example.com',
      microsoftDeltaCursor: 'https://graph.example.com/cursor',
    };
    const { repo, state } = createFakeRepo([mailbox]);
    const accessToken = createFakeAccessToken({ mb_403: 'token-healthy' });
    const { port: enqueue, calls: enqueueCalls } = createFakeEnqueue();
    const { fetch: stub } = fetchStub([errorResponse(403)]);

    const result = await runDeltaPollingOnce(
      buildDeps({ repo, accessToken, enqueue, fetchImpl: stub }),
    );

    // The grant is healthy — 403 must never flip the mailbox to reconnect.
    expect(state.reconnectMarked).toEqual([]);
    // Still counted as a failed cycle and recorded for visibility.
    expect(result.failedMailboxCount).toBe(1);
    expect(state.recordedErrors).toHaveLength(1);
    expect(state.recordedErrors[0].message).toMatch(/GRAPH_REQUEST_FAILED/);
    expect(enqueueCalls).toEqual([]);
  });

  it('TASK-071 — Graph 403 with a stored cursor resets the cursor (self-heal)', async () => {
    const mailbox: DeltaPollingMailbox = {
      id: 'mb_403_cursor',
      emailAddress: 'poison@example.com',
      microsoftDeltaCursor: 'https://graph.example.com/poisoned-cursor',
    };
    const { repo, state } = createFakeRepo([mailbox]);
    const accessToken = createFakeAccessToken({ mb_403_cursor: 'token-healthy' });
    const { port: enqueue } = createFakeEnqueue();
    const { fetch: stub } = fetchStub([errorResponse(403)]);

    await runDeltaPollingOnce(
      buildDeps({ repo, accessToken, enqueue, fetchImpl: stub }),
    );

    // The poisoned cursor is dropped so the next cycle bootstraps fresh; the
    // mailbox stays ACTIVE (no reconnect).
    expect(state.cursorResets).toEqual(['mb_403_cursor']);
    expect(state.reconnectMarked).toEqual([]);
  });

  it('TASK-071 — Graph 403 during bootstrap (no cursor) does not reset or reconnect', async () => {
    const mailbox: DeltaPollingMailbox = {
      id: 'mb_403_bootstrap',
      emailAddress: 'bootstrap403@example.com',
      microsoftDeltaCursor: null,
    };
    const { repo, state } = createFakeRepo([mailbox]);
    const accessToken = createFakeAccessToken({ mb_403_bootstrap: 'token-healthy' });
    const { port: enqueue } = createFakeEnqueue();
    const { fetch: stub } = fetchStub([errorResponse(403)]);

    const result = await runDeltaPollingOnce(
      buildDeps({ repo, accessToken, enqueue, fetchImpl: stub }),
    );

    // Nothing to reset (already bootstrapping) and no reconnect; just retry next.
    expect(state.cursorResets).toEqual([]);
    expect(state.reconnectMarked).toEqual([]);
    expect(result.failedMailboxCount).toBe(1);
    expect(state.recordedErrors).toHaveLength(1);
  });

  it('TASK-071 — records sanitized Graph diagnostics (code/inner/request-id, no message)', async () => {
    const mailbox: DeltaPollingMailbox = {
      id: 'mb_diag',
      emailAddress: 'diag@example.com',
      microsoftDeltaCursor: 'https://graph.example.com/cursor',
    };
    const { repo, state } = createFakeRepo([mailbox]);
    const accessToken = createFakeAccessToken({ mb_diag: 'token-healthy' });
    const { port: enqueue } = createFakeEnqueue();
    // Graph-shaped error body + request-id header. error.message is intentionally
    // sensitive-looking so we can assert it is NEVER copied into the record.
    const graph403 = new Response(
      JSON.stringify({
        error: {
          code: 'ErrorAccessDenied',
          message: 'Access is denied for diag@example.com mailbox UPN',
          innerError: { code: 'MailboxNotEnabledForRESTAPI' },
        },
      }),
      {
        status: 403,
        headers: {
          'content-type': 'application/json',
          'request-id': 'req-abc-123',
        },
      },
    );
    const { fetch: stub } = fetchStub([graph403]);

    await runDeltaPollingOnce(
      buildDeps({ repo, accessToken, enqueue, fetchImpl: stub }),
    );

    expect(state.recordedErrors).toHaveLength(1);
    const message = state.recordedErrors[0].message;
    expect(message).toContain('code=ErrorAccessDenied');
    expect(message).toContain('inner=MailboxNotEnabledForRESTAPI');
    expect(message).toContain('reqId=req-abc-123');
    // The human-readable Graph message (which can echo the UPN/address) must
    // never be copied into the stored error.
    expect(message).not.toContain('Access is denied');
    expect(message).not.toContain('UPN');
  });

  it('marks mailbox RECONNECT_REQUIRED when the token error is reconnect_required', async () => {
    const mailbox: DeltaPollingMailbox = {
      id: 'mb_no_token',
      emailAddress: 'theta@example.com',
      microsoftDeltaCursor: null,
    };
    const { repo, state } = createFakeRepo([mailbox]);
    const accessToken: DeltaPollingAccessTokenPort = {
      async getAccessTokenForMailbox() {
        // TASK-069C — a revoked grant carries classification 'reconnect_required'.
        throw Object.assign(new Error('grant revoked'), {
          classification: 'reconnect_required' as const,
        });
      },
    };
    const { port: enqueue, calls: enqueueCalls } = createFakeEnqueue();
    const { fetch: stub, calls: fetchCalls } = fetchStub([]);

    const result = await runDeltaPollingOnce(
      buildDeps({ repo, accessToken, enqueue, fetchImpl: stub }),
    );

    // Graph must NEVER be called once the token port has failed.
    expect(fetchCalls).toHaveLength(0);
    expect(enqueueCalls).toEqual([]);
    expect(state.reconnectMarked).toEqual(['mb_no_token']);
    expect(state.savedCursors).toEqual([]);
    expect(result.failedMailboxCount).toBe(1);
  });

  it('TASK-069C — does NOT mark RECONNECT_REQUIRED on a transient token error', async () => {
    const mailbox: DeltaPollingMailbox = {
      id: 'mb_transient',
      emailAddress: 'kappa@example.com',
      microsoftDeltaCursor: null,
    };
    const { repo, state } = createFakeRepo([mailbox]);
    const accessToken: DeltaPollingAccessTokenPort = {
      async getAccessTokenForMailbox() {
        // network/429/5xx → transient classification; the next cycle retries.
        throw Object.assign(new Error('network blip'), {
          classification: 'transient' as const,
        });
      },
    };
    const { port: enqueue, calls: enqueueCalls } = createFakeEnqueue();
    const { fetch: stub, calls: fetchCalls } = fetchStub([]);

    const result = await runDeltaPollingOnce(
      buildDeps({ repo, accessToken, enqueue, fetchImpl: stub }),
    );

    // Graph never called; the mailbox stays ACTIVE (no reconnect mark), but the
    // error is recorded and the mailbox is counted as failed this cycle.
    expect(fetchCalls).toHaveLength(0);
    expect(enqueueCalls).toEqual([]);
    expect(state.reconnectMarked).toEqual([]);
    expect(state.recordedErrors).toHaveLength(1);
    expect(state.recordedErrors[0].mailboxId).toBe('mb_transient');
    expect(state.savedCursors).toEqual([]);
    expect(result.failedMailboxCount).toBe(1);
  });

  it('stops paging at maxPagesPerMailbox and does not save a cursor', async () => {
    const mailbox: DeltaPollingMailbox = {
      id: 'mb_runaway',
      emailAddress: 'iota@example.com',
      microsoftDeltaCursor: 'https://graph.example.com/cursor-0',
    };
    const { repo, state } = createFakeRepo([mailbox]);
    const accessToken = createFakeAccessToken({ mb_runaway: 'token-loop' });
    const { port: enqueue, calls: enqueueCalls } = createFakeEnqueue();
    // Always returns nextLink, never deltaLink → infinite paging without
    // the max-pages guard.
    const looping = async (): Promise<Response> =>
      jsonResponse({
        value: [{ id: 'm' }],
        '@odata.nextLink': 'https://graph.example.com/cursor-next',
      });
    const { fetch: stub, calls: fetchCalls } = fetchStub([
      looping,
      looping,
      looping,
      looping,
      looping,
      looping,
      looping,
      looping,
      looping,
      looping,
      looping,
      looping,
      looping,
      looping,
    ]);

    await runDeltaPollingOnce(
      buildDeps({
        repo,
        accessToken,
        enqueue,
        fetchImpl: stub,
        maxPagesPerMailbox: 3,
      }),
    );

    expect(fetchCalls.length).toBe(3);
    expect(enqueueCalls).toHaveLength(3);
    expect(state.savedCursors).toEqual([]);
  });
});

describe('runDeltaPollingOnce — security contract', () => {
  it('uses ONLY the injected enqueue port (no Telegram sender / pipeline call surface)', async () => {
    // The service has no path to import any telegram or detector code at
    // runtime. We assert behaviorally here: across a full cycle, the only
    // outbound channels touched are the injected ports.
    const mailbox: DeltaPollingMailbox = {
      id: 'mb_isolation',
      emailAddress: 'kappa@example.com',
      microsoftDeltaCursor: 'https://graph.example.com/cursor',
    };
    const { repo } = createFakeRepo([mailbox]);
    const accessToken = createFakeAccessToken({ mb_isolation: 'token-K' });
    const { port: enqueue, calls: enqueueCalls } = createFakeEnqueue();
    const { fetch: stub, calls: fetchCalls } = fetchStub([
      jsonResponse({
        value: [{ id: 'msg-1' }],
        '@odata.deltaLink': 'https://graph.example.com/delta-done',
      }),
    ]);

    const result = await runDeltaPollingOnce(
      buildDeps({ repo, accessToken, enqueue, fetchImpl: stub }),
    );

    expect(result.enqueuedMessageCount).toBe(1);
    expect(enqueueCalls).toHaveLength(1);
    // Exactly one HTTP call to Graph; no other network call possible.
    expect(fetchCalls).toHaveLength(1);
    // The payload routed to enqueue carries only the safe identifiers.
    expect(Object.keys(enqueueCalls[0]).sort()).toEqual([
      'graphMessageId',
      'mailboxId',
      'queuedAt',
    ]);
  });

  it('handles listing failure without crashing and reports zero work', async () => {
    const repo: DeltaPollingMailboxRepo = {
      async listActiveMicrosoftMailboxes() {
        throw new Error('db unreachable');
      },
      async saveDeltaCursor() {},
      async recordDeltaError() {},
      async resetDeltaCursor() {},
      async markReconnectRequired() {},
    };
    const accessToken = createFakeAccessToken({});
    const { port: enqueue } = createFakeEnqueue();
    const { fetch: stub } = fetchStub([]);

    const result = await runDeltaPollingOnce(
      buildDeps({ repo, accessToken, enqueue, fetchImpl: stub }),
    );

    expect(result).toEqual({
      checkedMailboxCount: 0,
      bootstrappedMailboxCount: 0,
      enqueuedMessageCount: 0,
      failedMailboxCount: 0,
    });
  });
});
