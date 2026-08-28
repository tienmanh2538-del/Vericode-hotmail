// TASK-083 — SUBSCRIPTION_EXPIRED recovery mode tests.
//
// Recovery is an explicit opt-in on the TASK-082 reconciliation service: same
// dry-run/apply/bounded/sequential machinery, candidates pinned to
// SUBSCRIPTION_EXPIRED, and one new mutation primitive — the conditional flip
// back to ACTIVE that only fires after the ensure seam proved a fresh
// subscription was created. These tests cover the approved state machine, the
// D2 skipped_existing edge, and the disconnect/reconnect/renewal races.

import { describe, it, expect, vi } from 'vitest';

import {
  MAX_RECONCILIATION_LIMIT,
  runSubscriptionReconciliationOnce,
  type MailboxReconciliationOutcome,
  type SubscriptionReconciliationDeps,
} from '@/services/microsoft/subscription-reconciliation.service';
import { SubscriptionRenewalTokenError } from '@/services/microsoft/subscription-renewal.service';

const NOW = new Date('2026-08-23T10:00:00.000Z');

interface RecoveryFakeOptions {
  recoveryCandidates?: string[];
  normalCandidates?: string[];
  /** Per-mailbox status sequence consumed by getMailboxStatus calls. */
  statusSequences?: Record<string, string[]>;
  blocking?: Record<string, boolean>;
  tokenError?: unknown;
  ensureOutcome?: (mailboxId: string) =>
    | { outcome: 'created'; subscriptionId: string }
    | { outcome: 'skipped_existing'; existingStatus: 'FAILED' }
    // TASK-086 — the non-creating concurrency outcomes. None of them may ever
    // drive the SUBSCRIPTION_EXPIRED → ACTIVE flip.
    | { outcome: 'blocked_renewing' }
    | { outcome: 'lost_ownership'; existingStatus: 'ACTIVE' }
    | { outcome: 'conflict_existing'; existingStatus: 'ACTIVE' }
    | {
        outcome: 'conflict_unowned';
        source: 'remote_conflict' | 'local_unique_conflict';
      }
    | { outcome: 'failed'; errorName: string };
  /** Result of the conditional SUBSCRIPTION_EXPIRED → ACTIVE flip. */
  flipResult?: boolean;
  cleanupError?: Error;
}

function buildRecoveryDeps(options: RecoveryFakeOptions = {}) {
  const statusSequences = new Map<string, string[]>(
    Object.entries(options.statusSequences ?? {}),
  );
  const repo = {
    listReconciliationCandidates: vi.fn(async (limit: number) =>
      (options.normalCandidates ?? [])
        .slice(0, limit)
        .map((mailboxId) => ({ mailboxId })),
    ),
    listSubscriptionExpiredRecoveryCandidates: vi.fn(async (limit: number) =>
      (options.recoveryCandidates ?? [])
        .slice(0, limit)
        .map((mailboxId) => ({ mailboxId })),
    ),
    getMailboxStatus: vi.fn(async (mailboxId: string) => {
      const sequence = statusSequences.get(mailboxId);
      if (sequence && sequence.length > 0) {
        return sequence.length > 1 ? (sequence.shift() as string) : sequence[0];
      }
      return 'SUBSCRIPTION_EXPIRED';
    }),
    hasBlockingSubscription: vi.fn(
      async (mailboxId: string) => options.blocking?.[mailboxId] ?? false,
    ),
    markMailboxReconnectRequiredIfActive: vi.fn(async () => true),
    markMailboxReconnectRequiredIfSubscriptionExpired: vi.fn(async () => true),
    markMailboxActiveIfSubscriptionExpired: vi.fn(
      async () => options.flipResult ?? true,
    ),
    markSubscriptionExpired: vi.fn(async () => undefined),
  };
  const accessToken = {
    getAccessTokenForMailbox: vi.fn(async (mailboxId: string) => {
      if (options.tokenError) throw options.tokenError;
      return `access-for-${mailboxId}`;
    }),
  };
  const ensure = {
    ensure: vi.fn(async ({ mailboxId }: { mailboxId: string }) =>
      options.ensureOutcome
        ? options.ensureOutcome(mailboxId)
        : { outcome: 'created' as const, subscriptionId: `sub-${mailboxId}` },
    ),
  };
  const remoteCleanup = {
    deleteRemoteSubscription: vi.fn(async () => {
      if (options.cleanupError) throw options.cleanupError;
    }),
  };
  const logCalls: unknown[][] = [];
  const logger = {
    debug: (...args: unknown[]) => logCalls.push(args),
    info: (...args: unknown[]) => logCalls.push(args),
    warn: (...args: unknown[]) => logCalls.push(args),
    error: (...args: unknown[]) => logCalls.push(args),
  };
  const deps: SubscriptionReconciliationDeps = {
    repo,
    accessToken,
    ensure,
    remoteCleanup,
    logger,
    now: () => NOW,
  };
  return { deps, repo, accessToken, ensure, remoteCleanup, logCalls };
}

