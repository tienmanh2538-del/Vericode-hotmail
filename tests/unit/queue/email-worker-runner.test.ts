import { describe, it, expect, vi, beforeEach } from 'vitest';

const refreshMock = vi.fn();
const decryptMock = vi.fn();
const persistRotatedMock = vi.fn();

// TASK-069C — keep the REAL RefreshAccessTokenError so classification
// (instanceof + microsoftErrorCode) works exactly like production.
vi.mock('@/services/microsoft/refresh-access-token.service', async () => {
  const actual = await vi.importActual<
    typeof import('@/services/microsoft/refresh-access-token.service')
  >('@/services/microsoft/refresh-access-token.service');
  return {
    ...actual,
    refreshMicrosoftAccessToken: (token: string) => refreshMock(token),
  };
});

vi.mock('@/lib/security/encryption', () => ({
  decryptSecret: (value: string) => decryptMock(value),
}));

vi.mock('@/services/microsoft/refresh-token-rotation.service', () => ({
  // TASK-085 — signature is now (mailboxId, token, expectedGeneration, deps).
  persistRotatedRefreshToken: (
    mailboxId: string,
    token: string | undefined,
    expectedGeneration: string | null,
    deps: unknown,
  ) => persistRotatedMock(mailboxId, token, expectedGeneration, deps),
}));

import { RefreshAccessTokenError } from '@/services/microsoft/refresh-access-token.service';
import {
  buildGlobalSendThrottle,
  createPrismaEmailAccessTokenPort,
  createPrismaMailboxLookupPort,
  EmailWorkerTokenError,
  isRedisConfiguredForPacer,
} from '@/services/queue/workers/email-worker-runner';
import type { RedisGlobalThrottleClient } from '@/services/queue/redis-global-send-throttle';

beforeEach(() => {
  refreshMock.mockReset();
  decryptMock.mockReset();
  persistRotatedMock.mockReset();
  persistRotatedMock.mockResolvedValue({ rotated: false });
});

describe('createPrismaMailboxLookupPort', () => {
  it('maps a row to the pipeline record (customer name preferred)', async () => {
    const client = {
      mailbox: {
        findUnique: vi.fn(async () => ({
          id: 'mb1',
          emailAddress: 'box@example.com',
          status: 'ACTIVE',
          ownerCustomerName: 'Owner Co',
          customer: { name: 'Customer Co' },
        })),
        update: vi.fn(async () => ({})),
      },
    };
    const port = createPrismaMailboxLookupPort(client as never);
    const record = await port.findById('mb1');
    expect(record).toEqual({
      id: 'mb1',
      emailAddress: 'box@example.com',
      status: 'ACTIVE',
      customerName: 'Customer Co',
    });
  });

  it('flags reconnect-required via a status update', async () => {
    const update = vi.fn(async () => ({}));
    const client = { mailbox: { findUnique: vi.fn(), update } };
    const port = createPrismaMailboxLookupPort(client as never);
    await port.markReconnectRequired?.('mb1');
    expect(update).toHaveBeenCalledWith({
      where: { id: 'mb1' },
      data: { status: 'RECONNECT_REQUIRED' },
    });
  });
});

