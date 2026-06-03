// TASK-040 preflight — staging admin logout. Clears the session cookie.

import { NextResponse, type NextRequest } from 'next/server';

import { loadEnv } from '@/lib/env';
import { STAGING_SESSION_COOKIE } from '@/lib/auth/staging-session';
import { recordAdminLogoutAudit } from '@/lib/auth/auth-audit';

export const dynamic = 'force-dynamic';

export async function POST(_request: NextRequest): Promise<NextResponse> {
  // Redirect from APP_URL (the public origin), not request.url. Behind Railway's
  // proxy request.url resolves to the internal http://localhost:8080, which would
  // bounce the browser to a dead address (ERR_CONNECTION_REFUSED).
  const { values } = loadEnv();
  await recordAdminLogoutAudit({ appEnv: values.APP_ENV });
  const response = NextResponse.redirect(new URL('/login', values.APP_URL), 303);
  response.cookies.set(STAGING_SESSION_COOKIE, '', {
    httpOnly: true,
    secure: true,
    // Match the login cookie's attributes (SameSite=Lax) so this clearing
    // cookie reliably overwrites it. See staging-login/route.ts for why Lax.
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
  return response;
}
