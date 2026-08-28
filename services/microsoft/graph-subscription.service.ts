import { randomBytes, timingSafeEqual } from 'node:crypto';

import { prisma as defaultPrisma } from '@/lib/prisma';
import { requireGraphSubscriptionEnv, type EnvValues } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { hashSensitiveValue } from '@/lib/security/redact';
import {
  isUniqueConstraintError,
  uniqueConstraintTargetIncludes,
} from '@/lib/db/prisma-error';

const logger = createLogger();

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const SUBSCRIPTIONS_PATH = '/subscriptions';
const INBOX_RESOURCE = "/me/mailFolders('Inbox')/messages";
const CHANGE_TYPE_CREATED = 'created';

// Outlook message subscriptions accept up to ~4230 minutes (~70 hours) on some
// historical docs but the documented maximum for Outlook resources is 4230
// minutes for messages and 7 days for some resources. To stay well within the
// safe 3-day floor Microsoft sometimes enforces and yet not chase the ceiling,
// we default to 6 days from "now" — long enough to amortize renewal cost,
// short enough that one missed renewal does not stall mail processing.
const DEFAULT_EXPIRATION_MS = 6 * 24 * 60 * 60 * 1000;
// Hard ceiling to protect callers from accidentally requesting an expiration
// longer than Microsoft accepts. Anything > 7 days is rejected by Graph.
const MAX_EXPIRATION_MS = 7 * 24 * 60 * 60 * 1000;

// clientState must be ≤ 128 chars per task spec (Graph allows up to 255).
// 48 random bytes encoded as base64url yields 64 chars: half the cap,
// 384 bits of entropy. Safe even if Microsoft later tightens the limit.
const CLIENT_STATE_BYTES = 48;
const CLIENT_STATE_MAX_LENGTH = 128;

const ACTIVE_STATUS: GraphSubscriptionStatus = 'ACTIVE';
const EXPIRED_STATUS: GraphSubscriptionStatus = 'EXPIRED';

// TASK-086 — name of the PARTIAL unique index that enforces "at most one live
// GraphSubscription per mailbox" at the database level (raw SQL migration; see
// prisma/migrations/*_task086_one_live_graph_subscription). Exported so the
// error-classification below and the tests both reference the same identifier
// Prisma reports in `meta.target` — never a hand-typed duplicate string.
export const GRAPH_SUBSCRIPTION_LIVE_UNIQUE_INDEX =
  'GraphSubscription_mailboxId_live_unique';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type GraphSubscriptionStatus =
  | 'ACTIVE'
  | 'EXPIRED'
  | 'FAILED'
  | 'RENEWING';

export type GraphSubscriptionErrorKind =
  | 'validation'
  | 'config'
  | 'auth'
  | 'permission'
  | 'webhook_validation'
  | 'not_found'
  | 'rate_limited'
  | 'temporary'
  | 'http'
  | 'network'
  | 'parse'
  | 'database'
  // TASK-086 — Microsoft refused the create because a subscription with the same
  // changeType + resource already exists (documented HTTP 409). Defensive only:
  // local correctness never depends on Microsoft serialising concurrent creates.
  | 'conflict'
  // TASK-086 — the remote subscription was created but the local INSERT lost the
  // "at most one live subscription per mailbox" race to a concurrent operation.
  // This is an ownership loss, NOT an infrastructure failure.
  | 'ownership_conflict';

export class GraphSubscriptionError extends Error {
  readonly kind: GraphSubscriptionErrorKind;
  readonly httpStatus?: number;
  readonly graphErrorCode?: string;

  constructor(
    kind: GraphSubscriptionErrorKind,
    message: string,
    options?: { httpStatus?: number; graphErrorCode?: string },
  ) {
    super(message);
    this.name = 'GraphSubscriptionError';
    this.kind = kind;
    this.httpStatus = options?.httpStatus;
    this.graphErrorCode = options?.graphErrorCode;
  }
}

export interface CreateInboxSubscriptionInput {
  mailboxId: string;
  accessToken: string;
  notificationUrl?: string;
  lifecycleNotificationUrl?: string;
  now?: Date;
  expirationDateTime?: Date;
}

