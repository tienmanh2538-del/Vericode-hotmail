// TASK-081 — Connect-time Graph subscription provisioning (Option A only).
// TASK-086 — Provisioning concurrency guard.
//
// TASK-079 confirmed that `createInboxSubscription` had no production caller:
// a freshly connected/reconnected mailbox never got a Graph subscription, so
// the webhook path never existed for it and the renewal worker had no
// candidate. This service is the missing production caller. The OAuth callback
// invokes it AFTER `saveConnectedMailbox` has succeeded, with the fresh access
// token already minted by the token exchange (no extra token is requested or
// persisted). Reconciliation (TASK-082) and SUBSCRIPTION_EXPIRED recovery
// (TASK-083) reuse this exact seam.
//
// ---------------------------------------------------------------------------
// TASK-086 — locked concurrency architecture
// ---------------------------------------------------------------------------
// Correctness invariant: AT MOST ONE LOCAL LIVE GraphSubscription PER MAILBOX,
// where "live" is ACTIVE / RENEWING / FAILED. It is enforced by a PARTIAL
// UNIQUE INDEX on (mailboxId) WHERE status IN (live) — the database is the one
// and only serialisation point. No Redis lock, no long transaction, no advisory
// lock, and no placeholder row. Microsoft's documented HTTP 409 for duplicate
// subscriptions is DEFENSIVE handling only: this code stays correct even if two
// concurrent creates both receive 201.
//
// Because a partial index cannot carry a time predicate, "expired by time" and
// "occupies the live slot" are two different things and must be reconciled
// BEFORE deciding to create:
//
//   capturedNow
//   → STEP A: normalise expired live rows to EXPIRED (conditional writes only)
//   → a FRESH RENEWING claim (TASK-084) temporarily blocks — never stolen
//   → STEP B: re-read; ANY remaining ACTIVE/RENEWING/FAILED row blocks
//   → only with no live row left: remote POST, then local INSERT
//
// STEP B deliberately does NOT filter on `expirationDateTime > now` any more:
// expiration was already resolved in STEP A, so the application's blocking
// definition and the database index now mean exactly the same thing.
//
// Normalisation NEVER touches `Mailbox.status` — mailbox lifecycle stays owned
// by TASK-052/083/084.
//
// Fail-open — this function NEVER throws. Any failure (config, Graph 4xx/5xx,
// network, timeout, DB, conflict, ownership loss) is logged sanitized and
// reported via the returned outcome; the connected mailbox and its persisted
// credential are left exactly as `saveConnectedMailbox` wrote them, and delta
// polling remains the backup path. There is no retry loop — the single attempt
// either settles or is aborted by the finite timeout below.

import { prisma as defaultPrisma } from '@/lib/prisma';
import { createLogger, type Logger } from '@/lib/logger';
import { fetchWithTimeout } from '@/lib/http/fetch-with-timeout';
import { computeStaleClaimCutoff } from '@/services/microsoft/subscription-claim-window';
import {
  createInboxSubscription,
  GraphSubscriptionError,
  type GraphSubscriptionDeps,
  type GraphSubscriptionResult,
  type GraphSubscriptionStatus,
  type CreateInboxSubscriptionInput,
} from '@/services/microsoft/graph-subscription.service';

const logger = createLogger();

// Finite ceiling for the connect-time subscription HTTP calls (create and, on a
// persist failure, the single compensating delete). Mirrors the 20s delta-path
// ceiling from TASK-080. The OAuth callback must never hang on Microsoft.
export const CONNECT_SUBSCRIPTION_HTTP_TIMEOUT_MS = 20_000;

// The "live" statuses: a row in one of these occupies the mailbox's single live
// slot (TASK-086 partial unique index) and blocks provisioning. EXPIRED never
// blocks and is never constrained, so historical rows accumulate freely.
// Exported as the single source of truth shared by the reconciliation candidate
// query (TASK-082/083) and the renewal relation predicates (TASK-084).
export const BLOCKING_SUBSCRIPTION_STATUSES: GraphSubscriptionStatus[] = [
  'ACTIVE',
  'RENEWING',
  'FAILED',
];

const EXPIRED_STATUS: GraphSubscriptionStatus = 'EXPIRED';
const RENEWING_STATUS: GraphSubscriptionStatus = 'RENEWING';

export type EnsureInboxSubscriptionOutcome =
  | { outcome: 'created'; subscriptionId: string }
  /** A live row already occupies the mailbox's slot — nothing to do. */
  | { outcome: 'skipped_existing'; existingStatus: GraphSubscriptionStatus }
  /**
   * TASK-086 — an expired-by-time RENEWING row is held by a FRESH TASK-084
   * claim. Provisioning is deliberately deferred (no Graph call, no write, no
   * immediate retry) until that claim settles or goes stale.
   */
  | { outcome: 'blocked_renewing' }
  /**
   * TASK-086 — the remote subscription was created but the local INSERT lost
   * the live-slot race; our remote subscription was released and a live winner
   * was confirmed by re-reading local state.
   */
  | { outcome: 'lost_ownership'; existingStatus: GraphSubscriptionStatus }
  /** Microsoft answered 409 and local state does hold a live winner. */
  | { outcome: 'conflict_existing'; existingStatus: GraphSubscriptionStatus }
  /**
   * A conflict (remote 409 or local unique violation) with NO local live owner:
   * either a concurrent winner has not persisted yet, or a remote subscription
   * exists that this database does not own. Fail-safe — nothing is fabricated
   * and no mailbox state is changed. Orphan remediation is out of scope.
   */
  | {
      outcome: 'conflict_unowned';
      source: 'remote_conflict' | 'local_unique_conflict';
    }
  | { outcome: 'failed'; errorName: string };

