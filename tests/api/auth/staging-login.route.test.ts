import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

import { STAGING_SESSION_COOKIE } from '@/lib/auth/staging-session';

// TASK-057 — the staging-login route is the only place a session cookie is
// minted. These tests pin: (1) it is inert outside staging (so the passphrase
// gate can never run in production), (2) it fails closed when unconfigured,
// (3) a correct passphrase mints a hardened cookie, (4) a wrong passphrase mints
// nothing. Audit writes are mocked so no DB is required.

vi.mock('@/lib/auth/auth-audit', () => ({
  recordAdminLoginAudit: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from '@/app/api/auth/staging-login/route';

// 32-byte base64 example key (the committed .env.example placeholder).
const ENCRYPTION_KEY = 'nalEIVJZXcG9Ew6PQbF/QzIlSu60kDrNs4EJd1zrMiA=';
const APP_URL = 'https://staging.example.test';
const PASSPHRASE = 'correct horse battery staple';

function loginRequest(password: string): NextRequest {
  return new NextRequest(`${APP_URL}/api/auth/staging-login`, {
    method: 'POST',
    body: new URLSearchParams({ password }),
  });
}

function stubBaseEnv(appEnv: string): void {
  vi.stubEnv('APP_ENV', appEnv);
  vi.stubEnv('APP_URL', APP_URL);
}

beforeEach(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/auth/staging-login', () => {
  it('does not run the passphrase gate outside staging (production)', async () => {
    stubBaseEnv('production');
    vi.stubEnv('ENCRYPTION_KEY', ENCRYPTION_KEY);
    vi.stubEnv('STAGING_ADMIN_PASSWORD', PASSPHRASE);

    // Even submitting the correct passphrase must not authenticate in production.
    const res = await POST(loginRequest(PASSPHRASE));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${APP_URL}/login`);
    expect(res.cookies.get(STAGING_SESSION_COOKIE)).toBeUndefined();
  });

  it('fails closed on staging when not configured (no passphrase/secret)', async () => {
    stubBaseEnv('staging');

    const res = await POST(loginRequest('anything'));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${APP_URL}/login?error=unconfigured`);
    expect(res.cookies.get(STAGING_SESSION_COOKIE)).toBeUndefined();
  });

  it('rejects a wrong passphrase without minting a cookie', async () => {
    stubBaseEnv('staging');
    vi.stubEnv('ENCRYPTION_KEY', ENCRYPTION_KEY);
    vi.stubEnv('STAGING_ADMIN_PASSWORD', PASSPHRASE);

    const res = await POST(loginRequest('wrong passphrase'));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${APP_URL}/login?error=invalid`);
    expect(res.cookies.get(STAGING_SESSION_COOKIE)).toBeUndefined();
  });

  it('mints a hardened session cookie for the correct passphrase', async () => {
    stubBaseEnv('staging');
    vi.stubEnv('ENCRYPTION_KEY', ENCRYPTION_KEY);
    vi.stubEnv('STAGING_ADMIN_PASSWORD', PASSPHRASE);

    const res = await POST(loginRequest(PASSPHRASE));

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${APP_URL}/admin`);

    const cookie = res.cookies.get(STAGING_SESSION_COOKIE);
    expect(cookie?.value).toBeTruthy();
    // Hardened flags: not readable by JS, HTTPS-only, Lax, scoped to '/',
    // and time-bounded with a positive max-age.
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.secure).toBe(true);
    expect(cookie?.sameSite).toBe('lax');
    expect(cookie?.path).toBe('/');
    expect(cookie?.maxAge).toBeGreaterThan(0);
  });
});