export interface GraphSubscriptionResult {
  id: string;
  mailboxId: string;
  subscriptionId: string;
  resource: string;
  expirationDateTime: Date;
  status: GraphSubscriptionStatus;
}

export interface RenewGraphSubscriptionInput {
  mailboxId: string;
  subscriptionId: string;
  accessToken: string;
  now?: Date;
  expirationDateTime?: Date;
}

export interface DeleteGraphSubscriptionInput {
  mailboxId: string;
  subscriptionId: string;
  accessToken: string;
}

export interface GraphSubscriptionPayload {
  changeType: 'created';
  notificationUrl: string;
  lifecycleNotificationUrl?: string;
  resource: string;
  expirationDateTime: string;
  clientState: string;
}

// -----------------------------------------------------------------------------
// Prisma surface (minimal slice so tests can inject a fake)
// -----------------------------------------------------------------------------

interface GraphSubscriptionRecord {
  id: string;
  mailboxId: string;
  subscriptionId: string;
  resource: string;
  clientStateHash: string;
  expirationDateTime: Date;
  status: GraphSubscriptionStatus;
  lastRenewedAt: Date | null;
}

interface GraphSubscriptionPrismaClient {
  create: (args: {
    data: {
      mailboxId: string;
      subscriptionId: string;
      resource: string;
      clientStateHash: string;
      expirationDateTime: Date;
      status: GraphSubscriptionStatus;
    };
  }) => Promise<GraphSubscriptionRecord>;
  update: (args: {
    where: { subscriptionId: string };
    data: {
      expirationDateTime?: Date;
      status?: GraphSubscriptionStatus;
      lastRenewedAt?: Date | null;
    };
  }) => Promise<GraphSubscriptionRecord>;
  findUnique: (args: {
    where: { subscriptionId: string };
  }) => Promise<GraphSubscriptionRecord | null>;
}

export interface PrismaClientLike {
  graphSubscription: GraphSubscriptionPrismaClient;
}

export interface GraphSubscriptionDeps {
  prisma?: PrismaClientLike;
  fetchImpl?: typeof fetch;
  env?: EnvValues;
}

// -----------------------------------------------------------------------------
// Helpers (exported for unit tests)
// -----------------------------------------------------------------------------

export function generateClientState(): string {
  const value = randomBytes(CLIENT_STATE_BYTES).toString('base64url');
  if (value.length > CLIENT_STATE_MAX_LENGTH) {
    // Defensive — base64url of 48 bytes is 64 chars, but if CLIENT_STATE_BYTES
    // is ever increased, prevent silently overflowing Microsoft's limit.
    return value.slice(0, CLIENT_STATE_MAX_LENGTH);
  }
  return value;
}

export function hashClientState(clientState: string): string {
  if (typeof clientState !== 'string' || clientState.length === 0) {
    throw new GraphSubscriptionError(
      'validation',
      'clientState is required to compute a hash',
    );
  }
  return hashSensitiveValue(clientState);
}

