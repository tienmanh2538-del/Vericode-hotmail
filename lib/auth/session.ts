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

/**
 * Resolve the current admin user for the active runtime, or null when no
 * trusted session is present.
 *
 * TASK-057 — production hardening. The resolution is an explicit per-environment
 * switch so the dev/staging convenience logins can NEVER be reached outside the
 * environment they belong to:
 *   - development: the dev-only demo user, and only when AUTH_DEV_DEMO_USER is on.
 *   - staging: a signed, time-bounded staging session cookie (HMAC verified).
 *   - production / test / anything else: FAIL CLOSED — always null. There is no
 *     real production auth provider yet (that lands in a later task), so the
 *     correct behaviour is to deny admin access rather than fall back to the dev
 *     demo user or the staging passphrase. The role/userId is therefore never
 *     taken from the request body, query, or an unverified cookie.
 */
export async function getCurrentUser(
  source: Record<string, string | undefined> = process.env,
  options: GetCurrentUserOptions = {},
): Promise<AuthUser | null> {
  const { values } = loadEnv(source);

  switch (values.APP_ENV) {
    case 'development':
      return isTruthyFlag(values.AUTH_DEV_DEMO_USER) ? DEMO_USER : null;

    case 'staging': {
      const token =
        options.stagingSessionToken !== undefined
          ? options.stagingSessionToken
          : await readStagingSessionCookie();
      return verifyStagingSessionToken(token, values);
    }

    // Production is intentionally listed alongside the fail-closed default so the
    // denial is explicit, not an accident of falling through.
    case 'production':
    case 'test':
    default:
      return null;
  }
}
