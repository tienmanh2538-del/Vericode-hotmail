// TASK-082 — Operator-invoked, one-shot Graph subscription reconciliation.
//
// Existing Microsoft mailboxes that connected BEFORE TASK-081 never got a
// Graph subscription at connect time: no webhook path exists for them and they
// live off the delta polling backup alone. This service lets an operator
// reconcile a bounded batch of such mailboxes on demand.
//
// Locked semantics (human-approved, see docs/tasks/TASK-082):
//   - NOT scheduled, NOT wired into any worker, NOT gated by env flags. If the
//     capability is not invoked, nothing runs.
//   - Default mode is DRY-RUN and is strictly non-mutating: it only reads local
//     candidate state. No token refresh, no Graph call, no DB write.
//   - Only an explicit apply invocation mutates, sequentially (concurrency 1),
//     over a bounded batch with a code-level hard maximum (not env-tunable).
//   - Apply reuses the existing production seams and never re-implements them:
//     renewal access-token port (decrypt → refresh → persist rotated credential
//     encrypted-at-rest), TASK-069C classification (already embedded in the
//     port's error kind), and the TASK-081 ensure service (blocking-row
//     re-check immediately before create, 20s timeout, fail-open, compensating
//     DELETE on persist failure).
//
// Disconnect-race ordering per candidate (mandatory):
//   local pre-check (cheap) → token refresh → RE-CHECK mailbox ACTIVE →
//   ensure/provision (its internal findFirst is the potentially-live re-check)
//   → post-create RE-CHECK mailbox ACTIVE; if the mailbox left ACTIVE, the new
//   local row is marked EXPIRED first (fail-safe: webhook and renewal both
//   ignore EXPIRED) and ONE best-effort remote delete is attempted.
//
// This service NEVER logs tokens, refresh credentials, clientState plaintext,
// verification codes, or email bodies. Results carry internal mailbox IDs and
// outcome counters only.

import { createLogger, type Logger } from '@/lib/logger';
import type { EnsureInboxSubscriptionOutcome } from '@/services/microsoft/mailbox-subscription-provisioning.service';

// Bounded batch: a small default so an operator run never storms Graph, and a
// code-level hard ceiling that deliberately is NOT an env variable.
export const DEFAULT_RECONCILIATION_LIMIT = 5;
export const MAX_RECONCILIATION_LIMIT = 20;

const MAILBOX_STATUS_ACTIVE = 'ACTIVE';

// ---------------------------------------------------------------------------
// Ports
// ---------------------------------------------------------------------------

export interface ReconciliationCandidate {
  mailboxId: string;
}

/**
 * Persistence surface. `listReconciliationCandidates` must apply the locked
 * candidate filter (Microsoft + ACTIVE + encrypted credential present + no
 * potentially-live subscription per TASK-081's BLOCKING_SUBSCRIPTION_STATUSES)
 * and is the only method dry-run may call.
 */
export interface SubscriptionReconciliationRepo {
  listReconciliationCandidates(
    limit: number,
    now: Date,
  ): Promise<ReconciliationCandidate[]>;
  getMailboxStatus(mailboxId: string): Promise<string | null>;
  hasBlockingSubscription(mailboxId: string, now: Date): Promise<boolean>;
  /**
   * Conditional mark: flips the mailbox to RECONNECT_REQUIRED only when it is
   * still ACTIVE, so a concurrent disconnect (DISABLED) is never overwritten.
   * Returns true when a row was actually updated.
   */
  markMailboxReconnectRequiredIfActive(mailboxId: string): Promise<boolean>;
  /** Fail-safe local disable of a just-created subscription (disconnect race). */
  markSubscriptionExpired(subscriptionId: string): Promise<void>;
}

/** Same surface as the renewal worker's access-token port (reused directly). */
export interface ReconciliationAccessTokenPort {
  getAccessTokenForMailbox(mailboxId: string): Promise<string>;
}

/** Wraps TASK-081's ensureInboxSubscriptionForConnectedMailbox. Never throws. */
export interface ReconciliationEnsurePort {
  ensure(input: {
    mailboxId: string;
    accessToken: string;
  }): Promise<EnsureInboxSubscriptionOutcome>;
}

/** Best-effort remote delete via the existing deleteGraphSubscription seam. */
export interface ReconciliationRemoteCleanupPort {
  deleteRemoteSubscription(input: {
    mailboxId: string;
    subscriptionId: string;
    accessToken: string;
  }): Promise<void>;
}