function outcomesOf(result: {
  outcomes: Array<{ outcome: MailboxReconciliationOutcome }>;
}) {
  return result.outcomes.map((record) => record.outcome);
}

// ---------------------------------------------------------------------------
// Opt-in gating — normal reconciliation is untouched
// ---------------------------------------------------------------------------

describe('recovery opt-in gating', () => {
  it('without the flag, recovery candidates are never listed or touched', async () => {
    const { deps, repo } = buildRecoveryDeps({
      normalCandidates: [],
      recoveryCandidates: ['mb-exp'],
    });
    const result = await runSubscriptionReconciliationOnce(deps, { mode: 'apply' });
    expect(result.recoveryMode).toBe(false);
    expect(repo.listReconciliationCandidates).toHaveBeenCalledTimes(1);
    expect(repo.listSubscriptionExpiredRecoveryCandidates).not.toHaveBeenCalled();
    expect(repo.markMailboxActiveIfSubscriptionExpired).not.toHaveBeenCalled();
    expect(
      repo.markMailboxReconnectRequiredIfSubscriptionExpired,
    ).not.toHaveBeenCalled();
  });

  it('with the flag, candidates come from the dedicated recovery query only', async () => {
    const { deps, repo } = buildRecoveryDeps({
      normalCandidates: ['mb-active'],
      recoveryCandidates: ['mb-exp'],
    });
    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      recoverSubscriptionExpired: true,
    });
    expect(result.recoveryMode).toBe(true);
    expect(repo.listSubscriptionExpiredRecoveryCandidates).toHaveBeenCalledWith(
      5,
      NOW,
    );
    expect(repo.listReconciliationCandidates).not.toHaveBeenCalled();
    // The ACTIVE mailbox from the normal pool was never processed.
    expect(outcomesOf(result)).toEqual(['recovered']);
  });

  it('recovery dry-run is the default and is strictly non-mutating', async () => {
    const { deps, repo, accessToken, ensure, remoteCleanup } = buildRecoveryDeps({
      recoveryCandidates: ['mb-exp'],
    });
    const result = await runSubscriptionReconciliationOnce(deps, {
      recoverSubscriptionExpired: true,
    });
    expect(result.mode).toBe('dry_run');
    expect(result.recoveryMode).toBe(true);
    expect(outcomesOf(result)).toEqual(['candidate']);
    expect(accessToken.getAccessTokenForMailbox).not.toHaveBeenCalled();
    expect(ensure.ensure).not.toHaveBeenCalled();
    expect(remoteCleanup.deleteRemoteSubscription).not.toHaveBeenCalled();
    expect(repo.markMailboxActiveIfSubscriptionExpired).not.toHaveBeenCalled();
    expect(repo.markSubscriptionExpired).not.toHaveBeenCalled();
  });

  it('recovery honours the shared bounded limit and hard maximum', async () => {
    const { deps, repo } = buildRecoveryDeps({ recoveryCandidates: [] });
    const result = await runSubscriptionReconciliationOnce(deps, {
      recoverSubscriptionExpired: true,
      limit: 999,
    });
    expect(result.limit).toBe(MAX_RECONCILIATION_LIMIT);
    expect(result.limitClamped).toBe(true);
    expect(repo.listSubscriptionExpiredRecoveryCandidates).toHaveBeenCalledWith(
      MAX_RECONCILIATION_LIMIT,
      NOW,
    );
  });
});