describe('createPrismaEmailAccessTokenPort — token rotation', () => {
  function makeClient() {
    return {
      mailbox: {
        findUnique: vi.fn(async () => ({ encryptedRefreshToken: 'cipher' })),
        update: vi.fn(async () => ({})),
      },
    };
  }

  it('decrypts, refreshes, and persists a rotated refresh token', async () => {
    decryptMock.mockReturnValue('plain-refresh');
    refreshMock.mockResolvedValue({ accessToken: 'AT', refreshToken: 'new-RT' });
    const client = makeClient();

    const port = createPrismaEmailAccessTokenPort(client as never);
    const token = await port.getAccessTokenForMailbox({
      id: 'mb1',
      emailAddress: 'box@example.com',
      status: 'ACTIVE',
    });

    expect(token).toBe('AT');
    expect(decryptMock).toHaveBeenCalledWith('cipher');
    expect(refreshMock).toHaveBeenCalledWith('plain-refresh');
    // The worker uses the SAME rotation helper as delta-polling / renewal, now
    // passing the read generation (G0) as the CAS expected generation (TASK-085).
    expect(persistRotatedMock).toHaveBeenCalledWith('mb1', 'new-RT', 'cipher', {
      prisma: client,
    });
  });

  it('persists with undefined when Microsoft returns no new refresh token', async () => {
    decryptMock.mockReturnValue('plain-refresh');
    refreshMock.mockResolvedValue({ accessToken: 'AT' });
    const client = makeClient();

    const port = createPrismaEmailAccessTokenPort(client as never);
    await port.getAccessTokenForMailbox({
      id: 'mb1',
      emailAddress: 'box@example.com',
      status: 'ACTIVE',
    });

    // undefined ⇒ rotation helper keeps the existing token (no overwrite).
    expect(persistRotatedMock).toHaveBeenCalledWith('mb1', undefined, 'cipher', {
      prisma: client,
    });
  });

  it('throws missing_refresh_token when the mailbox has none', async () => {
    const client = {
      mailbox: {
        findUnique: vi.fn(async () => ({ encryptedRefreshToken: null })),
        update: vi.fn(),
      },
    };
    const port = createPrismaEmailAccessTokenPort(client as never);
    await expect(
      port.getAccessTokenForMailbox({
        id: 'mb1',
        emailAddress: 'box@example.com',
        status: 'ACTIVE',
      }),
    ).rejects.toMatchObject({ kind: 'missing_refresh_token' });
    expect(persistRotatedMock).not.toHaveBeenCalled();
  });

  it('throws refresh_failed when decryption fails', async () => {
    decryptMock.mockImplementation(() => {
      throw new Error('bad cipher');
    });
    const client = makeClient();
    const port = createPrismaEmailAccessTokenPort(client as never);
    await expect(
      port.getAccessTokenForMailbox({
        id: 'mb1',
        emailAddress: 'box@example.com',
        status: 'ACTIVE',
      }),
    ).rejects.toBeInstanceOf(EmailWorkerTokenError);
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

describe('createPrismaEmailAccessTokenPort — failure classification (TASK-069C)', () => {
  function makeClient() {
    return {
      mailbox: {
        findUnique: vi.fn(async () => ({ encryptedRefreshToken: 'cipher' })),
        update: vi.fn(async () => ({})),
      },
    };
  }

  async function classify(rejection: unknown): Promise<EmailWorkerTokenError> {
    decryptMock.mockReturnValue('plain-refresh');
    refreshMock.mockRejectedValue(rejection);
    const port = createPrismaEmailAccessTokenPort(makeClient() as never);
    const error = await port
      .getAccessTokenForMailbox({
        id: 'mb1',
        emailAddress: 'box@example.com',
        status: 'ACTIVE',
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(EmailWorkerTokenError);
    return error as EmailWorkerTokenError;
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
    const client = {
      mailbox: {
        findUnique: vi.fn(async () => ({ encryptedRefreshToken: null })),
        update: vi.fn(),
      },
    };
    const port = createPrismaEmailAccessTokenPort(client as never);
    const error = (await port
      .getAccessTokenForMailbox({
        id: 'mb1',
        emailAddress: 'box@example.com',
        status: 'ACTIVE',
      })
      .catch((e) => e)) as EmailWorkerTokenError;
    expect(error).toBeInstanceOf(EmailWorkerTokenError);
    expect(error.classification).toBe('reconnect_required');
    expect(refreshMock).not.toHaveBeenCalled();
  });
});

describe('global send pacer wiring (TASK-070)', () => {
  it('treats REDIS_URL presence as the gate for the cross-process pacer', () => {
    expect(isRedisConfiguredForPacer({ REDIS_URL: 'redis://example:6379' })).toBe(
      true,
    );
    expect(isRedisConfiguredForPacer({})).toBe(false);
    expect(isRedisConfiguredForPacer({ REDIS_URL: '   ' })).toBe(false);
  });

  it('builds an in-memory pacer when no Redis client provider is supplied', async () => {
    const throttle = buildGlobalSendThrottle(null);
    // First reservation is immediate; the result is a plain reservation, never a
    // Redis round-trip (there is no client to call).
    const reservation = await throttle.reserve();
    expect(reservation.waitMs).toBe(0);
    expect(typeof reservation.waitMs).toBe('number');
  });

  it('builds a Redis-backed pacer when a client provider is supplied', async () => {
    const evalMock = vi.fn(async () => 0);
    const client: RedisGlobalThrottleClient = { eval: evalMock };
    const throttle = buildGlobalSendThrottle(async () => client);

    await throttle.reserve();

    // The Redis backend reserves the slot via the shared client's eval.
    expect(evalMock).toHaveBeenCalledTimes(1);
    const [script, numKeys] = evalMock.mock.calls[0] as unknown[];
    expect(typeof script).toBe('string');
    expect(numKeys).toBe(1);
  });
});