export interface EnsureInboxSubscriptionInput {
  mailboxId: string;
  /** Fresh access token from the OAuth token exchange. Never persisted here. */
  accessToken: string;
}

interface LiveSubscriptionRow {
  id: string;
  subscriptionId: string;
  status: GraphSubscriptionStatus;
  expirationDateTime: Date;
  /** TASK-084 claim generation — only meaningful for RENEWING rows. */
  updatedAt: Date;
}

interface EnsurePrismaClient {
  graphSubscription: {
    findMany: (args: {
      where: {
        mailboxId: string;
        status: { in: GraphSubscriptionStatus[] };
      };
      orderBy: { expirationDateTime: 'desc' };
      select: {
        id: true;
        subscriptionId: true;
        status: true;
        expirationDateTime: true;
        updatedAt: true;
      };
    }) => Promise<LiveSubscriptionRow[]>;
    updateMany: (args: {
      where: {
        id: string;
        status: GraphSubscriptionStatus;
        expirationDateTime: { lte: Date };
        updatedAt?: { lt: Date };
      };
      data: { status: GraphSubscriptionStatus };
    }) => Promise<{ count: number }>;
  };
}

export interface EnsureInboxSubscriptionDeps {
  prisma?: EnsurePrismaClient;
  /** Injectable creation port; defaults to the real graph-subscription service. */
  createSubscription?: (
    input: CreateInboxSubscriptionInput,
    deps: GraphSubscriptionDeps,
  ) => Promise<GraphSubscriptionResult>;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  now?: () => Date;
}

function safeErrorName(error: unknown): string {
  return error instanceof Error ? error.name : 'UnknownError';
}

function readLiveRows(
  prisma: EnsurePrismaClient,
  mailboxId: string,
): Promise<LiveSubscriptionRow[]> {
  return prisma.graphSubscription.findMany({
    where: { mailboxId, status: { in: BLOCKING_SUBSCRIPTION_STATUSES } },
    orderBy: { expirationDateTime: 'desc' },
    select: {
      id: true,
      subscriptionId: true,
      status: true,
      expirationDateTime: true,
      updatedAt: true,
    },
  });
}

/**
 * STEP A — normalise rows that are live by status but already expired by time.
 *
 * Every write is CONDITIONAL and pinned to one row id, so it can only ever win
 * against the exact state it observed:
 *   - ACTIVE / FAILED: the status must still be the one we read. If TASK-084
 *     claimed the row first (→ RENEWING) the update matches nothing (count 0)
 *     and the claim keeps ownership. Conversely, when this update wins first,
 *     the row is EXPIRED and the renewal claim (which requires ACTIVE/FAILED)
 *     matches nothing.
 *   - RENEWING: only a STALE claim may be normalised, using the SAME 30-minute
 *     window TASK-084 uses to reclaim abandoned claims. If a concurrent stale
 *     reclaim bumps `updatedAt` first, our `updatedAt < staleCutoff` predicate
 *     no longer matches and we lose. When we win, the previous claimant's
 *     completion CAS (status = RENEWING AND updatedAt = claimGeneration) can no
 *     longer match either — an EXPIRED row is never resurrected.
 *
 * Returns true when a FRESH RENEWING claim was seen: provisioning must stop.
 */
async function normaliseExpiredLiveRows(
  prisma: EnsurePrismaClient,
  rows: LiveSubscriptionRow[],
  capturedNow: Date,
): Promise<{ freshRenewingHeld: boolean }> {
  const staleCutoff = computeStaleClaimCutoff(capturedNow);
  let freshRenewingHeld = false;

  for (const row of rows) {
    if (row.expirationDateTime.getTime() > capturedNow.getTime()) {
      // Still usable by time — not a normalisation candidate. STEP B will treat
      // it as a blocker.
      continue;
    }

    if (row.status === RENEWING_STATUS) {
      if (row.updatedAt.getTime() >= staleCutoff.getTime()) {
        // Fresh TASK-084 claim: never stolen, never expired from under the
        // owner. Provisioning waits for the next connect/tick instead.
        freshRenewingHeld = true;
        continue;
      }
      await prisma.graphSubscription.updateMany({
        where: {
          id: row.id,
          status: RENEWING_STATUS,
          expirationDateTime: { lte: capturedNow },
          updatedAt: { lt: staleCutoff },
        },
        data: { status: EXPIRED_STATUS },
      });
      continue;
    }

    await prisma.graphSubscription.updateMany({
      where: {
        id: row.id,
        status: row.status,
        expirationDateTime: { lte: capturedNow },
      },
      data: { status: EXPIRED_STATUS },
    });
  }

  return { freshRenewingHeld };
}