export function verifyGraphClientState(
  candidatePlaintext: string,
  storedHash: string,
): boolean {
  if (
    typeof candidatePlaintext !== 'string' ||
    candidatePlaintext.length === 0 ||
    typeof storedHash !== 'string' ||
    storedHash.length === 0
  ) {
    return false;
  }
  const candidateHash = hashSensitiveValue(candidatePlaintext);
  const a = Buffer.from(candidateHash, 'utf8');
  const b = Buffer.from(storedHash, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function calculateDefaultSubscriptionExpiration(now: Date = new Date()): Date {
  return new Date(now.getTime() + DEFAULT_EXPIRATION_MS);
}

function clampExpiration(now: Date, requested: Date): Date {
  const requestedMs = requested.getTime();
  const nowMs = now.getTime();
  if (!Number.isFinite(requestedMs)) {
    throw new GraphSubscriptionError(
      'validation',
      'expirationDateTime is not a valid date',
    );
  }
  if (requestedMs <= nowMs) {
    throw new GraphSubscriptionError(
      'validation',
      'expirationDateTime must be in the future',
    );
  }
  const maxAllowed = nowMs + MAX_EXPIRATION_MS;
  if (requestedMs > maxAllowed) {
    return new Date(maxAllowed);
  }
  return requested;
}

export function buildCreateSubscriptionPayload(input: {
  notificationUrl: string;
  lifecycleNotificationUrl?: string;
  expirationDateTime: Date;
  clientState: string;
}): GraphSubscriptionPayload {
  if (typeof input.notificationUrl !== 'string' || input.notificationUrl.length === 0) {
    throw new GraphSubscriptionError('config', 'notificationUrl is required');
  }
  if (typeof input.clientState !== 'string' || input.clientState.length === 0) {
    throw new GraphSubscriptionError('validation', 'clientState is required');
  }
  if (input.clientState.length > CLIENT_STATE_MAX_LENGTH) {
    throw new GraphSubscriptionError(
      'validation',
      `clientState exceeds maximum length of ${CLIENT_STATE_MAX_LENGTH} characters`,
    );
  }

  const payload: GraphSubscriptionPayload = {
    changeType: CHANGE_TYPE_CREATED,
    notificationUrl: input.notificationUrl,
    resource: INBOX_RESOURCE,
    expirationDateTime: input.expirationDateTime.toISOString(),
    clientState: input.clientState,
  };
  if (
    typeof input.lifecycleNotificationUrl === 'string' &&
    input.lifecycleNotificationUrl.length > 0
  ) {
    payload.lifecycleNotificationUrl = input.lifecycleNotificationUrl;
  }
  return payload;
}

// -----------------------------------------------------------------------------
// HTTP layer
// -----------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function requireAccessToken(accessToken: unknown): string {
  if (typeof accessToken !== 'string' || accessToken.trim().length === 0) {
    throw new GraphSubscriptionError('validation', 'access token is required');
  }
  return accessToken;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new GraphSubscriptionError('validation', `${field} is required`);
  }
  return value.trim();
}

function extractGraphErrorCode(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const error = payload.error;
  if (!isRecord(error)) return undefined;
  return readString(error.code);
}

function mapHttpStatusToError(
  status: number,
  graphErrorCode: string | undefined,
): GraphSubscriptionError {
  if (status === 401) {
    return new GraphSubscriptionError('auth', 'GRAPH_AUTH_FAILED', {
      httpStatus: status,
      graphErrorCode,
    });
  }
  if (status === 403) {
    return new GraphSubscriptionError('permission', 'GRAPH_PERMISSION_DENIED', {
      httpStatus: status,
      graphErrorCode,
    });
  }
  if (status === 404) {
    return new GraphSubscriptionError('not_found', 'GRAPH_SUBSCRIPTION_NOT_FOUND', {
      httpStatus: status,
      graphErrorCode,
    });
  }
  if (status === 409) {
    // TASK-086 — Microsoft documents that a create whose changeType + resource
    // duplicates an existing subscription fails with 409. Classified as its own
    // kind so callers can react deliberately (re-read local state) instead of
    // treating it as a generic HTTP failure. It is DEFENSIVE handling only: the
    // local uniqueness guard, not this response, is the correctness boundary.
    return new GraphSubscriptionError('conflict', 'GRAPH_SUBSCRIPTION_CONFLICT', {
      httpStatus: status,
      graphErrorCode,
    });
  }
  if (status === 429) {
    return new GraphSubscriptionError('rate_limited', 'GRAPH_RATE_LIMITED', {
      httpStatus: status,
      graphErrorCode,
    });
  }
  if (status === 400 && graphErrorCode === 'InvalidRequest') {
    // Microsoft uses InvalidRequest for "Subscription validation request failed"
    // when the notificationUrl cannot be reached or did not echo the
    // validationToken correctly. Surface a distinct kind so callers can
    // suggest fixing the webhook endpoint rather than the access token.
    return new GraphSubscriptionError(
      'webhook_validation',
      'GRAPH_WEBHOOK_VALIDATION_FAILED',
      { httpStatus: status, graphErrorCode },
    );
  }
  if (status >= 500 && status <= 599) {
    return new GraphSubscriptionError('temporary', 'GRAPH_TEMPORARY_ERROR', {
      httpStatus: status,
      graphErrorCode,
    });
  }
  return new GraphSubscriptionError('http', 'GRAPH_REQUEST_FAILED', {
    httpStatus: status,
    graphErrorCode,
  });
}

