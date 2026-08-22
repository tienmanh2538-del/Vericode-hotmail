// TASK-082 — Reconciliation runner tests: Prisma adapter query shape (the
// locked candidate filter), conditional reconnect marking, seam wiring
// (TASK-081 ensure / TASK-052 delete / renewal access-token port reuse), and
// the one-shot CLI argument contract.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const ensureMock = vi.fn();
const deleteGraphMock = vi.fn();
const accessTokenPortFactoryMock = vi.fn();
const refreshMock = vi.fn();
const decryptMock = vi.fn();
const encryptMock = vi.fn();

vi.mock('@/services/microsoft/mailbox-subscription-provisioning.service', async () => {
  const actual = await vi.importActual<
    typeof import('@/services/microsoft/mailbox-subscription-provisioning.service')
  >('@/services/microsoft/mailbox-subscription-provisioning.service');
  return {
    ...actual,
    ensureInboxSubscriptionForConnectedMailbox: (...args: unknown[]) =>
      ensureMock(...args),
  };
});

vi.mock('@/services/microsoft/graph-subscription.service', async () => {
  const actual = await vi.importActual<
    typeof import('@/services/microsoft/graph-subscription.service')
  >('@/services/microsoft/graph-subscription.service');
  return {
    ...actual,
    deleteGraphSubscription: (...args: unknown[]) => deleteGraphMock(...args),
  };
});

vi.mock('@/services/queue/workers/subscription-renewal-runner', async () => {
  const actual = await vi.importActual<
    typeof import('@/services/queue/workers/subscription-renewal-runner')
  >('@/services/queue/workers/subscription-renewal-runner');
  return {
    ...actual,
    createPrismaRenewalAccessTokenPort: (...args: unknown[]) =>
      accessTokenPortFactoryMock(...args),
  };
});

vi.mock('@/services/microsoft/refresh-access-token.service', async () => {
  const actual = await vi.importActual<
    typeof import('@/services/microsoft/refresh-access-token.service')
  >('@/services/microsoft/refresh-access-token.service');
  return {
    ...actual,
    refreshMicrosoftAccessToken: (...args: unknown[]) => refreshMock(...args),
  };
});

vi.mock('@/lib/security/encryption', () => ({
  decryptSecret: (...args: unknown[]) => decryptMock(...args),
  encryptSecret: (...args: unknown[]) => encryptMock(...args),
}));

// Imported after the mocks are registered.
const {
  createPrismaReconciliationRepo,
  createReconciliationEnsurePort,
  createReconciliationRemoteCleanupPort,
  buildDefaultSubscriptionReconciliationDeps,
  parseReconciliationCliArgs,
} = await import('@/services/queue/workers/subscription-reconciliation-runner');
const { BLOCKING_SUBSCRIPTION_STATUSES, CONNECT_SUBSCRIPTION_HTTP_TIMEOUT_MS } =
  await import('@/services/microsoft/mailbox-subscription-provisioning.service');
const { runSubscriptionReconciliationOnce, MAX_RECONCILIATION_LIMIT } =
  await import('@/services/microsoft/subscription-reconciliation.service');
const { RefreshAccessTokenError } = await import(
  '@/services/microsoft/refresh-access-token.service'
);
const renewalRunnerActual = await vi.importActual<
  typeof import('@/services/queue/workers/subscription-renewal-runner')
>('@/services/queue/workers/subscription-renewal-runner');

const NOW = new Date('2026-08-22T10:00:00.000Z');

