// TASK-032 — Microsoft Graph subscription renewal worker (service layer).
//
// Architecture:
//   scheduler tick (every ~15–30 min) →
//     list renewable GraphSubscriptions →
//     for each due (<= 24h) subscription:
//       get access token → PATCH /subscriptions/{id} (now + 6 days) →
//       persist new expiration / status ACTIVE / lastRenewedAt →
//       audit SUBSCRIPTION_RENEWED.
//
// This service is the ORCHESTRATION layer. The actual Graph PATCH + DB write is
// delegated to a `RenewSubscriptionPort` (default wired to the existing
// `renewGraphSubscription` from graph-subscription.service.ts). The service
// never re-implements the PATCH and never opens its own Prisma/HTTP handles —
// every side effect is an injected port so the whole flow is unit-testable.
//
// This service NEVER:
//   - logs access tokens, refresh tokens, encryptedRefreshToken, client secrets
//   - reads / writes .env or .env.local
//   - sends Telegram, runs the detector / extractor / email pipeline
//   - mutates clientState / clientStateHash / resource / changeType
//
// Per-subscription errors are isolated: a single failing mailbox is recorded
// and the batch continues. Transient Graph errors (429/5xx/network) are retried
// a bounded number of times; auth/revoke errors map the mailbox to
// RECONNECT_REQUIRED; 404/410 (subscription gone) marks SUBSCRIPTION_EXPIRED.

import { createLogger, type Logger } from '@/lib/logger';

// Renew when the subscription expires within this window. The spec calls for
// "<= 24 hours"; a scheduler running every 15–30 min comfortably catches every
// subscription before it crosses this line.
const DEFAULT_RENEW_WINDOW_MS = 24 * 60 * 60 * 1000;

// Bounded retry for transient Graph failures (429 / 5xx / network). Kept small:
// the next scheduler tick is the real backstop, so we never want one mailbox to
// monopolize a batch.
const DEFAULT_MAX_RENEW_ATTEMPTS = 3;
const DEFAULT_RETRY_BASE_DELAY_MS = 500;

const MAILBOX_STATUS_DISABLED = 'DISABLED';

// ---------------------------------------------------------------------------
// Public types & ports
// ---------------------------------------------------------------------------

/**
 * A candidate row joined with just enough mailbox context to decide whether it
 * should be renewed. The repo may pre-filter in SQL for efficiency, but the
 * service re-validates every field here so selection logic stays testable
 * without a database.
 */
export interface RenewableSubscriptionCandidate {
  /** GraphSubscription primary key. */
  id: string;
  mailboxId: string;
  /** Microsoft subscription id used in the PATCH URL. May be missing/blank. */
  subscriptionId: string | null;
  /** For masked ops logging only — never logged in full. */
  emailAddress: string;
  /** Mailbox status; DISABLED mailboxes are skipped. */
  mailboxStatus: string;
  expirationDateTime: Date;
}

export type RenewalDecision = 'renew' | 'skip' | 'expired' | 'invalid';

/**
 * TASK-084 — the outcome of an atomic claim attempt on a GraphSubscription row.
 * `claimed` is true only when this operation won the row (affected count = 1).
 * `claimGeneration` is the exact `updatedAt` the claim wrote, read back and held
 * as the CAS ownership token for every subsequent completion write. It is null
 * whenever the claim was lost. `reclaimedStale` is observability only — true when
 * the won row was a stale RENEWING reclaim rather than a fresh ACTIVE/FAILED one.
 */
export interface SubscriptionClaim {
  claimed: boolean;
  claimGeneration: Date | null;
  reclaimedStale: boolean;
}

/**
 * Persistence surface — supplied by a Prisma-backed adapter in production.
 *
 * TASK-084 — every write is an atomic claim (affected count = 1 to win) or a CAS
 * completion (only the current claim owner, matched on the exact claim
 * generation, may write). Mailbox lifecycle writers are conditional and only
 * ever run AFTER the subscription-level CAS proved ownership (count = 1).
 */
