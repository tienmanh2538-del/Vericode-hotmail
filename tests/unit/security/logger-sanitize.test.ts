import { describe, it, expect, vi } from 'vitest';

import { createLogger, sanitize } from '@/lib/logger';

describe('logger sanitize', () => {
  it('masks sensitive keys (token / secret / code / authorization)', () => {
    const out = sanitize({
      accessToken: 'aaaaaaaaaaaaaaaaaaaa',
      refreshToken: 'bbbbbbbbbbbbbbbbbbbb',
      clientSecret: 'cccccccccccccccccccc',
      verificationCode: '123456',
      authorization: 'Bearer dddddddddddddddddddd',
      mailboxId: 'mb_123',
    }) as Record<string, string>;

    expect(out.mailboxId).toBe('mb_123');
    for (const key of [
      'accessToken',
      'refreshToken',
      'clientSecret',
      'verificationCode',
      'authorization',
    ]) {
      expect(out[key]).not.toContain('aaaa');
      expect(out[key]).not.toContain('Bearer dddd');
      expect(out[key]).not.toBe('123456');
    }
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain('123456');
  });

  it('truncates and redacts email body keys', () => {
    const body = 'Your code is 445566 '.repeat(20);
    const out = sanitize({ emailBody: body }) as Record<string, string>;
    expect(out.emailBody.length).toBeLessThan(body.length);
    expect(out.emailBody).toContain('…[truncated]');
  });

  it('does not leak secrets through the sink when logging structured context', () => {
    const sink = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    };
    const logger = createLogger({ level: 'info', sink });

    logger.info('Refreshed token', {
      mailboxId: 'mb_9',
      refreshToken: 'topsecretrefreshtoken12345',
    });

    const serialized = JSON.stringify(sink.info.mock.calls);
    expect(serialized).not.toContain('topsecretrefreshtoken12345');
    expect(serialized).toContain('mb_9');
  });
});
