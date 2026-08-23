import { describe, it, expect, vi } from 'vitest';

import { persistRotatedRefreshToken } from '@/services/microsoft/refresh-token-rotation.service';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fakePrisma() {
  const update = vi.fn(
    async (_args: { where: { id: string }; data: Record<string, unknown> }) => ({}),
  );
  return { client: { mailbox: { update } }, update };
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('persistRotatedRefreshToken', () => {
  it('encrypts and persists a new refresh token, stamping tokenLastRefreshedAt', async () => {
    const { client, update } = fakePrisma();
    const encryptSecret = vi.fn(fakeEncrypt);

    const result = await persistRotatedRefreshToken('mb_1', 'new-refresh-token', {
      prisma: client,
      encryptSecret,
      now: NOW,
      logger: captureLogger(),
    });

    // TASK-084 — the written ciphertext is surfaced so the renewal worker can
    // capture the post-rotation credential generation without a follow-up query.
    expect(result).toEqual({
      rotated: true,
      encryptedRefreshToken: fakeEncrypt('new-refresh-token'),
    });
    expect(encryptSecret).toHaveBeenCalledWith('new-refresh-token');
    expect(update).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalledWith({
      where: { id: 'mb_1' },
      data: {
        encryptedRefreshToken: fakeEncrypt('new-refresh-token'),
        tokenLastRefreshedAt: new Date('2026-05-30T00:00:00.000Z'),
      },
    });
  });

  it('NEVER writes plaintext: the stored token is the encrypted form only', async () => {
    const { client, update } = fakePrisma();

    await persistRotatedRefreshToken('mb_2', 'super-secret-token', {
      prisma: client,
      encryptSecret: fakeEncrypt,
      now: NOW,
      logger: captureLogger(),
    });

    const written = update.mock.calls[0][0].data.encryptedRefreshToken as string;
    expect(written).not.toContain('super-secret-token');
    expect(written).toBe(fakeEncrypt('super-secret-token'));
  });

  it('keeps the old token (no DB write) when Microsoft returns no new refresh token', async () => {
    const { client, update } = fakePrisma();
    const encryptSecret = vi.fn(fakeEncrypt);

    const result = await persistRotatedRefreshToken('mb_3', undefined, {
      prisma: client,
      encryptSecret,
      logger: captureLogger(),
    });

    expect(result).toEqual({ rotated: false });
    expect(update).not.toHaveBeenCalled();
    expect(encryptSecret).not.toHaveBeenCalled();
  });

  it('treats an empty / whitespace refresh token as "no rotation" — never overwrites', async () => {
    const { client, update } = fakePrisma();

    for (const empty of ['', '   ']) {
      const result = await persistRotatedRefreshToken('mb_4', empty, {
        prisma: client,
        encryptSecret: fakeEncrypt,
        logger: captureLogger(),
      });
      expect(result).toEqual({ rotated: false });
    }
    expect(update).not.toHaveBeenCalled();
  });

  it('is non-fatal and leaks no token when encryption fails', async () => {
    const { client, update } = fakePrisma();
    const logger = captureLogger();
    const encryptSecret = vi.fn(() => {
      throw new Error('boom: top-secret-token leaked in error');
    });

    const result = await persistRotatedRefreshToken('mb_5', 'top-secret-token', {
      prisma: client,
      encryptSecret,
      logger,
    });

    expect(result).toEqual({ rotated: false });
    expect(update).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // The warn call must only carry the mailbox id — never the token or the
    // underlying error message.
    const [msg, ctx] = logger.warn.mock.calls[0];
    expect(JSON.stringify({ msg, ctx })).not.toContain('top-secret-token');
    expect(ctx).toEqual({ mailboxId: 'mb_5' });
  });

  it('is non-fatal and leaks no token when the DB update fails', async () => {
    const update = vi.fn(async () => {
      throw new Error('db down (refresh=plaintext-should-not-appear)');
    });
    const client = { mailbox: { update } };
    const logger = captureLogger();

    const result = await persistRotatedRefreshToken('mb_6', 'plaintext-should-not-appear', {
      prisma: client,
      encryptSecret: fakeEncrypt,
      now: NOW,
      logger,
    });

    expect(result).toEqual({ rotated: false });
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [, ctx] = logger.warn.mock.calls[0];
    expect(ctx).toEqual({ mailboxId: 'mb_6' });
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(
      'plaintext-should-not-appear',
    );
  });
});
