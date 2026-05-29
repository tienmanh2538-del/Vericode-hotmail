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
  claimMessageForProcessing,
  markMessageAsSent,
  type ProcessedMessageStore,
} from './deduplication.service';
import { extractVerificationCode } from './code-extractor.service';
import { detectFacebookVerificationEmail } from './facebook-detector.service';
import {
  GraphMailError,
  type GraphMailMessage,
} from '@/services/microsoft/graph-mail.service';
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
import { createLogger, type Logger } from '@/lib/logger';

const FACEBOOK_DETECTOR_PASS_THRESHOLD = 70;

export type GraphMessagePipelineStatus =
  | 'CODE_SENT'
  | 'SKIPPED_DUPLICATE'
  | 'SKIPPED_MAILBOX_NOT_ACTIVE'
  | 'SKIPPED_NOT_FACEBOOK_VERIFICATION'
  | 'SKIPPED_LOW_CONFIDENCE'
  | 'SKIPPED_NO_CODE'
  | 'SKIPPED_NO_TELEGRAM_MAPPING'
  | 'FAILED_GRAPH_FETCH'
  | 'FAILED_TELEGRAM_SEND'
  | 'FAILED_RECONNECT_REQUIRED'
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
    if (err.kind === 'auth' || err.kind === 'permission') {
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
  const now = deps.now ?? (() => new Date());
  const audit = deps.audit;

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
  } catch {
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
  const earlyExisting = await deps.store.findByGraphMessageId(
    mailbox.id,
    normalized.graphMessageId,
  );
  if (earlyExisting) {
    logger.info('Graph message job skipped: duplicate (graph message id)', {
      mailboxId: mailbox.id,
      processedMessageId: earlyExisting.id,
    });
    safeRecordCodeEvent(
      audit,
      {
        mailboxEmail: mailbox.emailAddress,
        customerName: mailbox.customerName ?? undefined,
        status: 'CODE_SKIPPED_DUPLICATE',
        source: 'webhook',
        receivedAt,
        message: 'Duplicate Graph message id',
      },
      logger,
    );
    return {
      ok: false,
      status: 'SKIPPED_DUPLICATE',
      ...baseResultKeys,
      sentToTelegram: false,
      reason: 'duplicate_graph_message_id',
    };
  }
  if (internetMessageId) {
    const earlyImid = await deps.store.findByInternetMessageId(
      mailbox.id,
      internetMessageId,
    );
    if (earlyImid) {
      logger.info('Graph message job skipped: duplicate (internet message id)', {
        mailboxId: mailbox.id,
        processedMessageId: earlyImid.id,
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

  // Step 8: claim the message for processing (covers code+bucket dedup).
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
  );

  if (dedupe.isDuplicate) {
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

  if (!dedupe.shouldProcess || !dedupe.processedMessageId) {
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
  }

  const processedMessageId = dedupe.processedMessageId;

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

  try {
    await deps.telegramSender.sendTelegramMessage({
      chatId: mapping.telegramChatId,
      text: telegramText,
    });
  } catch (err: unknown) {
    const reason =
      err instanceof TelegramSendError ? err.kind : 'unknown';
    logger.warn('Telegram send failed', {
      mailboxId: mailbox.id,
      reason,
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
        message: reason,
      },
      logger,
    );
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
  try {
    await markMessageAsSent(processedMessageId, deps.store, now());
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
