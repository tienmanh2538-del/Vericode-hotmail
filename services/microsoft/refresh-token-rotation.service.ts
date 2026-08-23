// TASK-036 — Refresh token rotation persistence.
//
// Microsoft's OAuth token endpoint MAY return a brand-new `refresh_token` on a
// refresh-grant exchange (rolling refresh tokens). If we keep using the OLD
// refresh token after Microsoft rotated it, the next refresh fails with
// invalid_grant and the mailbox silently loses access until a human reconnects.
//
// This helper is the single, shared place that persists a rotated refresh
// token. It is consumed by every access-token port that exchanges a refresh
// token (delta polling backup worker, subscription renewal worker).
//
// Safety contract:
//   - When Microsoft returns NO new refresh token, we MUST keep the existing
//     encrypted token — never overwrite it with null/empty.
//   - A new refresh token is ALWAYS encrypted before it touches the database.
//   - Refresh tokens (old or new), plaintext or ciphertext, are NEVER logged.
//   - Persistence failure is non-fatal: the access token obtained this cycle is
//     still valid, so we log a masked warning and let the next cycle retry.

import { prisma as defaultPrisma } from '@/lib/prisma';
import { encryptSecret as defaultEncryptSecret } from '@/lib/security/encryption';
import { createLogger, type Logger } from '@/lib/logger';

/** Minimal Prisma surface required to persist a rotated refresh token. */
export interface RotatedRefreshTokenClient {
  mailbox: {
    update: (args: {
      where: { id: string };
      data: Record<string, unknown>;
    }) => Promise<unknown>;
  };
}

export interface PersistRotatedRefreshTokenDeps {
  prisma?: RotatedRefreshTokenClient;
  encryptSecret?: (plaintext: string) => string;
  logger?: Logger;
  now?: () => Date;
}

export interface PersistRotatedRefreshTokenResult {
  /** True only when a new token was encrypted AND written to the database. */
  rotated: boolean;
  // TASK-084 — when a rotation was persisted, the exact ciphertext that was
  // written. Callers that need to capture the mailbox's post-rotation credential
  // generation (the subscription renewal worker's reconnect-required guard) read
  // this instead of issuing a follow-up query. It is an OPAQUE marker only — it
  // is never logged, printed, or decrypted. Undefined when nothing was rotated.
  encryptedRefreshToken?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Persist a rotated Microsoft refresh token for a mailbox.
 *
 * @param mailboxId        Mailbox primary key.
 * @param newRefreshToken  The `refresh_token` returned by Microsoft this cycle,
 *                         or undefined when Microsoft did not rotate it.
 */
export async function persistRotatedRefreshToken(
  mailboxId: string,
  newRefreshToken: string | undefined,
  deps: PersistRotatedRefreshTokenDeps = {},
): Promise<PersistRotatedRefreshTokenResult> {
  // No rotation → keep the existing encrypted token untouched. This is the
  // critical safety branch: overwriting with null/empty would brick the mailbox.
  if (!isNonEmptyString(newRefreshToken)) {
    return { rotated: false };
  }

  const logger = deps.logger ?? createLogger();
  const prisma =
    deps.prisma ?? (defaultPrisma as unknown as RotatedRefreshTokenClient);
  const encryptSecret = deps.encryptSecret ?? defaultEncryptSecret;
  const now = deps.now ?? (() => new Date());

  let encryptedRefreshToken: string;
  try {
    encryptedRefreshToken = encryptSecret(newRefreshToken.trim());
  } catch {
    // Never include the token or the underlying error message — both could leak
    // secret material into logs.
    logger.warn('Failed to encrypt rotated refresh token', { mailboxId });
    return { rotated: false };
  }

  try {
    await prisma.mailbox.update({
      where: { id: mailboxId },
      data: {
        encryptedRefreshToken,
        tokenLastRefreshedAt: now(),
      },
    });
  } catch {
    // Non-fatal: the access token this cycle is still usable. Surface a masked
    // warning so ops can see rotation persistence is failing.
    logger.warn('Failed to persist rotated refresh token', { mailboxId });
    return { rotated: false };
  }

  // Intentionally NOT logging the token. Only the safe identifier.
  logger.info('Persisted rotated Microsoft refresh token', { mailboxId });
  return { rotated: true, encryptedRefreshToken };
}
