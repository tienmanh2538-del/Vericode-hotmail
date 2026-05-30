// TASK-040 preflight — staging-only admin session.
//
// Staging runs on a public HTTPS domain, so admin access cannot be a silent
// env bypass (that would expose /admin to anyone with the URL). Instead the
// /login form accepts a shared passphrase (STAGING_ADMIN_PASSWORD) and we mint
// a signed, httpOnly session cookie. This module owns ONLY the crypto:
//   - constant-time passphrase comparison,
//   - HMAC-SHA256 signing/verification of the session token.
//
// SECURITY:
//   - The passphrase, the HMAC secret, and the raw token are NEVER logged.
//   - Tokens are signed (tamper-evident) and time-bounded (expiry baked in).
//   - Fail-closed: if no passphrase or no signing secret is configured, both
//     `verifyStagingPassword` and `verifyStagingSessionToken` return false.
//   - This is intentionally NOT production auth — it is a staging gate only.

import { createHmac, timingSafeEqual } from 'node:crypto';

import type { EnvValues } from '../env';
import type { AuthUser } from './session';

const TOKEN_VERSION = 'v1';
const SESSION_ROLE = 'OWNER' as const;
/** Staging session lifetime: 12 hours. */
export const STAGING_SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** The admin identity granted by a valid staging session. */
export const STAGING_ADMIN_USER: AuthUser = {
  id: 'staging-admin',
  email: 'staging-admin@local.staging',
  role: SESSION_ROLE,
};

function toBuffer(value: string): Buffer {
  return Buffer.from(value, 'utf8');
}

/**
 * Constant-time string comparison that does not leak length via early return.
 * Both sides are hashed to a fixed width first so unequal lengths still take
 * the same code path.
 */
export function constantTimeEquals(a: string, b: string): boolean {
  const ha = createHmac('sha256', 'cmp').update(toBuffer(a)).digest();
  const hb = createHmac('sha256', 'cmp').update(toBuffer(b)).digest();
  return timingSafeEqual(ha, hb);
}

/** Resolve the HMAC signing secret. Prefers a dedicated secret, else the
 * encryption key. Returns null when neither is configured (fail-closed). */
function resolveSigningSecret(values: EnvValues): string | null {
  const dedicated = values.STAGING_ADMIN_SESSION_SECRET;
  if (typeof dedicated === 'string' && dedicated.length > 0) return dedicated;
  const encryptionKey = values.ENCRYPTION_KEY;
  if (typeof encryptionKey === 'string' && encryptionKey.length > 0) {
    return encryptionKey;
  }
  return null;
}

/** True only when staging admin login is fully configured: the env declares a
 * non-empty passphrase AND a signing secret is available. */
export function isStagingAdminConfigured(values: EnvValues): boolean {
  const password = values.STAGING_ADMIN_PASSWORD;
  return (
    typeof password === 'string' &&
    password.length > 0 &&
    resolveSigningSecret(values) !== null
  );
}

/**
 * Verify a submitted passphrase against STAGING_ADMIN_PASSWORD in constant
 * time. Fail-closed when staging admin is not configured.
 */
export function verifyStagingPassword(
  submitted: string,
  values: EnvValues,
): boolean {
  if (!isStagingAdminConfigured(values)) return false;
  if (typeof submitted !== 'string' || submitted.length === 0) return false;
  return constantTimeEquals(submitted, values.STAGING_ADMIN_PASSWORD as string);
}

function sign(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload).digest('base64url');
}

/**
 * Create a signed session token: `v1.<role>.<expiryEpochMs>.<sig>`.
 * Returns null when no signing secret is configured.
 */
export function createStagingSessionToken(
  values: EnvValues,
  nowMs: number = Date.now(),
): string | null {
  const secret = resolveSigningSecret(values);
  if (secret === null) return null;
  const expiry = nowMs + STAGING_SESSION_TTL_MS;
  const payload = `${TOKEN_VERSION}.${SESSION_ROLE}.${expiry}`;
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Verify a session token's signature and expiry. Returns the admin user on
 * success, or null on any failure (bad shape, bad signature, expired,
 * unconfigured). No part of the token is logged by callers.
 */
export function verifyStagingSessionToken(
  token: string | undefined | null,
  values: EnvValues,
  nowMs: number = Date.now(),
): AuthUser | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  const secret = resolveSigningSecret(values);
  if (secret === null) return null;

  const lastDot = token.lastIndexOf('.');
  if (lastDot <= 0) return null;
  const payload = token.slice(0, lastDot);
  const providedSig = token.slice(lastDot + 1);

  const parts = payload.split('.');
  if (parts.length !== 3) return null;
  const [version, role, expiryRaw] = parts;
  if (version !== TOKEN_VERSION || role !== SESSION_ROLE) return null;

  const expiry = Number.parseInt(expiryRaw, 10);
  if (!Number.isFinite(expiry) || expiry <= nowMs) return null;

  const expectedSig = sign(payload, secret);
  // timingSafeEqual throws on length mismatch; guard first.
  if (providedSig.length !== expectedSig.length) return null;
  if (!timingSafeEqual(toBuffer(providedSig), toBuffer(expectedSig))) {
    return null;
  }

  return STAGING_ADMIN_USER;
}

/** Cookie name for the staging admin session. */
export const STAGING_SESSION_COOKIE = 'staging_admin_session';
