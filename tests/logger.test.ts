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
  it('masks every sensitive key listed in the spec', () => {
    const out = sanitize({
      token: 'AAAAAAAAAAAAAAAAAAAA',
      accessToken: 'BBBBBBBBBBBBBBBBBBBB',
      refreshToken: 'CCCCCCCCCCCCCCCCCCCC',
      password: 'DDDDDDDDDDDDDDDDDDDD',
      secret: 'EEEEEEEEEEEEEEEEEEEE',
      clientSecret: 'FFFFFFFFFFFFFFFFFFFF',
      code: '987654',
      verificationCode: '123456',
      telegramBotToken: 'GGGGGGGGGGGGGGGGGGGG',
    }) as Record<string, string>;
    for (const v of [
      'AAAAAAAAAAAAAAAAAAAA',
      'BBBBBBBBBBBBBBBBBBBB',
      'CCCCCCCCCCCCCCCCCCCC',
      'DDDDDDDDDDDDDDDDDDDD',
      'EEEEEEEEEEEEEEEEEEEE',
      'FFFFFFFFFFFFFFFFFFFF',
      '987654',
      '123456',
      'GGGGGGGGGGGGGGGGGGGG',
    ]) {
      expect(JSON.stringify(out)).not.toContain(v);
    }
  });

  it('truncates email body / html content', () => {
    const body = 'Hello user, your code is 123456. '.repeat(20);
    const out = sanitize({ body }) as { body: string };
    expect(out.body.length).toBeLessThan(body.length);
    expect(out.body).toContain('[truncated]');
  });

  it('recurses into nested structures', () => {
    const out = sanitize({
      meta: { authorization: 'Bearer secretToken1234567890' },
      list: [{ secret: 'plaintext-value-here' }],
    });
    const dumped = JSON.stringify(out);
    expect(dumped).not.toContain('secretToken1234567890');
    expect(dumped).not.toContain('plaintext-value-here');
  });

  it('caps excessive depth', () => {
    let nested: Record<string, unknown> = { leaf: 'ok' };
    for (let i = 0; i < 10; i += 1) nested = { child: nested };
    expect(JSON.stringify(sanitize(nested))).toContain('[Truncated]');
  });
});

describe('createLogger', () => {
  it('respects level threshold', () => {
    const sink = makeSink();
    const log = createLogger({ level: 'warn', sink });
    log.debug('a');
    log.info('b');
    log.warn('c');
    log.error('d');
    expect(sink.debug).not.toHaveBeenCalled();
    expect(sink.info).not.toHaveBeenCalled();
    expect(sink.warn).toHaveBeenCalledTimes(1);
    expect(sink.error).toHaveBeenCalledTimes(1);
  });

  it('redacts secrets in free-text message string', () => {
    const sink = makeSink();
    const log = createLogger({ level: 'debug', sink });
    log.info('user authenticated with token=abcdef1234567890realsecret value');
    const joined = sink.info.mock.calls.flat().map((a) => JSON.stringify(a)).join(' ');
    expect(joined).not.toContain('abcdef1234567890realsecret');
    expect(joined).toContain('[REDACTED]');
  });

  it('never emits raw sensitive context values', () => {
    const sink = makeSink();
    const log = createLogger({ level: 'debug', sink });
    log.info('telegram send', {
      chatId: '123',
      telegramBotToken: 'real-bot-token-do-not-leak',
      verificationCode: '987654',
    });
    const joined = sink.info.mock.calls.flat().map((a) => JSON.stringify(a)).join(' ');
    expect(joined).not.toContain('real-bot-token-do-not-leak');
    expect(joined).not.toContain('987654');
    expect(joined).toContain('chatId');
  });
});
