import { describe, it, expect, vi } from 'vitest';

import {
  classifyRenewError,
  classifySubscription,
  maskEmail,
  runSubscriptionRenewalOnce,
  SubscriptionRenewalTokenError,
  __internal,
  type RenewSubscriptionPort,
  type RenewableSubscriptionCandidate,
  type RenewalAccessTokenPort,
  type RenewalAuditPort,
  type SubscriptionRenewalDeps,
  type SubscriptionRenewalRepo,
} from '@/services/microsoft/subscription-renewal.service';

// ---------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------

// TASK-084 — a stable claim generation the fake hands back from claimForRenewal
// and expects on every subsequent CAS completion.
const FAKE_CLAIM_GENERATION = new Date('2026-05-29T09:59:59.000Z');

interface FakeRepoState {
  candidates: RenewableSubscriptionCandidate[];
  expiredSubscriptions: string[];
  failedSubscriptions: string[];
  reconnectMailboxes: string[];
  expiredMailboxes: string[];
  renewedSubscriptions: string[];
  claimedSubscriptions: string[];
  // Args captured for correction-A/B assertions.
  reconnectCredentialGenerations: Array<string | null>;
  expiredFailingRowIds: string[];
  listImpl?: () => Promise<RenewableSubscriptionCandidate[]>;
  // Behaviour knobs (default = current claim owner + writes succeed).
  claimImpl?: (subscriptionId: string) => import('@/services/microsoft/subscription-renewal.service').SubscriptionClaim;
  ownsClaim?: boolean;
  mailboxSubscriptionExpiredResult?: boolean;
  mailboxReconnectResult?: boolean;
  casThrows?: boolean;
}

function createFakeRepo(initial: RenewableSubscriptionCandidate[]): {
  repo: SubscriptionRenewalRepo;
  state: FakeRepoState;
} {
  const state: FakeRepoState = {
    candidates: [...initial],
    expiredSubscriptions: [],
    failedSubscriptions: [],
    reconnectMailboxes: [],
    expiredMailboxes: [],
    renewedSubscriptions: [],
    claimedSubscriptions: [],
    reconnectCredentialGenerations: [],
    expiredFailingRowIds: [],
  };
  const owns = (): boolean => state.ownsClaim ?? true;
  const repo: SubscriptionRenewalRepo = {
    async listRenewableCandidates() {
      if (state.listImpl) return state.listImpl();
      return state.candidates;
    },
    async claimForRenewal(subscriptionId) {
      state.claimedSubscriptions.push(subscriptionId);
      if (state.claimImpl) return state.claimImpl(subscriptionId);
      return {
        claimed: true,
        claimGeneration: FAKE_CLAIM_GENERATION,
        reclaimedStale: false,
      };
    },
    async markRenewedIfOwner({ subscriptionId }) {
      if (state.casThrows) throw new Error('db down');
      if (!owns()) return false;
      state.renewedSubscriptions.push(subscriptionId);
      return true;
    },
    async markSubscriptionFailedIfOwner(subscriptionId) {
      if (state.casThrows) throw new Error('db down');
      if (!owns()) return false;
      state.failedSubscriptions.push(subscriptionId);
      return true;
    },
    async markSubscriptionExpiredIfOwner(subscriptionId) {
      if (state.casThrows) throw new Error('db down');
      if (!owns()) return false;
      state.expiredSubscriptions.push(subscriptionId);
      return true;
    },
    async markMailboxSubscriptionExpiredIfNoOtherLiveSubscription({
      mailboxId,
      failingSubscriptionRowId,
    }) {
      state.expiredFailingRowIds.push(failingSubscriptionRowId);
      const result = state.mailboxSubscriptionExpiredResult ?? true;
      if (result) state.expiredMailboxes.push(mailboxId);
      return result;
    },
    async markMailboxReconnectRequiredIfCredentialCurrent(
      mailboxId,
      credentialGeneration,
    ) {
      state.reconnectCredentialGenerations.push(credentialGeneration);
      const result = state.mailboxReconnectResult ?? true;
      if (result) state.reconnectMailboxes.push(mailboxId);
      return result;
    },
  };
  return { repo, state };
}

