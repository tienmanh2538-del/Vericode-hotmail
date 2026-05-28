import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { loadEnv, type EnvValues } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { MICROSOFT_OAUTH_STATE_COOKIE } from '@/services/microsoft/oauth-connect-url.service';
import {
  MicrosoftOAuthTokenExchangeError,
  exchangeAuthorizationCodeForTokens,
} from '@/services/microsoft/oauth-token-exchange.service';
import { fetchMicrosoftProfile } from '@/services/microsoft/microsoft-profile.service';
import {
  MailboxConnectError,
  saveConnectedMailbox,
} from '@/services/microsoft/mailbox-connect.service';

export const dynamic = 'force-dynamic';

const logger = createLogger();

type CallbackReason =
  | 'access_denied'
  | 'oauth_error'
  | 'invalid_request'
  | 'invalid_state'
  | 'missing_code'
  | 'token_exchange_failed'
  | 'mailbox_save_failed';

const MICROSOFT_ERROR_REASON_MAP: Record<string, CallbackReason> = {
  access_denied: 'access_denied',
  invalid_request: 'invalid_request',
};

function mapMicrosoftError(value: string): CallbackReason {
  return MICROSOFT_ERROR_REASON_MAP[value] ?? 'oauth_error';
}

function safeStateEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.byteLength !== bufB.byteLength) return false;
  return timingSafeEqual(bufA, bufB);
}

function clearStateCookie(response: NextResponse, env: EnvValues): void {
  response.cookies.set({
    name: MICROSOFT_OAUTH_STATE_COOKIE,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: env.APP_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
}

function buildRedirect(
  request: NextRequest,
  env: EnvValues,
  status: 'success' | 'error',
  reason?: CallbackReason,
): NextResponse {
  const target = new URL('/admin', request.url);
  target.searchParams.set('oauth', status);
  if (reason) target.searchParams.set('reason', reason);
  const response = NextResponse.redirect(target);
  clearStateCookie(response, env);
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { values: env } = loadEnv();
  const url = new URL(request.url);

  const code = url.searchParams.get('code');
  const stateParam = url.searchParams.get('state');
  const errorParam = url.searchParams.get('error');

  const cookieState = request.cookies.get(MICROSOFT_OAUTH_STATE_COOKIE)?.value;

  if (typeof errorParam === 'string' && errorParam.length > 0) {
    const reason = mapMicrosoftError(errorParam);
    logger.warn('Microsoft OAuth callback returned error', {
      microsoftError: errorParam,
      reason,
    });
    return buildRedirect(request, env, 'error', reason);
  }

  if (typeof code !== 'string' || code.length === 0) {
    logger.warn('Microsoft OAuth callback missing code');
    return buildRedirect(request, env, 'error', 'missing_code');
  }

  if (
    typeof stateParam !== 'string' ||
    stateParam.length === 0 ||
    typeof cookieState !== 'string' ||
    cookieState.length === 0 ||
    !safeStateEquals(stateParam, cookieState)
  ) {
    logger.warn('Microsoft OAuth callback state invalid');
    return buildRedirect(request, env, 'error', 'invalid_state');
  }

  let tokens;
  try {
    tokens = await exchangeAuthorizationCodeForTokens({ code }, { env });
  } catch (err: unknown) {
    if (err instanceof MicrosoftOAuthTokenExchangeError) {
      logger.warn('Microsoft OAuth token exchange failed', {
        kind: err.kind,
        httpStatus: err.httpStatus,
        microsoftErrorCode: err.microsoftErrorCode,
      });
    } else {
      logger.error('Microsoft OAuth callback unexpected error');
    }
    return buildRedirect(request, env, 'error', 'token_exchange_failed');
  }

  // offline_access is required for refresh_token; without it we cannot keep
  // the mailbox ACTIVE, so we refuse to persist a half-connected mailbox.
  if (!tokens.refreshToken) {
    logger.warn('Microsoft OAuth callback succeeded without refresh_token');
    return buildRedirect(request, env, 'error', 'token_exchange_failed');
  }

  try {
    const profile = await fetchMicrosoftProfile(tokens.accessToken);
    const emailAddress = profile.mail ?? profile.userPrincipalName;
    if (typeof emailAddress !== 'string' || emailAddress.length === 0) {
      logger.warn('Microsoft profile missing both mail and userPrincipalName');
      return buildRedirect(request, env, 'error', 'mailbox_save_failed');
    }

    await saveConnectedMailbox({
      microsoftUserId: profile.id,
      emailAddress,
      displayName: profile.displayName,
      refreshToken: tokens.refreshToken,
      scope: tokens.scope ?? null,
    });
  } catch (err: unknown) {
    if (err instanceof MailboxConnectError) {
      logger.warn('Mailbox connect failed after OAuth callback', { kind: err.kind });
    } else {
      logger.error('Microsoft OAuth mailbox save unexpected error');
    }
    return buildRedirect(request, env, 'error', 'mailbox_save_failed');
  }

  return buildRedirect(request, env, 'success');
}
