// TASK-040 preflight — staging admin logout. Clears the session cookie.

import { NextResponse, type NextRequest } from 'next/server';

import { STAGING_SESSION_COOKIE } from '@/lib/auth/staging-session';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const response = NextResponse.redirect(new URL('/login', request.url), 303);
  response.cookies.set(STAGING_SESSION_COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    path: '/',
    maxAge: 0,
  });
  return response;
}
