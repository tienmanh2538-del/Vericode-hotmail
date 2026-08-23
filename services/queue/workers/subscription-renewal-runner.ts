// TASK-032 — Scheduler + Prisma-backed adapters for the subscription renewal
// worker. Importing this module does NOT start any timers or open any
// connections; the CLI entry (or future server instrumentation) must call
// `startSubscriptionRenewalScheduler()` explicitly.

import { prisma as defaultPrisma } from '@/lib/prisma';
import { decryptSecret } from '@/lib/security/encryption';
import { createLogger, type Logger } from '@/lib/logger';
import { loadSubscriptionRenewalEnv } from '@/lib/env';
import { refreshMicrosoftAccessToken } from '@/services/microsoft/refresh-access-token.service';
import { persistRotatedRefreshToken } from '@/services/microsoft/refresh-token-rotation.service';
import { classifyRefreshTokenError } from '@/services/microsoft/refresh-token-failure';
import { renewGraphSubscription } from '@/services/microsoft/graph-subscription.service';
import { BLOCKING_SUBSCRIPTION_STATUSES } from '@/services/microsoft/mailbox-subscription-provisioning.service';
import { createAuditLogInDb } from '@/services/logs/prisma-audit-log-store';
import {
  runSubscriptionRenewalOnce,
  SubscriptionRenewalTokenError,
  type RenewSubscriptionPort,
  type RenewableSubscriptionCandidate,
  type RenewalAccessTokenPort,
  type RenewalCredential,
  type RenewalAuditPort,
  type SubscriptionClaim,
  type SubscriptionRenewalDeps,
  type SubscriptionRenewalRepo,
  type SubscriptionRenewalRunResult,
} from '@/services/microsoft/subscription-renewal.service';

const MAILBOX_STATUS_ACTIVE = 'ACTIVE';
const MAILBOX_STATUS_RECONNECT_REQUIRED = 'RECONNECT_REQUIRED';
const MAILBOX_STATUS_SUBSCRIPTION_EXPIRED = 'SUBSCRIPTION_EXPIRED';
const SUBSCRIPTION_STATUS_ACTIVE = 'ACTIVE';
const SUBSCRIPTION_STATUS_RENEWING = 'RENEWING';
const SUBSCRIPTION_STATUS_FAILED = 'FAILED';
const SUBSCRIPTION_STATUS_EXPIRED = 'EXPIRED';
const MAILBOX_STATUS_DISABLED = 'DISABLED';

// TASK-084 — a RENEWING row is considered abandoned (claimable by another worker)
// once its claim generation is older than this. 30 min = 2× the default 15-min
// scheduler interval, so a healthy in-flight renewal is never reclaimed. Code-level
// constant by design (D2) — NOT an env knob.
const STALE_CLAIM_CUTOFF_MS = 30 * 60 * 1000;

// TASK-069C — the revoke-vs-transient decision now lives in the shared
// `classifyRefreshTokenError` helper so all three workers stay in lockstep.

// ---------------------------------------------------------------------------
// Prisma-backed repo
// ---------------------------------------------------------------------------

interface GraphSubscriptionCandidateRow {
  id: string;
  mailboxId: string;
  subscriptionId: string;
  expirationDateTime: Date;
  mailbox: { status: string; emailAddress: string } | null;
}

interface CountResult {
  count: number;
}

interface ClaimGenerationRow {
  updatedAt: Date;
  status: string;
}

interface SubscriptionRenewalPrismaClient {
  graphSubscription: {
    findMany: (args: unknown) => Promise<GraphSubscriptionCandidateRow[]>;
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<CountResult>;
    findUnique: (args: {
      where: { subscriptionId: string };
      select: Record<string, boolean>;
    }) => Promise<ClaimGenerationRow | null>;
  };
  mailbox: {
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<CountResult>;
  };
}