export interface SubscriptionRenewalRepo {
  listRenewableCandidates(): Promise<RenewableSubscriptionCandidate[]>;
  /**
   * Atomically claim a subscription for renewal: ACTIVE / FAILED / stale-RENEWING
   * → RENEWING. Wins only when affected count = 1. Fresh RENEWING is never
   * claimed. On a win, returns the exact written `updatedAt` as `claimGeneration`.
   */
  claimForRenewal(subscriptionId: string, now: Date): Promise<SubscriptionClaim>;
  /**
   * CAS success completion. Only writes when the row is still RENEWING with the
   * exact claim generation. Returns true when this operation still owned the row.
   */
  markRenewedIfOwner(input: {
    subscriptionId: string;
    claimGeneration: Date;
    newExpirationDateTime: Date;
    now: Date;
  }): Promise<boolean>;
  /** CAS failure completion → FAILED. Returns ownership (count = 1). */
  markSubscriptionFailedIfOwner(
    subscriptionId: string,
    claimGeneration: Date,
  ): Promise<boolean>;
  /** CAS 404/410 completion → EXPIRED. Returns ownership (count = 1). */
  markSubscriptionExpiredIfOwner(
    subscriptionId: string,
    claimGeneration: Date,
  ): Promise<boolean>;
  /**
   * Relation-aware mailbox writer (TASK-083 protection). ACTIVE →
   * SUBSCRIPTION_EXPIRED only when NO OTHER possibly-live GraphSubscription
   * exists (TASK-081/082 semantics), excluding the failing row itself. Returns
   * true when the mailbox was actually transitioned.
   */
  markMailboxSubscriptionExpiredIfNoOtherLiveSubscription(input: {
    mailboxId: string;
    failingSubscriptionRowId: string;
    now: Date;
  }): Promise<boolean>;
  /**
   * Credential-generation-guarded mailbox writer (TASK-084 correction B). Marks
   * RECONNECT_REQUIRED only when the mailbox is not DISABLED AND its stored
   * credential generation still equals the one this operation used — so a stale
   * pre-reconnect renewal can never overwrite a freshly OAuth-reconnected mailbox.
   * `credentialGeneration` is an OPAQUE marker (never logged/decrypted).
   */
  markMailboxReconnectRequiredIfCredentialCurrent(
    mailboxId: string,
    credentialGeneration: string | null,
  ): Promise<boolean>;
}

/**
 * Access-token surface. Implementations decrypt + exchange the refresh token and
 * also report the mailbox credential generation the operation committed to (the
 * opaque `encryptedRefreshToken` marker) so the reconnect-required writer can
 * prove the failure belongs to the CURRENT credential (TASK-084 correction B).
 */
export interface RenewalCredential {
  accessToken: string;
  credentialGeneration: string | null;
}

export interface RenewalAccessTokenPort {
  getAccessTokenForMailbox(mailboxId: string): Promise<RenewalCredential>;
}

/**
 * Performs the Graph PATCH + DB persistence for a single subscription. The
 * default production wiring delegates to `renewGraphSubscription`. Errors must
 * be thrown so the service can classify them (see {@link classifyRenewError}).
 */
export interface RenewSubscriptionPort {
  renew(input: {
    mailboxId: string;
    subscriptionId: string;
    accessToken: string;
    now: Date;
  }): Promise<{ newExpirationDateTime: Date }>;
}

/** Audit surface — default wired to the in-memory audit log service. */
export interface RenewalAuditPort {
  recordRenewed(input: {
    mailboxId: string;
    graphSubscriptionId: string;
    oldExpirationDateTime: Date;
    newExpirationDateTime: Date;
  }): void | Promise<void>;
}

export interface SubscriptionRenewalDeps {
  repo: SubscriptionRenewalRepo;
  accessToken: RenewalAccessTokenPort;
  renew: RenewSubscriptionPort;
  audit?: RenewalAuditPort;
  logger?: Logger;
  now?: () => Date;
  /** Renew when expiration is within this many ms. Defaults to 24h. */
  renewWithinMs?: number;
  /** Max attempts per subscription on transient errors. Defaults to 3. */
  maxRenewAttempts?: number;
  /** Override the inter-retry delay (tests inject a no-op). */
  sleep?: (ms: number) => Promise<void>;
}

export interface SubscriptionRenewalRunResult {
  checkedCount: number;
  renewedCount: number;
  skippedCount: number;
  failedCount: number;
  reconnectRequiredCount: number;
  expiredCount: number;
  // TASK-084 — concurrency-guard observability (K). `claimLostCount` counts
  // subscriptions this run skipped because another worker owned the claim (or a
  // completion CAS found ownership lost); `staleReclaimedCount` counts rows won
  // by reclaiming a stale RENEWING generation.
  claimLostCount: number;
  staleReclaimedCount: number;
}

export type RenewalTokenErrorKind = 'reconnect_required' | 'transient' | 'config';

