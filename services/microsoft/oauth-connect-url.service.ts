import { randomBytes } from 'node:crypto';
import { requireMicrosoftEnv, type EnvValues } from '@/lib/env';

export const MICROSOFT_OAUTH_SCOPES = [
  'Mail.Read',
  'offline_access',
  'User.Read',
] as const;

export const MICROSOFT_OAUTH_STATE_BYTES = 32;
export const MICROSOFT_OAUTH_STATE_COOKIE = 'ms_oauth_state';
export const MICROSOFT_OAUTH_STATE_TTL_SECONDS = 600;

export type MicrosoftOAuthErrorKind = 'config';

export class MicrosoftOAuthConfigError extends Error {
  readonly kind: MicrosoftOAuthErrorKind;

  constructor(message: string) {
    super(message);
    this.name = 'MicrosoftOAuthConfigError';
    this.kind = 'config';
  }
}

export interface BuildConnectUrlOptions {
  state?: string;
  env?: EnvValues;
}

export interface ConnectUrlResult {
  url: string;
  state: string;
}

export function generateOAuthState(byteLength = MICROSOFT_OAUTH_STATE_BYTES): string {
  if (!Number.isInteger(byteLength) || byteLength < 16) {
    throw new Error('byteLength must be an integer >= 16');
  }
  return randomBytes(byteLength).toString('base64url');
}

export function buildMicrosoftConnectUrl(
  options: BuildConnectUrlOptions = {},
): ConnectUrlResult {
  let clientId: string;
  let tenantId: string;
  let redirectUri: string;
  try {
    const env = requireMicrosoftEnv(options.env);
    clientId = env.clientId;
    tenantId = env.tenantId;
    redirectUri = env.redirectUri;
  } catch {
    throw new MicrosoftOAuthConfigError('Microsoft OAuth is not configured');
  }

  const state =
    typeof options.state === 'string' && options.state.length > 0
      ? options.state
      : generateOAuthState();

  const encodedTenant = encodeURIComponent(tenantId);
  const base = `https://login.microsoftonline.com/${encodedTenant}/oauth2/v2.0/authorize`;

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: MICROSOFT_OAUTH_SCOPES.join(' '),
    state,
    prompt: 'select_account',
  });

  return {
    url: `${base}?${params.toString()}`,
    state,
  };
}