// ---------------------------------------------------------------------------
// Approved state machine — ACTIVE only as the final conditional step
// ---------------------------------------------------------------------------

describe('recovery state machine', () => {
  it('recovers: ensure created first, THEN the conditional flip to ACTIVE', async () => {
    const { deps, repo, ensure } = buildRecoveryDeps({
      recoveryCandidates: ['mb-exp'],
    });
    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      recoverSubscriptionExpired: true,
    });
    expect(outcomesOf(result)).toEqual(['recovered']);
    expect(result.recoveredCount).toBe(1);
    expect(result.createdCount).toBe(1);
    // Order: the flip only happened after ensure proved a usable subscription.
    expect(ensure.ensure.mock.invocationCallOrder[0]).toBeLessThan(
      repo.markMailboxActiveIfSubscriptionExpired.mock.invocationCallOrder[0],
    );
    expect(repo.markMailboxActiveIfSubscriptionExpired).toHaveBeenCalledWith(
      'mb-exp',
    );
    expect(repo.markSubscriptionExpired).not.toHaveBeenCalled();
  });

  it('D2: a blocking possibly-live subscription → skipped_existing, no create, no flip', async () => {
    const { deps, repo, accessToken, ensure } = buildRecoveryDeps({
      recoveryCandidates: ['mb-exp'],
      blocking: { 'mb-exp': true },
    });
    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      recoverSubscriptionExpired: true,
    });
    expect(outcomesOf(result)).toEqual(['skipped_existing']);
    expect(accessToken.getAccessTokenForMailbox).not.toHaveBeenCalled();
    expect(ensure.ensure).not.toHaveBeenCalled();
    expect(repo.markMailboxActiveIfSubscriptionExpired).not.toHaveBeenCalled();
  });

  it('D2 at the ensure seam (renewal race): skipped_existing → no flip, status kept', async () => {
    const { deps, repo } = buildRecoveryDeps({
      recoveryCandidates: ['mb-exp'],
      ensureOutcome: () => ({
        outcome: 'skipped_existing',
        existingStatus: 'FAILED',
      }),
    });
    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      recoverSubscriptionExpired: true,
    });
    expect(outcomesOf(result)).toEqual(['skipped_existing']);
    expect(repo.markMailboxActiveIfSubscriptionExpired).not.toHaveBeenCalled();
    expect(repo.markSubscriptionExpired).not.toHaveBeenCalled();
  });

  it('ensure failure keeps SUBSCRIPTION_EXPIRED — no flip, no cleanup', async () => {
    const { deps, repo, remoteCleanup } = buildRecoveryDeps({
      recoveryCandidates: ['mb-exp'],
      ensureOutcome: () => ({ outcome: 'failed', errorName: 'GraphSubscriptionError' }),
    });
    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      recoverSubscriptionExpired: true,
    });
    expect(outcomesOf(result)).toEqual(['failed']);
    expect(repo.markMailboxActiveIfSubscriptionExpired).not.toHaveBeenCalled();
    expect(remoteCleanup.deleteRemoteSubscription).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Token semantics
// ---------------------------------------------------------------------------