type FakeCredentialEntry =
  | string
  | { accessToken: string; credentialGeneration: string | null }
  | (() => Promise<{ accessToken: string; credentialGeneration: string | null }>);

function createFakeAccessToken(
  tokenByMailboxId: Record<string, FakeCredentialEntry>,
): RenewalAccessTokenPort {
  return {
    async getAccessTokenForMailbox(mailboxId) {
      const entry = tokenByMailboxId[mailboxId];
      if (entry === undefined) {
        throw new Error(`no token configured for mailbox ${mailboxId}`);
      }
      if (typeof entry === 'function') return entry();
      if (typeof entry === 'string') {
        return { accessToken: entry, credentialGeneration: null };
      }
      return entry;
    },
  };
}

const FIXED_NOW = new Date('2026-05-29T10:00:00.000Z');
const HOURS = 60 * 60 * 1000;

function candidate(
  overrides: Partial<RenewableSubscriptionCandidate> = {},
): RenewableSubscriptionCandidate {
  return {
    id: 'gs_1',
    mailboxId: 'mb_1',
    subscriptionId: 'sub_1',
    emailAddress: 'user@example.com',
    mailboxStatus: 'ACTIVE',
    expirationDateTime: new Date(FIXED_NOW.getTime() + 12 * HOURS),
    ...overrides,
  };
}

const noopSleep = async (): Promise<void> => {};

function baseDeps(
  repo: SubscriptionRenewalRepo,
  partial: Partial<SubscriptionRenewalDeps> = {},
): SubscriptionRenewalDeps {
  return {
    repo,
    accessToken: createFakeAccessToken({ mb_1: 'access-token' }),
    renew: {
      async renew() {
        return { newExpirationDateTime: new Date(FIXED_NOW.getTime() + 6 * 24 * HOURS) };
      },
    },
    now: () => FIXED_NOW,
    sleep: noopSleep,
    ...partial,
  };
}

// ---------------------------------------------------------------------------
// 9.1 — Selection
// ---------------------------------------------------------------------------

describe('classifySubscription (selection)', () => {
  const within = __internal.DEFAULT_RENEW_WINDOW_MS;

  it('skips a subscription with more than 24h remaining', () => {
    const c = candidate({
      expirationDateTime: new Date(FIXED_NOW.getTime() + 48 * HOURS),
    });
    expect(classifySubscription(c, FIXED_NOW, within)).toBe('skip');
  });

  it('renews a subscription with <= 24h remaining', () => {
    const c = candidate({
      expirationDateTime: new Date(FIXED_NOW.getTime() + 6 * HOURS),
    });
    expect(classifySubscription(c, FIXED_NOW, within)).toBe('renew');
  });

  it('treats an already-expired subscription as expired', () => {
    const c = candidate({
      expirationDateTime: new Date(FIXED_NOW.getTime() - HOURS),
    });
    expect(classifySubscription(c, FIXED_NOW, within)).toBe('expired');
  });

  it('skips a DISABLED mailbox even when due', () => {
    const c = candidate({
      mailboxStatus: 'DISABLED',
      expirationDateTime: new Date(FIXED_NOW.getTime() + HOURS),
    });
    expect(classifySubscription(c, FIXED_NOW, within)).toBe('skip');
  });

  it('marks a candidate without a subscriptionId as invalid', () => {
    expect(classifySubscription(candidate({ subscriptionId: null }), FIXED_NOW, within)).toBe(
      'invalid',
    );
    expect(classifySubscription(candidate({ subscriptionId: '  ' }), FIXED_NOW, within)).toBe(
      'invalid',
    );
  });
});

describe('classifyRenewError', () => {
  it('maps auth (401) to reconnect_required', () => {
    expect(classifyRenewError({ kind: 'auth', httpStatus: 401 })).toBe('reconnect_required');
  });

  it('TASK-071 — maps permission (403) to transient, not reconnect_required', () => {
    // A 403 on the renew request is a Graph access blip, not a dead grant (the
    // access token was minted from a healthy refresh), so it must retry rather
    // than force a manual reconnect.
    expect(classifyRenewError({ kind: 'permission', httpStatus: 403 })).toBe('transient');
  });

  it('maps not_found / 404 / 410 to expired', () => {
    expect(classifyRenewError({ kind: 'not_found', httpStatus: 404 })).toBe('expired');
    expect(classifyRenewError({ httpStatus: 410 })).toBe('expired');
  });

  it('maps rate_limited / temporary / network to transient', () => {
    expect(classifyRenewError({ kind: 'rate_limited', httpStatus: 429 })).toBe('transient');
    expect(classifyRenewError({ kind: 'temporary', httpStatus: 503 })).toBe('transient');
    expect(classifyRenewError({ kind: 'network' })).toBe('transient');
  });

  it('falls back to fatal for unknown errors', () => {
    expect(classifyRenewError(new Error('boom'))).toBe('fatal');
    expect(classifyRenewError({ kind: 'validation' })).toBe('fatal');
  });
});

