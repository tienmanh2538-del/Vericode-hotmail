import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  disconnectMailbox,
  MailboxDisconnectError,
  type MailboxDisconnectAuditPort,
  type MailboxDisconnectPrismaClient,
  type MailboxDisconnectRemoteCleanup,
} from '@/services/microsoft/mailbox-disconnect.service';

// All identifiers are synthetic — no real mailbox, token, chat id, or code.
const MAILBOX_ID = 'mbx_test_052';
const CUSTOMER_ID = 'cus_test_052';
const REMOTE_SUB_ID = 'sub_remote_052_a';

interface FakeClient {
  client: MailboxDisconnectPrismaClient;
  mailboxFindUnique: ReturnType<typeof vi.fn>;
  mailboxUpdate: ReturnType<typeof vi.fn>;
  mailboxDelete: ReturnType<typeof vi.fn>;
  mappingUpdateMany: ReturnType<typeof vi.fn>;
  mappingDeleteMany: ReturnType<typeof vi.fn>;
  subFindMany: ReturnType<typeof vi.fn>;
  subUpdateMany: ReturnType<typeof vi.fn>;
  processedDeleteMany: ReturnType<typeof vi.fn>;
  transaction: ReturnType<typeof vi.fn>;
}

function makeClient(
  options: {
    mailbox?: {
      id: string;
      status: string;
      customerId: string | null;
      provider: string;
    } | null;
    liveSubscriptionIds?: string[];
    mappingCount?: number;
    subscriptionCount?: number;
  } = {},
): FakeClient {
  const mailboxRow =
    options.mailbox === undefined
      ? { id: MAILBOX_ID, status: 'ACTIVE', customerId: CUSTOMER_ID, provider: 'MICROSOFT' }
      : options.mailbox;
  const liveIds = options.liveSubscriptionIds ?? [REMOTE_SUB_ID];

  const mailboxFindUnique = vi.fn(async () => mailboxRow);
  const mailboxUpdate = vi.fn(async () => ({ id: MAILBOX_ID }));
  const mailboxDelete = vi.fn(async () => ({ id: MAILBOX_ID }));
  const mappingUpdateMany = vi.fn(async () => ({
    count: options.mappingCount ?? 1,
  }));
  const mappingDeleteMany = vi.fn(async () => ({ count: 0 }));
  const subFindMany = vi.fn(async () =>
    liveIds.map((subscriptionId) => ({ subscriptionId })),
  );
  const subUpdateMany = vi.fn(async () => ({
    count: options.subscriptionCount ?? liveIds.length,
  }));
  const processedDeleteMany = vi.fn(async () => ({ count: 0 }));
  const transaction = vi.fn(async (ops: ReadonlyArray<Promise<unknown>>) =>
    Promise.all(ops),
  );

  const client = {
    mailbox: {
      findUnique: mailboxFindUnique,
      update: mailboxUpdate,
      delete: mailboxDelete,
    },
    telegramMapping: {
      updateMany: mappingUpdateMany,
      deleteMany: mappingDeleteMany,
    },
    graphSubscription: {
      findMany: subFindMany,
      updateMany: subUpdateMany,
    },
    processedMessage: {
      deleteMany: processedDeleteMany,
    },
    $transaction: transaction,
  } as unknown as MailboxDisconnectPrismaClient;

  return {
    client,
    mailboxFindUnique,
    mailboxUpdate,
    mailboxDelete,
    mappingUpdateMany,
    mappingDeleteMany,
    subFindMany,
    subUpdateMany,
    processedDeleteMany,
    transaction,
  };
}

