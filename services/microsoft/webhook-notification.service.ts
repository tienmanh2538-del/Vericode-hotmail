import { prisma as defaultPrisma } from '@/lib/prisma';
import { createLogger } from '@/lib/logger';
import { verifyGraphClientState } from '@/services/microsoft/graph-subscription.service';
import type { GraphSubscriptionStatus } from '@/services/microsoft/graph-subscription.service';

const logger = createLogger();

const CHANGE_TYPE_CREATED = 'created';

// -----------------------------------------------------------------------------
// Public types
// -----------------------------------------------------------------------------

export type MicrosoftGraphChangeType = 'created' | 'updated' | 'deleted';

export interface MicrosoftGraphResourceData {
  id?: string;
  '@odata.type'?: string;
  '@odata.id'?: string;
  '@odata.etag'?: string;
}

export interface MicrosoftGraphChangeNotification {
  id?: string;
  subscriptionId?: string;
  subscriptionExpirationDateTime?: string;
  clientState?: string;
  changeType?: MicrosoftGraphChangeType | string;
  resource?: string;
  tenantId?: string;
  resourceData?: MicrosoftGraphResourceData;
}

export interface MicrosoftGraphChangeNotificationCollection {
  value: MicrosoftGraphChangeNotification[];
}

export interface AcceptedMicrosoftMailNotification {
  subscriptionId: string;
  mailboxId: string;
  graphMessageId: string;
  changeType: MicrosoftGraphChangeType;
  resource: string;
  receivedAt: string;
}

export type SkipReason =
  | 'missing_subscriptionId'
  | 'missing_clientState'
  | 'missing_changeType'
  | 'unsupported_changeType'
  | 'missing_resource'
  | 'subscription_not_found'
  | 'subscription_inactive'
  | 'invalid_clientState';

export interface SkippedNotification {
  reason: SkipReason;
}

export interface WebhookNotificationResult {
  received: number;
  accepted: AcceptedMicrosoftMailNotification[];
  skipped: SkippedNotification[];
}

// -----------------------------------------------------------------------------
// Prisma surface (minimal slice so tests can inject a fake)
// -----------------------------------------------------------------------------

interface GraphSubscriptionLookupRecord {
  mailboxId: string;
  clientStateHash: string;
  status: GraphSubscriptionStatus;
}

interface GraphSubscriptionPrismaClient {
  findUnique: (args: {
    where: { subscriptionId: string };
  }) => Promise<GraphSubscriptionLookupRecord | null>;
}

export interface PrismaClientLike {
  graphSubscription: GraphSubscriptionPrismaClient;
}

export interface WebhookNotificationDeps {
  prisma?: PrismaClientLike;
  now?: () => Date;
}

// -----------------------------------------------------------------------------
// Parsing helpers
// -----------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function parseNotificationCollection(
  body: unknown,
): MicrosoftGraphChangeNotificationCollection | null {
  if (!isRecord(body)) return null;
  const value = body.value;
  if (!Array.isArray(value)) return null;
  const notifications: MicrosoftGraphChangeNotification[] = [];
  for (const item of value) {
    if (!isRecord(item)) {
      notifications.push({});
      continue;
    }
    const resourceData = isRecord(item.resourceData)
      ? {
          id: readString(item.resourceData.id),
          '@odata.type': readString(item.resourceData['@odata.type']),
          '@odata.id': readString(item.resourceData['@odata.id']),
          '@odata.etag': readString(item.resourceData['@odata.etag']),
        }
      : undefined;

    notifications.push({
      id: readString(item.id),
      subscriptionId: readString(item.subscriptionId),
      subscriptionExpirationDateTime: readString(
        item.subscriptionExpirationDateTime,
      ),
      clientState: readString(item.clientState),
      changeType: readString(item.changeType),
      resource: readString(item.resource),
      tenantId: readString(item.tenantId),
      resourceData,
    });
  }
  return { value: notifications };
}

