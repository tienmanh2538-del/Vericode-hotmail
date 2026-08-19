// TASK-031 — Microsoft Graph delta polling backup worker.
//
// Architecture:
//   webhook (primary)   →  enqueue → worker → pipeline → Telegram
//   delta polling (here, backup, every ~30s) →
//          list ACTIVE Microsoft mailboxes →
//          for each: bootstrap cursor OR page delta from cursor →
//          enqueue NEW graphMessageId into the existing TASK-027 pipeline.
//
// This service NEVER:
//   - fetches message bodies
//   - runs the detector / extractor / Telegram sender
//   - logs full email content, full verification codes, or any token
//   - writes to .env / .env.local
//   - mutates the queue/worker contract (only adds a new source value)
//
// Cursor handling follows Microsoft's delta query contract exactly: the
// service stores the FULL `@odata.deltaLink` / `@odata.nextLink` URL returned
// by Graph. It never parses `$deltatoken` / `$skiptoken` and never rebuilds
// URLs from those tokens.

import { createLogger, type Logger } from '@/lib/logger';
import {
  fetchWithTimeout,
  HttpTimeoutError,
} from '@/lib/http/fetch-with-timeout';
import { shouldMarkReconnectRequired } from './refresh-token-failure';

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const INBOX_DELTA_PATH = "/me/mailFolders('inbox')/messages/delta";
const DELTA_PAGE_TOP = '50';
const DEFAULT_MAX_PAGES_PER_MAILBOX = 10;

// TASK-080 — finite per-request ceiling for every Microsoft HTTP call made on the
// delta polling path (Graph delta pages here + the token-refresh request wired in
// the runner). A hung request is aborted after this window so `runDeltaPollingOnce`
// always settles and the scheduler can never wedge on a single stuck cycle
// (root cause confirmed in TASK-079). Not env-tunable in TASK-080 by design.
export const DELTA_POLLING_HTTP_TIMEOUT_MS = 20_000;
// TASK-036 — first-run (bootstrap) safety. Without a cursor, an unbounded delta
// query walks the ENTIRE mailbox to reach the first @odata.deltaLink. On a very
// large mailbox that never converges within the page cap, so the cursor is never
// saved and every cycle re-scans from scratch. We bound the initial scan with a
// receivedDateTime filter — supported by Graph on the messages delta query
// ($filter=receivedDateTime ge {ts}, itself capped at 5,000 messages).
const DEFAULT_BOOTSTRAP_LOOKBACK_HOURS = 24;
const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_MINUTE = 60 * 1000;

// TASK-075 — persistent delta 403 (forbidden) backoff.
//
// A 403 on a Graph DATA request is NOT a dead refresh grant (TASK-071), so it
// must never flip the mailbox to RECONNECT_REQUIRED. But an ACCOUNT/ENDPOINT
// -level 403 (e.g. MailboxNotEnabledForRESTAPI, ErrorAccessDenied) keeps
// returning 403 every cycle even after the TASK-071 cursor self-heal resets the
// cursor and re-bootstraps. Without a brake, the poller hammers Graph (and the
// token endpoint) full-speed forever and stays silent.
//
// Backoff model (per mailbox, persisted in DB so it survives a restart):
//   - Each consecutive forbidden cycle increments `deltaForbiddenCount`.
//   - Below the threshold, we stay full-speed so the TASK-071 cursor self-heal
//     still has a fast chance to recover a merely-poisoned cursor.
//   - At/above the threshold we set an exponential cooldown (capped). While a
//     mailbox is in cooldown the next cycle SKIPS it entirely — no token fetch,
//     no Graph call — and raises one safe admin alert.
//   - Any successful poll clears the count + cooldown + stale error metadata.
const DEFAULT_FORBIDDEN_BACKOFF_THRESHOLD = 3;
const FORBIDDEN_BACKOFF_BASE_MS = 5 * MS_PER_MINUTE;
const FORBIDDEN_BACKOFF_MAX_MS = 60 * MS_PER_MINUTE;

// ---------------------------------------------------------------------------
// Public types & ports
// ---------------------------------------------------------------------------

