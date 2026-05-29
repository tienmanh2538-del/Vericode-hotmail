import { describe, it, expect, vi, beforeEach } from 'vitest';

import { RefreshAccessTokenError } from '@/services/microsoft/refresh-access-token.service';
import { SubscriptionRenewalTokenError } from '@/services/microsoft/subscription-renewal.service';

// Mock the heavy collaborators of the access-token port so we can drive the
// classification logic deterministically.
const refreshMock = vi.fn();
const decryptMock = vi.fn();

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
}));

// Imported after the mocks are registered.
const {
  createPrismaRenewalAccessTokenPort,
  createPrismaSubscriptionRenewalRepo,
} = await import('@/services/queue/workers/subscription-renewal-runner');

function mailboxClient(encryptedRefreshToken: string | null) {
  return {
    mailbox: {
      findUnique: vi.fn(async () => ({ encryptedRefreshToken })),
    },
  };
}

beforeEach(() => {
  refreshMock.mockReset();
  decryptMock.mockReset();
});

describe('createPrismaRenewalAccessTokenPort', () => {
  it('returns the access token on a successful refresh', async () => {
    decryptMock.mockReturnValue('plaintext-refresh');
    refreshMock.mockResolvedValue({ accessToken: 'fresh-access-token' });
    const port = createPrismaRenewalAccessTokenPort(mailboxClient('cipher') as never);

    await expect(port.getAccessTokenForMailbox('mb_1')).resolves.toBe('fresh-access-token');
    expect(decryptMock).toHaveBeenCalledWith('cipher');
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

describe('createPrismaSubscriptionRenewalRepo', () => {
  it('maps Graph subscription rows into renewal candidates', async () => {
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
    const repo = createPrismaSubscriptionRenewalRepo({
      graphSubscription: { findMany, update: vi.fn() },
      mailbox: { update: vi.fn() },
    } as never);

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
  });

  it('updates the right rows for each mark* operation', async () => {
    const gsUpdate = vi.fn(async () => ({}));
    const mbUpdate = vi.fn(async () => ({}));
    const repo = createPrismaSubscriptionRenewalRepo({
      graphSubscription: { findMany: vi.fn(), update: gsUpdate },
      mailbox: { update: mbUpdate },
    } as never);

    await repo.markSubscriptionExpired('sub_1');
    await repo.markSubscriptionFailed('sub_2');
    await repo.markMailboxReconnectRequired('mb_1');
    await repo.markMailboxSubscriptionExpired('mb_2');

    expect(gsUpdate).toHaveBeenCalledWith({
      where: { subscriptionId: 'sub_1' },
      data: { status: 'EXPIRED' },
    });
    expect(gsUpdate).toHaveBeenCalledWith({
      where: { subscriptionId: 'sub_2' },
      data: { status: 'FAILED' },
    });
    expect(mbUpdate).toHaveBeenCalledWith({
      where: { id: 'mb_1' },
      data: { status: 'RECONNECT_REQUIRED' },
    });
    expect(mbUpdate).toHaveBeenCalledWith({
      where: { id: 'mb_2' },
      data: { status: 'SUBSCRIPTION_EXPIRED' },
    });
  });
});
