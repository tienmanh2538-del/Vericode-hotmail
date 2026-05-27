import { describe, it, expect } from 'vitest';
import {
  createAuditLog,
  createInMemoryAuditLogStore,
  listAuditLogs,
  sanitizeAuditMetadata,
} from '@/services/logs/audit-log.service';

describe('sanitizeAuditMetadata', () => {
  it('returns null for null/undefined input', () => {
    expect(sanitizeAuditMetadata(null)).toBeNull();
    expect(sanitizeAuditMetadata(undefined)).toBeNull();
  });

  it('redacts every documented sensitive field', () => {
    const result = sanitizeAuditMetadata({
      password: 'p@ss',
      token: 't1',
      accessToken: 'at',
      refreshToken: 'rt',
      clientSecret: 'cs',
      secret: 's',
      telegramBotToken: 'bot',
      code: '123456',
      verificationCode: '654321',
      otp: '999',
      authorization: 'Bearer abc',
      cookie: 'sid=xyz',
      keep: 'visible',
    });

    expect(result).not.toBeNull();
    expect(result?.keep).toBe('visible');
    for (const key of [
      'password',
      'token',
      'accessToken',
      'refreshToken',
      'clientSecret',
      'secret',
      'telegramBotToken',
      'code',
      'verificationCode',
      'otp',
      'authorization',
      'cookie',
    ]) {
      expect(result?.[key]).toBe('[REDACTED]');
    }
  });

  it('redacts case-insensitively and through common separators', () => {
    const result = sanitizeAuditMetadata({
      Password: 'p',
      ACCESS_TOKEN: 'a',
      'refresh-token': 'r',
      'Telegram Bot Token': 'b',
    });
    expect(result?.Password).toBe('[REDACTED]');
    expect(result?.ACCESS_TOKEN).toBe('[REDACTED]');
    expect(result?.['refresh-token']).toBe('[REDACTED]');
    expect(result?.['Telegram Bot Token']).toBe('[REDACTED]');
  });

  it('redacts nested sensitive fields in objects and arrays', () => {
    const result = sanitizeAuditMetadata({
      user: { id: 'u1', password: 'p' },
      tokens: [{ refreshToken: 'rt1' }, { refreshToken: 'rt2' }],
      deep: { layer1: { layer2: { secret: 's' } } },
    });
    expect(result).toEqual({
      user: { id: 'u1', password: '[REDACTED]' },
      tokens: [{ refreshToken: '[REDACTED]' }, { refreshToken: '[REDACTED]' }],
      deep: { layer1: { layer2: { secret: '[REDACTED]' } } },
    });
  });

  it('returns null for non-object metadata', () => {
    expect(sanitizeAuditMetadata([] as unknown as Record<string, unknown>)).toBeNull();
    expect(sanitizeAuditMetadata('foo' as unknown as Record<string, unknown>)).toBeNull();
  });
});

describe('createAuditLog', () => {
  it('rejects when action is missing or unknown', () => {
    const store = createInMemoryAuditLogStore();
    expect(() =>
      createAuditLog(
        {
          action: 'NOT_A_REAL_ACTION' as never,
          entityType: 'customer',
        },
        store,
      ),
    ).toThrow(/action/);
    expect(store.list()).toHaveLength(0);
  });

  it('rejects when entityType is unknown', () => {
    const store = createInMemoryAuditLogStore();
    expect(() =>
      createAuditLog(
        {
          action: 'CUSTOMER_CREATED',
          entityType: 'nope' as never,
        },
        store,
      ),
    ).toThrow(/entityType/);
    expect(store.list()).toHaveLength(0);
  });

  it('sanitizes metadata before storage', () => {
    const store = createInMemoryAuditLogStore();
    const item = createAuditLog(
      {
        action: 'TELEGRAM_TEST_SEND_REQUESTED',
        entityType: 'telegram_mapping',
        entityId: 'tm_1',
        actorEmail: 'admin@example.com',
        metadata: {
          telegramBotToken: 'super-secret',
          verificationCode: '123456',
          note: 'manual test',
        },
      },
      store,
    );

    expect(item.metadata).toEqual({
      telegramBotToken: '[REDACTED]',
      verificationCode: '[REDACTED]',
      note: 'manual test',
    });
    expect(store.list()).toHaveLength(1);
    expect(store.list()[0].metadata).toEqual(item.metadata);
  });

  it('defaults severity based on action', () => {
    const store = createInMemoryAuditLogStore();
    const ok = createAuditLog(
      { action: 'CUSTOMER_CREATED', entityType: 'customer' },
      store,
    );
    const bad = createAuditLog(
      { action: 'SYSTEM_ERROR', entityType: 'system' },
      store,
    );
    expect(ok.severity).toBe('info');
    expect(bad.severity).toBe('error');
  });

  it('respects an explicit severity when provided', () => {
    const store = createInMemoryAuditLogStore();
    const item = createAuditLog(
      {
        action: 'CUSTOMER_CREATED',
        entityType: 'customer',
        severity: 'warning',
      },
      store,
    );
    expect(item.severity).toBe('warning');
  });
});

