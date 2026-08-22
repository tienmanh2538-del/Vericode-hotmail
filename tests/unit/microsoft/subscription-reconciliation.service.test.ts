// TASK-082 — Subscription reconciliation service tests.
//
// Covers the locked invocation-safety contract (dry-run default and strictly
// non-mutating), apply-mode sequencing, TASK-069C-aligned token semantics, and
// the mandatory disconnect-race (TOCTOU) orderings. The Microsoft boundary is
// always faked — no real Graph call, no real secret.

import { describe, it, expect, vi } from 'vitest';

import {
  DEFAULT_RECONCILIATION_LIMIT,
  MAX_RECONCILIATION_LIMIT,
  ReconciliationValidationError,
  readTokenFailureKind,
  resolveReconciliationLimit,
  runSubscriptionReconciliationOnce,
  type MailboxReconciliationOutcome,
  type SubscriptionReconciliationDeps,
} from '@/services/microsoft/subscription-reconciliation.service';
import { ensureInboxSubscriptionForConnectedMailbox } from '@/services/microsoft/mailbox-subscription-provisioning.service';
import { SubscriptionRenewalTokenError } from '@/services/microsoft/subscription-renewal.service';

const NOW = new Date('2026-08-22T10:00:00.000Z');

interface FakeDepsOptions {
  candidates?: string[];
  /** Per-mailbox status sequence consumed by getMailboxStatus calls. */
  statusSequences?: Record<string, string[]>;
  blocking?: Record<string, boolean>;
  tokenError?: unknown;
  ensureOutcome?: (mailboxId: string) =>
    | { outcome: 'created'; subscriptionId: string }
    | { outcome: 'skipped_existing'; existingStatus: 'ACTIVE' }
    | { outcome: 'failed'; errorName: string };
  cleanupError?: Error;
}

function buildFakeDeps(options: FakeDepsOptions = {}) {
  const statusSequences = new Map<string, string[]>(
    Object.entries(options.statusSequences ?? {}),
  );
  const repo = {
    listReconciliationCandidates: vi.fn(async (limit: number) =>
      (options.candidates ?? []).slice(0, limit).map((mailboxId) => ({ mailboxId })),
    ),
    getMailboxStatus: vi.fn(async (mailboxId: string) => {
      const sequence = statusSequences.get(mailboxId);
      if (sequence && sequence.length > 0) {
        return sequence.length > 1 ? (sequence.shift() as string) : sequence[0];
      }
      return 'ACTIVE';
    }),
    hasBlockingSubscription: vi.fn(
      async (mailboxId: string) => options.blocking?.[mailboxId] ?? false,
    ),
    markMailboxReconnectRequiredIfActive: vi.fn(async () => true),
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

function outcomesOf(result: { outcomes: Array<{ outcome: MailboxReconciliationOutcome }> }) {
  return result.outcomes.map((record) => record.outcome);
}

// ---------------------------------------------------------------------------
// Limit resolution
// ---------------------------------------------------------------------------

describe('resolveReconciliationLimit', () => {
  it('defaults to the small bounded batch size', () => {
    expect(resolveReconciliationLimit()).toEqual({
      limit: DEFAULT_RECONCILIATION_LIMIT,
      clamped: false,
    });
  });

  it('deterministically clamps values above the code-level hard maximum', () => {
    expect(resolveReconciliationLimit(1_000)).toEqual({
      limit: MAX_RECONCILIATION_LIMIT,
      clamped: true,
    });
    expect(resolveReconciliationLimit(MAX_RECONCILIATION_LIMIT)).toEqual({
      limit: MAX_RECONCILIATION_LIMIT,
      clamped: false,
    });
  });

  it('rejects non-positive and non-integer limits', () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => resolveReconciliationLimit(bad)).toThrow(
        ReconciliationValidationError,
      );
    }
  });
});

describe('readTokenFailureKind', () => {
  it('reads reconnect_required and config kinds, defaulting everything else to transient', () => {
    expect(
      readTokenFailureKind(new SubscriptionRenewalTokenError('reconnect_required', 'x')),
    ).toBe('reconnect_required');
    expect(
      readTokenFailureKind(new SubscriptionRenewalTokenError('config', 'x')),
    ).toBe('config');
    expect(
      readTokenFailureKind(new SubscriptionRenewalTokenError('transient', 'x')),
    ).toBe('transient');
    expect(readTokenFailureKind(new Error('mystery'))).toBe('transient');
    expect(readTokenFailureKind(null)).toBe('transient');
  });
});

// ---------------------------------------------------------------------------
// Invocation safety — dry-run default, strictly non-mutating
// ---------------------------------------------------------------------------

