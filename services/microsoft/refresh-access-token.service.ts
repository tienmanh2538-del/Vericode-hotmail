import { requireMicrosoftEnv, type EnvValues } from '@/lib/env';
import { createLogger } from '@/lib/logger';

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

  let response: Response;
  try {
    response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch {
    logger.error('Microsoft token endpoint network call failed (refresh grant)');
    throw new RefreshAccessTokenError('network', 'Microsoft token request failed');
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    // Non-JSON body — treated as endpoint failure below.
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
