import { requireMicrosoftEnv, type EnvValues } from '@/lib/env';
import { createLogger } from '@/lib/logger';

const logger = createLogger();

export type MicrosoftOAuthTokenExchangeErrorKind =
  | 'validation'
  | 'config'
  | 'network'
  | 'token_endpoint';

export class MicrosoftOAuthTokenExchangeError extends Error {
  readonly kind: MicrosoftOAuthTokenExchangeErrorKind;
  readonly microsoftErrorCode?: string;
  readonly httpStatus?: number;

  constructor(
    kind: MicrosoftOAuthTokenExchangeErrorKind,
    message: string,
    options?: { microsoftErrorCode?: string; httpStatus?: number },
  ) {
    super(message);
    this.name = 'MicrosoftOAuthTokenExchangeError';
    this.kind = kind;
    this.microsoftErrorCode = options?.microsoftErrorCode;
    this.httpStatus = options?.httpStatus;
  }
}

export interface ExchangeAuthorizationCodeInput {
  code: string;
  redirectUri?: string;
}

export interface MicrosoftOAuthTokenResult {
  tokenType: string;
  expiresIn: number;
  scope?: string;
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
}

export interface ExchangeAuthorizationCodeOptions {
  env?: EnvValues;
}

interface TokenEndpointSuccessPayload {
  token_type?: unknown;
  expires_in?: unknown;
  scope?: unknown;
  access_token?: unknown;
  refresh_token?: unknown;
  id_token?: unknown;
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

export async function exchangeAuthorizationCodeForTokens(
  input: ExchangeAuthorizationCodeInput,
  options: ExchangeAuthorizationCodeOptions = {},
): Promise<MicrosoftOAuthTokenResult> {
  if (typeof input.code !== 'string') {
    throw new MicrosoftOAuthTokenExchangeError(
      'validation',
      'authorization code is required',
    );
  }
  const code = input.code.trim();
  if (code.length === 0) {
    throw new MicrosoftOAuthTokenExchangeError(
      'validation',
      'authorization code is required',
    );
  }

  let clientId: string;
  let clientSecret: string;
  let tenantId: string;
  let redirectUri: string;
  try {
    const env = requireMicrosoftEnv(options.env);
    clientId = env.clientId;
    clientSecret = env.clientSecret;
    tenantId = env.tenantId;
    redirectUri = input.redirectUri ?? env.redirectUri;
  } catch {
    throw new MicrosoftOAuthTokenExchangeError(
      'config',
      'Microsoft OAuth is not configured',
    );
  }

  const encodedTenant = encodeURIComponent(tenantId);
  const tokenUrl = `https://login.microsoftonline.com/${encodedTenant}/oauth2/v2.0/token`;

  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code,
    redirect_uri: redirectUri,
    grant_type: 'authorization_code',
  });

  let response: Response;
  try {
    response = await fetch(tokenUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        accept: 'application/json',
      },
      body: body.toString(),
    });
  } catch {
    logger.error('Microsoft token endpoint network call failed');
    throw new MicrosoftOAuthTokenExchangeError(
      'network',
      'Microsoft token request failed',
    );
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
    logger.warn('Microsoft token endpoint rejected exchange', {
      httpStatus: response.status,
      microsoftErrorCode,
    });
    throw new MicrosoftOAuthTokenExchangeError(
      'token_endpoint',
      'Microsoft token exchange failed',
      { microsoftErrorCode, httpStatus: response.status },
    );
  }

  if (!isRecord(payload)) {
    logger.warn('Microsoft token endpoint returned non-JSON success body');
    throw new MicrosoftOAuthTokenExchangeError(
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
    logger.warn('Microsoft token response missing required fields', {
      hasAccessToken: accessToken !== undefined,
      hasTokenType: tokenType !== undefined,
      hasExpiresIn: expiresIn !== undefined,
    });
    throw new MicrosoftOAuthTokenExchangeError(
      'token_endpoint',
      'Microsoft token response missing required fields',
      { httpStatus: response.status },
    );
  }

  const result: MicrosoftOAuthTokenResult = {
    tokenType,
    expiresIn,
    accessToken,
    scope: readString(success.scope),
    refreshToken: readString(success.refresh_token),
    idToken: readString(success.id_token),
  };

  logger.info('Microsoft token exchange succeeded', {
    tokenType: result.tokenType,
    expiresIn: result.expiresIn,
    scope: result.scope,
    hasRefreshToken: result.refreshToken !== undefined,
    hasIdToken: result.idToken !== undefined,
  });

  return result;
}
