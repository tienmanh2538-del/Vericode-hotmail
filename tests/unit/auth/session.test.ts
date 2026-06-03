import { describe, it, expect } from 'vitest';

import { loadEnv } from '@/lib/env';
import { getCurrentUser } from '@/lib/auth/session';
import { createStagingSessionToken } from '@/lib/auth/staging-session';

// TASK-057 — getCurrentUser is the single chokepoint that decides whether a
// request carries a trusted admin identity. These tests pin the fail-closed
// contract: dev/staging convenience logins must NEVER resolve in production,
// and an unconfigured/invalid runtime must resolve to null (no admin).

// 32-byte base64 example key (same placeholder the committed .env.example uses).
const ENCRYPTION_KEY = 'nalEIVJZXcG9Ew6PQbF/QzIlSu60kDrNs4EJd1zrMiA=';

function validStagingToken(): string {
  const values = loadEnv({
    APP_ENV: 'staging',
    ENCRYPTION_KEY,
    STAGING_ADMIN_PASSWORD: 'correct horse battery staple',
  }).values;
  // Use the default (current) clock so the 12h expiry is in the future when
  // getCurrentUser verifies it against Date.now().
  const token = createStagingSessionToken(values);
  if (token === null) throw new Error('expected a signed staging token');
  return token;
}

describe('getCurrentUser — development', () => {
  it('returns the demo user only when the dev flag is enabled', async () => {
    const user = await getCurrentUser({
      APP_ENV: 'development',
      AUTH_DEV_DEMO_USER: 'true',
    });
    expect(user).toEqual({
      id: 'dev-demo-user',
      email: 'demo@local.test',
      role: 'OWNER',
    });
  });

  it('returns null in development when the dev flag is off/unset', async () => {
    expect(await getCurrentUser({ APP_ENV: 'development' })).toBeNull();
    expect(
      await getCurrentUser({ APP_ENV: 'development', AUTH_DEV_DEMO_USER: 'false' }),
    ).toBeNull();
  });
});

describe('getCurrentUser — staging', () => {
  it('resolves a valid signed session token to the staging admin', async () => {
    const user = await getCurrentUser(
      { APP_ENV: 'staging', ENCRYPTION_KEY, STAGING_ADMIN_PASSWORD: 'pw' },
      { stagingSessionToken: validStagingToken() },
    );
    expect(user).toEqual({
      id: 'staging-admin',
      email: 'staging-admin@local.staging',
      role: 'OWNER',
    });
  });

  it('returns null for an invalid/tampered token', async () => {
    const user = await getCurrentUser(
      { APP_ENV: 'staging', ENCRYPTION_KEY, STAGING_ADMIN_PASSWORD: 'pw' },
      { stagingSessionToken: `${validStagingToken()}tampered` },
    );
    expect(user).toBeNull();
  });

  it('returns null when no session token is present', async () => {
    const user = await getCurrentUser(
      { APP_ENV: 'staging', ENCRYPTION_KEY, STAGING_ADMIN_PASSWORD: 'pw' },
      { stagingSessionToken: null },
    );
    expect(user).toBeNull();
  });
});

describe('getCurrentUser — production is fail-closed', () => {
  it('never returns the dev demo user, even if AUTH_DEV_DEMO_USER is on', async () => {
    const user = await getCurrentUser({
      APP_ENV: 'production',
      AUTH_DEV_DEMO_USER: 'true',
    });
    expect(user).toBeNull();
  });

  it('never honors a valid staging session token in production', async () => {
    // A perfectly valid staging token + signing secret is present, yet because
    // the runtime is production it must be ignored entirely.
    const user = await getCurrentUser(
      {
        APP_ENV: 'production',
        ENCRYPTION_KEY,
        STAGING_ADMIN_PASSWORD: 'correct horse battery staple',
      },
      { stagingSessionToken: validStagingToken() },
    );
    expect(user).toBeNull();
  });

  it('returns null in production with no auth config at all', async () => {
    expect(await getCurrentUser({ APP_ENV: 'production' })).toBeNull();
  });
});

describe('getCurrentUser — other runtimes', () => {
  it('returns null under the test runtime', async () => {
    expect(
      await getCurrentUser({ APP_ENV: 'test', AUTH_DEV_DEMO_USER: 'true' }),
    ).toBeNull();
  });
});