describe('runSubscriptionReconciliationOnce — invocation safety', () => {
  it('defaults to dry-run when no mode is given', async () => {
    const { deps } = buildFakeDeps({ candidates: ['mb-1', 'mb-2'] });
    const result = await runSubscriptionReconciliationOnce(deps);
    expect(result.mode).toBe('dry_run');
    expect(result.candidateCount).toBe(2);
    expect(outcomesOf(result)).toEqual(['candidate', 'candidate']);
  });

  it('dry-run never refreshes tokens', async () => {
    const { deps, accessToken } = buildFakeDeps({ candidates: ['mb-1'] });
    await runSubscriptionReconciliationOnce(deps, { mode: 'dry_run' });
    expect(accessToken.getAccessTokenForMailbox).not.toHaveBeenCalled();
  });

  it('dry-run never calls Graph create or delete', async () => {
    const { deps, ensure, remoteCleanup } = buildFakeDeps({ candidates: ['mb-1'] });
    await runSubscriptionReconciliationOnce(deps);
    expect(ensure.ensure).not.toHaveBeenCalled();
    expect(remoteCleanup.deleteRemoteSubscription).not.toHaveBeenCalled();
  });

  it('dry-run performs no database writes — only the candidate read runs', async () => {
    const { deps, repo } = buildFakeDeps({ candidates: ['mb-1'] });
    await runSubscriptionReconciliationOnce(deps);
    expect(repo.listReconciliationCandidates).toHaveBeenCalledTimes(1);
    expect(repo.getMailboxStatus).not.toHaveBeenCalled();
    expect(repo.hasBlockingSubscription).not.toHaveBeenCalled();
    expect(repo.markMailboxReconnectRequiredIfActive).not.toHaveBeenCalled();
    expect(repo.markSubscriptionExpired).not.toHaveBeenCalled();
  });

  it('only explicit apply reaches the mutation path', async () => {
    const { deps, ensure } = buildFakeDeps({ candidates: ['mb-1'] });
    const result = await runSubscriptionReconciliationOnce(deps, { mode: 'apply' });
    expect(ensure.ensure).toHaveBeenCalledTimes(1);
    expect(result.createdCount).toBe(1);
    expect(outcomesOf(result)).toEqual(['created']);
  });

  it('enforces the batch limit on candidate discovery', async () => {
    const { deps, repo } = buildFakeDeps({
      candidates: ['mb-1', 'mb-2', 'mb-3', 'mb-4'],
    });
    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'apply',
      limit: 2,
    });
    expect(repo.listReconciliationCandidates).toHaveBeenCalledWith(2, NOW);
    expect(result.checkedCount).toBe(2);
  });

  it('clamps an over-maximum limit deterministically and rejects invalid limits', async () => {
    const { deps, repo } = buildFakeDeps({ candidates: [] });
    const result = await runSubscriptionReconciliationOnce(deps, {
      mode: 'dry_run',
      limit: 999,
    });
    expect(result.limit).toBe(MAX_RECONCILIATION_LIMIT);
    expect(result.limitClamped).toBe(true);
    expect(repo.listReconciliationCandidates).toHaveBeenCalledWith(
      MAX_RECONCILIATION_LIMIT,
      NOW,
    );

    await expect(
      runSubscriptionReconciliationOnce(deps, { limit: 0 }),
    ).rejects.toBeInstanceOf(ReconciliationValidationError);
  });

  it('processes mailboxes strictly sequentially — max in-flight is 1', async () => {
    const { deps, ensure } = buildFakeDeps({ candidates: ['mb-1', 'mb-2', 'mb-3'] });
    let inFlight = 0;
    let maxInFlight = 0;
    ensure.ensure.mockImplementation(async ({ mailboxId }: { mailboxId: string }) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      // Yield so any (incorrect) concurrent processing would interleave here.
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return { outcome: 'created' as const, subscriptionId: `sub-${mailboxId}` };
    });
    const result = await runSubscriptionReconciliationOnce(deps, { mode: 'apply' });
    expect(result.createdCount).toBe(3);
    expect(maxInFlight).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Apply-mode candidate no-op semantics (blocking subscriptions)
// ---------------------------------------------------------------------------

describe('runSubscriptionReconciliationOnce — no-op on potentially-live subscriptions', () => {
  it('skips without a token refresh when a blocking subscription appears after selection', async () => {
    const { deps, accessToken, ensure } = buildFakeDeps({
      candidates: ['mb-1'],
      blocking: { 'mb-1': true },
    });
    const result = await runSubscriptionReconciliationOnce(deps, { mode: 'apply' });
    expect(outcomesOf(result)).toEqual(['skipped_existing']);
    expect(accessToken.getAccessTokenForMailbox).not.toHaveBeenCalled();
    expect(ensure.ensure).not.toHaveBeenCalled();
  });

  it('counts an ensure-level skipped_existing as a no-op, never a create', async () => {
    const { deps } = buildFakeDeps({
      candidates: ['mb-1'],
      ensureOutcome: () => ({ outcome: 'skipped_existing', existingStatus: 'ACTIVE' }),
    });
    const result = await runSubscriptionReconciliationOnce(deps, { mode: 'apply' });
    expect(result.skippedExistingCount).toBe(1);
    expect(result.createdCount).toBe(0);
  });

  it('never blind-creates when the TASK-081 ensure seam sees a live row (real ensure)', async () => {
    // Wire the REAL ensure service as the port: a blocking row exists locally,
    // so the potentially-live re-check inside the seam must prevent any create.
    const createSpy = vi.fn();
    const fakePrisma = {
      graphSubscription: {
        findFirst: vi.fn(async () => ({
          subscriptionId: 'sub-live',
          status: 'RENEWING' as const,
          expirationDateTime: new Date(NOW.getTime() + 60_000),
        })),
      },
    };
    const { deps } = buildFakeDeps({ candidates: ['mb-1'] });
    deps.ensure = {
      ensure: (input) =>
        ensureInboxSubscriptionForConnectedMailbox(input, {
          prisma: fakePrisma,
          createSubscription: createSpy,
          now: () => NOW,
        }),
    };
    const result = await runSubscriptionReconciliationOnce(deps, { mode: 'apply' });
    expect(createSpy).not.toHaveBeenCalled();
    expect(result.skippedExistingCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Token semantics (TASK-069C reuse)
// ---------------------------------------------------------------------------

describe('runSubscriptionReconciliationOnce — token failure semantics', () => {
  it('reconnect_required marks the mailbox via the conditional path and skips creation', async () => {
    const { deps, repo, ensure } = buildFakeDeps({
      candidates: ['mb-1'],
      tokenError: new SubscriptionRenewalTokenError('reconnect_required', 'revoked'),
    });
    const result = await runSubscriptionReconciliationOnce(deps, { mode: 'apply' });
    expect(repo.markMailboxReconnectRequiredIfActive).toHaveBeenCalledWith('mb-1');
    expect(ensure.ensure).not.toHaveBeenCalled();
    expect(result.reconnectRequiredCount).toBe(1);
  });

  it('a concurrent disconnect is never overwritten — the conditional mark may decline', async () => {
    const { deps, repo } = buildFakeDeps({
      candidates: ['mb-1'],
      tokenError: new SubscriptionRenewalTokenError('reconnect_required', 'revoked'),
    });
    repo.markMailboxReconnectRequiredIfActive.mockResolvedValue(false);
    const result = await runSubscriptionReconciliationOnce(deps, { mode: 'apply' });
    // Only the conditional helper was used — there is no unconditional write
    // that could resurrect a DISABLED mailbox.
    expect(repo.markMailboxReconnectRequiredIfActive).toHaveBeenCalledTimes(1);
    expect(result.reconnectRequiredCount).toBe(1);
  });

  it('transient failures never flip mailbox status and are attempted exactly once', async () => {
    const { deps, repo, accessToken } = buildFakeDeps({
      candidates: ['mb-1'],
      tokenError: new SubscriptionRenewalTokenError('transient', 'HTTP 503'),
    });
    const result = await runSubscriptionReconciliationOnce(deps, { mode: 'apply' });
    expect(result.transientFailureCount).toBe(1);
    expect(repo.markMailboxReconnectRequiredIfActive).not.toHaveBeenCalled();
    expect(accessToken.getAccessTokenForMailbox).toHaveBeenCalledTimes(1);
  });

  it('a config failure aborts the whole run without blaming any mailbox', async () => {
    const { deps, repo } = buildFakeDeps({
      candidates: ['mb-1', 'mb-2'],
      tokenError: new SubscriptionRenewalTokenError('config', 'OAuth unset'),
    });
    const result = await runSubscriptionReconciliationOnce(deps, { mode: 'apply' });
    expect(result.aborted).toBe(true);
    expect(result.reconnectRequiredCount).toBe(0);
    expect(repo.markMailboxReconnectRequiredIfActive).not.toHaveBeenCalled();
    // Aborted on the first mailbox — the second is never touched.
    expect(result.checkedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// TOCTOU / disconnect race
// ---------------------------------------------------------------------------

describe('runSubscriptionReconciliationOnce — disconnect race protection', () => {
  it('never calls Graph create when the mailbox leaves ACTIVE before provisioning', async () => {
    const { deps, ensure } = buildFakeDeps({
      candidates: ['mb-1'],
      // Pre-token check sees ACTIVE; the mandatory post-token re-check sees
      // the concurrent disconnect.
      statusSequences: { 'mb-1': ['ACTIVE', 'DISABLED'] },
    });
    const result = await runSubscriptionReconciliationOnce(deps, { mode: 'apply' });
    expect(ensure.ensure).not.toHaveBeenCalled();
    expect(result.skippedNotActiveCount).toBe(1);
  });

  it('makes the new local row non-usable when the mailbox leaves ACTIVE after create', async () => {
    const { deps, repo } = buildFakeDeps({
      candidates: ['mb-1'],
      statusSequences: { 'mb-1': ['ACTIVE', 'ACTIVE', 'DISABLED'] },
    });
    const result = await runSubscriptionReconciliationOnce(deps, { mode: 'apply' });
    expect(repo.markSubscriptionExpired).toHaveBeenCalledWith('sub-mb-1');
    expect(result.disconnectRaceCount).toBe(1);
    expect(outcomesOf(result)).toEqual(['created_disconnect_cleanup']);
  });

  it('attempts exactly one best-effort remote cleanup after a post-create disconnect', async () => {
    const { deps, remoteCleanup } = buildFakeDeps({
      candidates: ['mb-1'],
      statusSequences: { 'mb-1': ['ACTIVE', 'ACTIVE', 'DISABLED'] },
    });
    const result = await runSubscriptionReconciliationOnce(deps, { mode: 'apply' });
    expect(remoteCleanup.deleteRemoteSubscription).toHaveBeenCalledTimes(1);
    expect(remoteCleanup.deleteRemoteSubscription).toHaveBeenCalledWith({
      mailboxId: 'mb-1',
      subscriptionId: 'sub-mb-1',
      accessToken: 'access-for-mb-1',
    });
    expect(result.outcomes[0]?.remoteCleanup).toBe('deleted');
  });

  it('stays fail-safe when the remote cleanup itself fails — no retry loop', async () => {
    const { deps, repo, remoteCleanup } = buildFakeDeps({
      candidates: ['mb-1'],
      statusSequences: { 'mb-1': ['ACTIVE', 'ACTIVE', 'DISABLED'] },
      cleanupError: new Error('boom'),
    });
    const result = await runSubscriptionReconciliationOnce(deps, { mode: 'apply' });
    // Local fail-safe state was written FIRST, so the row is inert regardless.
    expect(repo.markSubscriptionExpired).toHaveBeenCalledWith('sub-mb-1');
    expect(remoteCleanup.deleteRemoteSubscription).toHaveBeenCalledTimes(1);
    expect(result.outcomes[0]?.remoteCleanup).toBe('failed');
    expect(result.disconnectRaceCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Batch isolation & sanitization
// ---------------------------------------------------------------------------

describe('runSubscriptionReconciliationOnce — batch isolation and sanitization', () => {
  it('a transient failure on one mailbox never breaks the rest of the batch', async () => {
    const { deps, accessToken } = buildFakeDeps({
      candidates: ['mb-1', 'mb-2', 'mb-3'],
    });
    accessToken.getAccessTokenForMailbox.mockImplementation(
      async (mailboxId: string) => {
        if (mailboxId === 'mb-2') {
          throw new SubscriptionRenewalTokenError('transient', 'HTTP 429');
        }
        return `access-for-${mailboxId}`;
      },
    );
    const result = await runSubscriptionReconciliationOnce(deps, { mode: 'apply' });
    expect(outcomesOf(result)).toEqual(['created', 'failed_transient', 'created']);
    // One attempt per mailbox — no retry loop anywhere.
    expect(accessToken.getAccessTokenForMailbox).toHaveBeenCalledTimes(3);
  });

  it('an unexpected per-mailbox error is contained as failed and the batch continues', async () => {
    const { deps, repo } = buildFakeDeps({ candidates: ['mb-1', 'mb-2'] });
    repo.getMailboxStatus.mockImplementationOnce(async () => {
      throw new Error('db blip');
    });
    const result = await runSubscriptionReconciliationOnce(deps, { mode: 'apply' });
    expect(outcomesOf(result)).toEqual(['failed', 'created']);
  });

  it('results and logs stay sanitized — no token value, no secret-like content', async () => {
    const { deps, logCalls } = buildFakeDeps({
      candidates: ['mb-1'],
      statusSequences: { 'mb-1': ['ACTIVE', 'ACTIVE', 'DISABLED'] },
      cleanupError: new Error('cleanup failed'),
    });
    const result = await runSubscriptionReconciliationOnce(deps, { mode: 'apply' });

    const serializedResult = JSON.stringify(result);
    const serializedLogs = JSON.stringify(logCalls);
    for (const forbidden of ['access-for-mb-1', 'refreshToken', 'clientState']) {
      expect(serializedResult).not.toContain(forbidden);
      expect(serializedLogs).not.toContain(forbidden);
    }
    // Outcome records expose internal IDs and outcome markers only.
    expect(Object.keys(result.outcomes[0] ?? {}).sort()).toEqual([
      'mailboxId',
      'outcome',
      'remoteCleanup',
    ]);
  });
});