export interface SubscriptionReconciliationDeps {
  repo: SubscriptionReconciliationRepo;
  accessToken: ReconciliationAccessTokenPort;
  ensure: ReconciliationEnsurePort;
  remoteCleanup: ReconciliationRemoteCleanupPort;
  logger?: Logger;
  now?: () => Date;
}

// ---------------------------------------------------------------------------
// Options & result
// ---------------------------------------------------------------------------

export type ReconciliationMode = 'dry_run' | 'apply';

export interface SubscriptionReconciliationOptions {
  /** Defaults to dry_run — mutation requires an explicit 'apply'. */
  mode?: ReconciliationMode;
  /** Bounded batch size; clamped to MAX_RECONCILIATION_LIMIT. */
  limit?: number;
}

export type MailboxReconciliationOutcome =
  /** Dry-run only: the mailbox would be provisioned by an apply run. */
  | 'candidate'
  | 'created'
  | 'skipped_existing'
  | 'skipped_not_active'
  | 'reconnect_required'
  | 'failed_transient'
  | 'failed'
  /** Created, then the mailbox left ACTIVE → row EXPIRED + one cleanup try. */
  | 'created_disconnect_cleanup';

export interface MailboxReconciliationRecord {
  mailboxId: string;
  outcome: MailboxReconciliationOutcome;
  /** Only for created_disconnect_cleanup: result of the single remote delete. */
  remoteCleanup?: 'deleted' | 'failed';
}

export interface SubscriptionReconciliationRunResult {
  mode: ReconciliationMode;
  /** The limit actually applied after clamping. */
  limit: number;
  limitClamped: boolean;
  checkedCount: number;
  candidateCount: number;
  createdCount: number;
  skippedExistingCount: number;
  skippedNotActiveCount: number;
  reconnectRequiredCount: number;
  transientFailureCount: number;
  failedCount: number;
  disconnectRaceCount: number;
  /** True when a config-level token failure aborted the whole run. */
  aborted: boolean;
  outcomes: MailboxReconciliationRecord[];
}

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests and the CLI)
// ---------------------------------------------------------------------------

export class ReconciliationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReconciliationValidationError';
  }
}

/**
 * Resolve a requested batch limit: undefined → default; a positive integer is
 * deterministically clamped to the code-level hard maximum; anything else is
 * rejected. Pure, so the CLI and the service enforce identical semantics.
 */
export function resolveReconciliationLimit(requested?: number): {
  limit: number;
  clamped: boolean;
} {
  if (requested === undefined) {
    return { limit: DEFAULT_RECONCILIATION_LIMIT, clamped: false };
  }
  if (!Number.isInteger(requested) || requested < 1) {
    throw new ReconciliationValidationError(
      'limit must be a positive integer',
    );
  }
  if (requested > MAX_RECONCILIATION_LIMIT) {
    return { limit: MAX_RECONCILIATION_LIMIT, clamped: true };
  }
  return { limit: requested, clamped: false };
}

type TokenFailureKind = 'reconnect_required' | 'transient' | 'config';

/**
 * Read the classification off a token-port error (the renewal port throws
 * SubscriptionRenewalTokenError with a TASK-069C-classified `kind`). Duck-typed
 * so the service never depends on a concrete error class; anything
 * unrecognised is treated as transient so an odd error can never brick a
 * mailbox — the same default TASK-069C uses.
 */
