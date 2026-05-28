import { describe, it, expect, vi } from 'vitest';
import {
  MailboxConnectError,
  saveConnectedMailbox,
  type PrismaClientLike,
  type SaveConnectedMailboxDeps,
} from '@/services/microsoft/mailbox-connect.service';
import type {
  AuditLogListItem,
  CreateAuditLogInput,
} from '@/services/logs/audit-log.service';

const FAKE_REFRESH_TOKEN = 'fake-refresh-token-do-not-leak';
const ANOTHER_REFRESH_TOKEN = 'another-refresh-token-also-secret';
const FAKE_ACCESS_TOKEN = 'fake-access-token-do-not-leak';

interface StoredMailbox {
  id: string;
  emailAddress: string;
  provider: 'MICROSOFT';
  microsoftUserId: string;
  encryptedRefreshToken: string;
  status: string;
  tokenLastRefreshedAt: Date | null;
  createdById: string | null;
}

function createFakePrisma(): {
  prisma: PrismaClientLike;
  store: StoredMailbox[];
} {
  const store: StoredMailbox[] = [];
  let idCounter = 0;

  const prisma: PrismaClientLike = {
    mailbox: {
      async findFirst({ where }) {
        return (
          store.find(
            (m) =>
              m.provider === where.provider &&
              m.microsoftUserId === where.microsoftUserId,
          ) ?? null
        );
      },
      async findUnique({ where }) {
        return store.find((m) => m.emailAddress === where.emailAddress) ?? null;
      },
      async update({ where, data }) {
        const target = store.find((m) => m.id === where.id);
        if (!target) throw new Error('not found');
        Object.assign(target, data);
        return { ...target };
      },
      async create({ data }) {
        idCounter += 1;
        const record: StoredMailbox = {
          id: `mb_${idCounter}`,
          emailAddress: data.emailAddress as string,
          provider: data.provider as 'MICROSOFT',
          microsoftUserId: data.microsoftUserId as string,
          encryptedRefreshToken: data.encryptedRefreshToken as string,
          status: data.status as string,
          tokenLastRefreshedAt: (data.tokenLastRefreshedAt as Date) ?? null,
          createdById: (data.createdById as string | null) ?? null,
        };
        store.push(record);
        return { ...record };
      },
    },
  };

  return { prisma, store };
}

function fakeEncrypt(plaintext: string): string {
  return `enc::${Buffer.from(plaintext, 'utf8').toString('base64')}`;
}

function makeAuditCollector(): {
  audit: SaveConnectedMailboxDeps['createAuditLog'];
  calls: CreateAuditLogInput[];
} {
  const calls: CreateAuditLogInput[] = [];
  const audit: SaveConnectedMailboxDeps['createAuditLog'] = (input) => {
    calls.push(input);
    const item: AuditLogListItem = {
      id: `aud_${calls.length}`,
      createdAt: '2026-05-28T00:00:00.000Z',
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId ?? null,
      actorUserId: input.actorUserId ?? null,
      actorEmail: input.actorEmail ?? null,
      ipAddress: input.ipAddress ?? null,
      severity: input.severity ?? 'info',
      summary: input.summary ?? null,
      metadata: (input.metadata as Record<string, unknown> | null) ?? null,
    };
    return item;
  };
  return { audit, calls };
}

describe('saveConnectedMailbox — Case 1: save new mailbox', () => {
  it('creates a new ACTIVE mailbox and encrypts the refresh token', async () => {
    const { prisma, store } = createFakePrisma();
    const { audit, calls } = makeAuditCollector();
    const fixedNow = new Date('2026-05-28T10:00:00.000Z');

    const result = await saveConnectedMailbox(
      {
        microsoftUserId: 'ms-user-001',
        emailAddress: 'Client@Example.com',
        displayName: 'Example Client',
        refreshToken: FAKE_REFRESH_TOKEN,
        scope: 'Mail.Read offline_access User.Read',
      },
      {
        prisma,
        encryptSecret: fakeEncrypt,
        createAuditLog: audit,
        now: () => fixedNow,
      },
    );

    expect(result.created).toBe(true);
    expect(result.status).toBe('ACTIVE');
    expect(result.emailAddress).toBe('client@example.com');
    expect(result.mailboxId).toMatch(/^mb_/);

    expect(store).toHaveLength(1);
    const saved = store[0];
    expect(saved.provider).toBe('MICROSOFT');
    expect(saved.microsoftUserId).toBe('ms-user-001');
    expect(saved.status).toBe('ACTIVE');
    expect(saved.tokenLastRefreshedAt).toEqual(fixedNow);

    expect(saved.encryptedRefreshToken).not.toBe(FAKE_REFRESH_TOKEN);
    expect(saved.encryptedRefreshToken).not.toContain(FAKE_REFRESH_TOKEN);

    expect(calls).toHaveLength(1);
    expect(calls[0].action).toBe('MAILBOX_CONNECTED');
    expect(calls[0].entityType).toBe('mailbox');
    expect(calls[0].entityId).toBe(saved.id);
  });
});

