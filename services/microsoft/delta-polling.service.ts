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

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const INBOX_DELTA_PATH = "/me/mailFolders('inbox')/messages/delta";
const DELTA_PAGE_TOP = '50';
const DEFAULT_MAX_PAGES_PER_MAILBOX = 10;

// ---------------------------------------------------------------------------
// Public types & ports
// ---------------------------------------------------------------------------

export interface DeltaPollingMailbox {
  id: string;
  emailAddress: string;
  microsoftDeltaCursor: string | null;
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
  markReconnectRequired(mailboxId: string): Promise<void>;
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

export interface DeltaPollingDeps {
  repo: DeltaPollingMailboxRepo;
  accessToken: DeltaPollingAccessTokenPort;
  enqueue: DeltaPollingEnqueuePort;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  now?: () => Date;
  maxPagesPerMailbox?: number;
}

export interface DeltaPollingRunResult {
  checkedMailboxCount: number;
  bootstrappedMailboxCount: number;
  enqueuedMessageCount: number;
  failedMailboxCount: number;
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

type AuthKind = 'auth' | 'transient' | 'unknown';

class DeltaPollingHttpError extends Error {
  readonly kind: AuthKind;
  readonly httpStatus: number;
  constructor(kind: AuthKind, httpStatus: number, message: string) {
    super(message);
    this.name = 'DeltaPollingHttpError';
    this.kind = kind;
    this.httpStatus = httpStatus;
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

function buildInitialDeltaUrl(): string {
  // $select=id keeps the payload minimal — we never read bodies in this layer.
  // $top is honored by Graph as a hint; the server caps it.
  const params = new URLSearchParams({ $select: 'id', $top: DELTA_PAGE_TOP });
  return `${GRAPH_BASE_URL}${INBOX_DELTA_PATH}?${params.toString()}`;
}

function classifyHttpStatus(status: number): AuthKind {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'transient';
  if (status >= 500 && status <= 599) return 'transient';
  return 'unknown';
}

async function fetchDeltaPage(
  url: string,
  accessToken: string,
  fetchImpl: typeof fetch,
): Promise<GraphDeltaResponse> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
      },
    });
  } catch {
    throw new DeltaPollingHttpError('transient', 0, 'GRAPH_NETWORK_ERROR');
  }

  if (!response.ok) {
    const kind = classifyHttpStatus(response.status);
    throw new DeltaPollingHttpError(kind, response.status, 'GRAPH_REQUEST_FAILED');
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
    return `${error.message} (http=${error.httpStatus})`;
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
  },
): Promise<PerMailboxPollOutcome> {
  const isBootstrap = mailbox.microsoftDeltaCursor === null;
  let currentUrl = mailbox.microsoftDeltaCursor ?? buildInitialDeltaUrl();
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

  const result: DeltaPollingRunResult = {
    checkedMailboxCount: 0,
    bootstrappedMailboxCount: 0,
    enqueuedMessageCount: 0,
    failedMailboxCount: 0,
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
  });

  for (const mailbox of mailboxes) {
    result.checkedMailboxCount += 1;
    const startedAt = now();
    try {
      let accessToken: string;
      try {
        accessToken = await deps.accessToken.getAccessTokenForMailbox(mailbox);
      } catch (error) {
        await safelyMarkReconnectRequired(mailbox.id, deps.repo, logger);
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

      const outcome = await pollMailboxDelta(mailbox, accessToken, {
        fetchImpl,
        logger,
        now,
        maxPagesPerMailbox,
        enqueue: deps.enqueue,
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
        await safelyMarkReconnectRequired(mailbox.id, deps.repo, logger);
      }
      await safelyRecordError(
        mailbox.id,
        safeErrorMessage(error),
        startedAt,
        deps.repo,
        logger,
      );
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
  });

  return result;
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

// ---------------------------------------------------------------------------
// Test-facing internals
// ---------------------------------------------------------------------------

export const __internal = {
  GRAPH_BASE_URL,
  INBOX_DELTA_PATH,
  DEFAULT_MAX_PAGES_PER_MAILBOX,
  buildInitialDeltaUrl,
  isValidMessageItem,
  maskEmail,
};
