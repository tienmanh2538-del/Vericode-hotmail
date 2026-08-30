// TASK-027 — Worker pipeline for real Microsoft Graph email notifications.
//
// This service ties together everything the BullMQ worker needs to turn a
// validated webhook job into either a sent Telegram message or a deliberate
// skip. The mock email flow from TASK-014 lives in
// `email-processing.service.ts` and is intentionally left untouched.
//
// SECURITY contract (see docs/SECURITY_RULES.md + AGENTS.md):
//   - Never log access tokens, refresh tokens, Telegram bot tokens, or
//     Microsoft client secrets.
//   - Never log the full verification code or the full email body.
//   - Telegram chat id always comes from the database mapping. There is no
//     fallback chat id.
//   - The result envelope returned to the worker/caller carries only the
//     masked code, never the plaintext.

import {
  acquireDeliveryOwnership,
  claimMessageForProcessing,
  isDeliveryRecoverableRow,
  markMessageAsSent,
  type DeliveryOwnershipAcquisition,
  type ProcessedMessageRecord,
  type ProcessedMessageStore,
} from './deduplication.service';
import { extractVerificationCode } from './code-extractor.service';
import { detectFacebookVerificationEmail } from './facebook-detector.service';
import {
  GraphMailError,
  type GraphMailMessage,
} from '@/services/microsoft/graph-mail.service';
import { shouldMarkReconnectRequired } from '@/services/microsoft/refresh-token-failure';
import {
  TelegramSendError,
  type SendTelegramMessageInput,
  type SendTelegramMessageResult,
} from '@/services/telegram/telegram-sender.service';
import {
  recordCodeEvent,
  type CodeEventStatus,
  type RecordCodeEventInput,
} from '@/services/logs/code-event-log.service';
import {
  createAuditLog,
  type AuditLogAction,
  type CreateAuditLogInput,
} from '@/services/logs/audit-log.service';
import type {
  MailboxLockHandle,
  MailboxProcessingLock,
} from '@/services/queue/mailbox-processing-lock';
import {
  buildDestinationKey,
  type DestinationThrottle,
} from '@/services/queue/destination-throttle';
import type { GlobalSendThrottle } from '@/services/queue/global-send-throttle';
import {
  recordWorkerMetricSafely,
  type WorkerMetricsRecorder,
} from '@/services/observability/worker-metrics';
import { createLogger, type Logger } from '@/lib/logger';
// TASK-080 — max age of a verification email (measured against the Microsoft Graph
// source `receivedDateTime`) that may still be relayed to Telegram. A message
// older than this at processing time is treated as stale and never sent — this
// protects against a backlog of expired codes being drained after a worker outage
// (see TASK-079). Intentionally NOT env-tunable.
// TASK-089 (HD-3) — the constants moved to the shared LEAF policy module so the
// delta 410 recovery lookback can share the single source of truth without
// importing this high-level pipeline module. Values/behavior unchanged (30m).
import {
  MAX_RELAY_MESSAGE_AGE_MINUTES,
  MAX_RELAY_MESSAGE_AGE_MS,
} from './relay-freshness-policy';

const FACEBOOK_DETECTOR_PASS_THRESHOLD = 70;

export type GraphMessagePipelineStatus =
  | 'CODE_SENT'
  | 'SKIPPED_DUPLICATE'
  | 'SKIPPED_MAILBOX_NOT_ACTIVE'
  | 'SKIPPED_NOT_FACEBOOK_VERIFICATION'
  | 'SKIPPED_LOW_CONFIDENCE'
  | 'SKIPPED_NO_CODE'
  | 'SKIPPED_NO_TELEGRAM_MAPPING'
  // TASK-080 — verification email older than the max relay age; deliberately not
  // relayed. Terminal skip (worker returns it, never retries).
  | 'SKIPPED_STALE'
  // TASK-055 — another job for the SAME mailbox is already mid-pipeline; this job
  // is deferred (treated as retryable by the worker) so it never calls
  // Graph/Telegram concurrently with the in-flight job.
  | 'DEFERRED_MAILBOX_BUSY'
  | 'FAILED_GRAPH_FETCH'
  // Retryable/transient Telegram failure whose bounded internal retries
  // (TASK-033) were exhausted. The worker throws so BullMQ re-attempts, and
  // TASK-090's delivery-ownership recovery lets that re-attempt actually reach
  // the send path again (the delivery lease was released on this known
  // failure, and early dedup no longer terminal-skips an unfinished row).
  | 'FAILED_TELEGRAM_SEND'
  // TASK-090 (DF-90-4) — permanent/non-retryable Telegram failure (e.g.
  // 400/403/404, validation, config). The row is terminally FAILED and the
  // worker RETURNS this status (never throws), so no BullMQ attempt is wasted
  // and the message is never auto-retried.
  | 'FAILED_TELEGRAM_PERMANENT'
  | 'FAILED_RECONNECT_REQUIRED'
  // TASK-069C — a TRANSIENT token-refresh failure (network/timeout/429/5xx). The
  // job is retryable but the mailbox is deliberately NOT flagged
  // RECONNECT_REQUIRED, so a blip never forces a manual reconnect.
  | 'FAILED_TOKEN_TRANSIENT'
  | 'FAILED_UNEXPECTED';

export type GraphMessageJobSource = 'webhook' | 'manual' | 'test';

export interface GraphMessageProcessingJob {
  mailboxId: string;
  graphMessageId: string;
  source?: GraphMessageJobSource;
  subscriptionId?: string | null;
  internetMessageId?: string | null;
  receivedNotificationAt?: string | null;
}

export interface GraphMessagePipelineResult {
  ok: boolean;
  status: GraphMessagePipelineStatus;
  mailboxId: string;
  graphMessageId: string;
  internetMessageId?: string | null;
  maskedCode?: string | null;
  detectorConfidence?: number | null;
  sentToTelegram?: boolean;
  reason?: string;
}

export interface MailboxLookupRecord {
  id: string;
  emailAddress: string;
  status: string;
  customerName?: string | null;
}

export interface MailboxLookupPort {
  findById(mailboxId: string): Promise<MailboxLookupRecord | null>;
  /**
   * Best-effort persistence helper invoked when Graph rejects the access token
   * (HTTP 401 / auth kind). Implementations should flip the mailbox status to
   * `RECONNECT_REQUIRED` so an operator can re-link OAuth. Failures here must
   * not crash the worker — they are logged and swallowed.
   */
  markReconnectRequired?(mailboxId: string): Promise<void>;
}

export interface AccessTokenPort {
  /**
   * Resolve a usable access token for the given mailbox. Implementations are
   * responsible for decrypting the stored refresh token and exchanging it at
   * the Microsoft token endpoint. Tokens MUST NOT be cached on the returned
   * mailbox record or logged.
   */
  getAccessTokenForMailbox(mailbox: MailboxLookupRecord): Promise<string>;
}