export interface DeltaPollingMailbox {
  id: string;
  emailAddress: string;
  microsoftDeltaCursor: string | null;
  // TASK-075 — persistent forbidden backoff state. Optional so callers/tests
  // built before TASK-075 keep compiling; absent is treated as "no backoff".
  deltaForbiddenCount?: number;
  deltaForbiddenCooldownUntil?: Date | null;
}

/** Persistence surface — supplied by a Prisma-backed adapter in production. */
export interface DeltaPollingMailboxRepo {
  listActiveMicrosoftMailboxes(): Promise<DeltaPollingMailbox[]>;
  saveDeltaCursor(
    mailboxId: string,
    cursorUrl: string,
    polledAt: Date,
  ): Promise<void>;
  recordDeltaError(
    mailboxId: string,
    safeMessage: string,
    occurredAt: Date,
  ): Promise<void>;
  /**
   * TASK-071 — clear a poisoned delta cursor so the NEXT cycle re-bootstraps from
   * scratch instead of replaying the same rejected deltaLink. Used when a stored
   * cursor request is forbidden (403): a fresh bootstrap is strictly better than
   * a cursor that can no longer mint pages, and the refresh grant is healthy.
   */
  resetDeltaCursor(mailboxId: string): Promise<void>;
  markReconnectRequired(mailboxId: string): Promise<void>;
  /**
   * TASK-075 — persist the per-mailbox persistent-403 backoff state (consecutive
   * forbidden count + optional cooldown) together with the sanitized error
   * metadata in ONE write. `cooldownUntil = null` means "counting, but not yet
   * cooling down". Survives a worker restart.
   */
  recordForbiddenBackoff(
    mailboxId: string,
    count: number,
    cooldownUntil: Date | null,
    occurredAt: Date,
    safeMessage: string,
  ): Promise<void>;
  /**
   * TASK-075/080 — clear the forbidden backoff state (count → 0, cooldown → null)
   * AND the now-stale delta error metadata after a successful poll / self-heal,
   * so the dashboard stops showing a resolved error.
   */
  clearForbiddenBackoff(mailboxId: string): Promise<void>;
}

/** Access-token surface. Implementations decrypt + exchange the refresh token. */
export interface DeltaPollingAccessTokenPort {
  getAccessTokenForMailbox(mailbox: DeltaPollingMailbox): Promise<string>;
}

/** Enqueue surface used to forward newly-discovered Graph message ids. */
export interface DeltaPollingEnqueuePort {
  enqueueMessage(input: {
    mailboxId: string;
    graphMessageId: string;
    queuedAt: string;
  }): Promise<void>;
}

/**
 * TASK-075 — optional admin alert surface. Wired in production to the TASK-035
 * admin alert (Telegram) channel; left undefined in unit tests that do not
 * assert on alerting. The service calls it ONLY when a mailbox crosses the
 * persistent-403 threshold, and never lets an alert failure break the cycle.
 */
export interface DeltaPollingAlertPort {
  raisePersistentForbidden(input: {
    mailboxId: string;
    emailAddressMasked: string;
    consecutiveForbiddenCount: number;
    cooldownUntil: Date;
    /** Sanitized Graph diagnostics (enum codes + request-id) — never a secret. */
    safeDiagnostics: string;
  }): Promise<void>;
}

export interface DeltaPollingDeps {
  repo: DeltaPollingMailboxRepo;
  accessToken: DeltaPollingAccessTokenPort;
  enqueue: DeltaPollingEnqueuePort;
  /** TASK-075 — optional admin alert port for persistent 403 escalation. */
  alert?: DeltaPollingAlertPort;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  now?: () => Date;
  maxPagesPerMailbox?: number;
  /**
   * TASK-036 — how far back the FIRST (bootstrap) sync of a mailbox is allowed
   * to scan, in hours. Applied as $filter=receivedDateTime ge (now - hours) on
   * the initial delta request only. Ignored once a deltaLink cursor exists.
   */
  bootstrapLookbackHours?: number;
  /**
   * TASK-075 — consecutive forbidden (403) cycles a mailbox may accrue before a
   * cooldown + alert kicks in. Defaults to {@link DEFAULT_FORBIDDEN_BACKOFF_THRESHOLD}.
   * Injectable so tests can exercise escalation without running many cycles.
   */
  forbiddenBackoffThreshold?: number;
}