/**
 * Classify a conflict (remote 409 or local unique violation) by re-reading the
 * mailbox's live rows. A live winner turns the conflict into a controlled
 * "someone else owns the slot" outcome; no winner is reported as-is and never
 * papered over with a fabricated local row.
 */
async function classifyConflict(
  prisma: EnsurePrismaClient,
  mailboxId: string,
  source: 'remote_conflict' | 'local_unique_conflict',
): Promise<EnsureInboxSubscriptionOutcome> {
  const winners = await readLiveRows(prisma, mailboxId);
  const winner = winners[0];
  if (!winner) {
    return { outcome: 'conflict_unowned', source };
  }
  return source === 'remote_conflict'
    ? { outcome: 'conflict_existing', existingStatus: winner.status }
    : { outcome: 'lost_ownership', existingStatus: winner.status };
}

/**
 * Ensure the mailbox has exactly one usable Graph subscription, creating one
 * only when its live slot is genuinely free. Never throws; see the module
 * header for the normalisation, blocking and fail-open contracts.
 */
export async function ensureInboxSubscriptionForConnectedMailbox(
  input: EnsureInboxSubscriptionInput,
  deps: EnsureInboxSubscriptionDeps = {},
): Promise<EnsureInboxSubscriptionOutcome> {
  const log = deps.logger ?? logger;
  const mailboxId = typeof input.mailboxId === 'string' ? input.mailboxId.trim() : '';

  try {
    if (mailboxId.length === 0) {
      throw new GraphSubscriptionError('validation', 'mailboxId is required');
    }
    if (
      typeof input.accessToken !== 'string' ||
      input.accessToken.trim().length === 0
    ) {
      throw new GraphSubscriptionError('validation', 'access token is required');
    }

    const prisma = deps.prisma ?? (defaultPrisma as unknown as EnsurePrismaClient);
    const now = deps.now ?? (() => new Date());
    const capturedNow = now();

    // STEP A — read the live slot, then normalise what is expired by time.
    const liveRows = await readLiveRows(prisma, mailboxId);
    const { freshRenewingHeld } = await normaliseExpiredLiveRows(
      prisma,
      liveRows,
      capturedNow,
    );

    if (freshRenewingHeld) {
      log.info('Provisioning deferred — a fresh renewal claim holds the live slot', {
        mailboxId,
      });
      return { outcome: 'blocked_renewing' };
    }

    // STEP B — anything still live blocks. No time predicate here: expiration
    // was already resolved above, so this read matches the database index.
    const remaining = await readLiveRows(prisma, mailboxId);
    const blocker = remaining[0];
    if (blocker) {
      log.info('Graph subscription already usable — skipping create', {
        mailboxId,
        existingStatus: blocker.status,
      });
      return { outcome: 'skipped_existing', existingStatus: blocker.status };
    }

    const baseFetch = deps.fetchImpl ?? fetch;
    const timeoutFetch = ((url: RequestInfo | URL, init?: RequestInit) =>
      fetchWithTimeout(baseFetch, String(url), init ?? {}, {
        timeoutMs: CONNECT_SUBSCRIPTION_HTTP_TIMEOUT_MS,
      })) as typeof fetch;

    const createSubscription = deps.createSubscription ?? createInboxSubscription;

    let created: GraphSubscriptionResult;
    try {
      created = await createSubscription(
        { mailboxId, accessToken: input.accessToken },
        { fetchImpl: timeoutFetch },
      );
    } catch (createError) {
      if (createError instanceof GraphSubscriptionError) {
        // Microsoft refused the duplicate (defensive) or our local INSERT lost
        // the live-slot race (authoritative). Either way the remote side has
        // already been compensated by the create seam; classify and report a
        // controlled outcome — never retry the create here.
        if (createError.kind === 'conflict') {
          log.info('Graph refused a duplicate subscription — re-reading local state', {
            mailboxId,
            httpStatus: createError.httpStatus,
          });
          return classifyConflict(prisma, mailboxId, 'remote_conflict');
        }
        if (createError.kind === 'ownership_conflict') {
          log.info('Lost the local live-slot race — own subscription released', {
            mailboxId,
          });
          return classifyConflict(prisma, mailboxId, 'local_unique_conflict');
        }
      }
      throw createError;
    }

    log.info('Graph subscription provisioned for connected mailbox', {
      mailboxId,
      graphSubscriptionId: created.subscriptionId,
    });
    return { outcome: 'created', subscriptionId: created.subscriptionId };
  } catch (error) {
    // Sanitized failure only: error name/kind/httpStatus — never tokens,
    // clientState, or response bodies. The connect itself stays successful.
    const kind = error instanceof GraphSubscriptionError ? error.kind : undefined;
    const httpStatus =
      error instanceof GraphSubscriptionError ? error.httpStatus : undefined;
    log.warn('Graph subscription provisioning failed after mailbox connect', {
      mailboxId,
      errorName: safeErrorName(error),
      kind,
      httpStatus,
    });
    return { outcome: 'failed', errorName: safeErrorName(error) };
  }
}
