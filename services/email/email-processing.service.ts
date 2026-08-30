import {
  claimMessageForProcessing,
  markMessageAsSent,
  type ProcessedMessageStore,
} from './deduplication.service';
import { extractVerificationCode } from './code-extractor.service';
import { detectFacebookVerificationEmail } from './facebook-detector.service';
import {
  sendTelegramMessage,
  TelegramSendError,
  type SendTelegramMessageInput,
  type SendTelegramMessageResult,
} from '@/services/telegram/telegram-sender.service';
import { createLogger } from '@/lib/logger';

const logger = createLogger();

export type ProcessMockEmailInput = {
  messageId: string;
  // mailboxId is the FK used by ProcessedMessage. In the mock flow the
  // caller may only know the address; we fall back to mailboxEmail.
  mailboxId?: string;
  mailboxEmail: string;
  from: string;
  subject: string;
  textBody?: string;
  htmlBody?: string;
  bodyPreview?: string;
  receivedAt: string | Date;
  telegramChatId?: string;
  telegramThreadId?: string;
};

export type EmailProcessingPlatform = 'facebook_meta' | 'unknown';

export type EmailProcessingStatus =
  | 'SENT'
  | 'SKIPPED_NOT_FACEBOOK_VERIFICATION'
  | 'SKIPPED_LOW_CONFIDENCE'
  | 'SKIPPED_NO_CODE'
  | 'SKIPPED_DUPLICATE'
  | 'SKIPPED_NO_TELEGRAM_MAPPING'
  | 'FAILED_TELEGRAM_SEND'
  | 'FAILED_UNEXPECTED';

export interface EmailProcessingResult {
  status: EmailProcessingStatus;
  success: boolean;
  messageId: string;
  mailboxEmail: string;
  platform?: EmailProcessingPlatform;
  maskedCode?: string;
  confidence?: number;
  reason?: string;
}

export interface TelegramDestination {
  chatId: string;
  threadId?: string | null;
}

