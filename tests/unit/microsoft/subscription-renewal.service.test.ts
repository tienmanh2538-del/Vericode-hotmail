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

interface FakeRepoState {
  candidates: RenewableSubscriptionCandidate[];
  expiredSubscriptions: string[];
  failedSubscriptions: string[];
  reconnectMailboxes: string[];
  expiredMailboxes: string[];
  listImpl?: () => Promise<RenewableSubscriptionCandidate[]>;
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
  };
  const repo: SubscriptionRenewalRepo = {
    async listRenewableCandidates() {
      if (state.listImpl) return state.listImpl();
      return state.candidates;
    },
    async markSubscriptionExpired(subscriptionId) {
      state.expiredSubscriptions.push(subscriptionId);
    },
    async markSubscriptionFailed(subscriptionId) {
      state.failedSubscriptions.push(subscriptionId);
    },
    async markMailboxReconnectRequired(mailboxId) {
      state.reconnectMailboxes.push(mailboxId);
    },
    async markMailboxSubscriptionExpired(mailboxId) {
      state.expiredMailboxes.push(mailboxId);
    },
  };
  return { repo, state };
}

function createFakeAccessToken(
  tokenByMailboxId: Record<string, string | (() => Promise<string>)>,
): RenewalAccessTokenPort {
  return {
    async getAccessTokenForMailbox(mailboxId) {
      const entry = tokenByMailboxId[mailboxId];
      if (entry === undefined) {
        throw new Error(`no token configured for mailbox ${mailboxId}`);
      }
      if (typeof entry === 'function') return entry();
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
    });
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
