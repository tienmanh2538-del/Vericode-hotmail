import { describe, it, expect, vi, beforeEach } from 'vitest';

import { RefreshAccessTokenError } from '@/services/microsoft/refresh-access-token.service';
import { SubscriptionRenewalTokenError } from '@/services/microsoft/subscription-renewal.service';
import { BLOCKING_SUBSCRIPTION_STATUSES } from '@/services/microsoft/mailbox-subscription-provisioning.service';

// Mock the heavy collaborators of the access-token port so we can drive the
// classification logic deterministically.
const refreshMock = vi.fn();
const decryptMock = vi.fn();
const encryptMock = vi.fn();

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
  createPrismaRenewalAccessTokenPort,
  createPrismaRenewalAccessTokenPortWithGeneration,
  createPrismaSubscriptionRenewalRepo,
} = await import('@/services/queue/workers/subscription-renewal-runner');

function mailboxClient(encryptedRefreshToken: string | null) {
  return {
    mailbox: {
      findUnique: vi.fn(async () => ({ encryptedRefreshToken })),
      update: vi.fn(async () => ({})),
    },
  };
}

beforeEach(() => {
  refreshMock.mockReset();
  decryptMock.mockReset();
  encryptMock.mockReset();
});

// ---------------------------------------------------------------------------
// Access-token port (string variant — reused by reconciliation, unchanged)
// ---------------------------------------------------------------------------