describe('recovery token semantics', () => {
  it('transient failure keeps SUBSCRIPTION_EXPIRED with exactly one attempt', async () => {
    const { deps, repo, accessToken } = buildRecoveryDeps({
      recoveryCandidates: ['mb-exp'],
      tokenError: new SubscriptionRenewalTokenError('transient', 'HTTP 503'),
    });
    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      recoverSubscriptionExpired: true,
    });
    expect(outcomesOf(result)).toEqual(['failed_transient']);
    expect(accessToken.getAccessTokenForMailbox).toHaveBeenCalledTimes(1);
    expect(repo.markMailboxReconnectRequiredIfActive).not.toHaveBeenCalled();
    expect(
      repo.markMailboxReconnectRequiredIfSubscriptionExpired,
    ).not.toHaveBeenCalled();
    expect(repo.markMailboxActiveIfSubscriptionExpired).not.toHaveBeenCalled();
  });

  it('reconnect_required uses the SUBSCRIPTION_EXPIRED-pinned conditional mark', async () => {
    const { deps, repo, ensure } = buildRecoveryDeps({
      recoveryCandidates: ['mb-exp'],
      tokenError: new SubscriptionRenewalTokenError('reconnect_required', 'revoked'),
    });
    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      recoverSubscriptionExpired: true,
    });
    expect(outcomesOf(result)).toEqual(['reconnect_required']);
    expect(
      repo.markMailboxReconnectRequiredIfSubscriptionExpired,
    ).toHaveBeenCalledWith('mb-exp');
    // The ACTIVE-pinned variant must never fire in recovery mode.
    expect(repo.markMailboxReconnectRequiredIfActive).not.toHaveBeenCalled();
    expect(ensure.ensure).not.toHaveBeenCalled();
    expect(repo.markMailboxActiveIfSubscriptionExpired).not.toHaveBeenCalled();
  });

  it('config failure aborts the run without touching any mailbox', async () => {
    const { deps, repo } = buildRecoveryDeps({
      recoveryCandidates: ['mb-1', 'mb-2'],
      tokenError: new SubscriptionRenewalTokenError('config', 'OAuth unset'),
    });
    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      recoverSubscriptionExpired: true,
    });
    expect(result.aborted).toBe(true);
    expect(result.checkedCount).toBe(1);
    expect(
      repo.markMailboxReconnectRequiredIfSubscriptionExpired,
    ).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Disconnect / reconnect races
// ---------------------------------------------------------------------------