export interface DeltaPollingRunResult {
  checkedMailboxCount: number;
  bootstrappedMailboxCount: number;
  enqueuedMessageCount: number;
  failedMailboxCount: number;
  // TASK-075 — mailboxes skipped this cycle because they are inside a persistent
  // -403 cooldown window. Not counted as failures (no Graph call was attempted).
  cooldownSkippedMailboxCount: number;
}

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface GraphDeltaItem {
  id?: string;
  '@removed'?: unknown;
}

interface GraphDeltaResponse {
  value?: GraphDeltaItem[];
  '@odata.nextLink'?: string;
  '@odata.deltaLink'?: string;
}

// TASK-071 — `forbidden` (HTTP 403) is split out from `auth` (HTTP 401). A 403 on
// a Graph DATA request is NOT a dead refresh grant (the access token was just
// minted from a healthy refresh — see the runner's token port), so it must NOT
// flip the mailbox to RECONNECT_REQUIRED the way a token-endpoint invalid_grant
// does. Only 401 (token rejected outright) keeps the reconnect semantics.
type AuthKind = 'auth' | 'forbidden' | 'transient' | 'unknown';

/** Sanitized diagnostics pulled from a Graph error response (never tokens). */
interface GraphErrorDiagnostics {
  graphErrorCode?: string;
  graphInnerErrorCode?: string;
  graphRequestId?: string;
}

class DeltaPollingHttpError extends Error {
  readonly kind: AuthKind;
  readonly httpStatus: number;
  readonly graphErrorCode?: string;
  readonly graphInnerErrorCode?: string;
  readonly graphRequestId?: string;
  constructor(
    kind: AuthKind,
    httpStatus: number,
    message: string,
    diagnostics: GraphErrorDiagnostics = {},
  ) {
    super(message);
    this.name = 'DeltaPollingHttpError';
    this.kind = kind;
    this.httpStatus = httpStatus;
    this.graphErrorCode = diagnostics.graphErrorCode;
    this.graphInnerErrorCode = diagnostics.graphInnerErrorCode;
    this.graphRequestId = diagnostics.graphRequestId;
  }
}