describe('createPrismaRenewalAccessTokenPort (string)', () => {
  it('returns the access token on a successful refresh', async () => {
    decryptMock.mockReturnValue('plaintext-refresh');
    refreshMock.mockResolvedValue({ accessToken: 'fresh-access-token' });
    const client = mailboxClient('cipher');
    const port = createPrismaRenewalAccessTokenPort(client as never);

    await expect(port.getAccessTokenForMailbox('mb_1')).resolves.toBe('fresh-access-token');
    expect(decryptMock).toHaveBeenCalledWith('cipher');
    expect(client.mailbox.update).not.toHaveBeenCalled();
  });

  it('maps a missing refresh token to reconnect_required', async () => {
    const port = createPrismaRenewalAccessTokenPort(mailboxClient(null) as never);
    await expect(port.getAccessTokenForMailbox('mb_1')).rejects.toMatchObject({
      name: 'SubscriptionRenewalTokenError',
      kind: 'reconnect_required',
    });
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('maps invalid_grant to reconnect_required', async () => {
    decryptMock.mockReturnValue('plaintext-refresh');
    refreshMock.mockRejectedValue(
      new RefreshAccessTokenError('token_endpoint', 'rejected', {
        microsoftErrorCode: 'invalid_grant',
        httpStatus: 400,
      }),
    );
    const port = createPrismaRenewalAccessTokenPort(mailboxClient('cipher') as never);

    const error = await port.getAccessTokenForMailbox('mb_1').catch((e) => e);
    expect(error).toBeInstanceOf(SubscriptionRenewalTokenError);
    expect(error.kind).toBe('reconnect_required');
  });

  it('maps a network token error to transient', async () => {
    decryptMock.mockReturnValue('plaintext-refresh');
    refreshMock.mockRejectedValue(new RefreshAccessTokenError('network', 'net'));
    const port = createPrismaRenewalAccessTokenPort(mailboxClient('cipher') as never);

    const error = await port.getAccessTokenForMailbox('mb_1').catch((e) => e);
    expect(error).toBeInstanceOf(SubscriptionRenewalTokenError);
    expect(error.kind).toBe('transient');
  });

  it('maps a decrypt failure to reconnect_required and never calls refresh', async () => {
    decryptMock.mockImplementation(() => {
      throw new Error('bad key');
    });
    const port = createPrismaRenewalAccessTokenPort(mailboxClient('cipher') as never);

    const error = await port.getAccessTokenForMailbox('mb_1').catch((e) => e);
    expect(error.kind).toBe('reconnect_required');
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Access-token port (generation variant — TASK-084, renewal only)
// ---------------------------------------------------------------------------

describe('createPrismaRenewalAccessTokenPortWithGeneration', () => {
  it('reports the read credential generation when Microsoft does not rotate', async () => {
    decryptMock.mockReturnValue('plaintext-refresh');
    refreshMock.mockResolvedValue({ accessToken: 'fresh-access-token' });
    const port = createPrismaRenewalAccessTokenPortWithGeneration(
      mailboxClient('cipher-A') as never,
    );

    await expect(port.getAccessTokenForMailbox('mb_1')).resolves.toEqual({
      accessToken: 'fresh-access-token',
      credentialGeneration: 'cipher-A',
    });
  });

  it('reports the post-rotation generation when Microsoft rotates the token', async () => {
    decryptMock.mockReturnValue('plaintext-refresh');
    refreshMock.mockResolvedValue({
      accessToken: 'fresh-access-token',
      refreshToken: 'rotated-refresh',
    });
    encryptMock.mockReturnValue('cipher-A-prime');
    const client = mailboxClient('cipher-A');
    const port = createPrismaRenewalAccessTokenPortWithGeneration(client as never);

    const credential = await port.getAccessTokenForMailbox('mb_1');
    expect(credential.accessToken).toBe('fresh-access-token');
    // Case B — the generation the operation committed to is the rotated value.
    expect(credential.credentialGeneration).toBe('cipher-A-prime');
    expect(client.mailbox.update).toHaveBeenCalledTimes(1);
  });

  it('carries null generation when the mailbox has no stored credential', async () => {
    const port = createPrismaRenewalAccessTokenPortWithGeneration(
      mailboxClient(null) as never,
    );
    const error = await port.getAccessTokenForMailbox('mb_1').catch((e) => e);
    expect(error).toBeInstanceOf(SubscriptionRenewalTokenError);
    expect(error.kind).toBe('reconnect_required');
    expect(error.credentialGeneration).toBeNull();
  });

  it('carries the read ciphertext as the generation on a decrypt failure', async () => {
    decryptMock.mockImplementation(() => {
      throw new Error('bad key');
    });
    const port = createPrismaRenewalAccessTokenPortWithGeneration(
      mailboxClient('cipher-A') as never,
    );
    const error = await port.getAccessTokenForMailbox('mb_1').catch((e) => e);
    expect(error.kind).toBe('reconnect_required');
    expect(error.credentialGeneration).toBe('cipher-A');
  });

  it('carries the read ciphertext as the generation on invalid_grant', async () => {
    decryptMock.mockReturnValue('plaintext-refresh');
    refreshMock.mockRejectedValue(
      new RefreshAccessTokenError('token_endpoint', 'rejected', {
        microsoftErrorCode: 'invalid_grant',
        httpStatus: 400,
      }),
    );
    const port = createPrismaRenewalAccessTokenPortWithGeneration(
      mailboxClient('cipher-A') as never,
    );
    const error = await port.getAccessTokenForMailbox('mb_1').catch((e) => e);
    expect(error.kind).toBe('reconnect_required');
    expect(error.credentialGeneration).toBe('cipher-A');
  });

  it('carries null generation for a transient error (guard is irrelevant)', async () => {
    decryptMock.mockReturnValue('plaintext-refresh');
    refreshMock.mockRejectedValue(new RefreshAccessTokenError('network', 'net'));
    const port = createPrismaRenewalAccessTokenPortWithGeneration(
      mailboxClient('cipher-A') as never,
    );
    const error = await port.getAccessTokenForMailbox('mb_1').catch((e) => e);
    expect(error.kind).toBe('transient');
    expect(error.credentialGeneration).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Prisma repo — candidate query, atomic claim, CAS completion, conditional
// mailbox writers (TASK-084)
// ---------------------------------------------------------------------------

const FIXED_NOW = new Date('2026-05-29T10:00:00.000Z');
const THIRTY_MIN_MS = 30 * 60 * 1000;

function repoClient(overrides: {
  findMany?: ReturnType<typeof vi.fn>;
  gsUpdateMany?: ReturnType<typeof vi.fn>;
  gsFindUnique?: ReturnType<typeof vi.fn>;
  mbUpdateMany?: ReturnType<typeof vi.fn>;
} = {}) {
  return {
    graphSubscription: {
      findMany: overrides.findMany ?? vi.fn(async () => []),
      updateMany: overrides.gsUpdateMany ?? vi.fn(async () => ({ count: 1 })),
      findUnique: overrides.gsFindUnique ?? vi.fn(async () => null),
    },
    mailbox: {
      updateMany: overrides.mbUpdateMany ?? vi.fn(async () => ({ count: 1 })),
    },
  };
}

describe('createPrismaSubscriptionRenewalRepo — candidate query', () => {
  it('maps rows and excludes fresh RENEWING via a stale-cutoff OR clause', async () => {
    const expiration = new Date('2026-05-30T10:00:00.000Z');
    const findMany = vi.fn(async () => [
      {
        id: 'gs_1',
        mailboxId: 'mb_1',
        subscriptionId: 'sub_1',
        expirationDateTime: expiration,
        mailbox: { status: 'ACTIVE', emailAddress: 'user@example.com' },
      },
    ]);
    const repo = createPrismaSubscriptionRenewalRepo(
      repoClient({ findMany }) as never,
      { now: () => FIXED_NOW },
    );

    const candidates = await repo.listRenewableCandidates();
    expect(candidates).toEqual([
      {
        id: 'gs_1',
        mailboxId: 'mb_1',
        subscriptionId: 'sub_1',
        emailAddress: 'user@example.com',
        mailboxStatus: 'ACTIVE',
        expirationDateTime: expiration,
      },
    ]);
    const firstArg = (findMany.mock.calls[0] as unknown as unknown[])[0] as {
      where: Record<string, unknown>;
    };
    const where = firstArg.where;
    expect(where.mailbox).toEqual({ is: { status: { not: 'DISABLED' } } });
    expect(where.OR).toEqual([
      { status: { in: ['ACTIVE', 'FAILED'] } },
      {
        status: 'RENEWING',
        updatedAt: { lt: new Date(FIXED_NOW.getTime() - THIRTY_MIN_MS) },
      },
    ]);
  });
});

describe('createPrismaSubscriptionRenewalRepo — claimForRenewal', () => {
  it('mints and writes its own generation explicitly, and holds it as the token', async () => {
    // The claimant's ownership token is the claimTimestamp it minted (= claimNow),
    // written explicitly into updatedAt — NOT a value read back from the DB.
    const gsUpdateMany = vi.fn(async () => ({ count: 1 }));
    const gsFindUnique = vi.fn(async () => ({ updatedAt: FIXED_NOW, status: 'RENEWING' }));
    const repo = createPrismaSubscriptionRenewalRepo(
      repoClient({ gsUpdateMany, gsFindUnique }) as never,
    );

    const claim = await repo.claimForRenewal('sub_1', FIXED_NOW);

    expect(claim).toEqual({
      claimed: true,
      claimGeneration: FIXED_NOW,
      reclaimedStale: false,
    });
    // Step 1 only (fresh claim won) — the stale-reclaim step is not attempted.
    expect(gsUpdateMany).toHaveBeenCalledTimes(1);
    expect((gsUpdateMany.mock.calls[0] as unknown as unknown[])[0]).toEqual({
      where: { subscriptionId: 'sub_1', status: { in: ['ACTIVE', 'FAILED'] } },
      data: { status: 'RENEWING', updatedAt: FIXED_NOW },
    });
  });

  it('reclaims a stale RENEWING row, stamping ITS OWN generation, and flags reclaimedStale', async () => {
    const gsUpdateMany = vi
      .fn()
      .mockResolvedValueOnce({ count: 0 }) // fresh claim misses
      .mockResolvedValueOnce({ count: 1 }); // stale reclaim wins
    const gsFindUnique = vi.fn(async () => ({ updatedAt: FIXED_NOW, status: 'RENEWING' }));
    const repo = createPrismaSubscriptionRenewalRepo(
      repoClient({ gsUpdateMany, gsFindUnique }) as never,
    );

    const claim = await repo.claimForRenewal('sub_1', FIXED_NOW);

    expect(claim.claimed).toBe(true);
    expect(claim.claimGeneration).toEqual(FIXED_NOW);
    expect(claim.reclaimedStale).toBe(true);
    expect(gsUpdateMany).toHaveBeenCalledTimes(2);
    expect(gsUpdateMany.mock.calls[1][0]).toEqual({
      where: {
        subscriptionId: 'sub_1',
        status: 'RENEWING',
        updatedAt: { lt: new Date(FIXED_NOW.getTime() - THIRTY_MIN_MS) },
      },
      data: { status: 'RENEWING', updatedAt: FIXED_NOW },
    });
  });

  it('loses the claim when neither step matches', async () => {
    const gsUpdateMany = vi.fn(async () => ({ count: 0 }));
    const repo = createPrismaSubscriptionRenewalRepo(
      repoClient({ gsUpdateMany }) as never,
    );

    const claim = await repo.claimForRenewal('sub_1', FIXED_NOW);
    expect(claim).toEqual({ claimed: false, claimGeneration: null, reclaimedStale: false });
  });

  it('loses the claim when a concurrent write changed the status before read-back', async () => {
    // e.g. a disconnect flipped the row to EXPIRED between claim and read-back.
    const gsUpdateMany = vi.fn(async () => ({ count: 1 }));
    const gsFindUnique = vi.fn(async () => ({
      updatedAt: new Date('2026-05-29T09:57:00.000Z'),
      status: 'EXPIRED',
    }));
    const repo = createPrismaSubscriptionRenewalRepo(
      repoClient({ gsUpdateMany, gsFindUnique }) as never,
    );

    const claim = await repo.claimForRenewal('sub_1', FIXED_NOW);
    expect(claim.claimed).toBe(false);
    expect(claim.claimGeneration).toBeNull();
  });

  it('HIJACK GUARD — never adopts a stale-reclaimer generation seen on read-back', async () => {
    // The core race ChatGPT flagged: Worker A atomic-claims (generation A), stalls,
    // Worker B stale-reclaims (generation B) after the 30-min cutoff, then A resumes
    // and reads back. The row is still RENEWING but carries B's generation. A MUST
    // treat this as a lost claim — it must NOT adopt B's generation as its own.
    const generationB = new Date('2026-05-29T09:58:30.000Z'); // != FIXED_NOW (A's mint)
    const gsUpdateMany = vi.fn(async () => ({ count: 1 }));
    const gsFindUnique = vi.fn(async () => ({ updatedAt: generationB, status: 'RENEWING' }));
    const repo = createPrismaSubscriptionRenewalRepo(
      repoClient({ gsUpdateMany, gsFindUnique }) as never,
    );

    const claim = await repo.claimForRenewal('sub_1', FIXED_NOW);

    expect(claim.claimed).toBe(false);
    expect(claim.claimGeneration).toBeNull();
  });

  it('fails closed if Prisma/PostgreSQL did not round-trip the explicit generation', async () => {
    // Defensive: if the stored updatedAt is not byte-for-byte our claimTimestamp
    // (e.g. the explicit @updatedAt value was overridden), we own nothing.
    const drifted = new Date(FIXED_NOW.getTime() + 1); // 1 ms drift
    const gsUpdateMany = vi.fn(async () => ({ count: 1 }));
    const gsFindUnique = vi.fn(async () => ({ updatedAt: drifted, status: 'RENEWING' }));
    const repo = createPrismaSubscriptionRenewalRepo(
      repoClient({ gsUpdateMany, gsFindUnique }) as never,
    );

    const claim = await repo.claimForRenewal('sub_1', FIXED_NOW);
    expect(claim.claimed).toBe(false);
    expect(claim.claimGeneration).toBeNull();
  });
});

describe('createPrismaSubscriptionRenewalRepo — CAS completion writers', () => {
  const generation = new Date('2026-05-29T09:55:00.000Z');

  it('markRenewedIfOwner writes ACTIVE + expiration + lastRenewedAt under CAS', async () => {
    const gsUpdateMany = vi.fn(async () => ({ count: 1 }));
    const repo = createPrismaSubscriptionRenewalRepo(
      repoClient({ gsUpdateMany }) as never,
    );
    const newExpiration = new Date('2026-06-04T10:00:00.000Z');

    const owned = await repo.markRenewedIfOwner({
      subscriptionId: 'sub_1',
      claimGeneration: generation,
      newExpirationDateTime: newExpiration,
      now: FIXED_NOW,
    });

    expect(owned).toBe(true);
    expect(gsUpdateMany).toHaveBeenCalledWith({
      where: { subscriptionId: 'sub_1', status: 'RENEWING', updatedAt: generation },
      data: { status: 'ACTIVE', expirationDateTime: newExpiration, lastRenewedAt: FIXED_NOW },
    });
  });

  it('markSubscriptionFailedIfOwner returns false when the CAS matches no row', async () => {
    const gsUpdateMany = vi.fn(async () => ({ count: 0 }));
    const repo = createPrismaSubscriptionRenewalRepo(
      repoClient({ gsUpdateMany }) as never,
    );
    const owned = await repo.markSubscriptionFailedIfOwner('sub_1', generation);
    expect(owned).toBe(false);
    expect(gsUpdateMany).toHaveBeenCalledWith({
      where: { subscriptionId: 'sub_1', status: 'RENEWING', updatedAt: generation },
      data: { status: 'FAILED' },
    });
  });

  it('markSubscriptionExpiredIfOwner writes EXPIRED under CAS', async () => {
    const gsUpdateMany = vi.fn(async () => ({ count: 1 }));
    const repo = createPrismaSubscriptionRenewalRepo(
      repoClient({ gsUpdateMany }) as never,
    );
    const owned = await repo.markSubscriptionExpiredIfOwner('sub_1', generation);
    expect(owned).toBe(true);
    expect(gsUpdateMany).toHaveBeenCalledWith({
      where: { subscriptionId: 'sub_1', status: 'RENEWING', updatedAt: generation },
      data: { status: 'EXPIRED' },
    });
  });
});

describe('createPrismaSubscriptionRenewalRepo — conditional mailbox writers', () => {
  it('relation-aware expired writer excludes the failing row and uses possibly-live semantics', async () => {
    const mbUpdateMany = vi.fn(async () => ({ count: 1 }));
    const repo = createPrismaSubscriptionRenewalRepo(
      repoClient({ mbUpdateMany }) as never,
    );

    const changed = await repo.markMailboxSubscriptionExpiredIfNoOtherLiveSubscription({
      mailboxId: 'mb_1',
      failingSubscriptionRowId: 'gs_row_1',
      now: FIXED_NOW,
    });

    expect(changed).toBe(true);
    expect(mbUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'mb_1',
        status: 'ACTIVE',
        graphSubscriptions: {
          none: {
            id: { not: 'gs_row_1' },
            status: { in: [...BLOCKING_SUBSCRIPTION_STATUSES] },
            expirationDateTime: { gt: FIXED_NOW },
          },
        },
      },
      data: { status: 'SUBSCRIPTION_EXPIRED' },
    });
  });

  it('returns false when the relation predicate does not match (replacement is live)', async () => {
    const mbUpdateMany = vi.fn(async () => ({ count: 0 }));
    const repo = createPrismaSubscriptionRenewalRepo(
      repoClient({ mbUpdateMany }) as never,
    );
    const changed = await repo.markMailboxSubscriptionExpiredIfNoOtherLiveSubscription({
      mailboxId: 'mb_1',
      failingSubscriptionRowId: 'gs_row_1',
      now: FIXED_NOW,
    });
    expect(changed).toBe(false);
  });

  it('credential-guarded reconnect writer matches on status != DISABLED AND the generation', async () => {
    const mbUpdateMany = vi.fn(async () => ({ count: 1 }));
    const repo = createPrismaSubscriptionRenewalRepo(
      repoClient({ mbUpdateMany }) as never,
    );

    const marked = await repo.markMailboxReconnectRequiredIfCredentialCurrent(
      'mb_1',
      'cipher-A',
    );

    expect(marked).toBe(true);
    expect(mbUpdateMany).toHaveBeenCalledWith({
      where: {
        id: 'mb_1',
        status: { not: 'DISABLED' },
        encryptedRefreshToken: 'cipher-A',
      },
      data: { status: 'RECONNECT_REQUIRED' },
    });
  });

  it('reconnect writer matches IS NULL when the captured generation is null', async () => {
    const mbUpdateMany = vi.fn(async () => ({ count: 1 }));
    const repo = createPrismaSubscriptionRenewalRepo(
      repoClient({ mbUpdateMany }) as never,
    );
    await repo.markMailboxReconnectRequiredIfCredentialCurrent('mb_1', null);
    const arg = (mbUpdateMany.mock.calls[0] as unknown as unknown[])[0] as {
      where: { encryptedRefreshToken: unknown };
    };
    expect(arg.where.encryptedRefreshToken).toBeNull();
  });

  it('returns false when the credential generation changed concurrently', async () => {
    const mbUpdateMany = vi.fn(async () => ({ count: 0 }));
    const repo = createPrismaSubscriptionRenewalRepo(
      repoClient({ mbUpdateMany }) as never,
    );
    const marked = await repo.markMailboxReconnectRequiredIfCredentialCurrent(
      'mb_1',
      'stale-cipher',
    );
    expect(marked).toBe(false);
  });
});
