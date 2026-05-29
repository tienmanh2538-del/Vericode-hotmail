import { prisma } from '@/lib/prisma';

export type MailboxStatusValue =
  | 'ACTIVE'
  | 'RECONNECT_REQUIRED'
  | 'SUBSCRIPTION_EXPIRED'
  | 'WEBHOOK_FAILED'
  | 'DISABLED'
  | 'ERROR';

export type MailboxProviderValue = 'MICROSOFT' | 'MOCK';

export type TelegramMappingStatusValue = 'ACTIVE' | 'DISABLED';

export type GraphSubscriptionStatusValue =
  | 'ACTIVE'
  | 'EXPIRED'
  | 'FAILED'
  | 'RENEWING';

export interface MailboxListItem {
  id: string;
  emailAddress: string;
  provider: MailboxProviderValue;
  status: MailboxStatusValue;
  ownerCustomerName: string | null;
  customerName: string | null;
  telegramGroupName: string | null;
  telegramChatIdMasked: string | null;
  telegramMappingStatus: TelegramMappingStatusValue | null;
  subscriptionStatus: GraphSubscriptionStatusValue | null;
  subscriptionExpiresAt: Date | null;
  lastSuccessfulSyncAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function maskChatId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (trimmed.length <= 4) return '••••';
  return `••••${trimmed.slice(-4)}`;
}

// Whitelisted projection. Mailbox.encryptedRefreshToken, microsoftUserId,
// GraphSubscription.clientStateHash / subscriptionId / resource are NEVER
// selected here so they cannot leak into UI props.
export async function listMailboxesForAdmin(): Promise<MailboxListItem[]> {
  const rows = await prisma.mailbox.findMany({
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      emailAddress: true,
      provider: true,
      status: true,
      ownerCustomerName: true,
      lastSuccessfulSyncAt: true,
      createdAt: true,
      updatedAt: true,
      customer: {
        select: { name: true },
      },
      telegramMappings: {
        orderBy: { updatedAt: 'desc' },
        take: 1,
        select: {
          telegramGroupName: true,
          telegramChatId: true,
          status: true,
        },
      },
      graphSubscriptions: {
        orderBy: { expirationDateTime: 'desc' },
        take: 1,
        select: {
          status: true,
          expirationDateTime: true,
        },
      },
    },
  });

  return rows.map<MailboxListItem>((row) => {
    const mapping = row.telegramMappings[0] ?? null;
    const subscription = row.graphSubscriptions[0] ?? null;
    return {
      id: row.id,
      emailAddress: row.emailAddress,
      provider: row.provider as MailboxProviderValue,
      status: row.status as MailboxStatusValue,
      ownerCustomerName: row.ownerCustomerName,
      customerName: row.customer?.name ?? null,
      telegramGroupName: mapping?.telegramGroupName ?? null,
      telegramChatIdMasked: mapping ? maskChatId(mapping.telegramChatId) : null,
      telegramMappingStatus: mapping
        ? (mapping.status as TelegramMappingStatusValue)
        : null,
      subscriptionStatus: subscription
        ? (subscription.status as GraphSubscriptionStatusValue)
        : null,
      subscriptionExpiresAt: subscription?.expirationDateTime ?? null,
      lastSuccessfulSyncAt: row.lastSuccessfulSyncAt,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  });
}
