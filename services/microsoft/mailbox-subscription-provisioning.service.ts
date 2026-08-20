// TASK-081 — Connect-time Graph subscription provisioning (Option A only).
//
// TASK-079 confirmed that `createInboxSubscription` had no production caller:
// a freshly connected/reconnected mailbox never got a Graph subscription, so
// the webhook path never existed for it and the renewal worker had no
// candidate. This service is the missing production caller. The OAuth callback
// invokes it AFTER `saveConnectedMailbox` has succeeded, with the fresh access
// token already minted by the token exchange (no extra token is requested or
// persisted).
//
// Ensure semantics — never blind-create:
//   - a local subscription with status ACTIVE/RENEWING/FAILED whose
//     expirationDateTime is still in the future blocks creation (FAILED is
//     included because the remote subscription may still be live; creating a
//     second one would duplicate webhook notifications);
//   - no such row (none at all, clearly expired, or status EXPIRED) → create.
//
// Fail-open — this function NEVER throws. A provisioning failure of any kind
// (config, Graph 4xx/5xx, network, timeout, DB) is logged sanitized and
// reported via the returned outcome; the connected mailbox and its persisted
// credential are left exactly as `saveConnectedMailbox` wrote them, and delta
// polling remains the backup path. There is no retry loop — the single attempt
// either settles or is aborted by the finite timeout below.

import { prisma as defaultPrisma } from '@/lib/prisma';
import { createLogger, type Logger } from '@/lib/logger';
import { fetchWithTimeout } from '@/lib/http/fetch-with-timeout';
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

// A row in one of these statuses that has not clearly expired is treated as
// possibly live on Microsoft's side and blocks creation. EXPIRED rows never
// block: they are only written when the remote subscription is known gone
// (disconnect, renewal 404/410) or already past its expiration.
const BLOCKING_SUBSCRIPTION_STATUSES: GraphSubscriptionStatus[] = [
  'ACTIVE',
  'RENEWING',
  'FAILED',
];

export type EnsureInboxSubscriptionOutcome =
  | { outcome: 'created'; subscriptionId: string }
  | { outcome: 'skipped_existing'; existingStatus: GraphSubscriptionStatus }
  | { outcome: 'failed'; errorName: string };

export interface EnsureInboxSubscriptionInput {
  mailboxId: string;
  /** Fresh access token from the OAuth token exchange. Never persisted here. */
  accessToken: string;
}

interface ExistingSubscriptionSlice {
  subscriptionId: string;
  status: GraphSubscriptionStatus;
  expirationDateTime: Date;
}

interface EnsurePrismaClient {
  graphSubscription: {
    findFirst: (args: {
      where: {
        mailboxId: string;
        status: { in: GraphSubscriptionStatus[] };
        expirationDateTime: { gt: Date };
      };
      orderBy: { expirationDateTime: 'desc' };
      select: {
        subscriptionId: true;
        status: true;
        expirationDateTime: true;
      };
    }) => Promise<ExistingSubscriptionSlice | null>;
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

/**
 * Ensure the freshly connected mailbox has a usable Graph subscription,
 * creating one only when no possibly-live local subscription exists. Never
 * throws; see the module header for the ensure and fail-open contracts.
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

    const existing = await prisma.graphSubscription.findFirst({
      where: {
        mailboxId,
        status: { in: BLOCKING_SUBSCRIPTION_STATUSES },
        expirationDateTime: { gt: now() },
      },
      orderBy: { expirationDateTime: 'desc' },
      select: { subscriptionId: true, status: true, expirationDateTime: true },
    });

    if (existing) {
      log.info('Graph subscription already usable — skipping create', {
        mailboxId,
        existingStatus: existing.status,
      });
      return { outcome: 'skipped_existing', existingStatus: existing.status };
    }

    const baseFetch = deps.fetchImpl ?? fetch;
    const timeoutFetch = ((url: RequestInfo | URL, init?: RequestInit) =>
      fetchWithTimeout(baseFetch, String(url), init ?? {}, {
        timeoutMs: CONNECT_SUBSCRIPTION_HTTP_TIMEOUT_MS,
      })) as typeof fetch;

    const createSubscription = deps.createSubscription ?? createInboxSubscription;
    const created = await createSubscription(
      { mailboxId, accessToken: input.accessToken },
      { fetchImpl: timeoutFetch },
    );

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
