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

/** Persistence surface — supplied by a Prisma-backed adapter in production. */
export interface SubscriptionRenewalRepo {
  listRenewableCandidates(): Promise<RenewableSubscriptionCandidate[]>;
  /** Subscription gone on Microsoft's side (404/410) or already past expiry. */
  markSubscriptionExpired(subscriptionId: string): Promise<void>;
  /** Renew failed after exhausting retries / on a fatal error. */
  markSubscriptionFailed(subscriptionId: string): Promise<void>;
  /** Refresh token revoked — the human operator must reconnect the mailbox. */
  markMailboxReconnectRequired(mailboxId: string): Promise<void>;
  /** Mailbox-level mirror of an expired/missing subscription. */
  markMailboxSubscriptionExpired(mailboxId: string): Promise<void>;
}

/** Access-token surface. Implementations decrypt + exchange the refresh token. */
export interface RenewalAccessTokenPort {
  getAccessTokenForMailbox(mailboxId: string): Promise<string>;
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
  constructor(kind: RenewalTokenErrorKind, message: string) {
    super(message);
    this.name = 'SubscriptionRenewalTokenError';
    this.kind = kind;
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

  if (kind === 'auth' || kind === 'permission') {
    // 401/403 on a freshly-minted access token means the grant is no longer
    // usable for this mailbox — surface as reconnect-required.
    return 'reconnect_required';
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
  | 'expired';

async function safely(
  action: () => Promise<void>,
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

async function handleExpired(
  candidate: RenewableSubscriptionCandidate,
  subscriptionId: string,
  ctx: RenewContext,
): Promise<void> {
  await safely(
    () => ctx.repo.markSubscriptionExpired(subscriptionId),
    ctx.logger,
    'Failed to mark subscription expired',
    { mailboxId: candidate.mailboxId },
  );
  await safely(
    () => ctx.repo.markMailboxSubscriptionExpired(candidate.mailboxId),
    ctx.logger,
    'Failed to mark mailbox subscription-expired',
    { mailboxId: candidate.mailboxId },
  );
}

async function handleReconnectRequired(
  candidate: RenewableSubscriptionCandidate,
  subscriptionId: string,
  ctx: RenewContext,
): Promise<void> {
  await safely(
    () => ctx.repo.markMailboxReconnectRequired(candidate.mailboxId),
    ctx.logger,
    'Failed to mark mailbox reconnect-required',
    { mailboxId: candidate.mailboxId },
  );
  await safely(
    () => ctx.repo.markSubscriptionFailed(subscriptionId),
    ctx.logger,
    'Failed to mark subscription failed',
    { mailboxId: candidate.mailboxId },
  );
}

/**
 * Renew one subscription with bounded retries. Returns the terminal outcome.
 * Never throws — all failures are captured and reported via the return value.
 */
async function renewOneSubscription(
  candidate: RenewableSubscriptionCandidate,
  subscriptionId: string,
  ctx: RenewContext,
): Promise<SubscriptionOutcome> {
  let accessToken: string;
  try {
    accessToken = await ctx.accessToken.getAccessTokenForMailbox(
      candidate.mailboxId,
    );
  } catch (error) {
    if (
      error instanceof SubscriptionRenewalTokenError &&
      error.kind === 'reconnect_required'
    ) {
      await handleReconnectRequired(candidate, subscriptionId, ctx);
      return 'reconnect_required';
    }
    // transient/config/unknown token errors: record a failure, retry next tick.
    await safely(
      () => ctx.repo.markSubscriptionFailed(subscriptionId),
      ctx.logger,
      'Failed to mark subscription failed',
      { mailboxId: candidate.mailboxId },
    );
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
        accessToken,
        now: ctx.now(),
      });

      if (ctx.audit) {
        await safely(
          async () => {
            await ctx.audit?.recordRenewed({
              mailboxId: candidate.mailboxId,
              graphSubscriptionId: subscriptionId,
              oldExpirationDateTime: candidate.expirationDateTime,
              newExpirationDateTime,
            });
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
        await handleReconnectRequired(candidate, subscriptionId, ctx);
        return 'reconnect_required';
      }
      if (failureKind === 'expired') {
        await handleExpired(candidate, subscriptionId, ctx);
        return 'expired';
      }
      if (failureKind === 'transient' && attempt < ctx.maxRenewAttempts) {
        await ctx.sleep(DEFAULT_RETRY_BASE_DELAY_MS * attempt);
        continue;
      }
      // transient exhausted, or fatal — record failure and move on.
      await safely(
        () => ctx.repo.markSubscriptionFailed(subscriptionId),
        ctx.logger,
        'Failed to mark subscription failed',
        { mailboxId: candidate.mailboxId },
      );
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
      if (decision === 'expired') {
        await handleExpired(candidate, subscriptionId, ctx);
        result.expiredCount += 1;
        logger.info('Subscription marked expired', {
          mailboxId: candidate.mailboxId,
          emailAddressMasked: maskEmail(candidate.emailAddress),
        });
        continue;
      }

      const outcome = await renewOneSubscription(candidate, subscriptionId, ctx);
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