describe('recovery race protection', () => {
  it('Race A: state changed before the token step → no token, no create, no overwrite', async () => {
    const { deps, accessToken, ensure } = buildRecoveryDeps({
      recoveryCandidates: ['mb-exp'],
      statusSequences: { 'mb-exp': ['DISABLED'] },
    });
    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      recoverSubscriptionExpired: true,
    });
    expect(outcomesOf(result)).toEqual(['skipped_state_changed']);
    expect(accessToken.getAccessTokenForMailbox).not.toHaveBeenCalled();
    expect(ensure.ensure).not.toHaveBeenCalled();
  });

  it('Race B: disconnect during the token refresh → post-token re-check stops the create', async () => {
    const { deps, ensure, repo } = buildRecoveryDeps({
      recoveryCandidates: ['mb-exp'],
      statusSequences: { 'mb-exp': ['SUBSCRIPTION_EXPIRED', 'DISABLED'] },
    });
    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      recoverSubscriptionExpired: true,
    });
    expect(outcomesOf(result)).toEqual(['skipped_state_changed']);
    expect(ensure.ensure).not.toHaveBeenCalled();
    expect(repo.markMailboxActiveIfSubscriptionExpired).not.toHaveBeenCalled();
  });

  it('Race C: flip does not match and status is DISABLED → no resurrect, subscription made non-usable', async () => {
    // Operator disconnect after the remote create: the conditional flip
    // matches nothing, DISABLED is preserved, and the just-created
    // subscription is made non-usable — local EXPIRED first, then ONE delete.
    const { deps, repo, remoteCleanup } = buildRecoveryDeps({
      recoveryCandidates: ['mb-exp'],
      flipResult: false,
      statusSequences: {
        'mb-exp': ['SUBSCRIPTION_EXPIRED', 'SUBSCRIPTION_EXPIRED', 'DISABLED'],
      },
    });
    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      recoverSubscriptionExpired: true,
    });
    expect(result.outcomes).toEqual([
      {
        mailboxId: 'mb-exp',
        outcome: 'skipped_state_changed',
        remoteCleanup: 'deleted',
      },
    ]);
    expect(result.skippedStateChangedCount).toBe(1);
    expect(result.recoveredCount).toBe(0);
    expect(repo.markSubscriptionExpired).toHaveBeenCalledWith('sub-mb-exp');
    expect(remoteCleanup.deleteRemoteSubscription).toHaveBeenCalledTimes(1);
    expect(remoteCleanup.deleteRemoteSubscription).toHaveBeenCalledWith({
      mailboxId: 'mb-exp',
      subscriptionId: 'sub-mb-exp',
      accessToken: 'access-for-mb-exp',
    });
  });

  it('Race D (Antigravity High regression): concurrent reconnect made the mailbox ACTIVE → KEEP the new subscription', async () => {
    // OAuth reconnect finished between the create and the flip: reconnect's
    // ensure may have no-opped onto the subscription THIS recovery created.
    // Destroying it would leave an ACTIVE mailbox without a webhook path, so
    // the fix keeps both the ACTIVE status and the usable subscription intact.
    const { deps, repo, ensure, remoteCleanup } = buildRecoveryDeps({
      recoveryCandidates: ['mb-exp'],
      flipResult: false,
      statusSequences: {
        'mb-exp': ['SUBSCRIPTION_EXPIRED', 'SUBSCRIPTION_EXPIRED', 'ACTIVE'],
      },
    });
    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      recoverSubscriptionExpired: true,
    });
    // Safe concurrent-state outcome, no cleanup marker.
    expect(result.outcomes).toEqual([
      { mailboxId: 'mb-exp', outcome: 'skipped_state_changed' },
    ]);
    expect(result.skippedStateChangedCount).toBe(1);
    expect(result.failedCount).toBe(0);
    // The new subscription stays usable: no local expiry, no remote delete.
    expect(repo.markSubscriptionExpired).not.toHaveBeenCalled();
    expect(remoteCleanup.deleteRemoteSubscription).not.toHaveBeenCalled();
    // No second create, no repeated flip, no overwrite of ACTIVE.
    expect(ensure.ensure).toHaveBeenCalledTimes(1);
    expect(repo.markMailboxActiveIfSubscriptionExpired).toHaveBeenCalledTimes(1);
  });

  it('Race E variant: concurrent RECONNECT_REQUIRED → preserve status, cleanup exactly once', async () => {
    const { deps, repo, remoteCleanup } = buildRecoveryDeps({
      recoveryCandidates: ['mb-exp'],
      flipResult: false,
      statusSequences: {
        'mb-exp': [
          'SUBSCRIPTION_EXPIRED',
          'SUBSCRIPTION_EXPIRED',
          'RECONNECT_REQUIRED',
        ],
      },
    });
    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      recoverSubscriptionExpired: true,
    });
    expect(result.outcomes).toEqual([
      {
        mailboxId: 'mb-exp',
        outcome: 'skipped_state_changed',
        remoteCleanup: 'deleted',
      },
    ]);
    // Only the conditional helpers were used — RECONNECT_REQUIRED not touched.
    expect(repo.markSubscriptionExpired).toHaveBeenCalledWith('sub-mb-exp');
    expect(remoteCleanup.deleteRemoteSubscription).toHaveBeenCalledTimes(1);
  });

  it('flip malfunction (status still SUBSCRIPTION_EXPIRED) → fail-safe cleanup, reported failed, no retry', async () => {
    // The flip returned false yet the mailbox still reads SUBSCRIPTION_EXPIRED
    // (e.g. a swallowed write error). No blind ACTIVE flip, no retry; the new
    // subscription must not stay intentionally usable on a non-ACTIVE mailbox.
    const { deps, repo, remoteCleanup } = buildRecoveryDeps({
      recoveryCandidates: ['mb-exp'],
      flipResult: false,
    });
    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      recoverSubscriptionExpired: true,
    });
    expect(result.outcomes).toEqual([
      { mailboxId: 'mb-exp', outcome: 'failed', remoteCleanup: 'deleted' },
    ]);
    expect(result.failedCount).toBe(1);
    expect(result.recoveredCount).toBe(0);
    expect(repo.markMailboxActiveIfSubscriptionExpired).toHaveBeenCalledTimes(1);
    expect(repo.markSubscriptionExpired).toHaveBeenCalledWith('sub-mb-exp');
    expect(remoteCleanup.deleteRemoteSubscription).toHaveBeenCalledTimes(1);
  });

  it('cleanup failure stays bounded and never overwrites operator state', async () => {
    const { deps, repo, remoteCleanup } = buildRecoveryDeps({
      recoveryCandidates: ['mb-exp'],
      flipResult: false,
      cleanupError: new Error('boom'),
      statusSequences: {
        'mb-exp': ['SUBSCRIPTION_EXPIRED', 'SUBSCRIPTION_EXPIRED', 'DISABLED'],
      },
    });
    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      recoverSubscriptionExpired: true,
    });
    // Local fail-safe mark happened FIRST; exactly one remote attempt.
    expect(repo.markSubscriptionExpired).toHaveBeenCalledWith('sub-mb-exp');
    expect(remoteCleanup.deleteRemoteSubscription).toHaveBeenCalledTimes(1);
    expect(result.outcomes[0]?.outcome).toBe('skipped_state_changed');
    expect(result.outcomes[0]?.remoteCleanup).toBe('failed');
    expect(repo.markMailboxActiveIfSubscriptionExpired).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// Batch behaviour & sanitization
