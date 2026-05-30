import { loadEnv } from '../env';
import type { Role } from './roles';
import {
  STAGING_SESSION_COOKIE,
  verifyStagingSessionToken,
} from './staging-session';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}

const DEMO_USER: AuthUser = {
  id: 'dev-demo-user',
  email: 'demo@local.test',
  role: 'OWNER',
};

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  return value.trim().toLowerCase() === 'true';
}

/**
 * Read the staging session cookie from the active request. Lazily imports
 * `next/headers` so this module stays usable outside a Next request scope
 * (tests pass the token explicitly instead). Never throws — returns null when
 * cookies are unavailable.
 */
async function readStagingSessionCookie(): Promise<string | null> {
  try {
    const { cookies } = await import('next/headers');
    return cookies().get(STAGING_SESSION_COOKIE)?.value ?? null;
  } catch {
    return null;
  }
}

export interface GetCurrentUserOptions {
  /**
   * Inject the staging session token directly (tests / callers that already
   * hold the cookie value). When omitted on a staging request, the token is
   * read from the request cookies.
   */
  stagingSessionToken?: string | null;
}

export async function getCurrentUser(
  source: Record<string, string | undefined> = process.env,
  options: GetCurrentUserOptions = {},
): Promise<AuthUser | null> {
  const { values } = loadEnv(source);

  if (values.APP_ENV === 'development' && isTruthyFlag(values.AUTH_DEV_DEMO_USER)) {
    return DEMO_USER;
  }

  if (values.APP_ENV === 'staging') {
    const token =
      options.stagingSessionToken !== undefined
        ? options.stagingSessionToken
        : await readStagingSessionCookie();
    return verifyStagingSessionToken(token, values);
  }

  return null;
}
