import { timingSafeEqual } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';
import { loadEnv, type EnvValues } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import {
  MICROSOFT_OAUTH_RECONNECT_COOKIE,
  MICROSOFT_OAUTH_STATE_COOKIE,
} from '@/services/microsoft/oauth-connect-url.service';
import {
  MicrosoftOAuthTokenExchangeError,
  exchangeAuthorizationCodeForTokens,
} from '@/services/microsoft/oauth-token-exchange.service';
import { fetchMicrosoftProfile } from '@/services/microsoft/microsoft-profile.service';
import {
  MailboxConnectError,
  saveConnectedMailbox,
} from '@/services/microsoft/mailbox-connect.service';
import { ensureInboxSubscriptionForConnectedMailbox } from '@/services/microsoft/mailbox-subscription-provisioning.service';

export const dynamic = 'force-dynamic';

const logger = createLogger();

type CallbackReason =
  | 'access_denied'
  | 'oauth_error'
  | 'invalid_request'
  | 'invalid_state'
  | 'missing_code'
  | 'token_exchange_failed'
  | 'mailbox_save_failed'
  | 'mailbox_mismatch';

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
  // TASK-069B — always clear the reconnect-target cookie too, on success or
  // error, so it can never leak into an unrelated later OAuth attempt.
  response.cookies.set({
    name: MICROSOFT_OAUTH_RECONNECT_COOKIE,
    value: '',
    httpOnly: true,
    sameSite: 'lax',
    secure: env.APP_ENV === 'production',
    path: '/',
    maxAge: 0,
  });
}

function buildRedirect(
  env: EnvValues,
  status: 'success' | 'error',
  reason?: CallbackReason,
): NextResponse {
  // Anchor the post-OAuth redirect to APP_URL (the canonical public origin),
  // NOT request.url. Behind Railway's proxy the app binds to an internal port,
  // so request.url resolves to http://localhost:8080 — redirecting there sends
  // the browser to a dead address (ERR_CONNECTION_REFUSED) even though the
  // mailbox was already persisted. Same fix as the staging login/logout routes.
  //
  // Success lands on /admin/mailboxes so the freshly connected mailbox is
  // visible in the list immediately; errors land on the /admin dashboard, which
  // renders the reason banner from the `oauth`/`reason` query params.
  const path = status === 'success' ? '/admin/mailboxes' : '/admin';
  const target = new URL(path, env.APP_URL);
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
  // TASK-069B — present only when this flow began from a mailbox "Reconnect"
  // button. Empty/blank means a fresh connect (no reconnect target).
  const reconnectCookie = request.cookies
    .get(MICROSOFT_OAUTH_RECONNECT_COOKIE)
    ?.value?.trim();
  const expectedMailboxId =
    typeof reconnectCookie === 'string' && reconnectCookie.length > 0
      ? reconnectCookie
      : null;

  if (typeof errorParam === 'string' && errorParam.length > 0) {
    const reason = mapMicrosoftError(errorParam);
    logger.warn('Microsoft OAuth callback returned error', {
      microsoftError: errorParam,
      reason,
    });
    return buildRedirect(env, 'error', reason);
  }

  if (typeof code !== 'string' || code.length === 0) {
    logger.warn('Microsoft OAuth callback missing code');
    return buildRedirect(env, 'error', 'missing_code');
  }

  if (
    typeof stateParam !== 'string' ||
    stateParam.length === 0 ||
    typeof cookieState !== 'string' ||
    cookieState.length === 0 ||
    !safeStateEquals(stateParam, cookieState)
  ) {
    logger.warn('Microsoft OAuth callback state invalid');
    return buildRedirect(env, 'error', 'invalid_state');
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
    return buildRedirect(env, 'error', 'token_exchange_failed');
  }

  // offline_access is required for refresh_token; without it we cannot keep
  // the mailbox ACTIVE, so we refuse to persist a half-connected mailbox.
  if (!tokens.refreshToken) {
    logger.warn('Microsoft OAuth callback succeeded without refresh_token');
    return buildRedirect(env, 'error', 'token_exchange_failed');
  }

  let savedMailbox;
  try {
    const profile = await fetchMicrosoftProfile(tokens.accessToken);
    const emailAddress = profile.mail ?? profile.userPrincipalName;
    if (typeof emailAddress !== 'string' || emailAddress.length === 0) {
      logger.warn('Microsoft profile missing both mail and userPrincipalName');
      return buildRedirect(env, 'error', 'mailbox_save_failed');
    }

    savedMailbox = await saveConnectedMailbox({
      microsoftUserId: profile.id,
      emailAddress,
      displayName: profile.displayName,
      refreshToken: tokens.refreshToken,
      scope: tokens.scope ?? null,
      expectedMailboxId,
    });
  } catch (err: unknown) {
    if (err instanceof MailboxConnectError) {
      logger.warn('Mailbox connect failed after OAuth callback', { kind: err.kind });
      // TASK-069B — a reconnect that targeted a specific mailbox but landed a
      // different Microsoft account is refused safely; tell the operator the
      // accounts did not match rather than a generic save failure.
      if (err.kind === 'mismatch') {
        return buildRedirect(env, 'error', 'mailbox_mismatch');
      }
    } else {
      logger.error('Microsoft OAuth mailbox save unexpected error');
    }
    return buildRedirect(env, 'error', 'mailbox_save_failed');
  }

  // TASK-081 — connect-time Graph subscription provisioning (Option A). Runs
  // ONLY after the mailbox + credential are safely persisted, reusing the fresh
  // access token from the token exchange (never persisted). The ensure service
  // is fail-open by contract (it never throws); the extra try/catch is a
  // boundary guarantee that a provisioning bug can never turn an already
  // successful connect into an error — delta polling remains the backup path.
  try {
    await ensureInboxSubscriptionForConnectedMailbox({
      mailboxId: savedMailbox.mailboxId,
      accessToken: tokens.accessToken,
    });
  } catch {
    logger.warn('Graph subscription provisioning threw unexpectedly after connect');
  }

  return buildRedirect(env, 'success');
}