export interface GraphMessageFetchPort {
  fetchMessage(
    accessToken: string,
    graphMessageId: string,
  ): Promise<GraphMailMessage>;
}

export interface TelegramMappingLookup {
  telegramChatId: string;
  telegramGroupName?: string | null;
  // TASK-041 — when present, the code is delivered to this forum topic via
  // `message_thread_id`. Absent/null keeps plain group delivery unchanged.
  telegramThreadId?: string | null;
}

export interface TelegramMappingPort {
  findActiveMappingForMailboxId(
    mailboxId: string,
  ): Promise<TelegramMappingLookup | null>;
}

export interface TelegramSendPort {
  sendTelegramMessage(
    input: SendTelegramMessageInput,
  ): Promise<SendTelegramMessageResult>;
}

export interface AuditPort {
  recordCodeEvent(input: RecordCodeEventInput): void;
  createAuditLog(input: CreateAuditLogInput): void;
}

export interface GraphMessagePipelineDeps {
  store: ProcessedMessageStore;
  mailboxes: MailboxLookupPort;
  accessToken: AccessTokenPort;
  graphMail: GraphMessageFetchPort;
  telegramMapping: TelegramMappingPort;
  telegramSender: TelegramSendPort;
  audit?: AuditPort;
  logger?: Logger;
  now?: () => Date;
  // TASK-055 — per-mailbox processing lock. When present, the job acquires the
  // lock for its mailboxId before touching Graph/Telegram and releases it in a
  // finally. Absent ⇒ no serialization (unchanged behavior for existing tests).
  lock?: MailboxProcessingLock;
  // TASK-055 — shared-destination burst guard. When present, the job spaces its
  // Telegram send against other sends to the same chat/topic. Absent ⇒ no delay.
  destinationThrottle?: DestinationThrottle;
  // TASK-068B — global bot send pacer. When present, the job also paces its send
  // against ALL other bot sends (not just the same destination) so a burst across
  // many different destinations cannot trip Telegram's global bot rate limit.
  // Absent ⇒ no extra delay. Bounded by the pacer's own cap.
  globalSendThrottle?: GlobalSendThrottle;
  // TASK-068B — bounded fairness retry when the per-mailbox lock is busy. When
  // present (and a lock is configured), the job re-tries acquiring the lock a few
  // times with a short delay BEFORE deferring, so a transient in-flight job for
  // the same mailbox does not force an immediate queue re-attempt (thrash). It is
  // strictly bounded by both `maxRetries` and `maxTotalWaitMs` — never an infinite
  // loop. It only re-acquires the lock; it never claims/dedups while busy, so it
  // cannot affect exactly-once. Absent ⇒ defer immediately (TASK-055 behaviour).
  busyDeferRetry?: {
    maxRetries: number;
    delayMs: number;
    maxTotalWaitMs: number;
  };
  // Injectable sleep so the throttle delay is instant under test.
  sleep?: (ms: number) => Promise<void>;
  // TASK-068C — best-effort observability sink. When present, the pipeline
  // records aggregate throttle/defer signals (mailbox-busy defer, destination
  // throttle wait, global pacing wait). Every call is wrapped so a metrics
  // failure can never break delivery, and only counts/durations are recorded —
  // never a code, email body, token, or destination id. Absent ⇒ no recording.
  metrics?: WorkerMetricsRecorder;
}