export interface SubscriptionRenewalRepoOptions {
  /** Injectable clock so the stale-claim cutoff is deterministic in tests. */
  now?: () => Date;
}

export function createPrismaSubscriptionRenewalRepo(
  client: SubscriptionRenewalPrismaClient = defaultPrisma as unknown as SubscriptionRenewalPrismaClient,
  options: SubscriptionRenewalRepoOptions = {},
): SubscriptionRenewalRepo {
  const now = options.now ?? (() => new Date());
  return {
    async listRenewableCandidates(): Promise<RenewableSubscriptionCandidate[]> {
      // TASK-084 — pre-filter in SQL: a mailbox that is not disabled AND a row
      // that is claimable (ACTIVE/FAILED, or a RENEWING whose claim generation is
      // already stale). Fresh RENEWING rows are excluded so a healthy in-flight
      // renewal on another worker is never picked up as work. The service still
      // re-validates the expiration window so selection stays testable.
      const staleCutoff = new Date(now().getTime() - STALE_CLAIM_CUTOFF_MS);
      const rows = await client.graphSubscription.findMany({
        where: {
          mailbox: { is: { status: { not: MAILBOX_STATUS_DISABLED } } },
          OR: [
            {
              status: {
                in: [SUBSCRIPTION_STATUS_ACTIVE, SUBSCRIPTION_STATUS_FAILED],
              },
            },
            {
              status: SUBSCRIPTION_STATUS_RENEWING,
              updatedAt: { lt: staleCutoff },
            },
          ],
        },
        select: {
          id: true,
          mailboxId: true,
          subscriptionId: true,
          expirationDateTime: true,
          mailbox: { select: { status: true, emailAddress: true } },
        },
        orderBy: { expirationDateTime: 'asc' },
      });
      return rows.map((row) => ({
        id: row.id,
        mailboxId: row.mailboxId,
        subscriptionId: row.subscriptionId,
        emailAddress: row.mailbox?.emailAddress ?? '',
        mailboxStatus: row.mailbox?.status ?? MAILBOX_STATUS_DISABLED,
        expirationDateTime: row.expirationDateTime,
      }));
    },

    async claimForRenewal(subscriptionId, claimNow): Promise<SubscriptionClaim> {
      const notClaimed: SubscriptionClaim = {
        claimed: false,
        claimGeneration: null,
        reclaimedStale: false,
      };
      // TASK-084 B3 — the operation MINTS its own generation token and writes it
      // EXPLICITLY. The ownership token is this exact value, held locally; it is
      // NEVER replaced by a value read back from the DB (doing so would let a
      // stalled worker adopt a stale-reclaimer's generation and hijack the row).
      const claimTimestamp = new Date(claimNow.getTime());

      // Step 1 — fresh claim from ACTIVE/FAILED. Atomic: exactly one racing worker
      // flips the row to RENEWING and stamps its own generation (count = 1); the
      // loser sees count = 0. `updatedAt` is set explicitly (Prisma uses the
      // supplied value for the @updatedAt column) so the generation is ours.
      let reclaimedStale = false;
      let won = await client.graphSubscription.updateMany({
        where: {
          subscriptionId,
          status: {
            in: [SUBSCRIPTION_STATUS_ACTIVE, SUBSCRIPTION_STATUS_FAILED],
          },
        },
        data: { status: SUBSCRIPTION_STATUS_RENEWING, updatedAt: claimTimestamp },
      });
      if (won.count === 0) {
        // Step 2 — stale reclaim: a RENEWING row whose generation is older than
        // the cutoff (the previous claimant stalled/died). We overwrite it with
        // OUR generation, distinguished so the staleReclaimed counter is accurate.
        const staleCutoff = new Date(claimNow.getTime() - STALE_CLAIM_CUTOFF_MS);
        won = await client.graphSubscription.updateMany({
          where: {
            subscriptionId,
            status: SUBSCRIPTION_STATUS_RENEWING,
            updatedAt: { lt: staleCutoff },
          },
          data: { status: SUBSCRIPTION_STATUS_RENEWING, updatedAt: claimTimestamp },
        });
        if (won.count > 0) reclaimedStale = true;
      }
      if (won.count === 0) return notClaimed;

      // Read back ONLY to VERIFY the DB round-tripped our exact generation and no
      // concurrent write intervened. This is a fail-closed check, NOT the source
      // of the token: if the stored `updatedAt` is not byte-for-byte our
      // `claimTimestamp` (Prisma/PostgreSQL did not honour the explicit value, or
      // a disconnect / stale-reclaimer overwrote it between our write and this
      // read), we do NOT own the row — treat the claim as lost and apply zero
      // side effects. The ownership token returned is ALWAYS our own
      // `claimTimestamp`, never the read-back value.
      const row = await client.graphSubscription.findUnique({
        where: { subscriptionId },
        select: { updatedAt: true, status: true },
      });
      if (
        !row ||
        row.status !== SUBSCRIPTION_STATUS_RENEWING ||
        !(row.updatedAt instanceof Date) ||
        row.updatedAt.getTime() !== claimTimestamp.getTime()
      ) {
        return notClaimed;
      }
      return { claimed: true, claimGeneration: claimTimestamp, reclaimedStale };
    },

    async markRenewedIfOwner({
      subscriptionId,
      claimGeneration,
      newExpirationDateTime,
      now: renewedAt,
    }): Promise<boolean> {
      const res = await client.graphSubscription.updateMany({
        where: {
          subscriptionId,
          status: SUBSCRIPTION_STATUS_RENEWING,
          updatedAt: claimGeneration,
        },
        data: {
          status: SUBSCRIPTION_STATUS_ACTIVE,
          expirationDateTime: newExpirationDateTime,
          lastRenewedAt: renewedAt,
        },
      });
      return res.count > 0;
    },

    async markSubscriptionFailedIfOwner(subscriptionId, claimGeneration): Promise<boolean> {
      const res = await client.graphSubscription.updateMany({
        where: {
          subscriptionId,
          status: SUBSCRIPTION_STATUS_RENEWING,
          updatedAt: claimGeneration,
        },
        data: { status: SUBSCRIPTION_STATUS_FAILED },
      });
      return res.count > 0;
    },

    async markSubscriptionExpiredIfOwner(subscriptionId, claimGeneration): Promise<boolean> {
      const res = await client.graphSubscription.updateMany({
        where: {
          subscriptionId,
          status: SUBSCRIPTION_STATUS_RENEWING,
          updatedAt: claimGeneration,
        },
        data: { status: SUBSCRIPTION_STATUS_EXPIRED },
      });
      return res.count > 0;
    },

    async markMailboxSubscriptionExpiredIfNoOtherLiveSubscription({
      mailboxId,
      failingSubscriptionRowId,
      now: expiredNow,
    }): Promise<boolean> {
      // TASK-083 protection. A single relation-predicate UPDATE: transition the
      // mailbox to SUBSCRIPTION_EXPIRED only while it is still ACTIVE and NO OTHER
      // possibly-live GraphSubscription exists (TASK-081/082 source-of-truth,
      // excluding the failing row itself). If a replacement subscription is live,
      // the predicate does not match and the mailbox keeps ACTIVE.
      const res = await client.mailbox.updateMany({
        where: {
          id: mailboxId,
          status: MAILBOX_STATUS_ACTIVE,
          graphSubscriptions: {
            none: {
              id: { not: failingSubscriptionRowId },
              status: { in: [...BLOCKING_SUBSCRIPTION_STATUSES] },
              expirationDateTime: { gt: expiredNow },
            },
          },
        },
        data: { status: MAILBOX_STATUS_SUBSCRIPTION_EXPIRED },
      });
      return res.count > 0;
    },

    async markMailboxReconnectRequiredIfCredentialCurrent(
      mailboxId,
      credentialGeneration,
    ): Promise<boolean> {
      // TASK-084 correction B. Mark RECONNECT_REQUIRED only when the mailbox is
      // not operator-DISABLED AND its stored credential generation still equals
      // the one this operation used. A Prisma `equals` of `null` compiles to
      // `IS NULL`, so a "no credential" Case A capture is matched correctly and a
      // concurrent OAuth reconnect (which writes a new, non-null credential) makes
      // the predicate miss → count 0 → the freshly reconnected mailbox is left
      // ACTIVE. The credential value is an OPAQUE marker; it is never logged.
      const res = await client.mailbox.updateMany({
        where: {
          id: mailboxId,
          status: { not: MAILBOX_STATUS_DISABLED },
          encryptedRefreshToken: credentialGeneration,
        },
        data: { status: MAILBOX_STATUS_RECONNECT_REQUIRED },
      });
      return res.count > 0;
    },
  };
}

