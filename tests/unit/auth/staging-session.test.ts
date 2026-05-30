import { describe, it, expect } from 'vitest';

import { loadEnv, type EnvValues } from '@/lib/env';
import {
  STAGING_SESSION_TTL_MS,
  constantTimeEquals,
  createStagingSessionToken,
  isStagingAdminConfigured,
  verifyStagingPassword,
  verifyStagingSessionToken,
} from '@/lib/auth/staging-session';

// 32-byte base64 example key (same one the committed .env.example uses).
const ENCRYPTION_KEY = 'nalEIVJZXcG9Ew6PQbF/QzIlSu60kDrNs4EJd1zrMiA=';

function stagingEnv(overrides: Record<string, string | undefined> = {}): EnvValues {
  return loadEnv({
    APP_ENV: 'staging',
    ENCRYPTION_KEY,
    STAGING_ADMIN_PASSWORD: 'correct horse battery staple',
    ...overrides,
  }).values;
}

describe('constantTimeEquals', () => {
  it('returns true for equal strings and false otherwise', () => {
    expect(constantTimeEquals('abc', 'abc')).toBe(true);
    expect(constantTimeEquals('abc', 'abd')).toBe(false);
    expect(constantTimeEquals('abc', 'abcd')).toBe(false);
  });
});

describe('isStagingAdminConfigured', () => {
  it('is true only with a passphrase AND a signing secret', () => {
    expect(isStagingAdminConfigured(stagingEnv())).toBe(true);
  });

  it('is false when the passphrase is empty (fail-closed)', () => {
    expect(isStagingAdminConfigured(stagingEnv({ STAGING_ADMIN_PASSWORD: '' }))).toBe(
      false,
    );
  });

  it('is false when no signing secret is available', () => {
    const values = loadEnv({
      APP_ENV: 'staging',
      STAGING_ADMIN_PASSWORD: 'pw',
    }).values;
    expect(isStagingAdminConfigured(values)).toBe(false);
  });
});

describe('verifyStagingPassword', () => {
  it('accepts the exact passphrase and rejects anything else', () => {
    const env = stagingEnv();
    expect(verifyStagingPassword('correct horse battery staple', env)).toBe(true);
    expect(verifyStagingPassword('wrong', env)).toBe(false);
    expect(verifyStagingPassword('', env)).toBe(false);
  });

  it('fails closed when staging admin is not configured', () => {
    const env = stagingEnv({ STAGING_ADMIN_PASSWORD: '' });
    expect(verifyStagingPassword('anything', env)).toBe(false);
  });
});

describe('staging session token', () => {
  it('round-trips a signed token to the admin user', () => {
    const env = stagingEnv();
    const token = createStagingSessionToken(env, 1_000);
    expect(token).not.toBeNull();
    const user = verifyStagingSessionToken(token, env, 2_000);
    expect(user).toEqual({
      id: 'staging-admin',
      email: 'staging-admin@local.staging',
      role: 'OWNER',
    });
  });

  it('rejects an expired token', () => {
    const env = stagingEnv();
    const token = createStagingSessionToken(env, 1_000);
    const afterExpiry = 1_000 + STAGING_SESSION_TTL_MS + 1;
    expect(verifyStagingSessionToken(token, env, afterExpiry)).toBeNull();
  });

  it('rejects a tampered token', () => {
    const env = stagingEnv();
    const token = createStagingSessionToken(env, 1_000) as string;
    const tampered = `${token}x`;
    expect(verifyStagingSessionToken(tampered, env, 2_000)).toBeNull();
  });

  it('rejects a token signed with a different secret', () => {
    const signEnv = stagingEnv({ STAGING_ADMIN_SESSION_SECRET: 'secret-A' });
    const verifyEnv = stagingEnv({ STAGING_ADMIN_SESSION_SECRET: 'secret-B' });
    const token = createStagingSessionToken(signEnv, 1_000);
    expect(verifyStagingSessionToken(token, verifyEnv, 2_000)).toBeNull();
  });

  it('returns null when no signing secret is configured', () => {
    const env = loadEnv({ APP_ENV: 'staging', STAGING_ADMIN_PASSWORD: 'pw' }).values;
    expect(createStagingSessionToken(env, 1_000)).toBeNull();
    expect(verifyStagingSessionToken('whatever', env, 2_000)).toBeNull();
  });

  it('rejects empty/undefined tokens', () => {
    const env = stagingEnv();
    expect(verifyStagingSessionToken(undefined, env)).toBeNull();
    expect(verifyStagingSessionToken('', env)).toBeNull();
  });
});