function extractGraphMessageId(
  notification: MicrosoftGraphChangeNotification,
): string | undefined {
  const fromResourceData = notification.resourceData?.id;
  if (fromResourceData && fromResourceData.length > 0) return fromResourceData;

  // Fallback: parse trailing id from "users/{id}/...messages/{message-id}".
  const resource = notification.resource;
  if (typeof resource !== 'string' || resource.length === 0) return undefined;
  const cleaned = resource.replace(/\/+$/, '');
  const lastSegment = cleaned.split('/').pop();
  return lastSegment && lastSegment.length > 0 ? lastSegment : undefined;
}

// -----------------------------------------------------------------------------
// Single-notification validation
// -----------------------------------------------------------------------------

interface ValidateOutcome {
  accepted?: AcceptedMicrosoftMailNotification;
  skipped?: SkippedNotification;
}

async function validateSingleNotification(
  notification: MicrosoftGraphChangeNotification,
  prisma: PrismaClientLike,
  receivedAtIso: string,
): Promise<ValidateOutcome> {
  if (!notification.subscriptionId) {
    return { skipped: { reason: 'missing_subscriptionId' } };
  }
  if (!notification.clientState) {
    return { skipped: { reason: 'missing_clientState' } };
  }
  if (!notification.changeType) {
    return { skipped: { reason: 'missing_changeType' } };
  }
  if (notification.changeType !== CHANGE_TYPE_CREATED) {
    return { skipped: { reason: 'unsupported_changeType' } };
  }

  const graphMessageId = extractGraphMessageId(notification);
  if (!graphMessageId) {
    return { skipped: { reason: 'missing_resource' } };
  }

  const subscription = await prisma.graphSubscription.findUnique({
    where: { subscriptionId: notification.subscriptionId },
  });
  if (!subscription) {
    return { skipped: { reason: 'subscription_not_found' } };
  }
  if (subscription.status !== 'ACTIVE' && subscription.status !== 'RENEWING') {
    return { skipped: { reason: 'subscription_inactive' } };
  }
  if (
    !verifyGraphClientState(notification.clientState, subscription.clientStateHash)
  ) {
    return { skipped: { reason: 'invalid_clientState' } };
  }

  return {
    accepted: {
      subscriptionId: notification.subscriptionId,
      mailboxId: subscription.mailboxId,
      graphMessageId,
      changeType: CHANGE_TYPE_CREATED,
      resource: notification.resource ?? '',
      receivedAt: receivedAtIso,
    },
  };
}

// -----------------------------------------------------------------------------
// Public entry point
// -----------------------------------------------------------------------------

export async function handleMicrosoftGraphNotifications(
  collection: MicrosoftGraphChangeNotificationCollection,
  deps: WebhookNotificationDeps = {},
): Promise<WebhookNotificationResult> {
  const prisma =
    deps.prisma ?? (defaultPrisma as unknown as PrismaClientLike);
  const now = deps.now ? deps.now() : new Date();
  const receivedAtIso = now.toISOString();

  const accepted: AcceptedMicrosoftMailNotification[] = [];
  const skipped: SkippedNotification[] = [];

  for (const notification of collection.value) {
    let outcome: ValidateOutcome;
    try {
      outcome = await validateSingleNotification(
        notification,
        prisma,
        receivedAtIso,
      );
    } catch {
      // Do not log notification body — it may contain clientState.
      logger.error('Microsoft webhook notification validation threw', {
        // Mask subscriptionId — log only existence, not value.
        hasSubscriptionId: Boolean(notification.subscriptionId),
      });
      skipped.push({ reason: 'subscription_not_found' });
      continue;
    }

    if (outcome.accepted) {
      accepted.push(outcome.accepted);
    } else if (outcome.skipped) {
      logger.warn('Microsoft webhook notification skipped', {
        reason: outcome.skipped.reason,
      });
      skipped.push(outcome.skipped);
    }
  }

  return {
    received: collection.value.length,
    accepted,
    skipped,
  };
}
