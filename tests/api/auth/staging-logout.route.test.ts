import { describe, it, expect, vi, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

import { STAGING_SESSION_COOKIE } from '@/lib/auth/staging-session';

// TASK-057 — logout must reliably clear the session cookie with the SAME
// hardened attributes used to set it, otherwise a stale cookie could linger.
// Audit writes are mocked so no DB is required.

vi.mock('@/lib/auth/auth-audit', () => ({
  recordAdminLogoutAudit: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from '@/app/api/auth/staging-logout/route';

const APP_URL = 'https://staging.example.test';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/auth/staging-logout', () => {
  it('clears the session cookie and redirects to /login', async () => {
    vi.stubEnv('APP_ENV', 'staging');
    vi.stubEnv('APP_URL', APP_URL);

    const res = await POST(
      new NextRequest(`${APP_URL}/api/auth/staging-logout`, { method: 'POST' }),
    );

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`${APP_URL}/login`);

    const cookie = res.cookies.get(STAGING_SESSION_COOKIE);
    // Cleared: empty value + maxAge 0, but the same flags so the browser
    // overwrites the original cookie rather than creating a sibling.
    expect(cookie?.value).toBe('');
    expect(cookie?.maxAge).toBe(0);
    expect(cookie?.httpOnly).toBe(true);
    expect(cookie?.secure).toBe(true);
    expect(cookie?.sameSite).toBe('lax');
    expect(cookie?.path).toBe('/');
  });
});
