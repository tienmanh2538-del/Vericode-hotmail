import { describe, it, expect, vi, beforeEach } from 'vitest';

const { findUnique } = vi.hoisted(() => ({
  findUnique: vi.fn(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    mailbox: { findUnique },
  },
}));

import { getMailboxDetailById } from '@/services/microsoft/mailbox-detail.service';

const CREATED = new Date('2026-01-01T00:00:00.000Z');
const UPDATED = new Date('2026-01-02T00:00:00.000Z');
const EXPIRES = new Date('2026-02-01T00:00:00.000Z');
const RECEIVED = new Date('2026-01-15T08:30:00.000Z');

beforeEach(() => {
  findUnique.mockReset();
});

describe('getMailboxDetailById', () => {
  it('returns null when id is empty without hitting Prisma', async () => {
    const result = await getMailboxDetailById('');
    expect(result).toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('returns null when mailbox is not found', async () => {
    findUnique.mockResolvedValue(null);
    const result = await getMailboxDetailById('missing');
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(result).toBeNull();
  });

  it('uses a whitelisted select that excludes sensitive fields', async () => {
    findUnique.mockResolvedValue(null);
    await getMailboxDetailById('mbx_1');

    const call = findUnique.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.where).toEqual({ id: 'mbx_1' });

    const select = call.select;
    expect(select.encryptedRefreshToken).toBeUndefined();
    expect(select.microsoftUserId).toBeUndefined();

    expect(select.telegramMappings.select.telegramChatId).toBe(true);

    expect(select.graphSubscriptions.select.clientStateHash).toBeUndefined();

    expect(select.processedMessages.select.codeHash).toBeUndefined();
    expect(select.processedMessages.select.subjectHash).toBeUndefined();
  });

  it('maps mailbox fields and resolves customer name from relation', async () => {
    findUnique.mockResolvedValue({
      id: 'mbx_1',
      emailAddress: 'tester@hotmail.com',
      provider: 'MICROSOFT',
      status: 'ACTIVE',
      ownerCustomerName: 'Owner fallback',
      tokenLastRefreshedAt: CREATED,
      lastSuccessfulSyncAt: UPDATED,
      createdAt: CREATED,
      updatedAt: UPDATED,
      customer: { name: 'Acme Co' },
      telegramMappings: [],
      graphSubscriptions: [],
      processedMessages: [],
    });

    const result = await getMailboxDetailById('mbx_1');
    expect(result).not.toBeNull();
    expect(result!.mailbox).toEqual({
      id: 'mbx_1',
      emailAddress: 'tester@hotmail.com',
      provider: 'MICROSOFT',
      status: 'ACTIVE',
      ownerCustomerName: 'Owner fallback',
      customerName: 'Acme Co',
      tokenLastRefreshedAt: CREATED,
      lastSuccessfulSyncAt: UPDATED,
      createdAt: CREATED,
      updatedAt: UPDATED,
    });
    expect(result!.telegramMappings).toEqual([]);
    expect(result!.graphSubscriptions).toEqual([]);
    expect(result!.recentProcessedMessages).toEqual([]);
  });

  it('falls back to ownerCustomerName when customer relation is missing', async () => {
    findUnique.mockResolvedValue({
      id: 'mbx_2',
      emailAddress: 'a@b.com',
      provider: 'MICROSOFT',
      status: 'ACTIVE',
      ownerCustomerName: 'Manual owner',
      tokenLastRefreshedAt: null,
      lastSuccessfulSyncAt: null,
      createdAt: CREATED,
      updatedAt: UPDATED,
      customer: null,
      telegramMappings: [],
      graphSubscriptions: [],
      processedMessages: [],
    });

    const result = await getMailboxDetailById('mbx_2');
    expect(result!.mailbox.customerName).toBeNull();
    expect(result!.mailbox.ownerCustomerName).toBe('Manual owner');
  });

  it('masks telegramChatId so the raw value never reaches the caller', async () => {
    findUnique.mockResolvedValue({
      id: 'mbx_3',
      emailAddress: 'a@b.com',
      provider: 'MICROSOFT',
      status: 'ACTIVE',
      ownerCustomerName: null,
      tokenLastRefreshedAt: null,
      lastSuccessfulSyncAt: null,
      createdAt: CREATED,
      updatedAt: UPDATED,
      customer: null,
      telegramMappings: [
        {
          id: 'tm_1',
          status: 'ACTIVE',
          telegramGroupName: 'Codes',
          telegramChatId: '-1001234567890',
          createdAt: CREATED,
          updatedAt: UPDATED,
        },
      ],
      graphSubscriptions: [],
      processedMessages: [],
    });

    const result = await getMailboxDetailById('mbx_3');
    const mapping = result!.telegramMappings[0];
    expect(mapping.telegramChatIdMasked).toBe('••••7890');
    expect(mapping).not.toHaveProperty('telegramChatId');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('-1001234567890');
  });

  it('masks subscriptionId and never returns clientStateHash', async () => {
    findUnique.mockResolvedValue({
      id: 'mbx_4',
      emailAddress: 'a@b.com',
      provider: 'MICROSOFT',
      status: 'ACTIVE',
      ownerCustomerName: null,
      tokenLastRefreshedAt: null,
      lastSuccessfulSyncAt: null,
      createdAt: CREATED,
      updatedAt: UPDATED,
      customer: null,
      telegramMappings: [],
      graphSubscriptions: [
        {
          id: 'gs_1',
          subscriptionId: 'abcdef1234567890',
          resource: '/me/mailFolders/inbox/messages',
          status: 'ACTIVE',
          expirationDateTime: EXPIRES,
          lastRenewedAt: null,
          createdAt: CREATED,
          updatedAt: UPDATED,
        },
      ],
      processedMessages: [],
    });

    const result = await getMailboxDetailById('mbx_4');
    const subscription = result!.graphSubscriptions[0];
    expect(subscription.subscriptionIdMasked).toBe('abcd…7890');
    expect(subscription).not.toHaveProperty('subscriptionId');
    expect(subscription).not.toHaveProperty('clientStateHash');
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('abcdef1234567890');
  });

  it('truncates processed message ids and excludes codeHash / subjectHash', async () => {
    findUnique.mockResolvedValue({
      id: 'mbx_5',
      emailAddress: 'a@b.com',
      provider: 'MICROSOFT',
      status: 'ACTIVE',
      ownerCustomerName: null,
      tokenLastRefreshedAt: null,
      lastSuccessfulSyncAt: null,
      createdAt: CREATED,
      updatedAt: UPDATED,
      customer: null,
      telegramMappings: [],
      graphSubscriptions: [],
      processedMessages: [
        {
          id: 'pm_1',
          graphMessageId: 'AAMkAGI2NThlNzZmLT',
          internetMessageId: 'msg-12345@notify.facebook.com',
          receivedAt: RECEIVED,
          senderEmail: 'security@facebookmail.com',
          status: 'SENT',
          sentToTelegramAt: RECEIVED,
          createdAt: RECEIVED,
        },
      ],
    });

    const result = await getMailboxDetailById('mbx_5');
    const message = result!.recentProcessedMessages[0];
    expect(message.graphMessageIdTruncated).toBe('AAMkAGI2NT…');
    expect(message.internetMessageIdTruncated).toBe('msg-12345@…');
    expect(message).not.toHaveProperty('codeHash');
    expect(message).not.toHaveProperty('subjectHash');
  });
});
