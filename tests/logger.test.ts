import { describe, it, expect, vi } from 'vitest';
import { createLogger, sanitize } from '@/lib/logger';

function makeSink() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  };
}

describe('sanitize', () => {
  it('masks sensitive keys in flat objects', () => {
    const out = sanitize({
      user: 'alice',
      password: 'super-secret-1234',
      token: 'ghp_xxxxxxxxxxxxxxxxxxxx',
      verification_code: '987654',
    }) as Record<string, string>;
    expect(out.user).toBe('alice');
    expect(out.password).not.toContain('super-secret');
    expect(out.token).not.toContain('xxxxxxxxxxxxxxxxxxxx');
    expect(out.verification_code).not.toContain('987654');
  });

  it('recurses into nested structures', () => {
    const out = sanitize({
      meta: { authToken: 'abcdef1234567890' },
      list: [{ secret: 'plaintext-value-here' }],
    }) as { meta: { authToken: string }; list: Array<{ secret: string }> };
    expect(out.meta.authToken).not.toContain('abcdef1234567890');
    expect(out.list[0].secret).not.toContain('plaintext-value-here');
  });

  it('truncates excessive depth', () => {
    let nested: Record<string, unknown> = { leaf: 'ok' };
    for (let i = 0; i < 10; i += 1) nested = { child: nested };
    const out = JSON.stringify(sanitize(nested));
    expect(out).toContain('[Truncated]');
  });
});

describe('createLogger', () => {
  it('respects level threshold', () => {
    const sink = makeSink();
    const log = createLogger({ level: 'warn', sink });
    log.debug('skip me');
    log.info('skip me too');
    log.warn('keep this');
    log.error('keep this too');
    expect(sink.debug).not.toHaveBeenCalled();
    expect(sink.info).not.toHaveBeenCalled();
    expect(sink.warn).toHaveBeenCalledTimes(1);
    expect(sink.error).toHaveBeenCalledTimes(1);
  });

  it('never emits raw sensitive values', () => {
    const sink = makeSink();
    const log = createLogger({ level: 'debug', sink });
    log.info('telegram send', {
      chatId: '123',
      botToken: 'real-bot-token-do-not-leak',
      code: '987654',
    });
    const joined = sink.info.mock.calls.flat().map((a) => JSON.stringify(a)).join(' ');
    expect(joined).not.toContain('real-bot-token-do-not-leak');
    expect(joined).not.toContain('987654');
    expect(joined).toContain('chatId');
  });
});