// ---------------------------------------------------------------------------

describe('recovery batch behaviour', () => {
  it('processes recovery candidates strictly sequentially', async () => {
    const { deps, ensure } = buildRecoveryDeps({
      recoveryCandidates: ['mb-1', 'mb-2', 'mb-3'],
    });
    let inFlight = 0;
    let maxInFlight = 0;
    ensure.ensure.mockImplementation(async ({ mailboxId }: { mailboxId: string }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return { outcome: 'created' as const, subscriptionId: `sub-${mailboxId}` };
    });
    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      recoverSubscriptionExpired: true,
    });
    expect(result.recoveredCount).toBe(3);
    expect(maxInFlight).toBe(1);
  });

  it('one transient mailbox never breaks the rest of the recovery batch', async () => {
    const { deps, accessToken } = buildRecoveryDeps({
      recoveryCandidates: ['mb-1', 'mb-2', 'mb-3'],
    });
    accessToken.getAccessTokenForMailbox.mockImplementation(
      async (mailboxId: string) => {
        if (mailboxId === 'mb-2') {
          throw new SubscriptionRenewalTokenError('transient', 'HTTP 429');
        }
        return `access-for-${mailboxId}`;
      },
    );
    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      recoverSubscriptionExpired: true,
    });
    expect(outcomesOf(result)).toEqual([
      'recovered',
      'failed_transient',
      'recovered',
    ]);
    expect(accessToken.getAccessTokenForMailbox).toHaveBeenCalledTimes(3);
  });

  it('results and logs stay sanitized in recovery mode', async () => {
    const { deps, logCalls } = buildRecoveryDeps({
      recoveryCandidates: ['mb-exp'],
      flipResult: false,
      cleanupError: new Error('cleanup failed'),
    });
    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      recoverSubscriptionExpired: true,
    });
    const serializedResult = JSON.stringify(result);
    const serializedLogs = JSON.stringify(logCalls);
    for (const forbidden of ['access-for-mb-exp', 'refreshToken', 'clientState']) {
      expect(serializedResult).not.toContain(forbidden);
      expect(serializedLogs).not.toContain(forbidden);
    }
  });
});

