import { describe, it, expect, vi } from 'vitest';
import {
  handleMicrosoftGraphNotifications,
  parseNotificationCollection,
  type PrismaClientLike,
  type MicrosoftGraphChangeNotificationCollection,
} from '@/services/microsoft/webhook-notification.service';
import { hashClientState } from '@/services/microsoft/graph-subscription.service';

const SUBSCRIPTION_ID = 'sub-guid-aaaa-bbbb';
const MAILBOX_ID = 'mailbox-test-1';
const CLIENT_STATE = 'super-secret-client-state-value';
const WRONG_CLIENT_STATE = 'wrong-client-state';
const MESSAGE_ID = 'AAMkAGNiYzAxNjAtY2Y0ZS00OWQ0';
const RESOURCE = `users/abc/mailFolders('Inbox')/messages/${MESSAGE_ID}`;

interface FakeSubscriptionRow {
  subscriptionId: string;
  mailboxId: string;
  clientStateHash: string;
  status: 'ACTIVE' | 'EXPIRED' | 'FAILED' | 'RENEWING';
}

function createFakePrisma(rows: FakeSubscriptionRow[]): PrismaClientLike {
  return {
    graphSubscription: {
      findUnique: vi.fn(async ({ where }) => {
        const found = rows.find((r) => r.subscriptionId === where.subscriptionId);
        return found ?? null;
      }),
    },
  };
}

function makeCollection(
  items: Array<Record<string, unknown>>,
): MicrosoftGraphChangeNotificationCollection {
  const parsed = parseNotificationCollection({ value: items });
  if (parsed === null) {
    throw new Error('test helper produced invalid collection');
  }
  return parsed;
}

function activeRow(): FakeSubscriptionRow {
  return {
    subscriptionId: SUBSCRIPTION_ID,
    mailboxId: MAILBOX_ID,
    clientStateHash: hashClientState(CLIENT_STATE),
    status: 'ACTIVE',
  };
}

// ---------------------------------------------------------------------------
// parseNotificationCollection
// ---------------------------------------------------------------------------

describe('parseNotificationCollection', () => {
  it('returns null when body is not an object', () => {
    expect(parseNotificationCollection(null)).toBeNull();
    expect(parseNotificationCollection('string')).toBeNull();
    expect(parseNotificationCollection(42)).toBeNull();
  });

  it('returns null when value is missing', () => {
    expect(parseNotificationCollection({})).toBeNull();
  });

  it('returns null when value is not an array', () => {
    expect(parseNotificationCollection({ value: 'nope' })).toBeNull();
    expect(parseNotificationCollection({ value: {} })).toBeNull();
  });

  it('parses an empty value array as an empty collection', () => {
    const result = parseNotificationCollection({ value: [] });
    expect(result).not.toBeNull();
    expect(result?.value).toHaveLength(0);
  });

  it('preserves known fields and ignores unknown shapes inside resourceData', () => {
    const result = parseNotificationCollection({
      value: [
        {
          subscriptionId: SUBSCRIPTION_ID,
          clientState: CLIENT_STATE,
          changeType: 'created',
          resource: RESOURCE,
          resourceData: { id: MESSAGE_ID, '@odata.type': '#Microsoft.Graph.Message' },
        },
      ],
    });
    expect(result?.value[0].subscriptionId).toBe(SUBSCRIPTION_ID);
    expect(result?.value[0].clientState).toBe(CLIENT_STATE);
    expect(result?.value[0].changeType).toBe('created');
    expect(result?.value[0].resourceData?.id).toBe(MESSAGE_ID);
  });
});

// ---------------------------------------------------------------------------
// handleMicrosoftGraphNotifications
// ---------------------------------------------------------------------------