interface NormalizedJob {
  mailboxId: string;
  graphMessageId: string;
  source: GraphMessageJobSource;
  subscriptionId: string | null;
  internetMessageId: string | null;
  receivedNotificationAt: string | null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * TASK-068B — acquire the per-mailbox lock with an optional, strictly-bounded
 * fairness retry. Without `busyDeferRetry` this is a single acquire (unchanged
 * TASK-055 behaviour). With it, a busy lock is re-tried a few times with a short
 * delay so a quickly-finishing in-flight job lets this job proceed in place
 * instead of bouncing back to the queue (thrash). Bounded by BOTH `maxRetries`
 * and `maxTotalWaitMs`, so it can never loop forever or hold a worker slot
 * unboundedly. It only re-acquires the lock — it never claims a message while
 * busy, so exactly-once (TASK-068A) is untouched.
 */
async function acquireMailboxLockWithFairness(
  lock: NonNullable<GraphMessagePipelineDeps['lock']>,
  mailboxId: string,
  busyDeferRetry: GraphMessagePipelineDeps['busyDeferRetry'],
  sleep: (ms: number) => Promise<void>,
): Promise<MailboxLockHandle | null> {
  const first = await lock.acquire(mailboxId);
  if (first || !busyDeferRetry) return first;

  const maxRetries = Math.max(0, Math.floor(busyDeferRetry.maxRetries));
  const delayMs = Math.max(0, busyDeferRetry.delayMs);
  const maxTotalWaitMs = Math.max(0, busyDeferRetry.maxTotalWaitMs);

  let waited = 0;
  for (let attempt = 0; attempt < maxRetries; attempt += 1) {
    const remaining = maxTotalWaitMs - waited;
    if (remaining <= 0) break;
    const thisDelay = Math.min(delayMs, remaining);
    if (thisDelay <= 0) break;
    await sleep(thisDelay);
    waited += thisDelay;
    const handle = await lock.acquire(mailboxId);
    if (handle) return handle;
  }
  return null;
}

function trimOrNull(value: unknown): string | null {
  return isNonEmptyString(value) ? value.trim() : null;
}

function validJobSource(value: unknown): GraphMessageJobSource {
  return value === 'webhook' || value === 'manual' || value === 'test'
    ? value
    : 'webhook';
}

function normalizeJob(job: GraphMessageProcessingJob): NormalizedJob | null {
  if (!job || typeof job !== 'object') return null;
  const mailboxId = trimOrNull(job.mailboxId);
  const graphMessageId = trimOrNull(job.graphMessageId);
  if (!mailboxId || !graphMessageId) return null;
  return {
    mailboxId,
    graphMessageId,
    source: validJobSource(job.source),
    subscriptionId: trimOrNull(job.subscriptionId),
    internetMessageId: trimOrNull(job.internetMessageId),
    receivedNotificationAt: trimOrNull(job.receivedNotificationAt),
  };
}

function pickReceivedAt(
  message: GraphMailMessage,
  fallback: () => Date,
): Date {
  if (isNonEmptyString(message.receivedDateTime)) {
    const parsed = new Date(message.receivedDateTime);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return fallback();
}

/**
 * TASK-080 — parse the Microsoft Graph source timestamp WITHOUT any fallback.
 * Returns null when `receivedDateTime` is missing/blank/unparseable. The stale
 * guard must NEVER substitute the enqueue/processing time, so it relies on this
 * (null-on-missing) rather than `pickReceivedAt` (which falls back to `now`).
 */
function parseGraphReceivedAt(
  value: string | null | undefined,
): Date | null {
  if (!isNonEmptyString(value)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function readEmailAddress(
  recipient: GraphMailMessage['from'] | GraphMailMessage['sender'],
): string {
  return recipient?.emailAddress?.address?.trim() ?? '';
}

function readDisplayName(
  recipient: GraphMailMessage['from'] | GraphMailMessage['sender'],
): string {
  return recipient?.emailAddress?.name?.trim() ?? '';
}

function buildFromHeader(message: GraphMailMessage): string {
  const fromAddress = readEmailAddress(message.from);
  const fromName = readDisplayName(message.from);
  if (fromAddress.length === 0 && fromName.length === 0) return '';
  if (fromAddress.length === 0) return fromName;
  if (fromName.length === 0) return fromAddress;
  return `${fromName} <${fromAddress}>`;
}

function buildTelegramText(args: {
  mailboxEmail: string;
  fromHeader: string;
  subject: string;
  code: string;
  receivedAt: Date;
}): string {
  const lines: string[] = [
    '🔐 Facebook verification code',
    '',
    `Email: ${args.mailboxEmail}`,
  ];
  if (args.fromHeader.length > 0) lines.push(`From: ${args.fromHeader}`);
  if (args.subject.length > 0) lines.push(`Subject: ${args.subject}`);
  lines.push(`Code: ${args.code}`);
  lines.push(`Received: ${args.receivedAt.toISOString()}`);
  return lines.join('\n');
}

function safeRecordCodeEvent(
  audit: AuditPort | undefined,
  input: RecordCodeEventInput,
  logger: Logger,
): void {
  try {
    if (audit) {
      audit.recordCodeEvent(input);
    } else {
      recordCodeEvent(input);
    }
  } catch {
    logger.warn('Failed to record code event', {
      mailboxEmail: input.mailboxEmail,
      status: input.status,
    });
  }
}

function safeCreateAuditLog(
  audit: AuditPort | undefined,
  input: CreateAuditLogInput,
  logger: Logger,
): void {
  try {
    if (audit) {
      audit.createAuditLog(input);
    } else {
      createAuditLog(input);
    }
  } catch {
    logger.warn('Failed to write audit log', {
      action: input.action,
      entityType: input.entityType,
    });
  }
}

function mapGraphErrorToResult(
  err: unknown,
  base: {
    mailboxId: string;
    graphMessageId: string;
    internetMessageId: string | null;
  },
): GraphMessagePipelineResult {
  if (err instanceof GraphMailError) {
    // TASK-074 — sync with TASK-071's delta-polling 403 handling. Only a 401
    // (`auth`, token rejected outright) is a dead grant → FAILED_RECONNECT_REQUIRED.
    // A 403 (`permission`, forbidden DATA request with a still-valid token) is
    // NOT a reconnect: it falls through to the neutral, retryable
    // FAILED_GRAPH_FETCH below and never flags the mailbox RECONNECT_REQUIRED.
    if (err.kind === 'auth') {
      return {
        ok: false,
        status: 'FAILED_RECONNECT_REQUIRED',
        mailboxId: base.mailboxId,
        graphMessageId: base.graphMessageId,
        internetMessageId: base.internetMessageId,
        sentToTelegram: false,
        reason: err.kind,
      };
    }
    return {
      ok: false,
      status: 'FAILED_GRAPH_FETCH',
      mailboxId: base.mailboxId,
      graphMessageId: base.graphMessageId,
      internetMessageId: base.internetMessageId,
      sentToTelegram: false,
      reason: err.kind,
    };
  }
  return {
    ok: false,
    status: 'FAILED_GRAPH_FETCH',
    mailboxId: base.mailboxId,
    graphMessageId: base.graphMessageId,
    internetMessageId: base.internetMessageId,
    sentToTelegram: false,
    reason: 'unknown',
  };
}

export async function processGraphMessageJob(
  job: GraphMessageProcessingJob,
  deps: GraphMessagePipelineDeps,
): Promise<GraphMessagePipelineResult> {
  const logger = deps.logger ?? createLogger();

  // Step 1: validate the job payload.
  const normalized = normalizeJob(job);
  if (!normalized) {
    logger.warn('Graph message job rejected: invalid payload', {
      hasMailboxId: isNonEmptyString(job?.mailboxId),
      hasGraphMessageId: isNonEmptyString(job?.graphMessageId),
    });
    return {
      ok: false,
      status: 'FAILED_UNEXPECTED',
      mailboxId: trimOrNull(job?.mailboxId) ?? '',
      graphMessageId: trimOrNull(job?.graphMessageId) ?? '',
      sentToTelegram: false,
      reason: 'invalid_job_payload',
    };
  }

  const baseResultKeys = {
    mailboxId: normalized.mailboxId,
    graphMessageId: normalized.graphMessageId,
    internetMessageId: normalized.internetMessageId,
  };

  // TASK-055 — per-mailbox processing lock. Acquire BEFORE any Graph/Telegram
  // side effect so two jobs for the same mailbox never run the pipeline in
  // parallel. When the mailbox is busy the job defers (the worker treats
  // DEFERRED_MAILBOX_BUSY as retryable) instead of calling Graph/Telegram now.
  // TASK-068A — `acquire` may be async (Redis-backed lock) or sync (in-memory).
  // Awaiting handles both; a sync lock's value passes straight through.
  // TASK-068B — when `busyDeferRetry` is configured, acquisition uses a bounded
  // fairness retry to cut DEFERRED_MAILBOX_BUSY thrash; otherwise it is a single
  // acquire exactly as before.
  const lockHandle = deps.lock
    ? await acquireMailboxLockWithFairness(
        deps.lock,
        normalized.mailboxId,
        deps.busyDeferRetry,
        deps.sleep ?? defaultSleep,
      )
    : null;
  if (deps.lock && !lockHandle) {
    logger.info('Graph message job deferred: mailbox is busy', {
      mailboxId: normalized.mailboxId,
    });
    // TASK-068C — aggregate-only signal (no code/email/token). Best-effort.
    recordWorkerMetricSafely(() => deps.metrics?.recordMailboxBusyDefer());
    return {
      ok: false,
      status: 'DEFERRED_MAILBOX_BUSY',
      ...baseResultKeys,
      sentToTelegram: false,
      reason: 'mailbox_busy',
    };
  }

  try {
    return await processActiveMailboxJob(normalized, baseResultKeys, deps);
  } finally {
    // Always release — even when the pipeline throws unexpectedly — so a single
    // failed job can never wedge the mailbox. `release` may be async (Redis) or
    // sync (in-memory); awaiting covers both.
    await lockHandle?.release();
  }
}

async function processActiveMailboxJob(
  normalized: NormalizedJob,
  baseResultKeys: {
    mailboxId: string;
    graphMessageId: string;
    internetMessageId: string | null;
  },
  deps: GraphMessagePipelineDeps,
): Promise<GraphMessagePipelineResult> {
  const logger = deps.logger ?? createLogger();
  const now = deps.now ?? (() => new Date());
  const audit = deps.audit;

  // Step 2: load mailbox and check ACTIVE.
  let mailbox: MailboxLookupRecord | null;
  try {
    mailbox = await deps.mailboxes.findById(normalized.mailboxId);
  } catch {
    logger.error('Mailbox lookup failed during graph message job', {
      mailboxId: normalized.mailboxId,
    });
    return {
      ok: false,
      status: 'FAILED_UNEXPECTED',
      ...baseResultKeys,
      sentToTelegram: false,
      reason: 'mailbox_lookup_error',
    };
  }

  if (!mailbox) {
    logger.warn('Graph message job skipped: mailbox not found', {
      mailboxId: normalized.mailboxId,
    });
    return {
      ok: false,
      status: 'FAILED_UNEXPECTED',
      ...baseResultKeys,
      sentToTelegram: false,
      reason: 'mailbox_not_found',
    };
  }

  if (mailbox.status !== 'ACTIVE') {
    logger.info('Graph message job skipped: mailbox not active', {
      mailboxId: mailbox.id,
      mailboxStatus: mailbox.status,
    });
    return {
      ok: false,
      status: 'SKIPPED_MAILBOX_NOT_ACTIVE',
      ...baseResultKeys,
      sentToTelegram: false,
      reason: `mailbox_status:${mailbox.status}`,
    };
  }

  // Step 3: acquire access token + fetch the Graph message.
  let accessToken: string;
  try {
    accessToken = await deps.accessToken.getAccessTokenForMailbox(mailbox);
  } catch (tokenError: unknown) {
    // TASK-069C — only a genuinely dead grant (invalid_grant /
    // interaction_required, or a missing/undecryptable token) flips the mailbox
    // to RECONNECT_REQUIRED. A transient failure (network/timeout/429/5xx) must
    // NOT change status — the job is retried and the mailbox stays ACTIVE.
    if (!shouldMarkReconnectRequired(tokenError)) {
      logger.warn('Mailbox access token refresh failed transiently — will retry', {
        mailboxId: mailbox.id,
      });
      return {
        ok: false,
        status: 'FAILED_TOKEN_TRANSIENT',
        ...baseResultKeys,
        sentToTelegram: false,
        reason: 'token_refresh_transient',
      };
    }
    logger.warn('Mailbox access token unavailable — flagging reconnect', {
      mailboxId: mailbox.id,
    });
    if (deps.mailboxes.markReconnectRequired) {
      try {
        await deps.mailboxes.markReconnectRequired(mailbox.id);
      } catch {
        logger.warn('Failed to mark mailbox reconnect-required', {
          mailboxId: mailbox.id,
        });
      }
    }
    safeCreateAuditLog(
      audit,
      {
        action: 'MAILBOX_RECONNECT_REQUIRED',
        entityType: 'mailbox',
        entityId: mailbox.id,
        severity: 'warning',
        summary: 'Mailbox token refresh failed during email pipeline',
        metadata: { mailboxId: mailbox.id },
      },
      logger,
    );
    return {
      ok: false,
      status: 'FAILED_RECONNECT_REQUIRED',
      ...baseResultKeys,
      sentToTelegram: false,
      reason: 'token_refresh_failed',
    };
  }

  let message: GraphMailMessage;
  try {
    message = await deps.graphMail.fetchMessage(
      accessToken,
      normalized.graphMessageId,
    );
  } catch (err: unknown) {
    if (err instanceof GraphMailError && err.kind === 'auth') {
      logger.warn('Graph rejected access token — flagging reconnect', {
        mailboxId: mailbox.id,
        kind: err.kind,
        httpStatus: err.httpStatus,
      });
      if (deps.mailboxes.markReconnectRequired) {
        try {
          await deps.mailboxes.markReconnectRequired(mailbox.id);
        } catch {
          logger.warn('Failed to mark mailbox reconnect-required', {
            mailboxId: mailbox.id,
          });
        }
      }
      safeCreateAuditLog(
        audit,
        {
          action: 'MAILBOX_RECONNECT_REQUIRED',
          entityType: 'mailbox',
          entityId: mailbox.id,
          severity: 'warning',
          summary: 'Microsoft Graph rejected access token (401)',
          metadata: { mailboxId: mailbox.id },
        },
        logger,
      );
    } else {
      logger.warn('Graph message fetch failed', {
        mailboxId: mailbox.id,
        kind: err instanceof GraphMailError ? err.kind : 'unknown',
      });
    }
    return mapGraphErrorToResult(err, baseResultKeys);
  }

  const internetMessageId =
    trimOrNull(message.internetMessageId) ?? normalized.internetMessageId;
  baseResultKeys.internetMessageId = internetMessageId;

  const receivedAt = pickReceivedAt(message, now);
  const fromAddress =
    readEmailAddress(message.from) || readEmailAddress(message.sender);
  const fromHeader = buildFromHeader(message) || fromAddress;
  const subject = message.subject?.trim() ?? '';
  const bodyContent = message.body?.content ?? undefined;
  const bodyContentType =
    typeof message.body?.contentType === 'string'
      ? message.body.contentType.toLowerCase()
      : undefined;
  const bodyText =
    bodyContentType === 'html' ? undefined : bodyContent ?? undefined;
  const bodyHtml =
    bodyContentType === 'html' ? bodyContent ?? undefined : undefined;
  const bodyPreview = message.bodyPreview ?? undefined;

  // Step 4: early dedup on message identity.
  //
  // TASK-090 — STATUS-AWARE. A row that reached a TERMINAL outcome (SENT, or
  // FAILED) is a duplicate skip exactly as before. A row whose delivery never
  // finished (status DETECTED — the S1/S2 permanent-loss window this task
  // fixes) is NOT terminal-skipped any more: it is carried forward as a
  // recovery candidate and must still pass the TASK-080 stale guard, the
  // detector/extractor, and the atomic delivery-ownership CAS (Step 8) before
  // any Telegram send. The DB unique identity constraint and the TASK-068A
  // P2002 backstop are untouched.
  let recoveryRow: ProcessedMessageRecord | null = null;

  const earlyExisting = await deps.store.findByGraphMessageId(
    mailbox.id,
    normalized.graphMessageId,
  );
  if (earlyExisting && !isDeliveryRecoverableRow(earlyExisting)) {
    logger.info('Graph message job skipped: duplicate (graph message id)', {
      mailboxId: mailbox.id,
      processedMessageId: earlyExisting.id,
      rowStatus: earlyExisting.status,
    });
    safeRecordCodeEvent(
      audit,
      {
        mailboxEmail: mailbox.emailAddress,
        customerName: mailbox.customerName ?? undefined,
        status: 'CODE_SKIPPED_DUPLICATE',
        source: 'webhook',
        receivedAt,
        message:
          earlyExisting.status === 'FAILED'
            ? 'Duplicate Graph message id (terminal failed)'
            : 'Duplicate Graph message id',
      },
      logger,
    );
    return {
      ok: false,
      status: 'SKIPPED_DUPLICATE',
      ...baseResultKeys,
      sentToTelegram: false,
      reason:
        earlyExisting.status === 'FAILED'
          ? 'duplicate_terminal_failed'
          : 'duplicate_graph_message_id',
    };
  }
  if (earlyExisting) {
    recoveryRow = earlyExisting;
  }
  if (internetMessageId) {
    const earlyImid = await deps.store.findByInternetMessageId(
      mailbox.id,
      internetMessageId,
    );
    if (
      earlyImid &&
      earlyImid.id !== recoveryRow?.id &&
      !isDeliveryRecoverableRow(earlyImid)
    ) {
      // The SAME email already reached a terminal outcome under another row
      // identity. Best-effort terminalize our unfinished row (if any) so it
      // can never become a duplicate-delivery candidate later; the write is
      // conditional (unclaimed rows only) so it can never steal a live owner.
      if (recoveryRow) {
        try {
          await deps.store.markFailedIfUnclaimed({
            processedMessageId: recoveryRow.id,
            reason: 'duplicate_identity_terminal',
            now: now(),
          });
        } catch {
          logger.warn('Failed to terminalize duplicate-identity row', {
            mailboxId: mailbox.id,
            processedMessageId: recoveryRow.id,
          });
        }
      }
      logger.info('Graph message job skipped: duplicate (internet message id)', {
        mailboxId: mailbox.id,
        processedMessageId: earlyImid.id,
        rowStatus: earlyImid.status,
      });
      safeRecordCodeEvent(
        audit,
        {
          mailboxEmail: mailbox.emailAddress,
          customerName: mailbox.customerName ?? undefined,
          status: 'CODE_SKIPPED_DUPLICATE',
          source: 'webhook',
          receivedAt,
          message: 'Duplicate internet message id',
        },
        logger,
      );
      return {
        ok: false,
        status: 'SKIPPED_DUPLICATE',
        ...baseResultKeys,
        sentToTelegram: false,
        reason: 'duplicate_internet_message_id',
      };
    }
    if (!recoveryRow && earlyImid) {
      recoveryRow = earlyImid;
    }
  }

  // TASK-080 — stale verification message relay protection. Placed AFTER the
  // early message-identity dedup (so existing duplicate reporting is unchanged)
  // and BEFORE detection/extraction/claim/Telegram (so the Telegram sender is
  // NEVER reached for a stale message, and we do not extract/log a code just to
  // decide staleness). Freshness is measured against the Graph source timestamp
  // ONLY — never the enqueue/processing time — so an old email that was just
  // enqueued today is still stale.
  const sourceReceivedAt = parseGraphReceivedAt(message.receivedDateTime);
  if (sourceReceivedAt !== null) {
    const ageMs = now().getTime() - sourceReceivedAt.getTime();
    if (ageMs > MAX_RELAY_MESSAGE_AGE_MS) {
      // TASK-090 — a recovery candidate that has gone stale is terminalized
      // (conditional: unclaimed rows only, never stealing a live owner) so it
      // stops being a recovery candidate. This is also what keeps historical
      // pre-migration DETECTED rows safe: any touch lands here and terminally
      // marks them instead of re-delivering an old verification message.
      if (recoveryRow) {
        try {
          await deps.store.markFailedIfUnclaimed({
            processedMessageId: recoveryRow.id,
            reason: 'stale_before_delivery',
            now: now(),
          });
        } catch {
          logger.warn('Failed to terminalize stale recovery row', {
            mailboxId: mailbox.id,
            processedMessageId: recoveryRow.id,
          });
        }
      }
      logger.info('Graph message job skipped: stale verification message', {
        mailboxId: mailbox.id,
        ageMinutes: Math.round(ageMs / 60_000),
        maxAgeMinutes: MAX_RELAY_MESSAGE_AGE_MINUTES,
      });
      safeRecordCodeEvent(
        audit,
        {
          mailboxEmail: mailbox.emailAddress,
          customerName: mailbox.customerName ?? undefined,
          status: 'CODE_SKIPPED_STALE',
          source: 'webhook',
          receivedAt,
          message: `stale_gt_${MAX_RELAY_MESSAGE_AGE_MINUTES}m`,
        },
        logger,
      );
      return {
        ok: false,
        status: 'SKIPPED_STALE',
        ...baseResultKeys,
        sentToTelegram: false,
        reason: 'stale_message',
      };
    }
  } else {
    // Fail-safe: Graph's data contract always includes `receivedDateTime`. A
    // missing/invalid value is an anomaly we cannot date. We do NOT fall back to
    // the enqueue/processing time (that would defeat the guard) and we do NOT
    // drop a possibly-valid code on an anomaly — we proceed with normal
    // processing and record a safe warning. See TASK-080 report.
    logger.warn(
      'Graph message has no usable receivedDateTime — skipping stale check',
      { mailboxId: mailbox.id },
    );
  }

  // Step 5 + 6: detect Facebook/Meta verification.
  const detection = detectFacebookVerificationEmail({
    from: fromHeader,
    sender: fromAddress,
    subject,
    bodyText,
    bodyPreview,
    receivedAt,
  });

  if (!detection.isFacebookVerification) {
    // Heuristic: a trusted Facebook/Meta sender that missed only the keyword
    // or code-context signals is "close but uncertain" → low confidence. An
    // unknown / non-trusted sender that didn't pass is simply not a Facebook
    // verification email at all.
    const trustedSender = detection.matchedSignals.includes(
      'trusted_sender_match',
    );
    const lowConfidence =
      trustedSender &&
      detection.confidenceScore < FACEBOOK_DETECTOR_PASS_THRESHOLD;
    const status: GraphMessagePipelineStatus = lowConfidence
      ? 'SKIPPED_LOW_CONFIDENCE'
      : 'SKIPPED_NOT_FACEBOOK_VERIFICATION';
    const codeEventStatus: CodeEventStatus = lowConfidence
      ? 'CODE_SKIPPED_LOW_CONFIDENCE'
      : 'DETECTOR_REJECTED';
    const auditAction: AuditLogAction | undefined = lowConfidence
      ? 'CODE_SKIPPED_LOW_CONFIDENCE'
      : undefined;

    logger.info('Graph message job: detector rejected email', {
      mailboxId: mailbox.id,
      status,
      detectorConfidence: detection.confidenceScore,
    });
    safeRecordCodeEvent(
      audit,
      {
        mailboxEmail: mailbox.emailAddress,
        customerName: mailbox.customerName ?? undefined,
        status: codeEventStatus,
        confidence: detection.confidenceScore,
        source: 'webhook',
        receivedAt,
        message:
          detection.warnings.length > 0
            ? detection.warnings.join(',')
            : 'detector_no_match',
      },
      logger,
    );
    if (auditAction) {
      safeCreateAuditLog(
        audit,
        {
          action: auditAction,
          entityType: 'code_event',
          entityId: mailbox.id,
          severity: 'notice',
          summary: 'Verification code skipped (low confidence)',
          metadata: {
            mailboxId: mailbox.id,
            detectorConfidence: detection.confidenceScore,
          },
        },
        logger,
      );
    }
    return {
      ok: false,
      status,
      ...baseResultKeys,
      detectorConfidence: detection.confidenceScore,
      sentToTelegram: false,
      reason: lowConfidence ? 'low_confidence' : 'detector_no_match',
    };
  }

  // Step 7: extract the verification code.
  const extraction = extractVerificationCode({
    subject,
    bodyText,
    bodyHtml,
    bodyPreview,
  });

  if (!extraction.success) {
    const lowConfidence = extraction.reason === 'LOW_CONFIDENCE';
    const status: GraphMessagePipelineStatus = lowConfidence
      ? 'SKIPPED_LOW_CONFIDENCE'
      : 'SKIPPED_NO_CODE';
    const codeEventStatus: CodeEventStatus = lowConfidence
      ? 'CODE_SKIPPED_LOW_CONFIDENCE'
      : 'EXTRACTOR_FAILED';

    logger.info('Graph message job: extractor failed', {
      mailboxId: mailbox.id,
      reason: extraction.reason,
      detectorConfidence: detection.confidenceScore,
    });
    safeRecordCodeEvent(
      audit,
      {
        mailboxEmail: mailbox.emailAddress,
        customerName: mailbox.customerName ?? undefined,
        status: codeEventStatus,
        confidence: detection.confidenceScore,
        source: 'webhook',
        receivedAt,
        message: extraction.reason,
      },
      logger,
    );
    if (lowConfidence) {
      safeCreateAuditLog(
        audit,
        {
          action: 'CODE_SKIPPED_LOW_CONFIDENCE',
          entityType: 'code_event',
          entityId: mailbox.id,
          severity: 'notice',
          summary: 'Verification code skipped (low confidence)',
          metadata: {
            mailboxId: mailbox.id,
            detectorConfidence: detection.confidenceScore,
            extractorReason: extraction.reason,
          },
        },
        logger,
      );
    }
    return {
      ok: false,
      status,
      ...baseResultKeys,
      detectorConfidence: detection.confidenceScore,
      sentToTelegram: false,
      reason: extraction.reason,
    };
  }

  const code = extraction.code;
  const maskedCode = extraction.maskedCode;

  // Step 8: message-identity claim + delivery-ownership claim (TASK-090).
  //
  // These are two DIFFERENT claims:
  //   - IDENTITY claim — the unique-constraint INSERT (TASK-068A). Exactly one
  //     producer flow creates the row; P2002 means "row already exists", which
  //     is no longer the same thing as "already delivered".
  //   - DELIVERY-OWNERSHIP claim — an atomic conditional lease on the row.
  //     Exactly one claimant at a time may run the send path. A fresh INSERT
  //     takes the initial lease atomically; an existing unfinished row goes
  //     through the CAS in `acquireDeliveryOwnership`.
  const sleep = deps.sleep ?? defaultSleep;
  let processedMessageId: string | null = null;
  let deliveryOwnerToken: string | null = null;

  if (recoveryRow === null) {
    const dedupe = await claimMessageForProcessing(
      {
        mailboxId: mailbox.id,
        graphMessageId: normalized.graphMessageId,
        internetMessageId,
        receivedAt,
        senderEmail: fromAddress,
        subject,
        verificationCode: code,
      },
      deps.store,
      { now },
    );

    if (dedupe.isDuplicate) {
      // TASK-090 — a concurrent flow won the INSERT between our early dedup
      // and our claim. If that racing row is an UNFINISHED identity match, it
      // becomes our recovery candidate (typically we then lose the ownership
      // CAS to the live winner and skip — but if the winner crashes, this path
      // is exactly what recovers the message). Terminal rows and code-bucket
      // duplicates (a DIFFERENT email identity) keep the existing skip.
      const identityRace =
        dedupe.reason === 'DUPLICATE_GRAPH_MESSAGE_ID' ||
        dedupe.reason === 'DUPLICATE_INTERNET_MESSAGE_ID';
      const racedRow =
        identityRace && dedupe.processedMessageId
          ? await deps.store.findById(dedupe.processedMessageId)
          : null;
      if (racedRow && isDeliveryRecoverableRow(racedRow)) {
        recoveryRow = racedRow;
      } else {
        logger.info('Graph message job skipped: duplicate (code/bucket)', {
          mailboxId: mailbox.id,
          reason: dedupe.reason,
        });
        safeRecordCodeEvent(
          audit,
          {
            mailboxEmail: mailbox.emailAddress,
            customerName: mailbox.customerName ?? undefined,
            status: 'CODE_SKIPPED_DUPLICATE',
            maskedCode,
            confidence: detection.confidenceScore,
            source: 'webhook',
            receivedAt,
            message: dedupe.reason,
          },
          logger,
        );
        safeCreateAuditLog(
          audit,
          {
            action: 'CODE_DUPLICATE_SKIPPED',
            entityType: 'code_event',
            entityId: mailbox.id,
            severity: 'notice',
            summary: 'Duplicate verification code skipped',
            metadata: {
              mailboxId: mailbox.id,
              reason: dedupe.reason,
            },
          },
          logger,
        );
        return {
          ok: false,
          status: 'SKIPPED_DUPLICATE',
          ...baseResultKeys,
          detectorConfidence: detection.confidenceScore,
          maskedCode,
          sentToTelegram: false,
          reason: dedupe.reason,
        };
      }
    } else if (
      !dedupe.shouldProcess ||
      !dedupe.processedMessageId ||
      !dedupe.deliveryOwnerToken
    ) {
      logger.warn('Graph message job: dedupe could not claim message', {
        mailboxId: mailbox.id,
        reason: dedupe.reason,
      });
      return {
        ok: false,
        status: 'FAILED_UNEXPECTED',
        ...baseResultKeys,
        detectorConfidence: detection.confidenceScore,
        maskedCode,
        sentToTelegram: false,
        reason: dedupe.reason,
      };
    } else {
      processedMessageId = dedupe.processedMessageId;
      deliveryOwnerToken = dedupe.deliveryOwnerToken;
    }
  }

  if (recoveryRow !== null) {
    // TASK-090 — atomic delivery-ownership CAS on the existing unfinished row.
    // The bounded wait inside covers a lease still held by a possibly-crashed
    // owner; every non-claimed outcome is a TERMINAL skip whose safety rests on
    // either a terminal row state or a live claimant whose own job (including
    // its BullMQ stalled retry) drives delivery.
    let acquisition: DeliveryOwnershipAcquisition;
    try {
      acquisition = await acquireDeliveryOwnership(
        recoveryRow.id,
        deps.store,
        { now, sleep },
      );
    } catch {
      logger.warn('Delivery ownership acquisition failed unexpectedly', {
        mailboxId: mailbox.id,
        processedMessageId: recoveryRow.id,
      });
      return {
        ok: false,
        status: 'FAILED_UNEXPECTED',
        ...baseResultKeys,
        detectorConfidence: detection.confidenceScore,
        maskedCode,
        sentToTelegram: false,
        reason: 'delivery_ownership_error',
      };
    }

    if (acquisition.kind === 'claimed') {
      processedMessageId = recoveryRow.id;
      deliveryOwnerToken = acquisition.ownerToken;
      logger.info('Graph message job re-claimed unfinished delivery', {
        mailboxId: mailbox.id,
        processedMessageId: recoveryRow.id,
      });
    } else {
      const skipReason =
        acquisition.kind === 'already_sent'
          ? 'duplicate_graph_message_id'
          : acquisition.kind === 'terminal_failed'
            ? 'duplicate_terminal_failed'
            : acquisition.kind === 'budget_exhausted'
              ? 'delivery_attempts_exhausted'
              : 'delivery_owned_elsewhere';
      logger.info('Graph message job skipped: delivery not claimable', {
        mailboxId: mailbox.id,
        processedMessageId: recoveryRow.id,
        outcome: acquisition.kind,
      });
      safeRecordCodeEvent(
        audit,
        {
          mailboxEmail: mailbox.emailAddress,
          customerName: mailbox.customerName ?? undefined,
          status:
            acquisition.kind === 'budget_exhausted'
              ? 'TELEGRAM_SEND_FAILED'
              : 'CODE_SKIPPED_DUPLICATE',
          maskedCode,
          confidence: detection.confidenceScore,
          source: 'webhook',
          receivedAt,
          message: skipReason,
        },
        logger,
      );
      return {
        ok: false,
        status: 'SKIPPED_DUPLICATE',
        ...baseResultKeys,
        detectorConfidence: detection.confidenceScore,
        maskedCode,
        sentToTelegram: false,
        reason: skipReason,
      };
    }
  }

  if (processedMessageId === null || deliveryOwnerToken === null) {
    // Unreachable by construction (every branch above either returned or set
    // both); kept as a typed guard so the send path always has an owner.
    return {
      ok: false,
      status: 'FAILED_UNEXPECTED',
      ...baseResultKeys,
      detectorConfidence: detection.confidenceScore,
      maskedCode,
      sentToTelegram: false,
      reason: 'delivery_ownership_missing',
    };
  }

  // TASK-090 — freshness RE-CHECK immediately after ownership acquisition.
  // The Step-5 stale guard ran before the (bounded but potentially long)
  // ownership wait, so re-measure against the SAME Graph source timestamp
  // before any Telegram side effect. A message that crossed the TASK-080
  // threshold while waiting is terminally failed by its owner — it is never
  // sent late just because delivery recovery caught up with it.
  if (sourceReceivedAt !== null) {
    const postClaimAgeMs = now().getTime() - sourceReceivedAt.getTime();
    if (postClaimAgeMs > MAX_RELAY_MESSAGE_AGE_MS) {
      try {
        await deps.store.markFailedByOwner(
          processedMessageId,
          deliveryOwnerToken,
          'stale_before_delivery',
        );
      } catch {
        logger.warn('Failed to terminalize stale owned delivery', {
          mailboxId: mailbox.id,
          processedMessageId,
        });
      }
      logger.info('Graph message job skipped: stale after ownership wait', {
        mailboxId: mailbox.id,
        ageMinutes: Math.round(postClaimAgeMs / 60_000),
        maxAgeMinutes: MAX_RELAY_MESSAGE_AGE_MINUTES,
      });
      safeRecordCodeEvent(
        audit,
        {
          mailboxEmail: mailbox.emailAddress,
          customerName: mailbox.customerName ?? undefined,
          status: 'CODE_SKIPPED_STALE',
          maskedCode,
          confidence: detection.confidenceScore,
          source: 'webhook',
          receivedAt,
          message: `stale_gt_${MAX_RELAY_MESSAGE_AGE_MINUTES}m`,
        },
        logger,
      );
      return {
        ok: false,
        status: 'SKIPPED_STALE',
        ...baseResultKeys,
        detectorConfidence: detection.confidenceScore,
        maskedCode,
        sentToTelegram: false,
        reason: 'stale_message',
      };
    }
  }

  // Step 9: load Telegram mapping. There is no fallback chat id.
  let mapping: TelegramMappingLookup | null = null;
  try {
    mapping = await deps.telegramMapping.findActiveMappingForMailboxId(
      mailbox.id,
    );
  } catch {
    logger.warn('Telegram mapping lookup failed', { mailboxId: mailbox.id });
    mapping = null;
  }

  if (!mapping || !isNonEmptyString(mapping.telegramChatId)) {
    // TASK-090 — release the delivery lease (attempts stay consumed): nothing
    // was sent, and a mapping added within the freshness window lets a later
    // duplicate job retry cleanly instead of waiting out this lease. Routing
    // rules are unchanged — there is still no fallback chat id.
    try {
      await deps.store.releaseDelivery(processedMessageId, deliveryOwnerToken);
    } catch {
      logger.warn('Failed to release delivery lease (no mapping)', {
        mailboxId: mailbox.id,
        processedMessageId,
      });
    }
    logger.info('Graph message job skipped: no active Telegram mapping', {
      mailboxId: mailbox.id,
    });
    safeRecordCodeEvent(
      audit,
      {
        mailboxEmail: mailbox.emailAddress,
        customerName: mailbox.customerName ?? undefined,
        status: 'CODE_DETECTED',
        maskedCode,
        confidence: detection.confidenceScore,
        source: 'webhook',
        receivedAt,
        message: 'No active Telegram mapping',
      },
      logger,
    );
    return {
      ok: false,
      status: 'SKIPPED_NO_TELEGRAM_MAPPING',
      ...baseResultKeys,
      detectorConfidence: detection.confidenceScore,
      maskedCode,
      sentToTelegram: false,
      reason: 'no_active_mapping',
    };
  }

  // Step 10: send Telegram. Full retry/backoff lives in TASK-033.
  const telegramText = buildTelegramText({
    mailboxEmail: mailbox.emailAddress,
    fromHeader,
    subject,
    code,
    receivedAt,
  });

  // TASK-055 — shared-destination burst guard. Many mailboxes can route to the
  // same reusable destination; space sends to one chat/topic so a burst does not
  // trip Telegram's per-chat flood limit. This is a bounded in-line delay (never
  // a queue retry), so it cannot interact with the dedup claim above. Routing is
  // unchanged — the throttle only reads the opaque destination key.
  if (deps.destinationThrottle) {
    const destinationKey = buildDestinationKey(
      mapping.telegramChatId,
      mapping.telegramThreadId,
    );
    const { waitMs } = deps.destinationThrottle.reserve(destinationKey);
    if (waitMs > 0) {
      logger.info('Throttling Telegram send for shared destination', {
        mailboxId: mailbox.id,
        waitMs,
      });
      // TASK-068C — record the throttle wait (ms only). Best-effort.
      recordWorkerMetricSafely(() =>
        deps.metrics?.recordDestinationThrottleWait(waitMs),
      );
      const sleep = deps.sleep ?? defaultSleep;
      await sleep(waitMs);
    }
  }

  // TASK-068B — global bot pacing. After the per-destination spacing, also pace
  // against ALL bot sends so a burst spread across many different destinations
  // cannot trip Telegram's global bot rate limit. This wait is independently
  // capped by the pacer, so total delay stays bounded and routing is unchanged.
  if (deps.globalSendThrottle) {
    // TASK-070 — reserve() may be async (Redis-backed cross-process pacer); the
    // in-memory pacer resolves synchronously so awaiting it is a no-op.
    const { waitMs } = await deps.globalSendThrottle.reserve();
    if (waitMs > 0) {
      logger.info('Pacing Telegram send for global bot rate limit', {
        mailboxId: mailbox.id,
        waitMs,
      });
      // TASK-068C — record the global pacing wait (ms only). Best-effort.
      recordWorkerMetricSafely(() =>
        deps.metrics?.recordGlobalThrottleWait(waitMs),
      );
      const sleep = deps.sleep ?? defaultSleep;
      await sleep(waitMs);
    }
  }

  try {
    await deps.telegramSender.sendTelegramMessage({
      chatId: mapping.telegramChatId,
      text: telegramText,
      messageThreadId: mapping.telegramThreadId ?? undefined,
    });
  } catch (err: unknown) {
    const reason =
      err instanceof TelegramSendError ? err.kind : 'unknown';
    // TASK-090 (DF-90-4) — split permanent vs retryable delivery failures.
    // ONLY an explicit `retryable: false` verdict (attached by the TASK-033
    // retry adapter from telegram-error.ts) is permanent; anything unclassified
    // stays on the conservative retryable path (previous behaviour).
    const isPermanentFailure =
      err instanceof TelegramSendError && err.retryable === false;
    const failureCategory =
      err instanceof TelegramSendError && typeof err.statusCode === 'number'
        ? `${err.kind}_${err.statusCode}`
        : reason;

    logger.warn('Telegram send failed', {
      mailboxId: mailbox.id,
      reason: failureCategory,
      permanent: isPermanentFailure,
    });
    safeRecordCodeEvent(
      audit,
      {
        mailboxEmail: mailbox.emailAddress,
        customerName: mailbox.customerName ?? undefined,
        status: 'TELEGRAM_SEND_FAILED',
        maskedCode,
        confidence: detection.confidenceScore,
        telegramGroupName: mapping.telegramGroupName ?? undefined,
        source: 'webhook',
        receivedAt,
        message: failureCategory,
      },
      logger,
    );

    if (isPermanentFailure) {
      // Terminal FAILED, fenced on our owner token. The worker RETURNS this
      // status (no throw), so no BullMQ attempt is burned on an error that a
      // retry cannot fix, and no later job auto-resends this message.
      try {
        await deps.store.markFailedByOwner(
          processedMessageId,
          deliveryOwnerToken,
          failureCategory,
        );
      } catch {
        logger.warn('Failed to mark delivery terminally failed', {
          mailboxId: mailbox.id,
          processedMessageId,
        });
      }
      return {
        ok: false,
        status: 'FAILED_TELEGRAM_PERMANENT',
        ...baseResultKeys,
        detectorConfidence: detection.confidenceScore,
        maskedCode,
        sentToTelegram: false,
        reason,
      };
    }

    // Retryable (or unclassified): release the lease NOW — the failure is
    // known (we caught it), so the next BullMQ attempt may reclaim immediately
    // instead of waiting out the lease. Attempts stay consumed, keeping the
    // total budget bounded. The worker throws for this status, which is what
    // schedules that next attempt.
    try {
      await deps.store.releaseDelivery(processedMessageId, deliveryOwnerToken);
    } catch {
      logger.warn('Failed to release delivery lease after send failure', {
        mailboxId: mailbox.id,
        processedMessageId,
      });
    }
    return {
      ok: false,
      status: 'FAILED_TELEGRAM_SEND',
      ...baseResultKeys,
      detectorConfidence: detection.confidenceScore,
      maskedCode,
      sentToTelegram: false,
      reason,
    };
  }

  // Step 11: bookkeeping. Failures here MUST NOT undo Telegram delivery.
  // TASK-090 — the SENT write is fenced on our delivery-owner token. `false`
  // means ownership was taken over while our send was in flight (we were
  // presumed dead): we never overwrite the newer owner's state and we never
  // repeat the external side effect — the remote delivery already happened,
  // which is exactly the documented bounded-duplicate ambiguity window.
  try {
    const recorded = await markMessageAsSent(
      processedMessageId,
      deps.store,
      now(),
      deliveryOwnerToken,
    );
    if (!recorded) {
      logger.warn(
        'Telegram delivered but SENT bookkeeping lost delivery ownership',
        {
          mailboxId: mailbox.id,
          processedMessageId,
        },
      );
    }
  } catch {
    logger.warn('Failed to mark processed message as sent', {
      mailboxId: mailbox.id,
      processedMessageId,
    });
  }

  safeRecordCodeEvent(
    audit,
    {
      mailboxEmail: mailbox.emailAddress,
      customerName: mailbox.customerName ?? undefined,
      status: 'CODE_SENT',
      maskedCode,
      confidence: detection.confidenceScore,
      telegramGroupName: mapping.telegramGroupName ?? undefined,
      source: 'webhook',
      receivedAt,
    },
    logger,
  );
  safeCreateAuditLog(
    audit,
    {
      action: 'CODE_SENT',
      entityType: 'code_event',
      entityId: mailbox.id,
      severity: 'info',
      summary: 'Verification code sent to Telegram',
      metadata: {
        mailboxId: mailbox.id,
        maskedCode,
        detectorConfidence: detection.confidenceScore,
        telegramGroupName: mapping.telegramGroupName ?? null,
      },
    },
    logger,
  );

  logger.info('Graph message job sent verification code to Telegram', {
    mailboxId: mailbox.id,
    maskedCode,
    detectorConfidence: detection.confidenceScore,
  });

  return {
    ok: true,
    status: 'CODE_SENT',
    ...baseResultKeys,
    detectorConfidence: detection.confidenceScore,
    maskedCode,
    sentToTelegram: true,
  };
}
