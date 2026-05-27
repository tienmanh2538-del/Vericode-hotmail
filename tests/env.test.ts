import { describe, it, expect } from 'vitest';
import { loadEnv } from '@/lib/env';

describe('loadEnv', () => {
  it('falls back to defaults when input is empty (does not throw)', () => {
    const result = loadEnv({});
    expect(result.values.APP_ENV).toBe('development');
    expect(result.values.LOG_LEVEL).toBe('info');
    expect(result.values.APP_URL).toBe('http://localhost:3000');
    expect(result.ok).toBe(true);
  });

  it('flags missing required secrets in production but does not throw', () => {
    const result = loadEnv({ APP_ENV: 'production' });
    expect(result.ok).toBe(false);
    expect(result.missing).toContain('DATABASE_URL');
    expect(result.missing).toContain('TELEGRAM_BOT_TOKEN');
    expect(result.missing).toContain('ENCRYPTION_KEY');
  });

  it('accepts a fully populated environment as ok', () => {
    const result = loadEnv({
      APP_ENV: 'production',
      APP_URL: 'https://app.example.test',
      LOG_LEVEL: 'warn',
      DATABASE_URL: 'postgresql://u:p@h:5432/db',
      MICROSOFT_CLIENT_ID: 'client-id-xxx',
      MICROSOFT_CLIENT_SECRET: 'client-secret-xxx',
      MICROSOFT_TENANT_ID: 'tenant',
      TELEGRAM_BOT_TOKEN: 'bot-token-xxx',
      ENCRYPTION_KEY: 'enc-key-xxx',
    });
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.values.LOG_LEVEL).toBe('warn');
  });

  it('falls back when enum value is invalid and records a warning', () => {
    const result = loadEnv({ APP_ENV: 'staging', LOG_LEVEL: 'verbose' });
    expect(result.values.APP_ENV).toBe('development');
    expect(result.values.LOG_LEVEL).toBe('info');
    expect(result.warnings.some((w) => w.includes('APP_ENV'))).toBe(true);
    expect(result.warnings.some((w) => w.includes('LOG_LEVEL'))).toBe(true);
  });
});