// ---------------------------------------------------------------------------
// Access token port (decrypt + refresh, classify revoke vs transient)
// ---------------------------------------------------------------------------

interface MailboxRefreshTokenSlice {
  encryptedRefreshToken: string | null;
}

interface MailboxRefreshTokenPrismaClient {
  mailbox: {
    findUnique: (args: unknown) => Promise<MailboxRefreshTokenSlice | null>;
    // TASK-085 — rotation persistence now writes via a conditional `updateMany`
    // (credential-generation CAS) inside `persistRotatedRefreshToken`.
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
}

export interface RenewalAccessTokenPortOptions {
  // TASK-082 — optional finite ceiling for the token-endpoint HTTP request,
  // forwarded to `refreshMicrosoftAccessToken` (TASK-080 seam: real
  // AbortController cancellation; a timeout surfaces as a `network` error →
  // transient, never reconnect). Omitted ⇒ unchanged behaviour (no timeout)
  // for the existing renewal caller.
  timeoutMs?: number;
}

/**
 * Shared core: decrypt the stored refresh token, exchange it, persist any
 * rotation, and report the mailbox credential generation the operation committed
 * to (TASK-084). The credential generation is the OPAQUE `encryptedRefreshToken`
 * marker — the value read at start for Case A failures, or the post-rotation
 * value for a successful exchange (Case B). It is never logged or decrypted for
 * logging.
 */
async function acquireRenewalCredential(
  mailboxId: string,
  client: MailboxRefreshTokenPrismaClient,
  options: RenewalAccessTokenPortOptions,
): Promise<RenewalCredential> {
  const row = await client.mailbox.findUnique({
    where: { id: mailboxId },
    select: { encryptedRefreshToken: true },
  });
  const initialGeneration = row?.encryptedRefreshToken ?? null;
  if (!row || !row.encryptedRefreshToken) {
    // No usable credential — the mailbox must be reconnected. The generation is
    // null so the reconnect writer only marks a mailbox that still has no token.
    throw new SubscriptionRenewalTokenError(
      'reconnect_required',
      'mailbox has no encrypted refresh token',
      null,
    );
  }

  let plaintextRefreshToken: string;
  try {
    plaintextRefreshToken = decryptSecret(row.encryptedRefreshToken);
  } catch {
    // Never include the underlying error — it may leak ciphertext/key context. A
    // decrypt failure means the stored token is unusable; the generation is the
    // exact ciphertext read so a concurrent reconnect (new ciphertext) is detected.
    throw new SubscriptionRenewalTokenError(
      'reconnect_required',
      'failed to decrypt refresh token',
      initialGeneration,
    );
  }

  try {
    const exchanged = await refreshMicrosoftAccessToken(plaintextRefreshToken, {
      timeoutMs: options.timeoutMs,
    });
    // TASK-036 — persist a rotated refresh token (encrypted) so renewal does not
    // silently lose mailbox access on the next cycle. No-op when Microsoft did
    // not return a new token. TASK-085 — the write is a credential-generation CAS
    // guarded by `initialGeneration` (G0): a stale/late rotation cannot overwrite
    // a newer credential or a DISABLED mailbox. TASK-084 Case B — the committed
    // generation is used for the reconnect guard ONLY when it was persisted; on a
    // CAS loss the helper returns no ciphertext, so we fall back to G0 (the
    // credential this operation actually used), which fails the status guard
    // closed against the newer stored generation.
    const persistResult = await persistRotatedRefreshToken(
      mailboxId,
      exchanged.refreshToken,
      initialGeneration,
      { prisma: client },
    );
    const credentialGeneration =
      persistResult.encryptedRefreshToken ?? initialGeneration;
    return { accessToken: exchanged.accessToken, credentialGeneration };
  } catch (error) {
    // TASK-069C — shared classification: revoke (invalid_grant /
    // interaction_required) → reconnect_required; config → config; everything
    // else (network/429/5xx/unknown) → transient so the next tick retries instead
    // of permanently disabling a possibly-fine mailbox.
    const kind = classifyRefreshTokenError(error);
    throw new SubscriptionRenewalTokenError(
      kind,
      'failed to exchange refresh token',
      kind === 'reconnect_required' ? initialGeneration : null,
    );
  }
}

/**
 * String-returning access-token port. Kept for callers that only need the access
 * token and not the credential generation (the TASK-082 reconciliation worker
 * reuses this). Its return contract is intentionally unchanged.
 */
export function createPrismaRenewalAccessTokenPort(
  client: MailboxRefreshTokenPrismaClient = defaultPrisma as unknown as MailboxRefreshTokenPrismaClient,
  options: RenewalAccessTokenPortOptions = {},
): { getAccessTokenForMailbox(mailboxId: string): Promise<string> } {
  return {
    async getAccessTokenForMailbox(mailboxId): Promise<string> {
      const credential = await acquireRenewalCredential(mailboxId, client, options);
      return credential.accessToken;
    },
  };
}

/**
 * TASK-084 — access-token port that also reports the mailbox credential
 * generation, used by the subscription renewal worker so its reconnect-required
 * writer can guard against a concurrent OAuth reconnect. Shares the exact same
 * decrypt/exchange/rotate core as the string port above.
 */
export function createPrismaRenewalAccessTokenPortWithGeneration(
  client: MailboxRefreshTokenPrismaClient = defaultPrisma as unknown as MailboxRefreshTokenPrismaClient,
  options: RenewalAccessTokenPortOptions = {},
): RenewalAccessTokenPort {
  return {
    async getAccessTokenForMailbox(mailboxId): Promise<RenewalCredential> {
      return acquireRenewalCredential(mailboxId, client, options);
    },
  };
}

// ---------------------------------------------------------------------------
// Renew port (delegates to the existing graph-subscription service)
// ---------------------------------------------------------------------------

export function createGraphRenewSubscriptionPort(): RenewSubscriptionPort {
  return {
    async renew({ mailboxId, subscriptionId, accessToken, now }) {
      // TASK-084 — renewGraphSubscription is now a THIN Graph PATCH adapter: it
      // performs PATCH /subscriptions/{id} (expiration = now + 6 days) and parses
      // the remote expiration only. All local state persistence (ACTIVE /
      // expiration / lastRenewedAt) is applied by the renewal service under CAS
      // ownership after this returns — never inside the Graph adapter.
      const result = await renewGraphSubscription({
        mailboxId,
        subscriptionId,
        accessToken,
        now,
      });
      return { newExpirationDateTime: result.expirationDateTime };
    },
  };
}

// ---------------------------------------------------------------------------
// Audit port
// ---------------------------------------------------------------------------

export const prismaRenewalAuditPort: RenewalAuditPort = {
  async recordRenewed(input) {
    // Metadata is intentionally limited to non-sensitive identifiers; the audit
    // service additionally sanitizes any secret-like keys. Persisted to the DB
    // so the renewal worker's audit entries are visible in the admin UI.
    await createAuditLogInDb({
      action: 'SUBSCRIPTION_RENEWED',
      entityType: 'subscription',
      entityId: input.graphSubscriptionId,
      severity: 'info',
      metadata: {
        mailboxId: input.mailboxId,
        graphSubscriptionId: input.graphSubscriptionId,
        oldExpirationDateTime: input.oldExpirationDateTime.toISOString(),
        newExpirationDateTime: input.newExpirationDateTime.toISOString(),
      },
    });
  },
};

// ---------------------------------------------------------------------------
// Default dependency wiring
// ---------------------------------------------------------------------------

export function buildDefaultSubscriptionRenewalDeps(
  overrides: Partial<SubscriptionRenewalDeps> = {},
): SubscriptionRenewalDeps {
  const env = loadSubscriptionRenewalEnv();
  return {
    repo: overrides.repo ?? createPrismaSubscriptionRenewalRepo(),
    accessToken:
      overrides.accessToken ?? createPrismaRenewalAccessTokenPortWithGeneration(),
    renew: overrides.renew ?? createGraphRenewSubscriptionPort(),
    audit: overrides.audit ?? prismaRenewalAuditPort,
    logger: overrides.logger,
    now: overrides.now,
    renewWithinMs: overrides.renewWithinMs ?? env.renewWithinMs,
    maxRenewAttempts: overrides.maxRenewAttempts,
    sleep: overrides.sleep,
  };
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

export interface SubscriptionRenewalSchedulerOptions {
  intervalMs?: number;
  deps?: SubscriptionRenewalDeps;
  logger?: Logger;
}

export interface SubscriptionRenewalSchedulerHandle {
  stop: () => Promise<void>;
}

/**
 * Start a setInterval loop that runs the renewal cycle every `intervalMs`. Each
 * tick is awaited so cycles never overlap. Calling `stop()` clears the interval
 * and waits for any in-flight tick.
 *
 * NOT started on import — invoke explicitly from a worker entry script.
 */
export function startSubscriptionRenewalScheduler(
  options: SubscriptionRenewalSchedulerOptions = {},
): SubscriptionRenewalSchedulerHandle {
  const env = loadSubscriptionRenewalEnv();
  const intervalMs = options.intervalMs ?? env.intervalSeconds * 1_000;
  const deps = options.deps ?? buildDefaultSubscriptionRenewalDeps();
  const logger = options.logger ?? createLogger();

  let stopped = false;
  let inflight: Promise<SubscriptionRenewalRunResult> | null = null;

  const emptyResult: SubscriptionRenewalRunResult = {
    checkedCount: 0,
    renewedCount: 0,
    skippedCount: 0,
    failedCount: 0,
    reconnectRequiredCount: 0,
    expiredCount: 0,
    claimLostCount: 0,
    staleReclaimedCount: 0,
  };

  const tick = async (): Promise<void> => {
    if (stopped) return;
    if (inflight !== null) {
      logger.warn('Subscription renewal skipping tick — previous still running');
      return;
    }
    inflight = runSubscriptionRenewalOnce(deps).catch((error) => {
      logger.error('Subscription renewal tick raised unexpectedly', {
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
      return emptyResult;
    });
    try {
      await inflight;
    } finally {
      inflight = null;
    }
  };

  void tick();
  const timer = setInterval(() => {
    void tick();
  }, intervalMs);

  logger.info('Subscription renewal scheduler started', {
    intervalSeconds: Math.round(intervalMs / 1_000),
  });

  return {
    async stop(): Promise<void> {
      stopped = true;
      clearInterval(timer);
      if (inflight !== null) {
        try {
          await inflight;
        } catch {
          // Already logged in tick().
        }
      }
      logger.info('Subscription renewal scheduler stopped');
    },
  };
}