interface GraphHttpRequest {
  method: 'POST' | 'PATCH' | 'DELETE';
  url: string;
  accessToken: string;
  body?: unknown;
  fetchImpl: typeof fetch;
  operationLabel: string;
  expectJson: boolean;
}

interface GraphHttpResponse {
  status: number;
  payload: unknown;
}

async function performGraphRequest(
  request: GraphHttpRequest,
): Promise<GraphHttpResponse> {
  const headers: Record<string, string> = {
    authorization: `Bearer ${request.accessToken}`,
    accept: 'application/json',
  };
  let body: string | undefined;
  if (request.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(request.body);
  }

  let response: Response;
  try {
    response = await request.fetchImpl(request.url, {
      method: request.method,
      headers,
      body,
    });
  } catch {
    logger.error(
      `Microsoft Graph ${request.operationLabel} network call failed`,
    );
    throw new GraphSubscriptionError('network', 'GRAPH_NETWORK_ERROR');
  }

  let payload: unknown = null;
  if (request.expectJson || !response.ok) {
    try {
      const text = await response.text();
      payload = text.length === 0 ? null : JSON.parse(text);
    } catch {
      payload = null;
    }
  }

  if (!response.ok) {
    const graphErrorCode = extractGraphErrorCode(payload);
    logger.warn(`Microsoft Graph ${request.operationLabel} rejected request`, {
      httpStatus: response.status,
      graphErrorCode,
    });
    throw mapHttpStatusToError(response.status, graphErrorCode);
  }

  return { status: response.status, payload };
}

// -----------------------------------------------------------------------------
// Public service
// -----------------------------------------------------------------------------

