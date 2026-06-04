import { NextResponse } from 'next/server';
import { loadEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import {
  MICROSOFT_OAUTH_RECONNECT_COOKIE,
  MICROSOFT_OAUTH_STATE_COOKIE,
  MICROSOFT_OAUTH_STATE_TTL_SECONDS,
  MicrosoftOAuthConfigError,
  buildMicrosoftConnectUrl,
} from '@/services/microsoft/oauth-connect-url.service';

export const dynamic = 'force-dynamic';

const logger = createLogger();

// A mailbox id (cuid) is short; cap to a sane length so a crafted query string
// can never bloat the cookie. Absent/blank → fresh connect (no reconnect cookie).
const MAILBOX_ID_MAX_LENGTH = 100;

function readReconnectMailboxId(request: Request): string | null {
  try {
    const value = new URL(request.url).searchParams.get('mailboxId');
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed.length > MAILBOX_ID_MAX_LENGTH) {
      return null;
    }
    return trimmed;
  } catch {
    return null;
  }
}

export async function GET(request: Request): Promise<NextResponse> {
  const { values } = loadEnv();
  const reconnectMailboxId = readReconnectMailboxId(request);

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
  // TASK-069B — remember the mailbox being reconnected so the callback can
  // refuse to overwrite a different mailbox if a wrong account signs in. The
  // value is just a row id (not a secret); kept httpOnly with the state TTL.
  response.cookies.set({
    name: MICROSOFT_OAUTH_RECONNECT_COOKIE,
    value: reconnectMailboxId ?? '',
    httpOnly: true,
    sameSite: 'lax',
    secure: values.APP_ENV === 'production',
    path: '/',
    // Clear any stale reconnect cookie on a fresh connect (maxAge 0).
    maxAge: reconnectMailboxId ? MICROSOFT_OAUTH_STATE_TTL_SECONDS : 0,
  });
  return response;
}
