import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the heavy collaborators of the access-token port so we can drive token
// rotation deterministically. The encryption module is mocked for BOTH the
// decrypt (consumed by the port) and encrypt (consumed by rotation persistence).
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

import { RefreshAccessTokenError } from '@/services/microsoft/refresh-access-token.service';

const { createPrismaAccessTokenPort, DeltaPollingTokenError } = await import(
  '@/services/queue/workers/delta-polling-runner'
);

function mailboxClient(encryptedRefreshToken: string | null) {
  const update = vi.fn(
    async (_args: { where: { id: string }; data: Record<string, unknown> }) => ({}),
  );
  return {
    client: {
      mailbox: {
        findUnique: vi.fn(async () => ({ encryptedRefreshToken })),
        update,
      },
    },
    update,
  };
}

beforeEach(() => {
  refreshMock.mockReset();
  decryptMock.mockReset();
  encryptMock.mockReset();
});

describe('createPrismaAccessTokenPort — token rotation (TASK-036)', () => {
  it('persists a rotated refresh token (encrypted) when Microsoft returns one', async () => {
    decryptMock.mockReturnValue('old-plaintext-refresh');
    refreshMock.mockResolvedValue({
      accessToken: 'fresh-access-token',
      refreshToken: 'rotated-refresh-token',
    });
    encryptMock.mockReturnValue('enc(rotated-refresh-token)');

    const { client, update } = mailboxClient('cipher-old');
    const port = createPrismaAccessTokenPort(client as never);

    const token = await port.getAccessTokenForMailbox({
      id: 'mb_1',
      emailAddress: 'a@example.com',
      microsoftDeltaCursor: null,
    });

    expect(token).toBe('fresh-access-token');
    expect(encryptMock).toHaveBeenCalledWith('rotated-refresh-token');
    expect(update).toHaveBeenCalledTimes(1);
    const data = update.mock.calls[0][0].data as Record<string, unknown>;
    // The persisted value is exactly what encryptSecret returned — the rotated
    // token is encrypted before it touches the database, never stored raw.
    expect(data.encryptedRefreshToken).toBe('enc(rotated-refresh-token)');
    expect(data).toHaveProperty('tokenLastRefreshedAt');
  });

  it('does NOT overwrite the stored token when Microsoft returns no new refresh token', async () => {
    decryptMock.mockReturnValue('old-plaintext-refresh');
    refreshMock.mockResolvedValue({ accessToken: 'fresh-access-token' });

    const { client, update } = mailboxClient('cipher-old');
    const port = createPrismaAccessTokenPort(client as never);

    const token = await port.getAccessTokenForMailbox({
      id: 'mb_2',
      emailAddress: 'b@example.com',
      microsoftDeltaCursor: null,
    });

    expect(token).toBe('fresh-access-token');
    expect(encryptMock).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('maps a missing refresh token to a token error and never calls refresh', async () => {
    const { client } = mailboxClient(null);
    const port = createPrismaAccessTokenPort(client as never);

    await expect(
      port.getAccessTokenForMailbox({
        id: 'mb_3',
        emailAddress: 'c@example.com',
        microsoftDeltaCursor: null,
      }),
    ).rejects.toMatchObject({ name: 'DeltaPollingTokenError' });
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

describe('createPrismaAccessTokenPort — failure classification (TASK-069C)', () => {
  async function classify(rejection: unknown) {
    decryptMock.mockReturnValue('plain-refresh');
    refreshMock.mockRejectedValue(rejection);
    const { client } = mailboxClient('cipher');
    const port = createPrismaAccessTokenPort(client as never);
    const error = (await port
      .getAccessTokenForMailbox({
        id: 'mb_x',
        emailAddress: 'x@example.com',
        microsoftDeltaCursor: null,
      })
      .catch((e) => e)) as InstanceType<typeof DeltaPollingTokenError>;
    expect(error).toBeInstanceOf(DeltaPollingTokenError);
    return error;
  }

  it('marks invalid_grant as reconnect_required', async () => {
    const error = await classify(
      new RefreshAccessTokenError('token_endpoint', 'rejected', {
        microsoftErrorCode: 'invalid_grant',
        httpStatus: 400,
      }),
    );
    expect(error.classification).toBe('reconnect_required');
  });

  it('marks interaction_required as reconnect_required', async () => {
    const error = await classify(
      new RefreshAccessTokenError('token_endpoint', 'rejected', {
        microsoftErrorCode: 'interaction_required',
        httpStatus: 400,
      }),
    );
    expect(error.classification).toBe('reconnect_required');
  });

  it('keeps a network/timeout error transient (no reconnect)', async () => {
    const error = await classify(new RefreshAccessTokenError('network', 'timeout'));
    expect(error.classification).toBe('transient');
  });

  it('keeps a Microsoft 429 transient (no reconnect)', async () => {
    const error = await classify(
      new RefreshAccessTokenError('token_endpoint', 'throttled', {
        microsoftErrorCode: 'temporarily_unavailable',
        httpStatus: 429,
      }),
    );
    expect(error.classification).toBe('transient');
  });

  it('keeps a Microsoft 5xx transient (no reconnect)', async () => {
    const error = await classify(
      new RefreshAccessTokenError('token_endpoint', 'server error', {
        httpStatus: 503,
      }),
    );
    expect(error.classification).toBe('transient');
  });

  it('marks a missing refresh token as reconnect_required', async () => {
    const { client } = mailboxClient(null);
    const port = createPrismaAccessTokenPort(client as never);
    const error = (await port
      .getAccessTokenForMailbox({
        id: 'mb_missing',
        emailAddress: 'm@example.com',
        microsoftDeltaCursor: null,
      })
      .catch((e) => e)) as InstanceType<typeof DeltaPollingTokenError>;
    expect(error).toBeInstanceOf(DeltaPollingTokenError);
    expect(error.classification).toBe('reconnect_required');
  });
});
