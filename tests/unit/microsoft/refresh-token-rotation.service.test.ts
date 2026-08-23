import { describe, it, expect, vi } from 'vitest';

import { persistRotatedRefreshToken } from '@/services/microsoft/refresh-token-rotation.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// TASK-085 — the DB seam is a conditional `updateMany` (credential-generation
// CAS). `count` models the affected-row count: 1 = CAS win (committed), 0 = CAS
// loss (generation changed / mailbox DISABLED).
function fakePrisma(count = 1) {
  const updateMany = vi.fn(
    async (_args: { where: Record<string, unknown>; data: Record<string, unknown> }) => ({
      count,
    }),
  );
  return { client: { mailbox: { updateMany } }, updateMany };
}

function captureLogger() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

// An "encryption" double whose output does NOT contain the plaintext as a
// substring, so tests can meaningfully assert ciphertext != plaintext without
// depending on the real AES implementation.
function fakeEncrypt(plaintext: string): string {
  return `cipher:${Buffer.from(plaintext, 'utf8').toString('base64')}`;
}

const NOW = () => new Date('2026-05-30T00:00:00.000Z');
// Opaque stored generation (G0) the operation started from — never a real token.
const G0 = 'cipher:existing-generation-marker';

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('persistRotatedRefreshToken (TASK-085 credential-generation CAS)', () => {
  it('CAS win: persists the rotated token under status!=DISABLED AND expected generation', async () => {
    const { client, updateMany } = fakePrisma(1);
    const encryptSecret = vi.fn(fakeEncrypt);

    const result = await persistRotatedRefreshToken(
      'mb_1',
      'new-refresh-token',
      G0,
      { prisma: client, encryptSecret, now: NOW, logger: captureLogger() },
    );

    // count = 1 → committed; the written ciphertext is surfaced ONLY on persist
    // (TASK-084 Case B captures the committed generation).
    expect(result).toEqual({
      rotated: true,
      persisted: true,
      encryptedRefreshToken: fakeEncrypt('new-refresh-token'),
    });
    expect(encryptSecret).toHaveBeenCalledWith('new-refresh-token');
    expect(updateMany).toHaveBeenCalledTimes(1);
    expect(updateMany).toHaveBeenCalledWith({
      where: {
        id: 'mb_1',
        status: { not: 'DISABLED' },
        encryptedRefreshToken: G0,
      },
      data: {
        encryptedRefreshToken: fakeEncrypt('new-refresh-token'),
        tokenLastRefreshedAt: new Date('2026-05-30T00:00:00.000Z'),
      },
    });
  });

  it('CAS predicate includes status != DISABLED (disconnect race)', async () => {
    const { client, updateMany } = fakePrisma(0); // DISABLED → no row matches
    const result = await persistRotatedRefreshToken('mb_dis', 'rotated', G0, {
      prisma: client,
      encryptSecret: fakeEncrypt,
      now: NOW,
      logger: captureLogger(),
    });

    const where = updateMany.mock.calls[0][0].where;
    expect(where.status).toEqual({ not: 'DISABLED' });
    // Late rotation after disconnect → count 0 → discard, do not resurrect.
    expect(result).toEqual({ rotated: true, persisted: false, casLost: true });
  });

  it('CAS loss (count=0): discards the rotated credential and surfaces casLost', async () => {
    // Models worker-vs-worker OR worker-vs-OAuth-reconnect: DB generation already
    // moved on, so the expected-generation predicate matches no row.
    const { client } = fakePrisma(0);
    const logger = captureLogger();
    const result = await persistRotatedRefreshToken('mb_2', 'stale-rotated', G0, {
      prisma: client,
      encryptSecret: fakeEncrypt,
      now: NOW,
      logger,
    });

    expect(result).toEqual({ rotated: true, persisted: false, casLost: true });
    // Never returns the CAS-lost ciphertext as a committed generation.
    expect(result.encryptedRefreshToken).toBeUndefined();
    // Not an auth failure; only a masked mailbox id is logged.
    const infoBlob = JSON.stringify(logger.info.mock.calls);
    expect(infoBlob).not.toContain('stale-rotated');
  });

  it('worker-vs-worker: winner commits (count=1), loser discards (count=0)', async () => {
    const winner = await persistRotatedRefreshToken('mb', 'G1', G0, {
      prisma: fakePrisma(1).client,
      encryptSecret: fakeEncrypt,
      now: NOW,
      logger: captureLogger(),
    });
    const loser = await persistRotatedRefreshToken('mb', 'G2', G0, {
      prisma: fakePrisma(0).client,
      encryptSecret: fakeEncrypt,
      now: NOW,
      logger: captureLogger(),
    });
    expect(winner.persisted).toBe(true);
    expect(winner.encryptedRefreshToken).toBe(fakeEncrypt('G1'));
    expect(loser.persisted).toBe(false);
    expect(loser.casLost).toBe(true);
    expect(loser.encryptedRefreshToken).toBeUndefined();
  });

  it('no rotation: no DB write, no CAS conflict when Microsoft returns no new token', async () => {
    const { client, updateMany } = fakePrisma(1);
    const encryptSecret = vi.fn(fakeEncrypt);

    const result = await persistRotatedRefreshToken('mb_3', undefined, G0, {
      prisma: client,
      encryptSecret,
      logger: captureLogger(),
    });

    expect(result).toEqual({ rotated: false, persisted: false });
    expect(updateMany).not.toHaveBeenCalled();
    expect(encryptSecret).not.toHaveBeenCalled();
  });

  it('treats an empty / whitespace refresh token as "no rotation" — never overwrites', async () => {
    const { client, updateMany } = fakePrisma(1);

    for (const empty of ['', '   ']) {
      const result = await persistRotatedRefreshToken('mb_4', empty, G0, {
        prisma: client,
        encryptSecret: fakeEncrypt,
        logger: captureLogger(),
      });
      expect(result).toEqual({ rotated: false, persisted: false });
    }
    expect(updateMany).not.toHaveBeenCalled();
  });

  it('NEVER writes plaintext: the stored token is the encrypted form only', async () => {
    const { client, updateMany } = fakePrisma(1);

    await persistRotatedRefreshToken('mb_5', 'super-secret-token', G0, {
      prisma: client,
      encryptSecret: fakeEncrypt,
      now: NOW,
      logger: captureLogger(),
    });

    const written = updateMany.mock.calls[0][0].data.encryptedRefreshToken as string;
    expect(written).not.toContain('super-secret-token');
    expect(written).toBe(fakeEncrypt('super-secret-token'));
  });

  it('is non-fatal and leaks no token when encryption fails', async () => {
    const { client, updateMany } = fakePrisma(1);
    const logger = captureLogger();
    const encryptSecret = vi.fn(() => {
      throw new Error('boom: top-secret-token leaked in error');
    });

    const result = await persistRotatedRefreshToken('mb_6', 'top-secret-token', G0, {
      prisma: client,
      encryptSecret,
      logger,
    });

    expect(result).toEqual({ rotated: false, persisted: false });
    expect(updateMany).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [msg, ctx] = logger.warn.mock.calls[0];
    expect(JSON.stringify({ msg, ctx })).not.toContain('top-secret-token');
    expect(ctx).toEqual({ mailboxId: 'mb_6' });
  });

  it('a real DB error PROPAGATES (is NOT swallowed) and is never disguised as a CAS loss', async () => {
    // The raw Prisma error carries a credential-looking substring to prove the
    // helper never lets it escape into the propagated error / logs.
    const updateMany = vi.fn(async () => {
      throw new Error('db down (refresh=plaintext-should-not-appear)');
    });
    const client = { mailbox: { updateMany } };
    const logger = captureLogger();

    const promise = persistRotatedRefreshToken(
      'mb_7',
      'plaintext-should-not-appear',
      G0,
      { prisma: client, encryptSecret: fakeEncrypt, now: NOW, logger },
    );

    // A DB/infra error is propagated (fail the operation), NOT swallowed into a
    // `{ persisted:false }` result and NOT reported as a CAS loss.
    await expect(promise).rejects.toBeInstanceOf(Error);
    const error = await promise.catch((e) => e);
    // The propagated error is sanitized — no raw Prisma message, no ciphertext.
    expect(error.message).toBe('failed to persist rotated refresh token');
    expect(error.message).not.toContain('plaintext-should-not-appear');
    // Masked warning only carries the mailbox id.
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [, ctx] = logger.warn.mock.calls[0];
    expect(ctx).toEqual({ mailboxId: 'mb_7' });
    // No CAS-loss info line, and the plaintext never appears anywhere in logs.
    const logBlob = JSON.stringify([
      logger.info.mock.calls,
      logger.warn.mock.calls,
    ]);
    expect(logBlob).not.toContain('plaintext-should-not-appear');
    expect(logBlob).not.toContain('generation changed');
  });
});