describe('saveConnectedMailbox — Case 2: reconnect existing mailbox', () => {
  it('updates the existing row instead of creating a duplicate', async () => {
    const { prisma, store } = createFakePrisma();
    const { audit, calls } = makeAuditCollector();
    const firstNow = new Date('2026-05-28T10:00:00.000Z');
    const secondNow = new Date('2026-05-29T11:30:00.000Z');

    await saveConnectedMailbox(
      {
        microsoftUserId: 'ms-user-001',
        emailAddress: 'client@example.com',
        refreshToken: FAKE_REFRESH_TOKEN,
      },
      {
        prisma,
        encryptSecret: fakeEncrypt,
        createAuditLog: audit,
        now: () => firstNow,
      },
    );

    const firstEncrypted = store[0].encryptedRefreshToken;

    const second = await saveConnectedMailbox(
      {
        microsoftUserId: 'ms-user-001',
        emailAddress: 'client@example.com',
        refreshToken: ANOTHER_REFRESH_TOKEN,
      },
      {
        prisma,
        encryptSecret: fakeEncrypt,
        createAuditLog: audit,
        now: () => secondNow,
      },
    );

    expect(second.created).toBe(false);
    expect(second.status).toBe('ACTIVE');
    expect(store).toHaveLength(1);

    const updated = store[0];
    expect(updated.encryptedRefreshToken).not.toBe(firstEncrypted);
    expect(updated.encryptedRefreshToken).not.toContain(ANOTHER_REFRESH_TOKEN);
    expect(updated.tokenLastRefreshedAt).toEqual(secondNow);

    expect(calls).toHaveLength(2);
    expect(calls[1].summary).toBe('Mailbox reconnected');
  });

  it('matches by microsoftUserId even when email surface changes', async () => {
    const { prisma, store } = createFakePrisma();
    const { audit } = makeAuditCollector();

    await saveConnectedMailbox(
      {
        microsoftUserId: 'ms-user-002',
        emailAddress: 'old-alias@example.com',
        refreshToken: FAKE_REFRESH_TOKEN,
      },
      { prisma, encryptSecret: fakeEncrypt, createAuditLog: audit },
    );

    const second = await saveConnectedMailbox(
      {
        microsoftUserId: 'ms-user-002',
        emailAddress: 'new-alias@example.com',
        refreshToken: ANOTHER_REFRESH_TOKEN,
      },
      { prisma, encryptSecret: fakeEncrypt, createAuditLog: audit },
    );

    expect(second.created).toBe(false);
    expect(store).toHaveLength(1);
    expect(store[0].emailAddress).toBe('new-alias@example.com');
  });
});

describe('saveConnectedMailbox — Case 3: missing refresh token', () => {
  it('throws validation and never touches the DB when refresh token is empty', async () => {
    const { prisma, store } = createFakePrisma();
    const { audit, calls } = makeAuditCollector();

    await expect(
      saveConnectedMailbox(
        {
          microsoftUserId: 'ms-user-003',
          emailAddress: 'client@example.com',
          refreshToken: '',
        },
        { prisma, encryptSecret: fakeEncrypt, createAuditLog: audit },
      ),
    ).rejects.toBeInstanceOf(MailboxConnectError);

    expect(store).toHaveLength(0);
    expect(calls).toHaveLength(0);
  });

  it('throws validation when refresh token is whitespace only', async () => {
    const { prisma, store } = createFakePrisma();

    await expect(
      saveConnectedMailbox(
        {
          microsoftUserId: 'ms-user-003',
          emailAddress: 'client@example.com',
          refreshToken: '   ',
        },
        { prisma, encryptSecret: fakeEncrypt },
      ),
    ).rejects.toMatchObject({ kind: 'validation' });

    expect(store).toHaveLength(0);
  });

  it('throws validation when microsoftUserId is missing', async () => {
    const { prisma, store } = createFakePrisma();

    await expect(
      saveConnectedMailbox(
        {
          microsoftUserId: '',
          emailAddress: 'client@example.com',
          refreshToken: FAKE_REFRESH_TOKEN,
        },
        { prisma, encryptSecret: fakeEncrypt },
      ),
    ).rejects.toMatchObject({ kind: 'validation' });

    expect(store).toHaveLength(0);
  });
});