export interface EmailProcessingDependencies {
  store: ProcessedMessageStore;
  /** @deprecated use resolveTelegramDestination */
  resolveTelegramChatId?: (mailboxKey: string) => Promise<string | null>;
  resolveTelegramDestination: (
    mailboxKey: string,
  ) => Promise<TelegramDestination | null>;
  sendTelegramMessage: (
    input: SendTelegramMessageInput,
  ) => Promise<SendTelegramMessageResult>;
  now?: () => Date;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function buildTelegramText(args: {
  mailboxEmail: string;
  from: string;
  subject: string;
  code: string;
  receivedAt: Date;
}): string {
  return [
    'Facebook/Meta verification code',
    `Mailbox: ${args.mailboxEmail}`,
    `From: ${args.from}`,
    `Subject: ${args.subject}`,
    `Code: ${args.code}`,
    `Received: ${args.receivedAt.toISOString()}`,
  ].join('\n');
}

export async function processMockEmail(
  input: ProcessMockEmailInput,
  deps: EmailProcessingDependencies,
): Promise<EmailProcessingResult> {
  const messageId = isNonEmptyString(input?.messageId)
    ? input.messageId.trim()
    : '';
  const mailboxEmail = isNonEmptyString(input?.mailboxEmail)
    ? input.mailboxEmail.trim()
    : '';

  if (!messageId || !mailboxEmail) {
    return {
      status: 'FAILED_UNEXPECTED',
      success: false,
      messageId,
      mailboxEmail,
      reason: 'INVALID_INPUT',
    };
  }

  const receivedAtDate =
    input.receivedAt instanceof Date
      ? input.receivedAt
      : new Date(String(input.receivedAt ?? ''));
  if (Number.isNaN(receivedAtDate.getTime())) {
    return {
      status: 'FAILED_UNEXPECTED',
      success: false,
      messageId,
      mailboxEmail,
      reason: 'INVALID_RECEIVED_AT',
    };
  }

  try {
    const detection = detectFacebookVerificationEmail({
      from: input.from,
      sender: input.from,
      subject: input.subject,
      bodyText: input.textBody,
      bodyPreview: input.bodyPreview,
      receivedAt: receivedAtDate,
    });

    if (!detection.isFacebookVerification) {
      logger.info('Email skipped: not Facebook verification', {
        messageId,
        mailboxEmail,
        confidence: detection.confidenceScore,
      });
      return {
        status: 'SKIPPED_NOT_FACEBOOK_VERIFICATION',
        success: false,
        messageId,
        mailboxEmail,
        platform: detection.platform,
        confidence: detection.confidenceScore,
        reason:
          detection.warnings.length > 0
            ? detection.warnings.join(',')
            : 'detector_no_match',
      };
    }

    const extraction = extractVerificationCode({
      subject: input.subject,
      bodyText: input.textBody,
      bodyHtml: input.htmlBody,
      bodyPreview: input.bodyPreview,
    });

    if (!extraction.success) {
      const status: EmailProcessingStatus =
        extraction.reason === 'LOW_CONFIDENCE'
          ? 'SKIPPED_LOW_CONFIDENCE'
          : 'SKIPPED_NO_CODE';
      logger.info('Email skipped: extraction failed', {
        messageId,
        mailboxEmail,
        reason: extraction.reason,
      });
      // Surface the *extractor* confidence here, not the detector score. The
      // "code confidence too low" outcome is decided by the extractor, so
      // reporting the detector's score (which can sit at/above its own
      // threshold) is misleading. Fall back to 0 when there is no candidate.
      const extractionConfidence = extraction.candidates[0]?.confidence ?? 0;
      return {
        status,
        success: false,
        messageId,
        mailboxEmail,
        platform: detection.platform,
        confidence: extractionConfidence,
        reason: extraction.reason,
      };
    }

    const code = extraction.code;
    const maskedCode = extraction.maskedCode;

    const dedupeMailboxId = isNonEmptyString(input.mailboxId)
      ? input.mailboxId.trim()
      : mailboxEmail;

    const dedupe = await claimMessageForProcessing(
      {
        mailboxId: dedupeMailboxId,
        graphMessageId: messageId,
        receivedAt: receivedAtDate,
        senderEmail: input.from,
        subject: input.subject,
        verificationCode: code,
      },
      deps.store,
    );

    if (dedupe.isDuplicate) {
      logger.info('Email skipped: duplicate', {
        messageId,
        mailboxEmail,
        dedupeReason: dedupe.reason,
      });
      return {
        status: 'SKIPPED_DUPLICATE',
        success: false,
        messageId,
        mailboxEmail,
        platform: detection.platform,
        confidence: detection.confidenceScore,
        maskedCode,
        reason: dedupe.reason,
      };
    }

    if (!dedupe.shouldProcess || !dedupe.processedMessageId) {
      logger.warn('Email skipped: dedupe could not claim message', {
        messageId,
        mailboxEmail,
        dedupeReason: dedupe.reason,
      });
      return {
        status: 'FAILED_UNEXPECTED',
        success: false,
        messageId,
        mailboxEmail,
        platform: detection.platform,
        maskedCode,
        reason: dedupe.reason,
      };
    }

    const processedMessageId = dedupe.processedMessageId;

    let chatId: string | null = isNonEmptyString(input.telegramChatId)
      ? input.telegramChatId.trim()
      : null;
    let threadId: string | null = isNonEmptyString(input.telegramThreadId)
      ? input.telegramThreadId.trim()
      : null;

    if (!chatId) {
      const lookupKey = isNonEmptyString(input.mailboxId)
        ? input.mailboxId.trim()
        : mailboxEmail;
      try {
        const destination = await deps.resolveTelegramDestination(lookupKey);
        chatId = destination?.chatId ?? null;
        threadId = destination?.threadId ?? null;
      } catch {
        chatId = null;
        threadId = null;
      }
    }

    if (!chatId) {
      logger.info('Email skipped: no Telegram mapping', {
        messageId,
        mailboxEmail,
      });
      return {
        status: 'SKIPPED_NO_TELEGRAM_MAPPING',
        success: false,
        messageId,
        mailboxEmail,
        platform: detection.platform,
        confidence: detection.confidenceScore,
        maskedCode,
        reason: 'no_active_mapping',
      };
    }

    const text = buildTelegramText({
      mailboxEmail,
      from: input.from,
      subject: input.subject,
      code,
      receivedAt: receivedAtDate,
    });

    try {
      await deps.sendTelegramMessage({
        chatId,
        text,
        messageThreadId: threadId ?? undefined,
      });
    } catch (err: unknown) {
      const reason =
        err instanceof TelegramSendError ? err.kind : 'unknown';
      logger.warn('Telegram send failed', {
        messageId,
        mailboxEmail,
        reason,
      });
      return {
        status: 'FAILED_TELEGRAM_SEND',
        success: false,
        messageId,
        mailboxEmail,
        platform: detection.platform,
        confidence: detection.confidenceScore,
        maskedCode,
        reason,
      };
    }

    const sentAt = (deps.now ?? (() => new Date()))();
    try {
      // TASK-090 — pass the delivery-owner token from the claim so the SENT
      // write goes through the same fenced (conditional) store path as the
      // worker pipeline. The mock flow has no concurrent delivery claimants,
      // so the condition always matches its own claim.
      await markMessageAsSent(
        processedMessageId,
        deps.store,
        sentAt,
        dedupe.deliveryOwnerToken,
      );
    } catch {
      // Telegram already received the message; failing to record SENT is a
      // bookkeeping issue, not a user-facing failure.
      logger.warn('Failed to mark processed message as sent', {
        messageId,
        mailboxEmail,
      });
    }

    logger.info('Email processed and sent to Telegram', {
      messageId,
      mailboxEmail,
      maskedCode,
    });
    return {
      status: 'SENT',
      success: true,
      messageId,
      mailboxEmail,
      platform: detection.platform,
      confidence: detection.confidenceScore,
      maskedCode,
    };
  } catch {
    logger.error('Unexpected error during email processing', {
      messageId,
      mailboxEmail,
    });
    return {
      status: 'FAILED_UNEXPECTED',
      success: false,
      messageId,
      mailboxEmail,
      reason: 'unexpected_error',
    };
  }
}

export function createDefaultEmailProcessingDependencies(
  store: ProcessedMessageStore,
): EmailProcessingDependencies {
  return {
    store,
    resolveTelegramDestination: async (key) => {
      // Imported lazily so unit tests that only import processMockEmail do
      // not pull in Prisma at module load time.
      const { findActiveMappingForMailbox } = await import(
        '@/services/telegram/telegram-mapping.service'
      );
      const mapping = await findActiveMappingForMailbox(key);
      if (!mapping) return null;
      return {
        chatId: mapping.telegramChatId,
        threadId: mapping.telegramThreadId,
      };
    },
    sendTelegramMessage,
  };
}