function makeAuditPort(): MailboxDisconnectAuditPort & {
  recordDisconnected: ReturnType<typeof vi.fn>;
} {
  const recordDisconnected = vi.fn(async () => undefined);
  return { recordDisconnected };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

describe('disconnectMailbox — local disable first', () => {
  it('marks the mailbox DISABLED, disables active mappings, and marks subscriptions EXPIRED', async () => {
    const fake = makeClient();
    const audit = makeAuditPort();

    const result = await disconnectMailbox(MAILBOX_ID, {
      prisma: fake.client,
      audit,
    });

    expect(fake.mailboxUpdate).toHaveBeenCalledWith({
      where: { id: MAILBOX_ID },
      data: { status: 'DISABLED' },
    });
    expect(fake.mappingUpdateMany).toHaveBeenCalledWith({
      where: { mailboxId: MAILBOX_ID, status: 'ACTIVE' },
      data: { status: 'DISABLED' },
    });
    expect(fake.subUpdateMany).toHaveBeenCalledWith({
      where: { mailboxId: MAILBOX_ID, status: { in: ['ACTIVE', 'RENEWING', 'FAILED'] } },
      data: { status: 'EXPIRED' },
    });
    expect(result.alreadyDisconnected).toBe(false);
    expect(result.disabledMappingCount).toBe(1);
    expect(result.deactivatedSubscriptionCount).toBe(1);
  });

  it('NEVER hard-deletes the mailbox, mappings, or processed message history', async () => {
    const fake = makeClient();
    await disconnectMailbox(MAILBOX_ID, { prisma: fake.client, audit: makeAuditPort() });

    expect(fake.mailboxDelete).not.toHaveBeenCalled();
    expect(fake.mappingDeleteMany).not.toHaveBeenCalled();
    expect(fake.processedDeleteMany).not.toHaveBeenCalled();
  });

  it('writes a safe MAILBOX_DISCONNECTED audit entry (no secrets)', async () => {
    const fake = makeClient();
    const audit = makeAuditPort();

    await disconnectMailbox(MAILBOX_ID, {
      prisma: fake.client,
      audit,
      actor: { userId: 'u_owner', email: 'owner@test.local' },
    });

    expect(audit.recordDisconnected).toHaveBeenCalledTimes(1);
    const input = audit.recordDisconnected.mock.calls[0][0];
    expect(input).toMatchObject({
      mailboxId: MAILBOX_ID,
      customerId: CUSTOMER_ID,
      disabledMappingCount: 1,
      deactivatedSubscriptionCount: 1,
      actorUserId: 'u_owner',
      actorEmail: 'owner@test.local',
    });
    // Defensive: no credential/code/body keys leak into audit metadata.
    const serialized = JSON.stringify(input).toLowerCase();
    expect(serialized).not.toContain('token');
    expect(serialized).not.toContain('refresh');
    expect(serialized).not.toContain('secret');
  });

  it('throws not_found and performs NO writes when the mailbox is missing', async () => {
    const fake = makeClient({ mailbox: null });

    await expect(
      disconnectMailbox(MAILBOX_ID, { prisma: fake.client, audit: makeAuditPort() }),
    ).rejects.toMatchObject({ kind: 'not_found' });

    expect(fake.transaction).not.toHaveBeenCalled();
    expect(fake.mailboxUpdate).not.toHaveBeenCalled();
  });

  it('throws a validation error for an empty id without touching Prisma', async () => {
    const fake = makeClient();
    await expect(
      disconnectMailbox('   ', { prisma: fake.client }),
    ).rejects.toBeInstanceOf(MailboxDisconnectError);
    expect(fake.mailboxFindUnique).not.toHaveBeenCalled();
  });

  it('is idempotent: an already-disconnected mailbox returns alreadyDisconnected', async () => {
    const fake = makeClient({
      mailbox: { id: MAILBOX_ID, status: 'DISABLED', customerId: CUSTOMER_ID, provider: 'MICROSOFT' },
      liveSubscriptionIds: [],
      mappingCount: 0,
      subscriptionCount: 0,
    });

    const result = await disconnectMailbox(MAILBOX_ID, {
      prisma: fake.client,
      audit: makeAuditPort(),
    });

    expect(result.alreadyDisconnected).toBe(true);
    // Still safe to re-run; the mailbox remains DISABLED.
    expect(fake.mailboxUpdate).toHaveBeenCalledWith({
      where: { id: MAILBOX_ID },
      data: { status: 'DISABLED' },
    });
  });
});

describe('disconnectMailbox — best-effort remote cleanup', () => {
  it('attempts a remote delete for each live subscription on success', async () => {
    const fake = makeClient({ liveSubscriptionIds: [REMOTE_SUB_ID] });
    const remoteCleanup: MailboxDisconnectRemoteCleanup = {
      deleteRemoteSubscription: vi.fn(async () => undefined),
    };

    const result = await disconnectMailbox(MAILBOX_ID, {
      prisma: fake.client,
      audit: makeAuditPort(),
      remoteCleanup,
    });

    expect(remoteCleanup.deleteRemoteSubscription).toHaveBeenCalledWith({
      mailboxId: MAILBOX_ID,
      subscriptionId: REMOTE_SUB_ID,
    });
    expect(result.remoteCleanup).toEqual({ attempted: 1, deleted: 1, failed: 0 });
  });

  it('stays fail-safe when the remote delete fails: mailbox is still DISABLED, no throw', async () => {
    const fake = makeClient({ liveSubscriptionIds: [REMOTE_SUB_ID] });
    const remoteCleanup: MailboxDisconnectRemoteCleanup = {
      deleteRemoteSubscription: vi.fn(async () => {
        throw new Error('GRAPH_NETWORK_ERROR');
      }),
    };

    const result = await disconnectMailbox(MAILBOX_ID, {
      prisma: fake.client,
      audit: makeAuditPort(),
      remoteCleanup,
    });

    // The local disconnect is NOT rolled back by a remote failure.
    expect(fake.mailboxUpdate).toHaveBeenCalledWith({
      where: { id: MAILBOX_ID },
      data: { status: 'DISABLED' },
    });
    expect(result.remoteCleanup).toEqual({ attempted: 1, deleted: 0, failed: 1 });
  });

  it('skips remote cleanup entirely when no remote port is provided', async () => {
    const fake = makeClient({ liveSubscriptionIds: [REMOTE_SUB_ID] });
    const result = await disconnectMailbox(MAILBOX_ID, {
      prisma: fake.client,
      audit: makeAuditPort(),
    });
    expect(result.remoteCleanup).toEqual({ attempted: 0, deleted: 0, failed: 0 });
  });
});