// ---------------------------------------------------------------------------
// TASK-086 — recovery must never flip on a concurrency outcome
// ---------------------------------------------------------------------------

describe('TASK-086 — recovery safety on non-creating ensure outcomes', () => {
  it('blocked_renewing → no flip, no cleanup, reported as its own outcome', async () => {
    const { deps, repo, remoteCleanup } = buildRecoveryDeps({
      recoveryCandidates: ['mb-1'],
      ensureOutcome: () => ({ outcome: 'blocked_renewing' }),
    });

    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      recoverSubscriptionExpired: true,
    });

    expect(outcomesOf(result)).toEqual(['blocked_renewing']);
    expect(result.blockedRenewingCount).toBe(1);
    expect(result.recoveredCount).toBe(0);
    expect(repo.markMailboxActiveIfSubscriptionExpired).not.toHaveBeenCalled();
    expect(repo.markSubscriptionExpired).not.toHaveBeenCalled();
    expect(remoteCleanup.deleteRemoteSubscription).not.toHaveBeenCalled();
  });

  it('conflict_existing (Microsoft 409 + local winner) → never flips the mailbox ACTIVE', async () => {
    const { deps, repo, remoteCleanup } = buildRecoveryDeps({
      recoveryCandidates: ['mb-1'],
      ensureOutcome: () => ({ outcome: 'conflict_existing', existingStatus: 'ACTIVE' }),
    });

    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      recoverSubscriptionExpired: true,
    });

    expect(outcomesOf(result)).toEqual(['skipped_existing']);
    expect(result.recoveredCount).toBe(0);
    expect(repo.markMailboxActiveIfSubscriptionExpired).not.toHaveBeenCalled();
    // The winner belongs to someone else — it must not be cleaned up.
    expect(remoteCleanup.deleteRemoteSubscription).not.toHaveBeenCalled();
    expect(repo.markSubscriptionExpired).not.toHaveBeenCalled();
  });

  it('lost_ownership → never flips, never touches the winner', async () => {
    const { deps, repo, remoteCleanup } = buildRecoveryDeps({
      recoveryCandidates: ['mb-1'],
      ensureOutcome: () => ({ outcome: 'lost_ownership', existingStatus: 'ACTIVE' }),
    });

    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      recoverSubscriptionExpired: true,
    });

    expect(outcomesOf(result)).toEqual(['skipped_existing']);
    expect(repo.markMailboxActiveIfSubscriptionExpired).not.toHaveBeenCalled();
    expect(remoteCleanup.deleteRemoteSubscription).not.toHaveBeenCalled();
  });

  it('conflict_unowned → fail-safe failure, no flip, nothing fabricated', async () => {
    const { deps, repo } = buildRecoveryDeps({
      recoveryCandidates: ['mb-1'],
      ensureOutcome: () => ({
        outcome: 'conflict_unowned',
        source: 'remote_conflict',
      }),
    });

    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      recoverSubscriptionExpired: true,
    });

    expect(outcomesOf(result)).toEqual(['failed']);
    expect(result.failedCount).toBe(1);
    expect(result.recoveredCount).toBe(0);
    expect(repo.markMailboxActiveIfSubscriptionExpired).not.toHaveBeenCalled();
  });

  it('a genuine created outcome still recovers the mailbox (no regression)', async () => {
    const { deps, repo } = buildRecoveryDeps({ recoveryCandidates: ['mb-1'] });

    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      recoverSubscriptionExpired: true,
    });

    expect(outcomesOf(result)).toEqual(['recovered']);
    expect(repo.markMailboxActiveIfSubscriptionExpired).toHaveBeenCalledTimes(1);
  });
});