function fakePrismaClient() {
  return {
    mailbox: {
      findMany: vi.fn(async () => [{ id: 'mb-1' }, { id: 'mb-2' }]),
      findUnique: vi.fn(async () => ({ status: 'ACTIVE' })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    graphSubscription: {
      findFirst: vi.fn(async (): Promise<{ id: string } | null> => null),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
  };
}

beforeEach(() => {
  ensureMock.mockReset();
  deleteGraphMock.mockReset();
  accessTokenPortFactoryMock.mockReset();
  refreshMock.mockReset();
  decryptMock.mockReset();
  encryptMock.mockReset();
});

// ---------------------------------------------------------------------------
// Prisma repo — locked candidate filter
// ---------------------------------------------------------------------------

describe('createPrismaReconciliationRepo', () => {
  it('queries candidates with the locked filter and reuses the TASK-081 blocking definition', async () => {
    const client = fakePrismaClient();
    const repo = createPrismaReconciliationRepo(client as never);

    const candidates = await repo.listReconciliationCandidates(3, NOW);
    expect(candidates).toEqual([{ mailboxId: 'mb-1' }, { mailboxId: 'mb-2' }]);

    // The single findMany carries the whole locked candidate scope: Microsoft
    // provider only, ACTIVE only (DISABLED / RECONNECT_REQUIRED /
    // SUBSCRIPTION_EXPIRED are excluded by construction), credential present,
    // and no potentially-live subscription. Expired rows do not block because
    // of the `expirationDateTime > now` bound.
    expect(client.mailbox.findMany).toHaveBeenCalledWith({
      where: {
        provider: 'MICROSOFT',
        status: 'ACTIVE',
        encryptedRefreshToken: { not: null },
        graphSubscriptions: {
          none: {
            status: { in: [...BLOCKING_SUBSCRIPTION_STATUSES] },
            expirationDateTime: { gt: NOW },
          },
        },
      },
      orderBy: { createdAt: 'asc' },
      take: 3,
      select: { id: true },
    });
    expect(BLOCKING_SUBSCRIPTION_STATUSES).toEqual(['ACTIVE', 'RENEWING', 'FAILED']);
  });

  it('reads the mailbox status and maps a missing mailbox to null', async () => {
    const client = fakePrismaClient();
    const repo = createPrismaReconciliationRepo(client as never);
    await expect(repo.getMailboxStatus('mb-1')).resolves.toBe('ACTIVE');

    client.mailbox.findUnique.mockResolvedValueOnce(null as never);
    await expect(repo.getMailboxStatus('mb-x')).resolves.toBeNull();
  });

  it('detects potentially-live subscriptions with the same blocking bound', async () => {
    const client = fakePrismaClient();
    const repo = createPrismaReconciliationRepo(client as never);

    await expect(repo.hasBlockingSubscription('mb-1', NOW)).resolves.toBe(false);
    client.graphSubscription.findFirst.mockResolvedValueOnce({ id: 'gs-1' });
    await expect(repo.hasBlockingSubscription('mb-1', NOW)).resolves.toBe(true);

    expect(client.graphSubscription.findFirst).toHaveBeenCalledWith({
      where: {
        mailboxId: 'mb-1',
        status: { in: [...BLOCKING_SUBSCRIPTION_STATUSES] },
        expirationDateTime: { gt: NOW },
      },
      select: { id: true },
    });
  });

  it('marks reconnect-required conditionally so DISABLED is never overwritten', async () => {
    const client = fakePrismaClient();
    const repo = createPrismaReconciliationRepo(client as never);

    await expect(repo.markMailboxReconnectRequiredIfActive('mb-1')).resolves.toBe(true);
    expect(client.mailbox.updateMany).toHaveBeenCalledWith({
      where: { id: 'mb-1', status: 'ACTIVE' },
      data: { status: 'RECONNECT_REQUIRED' },
    });

    // Concurrently disconnected mailbox → the conditional update matches no
    // row and reports false instead of resurrecting the DISABLED status.
    client.mailbox.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(repo.markMailboxReconnectRequiredIfActive('mb-2')).resolves.toBe(false);
  });

  it('marks a raced subscription EXPIRED by subscriptionId', async () => {
    const client = fakePrismaClient();
    const repo = createPrismaReconciliationRepo(client as never);
    await repo.markSubscriptionExpired('sub-1');
    expect(client.graphSubscription.updateMany).toHaveBeenCalledWith({
      where: { subscriptionId: 'sub-1' },
      data: { status: 'EXPIRED' },
    });
  });
});

// ---------------------------------------------------------------------------
// Seam wiring
// ---------------------------------------------------------------------------

describe('reconciliation seam wiring', () => {
  it('the ensure port delegates to the TASK-081 ensure service unchanged', async () => {
    ensureMock.mockResolvedValue({ outcome: 'created', subscriptionId: 'sub-9' });
    const port = createReconciliationEnsurePort();
    const outcome = await port.ensure({ mailboxId: 'mb-1', accessToken: 'at' });
    expect(outcome).toEqual({ outcome: 'created', subscriptionId: 'sub-9' });
    expect(ensureMock).toHaveBeenCalledWith({ mailboxId: 'mb-1', accessToken: 'at' });
  });

  it('the remote cleanup port reuses deleteGraphSubscription with a finite-timeout fetch', async () => {
    deleteGraphMock.mockResolvedValue(undefined);
    const port = createReconciliationRemoteCleanupPort();
    await port.deleteRemoteSubscription({
      mailboxId: 'mb-1',
      subscriptionId: 'sub-1',
      accessToken: 'at',
    });
    expect(deleteGraphMock).toHaveBeenCalledTimes(1);
    const [input, deps] = deleteGraphMock.mock.calls[0] as [
      Record<string, unknown>,
      { fetchImpl?: unknown },
    ];
    expect(input).toEqual({
      mailboxId: 'mb-1',
      subscriptionId: 'sub-1',
      accessToken: 'at',
    });
    expect(typeof deps.fetchImpl).toBe('function');
  });

  it('default deps reuse the renewal access-token port with a finite token timeout', () => {
    const sentinelPort = { getAccessTokenForMailbox: vi.fn() };
    accessTokenPortFactoryMock.mockReturnValue(sentinelPort);
    const deps = buildDefaultSubscriptionReconciliationDeps();
    expect(accessTokenPortFactoryMock).toHaveBeenCalledTimes(1);
    expect(deps.accessToken).toBe(sentinelPort);
    // Antigravity High fix: the reconciliation default port MUST request a
    // finite ceiling for the token-endpoint request so an operator --apply can
    // never hang on a stuck Microsoft token endpoint.
    expect(accessTokenPortFactoryMock).toHaveBeenCalledWith(undefined, {
      timeoutMs: CONNECT_SUBSCRIPTION_HTTP_TIMEOUT_MS,
    });
    expect(CONNECT_SUBSCRIPTION_HTTP_TIMEOUT_MS).toBeGreaterThan(0);
    expect(Number.isFinite(CONNECT_SUBSCRIPTION_HTTP_TIMEOUT_MS)).toBe(true);
  });

  it('the renewal access-token port forwards timeoutMs into the refresh call', async () => {
    decryptMock.mockReturnValue('plaintext-refresh');
    refreshMock.mockResolvedValue({ accessToken: 'minted-token-value' });
    const tokenClient = {
      mailbox: {
        findUnique: vi.fn(async () => ({ encryptedRefreshToken: 'cipher' })),
        update: vi.fn(async () => ({})),
      },
    };
    const port = renewalRunnerActual.createPrismaRenewalAccessTokenPort(
      tokenClient as never,
      { timeoutMs: 12_345 },
    );
    await port.getAccessTokenForMailbox('mb-1');
    expect(refreshMock).toHaveBeenCalledWith('plaintext-refresh', {
      timeoutMs: 12_345,
    });
  });

  it('the renewal caller stays unchanged: no options ⇒ no finite timeout requested', async () => {
    decryptMock.mockReturnValue('plaintext-refresh');
    refreshMock.mockResolvedValue({ accessToken: 'minted-token-value' });
    const tokenClient = {
      mailbox: {
        findUnique: vi.fn(async () => ({ encryptedRefreshToken: 'cipher' })),
        update: vi.fn(async () => ({})),
      },
    };
    const port = renewalRunnerActual.createPrismaRenewalAccessTokenPort(
      tokenClient as never,
    );
    await port.getAccessTokenForMailbox('mb-1');
    // timeoutMs undefined ⇒ fetchWithTimeout stays a pass-through, exactly the
    // pre-fix renewal behaviour.
    expect(refreshMock).toHaveBeenCalledWith('plaintext-refresh', {
      timeoutMs: undefined,
    });
  });
});

// ---------------------------------------------------------------------------
// Integration through the real renewal access-token port
// ---------------------------------------------------------------------------

function fakeServiceRepo(candidates: string[]) {
  return {
    listReconciliationCandidates: vi.fn(async (limit: number) =>
      candidates.slice(0, limit).map((mailboxId) => ({ mailboxId })),
    ),
    getMailboxStatus: vi.fn(async () => 'ACTIVE'),
    hasBlockingSubscription: vi.fn(async () => false),
    markMailboxReconnectRequiredIfActive: vi.fn(async () => true),
    markSubscriptionExpired: vi.fn(async () => undefined),
  };
}

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

describe('reconciliation through the real renewal access-token port', () => {
  it('mints the token via decrypt→refresh and persists the rotated credential encrypted', async () => {
    decryptMock.mockReturnValue('plaintext-refresh');
    refreshMock.mockResolvedValue({
      accessToken: 'minted-token-value',
      refreshToken: 'rotated-refresh',
    });
    encryptMock.mockReturnValue('enc(rotated-refresh)');
    const tokenClient = {
      mailbox: {
        findUnique: vi.fn(async () => ({ encryptedRefreshToken: 'cipher' })),
        update: vi.fn(async () => ({})),
      },
    };
    const port = renewalRunnerActual.createPrismaRenewalAccessTokenPort(
      tokenClient as never,
    );
    const ensureSpy = vi.fn(async () => ({
      outcome: 'created' as const,
      subscriptionId: 'sub-1',
    }));

    const result = await runSubscriptionReconciliationOnce(
      {
        repo: fakeServiceRepo(['mb-1']),
        accessToken: port,
        ensure: { ensure: ensureSpy },
        remoteCleanup: { deleteRemoteSubscription: vi.fn() },
        logger: silentLogger,
        now: () => NOW,
      },
      { mode: 'apply' },
    );

    expect(result.createdCount).toBe(1);
    // The in-memory access token flows straight into the ensure seam.
    expect(ensureSpy).toHaveBeenCalledWith({
      mailboxId: 'mb-1',
      accessToken: 'minted-token-value',
    });
    // Rotated refresh credential is persisted encrypted-at-rest (TASK-036).
    expect(encryptMock).toHaveBeenCalledWith('rotated-refresh');
    expect(tokenClient.mailbox.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          encryptedRefreshToken: 'enc(rotated-refresh)',
        }),
      }),
    );
  });

  it('classifies invalid_grant through the shared TASK-069C path as reconnect_required', async () => {
    decryptMock.mockReturnValue('plaintext-refresh');
    refreshMock.mockRejectedValue(
      new RefreshAccessTokenError('token_endpoint', 'rejected', {
        microsoftErrorCode: 'invalid_grant',
        httpStatus: 400,
      }),
    );
    const tokenClient = {
      mailbox: {
        findUnique: vi.fn(async () => ({ encryptedRefreshToken: 'cipher' })),
        update: vi.fn(async () => ({})),
      },
    };
    const port = renewalRunnerActual.createPrismaRenewalAccessTokenPort(
      tokenClient as never,
    );
    const repo = fakeServiceRepo(['mb-1']);
    const ensureSpy = vi.fn();

    const result = await runSubscriptionReconciliationOnce(
      {
        repo,
        accessToken: port,
        ensure: { ensure: ensureSpy },
        remoteCleanup: { deleteRemoteSubscription: vi.fn() },
        logger: silentLogger,
        now: () => NOW,
      },
      { mode: 'apply' },
    );

    expect(result.reconnectRequiredCount).toBe(1);
    expect(repo.markMailboxReconnectRequiredIfActive).toHaveBeenCalledWith('mb-1');
    expect(ensureSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// CLI argument contract
// ---------------------------------------------------------------------------

describe('parseReconciliationCliArgs', () => {
  it('defaults to a dry run with the small bounded limit', () => {
    expect(parseReconciliationCliArgs([])).toEqual({
      ok: true,
      options: { mode: 'dry_run', limit: 5, limitClamped: false },
    });
  });

  it('requires an explicit --apply for the mutating mode', () => {
    const parsed = parseReconciliationCliArgs(['--apply', '--limit', '3']);
    expect(parsed).toEqual({
      ok: true,
      options: { mode: 'apply', limit: 3, limitClamped: false },
    });
  });

  it('clamps an over-maximum limit deterministically', () => {
    const parsed = parseReconciliationCliArgs(['--limit', '999']);
    expect(parsed).toEqual({
      ok: true,
      options: {
        mode: 'dry_run',
        limit: MAX_RECONCILIATION_LIMIT,
        limitClamped: true,
      },
    });
  });

  it('rejects invalid limits and unknown arguments (no concurrency option exists)', () => {
    expect(parseReconciliationCliArgs(['--limit', '0']).ok).toBe(false);
    expect(parseReconciliationCliArgs(['--limit', 'abc']).ok).toBe(false);
    expect(parseReconciliationCliArgs(['--limit']).ok).toBe(false);
    expect(parseReconciliationCliArgs(['--concurrency', '4']).ok).toBe(false);
    expect(parseReconciliationCliArgs(['--force']).ok).toBe(false);
  });
});