export async function createInboxSubscription(
  input: CreateInboxSubscriptionInput,
  deps: GraphSubscriptionDeps = {},
): Promise<GraphSubscriptionResult> {
  const mailboxId = requireNonEmpty(input.mailboxId, 'mailboxId');
  const accessToken = requireAccessToken(input.accessToken);

  let notificationUrl: string;
  let lifecycleNotificationUrl: string | undefined;
  if (typeof input.notificationUrl === 'string' && input.notificationUrl.length > 0) {
    notificationUrl = input.notificationUrl;
    lifecycleNotificationUrl = input.lifecycleNotificationUrl;
  } else {
    try {
      const env = requireGraphSubscriptionEnv(deps.env);
      notificationUrl = env.notificationUrl;
      lifecycleNotificationUrl =
        input.lifecycleNotificationUrl ?? env.lifecycleNotificationUrl;
    } catch {
      throw new GraphSubscriptionError(
        'config',
        'Microsoft Graph notificationUrl is not configured',
      );
    }
  }

  const now = input.now ?? new Date();
  const expirationDateTime = clampExpiration(
    now,
    input.expirationDateTime ?? calculateDefaultSubscriptionExpiration(now),
  );

  const clientState = generateClientState();
  const clientStateHash = hashClientState(clientState);

  const payload = buildCreateSubscriptionPayload({
    notificationUrl,
    lifecycleNotificationUrl,
    expirationDateTime,
    clientState,
  });

  const fetchImpl = deps.fetchImpl ?? fetch;
  const url = `${GRAPH_BASE_URL}${SUBSCRIPTIONS_PATH}`;

  const { payload: responsePayload } = await performGraphRequest({
    method: 'POST',
    url,
    accessToken,
    body: payload,
    fetchImpl,
    operationLabel: 'createInboxSubscription',
    expectJson: true,
  });

  if (!isRecord(responsePayload)) {
    throw new GraphSubscriptionError('parse', 'GRAPH_RESPONSE_SHAPE_INVALID');
  }

  const subscriptionId = readString(responsePayload.id);
  if (!subscriptionId) {
    throw new GraphSubscriptionError(
      'parse',
      'GRAPH_RESPONSE_MISSING_SUBSCRIPTION_ID',
    );
  }

  const remoteResource = readString(responsePayload.resource) ?? INBOX_RESOURCE;
  const remoteExpiration = readString(responsePayload.expirationDateTime);
  const persistedExpiration = remoteExpiration
    ? new Date(remoteExpiration)
    : expirationDateTime;
  if (Number.isNaN(persistedExpiration.getTime())) {
    throw new GraphSubscriptionError(
      'parse',
      'GRAPH_RESPONSE_INVALID_EXPIRATION',
    );
  }

  const prisma = deps.prisma ?? (defaultPrisma as unknown as PrismaClientLike);

  let saved: GraphSubscriptionRecord;
  try {
    saved = await prisma.graphSubscription.create({
      data: {
        mailboxId,
        subscriptionId,
        resource: remoteResource,
        clientStateHash,
        expirationDateTime: persistedExpiration,
        status: ACTIVE_STATUS,
      },
    });
  } catch (persistError) {
    // TASK-086 — two distinct failure classes share one compensation, but NOT
    // one meaning:
    //   * unique-constraint violation on the live-per-mailbox partial index →
    //     a concurrent operation already owns the mailbox's live slot. This is
    //     an OWNERSHIP LOSS: our remote subscription is the loser and must be
    //     removed, but nothing is broken. A P2002 on `subscriptionId` is NOT
    //     this case (it would mean Microsoft handed back an id we already
    //     store) and stays a generic database failure.
    //   * anything else → generic infrastructure failure, TASK-081 semantics.
    const ownershipLost =
      isUniqueConstraintError(persistError) &&
      uniqueConstraintTargetIncludes(
        persistError,
        GRAPH_SUBSCRIPTION_LIVE_UNIQUE_INDEX,
      );

    // Do not log the response payload or the raw error — the payload contains
    // clientState plaintext we sent and Microsoft echoes back on 201, and a raw
    // driver error can carry row/connection metadata.
    if (ownershipLost) {
      logger.info('Graph subscription live slot already owned — releasing ours', {
        mailboxId,
      });
    } else {
      logger.error('Failed to persist Graph subscription', { mailboxId });
    }

    // TASK-081 — the remote subscription now exists but no local row records
    // it, so nothing (webhook validation, renewal, disconnect cleanup) would
    // ever see it. Best-effort compensating remote DELETE, exactly once: if the
    // cleanup itself fails we log sanitized and stop — never retried, never a
    // fake local ACTIVE row, and the error below still propagates.
    //
    // TASK-086 — the delete targets ONLY `subscriptionId`, the id Microsoft
    // returned for THIS operation's own create. The winner's subscription is
    // never referenced here, and no cleanup is ever keyed by mailboxId.
    try {
      await deleteGraphSubscription({ mailboxId, subscriptionId, accessToken }, deps);
    } catch {
      logger.warn('Compensating Graph subscription delete failed', { mailboxId });
    }

    if (ownershipLost) {
      throw new GraphSubscriptionError(
        'ownership_conflict',
        'GRAPH_SUBSCRIPTION_LIVE_SLOT_TAKEN',
      );
    }
    throw new GraphSubscriptionError(
      'database',
      'failed to persist Graph subscription',
    );
  }

  return {
    id: saved.id,
    mailboxId: saved.mailboxId,
    subscriptionId: saved.subscriptionId,
    resource: saved.resource,
    expirationDateTime: saved.expirationDateTime,
    status: saved.status,
  };
}

