// TASK-082 — Prisma-backed adapters + default wiring for the operator-invoked
// subscription reconciliation service. Importing this module has zero side
// effects: nothing is scheduled, no timers start, no connection is opened.
// The one-shot CLI (scripts/run-subscription-reconciliation.ts) is the only
// production caller.

import { prisma as defaultPrisma } from '@/lib/prisma';
import { fetchWithTimeout } from '@/lib/http/fetch-with-timeout';
import {
  BLOCKING_SUBSCRIPTION_STATUSES,
  CONNECT_SUBSCRIPTION_HTTP_TIMEOUT_MS,
  ensureInboxSubscriptionForConnectedMailbox,
} from '@/services/microsoft/mailbox-subscription-provisioning.service';
import { deleteGraphSubscription } from '@/services/microsoft/graph-subscription.service';
import { createPrismaRenewalAccessTokenPort } from '@/services/queue/workers/subscription-renewal-runner';
import {
  ReconciliationValidationError,
  resolveReconciliationLimit,
  type ReconciliationCandidate,
  type ReconciliationEnsurePort,
  type ReconciliationMode,
  type ReconciliationRemoteCleanupPort,
  type SubscriptionReconciliationDeps,
  type SubscriptionReconciliationRepo,
} from '@/services/microsoft/subscription-reconciliation.service';

const MAILBOX_PROVIDER_MICROSOFT = 'MICROSOFT';
const MAILBOX_STATUS_ACTIVE = 'ACTIVE';
const MAILBOX_STATUS_RECONNECT_REQUIRED = 'RECONNECT_REQUIRED';
const MAILBOX_STATUS_SUBSCRIPTION_EXPIRED = 'SUBSCRIPTION_EXPIRED';
const SUBSCRIPTION_STATUS_EXPIRED = 'EXPIRED';

// ---------------------------------------------------------------------------
// Prisma-backed repo
// ---------------------------------------------------------------------------

interface CountResult {
  count: number;
}

interface ReconciliationPrismaClient {
  mailbox: {
    findMany: (args: unknown) => Promise<Array<{ id: string }>>;
    findUnique: (args: unknown) => Promise<{ status: string } | null>;
    updateMany: (args: unknown) => Promise<CountResult>;
  };
  graphSubscription: {
    findFirst: (args: unknown) => Promise<{ id: string } | null>;
    updateMany: (args: unknown) => Promise<CountResult>;
  };
}