describe('listAuditLogs', () => {
  it('returns empty result without crashing when store is empty', () => {
    const store = createInMemoryAuditLogStore();
    const result = listAuditLogs({}, store);
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });

  it('returns entries newest first', () => {
    const store = createInMemoryAuditLogStore();
    createAuditLog(
      {
        action: 'CUSTOMER_CREATED',
        entityType: 'customer',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      store,
    );
    createAuditLog(
      {
        action: 'CUSTOMER_UPDATED',
        entityType: 'customer',
        createdAt: '2026-01-03T00:00:00.000Z',
      },
      store,
    );
    createAuditLog(
      {
        action: 'CUSTOMER_DELETED',
        entityType: 'customer',
        createdAt: '2026-01-02T00:00:00.000Z',
      },
      store,
    );

    const result = listAuditLogs({}, store);
    expect(result.items.map((i) => i.createdAt)).toEqual([
      '2026-01-03T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ]);
  });

  it('filters by action', () => {
    const store = createInMemoryAuditLogStore();
    createAuditLog({ action: 'CUSTOMER_CREATED', entityType: 'customer' }, store);
    createAuditLog({ action: 'CUSTOMER_UPDATED', entityType: 'customer' }, store);
    createAuditLog(
      { action: 'TELEGRAM_MAPPING_CREATED', entityType: 'telegram_mapping' },
      store,
    );

    const result = listAuditLogs({ action: 'CUSTOMER_CREATED' }, store);
    expect(result.total).toBe(1);
    expect(result.items[0].action).toBe('CUSTOMER_CREATED');
  });

  it('filters by entityType', () => {
    const store = createInMemoryAuditLogStore();
    createAuditLog({ action: 'CUSTOMER_CREATED', entityType: 'customer' }, store);
    createAuditLog(
      { action: 'TELEGRAM_MAPPING_CREATED', entityType: 'telegram_mapping' },
      store,
    );
    createAuditLog(
      { action: 'TELEGRAM_MAPPING_UPDATED', entityType: 'telegram_mapping' },
      store,
    );

    const result = listAuditLogs({ entityType: 'telegram_mapping' }, store);
    expect(result.total).toBe(2);
    expect(
      result.items.every((i) => i.entityType === 'telegram_mapping'),
    ).toBe(true);
  });

  it('filters by free-text search across actor and summary', () => {
    const store = createInMemoryAuditLogStore();
    createAuditLog(
      {
        action: 'ADMIN_LOGIN',
        entityType: 'user',
        actorEmail: 'alice@example.com',
        summary: 'Successful login',
      },
      store,
    );
    createAuditLog(
      {
        action: 'ADMIN_LOGIN',
        entityType: 'user',
        actorEmail: 'bob@example.com',
        summary: 'Successful login',
      },
      store,
    );

    const result = listAuditLogs({ search: 'alice' }, store);
    expect(result.total).toBe(1);
    expect(result.items[0].actorEmail).toBe('alice@example.com');
  });

  it('applies an explicit limit but reports the unfiltered total', () => {
    const store = createInMemoryAuditLogStore();
    for (let i = 0; i < 5; i += 1) {
      createAuditLog(
        {
          action: 'CUSTOMER_CREATED',
          entityType: 'customer',
          createdAt: `2026-01-0${i + 1}T00:00:00.000Z`,
        },
        store,
      );
    }
    const result = listAuditLogs({ limit: 2 }, store);
    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(5);
  });
});

describe('safety guarantees', () => {
  it('never returns raw token, secret, password, or full verification code', () => {
    const store = createInMemoryAuditLogStore();
    createAuditLog(
      {
        action: 'TOKEN_REFRESH_FAILED',
        entityType: 'mailbox',
        entityId: 'mb_1',
        metadata: {
          accessToken: 'AAAA-very-secret',
          refreshToken: 'RRRR-very-secret',
          telegramBotToken: '123:abc',
          password: 'hunter2',
          clientSecret: 'cs-secret',
          verificationCode: '987654',
          code: '123456',
          authorization: 'Bearer token',
          cookie: 'sid=abc',
          otp: '000111',
        },
      },
      store,
    );

    const result = listAuditLogs({}, store);
    const serialized = JSON.stringify(result.items);

    expect(serialized).not.toContain('AAAA-very-secret');
    expect(serialized).not.toContain('RRRR-very-secret');
    expect(serialized).not.toContain('123:abc');
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('cs-secret');
    expect(serialized).not.toContain('987654');
    expect(serialized).not.toContain('123456');
    expect(serialized).not.toContain('Bearer token');
    expect(serialized).not.toContain('sid=abc');
    expect(serialized).not.toContain('000111');

    const metadata = result.items[0].metadata!;
    for (const key of Object.keys(metadata)) {
      expect(metadata[key]).toBe('[REDACTED]');
    }
  });
});