describe('runSubscriptionRenewalOnce — selection integration', () => {
  it('only renews due subscriptions and skips the rest', async () => {
    const due = candidate({
      id: 'gs_due',
      mailboxId: 'mb_due',
      subscriptionId: 'sub_due',
      expirationDateTime: new Date(FIXED_NOW.getTime() + 3 * HOURS),
    });
    const notDue = candidate({
      id: 'gs_far',
      mailboxId: 'mb_far',
      subscriptionId: 'sub_far',
      expirationDateTime: new Date(FIXED_NOW.getTime() + 72 * HOURS),
    });
    const { repo } = createFakeRepo([due, notDue]);
    const renew = vi.fn(async () => ({
      newExpirationDateTime: new Date(FIXED_NOW.getTime() + 6 * 24 * HOURS),
    }));

    const result = await runSubscriptionRenewalOnce(
      baseDeps(repo, {
        accessToken: createFakeAccessToken({ mb_due: 'token', mb_far: 'token' }),
        renew: { renew },
      }),
    );

    expect(result.checkedCount).toBe(2);
    expect(result.renewedCount).toBe(1);
    expect(result.skippedCount).toBe(1);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(renew).toHaveBeenCalledWith(
      expect.objectContaining({ subscriptionId: 'sub_due', accessToken: 'token' }),
    );
  });

  it('counts a candidate missing its subscriptionId as skipped without crashing', async () => {
    const { repo } = createFakeRepo([
      candidate({ subscriptionId: null, expirationDateTime: new Date(FIXED_NOW.getTime() + HOURS) }),
    ]);
    const renew = vi.fn();
    const result = await runSubscriptionRenewalOnce(baseDeps(repo, { renew: { renew } }));
    expect(result.skippedCount).toBe(1);
    expect(result.renewedCount).toBe(0);
    expect(renew).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 9.2 — Renew success
// ---------------------------------------------------------------------------

describe('runSubscriptionRenewalOnce — success', () => {
  it('renews, returns the new expiration, and writes a SUBSCRIPTION_RENEWED audit entry', async () => {
    const due = candidate({
      expirationDateTime: new Date(FIXED_NOW.getTime() + 2 * HOURS),
    });
    const { repo, state } = createFakeRepo([due]);
    const newExpiration = new Date(FIXED_NOW.getTime() + 6 * 24 * HOURS);
    const renew: RenewSubscriptionPort = {
      renew: vi.fn(async () => ({ newExpirationDateTime: newExpiration })),
    };
    const recordRenewed = vi.fn();
    const audit: RenewalAuditPort = { recordRenewed };

    const result = await runSubscriptionRenewalOnce(baseDeps(repo, { renew, audit }));

    expect(result.renewedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    expect(recordRenewed).toHaveBeenCalledWith({
      mailboxId: 'mb_1',
      graphSubscriptionId: 'sub_1',
      oldExpirationDateTime: due.expirationDateTime,
      newExpirationDateTime: newExpiration,
    });
    // No failure/expiry side effects on the happy path.
    expect(state.failedSubscriptions).toEqual([]);
    expect(state.expiredSubscriptions).toEqual([]);
    expect(state.reconnectMailboxes).toEqual([]);
  });

  it('still renews when no audit port is provided', async () => {
    const { repo } = createFakeRepo([
      candidate({ expirationDateTime: new Date(FIXED_NOW.getTime() + HOURS) }),
    ]);
    const result = await runSubscriptionRenewalOnce(baseDeps(repo, { audit: undefined }));
    expect(result.renewedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 9.3 — Token / reconnect error
// ---------------------------------------------------------------------------

describe('runSubscriptionRenewalOnce — token revoked', () => {
  it('maps a revoked refresh token to RECONNECT_REQUIRED and does not retry the renew', async () => {
    const { repo, state } = createFakeRepo([
      candidate({ expirationDateTime: new Date(FIXED_NOW.getTime() + HOURS) }),
    ]);
    const renew = vi.fn();
    const accessToken: RenewalAccessTokenPort = {
      getAccessTokenForMailbox: vi.fn(async () => {
        throw new SubscriptionRenewalTokenError('reconnect_required', 'refresh token revoked');
      }),
    };

    const result = await runSubscriptionRenewalOnce(
      baseDeps(repo, { renew: { renew }, accessToken }),
    );

    expect(result.reconnectRequiredCount).toBe(1);
    expect(result.renewedCount).toBe(0);
    expect(state.reconnectMailboxes).toEqual(['mb_1']);
    expect(renew).not.toHaveBeenCalled();
    // getAccessTokenForMailbox is called exactly once — no infinite retry loop.
    expect(accessToken.getAccessTokenForMailbox).toHaveBeenCalledTimes(1);
  });

  it('maps a 401 during the PATCH to RECONNECT_REQUIRED', async () => {
    const { repo, state } = createFakeRepo([
      candidate({ expirationDateTime: new Date(FIXED_NOW.getTime() + HOURS) }),
    ]);
    const renew = vi.fn(async () => {
      throw { kind: 'auth', httpStatus: 401 };
    });

    const result = await runSubscriptionRenewalOnce(baseDeps(repo, { renew: { renew } }));

    expect(result.reconnectRequiredCount).toBe(1);
    expect(state.reconnectMailboxes).toEqual(['mb_1']);
    expect(renew).toHaveBeenCalledTimes(1); // auth is not retried
  });
});

// ---------------------------------------------------------------------------
// 9.1 / 9.4 — Missing / expired subscription
// ---------------------------------------------------------------------------

describe('runSubscriptionRenewalOnce — expired / missing subscription', () => {
  it('marks SUBSCRIPTION_EXPIRED for an already-expired candidate without calling Graph', async () => {
    const { repo, state } = createFakeRepo([
      candidate({ expirationDateTime: new Date(FIXED_NOW.getTime() - HOURS) }),
    ]);
    const renew = vi.fn();

    const result = await runSubscriptionRenewalOnce(baseDeps(repo, { renew: { renew } }));

    expect(result.expiredCount).toBe(1);
    expect(state.expiredSubscriptions).toEqual(['sub_1']);
    expect(state.expiredMailboxes).toEqual(['mb_1']);
    expect(renew).not.toHaveBeenCalled();
  });

  it('marks SUBSCRIPTION_EXPIRED when Graph returns 404/410 during renew', async () => {
    const { repo, state } = createFakeRepo([
      candidate({ expirationDateTime: new Date(FIXED_NOW.getTime() + HOURS) }),
    ]);
    const renew = vi.fn(async () => {
      throw { kind: 'not_found', httpStatus: 404 };
    });

    const result = await runSubscriptionRenewalOnce(baseDeps(repo, { renew: { renew } }));

    expect(result.expiredCount).toBe(1);
    expect(state.expiredSubscriptions).toEqual(['sub_1']);
    expect(state.expiredMailboxes).toEqual(['mb_1']);
  });
});

// ---------------------------------------------------------------------------
// 9.4 — Transient errors
// ---------------------------------------------------------------------------

describe('runSubscriptionRenewalOnce — transient errors', () => {
  it('retries transient failures up to the limit then records a failure', async () => {
    const { repo, state } = createFakeRepo([
      candidate({ expirationDateTime: new Date(FIXED_NOW.getTime() + HOURS) }),
    ]);
    const renew = vi.fn(async () => {
      throw { kind: 'temporary', httpStatus: 503 };
    });
    const sleep = vi.fn(async () => {});

    const result = await runSubscriptionRenewalOnce(
      baseDeps(repo, { renew: { renew }, maxRenewAttempts: 3, sleep }),
    );

    expect(result.failedCount).toBe(1);
    expect(result.renewedCount).toBe(0);
    expect(renew).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2); // between the 3 attempts
    expect(state.failedSubscriptions).toEqual(['sub_1']);
  });

  it('succeeds when a transient failure clears on retry', async () => {
    const { repo } = createFakeRepo([
      candidate({ expirationDateTime: new Date(FIXED_NOW.getTime() + HOURS) }),
    ]);
    let attempts = 0;
    const renew = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw { kind: 'rate_limited', httpStatus: 429 };
      return { newExpirationDateTime: new Date(FIXED_NOW.getTime() + 6 * 24 * HOURS) };
    });

    const result = await runSubscriptionRenewalOnce(
      baseDeps(repo, { renew: { renew }, sleep: noopSleep }),
    );

    expect(result.renewedCount).toBe(1);
    expect(renew).toHaveBeenCalledTimes(2);
  });

  it('does not let one failing mailbox crash the whole batch', async () => {
    const bad = candidate({
      id: 'gs_bad',
      mailboxId: 'mb_bad',
      subscriptionId: 'sub_bad',
      expirationDateTime: new Date(FIXED_NOW.getTime() + HOURS),
    });
    const good = candidate({
      id: 'gs_good',
      mailboxId: 'mb_good',
      subscriptionId: 'sub_good',
      expirationDateTime: new Date(FIXED_NOW.getTime() + HOURS),
    });
    const { repo } = createFakeRepo([bad, good]);

    const renew = vi.fn(async ({ subscriptionId }: { subscriptionId: string }) => {
      if (subscriptionId === 'sub_bad') {
        throw { kind: 'temporary', httpStatus: 500 };
      }
      return { newExpirationDateTime: new Date(FIXED_NOW.getTime() + 6 * 24 * HOURS) };
    });

    const result = await runSubscriptionRenewalOnce(
      baseDeps(repo, {
        accessToken: createFakeAccessToken({ mb_bad: 'token', mb_good: 'token' }),
        renew: { renew },
        maxRenewAttempts: 2,
        sleep: noopSleep,
      }),
    );

    expect(result.checkedCount).toBe(2);
    expect(result.renewedCount).toBe(1);
    expect(result.failedCount).toBe(1);
  });

  it('returns an empty result (no throw) when listing candidates fails', async () => {
    const { repo, state } = createFakeRepo([]);
    state.listImpl = async () => {
      throw new Error('db down');
    };
    const result = await runSubscriptionRenewalOnce(baseDeps(repo));
    expect(result).toEqual({
      checkedCount: 0,
      renewedCount: 0,
      skippedCount: 0,
      failedCount: 0,
      reconnectRequiredCount: 0,
      expiredCount: 0,
      claimLostCount: 0,
      staleReclaimedCount: 0,
    });
  });
});

// ---------------------------------------------------------------------------
// TASK-084 — atomic claim + CAS ownership orchestration
// ---------------------------------------------------------------------------

describe('runSubscriptionRenewalOnce — claim + CAS ownership (TASK-084)', () => {
  const due = () =>
    candidate({ expirationDateTime: new Date(FIXED_NOW.getTime() + HOURS) });

  it('claims before acquiring a token, and skips renew when the claim is lost', async () => {
    const { repo, state } = createFakeRepo([due()]);
    state.claimImpl = () => ({
      claimed: false,
      claimGeneration: null,
      reclaimedStale: false,
    });
    const renew = vi.fn();
    const getAccessTokenForMailbox = vi.fn(async () => ({
      accessToken: 'token',
      credentialGeneration: null,
    }));

    const result = await runSubscriptionRenewalOnce(
      baseDeps(repo, { renew: { renew }, accessToken: { getAccessTokenForMailbox } }),
    );

    expect(result.claimLostCount).toBe(1);
    expect(result.renewedCount).toBe(0);
    // Lost claim → no token, no PATCH, zero mailbox side effects.
    expect(getAccessTokenForMailbox).not.toHaveBeenCalled();
    expect(renew).not.toHaveBeenCalled();
    expect(state.reconnectMailboxes).toEqual([]);
    expect(state.expiredMailboxes).toEqual([]);
    expect(state.renewedSubscriptions).toEqual([]);
  });

  it('stale-reclaim race — a resumed worker that lost its generation applies zero side effects', async () => {
    // Worker A claimed generation A, stalled past the 30-min cutoff; Worker B
    // stale-reclaimed (generation B). When A resumes, its claim can no longer be
    // established (the repo's hijack guard returns claimed=false) — A must not
    // acquire a token, PATCH, complete, or touch the mailbox in any way.
    const { repo, state } = createFakeRepo([due()]);
    state.claimImpl = () => ({
      claimed: false,
      claimGeneration: null,
      reclaimedStale: false,
    });
    const getAccessTokenForMailbox = vi.fn();
    const renew = vi.fn();

    const result = await runSubscriptionRenewalOnce(
      baseDeps(repo, { renew: { renew }, accessToken: { getAccessTokenForMailbox } }),
    );

    expect(result.claimLostCount).toBe(1);
    expect(getAccessTokenForMailbox).not.toHaveBeenCalled();
    expect(renew).not.toHaveBeenCalled();
    expect(state.renewedSubscriptions).toEqual([]);
    expect(state.failedSubscriptions).toEqual([]);
    expect(state.expiredSubscriptions).toEqual([]);
    expect(state.reconnectMailboxes).toEqual([]);
    expect(state.expiredMailboxes).toEqual([]);
  });

  it('counts a stale reclaim in staleReclaimedCount', async () => {
    const { repo, state } = createFakeRepo([due()]);
    state.claimImpl = () => ({
      claimed: true,
      claimGeneration: FAKE_CLAIM_GENERATION,
      reclaimedStale: true,
    });
    const result = await runSubscriptionRenewalOnce(baseDeps(repo));
    expect(result.staleReclaimedCount).toBe(1);
    expect(result.renewedCount).toBe(1);
    expect(state.claimedSubscriptions).toEqual(['sub_1']);
  });

  it('does not overwrite a newer state when the success CAS finds ownership lost', async () => {
    const { repo, state } = createFakeRepo([due()]);
    state.ownsClaim = false; // markRenewedIfOwner → count 0
    const recordRenewed = vi.fn();

    const result = await runSubscriptionRenewalOnce(
      baseDeps(repo, { audit: { recordRenewed } }),
    );

    expect(result.claimLostCount).toBe(1);
    expect(result.renewedCount).toBe(0);
    expect(state.renewedSubscriptions).toEqual([]);
    // No audit entry is written for a lost claim.
    expect(recordRenewed).not.toHaveBeenCalled();
  });

  it('CORRECTION A — a lost completion CAS applies ZERO mailbox side effect (404/410)', async () => {
    const { repo, state } = createFakeRepo([due()]);
    state.ownsClaim = false; // markSubscriptionExpiredIfOwner → count 0
    const renew = vi.fn(async () => {
      throw { kind: 'not_found', httpStatus: 404 };
    });

    const result = await runSubscriptionRenewalOnce(baseDeps(repo, { renew: { renew } }));

    expect(result.expiredCount).toBe(1);
    // Ownership lost at STEP 1 → the relation-aware mailbox writer never runs.
    expect(state.expiredMailboxes).toEqual([]);
    expect(state.expiredFailingRowIds).toEqual([]);
  });

  it('CORRECTION A — a throwing completion CAS applies ZERO mailbox side effect', async () => {
    const { repo, state } = createFakeRepo([due()]);
    state.casThrows = true; // markSubscriptionExpiredIfOwner throws (DB error)
    const renew = vi.fn(async () => {
      throw { kind: 'not_found', httpStatus: 410 };
    });

    const result = await runSubscriptionRenewalOnce(baseDeps(repo, { renew: { renew } }));

    expect(result.expiredCount).toBe(1);
    expect(state.expiredMailboxes).toEqual([]);
    expect(state.expiredFailingRowIds).toEqual([]);
  });

  it('passes the failing subscription row id to the relation-aware expired writer', async () => {
    const c = candidate({
      id: 'gs_row_1',
      expirationDateTime: new Date(FIXED_NOW.getTime() - HOURS),
    });
    const { repo, state } = createFakeRepo([c]);
    await runSubscriptionRenewalOnce(baseDeps(repo));
    expect(state.expiredFailingRowIds).toEqual(['gs_row_1']);
    expect(state.expiredMailboxes).toEqual(['mb_1']);
  });

  it('keeps the mailbox ACTIVE when a replacement subscription blocks the expired writer', async () => {
    const { repo, state } = createFakeRepo([
      candidate({ expirationDateTime: new Date(FIXED_NOW.getTime() - HOURS) }),
    ]);
    // Relation predicate did not match (a live replacement exists) → no transition.
    state.mailboxSubscriptionExpiredResult = false;

    const result = await runSubscriptionRenewalOnce(baseDeps(repo));

    expect(result.expiredCount).toBe(1);
    // STEP 1 still owned the row, but STEP 2 left the mailbox untouched.
    expect(state.expiredSubscriptions).toEqual(['sub_1']);
    expect(state.expiredMailboxes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TASK-084 — credential-generation guard (correction B), Case A and Case B
// ---------------------------------------------------------------------------

describe('runSubscriptionRenewalOnce — credential-generation reconnect guard', () => {
  const due = () =>
    candidate({ expirationDateTime: new Date(FIXED_NOW.getTime() + HOURS) });

  it('Case A — uses the credential generation carried by the token error', async () => {
    const { repo, state } = createFakeRepo([due()]);
    const accessToken: RenewalAccessTokenPort = {
      getAccessTokenForMailbox: vi.fn(async () => {
        throw new SubscriptionRenewalTokenError(
          'reconnect_required',
          'revoked',
          'cipher-A',
        );
      }),
    };

    const result = await runSubscriptionRenewalOnce(baseDeps(repo, { accessToken }));

    expect(result.reconnectRequiredCount).toBe(1);
    expect(state.reconnectMailboxes).toEqual(['mb_1']);
    // The guard receives exactly the generation the operation started with.
    expect(state.reconnectCredentialGenerations).toEqual(['cipher-A']);
  });

  it('Case B — uses the post-acquisition credential generation on a Graph 401', async () => {
    const { repo, state } = createFakeRepo([due()]);
    const accessToken = createFakeAccessToken({
      mb_1: { accessToken: 'token', credentialGeneration: 'cipher-A-prime' },
    });
    const renew = vi.fn(async () => {
      throw { kind: 'auth', httpStatus: 401 };
    });

    const result = await runSubscriptionRenewalOnce(
      baseDeps(repo, { accessToken, renew: { renew } }),
    );

    expect(result.reconnectRequiredCount).toBe(1);
    expect(state.reconnectCredentialGenerations).toEqual(['cipher-A-prime']);
  });

  it('does not mark the mailbox when the credential generation changed concurrently', async () => {
    const { repo, state } = createFakeRepo([due()]);
    // Writer predicate misses (a concurrent OAuth reconnect wrote a new credential).
    state.mailboxReconnectResult = false;
    const accessToken: RenewalAccessTokenPort = {
      getAccessTokenForMailbox: vi.fn(async () => {
        throw new SubscriptionRenewalTokenError(
          'reconnect_required',
          'revoked',
          'stale-cipher',
        );
      }),
    };

    const result = await runSubscriptionRenewalOnce(baseDeps(repo, { accessToken }));

    // Outcome is still reconnect_required, but the freshly reconnected mailbox
    // was NOT overwritten.
    expect(result.reconnectRequiredCount).toBe(1);
    expect(state.reconnectMailboxes).toEqual([]);
  });

  it('CORRECTION A — a lost claim blocks the reconnect writer entirely (Case B)', async () => {
    const { repo, state } = createFakeRepo([due()]);
    state.ownsClaim = false; // markSubscriptionFailedIfOwner → count 0
    const renew = vi.fn(async () => {
      throw { kind: 'auth', httpStatus: 401 };
    });

    const result = await runSubscriptionRenewalOnce(baseDeps(repo, { renew: { renew } }));

    expect(result.reconnectRequiredCount).toBe(1);
    // Ownership lost → the credential guard is never even consulted.
    expect(state.reconnectMailboxes).toEqual([]);
    expect(state.reconnectCredentialGenerations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('maskEmail', () => {
  it('masks the local part and keeps the domain', () => {
    expect(maskEmail('verylonglocal@example.com')).toBe('v••l@example.com');
    expect(maskEmail('ab@example.com')).toBe('••@example.com');
    expect(maskEmail('not-an-email')).toBe('***');
  });
});