describe('saveConnectedMailbox — Case 4: email fallback to userPrincipalName', () => {
  it('accepts the resolved emailAddress when caller already fell back to UPN', async () => {
    // The fallback (profile.mail ?? profile.userPrincipalName) happens in the
    // route caller; this test verifies the service stores whatever the caller
    // resolved without rejecting UPN-style values.
    const { prisma, store } = createFakePrisma();

    const result = await saveConnectedMailbox(
      {
        microsoftUserId: 'ms-user-004',
        emailAddress: 'client@hotmail.com',
        refreshToken: FAKE_REFRESH_TOKEN,
      },
      { prisma, encryptSecret: fakeEncrypt },
    );

    expect(result.emailAddress).toBe('client@hotmail.com');
    expect(store[0].emailAddress).toBe('client@hotmail.com');
  });
});

describe('saveConnectedMailbox — Case 5: no token leakage', () => {
  it('never leaks refresh or access token in the result or audit metadata', async () => {
    const { prisma, store } = createFakePrisma();
    const { audit, calls } = makeAuditCollector();

    const result = await saveConnectedMailbox(
      {
        microsoftUserId: 'ms-user-005',
        emailAddress: 'leak-check@example.com',
        refreshToken: FAKE_REFRESH_TOKEN,
        scope: 'Mail.Read offline_access User.Read',
      },
      { prisma, encryptSecret: fakeEncrypt, createAuditLog: audit },
    );

    const serializedResult = JSON.stringify(result);
    expect(serializedResult).not.toContain(FAKE_REFRESH_TOKEN);
    expect(serializedResult).not.toContain(FAKE_ACCESS_TOKEN);

    const serializedAudit = JSON.stringify(calls);
    expect(serializedAudit).not.toContain(FAKE_REFRESH_TOKEN);
    expect(serializedAudit).not.toContain(FAKE_ACCESS_TOKEN);

    const serializedStore = JSON.stringify(store);
    expect(serializedStore).not.toContain(FAKE_REFRESH_TOKEN);
    expect(serializedStore).not.toContain(FAKE_ACCESS_TOKEN);
  });

  it('does not log the refresh token when encryption throws', async () => {
    const { prisma, store } = createFakePrisma();
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);

    const failingEncrypt = () => {
      throw new Error(`encrypt failed for ${FAKE_REFRESH_TOKEN}`);
    };

    await expect(
      saveConnectedMailbox(
        {
          microsoftUserId: 'ms-user-006',
          emailAddress: 'enc-fail@example.com',
          refreshToken: FAKE_REFRESH_TOKEN,
        },
        { prisma, encryptSecret: failingEncrypt },
      ),
    ).rejects.toMatchObject({ kind: 'encryption' });

    expect(store).toHaveLength(0);
    const serializedLogs = JSON.stringify([
      ...consoleErrorSpy.mock.calls,
      ...consoleWarnSpy.mock.calls,
    ]);
    expect(serializedLogs).not.toContain(FAKE_REFRESH_TOKEN);

    consoleErrorSpy.mockRestore();
    consoleWarnSpy.mockRestore();
  });
});

describe('saveConnectedMailbox — database failure', () => {
  it('throws database error and does not write audit log when create fails', async () => {
    const { audit, calls } = makeAuditCollector();
    const prisma: PrismaClientLike = {
      mailbox: {
        async findFirst() {
          return null;
        },
        async findUnique() {
          return null;
        },
        async update() {
          throw new Error('unreachable');
        },
        async create() {
          throw new Error('boom');
        },
      },
    };

    await expect(
      saveConnectedMailbox(
        {
          microsoftUserId: 'ms-user-007',
          emailAddress: 'db-fail@example.com',
          refreshToken: FAKE_REFRESH_TOKEN,
        },
        { prisma, encryptSecret: fakeEncrypt, createAuditLog: audit },
      ),
    ).rejects.toMatchObject({ kind: 'database' });

    expect(calls).toHaveLength(0);
  });
});