interface PerMailboxPollOutcome {
  enqueued: number;
  /** Set to a URL when a deltaLink was reached on this run. */
  newCursor: string | null;
  /** True when this run was a bootstrap (no prior cursor existed). */
  bootstrap: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function buildInitialDeltaUrl(bootstrapFromDate?: Date): string {
  // $select=id keeps the payload minimal — we never read bodies in this layer.
  // $top is honored by Graph as a hint; the server caps it.
  const params = new URLSearchParams({ $select: 'id', $top: DELTA_PAGE_TOP });
  if (bootstrapFromDate) {
    // Bound the first sync to recent mail so a huge mailbox converges to a
    // deltaLink quickly. Graph only supports receivedDateTime ge/gt here.
    params.set('$filter', `receivedDateTime ge ${bootstrapFromDate.toISOString()}`);
  }
  return `${GRAPH_BASE_URL}${INBOX_DELTA_PATH}?${params.toString()}`;
}

function classifyHttpStatus(status: number): AuthKind {
  if (status === 401) return 'auth';
  // TASK-071 — 403 on a data request ≠ dead grant → its own kind, never reconnect.
  if (status === 403) return 'forbidden';
  if (status === 429) return 'transient';
  if (status >= 500 && status <= 599) return 'transient';
  return 'unknown';
}

/**
 * TASK-075 — exponential cooldown (ms) for a persistent forbidden streak, capped.
 * The first `threshold - 1` forbidden cycles get no cooldown (count below
 * threshold); the threshold-th cycle gets the base window, then it doubles per
 * additional consecutive forbidden cycle up to the cap.
 */
function forbiddenBackoffMs(count: number, threshold: number): number {
  const steps = Math.max(0, count - threshold);
  const ms = FORBIDDEN_BACKOFF_BASE_MS * 2 ** steps;
  return Math.min(ms, FORBIDDEN_BACKOFF_MAX_MS);
}

/**
 * TASK-071 — pull ONLY enum-like diagnostics from a Graph error response:
 * `error.code`, `error.innerError.code`, and the `request-id` header. Never the
 * human-readable `error.message` (it can echo the address/UPN) and never any
 * token. Best-effort: a non-JSON or unreadable body yields partial diagnostics.
 */
async function readGraphErrorDiagnostics(
  response: Response,
): Promise<GraphErrorDiagnostics> {
  const diagnostics: GraphErrorDiagnostics = {};
  const requestId =
    response.headers.get('request-id') ??
    response.headers.get('client-request-id') ??
    undefined;
  if (requestId) diagnostics.graphRequestId = requestId;
  try {
    const body: unknown = await response.json();
    if (isRecord(body) && isRecord(body.error)) {
      diagnostics.graphErrorCode = readOptionalString(body.error.code);
      if (isRecord(body.error.innerError)) {
        diagnostics.graphInnerErrorCode = readOptionalString(
          body.error.innerError.code,
        );
      }
    }
  } catch {
    // Never throw while building diagnostics — the HTTP error is what matters.
  }
  return diagnostics;
}

async function fetchDeltaPage(
  url: string,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<GraphDeltaResponse> {
  let response: Response;
  try {
    response = await fetchWithTimeout(
      fetchImpl,
      url,
      {
        method: 'GET',
        headers: {
          authorization: `Bearer ${accessToken}`,
          accept: 'application/json',
        },
      },
      { timeoutMs: DELTA_POLLING_HTTP_TIMEOUT_MS },
    );
  } catch (error) {
    // TASK-080 — a timeout is a controlled TRANSIENT failure: it must NOT be
    // classified as 403 (forbidden) and must never trip the persistent-403
    // cooldown (TASK-075) or flip the mailbox to RECONNECT_REQUIRED. Both the
    // timeout and a plain network error map to the same transient kind.
    if (error instanceof HttpTimeoutError) {
      throw new DeltaPollingHttpError('transient', 0, 'GRAPH_TIMEOUT');
    }
    throw new DeltaPollingHttpError('transient', 0, 'GRAPH_NETWORK_ERROR');
  }

  if (!response.ok) {
    const kind = classifyHttpStatus(response.status);
    const diagnostics = await readGraphErrorDiagnostics(response);
    throw new DeltaPollingHttpError(
      kind,
      response.status,
      'GRAPH_REQUEST_FAILED',
      diagnostics,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new DeltaPollingHttpError('unknown', response.status, 'GRAPH_RESPONSE_NOT_JSON');
  }

  if (!isRecord(payload)) {
    throw new DeltaPollingHttpError('unknown', response.status, 'GRAPH_RESPONSE_SHAPE_INVALID');
  }

  return {
    value: Array.isArray(payload.value) ? (payload.value as GraphDeltaItem[]) : undefined,
    '@odata.nextLink': readOptionalString(payload['@odata.nextLink']),
    '@odata.deltaLink': readOptionalString(payload['@odata.deltaLink']),
  };
}

function isValidMessageItem(item: GraphDeltaItem): item is GraphDeltaItem & { id: string } {
  if (item == null) return false;
  if (Object.prototype.hasOwnProperty.call(item, '@removed')) return false;
  const id = readOptionalString(item.id);
  return typeof id === 'string';
}

/** Mask the email address in a way safe for ops logs. */
function maskEmail(emailAddress: string): string {
  const at = emailAddress.indexOf('@');
  if (at <= 0) return '***';
  const local = emailAddress.slice(0, at);
  const domain = emailAddress.slice(at + 1);
  const localMasked = local.length <= 2 ? '••' : `${local.slice(0, 1)}••${local.slice(-1)}`;
  return `${localMasked}@${domain}`;
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof DeltaPollingHttpError) {
    // TASK-071 — append sanitized Graph diagnostics (enum codes + request-id) so
    // ops can correlate with Microsoft support, without leaking any secret.
    const parts = [`${error.message} (http=${error.httpStatus})`];
    if (error.graphErrorCode) parts.push(`code=${error.graphErrorCode}`);
    if (error.graphInnerErrorCode) parts.push(`inner=${error.graphInnerErrorCode}`);
    if (error.graphRequestId) parts.push(`reqId=${error.graphRequestId}`);
    return parts.join(' ');
  }
  if (error instanceof Error) {
    // Only the error class name — error.message may contain unexpected
    // identifiers we do not want in DB columns or logs.
    return error.name;
  }
  return 'UnknownError';
}

// ---------------------------------------------------------------------------
// Per-mailbox polling
// ---------------------------------------------------------------------------

async function pollMailboxDelta(
  mailbox: DeltaPollingMailbox,
  accessToken: string,
  deps: Required<
    Pick<DeltaPollingDeps, 'fetchImpl' | 'logger' | 'now' | 'maxPagesPerMailbox'>
  > & {
    enqueue: DeltaPollingEnqueuePort;
    bootstrapFromDate: Date;
  },
): Promise<PerMailboxPollOutcome> {
  const isBootstrap = mailbox.microsoftDeltaCursor === null;
  let currentUrl =
    mailbox.microsoftDeltaCursor ?? buildInitialDeltaUrl(deps.bootstrapFromDate);
  let pagesProcessed = 0;
  let enqueued = 0;
  let deltaLink: string | null = null;

  while (pagesProcessed < deps.maxPagesPerMailbox) {
    const page = await fetchDeltaPage(currentUrl, accessToken, deps.fetchImpl);
    pagesProcessed += 1;

    // During bootstrap we INTENTIONALLY do not enqueue any pre-existing
    // messages — the cursor we save below is what tells the next poll where
    // "new" begins. This is the core safety property of the task.
    if (!isBootstrap) {
      const items = page.value ?? [];
      for (const item of items) {
        if (!isValidMessageItem(item)) continue;
        try {
          await deps.enqueue.enqueueMessage({
            mailboxId: mailbox.id,
            graphMessageId: item.id,
            queuedAt: deps.now().toISOString(),
          });
          enqueued += 1;
        } catch {
          // One enqueue failure must not break the whole page — the next poll
          // will see the same message again (cursor hasn't advanced past this
          // page yet) and pipeline-level dedup will sort out repeats.
          deps.logger.warn('Delta polling failed to enqueue message', {
            mailboxId: mailbox.id,
          });
        }
      }
    }

    if (page['@odata.deltaLink']) {
      deltaLink = page['@odata.deltaLink'];
      break;
    }
    if (page['@odata.nextLink']) {
      currentUrl = page['@odata.nextLink'];
      continue;
    }
    // No nextLink AND no deltaLink — defensively stop. We will retry the
    // same cursor next run.
    break;
  }

  if (deltaLink === null && pagesProcessed >= deps.maxPagesPerMailbox) {
    deps.logger.warn('Delta polling hit page limit before deltaLink', {
      mailboxId: mailbox.id,
      pagesProcessed,
      bootstrap: isBootstrap,
    });
  }

  return {
    enqueued,
    newCursor: deltaLink,
    bootstrap: isBootstrap,
  };
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run one polling cycle across every ACTIVE Microsoft mailbox. Safe to call
 * standalone from a test, a CLI script, or a scheduler tick. Per-mailbox
 * errors never bubble up — they are recorded against the offending mailbox
 * and the run continues.
 */
export async function runDeltaPollingOnce(
  deps: DeltaPollingDeps,
): Promise<DeltaPollingRunResult> {
  const logger = deps.logger ?? createLogger();
  const now = deps.now ?? (() => new Date());
  const fetchImpl = deps.fetchImpl ?? fetch;
  const maxPagesPerMailbox =
    typeof deps.maxPagesPerMailbox === 'number' && deps.maxPagesPerMailbox > 0
      ? Math.floor(deps.maxPagesPerMailbox)
      : DEFAULT_MAX_PAGES_PER_MAILBOX;
  const bootstrapLookbackHours =
    typeof deps.bootstrapLookbackHours === 'number' &&
    deps.bootstrapLookbackHours > 0
      ? deps.bootstrapLookbackHours
      : DEFAULT_BOOTSTRAP_LOOKBACK_HOURS;
  const forbiddenBackoffThreshold =
    typeof deps.forbiddenBackoffThreshold === 'number' &&
    deps.forbiddenBackoffThreshold > 0
      ? Math.floor(deps.forbiddenBackoffThreshold)
      : DEFAULT_FORBIDDEN_BACKOFF_THRESHOLD;

  const result: DeltaPollingRunResult = {
    checkedMailboxCount: 0,
    bootstrappedMailboxCount: 0,
    enqueuedMessageCount: 0,
    failedMailboxCount: 0,
    cooldownSkippedMailboxCount: 0,
  };

  let mailboxes: DeltaPollingMailbox[];
  try {
    mailboxes = await deps.repo.listActiveMicrosoftMailboxes();
  } catch (error) {
    logger.error('Delta polling failed to list active mailboxes', {
      errorName: safeErrorMessage(error),
    });
    return result;
  }

  logger.info('Delta polling cycle started', {
    activeMailboxCount: mailboxes.length,
    maxPagesPerMailbox,
    bootstrapLookbackHours,
  });

  for (const mailbox of mailboxes) {
    result.checkedMailboxCount += 1;
    const startedAt = now();

    // TASK-075 — persistent-403 cooldown: skip this mailbox entirely while it is
    // inside the backoff window. No token fetch, no Graph call, no failure count
    // — the cycle just moves on so a single bad mailbox cannot waste the run.
    const cooldownUntil = mailbox.deltaForbiddenCooldownUntil ?? null;
    if (cooldownUntil !== null && cooldownUntil.getTime() > startedAt.getTime()) {
      result.cooldownSkippedMailboxCount += 1;
      logger.info('Delta polling skipping mailbox in forbidden cooldown', {
        mailboxId: mailbox.id,
        emailAddressMasked: maskEmail(mailbox.emailAddress),
      });
      continue;
    }

    try {
      let accessToken: string;
      try {
        accessToken = await deps.accessToken.getAccessTokenForMailbox(mailbox);
      } catch (error) {
        // TASK-069C — only a genuinely dead grant (invalid_grant /
        // interaction_required, or a missing/undecryptable token) flips the
        // mailbox to RECONNECT_REQUIRED. A transient failure (network/429/5xx)
        // leaves the mailbox ACTIVE so the next cycle retries; we still record
        // the error metadata and count it as a failed mailbox this cycle.
        if (shouldMarkReconnectRequired(error)) {
          await safelyMarkReconnectRequired(mailbox.id, deps.repo, logger);
        }
        await safelyRecordError(
          mailbox.id,
          `TOKEN_REFRESH_FAILED:${safeErrorMessage(error)}`,
          startedAt,
          deps.repo,
          logger,
        );
        result.failedMailboxCount += 1;
        continue;
      }

      const bootstrapFromDate = new Date(
        startedAt.getTime() - bootstrapLookbackHours * MS_PER_HOUR,
      );
      const outcome = await pollMailboxDelta(mailbox, accessToken, {
        fetchImpl,
        logger,
        now,
        maxPagesPerMailbox,
        enqueue: deps.enqueue,
        bootstrapFromDate,
      });

      if (outcome.bootstrap) {
        result.bootstrappedMailboxCount += 1;
      }
      result.enqueuedMessageCount += outcome.enqueued;

      if (outcome.newCursor) {
        try {
          await deps.repo.saveDeltaCursor(mailbox.id, outcome.newCursor, startedAt);
        } catch (error) {
          logger.warn('Delta polling failed to save cursor', {
            mailboxId: mailbox.id,
            errorName: safeErrorMessage(error),
          });
        }
      }

      // TASK-075/080 — a successful poll means any prior forbidden streak has
      // self-healed. Clear the backoff counter, the cooldown, and the now-stale
      // delta error metadata so the dashboard stops showing a resolved error.
      // Only write when there was state to clear (recovery is the rare path).
      if (hasForbiddenState(mailbox)) {
        await safelyClearForbiddenBackoff(mailbox.id, deps.repo, logger);
      }

      logger.info('Delta polling cycle completed for mailbox', {
        mailboxId: mailbox.id,
        emailAddressMasked: maskEmail(mailbox.emailAddress),
        bootstrap: outcome.bootstrap,
        enqueued: outcome.enqueued,
        cursorAdvanced: outcome.newCursor !== null,
      });
    } catch (error) {
      result.failedMailboxCount += 1;
      if (error instanceof DeltaPollingHttpError && error.kind === 'auth') {
        // HTTP 401 on the data request: the access token was rejected outright →
        // reconnect, as before.
        await safelyMarkReconnectRequired(mailbox.id, deps.repo, logger);
        await safelyRecordError(
          mailbox.id,
          safeErrorMessage(error),
          startedAt,
          deps.repo,
          logger,
        );
      } else if (error instanceof DeltaPollingHttpError && error.kind === 'forbidden') {
        // TASK-075 — persistent 403 backoff (preserves TASK-071 self-heal).
        await handlePersistentForbidden(mailbox, error, startedAt, {
          repo: deps.repo,
          alert: deps.alert,
          logger,
          threshold: forbiddenBackoffThreshold,
        });
      } else {
        await safelyRecordError(
          mailbox.id,
          safeErrorMessage(error),
          startedAt,
          deps.repo,
          logger,
        );
      }
      logger.warn('Delta polling failed for mailbox', {
        mailboxId: mailbox.id,
        emailAddressMasked: maskEmail(mailbox.emailAddress),
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
  }

  logger.info('Delta polling cycle finished', {
    checkedMailboxCount: result.checkedMailboxCount,
    bootstrappedMailboxCount: result.bootstrappedMailboxCount,
    enqueuedMessageCount: result.enqueuedMessageCount,
    failedMailboxCount: result.failedMailboxCount,
    cooldownSkippedMailboxCount: result.cooldownSkippedMailboxCount,
  });

  return result;
}

/** TASK-075 — whether a mailbox currently carries any forbidden backoff state. */
function hasForbiddenState(mailbox: DeltaPollingMailbox): boolean {
  return (
    (mailbox.deltaForbiddenCount ?? 0) > 0 ||
    (mailbox.deltaForbiddenCooldownUntil ?? null) !== null
  );
}

/**
 * TASK-075 — handle a 403 (forbidden) on a Graph data request. Preserves the
 * TASK-071 cursor self-heal, increments the persistent forbidden counter, and —
 * once the streak crosses the threshold — sets an escalating cooldown and raises
 * a single safe admin alert. NEVER flips the mailbox to RECONNECT_REQUIRED.
 */
async function handlePersistentForbidden(
  mailbox: DeltaPollingMailbox,
  error: DeltaPollingHttpError,
  occurredAt: Date,
  deps: {
    repo: DeltaPollingMailboxRepo;
    alert?: DeltaPollingAlertPort;
    logger: Logger;
    threshold: number;
  },
): Promise<void> {
  // TASK-071 self-heal: a 403 against a STORED cursor drops the (likely poisoned)
  // cursor so the next cycle re-bootstraps. A 403 during bootstrap (cursor null)
  // has nothing to reset; it just retries (subject to the backoff below).
  if (mailbox.microsoftDeltaCursor !== null) {
    await safelyResetDeltaCursor(mailbox.id, deps.repo, deps.logger);
  }

  const nextCount = (mailbox.deltaForbiddenCount ?? 0) + 1;
  // Below the threshold we stay full-speed so the cursor self-heal has a fast
  // chance to recover a merely-poisoned cursor. At/above it, cool down.
  const cooldownUntil =
    nextCount >= deps.threshold
      ? new Date(
          occurredAt.getTime() + forbiddenBackoffMs(nextCount, deps.threshold),
        )
      : null;

  await safelyRecordForbiddenBackoff(
    mailbox.id,
    nextCount,
    cooldownUntil,
    occurredAt,
    safeErrorMessage(error),
    deps.repo,
    deps.logger,
  );

  if (cooldownUntil !== null && deps.alert) {
    // Over threshold: page OWNER/ADMIN once per cooldown window (the skip above
    // naturally rate-limits re-alerting). Best-effort and secret-free.
    await safelyRaisePersistentForbiddenAlert(
      deps.alert,
      {
        mailboxId: mailbox.id,
        emailAddressMasked: maskEmail(mailbox.emailAddress),
        consecutiveForbiddenCount: nextCount,
        cooldownUntil,
        safeDiagnostics: safeErrorMessage(error),
      },
      deps.logger,
    );
  }
}

async function safelyRecordError(
  mailboxId: string,
  safeMessage: string,
  occurredAt: Date,
  repo: DeltaPollingMailboxRepo,
  logger: Logger,
): Promise<void> {
  try {
    await repo.recordDeltaError(mailboxId, safeMessage, occurredAt);
  } catch (error) {
    logger.warn('Delta polling failed to record error metadata', {
      mailboxId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

async function safelyMarkReconnectRequired(
  mailboxId: string,
  repo: DeltaPollingMailboxRepo,
  logger: Logger,
): Promise<void> {
  try {
    await repo.markReconnectRequired(mailboxId);
  } catch (error) {
    logger.warn('Delta polling failed to mark mailbox reconnect-required', {
      mailboxId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

async function safelyResetDeltaCursor(
  mailboxId: string,
  repo: DeltaPollingMailboxRepo,
  logger: Logger,
): Promise<void> {
  try {
    await repo.resetDeltaCursor(mailboxId);
  } catch (error) {
    logger.warn('Delta polling failed to reset delta cursor', {
      mailboxId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

async function safelyRecordForbiddenBackoff(
  mailboxId: string,
  count: number,
  cooldownUntil: Date | null,
  occurredAt: Date,
  safeMessage: string,
  repo: DeltaPollingMailboxRepo,
  logger: Logger,
): Promise<void> {
  try {
    await repo.recordForbiddenBackoff(
      mailboxId,
      count,
      cooldownUntil,
      occurredAt,
      safeMessage,
    );
  } catch (error) {
    logger.warn('Delta polling failed to record forbidden backoff', {
      mailboxId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

async function safelyClearForbiddenBackoff(
  mailboxId: string,
  repo: DeltaPollingMailboxRepo,
  logger: Logger,
): Promise<void> {
  try {
    await repo.clearForbiddenBackoff(mailboxId);
  } catch (error) {
    logger.warn('Delta polling failed to clear forbidden backoff', {
      mailboxId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

async function safelyRaisePersistentForbiddenAlert(
  alert: DeltaPollingAlertPort,
  input: {
    mailboxId: string;
    emailAddressMasked: string;
    consecutiveForbiddenCount: number;
    cooldownUntil: Date;
    safeDiagnostics: string;
  },
  logger: Logger,
): Promise<void> {
  try {
    await alert.raisePersistentForbidden(input);
  } catch (error) {
    // Alerting must never break the poll cycle (and must not recurse).
    logger.warn('Delta polling failed to raise persistent-forbidden alert', {
      mailboxId: input.mailboxId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
  }
}

// ---------------------------------------------------------------------------
// Test-facing internals
// ---------------------------------------------------------------------------

export const __internal = {
  GRAPH_BASE_URL,
  INBOX_DELTA_PATH,
  DEFAULT_MAX_PAGES_PER_MAILBOX,
  DEFAULT_BOOTSTRAP_LOOKBACK_HOURS,
  DEFAULT_FORBIDDEN_BACKOFF_THRESHOLD,
  FORBIDDEN_BACKOFF_BASE_MS,
  FORBIDDEN_BACKOFF_MAX_MS,
  forbiddenBackoffMs,
  buildInitialDeltaUrl,
  isValidMessageItem,
  maskEmail,
};
