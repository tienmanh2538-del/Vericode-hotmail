// TASK-040 preflight — staging-only admin login endpoint.
//
// Accepts the shared staging passphrase (POST form field `password`), verifies
// it in constant time against STAGING_ADMIN_PASSWORD, and on success issues a
// signed httpOnly session cookie. The submitted password is NEVER logged.

import { NextResponse, type NextRequest } from 'next/server';

import { loadEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import {
  STAGING_SESSION_COOKIE,
  STAGING_SESSION_TTL_MS,
  createStagingSessionToken,
  isStagingAdminConfigured,
  verifyStagingPassword,
} from '@/lib/auth/staging-session';

export const dynamic = 'force-dynamic';

const logger = createLogger();

const SESSION_MAX_AGE_SECONDS = Math.floor(STAGING_SESSION_TTL_MS / 1000);

function redirect(request: NextRequest, path: string): NextResponse {
  // 303 converts the POST into a GET so the browser navigates cleanly.
  return NextResponse.redirect(new URL(path, request.url), 303);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const { values } = loadEnv();

  // Staging login is only available on staging. Other envs fall through to the
  // normal /login page (dev demo flag / production auth).
  if (values.APP_ENV !== 'staging') {
    return redirect(request, '/login');
  }
  if (!isStagingAdminConfigured(values)) {
    // Fail-closed: no passphrase / no signing secret ⇒ admin stays locked.
    return redirect(request, '/login?error=unconfigured');
  }

  let password = '';
  try {
    const form = await request.formData();
    const value = form.get('password');
    password = typeof value === 'string' ? value : '';
  } catch {
    return redirect(request, '/login?error=invalid');
  }

  if (!verifyStagingPassword(password, values)) {
    // No password / token / env value is logged — only the failure event.
    logger.warn('Staging admin login attempt rejected');
    return redirect(request, '/login?error=invalid');
  }

  const token = createStagingSessionToken(values);
  if (token === null) {
    return redirect(request, '/login?error=unconfigured');
  }

  const response = redirect(request, '/admin');
  response.cookies.set(STAGING_SESSION_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: SESSION_MAX_AGE_SECONDS,
  });
  logger.info('Staging admin login succeeded');
  return response;
}