/**
 * Thrown by {@link RenewalAccessTokenPort} implementations. `reconnect_required`
 * means the refresh token is revoked/invalid (invalid_grant) and the mailbox
 * must be reconnected by a human; `transient` is retryable; `config` is a setup
 * problem that affects every mailbox equally.
 */
export class SubscriptionRenewalTokenError extends Error {
  readonly kind: RenewalTokenErrorKind;
  // TASK-084 — for a `reconnect_required` failure raised BEFORE a successful
  // token exchange (Case A), this carries the mailbox credential generation the
  // operation read at the start, so the reconnect-required writer can guard on it
  // and never overwrite a concurrently OAuth-reconnected mailbox. Opaque marker;
  // null when there was no stored credential. Irrelevant for transient/config.
  readonly credentialGeneration: string | null;
  constructor(
    kind: RenewalTokenErrorKind,
    message: string,
    credentialGeneration: string | null = null,
  ) {
    super(message);
    this.name = 'SubscriptionRenewalTokenError';
    this.kind = kind;
    this.credentialGeneration = credentialGeneration;
  }
}

type RenewFailureKind = 'reconnect_required' | 'expired' | 'transient' | 'fatal';

// ---------------------------------------------------------------------------
// Pure helpers (exported for unit tests)
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Mask the email address in a way safe for ops logs. */
export function maskEmail(emailAddress: string): string {
  const at = emailAddress.indexOf('@');
  if (at <= 0) return '***';
  const local = emailAddress.slice(0, at);
  const domain = emailAddress.slice(at + 1);
  const localMasked =
    local.length <= 2 ? '••' : `${local.slice(0, 1)}••${local.slice(-1)}`;
  return `${localMasked}@${domain}`;
}

/**
 * Decide what to do with a candidate. Pure and side-effect free so every
 * selection case (skip / renew / expired / invalid) is unit-testable.
 */
export function classifySubscription(
  candidate: RenewableSubscriptionCandidate,
  now: Date,
  renewWithinMs: number,
): RenewalDecision {
  if (!isNonEmptyString(candidate.subscriptionId)) {
    // Cannot PATCH without a subscription id — skip safely, never crash.
    return 'invalid';
  }
  if (candidate.mailboxStatus === MAILBOX_STATUS_DISABLED) {
    return 'skip';
  }
  const remainingMs = candidate.expirationDateTime.getTime() - now.getTime();
  if (!Number.isFinite(remainingMs)) {
    return 'invalid';
  }
  if (remainingMs <= 0) {
    return 'expired';
  }
  if (remainingMs <= renewWithinMs) {
    return 'renew';
  }
  return 'skip';
}

/**
 * Read a thrown renew error and map it to an action. Decoupled from the
 * concrete error class — it duck-types `kind` / `httpStatus`, so both the real
 * `GraphSubscriptionError` and lightweight test doubles classify identically.
 */
