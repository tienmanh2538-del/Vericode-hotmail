import { describe, it, expect } from 'vitest';
import {
  loadEnv,
  MissingEnvError,
  requireDatabaseEnv,
  requireEncryptionEnv,
  requireMicrosoftEnv,
  requireTelegramEnv,
} from '@/lib/env';

describe('loadEnv', () => {
  it('falls back to defaults and does not throw on empty input', () => {
    const result = loadEnv({});
    expect(result.values.APP_ENV).toBe('development');
    expect(result.values.LOG_LEVEL).toBe('info');
    expect(result.values.APP_URL).toBe('http://localhost:3000');
    expect(result.warnings).toEqual([]);
  });

  it('falls back when enum is invalid and records a warning', () => {
    const result = loadEnv({ APP_ENV: 'staging', LOG_LEVEL: 'verbose' });
    expect(result.values.APP_ENV).toBe('development');
    expect(result.values.LOG_LEVEL).toBe('info');
    expect(result.warnings.some((w) => w.includes('APP_ENV'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('LOG_LEVEL'))).toBe(true);
  });

  it('does not throw in production when secrets are absent (per-module pattern)', () => {
    expect(() => loadEnv({ APP_ENV: 'production' })).not.toThrow();
  });
});

describe('per-module require helpers', () => {
  it('requireMicrosoftEnv throws MissingEnvError listing only key names', () => {
    const { values } = loadEnv({});
    try {
      requireMicrosoftEnv(values);
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MissingEnvError);
      const e = err as MissingEnvError;
      expect(e.module).toBe('microsoft-oauth');
      expect(e.missing).toContain('MICROSOFT_CLIENT_ID');
      expect(e.message).toContain('MICROSOFT_CLIENT_ID');
    }
  });

  it('returns parsed microsoft env when all keys present', () => {
    const { values } = loadEnv({
      MICROSOFT_CLIENT_ID: 'client-id',
      MICROSOFT_CLIENT_SECRET: 'client-secret',
      MICROSOFT_TENANT_ID: 'tenant',
      MICROSOFT_REDIRECT_URI: 'https://app.example/cb',
    });
    const out = requireMicrosoftEnv(values);
    expect(out.clientId).toBe('client-id');
    expect(out.tenantId).toBe('tenant');
  });

  it('requireTelegramEnv / requireDatabaseEnv / requireEncryptionEnv throw with module names', () => {
    const { values } = loadEnv({});
    expect(() => requireTelegramEnv(values)).toThrow(/telegram/);
    expect(() => requireDatabaseEnv(values)).toThrow(/database/);
    expect(() => requireEncryptionEnv(values)).toThrow(/encryption/);
  });

  it('error message never includes the secret value, only key names', () => {
    const secretValue = 'super-secret-token-do-not-leak-1234567890';
    const { values } = loadEnv({
      TELEGRAM_BOT_TOKEN: secretValue,
    });
    // Force a missing other module to assert error never echoes any provided secret
    try {
      requireMicrosoftEnv(values);
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).not.toContain(secretValue);
    }
  });
});
