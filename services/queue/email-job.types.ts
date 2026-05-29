/**
 * TASK-026 — Queue/worker foundation for Microsoft Graph webhook notifications.
 *
 * This module exposes only constants and type definitions. It must remain free
 * of I/O so it can be imported in any context without triggering Redis or
 * BullMQ initialization.
 */

export const EMAIL_QUEUE_NAME = 'email-processing';

export const EMAIL_QUEUE_JOB_NAMES = {
  PROCESS_MICROSOFT_GRAPH_MESSAGE: 'PROCESS_MICROSOFT_GRAPH_MESSAGE',
} as const;

export type EmailQueueJobName =
  (typeof EMAIL_QUEUE_JOB_NAMES)[keyof typeof EMAIL_QUEUE_JOB_NAMES];

export const EMAIL_WEBHOOK_JOB_SOURCE = 'microsoft-webhook' as const;

export type EmailWebhookJobSource = typeof EMAIL_WEBHOOK_JOB_SOURCE;

/**
 * Payload pushed onto the email queue after a Microsoft Graph webhook
 * notification has passed clientState validation. Sensitive data (access
 * tokens, refresh tokens, client secrets, Telegram tokens, full email body,
 * verification codes, passwords) MUST NOT appear here.
 */
export interface EmailWebhookJobData {
  mailboxId: string;
  graphMessageId: string;
  subscriptionId?: string;
  resource?: string;
  changeType?: string;
  tenantId?: string;
  clientStateValidated: true;
  queuedAt: string;
  source: EmailWebhookJobSource;
}

export const FORBIDDEN_JOB_DATA_KEYS: readonly string[] = [
  'accessToken',
  'refreshToken',
  'clientSecret',
  'telegramBotToken',
  'verificationCode',
  'password',
  'body',
  'emailBody',
  'html',
  'text',
] as const;