export function classifyRenewError(error: unknown): RenewFailureKind {
  const kind =
    typeof error === 'object' && error !== null && 'kind' in error
      ? (error as { kind?: unknown }).kind
      : undefined;
  const httpStatus =
    typeof error === 'object' && error !== null && 'httpStatus' in error
      ? (error as { httpStatus?: unknown }).httpStatus
      : undefined;

  if (kind === 'auth') {
    // HTTP 401 on a freshly-minted access token: the token was rejected outright
    // → surface as reconnect-required.
    return 'reconnect_required';
  }
  if (kind === 'permission') {
    // TASK-071 — HTTP 403 is NOT a dead grant (the access token was minted from a
    // healthy refresh). Treat it as transient/retryable so a Graph access blip on
    // the renew request never forces a manual reconnect — matching delta polling
    // and the email worker.
    return 'transient';
  }
  if (kind === 'not_found' || httpStatus === 404 || httpStatus === 410) {
    return 'expired';
  }
  if (kind === 'rate_limited' || kind === 'temporary' || kind === 'network') {
    return 'transient';
  }
  return 'fatal';
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

async function defaultSleep(ms: number): Promise<void> {
  if (ms <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Per-subscription handling
// ---------------------------------------------------------------------------

interface RenewContext {
  repo: SubscriptionRenewalRepo;
  accessToken: RenewalAccessTokenPort;
  renew: RenewSubscriptionPort;
  audit?: RenewalAuditPort;
  logger: Logger;
  now: () => Date;
  maxRenewAttempts: number;
  sleep: (ms: number) => Promise<void>;
}

type SubscriptionOutcome =
  | 'renewed'
  | 'failed'
  | 'reconnect_required'
  | 'expired'
  | 'claim_lost';

/**
 * Run a subscription-level CAS completion and return whether this operation
 * still owned the claim. A thrown DB error is treated as NOT owned (count 0):
 * per TASK-084 correction A, a persistence failure must never let a stale worker
 * assume ownership or apply a downstream mailbox side effect.
 */
async function casOwned(
  action: () => Promise<boolean>,
  logger: Logger,
  failureMessage: string,
  context: Record<string, unknown>,
): Promise<boolean> {
  try {
    return await action();
  } catch (error) {
    logger.warn(failureMessage, { ...context, errorName: safeErrorName(error) });
    return false;
  }
}

/** Best-effort mailbox lifecycle writer — only ever called AFTER a CAS win. */
async function applyMailboxSideEffect(
  action: () => Promise<boolean>,
  logger: Logger,
  failureMessage: string,
  context: Record<string, unknown>,
): Promise<void> {
  try {
    await action();
  } catch (error) {
    logger.warn(failureMessage, { ...context, errorName: safeErrorName(error) });
  }
}

/**
 * TASK-084 STEP 1 → STEP 2 ordering for the 404/410 (expired) branch.
 * STEP 1 is the CAS EXPIRED completion; the relation-aware mailbox writer (STEP
 * 2) runs ONLY when STEP 1 proved ownership (count = 1). A lost claim or DB error
 * yields ZERO mailbox side effect.
 */
async function completeExpired(
  candidate: RenewableSubscriptionCandidate,
  subscriptionId: string,
  claimGeneration: Date,
  ctx: RenewContext,
): Promise<void> {
  const owned = await casOwned(
    () => ctx.repo.markSubscriptionExpiredIfOwner(subscriptionId, claimGeneration),
    ctx.logger,
    'Failed to CAS-mark subscription expired',
    { mailboxId: candidate.mailboxId },
  );
  if (!owned) return;
  await applyMailboxSideEffect(
    () =>
      ctx.repo.markMailboxSubscriptionExpiredIfNoOtherLiveSubscription({
        mailboxId: candidate.mailboxId,
        failingSubscriptionRowId: candidate.id,
        now: ctx.now(),
      }),
    ctx.logger,
    'Failed to mark mailbox subscription-expired',
    { mailboxId: candidate.mailboxId },
  );
}

/**
 * TASK-084 STEP 1 → STEP 2 ordering for the reconnect-required branch. STEP 1 is
 * the CAS FAILED completion (claim ownership gate, correction A/H); the
 * credential-generation-guarded mailbox writer (STEP 2) runs ONLY when STEP 1
 * proved ownership. The credential-generation guard additionally prevents a stale
 * pre-reconnect renewal from overwriting a freshly OAuth-reconnected mailbox
 * (correction B) while preserving genuine TASK-069C reconnect semantics.
 */
async function completeReconnectRequired(
  candidate: RenewableSubscriptionCandidate,
  subscriptionId: string,
  claimGeneration: Date,
  credentialGeneration: string | null,
  ctx: RenewContext,
): Promise<void> {
  const owned = await casOwned(
    () => ctx.repo.markSubscriptionFailedIfOwner(subscriptionId, claimGeneration),
    ctx.logger,
    'Failed to CAS-mark subscription failed',
    { mailboxId: candidate.mailboxId },
  );
  if (!owned) return;
  await applyMailboxSideEffect(
    () =>
      ctx.repo.markMailboxReconnectRequiredIfCredentialCurrent(
        candidate.mailboxId,
        credentialGeneration,
      ),
    ctx.logger,
    'Failed to mark mailbox reconnect-required',
    { mailboxId: candidate.mailboxId },
  );
}

/** Plain failure completion (transient exhausted / fatal). No mailbox effect. */
async function completeFailed(
  candidate: RenewableSubscriptionCandidate,
  subscriptionId: string,
  claimGeneration: Date,
  ctx: RenewContext,
): Promise<void> {
  await casOwned(
    () => ctx.repo.markSubscriptionFailedIfOwner(subscriptionId, claimGeneration),
    ctx.logger,
    'Failed to CAS-mark subscription failed',
    { mailboxId: candidate.mailboxId },
  );
}

/**
 * Renew one already-claimed subscription with bounded retries. `claimGeneration`
 * is the CAS ownership token captured by the caller's successful claim. Returns
 * the terminal outcome; never throws.
 */
async function renewOneSubscription(
  candidate: RenewableSubscriptionCandidate,
  subscriptionId: string,
  claimGeneration: Date,
  ctx: RenewContext,
): Promise<SubscriptionOutcome> {
  let credential: RenewalCredential;
  try {
    credential = await ctx.accessToken.getAccessTokenForMailbox(
      candidate.mailboxId,
    );
  } catch (error) {
    if (
      error instanceof SubscriptionRenewalTokenError &&
      error.kind === 'reconnect_required'
    ) {
      // Case A — reconnect failure BEFORE a successful token exchange. The guard
      // uses the credential generation the token port read at operation start.
      await completeReconnectRequired(
        candidate,
        subscriptionId,
        claimGeneration,
        error.credentialGeneration,
        ctx,
      );
      return 'reconnect_required';
    }
    // transient/config/unknown token errors: CAS-record a failure, retry next tick.
    await completeFailed(candidate, subscriptionId, claimGeneration, ctx);
    ctx.logger.warn('Subscription renewal could not obtain access token', {
      mailboxId: candidate.mailboxId,
      errorName: safeErrorName(error),
    });
    return 'failed';
  }

  for (let attempt = 1; attempt <= ctx.maxRenewAttempts; attempt += 1) {
    try {
      const { newExpirationDateTime } = await ctx.renew.renew({
        mailboxId: candidate.mailboxId,
        subscriptionId,
        accessToken: credential.accessToken,
        now: ctx.now(),
      });

      const owned = await casOwned(
        () =>
          ctx.repo.markRenewedIfOwner({
            subscriptionId,
            claimGeneration,
            newExpirationDateTime,
            now: ctx.now(),
          }),
        ctx.logger,
        'Failed to CAS-persist renewed subscription',
        { mailboxId: candidate.mailboxId },
      );
      if (!owned) {
        // Stale owner: another worker already reclaimed + completed. Do NOT
        // overwrite the newer ACTIVE/expiration and do NOT write an audit entry.
        return 'claim_lost';
      }

      if (ctx.audit) {
        await applyMailboxSideEffect(
          async () => {
            await ctx.audit?.recordRenewed({
              mailboxId: candidate.mailboxId,
              graphSubscriptionId: subscriptionId,
              oldExpirationDateTime: candidate.expirationDateTime,
              newExpirationDateTime,
            });
            return true;
          },
          ctx.logger,
          'Failed to write SUBSCRIPTION_RENEWED audit entry',
          { mailboxId: candidate.mailboxId },
        );
      }
      return 'renewed';
    } catch (error) {
      const failureKind = classifyRenewError(error);

      if (failureKind === 'reconnect_required') {
        // Case B — Graph 401 AFTER token acquisition. The guard uses the
        // credential generation the operation committed to (post any rotation).
        await completeReconnectRequired(
          candidate,
          subscriptionId,
          claimGeneration,
          credential.credentialGeneration,
          ctx,
        );
        return 'reconnect_required';
      }
      if (failureKind === 'expired') {
        await completeExpired(candidate, subscriptionId, claimGeneration, ctx);
        return 'expired';
      }
      if (failureKind === 'transient' && attempt < ctx.maxRenewAttempts) {
        await ctx.sleep(DEFAULT_RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      // transient exhausted, or fatal — CAS-record failure and move on.
      await completeFailed(candidate, subscriptionId, claimGeneration, ctx);
      ctx.logger.warn('Subscription renewal failed', {
        mailboxId: candidate.mailboxId,
        failureKind,
        attempt,
        errorName: safeErrorName(error),
      });
      return 'failed';
    }
  }

  return 'failed';
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run one renewal cycle across every renewable subscription. Safe to call from
 * a test, a CLI script, or a scheduler tick. Per-subscription errors never
 * bubble up — they are recorded against the offending mailbox and the run
 * continues.
 */
export async function runSubscriptionRenewalOnce(
  deps: SubscriptionRenewalDeps,
): Promise<SubscriptionRenewalRunResult> {
  const logger = deps.logger ?? createLogger();
  const now = deps.now ?? (() => new Date());
  const renewWithinMs =
    typeof deps.renewWithinMs === 'number' && deps.renewWithinMs > 0
      ? deps.renewWithinMs
      : DEFAULT_RENEW_WINDOW_MS;
  const maxRenewAttempts =
    typeof deps.maxRenewAttempts === 'number' && deps.maxRenewAttempts >= 1
      ? Math.floor(deps.maxRenewAttempts)
      : DEFAULT_MAX_RENEW_ATTEMPTS;

  const ctx: RenewContext = {
    repo: deps.repo,
    accessToken: deps.accessToken,
    renew: deps.renew,
    audit: deps.audit,
    logger,
    now,
    maxRenewAttempts,
    sleep: deps.sleep ?? defaultSleep,
  };

  const result: SubscriptionRenewalRunResult = {
    checkedCount: 0,
    renewedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    reconnectRequiredCount: 0,
    expiredCount: 0,
    claimLostCount: 0,
    staleReclaimedCount: 0,
  };

  let candidates: RenewableSubscriptionCandidate[];
  try {
    candidates = await deps.repo.listRenewableCandidates();
  } catch (error) {
    logger.error('Subscription renewal failed to list candidates', {
      errorName: safeErrorName(error),
    });
    return result;
  }

  logger.info('Subscription renewal cycle started', {
    candidateCount: candidates.length,
    renewWithinHours: Math.round(renewWithinMs / (60 * 60 * 1000)),
  });

  for (const candidate of candidates) {
    result.checkedCount += 1;
    const decision = classifySubscription(candidate, now(), renewWithinMs);

    if (decision === 'invalid') {
      result.skippedCount += 1;
      logger.warn('Subscription renewal skipped invalid candidate', {
        mailboxId: candidate.mailboxId,
      });
      continue;
    }
    if (decision === 'skip') {
      result.skippedCount += 1;
      continue;
    }

    const subscriptionId = (candidate.subscriptionId as string).trim();

    try {
      // TASK-084 — atomic claim BEFORE any token acquisition / Graph PATCH. A
      // lost claim means another worker owns this row: skip entirely (no token,
      // no PATCH, no completion, no mailbox side effect) and re-evaluate next tick.
      let claim: SubscriptionClaim;
      try {
        claim = await ctx.repo.claimForRenewal(subscriptionId, now());
      } catch (error) {
        // Claim persistence failed: treat as a lost claim (fail-closed) rather
        // than proceeding without proven ownership.
        result.claimLostCount += 1;
        logger.warn('Subscription renewal could not claim subscription', {
          mailboxId: candidate.mailboxId,
          errorName: safeErrorName(error),
        });
        continue;
      }

      if (!claim.claimed || claim.claimGeneration === null) {
        result.claimLostCount += 1;
        continue;
      }
      if (claim.reclaimedStale) {
        result.staleReclaimedCount += 1;
      }
      const claimGeneration = claim.claimGeneration;

      if (decision === 'expired') {
        await completeExpired(candidate, subscriptionId, claimGeneration, ctx);
        result.expiredCount += 1;
        logger.info('Subscription marked expired', {
          mailboxId: candidate.mailboxId,
          emailAddressMasked: maskEmail(candidate.emailAddress),
        });
        continue;
      }

      const outcome = await renewOneSubscription(
        candidate,
        subscriptionId,
        claimGeneration,
        ctx,
      );
      if (outcome === 'renewed') {
        result.renewedCount += 1;
        logger.info('Subscription renewed', {
          mailboxId: candidate.mailboxId,
          emailAddressMasked: maskEmail(candidate.emailAddress),
        });
      } else if (outcome === 'reconnect_required') {
        result.reconnectRequiredCount += 1;
      } else if (outcome === 'expired') {
        result.expiredCount += 1;
      } else if (outcome === 'claim_lost') {
        result.claimLostCount += 1;
      } else {
        result.failedCount += 1;
      }
    } catch (error) {
      // Defensive backstop — handlers above already swallow their own errors,
      // but one bad mailbox must never crash the whole batch.
      result.failedCount += 1;
      logger.warn('Subscription renewal raised unexpectedly for mailbox', {
        mailboxId: candidate.mailboxId,
        errorName: safeErrorName(error),
      });
    }
  }

  logger.info('Subscription renewal cycle finished', { ...result });
  return result;
}

// ---------------------------------------------------------------------------
// Test-facing internals
// ---------------------------------------------------------------------------

export const __internal = {
  DEFAULT_RENEW_WINDOW_MS,
  DEFAULT_MAX_RENEW_ATTEMPTS,
  DEFAULT_RETRY_BASE_DELAY_MS,
  MAILBOX_STATUS_DISABLED,
};
