import { requireMicrosoftEnv, type EnvValues } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import {
  fetchAndConsumeWithTimeout,
  fetchWithTimeout,
} from '@/lib/http/fetch-with-timeout';

const logger = createLogger();

export type RefreshAccessTokenErrorKind =
  | 'validation'
  | 'config'
  | 'network'
  | 'token_endpoint';

export class RefreshAccessTokenError extends Error {
  readonly kind: RefreshAccessTokenErrorKind;
  readonly microsoftErrorCode?: string;
  readonly httpStatus?: number;

  constructor(
    kind: RefreshAccessTokenErrorKind,
    message: string,
    options?: { microsoftErrorCode?: string; httpStatus?: number },
  ) {
    super(message);
    this.name = 'RefreshAccessTokenError';
    this.kind = kind;
    this.microsoftErrorCode = options?.microsoftErrorCode;
    this.httpStatus = options?.httpStatus;
  }
}

export interface RefreshAccessTokenResult {
  tokenType: string;
  expiresIn: number;
  scope?: string;
  accessToken: string;
  refreshToken?: string;
}

export interface RefreshAccessTokenOptions {
  env?: EnvValues;
  fetchImpl?: typeof fetch;
  // TASK-080 — optional finite timeout for the token-endpoint request. Callers on
  // a scheduler-bound path (delta polling) pass this so a hung token request can
  // never wedge the cycle. Omitted ⇒ unchanged behaviour (no timeout) for the
  // email worker / OAuth / renewal callers that do not opt in. A timeout surfaces
  // as a `network` error, which classifies as transient (never reconnect).
  timeoutMs?: number;
  // TASK-093 — explicit opt-in (default OFF): when true, the SAME `timeoutMs`
  // becomes ONE absolute deadline covering the fetch AND the response-body read
  // (`response.json()`), with real cancellation of the body stream on expiry.
  // Passing `timeoutMs` alone NEVER changes body-read semantics — existing
  // headers-only callers (delta polling, reconciliation) are bit-for-bit
  // unchanged. Only the email worker enables this.
  deadlineCoversBodyRead?: boolean;
}

interface TokenEndpointSuccessPayload {
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
}

interface TokenEndpointErrorPayload {
  error?: unknown;
  error_description?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export async function refreshMicrosoftAccessToken(
  refreshToken: string,
  options: RefreshAccessTokenOptions = {},
): Promise<RefreshAccessTokenResult> {
  if (typeof refreshToken !== 'string' || refreshToken.trim().length === 0) {
    throw new RefreshAccessTokenError('validation', 'refresh token is required');
  }

  let clientId: string;
  let clientSecret: string;
  let tenantId: string;
  try {
    const env = requireMicrosoftEnv(options.env);
    clientId = env.clientId;
    clientSecret = env.clientSecret;
    tenantId = env.tenantId;
  } catch {
    throw new RefreshAccessTokenError(
      'config',
      'Microsoft OAuth is not configured',
    );
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const encodedTenant = encodeURIComponent(tenantId);
  const tokenUrl = `https://login.microsoftonline.com/${encodedTenant}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });

  const requestInit: RequestInit = {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      accept: 'application/json',
    },
    body: body.toString(),
  };

  let response: Response;
  let payload: unknown = null;
  try {
    if (options.deadlineCoversBodyRead === true) {
      // TASK-093 opt-in — ONE absolute deadline (`timeoutMs`, unchanged value)
      // covers fetch + body read; the timer never resets at headers. The body
      // is still read for BOTH success and OAuth error responses (the error
      // payload carries the revoke code), exactly like the legacy path below.
      // A non-abort json failure keeps the legacy swallow (payload stays null ⇒
      // the token_endpoint branches below); only a deadline abort is rethrown
      // so the helper normalizes it to HttpTimeoutError ⇒ `network` here.
      ({ response, payload } = await fetchAndConsumeWithTimeout(
        fetchImpl,
        tokenUrl,
        requestInit,
        async (res, signal) => {
          let parsed: unknown = null;
          try {
            parsed = await res.json();
          } catch (bodyError) {
            if (signal?.aborted) throw bodyError;
            // Non-JSON body — treated as endpoint failure below (unchanged).
          }
          return { response: res, payload: parsed };
        },
        { timeoutMs: options.timeoutMs },
      ));
    } else {
      response = await fetchWithTimeout(fetchImpl, tokenUrl, requestInit, {
        timeoutMs: options.timeoutMs,
      });
    }
  } catch {
    // TASK-080 — a timeout (HttpTimeoutError) or any network failure is reported
    // as a `network` error, which `classifyRefreshTokenError` treats as transient
    // (never reconnect). The underlying request was truly aborted on timeout.
    // TASK-093 — with the body-deadline opt-in this same branch also covers a
    // deadline that fires while reading the success or error body: transient,
    // never reconnect, and always BEFORE any rotated-credential persistence.
    logger.error('Microsoft token endpoint network call failed (refresh grant)');
    throw new RefreshAccessTokenError('network', 'Microsoft token request failed');
  }

  if (options.deadlineCoversBodyRead !== true) {
    // Legacy body read (headers-only deadline callers + no-timeout callers):
    // outside any deadline window, exactly as before TASK-093.
    try {
      payload = await response.json();
    } catch {
      // Non-JSON body — treated as endpoint failure below.
    }
  }

  if (!response.ok) {
    const errPayload: TokenEndpointErrorPayload = isRecord(payload) ? payload : {};
    const microsoftErrorCode = readString(errPayload.error);
    logger.warn('Microsoft token endpoint rejected refresh', {
      httpStatus: response.status,
      microsoftErrorCode,
    });
    throw new RefreshAccessTokenError(
      'token_endpoint',
      'Microsoft token refresh failed',
      { microsoftErrorCode, httpStatus: response.status },
    );
  }

  if (!isRecord(payload)) {
    throw new RefreshAccessTokenError(
      'token_endpoint',
      'Microsoft token response was not JSON',
      { httpStatus: response.status },
    );
  }

  const success = payload as TokenEndpointSuccessPayload;
  const accessToken = readString(success.access_token);
  const tokenType = readString(success.token_type);
  const expiresIn =
    typeof success.expires_in === 'number' && Number.isFinite(success.expires_in)
      ? success.expires_in
      : undefined;

  if (!accessToken || !tokenType || expiresIn === undefined) {
    logger.warn('Microsoft refresh response missing required fields', {
      hasAccessToken: accessToken !== undefined,
      hasTokenType: tokenType !== undefined,
      hasExpiresIn: expiresIn !== undefined,
    });
    throw new RefreshAccessTokenError(
      'token_endpoint',
      'Microsoft token response missing required fields',
      { httpStatus: response.status },
    );
  }

  return {
    tokenType,
    expiresIn,
    accessToken,
    scope: readString(success.scope),
    refreshToken: readString(success.refresh_token),
  };
}