export function createPrismaReconciliationRepo(
  client: ReconciliationPrismaClient = defaultPrisma as unknown as ReconciliationPrismaClient,
): SubscriptionReconciliationRepo {
  // Shared candidate predicate: Microsoft provider, the given mailbox status,
  // encrypted refresh credential present, and no potentially-live subscription
  // per the TASK-081 blocking definition (reused, not redefined). Normal
  // reconciliation and TASK-083 recovery differ ONLY in the pinned status —
  // never a status union in one query.
  async function listCandidatesWithStatus(
    mailboxStatus: string,
    limit: number,
    now: Date,
  ): Promise<ReconciliationCandidate[]> {
    const rows = await client.mailbox.findMany({
      where: {
        provider: MAILBOX_PROVIDER_MICROSOFT,
        status: mailboxStatus,
        encryptedRefreshToken: { not: null },
        graphSubscriptions: {
          none: {
            status: { in: [...BLOCKING_SUBSCRIPTION_STATUSES] },
            expirationDateTime: { gt: now },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: limit,
      select: { id: true },
    });
    return rows.map((row) => ({ mailboxId: row.id }));
  }

  return {
    async listReconciliationCandidates(
      limit: number,
      now: Date,
    ): Promise<ReconciliationCandidate[]> {
      return listCandidatesWithStatus(MAILBOX_STATUS_ACTIVE, limit, now);
    },
    async listSubscriptionExpiredRecoveryCandidates(
      limit: number,
      now: Date,
    ): Promise<ReconciliationCandidate[]> {
      return listCandidatesWithStatus(
        MAILBOX_STATUS_SUBSCRIPTION_EXPIRED,
        limit,
        now,
      );
    },
    async getMailboxStatus(mailboxId: string): Promise<string | null> {
      const row = await client.mailbox.findUnique({
        where: { id: mailboxId },
        select: { status: true },
      });
      return row?.status ?? null;
    },
    async hasBlockingSubscription(mailboxId: string, now: Date): Promise<boolean> {
      const row = await client.graphSubscription.findFirst({
        where: {
          mailboxId,
          status: { in: [...BLOCKING_SUBSCRIPTION_STATUSES] },
          expirationDateTime: { gt: now },
        },
        select: { id: true },
      });
      return row !== null;
    },
    async markMailboxReconnectRequiredIfActive(mailboxId: string): Promise<boolean> {
      // Conditional on status so a concurrent disconnect (DISABLED) is never
      // overwritten back to RECONNECT_REQUIRED.
      const updated = await client.mailbox.updateMany({
        where: { id: mailboxId, status: MAILBOX_STATUS_ACTIVE },
        data: { status: MAILBOX_STATUS_RECONNECT_REQUIRED },
      });
      return updated.count > 0;
    },
    async markMailboxReconnectRequiredIfSubscriptionExpired(
      mailboxId: string,
    ): Promise<boolean> {
      // TASK-083 — recovery variant of the conditional mark, pinned from
      // SUBSCRIPTION_EXPIRED so no concurrently-written state is overwritten.
      const updated = await client.mailbox.updateMany({
        where: { id: mailboxId, status: MAILBOX_STATUS_SUBSCRIPTION_EXPIRED },
        data: { status: MAILBOX_STATUS_RECONNECT_REQUIRED },
      });
      return updated.count > 0;
    },
    async markMailboxActiveIfSubscriptionExpired(
      mailboxId: string,
    ): Promise<boolean> {
      // TASK-083 — the conditional recovery flip. ACTIVE is only ever the
      // FINAL step after the ensure seam proved a usable subscription exists;
      // the status condition guarantees a concurrent DISABLED /
      // RECONNECT_REQUIRED / reconnect-ACTIVE write is never overwritten.
      const updated = await client.mailbox.updateMany({
        where: { id: mailboxId, status: MAILBOX_STATUS_SUBSCRIPTION_EXPIRED },
        data: { status: MAILBOX_STATUS_ACTIVE },
      });
      return updated.count > 0;
    },
    async markSubscriptionExpired(subscriptionId: string): Promise<void> {
      await client.graphSubscription.updateMany({
        where: { subscriptionId },
        data: { status: SUBSCRIPTION_STATUS_EXPIRED },
      });
    },
  };
}

// ---------------------------------------------------------------------------
// Ensure + remote cleanup ports (thin wrappers over existing seams)
// ---------------------------------------------------------------------------

export function createReconciliationEnsurePort(): ReconciliationEnsurePort {
  return {
    async ensure(input) {
      // TASK-081 seam as-is: blocking-row re-check, 20s timeout with real
      // cancellation, fail-open, compensating DELETE on persist failure.
      return ensureInboxSubscriptionForConnectedMailbox(input);
    },
  };
}

export function createReconciliationRemoteCleanupPort(): ReconciliationRemoteCleanupPort {
  return {
    async deleteRemoteSubscription({ mailboxId, subscriptionId, accessToken }) {
      // Same finite ceiling the connect-time path uses so an operator run can
      // never hang on Microsoft during cleanup.
      const timeoutFetch = ((url: RequestInfo | URL, init?: RequestInit) =>
        fetchWithTimeout(fetch, String(url), init ?? {}, {
          timeoutMs: CONNECT_SUBSCRIPTION_HTTP_TIMEOUT_MS,
        })) as typeof fetch;
      await deleteGraphSubscription(
        { mailboxId, subscriptionId, accessToken },
        { fetchImpl: timeoutFetch },
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Default dependency wiring
// ---------------------------------------------------------------------------

export function buildDefaultSubscriptionReconciliationDeps(
  overrides: Partial<SubscriptionReconciliationDeps> = {},
): SubscriptionReconciliationDeps {
  return {
    repo: overrides.repo ?? createPrismaReconciliationRepo(),
    // Reuse the renewal worker's production token path unchanged: decrypt →
    // refreshMicrosoftAccessToken → persistRotatedRefreshToken (encrypted) →
    // in-memory access token, with TASK-069C classification on failure. The
    // finite timeout (same 20s ceiling as every other reconciliation Microsoft
    // HTTP call) keeps the operator one-shot from hanging on a stuck token
    // endpoint; a timeout classifies as transient, never reconnect.
    accessToken:
      overrides.accessToken ??
      createPrismaRenewalAccessTokenPort(undefined, {
        timeoutMs: CONNECT_SUBSCRIPTION_HTTP_TIMEOUT_MS,
      }),
    ensure: overrides.ensure ?? createReconciliationEnsurePort(),
    remoteCleanup: overrides.remoteCleanup ?? createReconciliationRemoteCleanupPort(),
    logger: overrides.logger,
    now: overrides.now,
  };
}

// ---------------------------------------------------------------------------
// CLI argument parsing (kept here so the script stays a thin, untested shell)
// ---------------------------------------------------------------------------

export interface ReconciliationCliOptions {
  mode: ReconciliationMode;
  limit: number;
  limitClamped: boolean;
  /** TASK-083 — true only when the operator explicitly requested recovery. */
  recoverSubscriptionExpired: boolean;
}

export type ReconciliationCliParseResult =
  | { ok: true; options: ReconciliationCliOptions }
  | { ok: false; error: string };

/**
 * Parse the one-shot CLI arguments. Defaults to a dry run; only an explicit
 * `--apply` selects the mutating mode. `--limit <n>` accepts a positive
 * integer and is deterministically clamped to the code-level hard maximum.
 * `--recover-subscription-expired` (TASK-083) opts into the recovery mode for
 * SUBSCRIPTION_EXPIRED mailboxes — absent, the run is plain TASK-082
 * reconciliation. There is intentionally NO concurrency option.
 */
export function parseReconciliationCliArgs(
  argv: string[],
): ReconciliationCliParseResult {
  let mode: ReconciliationMode = 'dry_run';
  let requestedLimit: number | undefined;
  let recoverSubscriptionExpired = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--apply') {
      mode = 'apply';
      continue;
    }
    if (arg === '--dry-run') {
      // Explicit alias of the default, accepted for operator clarity.
      continue;
    }
    if (arg === '--recover-subscription-expired') {
      recoverSubscriptionExpired = true;
      continue;
    }
    if (arg === '--limit') {
      const raw = argv[i + 1];
      if (raw === undefined) {
        return { ok: false, error: '--limit requires a value' };
      }
      const parsed = Number(raw);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return { ok: false, error: '--limit must be a positive integer' };
      }
      requestedLimit = parsed;
      i += 1;
      continue;
    }
    return { ok: false, error: `unknown argument: ${arg}` };
  }

  try {
    const { limit, clamped } = resolveReconciliationLimit(requestedLimit);
    return {
      ok: true,
      options: {
        mode,
        limit,
        limitClamped: clamped,
        recoverSubscriptionExpired,
      },
    };
  } catch (error) {
    if (error instanceof ReconciliationValidationError) {
      return { ok: false, error: error.message };
    }
    throw error;
  }
}
