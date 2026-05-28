import { NextResponse } from 'next/server';
import { loadEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import {
  MICROSOFT_OAUTH_STATE_COOKIE,
  MICROSOFT_OAUTH_STATE_TTL_SECONDS,
  MicrosoftOAuthConfigError,
  buildMicrosoftConnectUrl,
} from '@/services/microsoft/oauth-connect-url.service';

export const dynamic = 'force-dynamic';

const logger = createLogger();

export async function GET(): Promise<NextResponse> {
  const { values } = loadEnv();

  let connect;
  try {
    connect = buildMicrosoftConnectUrl({ env: values });
  } catch (error: unknown) {
    if (error instanceof MicrosoftOAuthConfigError) {
      logger.warn('Microsoft OAuth connect URL requested but not configured');
      return NextResponse.json(
        { ok: false, error: 'Microsoft OAuth is not configured' },
        { status: 500 },
      );
    }
    logger.error('Failed to build Microsoft OAuth connect URL');
    return NextResponse.json(
      { ok: false, error: 'Unexpected server error' },
      { status: 500 },
    );
  }

  const response = NextResponse.json({ ok: true, url: connect.url });
  response.cookies.set({
    name: MICROSOFT_OAUTH_STATE_COOKIE,
    value: connect.state,
    httpOnly: true,
    sameSite: 'lax',
    secure: values.APP_ENV === 'production',
    path: '/',
    maxAge: MICROSOFT_OAUTH_STATE_TTL_SECONDS,
  });
  return response;
}