describe('handleMicrosoftGraphNotifications — single item', () => {
  it('accepts a valid created notification with matching clientState', async () => {
    const prisma = createFakePrisma([activeRow()]);
    const collection = makeCollection([
      {
        subscriptionId: SUBSCRIPTION_ID,
        clientState: CLIENT_STATE,
        changeType: 'created',
        resource: RESOURCE,
        resourceData: { id: MESSAGE_ID },
      },
    ]);

    const result = await handleMicrosoftGraphNotifications(collection, { prisma });
    expect(result.received).toBe(1);
    expect(result.accepted).toHaveLength(1);
    expect(result.skipped).toHaveLength(0);
    expect(result.accepted[0]).toMatchObject({
      subscriptionId: SUBSCRIPTION_ID,
      mailboxId: MAILBOX_ID,
      graphMessageId: MESSAGE_ID,
      changeType: 'created',
      resource: RESOURCE,
    });
    expect(typeof result.accepted[0].receivedAt).toBe('string');
  });

  it('skips when subscriptionId is missing', async () => {
    const prisma = createFakePrisma([activeRow()]);
    const collection = makeCollection([
      {
        clientState: CLIENT_STATE,
        changeType: 'created',
        resource: RESOURCE,
        resourceData: { id: MESSAGE_ID },
      },
    ]);

    const result = await handleMicrosoftGraphNotifications(collection, { prisma });
    expect(result.accepted).toHaveLength(0);
    expect(result.skipped).toEqual([{ reason: 'missing_subscriptionId' }]);
    expect(prisma.graphSubscription.findUnique).not.toHaveBeenCalled();
  });

  it('skips when clientState is missing', async () => {
    const prisma = createFakePrisma([activeRow()]);
    const collection = makeCollection([
      {
        subscriptionId: SUBSCRIPTION_ID,
        changeType: 'created',
        resource: RESOURCE,
        resourceData: { id: MESSAGE_ID },
      },
    ]);

    const result = await handleMicrosoftGraphNotifications(collection, { prisma });
    expect(result.accepted).toHaveLength(0);
    expect(result.skipped).toEqual([{ reason: 'missing_clientState' }]);
  });

  it('skips when changeType is missing', async () => {
    const prisma = createFakePrisma([activeRow()]);
    const collection = makeCollection([
      {
        subscriptionId: SUBSCRIPTION_ID,
        clientState: CLIENT_STATE,
        resource: RESOURCE,
        resourceData: { id: MESSAGE_ID },
      },
    ]);

    const result = await handleMicrosoftGraphNotifications(collection, { prisma });
    expect(result.skipped).toEqual([{ reason: 'missing_changeType' }]);
  });

  it('skips when changeType is not created', async () => {
    const prisma = createFakePrisma([activeRow()]);
    const collection = makeCollection([
      {
        subscriptionId: SUBSCRIPTION_ID,
        clientState: CLIENT_STATE,
        changeType: 'updated',
        resource: RESOURCE,
        resourceData: { id: MESSAGE_ID },
      },
    ]);

    const result = await handleMicrosoftGraphNotifications(collection, { prisma });
    expect(result.skipped).toEqual([{ reason: 'unsupported_changeType' }]);
  });

  it('skips when both resource and resourceData.id are missing', async () => {
    const prisma = createFakePrisma([activeRow()]);
    const collection = makeCollection([
      {
        subscriptionId: SUBSCRIPTION_ID,
        clientState: CLIENT_STATE,
        changeType: 'created',
      },
    ]);

    const result = await handleMicrosoftGraphNotifications(collection, { prisma });
    expect(result.skipped).toEqual([{ reason: 'missing_resource' }]);
  });

  it('falls back to parsing the trailing id of resource when resourceData.id is absent', async () => {
    const prisma = createFakePrisma([activeRow()]);
    const collection = makeCollection([
      {
        subscriptionId: SUBSCRIPTION_ID,
        clientState: CLIENT_STATE,
        changeType: 'created',
        resource: RESOURCE,
      },
    ]);

    const result = await handleMicrosoftGraphNotifications(collection, { prisma });
    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].graphMessageId).toBe(MESSAGE_ID);
  });

  it('skips when subscription is not found in DB', async () => {
    const prisma = createFakePrisma([]);
    const collection = makeCollection([
      {
        subscriptionId: SUBSCRIPTION_ID,
        clientState: CLIENT_STATE,
        changeType: 'created',
        resource: RESOURCE,
        resourceData: { id: MESSAGE_ID },
      },
    ]);

    const result = await handleMicrosoftGraphNotifications(collection, { prisma });
    expect(result.skipped).toEqual([{ reason: 'subscription_not_found' }]);
  });

  it('skips when subscription is not ACTIVE/RENEWING', async () => {
    const row = activeRow();
    row.status = 'EXPIRED';
    const prisma = createFakePrisma([row]);
    const collection = makeCollection([
      {
        subscriptionId: SUBSCRIPTION_ID,
        clientState: CLIENT_STATE,
        changeType: 'created',
        resource: RESOURCE,
        resourceData: { id: MESSAGE_ID },
      },
    ]);

    const result = await handleMicrosoftGraphNotifications(collection, { prisma });
    expect(result.skipped).toEqual([{ reason: 'subscription_inactive' }]);
  });

  it('skips when clientState does not match the stored hash', async () => {
    const prisma = createFakePrisma([activeRow()]);
    const collection = makeCollection([
      {
        subscriptionId: SUBSCRIPTION_ID,
        clientState: WRONG_CLIENT_STATE,
        changeType: 'created',
        resource: RESOURCE,
        resourceData: { id: MESSAGE_ID },
      },
    ]);

    const result = await handleMicrosoftGraphNotifications(collection, { prisma });
    expect(result.skipped).toEqual([{ reason: 'invalid_clientState' }]);
  });
});

describe('handleMicrosoftGraphNotifications — batch handling', () => {
  it('processes a mixed batch (valid + invalid + wrong clientState)', async () => {
    const prisma = createFakePrisma([activeRow()]);
    const collection = makeCollection([
      // Valid
      {
        subscriptionId: SUBSCRIPTION_ID,
        clientState: CLIENT_STATE,
        changeType: 'created',
        resource: RESOURCE,
        resourceData: { id: MESSAGE_ID },
      },
      // Invalid clientState
      {
        subscriptionId: SUBSCRIPTION_ID,
        clientState: WRONG_CLIENT_STATE,
        changeType: 'created',
        resource: RESOURCE,
        resourceData: { id: MESSAGE_ID },
      },
      // Missing subscriptionId
      {
        clientState: CLIENT_STATE,
        changeType: 'created',
        resource: RESOURCE,
        resourceData: { id: MESSAGE_ID },
      },
    ]);

    const result = await handleMicrosoftGraphNotifications(collection, { prisma });
    expect(result.received).toBe(3);
    expect(result.accepted).toHaveLength(1);
    expect(result.skipped).toHaveLength(2);
    const reasons = result.skipped.map((s) => s.reason).sort();
    expect(reasons).toEqual(['invalid_clientState', 'missing_subscriptionId']);
  });

  it('treats a thrown DB error as a skipped item without crashing the batch', async () => {
    const prisma: PrismaClientLike = {
      graphSubscription: {
        findUnique: vi.fn(async () => {
          throw new Error('db down');
        }),
      },
    };
    const collection = makeCollection([
      {
        subscriptionId: SUBSCRIPTION_ID,
        clientState: CLIENT_STATE,
        changeType: 'created',
        resource: RESOURCE,
        resourceData: { id: MESSAGE_ID },
      },
    ]);

    const result = await handleMicrosoftGraphNotifications(collection, { prisma });
    expect(result.received).toBe(1);
    expect(result.accepted).toHaveLength(0);
    expect(result.skipped).toHaveLength(1);
  });
});