// TASK-084 — narrow Graph PATCH adapter for the renewal path.
//
// Ownership/state persistence (RENEWING claim, ACTIVE/FAILED/EXPIRED completion)
// now lives in the renewal repository layer behind atomic claim + CAS, so this
// function is deliberately a THIN Graph operation: it performs the PATCH and
// parses the remote expiration only. It never touches the database — a stale
// worker must not be able to write local subscription state from here and defeat
// the CAS ownership guard. The single renewal caller does all persistence with
// affected-count checks after this returns.
export interface RenewGraphSubscriptionResult {
  subscriptionId: string;
  /** The expiration Microsoft echoed back (or the requested one as a fallback). */
  expirationDateTime: Date;
}

export async function renewGraphSubscription(
  input: RenewGraphSubscriptionInput,
  deps: GraphSubscriptionDeps = {},
): Promise<RenewGraphSubscriptionResult> {
  const subscriptionId = requireNonEmpty(input.subscriptionId, 'subscriptionId');
  const accessToken = requireAccessToken(input.accessToken);

  const now = input.now ?? new Date();
  const expirationDateTime = clampExpiration(
    now,
    input.expirationDateTime ?? calculateDefaultSubscriptionExpiration(now),
  );

  const fetchImpl = deps.fetchImpl ?? fetch;

  const url = `${GRAPH_BASE_URL}${SUBSCRIPTIONS_PATH}/${encodeURIComponent(subscriptionId)}`;
  // The PATCH error propagates unchanged so the renewal service can classify it
  // (auth → reconnect, 404/410 → expired, 429/5xx → transient) and then apply the
  // matching CAS completion. No local FAILED write happens here.
  const result = await performGraphRequest({
    method: 'PATCH',
    url,
    accessToken,
    body: { expirationDateTime: expirationDateTime.toISOString() },
    fetchImpl,
    operationLabel: 'renewGraphSubscription',
    expectJson: true,
  });
  const responsePayload = result.payload;

  const remoteExpiration = isRecord(responsePayload)
    ? readString(responsePayload.expirationDateTime)
    : undefined;
  const nextExpiration = remoteExpiration
    ? new Date(remoteExpiration)
    : expirationDateTime;
  if (Number.isNaN(nextExpiration.getTime())) {
    throw new GraphSubscriptionError(
      'parse',
      'GRAPH_RESPONSE_INVALID_EXPIRATION',
    );
  }

  return { subscriptionId, expirationDateTime: nextExpiration };
}

export async function deleteGraphSubscription(
  input: DeleteGraphSubscriptionInput,
  deps: GraphSubscriptionDeps = {},
): Promise<void> {
  const mailboxId = requireNonEmpty(input.mailboxId, 'mailboxId');
  const subscriptionId = requireNonEmpty(input.subscriptionId, 'subscriptionId');
  const accessToken = requireAccessToken(input.accessToken);

  const fetchImpl = deps.fetchImpl ?? fetch;
  const prisma = deps.prisma ?? (defaultPrisma as unknown as PrismaClientLike);

  const url = `${GRAPH_BASE_URL}${SUBSCRIPTIONS_PATH}/${encodeURIComponent(subscriptionId)}`;

  try {
    await performGraphRequest({
      method: 'DELETE',
      url,
      accessToken,
      fetchImpl,
      operationLabel: 'deleteGraphSubscription',
      expectJson: false,
    });
  } catch (err) {
    if (
      err instanceof GraphSubscriptionError &&
      err.kind === 'not_found'
    ) {
      // Microsoft already forgot about it — converge local state.
    } else {
      throw err;
    }
  }

  try {
    await prisma.graphSubscription.update({
      where: { subscriptionId },
      data: { status: EXPIRED_STATUS },
    });
  } catch {
    logger.warn('Could not mark subscription as EXPIRED after delete', {
      mailboxId,
      subscriptionId,
    });
  }
}

// Internal constants exported for tests that need to assert on URL shape and
// resource string without copying magic values around.
export const __internal = {
  GRAPH_BASE_URL,
  SUBSCRIPTIONS_PATH,
  INBOX_RESOURCE,
  CHANGE_TYPE_CREATED,
  DEFAULT_EXPIRATION_MS,
  MAX_EXPIRATION_MS,
  CLIENT_STATE_MAX_LENGTH,
};