export function readTokenFailureKind(error: unknown): TokenFailureKind {
  if (typeof error === 'object' && error !== null && 'kind' in error) {
    const kind = (error as { kind?: unknown }).kind;
    if (kind === 'reconnect_required' || kind === 'config') {
      return kind;
    }
  }
  return 'transient';
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

// ---------------------------------------------------------------------------
// Apply-mode per-mailbox handling
// ---------------------------------------------------------------------------

interface ReconcileContext {
  repo: SubscriptionReconciliationRepo;
  accessToken: ReconciliationAccessTokenPort;
  ensure: ReconciliationEnsurePort;
  remoteCleanup: ReconciliationRemoteCleanupPort;
  logger: Logger;
  now: () => Date;
}

type PerMailboxResult =
  | { record: MailboxReconciliationRecord }
  | { abortRun: true };

async function isMailboxActive(
  ctx: ReconcileContext,
  mailboxId: string,
): Promise<boolean> {
  const status = await ctx.repo.getMailboxStatus(mailboxId);
  return status === MAILBOX_STATUS_ACTIVE;
}

async function acquireAccessToken(
  ctx: ReconcileContext,
  mailboxId: string,
): Promise<{ accessToken: string } | { failure: PerMailboxResult }> {
  try {
    return { accessToken: await ctx.accessToken.getAccessTokenForMailbox(mailboxId) };
  } catch (error) {
    const kind = readTokenFailureKind(error);
    if (kind === 'config') {
      // App-wide misconfiguration: abort the whole run without blaming (or
      // marking) any mailbox — identical to the renewal worker's semantics.
      ctx.logger.error('Reconciliation aborted — token config failure', {
        errorName: safeErrorName(error),
      });
      return { failure: { abortRun: true } };
    }
    if (kind === 'reconnect_required') {
      // Conditional mark: a concurrently disconnected (DISABLED) mailbox must
      // never be resurrected to RECONNECT_REQUIRED.
      const marked = await ctx.repo
        .markMailboxReconnectRequiredIfActive(mailboxId)
        .catch(() => false);
      ctx.logger.warn('Reconciliation: mailbox requires reconnect', {
        mailboxId,
        marked,
      });
      return { failure: { record: { mailboxId, outcome: 'reconnect_required' } } };
    }
    // Transient: no status change, no retry — the operator can simply re-run.
    ctx.logger.warn('Reconciliation: transient token failure — skipping mailbox', {
      mailboxId,
      errorName: safeErrorName(error),
    });
    return { failure: { record: { mailboxId, outcome: 'failed_transient' } } };
  }
}

async function handlePostCreateDisconnectRace(
  ctx: ReconcileContext,
  mailboxId: string,
  subscriptionId: string,
  accessToken: string,
): Promise<MailboxReconciliationRecord> {
  // Fail-safe local state FIRST (TASK-052 ordering): an EXPIRED row is inert
  // for the webhook (ACTIVE/RENEWING only) and the renewal worker
  // (ACTIVE/RENEWING/FAILED only), so even a failed remote cleanup cannot make
  // this subscription usable.
  try {
    await ctx.repo.markSubscriptionExpired(subscriptionId);
  } catch {
    ctx.logger.warn('Reconciliation: could not mark raced subscription expired', {
      mailboxId,
    });
  }
  // Exactly one best-effort remote delete — never retried.
  try {
    await ctx.remoteCleanup.deleteRemoteSubscription({
      mailboxId,
      subscriptionId,
      accessToken,
    });
    return {
      mailboxId,
      outcome: 'created_disconnect_cleanup',
      remoteCleanup: 'deleted',
    };
  } catch (error) {
    ctx.logger.warn('Reconciliation: remote cleanup after disconnect race failed', {
      mailboxId,
      errorName: safeErrorName(error),
    });
    return {
      mailboxId,
      outcome: 'created_disconnect_cleanup',
      remoteCleanup: 'failed',
    };
  }
}

/**
 * Reconcile one candidate following the mandatory disconnect-race ordering.
 * Never throws for mailbox-level failures; a config-level token failure
 * requests a run abort.
 */
async function reconcileOneMailbox(
  ctx: ReconcileContext,
  mailboxId: string,
): Promise<PerMailboxResult> {
  // Local pre-check before spending a token refresh: skip mailboxes that left
  // ACTIVE or gained a potentially-live subscription since candidate selection.
  if (!(await isMailboxActive(ctx, mailboxId))) {
    return { record: { mailboxId, outcome: 'skipped_not_active' } };
  }
  if (await ctx.repo.hasBlockingSubscription(mailboxId, ctx.now())) {
    return { record: { mailboxId, outcome: 'skipped_existing' } };
  }

  const token = await acquireAccessToken(ctx, mailboxId);
  if ('failure' in token) {
    return token.failure;
  }

  // Mandatory RE-CHECK after the token refresh and before any Graph create: a
  // disconnect during the refresh must stop provisioning here.
  if (!(await isMailboxActive(ctx, mailboxId))) {
    return { record: { mailboxId, outcome: 'skipped_not_active' } };
  }

  // The ensure seam performs the potentially-live (blocking-row) re-check via
  // its own findFirst immediately before the Graph POST — reused, not
  // duplicated. It never throws (fail-open) and compensates internally when
  // the remote create succeeds but the local persist fails.
  const ensured = await ctx.ensure.ensure({
    mailboxId,
    accessToken: token.accessToken,
  });

  if (ensured.outcome === 'skipped_existing') {
    return { record: { mailboxId, outcome: 'skipped_existing' } };
  }
  if (ensured.outcome === 'failed') {
    return { record: { mailboxId, outcome: 'failed' } };
  }

  // Created: post-provision RE-CHECK. If the mailbox left ACTIVE while the
  // remote create was in flight, make the new row non-usable and clean up.
  if (!(await isMailboxActive(ctx, mailboxId))) {
    return {
      record: await handlePostCreateDisconnectRace(
        ctx,
        mailboxId,
        ensured.subscriptionId,
        token.accessToken,
      ),
    };
  }
  return { record: { mailboxId, outcome: 'created' } };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

function countOutcome(
  result: SubscriptionReconciliationRunResult,
  record: MailboxReconciliationRecord,
): void {
  result.outcomes.push(record);
  switch (record.outcome) {
    case 'candidate':
      break;
    case 'created':
      result.createdCount += 1;
      break;
    case 'skipped_existing':
      result.skippedExistingCount += 1;
      break;
    case 'skipped_not_active':
      result.skippedNotActiveCount += 1;
      break;
    case 'reconnect_required':
      result.reconnectRequiredCount += 1;
      break;
    case 'failed_transient':
      result.transientFailureCount += 1;
      break;
    case 'created_disconnect_cleanup':
      result.createdCount += 1;
      result.disconnectRaceCount += 1;
      break;
    default:
      result.failedCount += 1;
      break;
  }
}

/**
 * Run one reconciliation pass. Dry-run (the default) only reads candidate
 * state; apply processes candidates strictly sequentially. Mailbox-level
 * failures never abort the batch; only a config-level token failure does.
 */
export async function runSubscriptionReconciliationOnce(
  deps: SubscriptionReconciliationDeps,
  options: SubscriptionReconciliationOptions = {},
): Promise<SubscriptionReconciliationRunResult> {
  const logger = deps.logger ?? createLogger();
  const now = deps.now ?? (() => new Date());
  const mode: ReconciliationMode = options.mode === 'apply' ? 'apply' : 'dry_run';
  const { limit, clamped } = resolveReconciliationLimit(options.limit);

  const result: SubscriptionReconciliationRunResult = {
    mode,
    limit,
    limitClamped: clamped,
    checkedCount: 0,
    candidateCount: 0,
    createdCount: 0,
    skippedExistingCount: 0,
    skippedNotActiveCount: 0,
    reconnectRequiredCount: 0,
    transientFailureCount: 0,
    failedCount: 0,
    disconnectRaceCount: 0,
    aborted: false,
    outcomes: [],
  };

  let candidates: ReconciliationCandidate[];
  try {
    candidates = await deps.repo.listReconciliationCandidates(limit, now());
  } catch (error) {
    logger.error('Reconciliation failed to list candidates', {
      errorName: safeErrorName(error),
    });
    result.aborted = true;
    return result;
  }
  result.candidateCount = candidates.length;

  logger.info('Subscription reconciliation started', {
    mode,
    limit,
    candidateCount: candidates.length,
  });

  if (mode === 'dry_run') {
    // Strictly non-mutating: candidates are reported, nothing else runs — no
    // token refresh, no Graph call, no write, no persistent audit.
    for (const candidate of candidates) {
      result.checkedCount += 1;
      countOutcome(result, {
        mailboxId: candidate.mailboxId,
        outcome: 'candidate',
      });
    }
    logger.info('Subscription reconciliation dry-run finished', {
      candidateCount: result.candidateCount,
    });
    return result;
  }

  const ctx: ReconcileContext = {
    repo: deps.repo,
    accessToken: deps.accessToken,
    ensure: deps.ensure,
    remoteCleanup: deps.remoteCleanup,
    logger,
    now,
  };

  // Strictly sequential — concurrency 1 by construction; each candidate is
  // fully awaited before the next starts and there is no concurrency option.
  for (const candidate of candidates) {
    result.checkedCount += 1;
    try {
      const outcome = await reconcileOneMailbox(ctx, candidate.mailboxId);
      if ('abortRun' in outcome) {
        result.aborted = true;
        break;
      }
      countOutcome(result, outcome.record);
    } catch (error) {
      // Defensive backstop: one bad mailbox must never break the batch.
      countOutcome(result, { mailboxId: candidate.mailboxId, outcome: 'failed' });
      logger.warn('Reconciliation raised unexpectedly for mailbox', {
        mailboxId: candidate.mailboxId,
        errorName: safeErrorName(error),
      });
    }
  }

  logger.info('Subscription reconciliation finished', {
    mode,
    checkedCount: result.checkedCount,
    createdCount: result.createdCount,
    skippedExistingCount: result.skippedExistingCount,
    skippedNotActiveCount: result.skippedNotActiveCount,
    reconnectRequiredCount: result.reconnectRequiredCount,
    transientFailureCount: result.transientFailureCount,
    failedCount: result.failedCount,
    disconnectRaceCount: result.disconnectRaceCount,
    aborted: result.aborted,
  });
  return result;
}
