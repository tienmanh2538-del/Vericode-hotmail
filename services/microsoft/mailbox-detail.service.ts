import { prisma } from '@/lib/prisma';
import type {
  GraphSubscriptionStatusValue,
  MailboxProviderValue,
  MailboxStatusValue,
  TelegramMappingStatusValue,
} from '@/services/microsoft/mailbox-list.service';

export type ProcessedMessageStatusValue =
  | 'DETECTED'
  | 'SENT'
  | 'FAILED'
  | 'SKIPPED_LOW_CONFIDENCE'
  | 'DUPLICATE';

export interface MailboxDetailMailbox {
  id: string;
  emailAddress: string;
  provider: MailboxProviderValue;
  status: MailboxStatusValue;
  ownerCustomerName: string | null;
  customerName: string | null;
  tokenLastRefreshedAt: Date | null;
  lastSuccessfulSyncAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MailboxDetailTelegramMapping {
  id: string;
  status: TelegramMappingStatusValue;
  telegramGroupName: string | null;
  telegramChatIdMasked: string;
  // TASK-041 — forum topic destination. `telegramThreadId` is not sensitive
  // (it is a public message id within the group), so it is shown unmasked.
  telegramTopicName: string | null;
  telegramThreadId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MailboxDetailGraphSubscription {
  id: string;
  subscriptionIdMasked: string;
  resource: string;
  status: GraphSubscriptionStatusValue;
  expirationDateTime: Date;
  lastRenewedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MailboxDetailProcessedMessage {
  id: string;
  graphMessageIdTruncated: string;
  internetMessageIdTruncated: string | null;
  receivedAt: Date;
  senderEmail: string;
  status: ProcessedMessageStatusValue;
  sentToTelegramAt: Date | null;
  createdAt: Date;
}

export interface MailboxDetail {
  mailbox: MailboxDetailMailbox;
  telegramMappings: MailboxDetailTelegramMapping[];
  graphSubscriptions: MailboxDetailGraphSubscription[];
  recentProcessedMessages: MailboxDetailProcessedMessage[];
}

const RECENT_MESSAGES_LIMIT = 10;

function maskChatId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= 4) return '••••';
  return `••••${trimmed.slice(-4)}`;
}

function maskSubscriptionId(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length <= 6) return '••••';
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function truncateId(raw: string, head = 10): string {
  const trimmed = raw.trim();
  if (trimmed.length <= head) return trimmed;
  return `${trimmed.slice(0, head)}…`;
}

// Whitelisted projection. We NEVER select sensitive fields so they cannot
// reach UI props even by accident:
//   - Mailbox.encryptedRefreshToken, microsoftUserId
//   - TelegramMapping.telegramChatId (raw) — only masked form leaves this layer
//   - GraphSubscription.clientStateHash, subscriptionId (raw) — only masked form leaves
//   - ProcessedMessage.codeHash, subjectHash — never exposed
export async function getMailboxDetailById(
  id: string,
): Promise<MailboxDetail | null> {
  if (!id) return null;

  const row = await prisma.mailbox.findUnique({
    where: { id },
    select: {
      id: true,
      emailAddress: true,
      provider: true,
      status: true,
      ownerCustomerName: true,
      tokenLastRefreshedAt: true,
      lastSuccessfulSyncAt: true,
      createdAt: true,
      updatedAt: true,
      customer: {
        select: { name: true },
      },
      telegramMappings: {
        orderBy: { updatedAt: 'desc' },
        select: {
          id: true,
          status: true,
          telegramGroupName: true,
          telegramChatId: true,
          telegramTopicName: true,
          telegramThreadId: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      graphSubscriptions: {
        orderBy: { expirationDateTime: 'desc' },
        select: {
          id: true,
          subscriptionId: true,
          resource: true,
          status: true,
          expirationDateTime: true,
          lastRenewedAt: true,
          createdAt: true,
          updatedAt: true,
        },
      },
      processedMessages: {
        orderBy: { receivedAt: 'desc' },
        take: RECENT_MESSAGES_LIMIT,
        select: {
          id: true,
          graphMessageId: true,
          internetMessageId: true,
          receivedAt: true,
          senderEmail: true,
          status: true,
          sentToTelegramAt: true,
          createdAt: true,
        },
      },
    },
  });

  if (!row) return null;

  return {
    mailbox: {
      id: row.id,
      emailAddress: row.emailAddress,
      provider: row.provider as MailboxProviderValue,
      status: row.status as MailboxStatusValue,
      ownerCustomerName: row.ownerCustomerName,
      customerName: row.customer?.name ?? null,
      tokenLastRefreshedAt: row.tokenLastRefreshedAt,
      lastSuccessfulSyncAt: row.lastSuccessfulSyncAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    },
    telegramMappings: row.telegramMappings.map((mapping) => ({
      id: mapping.id,
      status: mapping.status as TelegramMappingStatusValue,
      telegramGroupName: mapping.telegramGroupName,
      telegramChatIdMasked: maskChatId(mapping.telegramChatId),
      telegramTopicName: mapping.telegramTopicName ?? null,
      telegramThreadId: mapping.telegramThreadId ?? null,
      createdAt: mapping.createdAt,
      updatedAt: mapping.updatedAt,
    })),
    graphSubscriptions: row.graphSubscriptions.map((subscription) => ({
      id: subscription.id,
      subscriptionIdMasked: maskSubscriptionId(subscription.subscriptionId),
      resource: subscription.resource,
      status: subscription.status as GraphSubscriptionStatusValue,
      expirationDateTime: subscription.expirationDateTime,
      lastRenewedAt: subscription.lastRenewedAt,
      createdAt: subscription.createdAt,
      updatedAt: subscription.updatedAt,
    })),
    recentProcessedMessages: row.processedMessages.map((message) => ({
      id: message.id,
      graphMessageIdTruncated: truncateId(message.graphMessageId),
      internetMessageIdTruncated: message.internetMessageId
        ? truncateId(message.internetMessageId)
        : null,
      receivedAt: message.receivedAt,
      senderEmail: message.senderEmail,
      status: message.status as ProcessedMessageStatusValue,
      sentToTelegramAt: message.sentToTelegramAt,
      createdAt: message.createdAt,
    })),
  };
}
