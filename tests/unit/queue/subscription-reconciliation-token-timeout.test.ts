// TASK-082 (Antigravity High fix) — a hung Microsoft token endpoint must never
// leave the operator one-shot `--apply` pending forever. This exercises the
// REAL chain: reconciliation service → real renewal access-token port (with a
// finite timeoutMs) → real refreshMicrosoftAccessToken → real fetchWithTimeout
// with an AbortController — only env lookup, encryption, and fetch are faked.
// No real timeout is waited: fake timers drive the 20s ceiling.

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('@/lib/env', async () => {
  const actual = await vi.importActual<typeof import('@/lib/env')>('@/lib/env');
  return {
    ...actual,
    // Synthetic, obviously-fake OAuth config — no real client secret / tenant.
    requireMicrosoftEnv: () => ({
      clientId: 'test-client-id',
      clientSecret: 'test-client-secret-placeholder',
      tenantId: 'common',
      redirectUri: 'https://app.example.test/api/microsoft/oauth/callback',
    }),
  };
});

vi.mock('@/lib/security/encryption', () => ({
  decryptSecret: () => 'plaintext-refresh-placeholder',
  encryptSecret: (value: string) => `enc(${value})`,
}));

const { createPrismaRenewalAccessTokenPort } = await import(
  '@/services/queue/workers/subscription-renewal-runner'
);
const { runSubscriptionReconciliationOnce } = await import(
  '@/services/microsoft/subscription-reconciliation.service'
);

const NOW = new Date('2026-08-22T10:00:00.000Z');
const TOKEN_TIMEOUT_MS = 20_000;

const silentLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

function fakeServiceRepo(candidates: string[]) {
  return {
    listReconciliationCandidates: vi.fn(async (limit: number) =>
      candidates.slice(0, limit).map((mailboxId) => ({ mailboxId })),
    ),
    listSubscriptionExpiredRecoveryCandidates: vi.fn(async () => []),
    getMailboxStatus: vi.fn(async () => 'ACTIVE'),
    hasBlockingSubscription: vi.fn(async () => false),
    markMailboxReconnectRequiredIfActive: vi.fn(async () => true),
    markMailboxReconnectRequiredIfSubscriptionExpired: vi.fn(async () => true),
    markMailboxActiveIfSubscriptionExpired: vi.fn(async () => true),
    markSubscriptionExpired: vi.fn(async () => undefined),
  };
}

describe('reconciliation apply with a hanging Microsoft token endpoint', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('aborts the hung request, classifies transient, and finishes the batch finitely', async () => {
    vi.useFakeTimers();

    // First token request hangs until its AbortSignal fires (real
    // cancellation); the second settles immediately with a rotated credential.
    const inits: RequestInit[] = [];
    const fetchImpl = vi.fn((_url: unknown, init?: RequestInit) => {
      inits.push(init ?? {});
      if (inits.length === 1) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          token_type: 'Bearer',
          expires_in: 3600,
          access_token: 'minted-token-value',
          refresh_token: 'rotated-refresh',
        }),
      } as unknown as Response);
    });
    vi.stubGlobal('fetch', fetchImpl);

    const tokenClient = {
      mailbox: {
        findUnique: vi.fn(async () => ({ encryptedRefreshToken: 'cipher' })),
        // TASK-085 — rotation persistence is a conditional `updateMany` (CAS win).
        updateMany: vi.fn(async () => ({ count: 1 })),
      },
    };
    const port = createPrismaRenewalAccessTokenPort(tokenClient as never, {
      timeoutMs: TOKEN_TIMEOUT_MS,
    });
    const repo = fakeServiceRepo(['mb-1', 'mb-2']);
    const ensureSpy = vi.fn(async ({ mailboxId }: { mailboxId: string }) => ({
      outcome: 'created' as const,
      subscriptionId: `sub-${mailboxId}`,
    }));

    const resultPromise = runSubscriptionReconciliationOnce(
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

    // Drive the finite ceiling — without the fix this would hang forever and
    // the run would never settle.
    await vi.advanceTimersByTimeAsync(TOKEN_TIMEOUT_MS);
    const result = await resultPromise;

    // The hung request was truly aborted via its AbortController.
    expect(inits[0]?.signal?.aborted).toBe(true);

    // Timeout is transient: the mailbox is NOT flipped to reconnect, no Graph
    // ensure/create for it, and there is no retry (one fetch per mailbox).
    expect(result.outcomes).toEqual([
      { mailboxId: 'mb-1', outcome: 'failed_transient' },
      { mailboxId: 'mb-2', outcome: 'created' },
    ]);
    expect(repo.markMailboxReconnectRequiredIfActive).not.toHaveBeenCalled();
    expect(ensureSpy).toHaveBeenCalledTimes(1);
    expect(ensureSpy).toHaveBeenCalledWith({
      mailboxId: 'mb-2',
      accessToken: 'minted-token-value',
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // The independent next mailbox completed AND its rotated refresh credential
    // was persisted encrypted-at-rest under the TASK-085 CAS (not DISABLED AND
    // expected generation G0).
    expect(tokenClient.mailbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: 'mb-2',
          status: { not: 'DISABLED' },
          encryptedRefreshToken: 'cipher',
        },
        data: expect.objectContaining({
          encryptedRefreshToken: 'enc(rotated-refresh)',
        }),
      }),
    );
  });
});
