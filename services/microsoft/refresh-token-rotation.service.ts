// TASK-036 — Refresh token rotation persistence.
//
// Microsoft's OAuth token endpoint MAY return a brand-new `refresh_token` on a
// refresh-grant exchange (rolling refresh tokens). If we keep using the OLD
// refresh token after Microsoft rotated it, the next refresh fails with
// invalid_grant and the mailbox silently loses access until a human reconnects.
//
// This helper is the single, shared place that persists a rotated refresh
// token. It is consumed by every access-token port that exchanges a refresh
// token (subscription renewal, delta polling backup, email worker, and — via the
// renewal port — subscription reconciliation/recovery).
//
// Safety contract:
//   - When Microsoft returns NO new refresh token, we MUST keep the existing
//     encrypted token — never overwrite it with null/empty.
//   - A new refresh token is ALWAYS encrypted before it touches the database.
//   - Refresh tokens (old or new), plaintext or ciphertext, are NEVER logged.
//   - A CAS conflict (count === 0) is a controlled, non-fatal outcome: the new
//     credential is discarded and the caller keeps using this cycle's access
//     token (see TASK-085 below).
//   - A real DB/infrastructure error (updateMany THROWS) is NOT a CAS conflict:
//     it is not swallowed — it propagates as a sanitized thrown error so the
//     operation fails and is retried next cycle (never masked as a CAS loss,
//     never turned into an auth/reconnect outcome, never leaks ciphertext).
//
// TASK-085 — credential-generation ownership CAS. Multiple workers (+ human OAuth
// reconnect) can write `Mailbox.encryptedRefreshToken` concurrently. Without a
// guard, a stale/late rotation could last-writer-wins overwrite a newer
// credential (another worker's rotation, or a fresh OAuth reconnect) or write
// into a mailbox an operator just DISABLED. The write is therefore a conditional
// `updateMany` that only commits when the mailbox is NOT DISABLED and its stored
// credential still equals the exact generation this operation started from. The
// credential generation is an OPAQUE ciphertext marker — never decrypted or
// logged, only compared inside the WHERE clause.

import { prisma as defaultPrisma } from '@/lib/prisma';
import { encryptSecret as defaultEncryptSecret } from '@/lib/security/encryption';
import { createLogger, type Logger } from '@/lib/logger';

const MAILBOX_STATUS_DISABLED = 'DISABLED';

/** Minimal Prisma surface required to persist a rotated refresh token under CAS. */
export interface RotatedRefreshTokenClient {
  mailbox: {
    updateMany: (args: {
      where: Record<string, unknown>;
      data: Record<string, unknown>;
    }) => Promise<{ count: number }>;
  };
}

export interface PersistRotatedRefreshTokenDeps {
  prisma?: RotatedRefreshTokenClient;
  encryptSecret?: (plaintext: string) => string;
  logger?: Logger;
  now?: () => Date;
}

export interface PersistRotatedRefreshTokenResult {
  /** True when Microsoft returned a NEW refresh token this cycle (a rotation). */
  rotated: boolean;
  /**
   * True ONLY when the rotated credential was actually committed to the DB under
   * CAS (affected count === 1). False on no-rotation, encrypt failure, or CAS
   * loss. A real DB/infra error does NOT return a result — it throws (see below).
   */
  persisted: boolean;
  /**
   * True when a rotation WAS produced but the CAS matched no row (count === 0):
   * the stored generation changed (another worker / OAuth reconnect) or the
   * mailbox became DISABLED. The new credential is discarded. This is NOT an auth
   * failure and callers must not blind-retry or mark RECONNECT_REQUIRED for it.
   * A CAS conflict (count === 0) is the ONLY thing that sets this flag; a real
   * DB/infrastructure error is a DIFFERENT case — it propagates as a thrown error
   * and never returns a result, so `casLost` can never be confused with infra.
   */
  casLost?: boolean;
  // TASK-084 — the committed ciphertext, present ONLY when `persisted` is true.
  // OPAQUE marker (never logged/decrypted). Absent on CAS loss so downstream
  // ownership logic can never mistake a CAS-lost generation for the committed DB
  // generation (see TASK-084 Case B).
  encryptedRefreshToken?: string;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Persist a rotated Microsoft refresh token for a mailbox under a
 * credential-generation CAS (TASK-085).
 *
 * @param mailboxId          Mailbox primary key.
 * @param newRefreshToken    The `refresh_token` returned by Microsoft this cycle,
 *                           or undefined when Microsoft did not rotate it.
 * @param expectedGeneration The EXACT stored encrypted credential (opaque marker)
 *                           the operation read before refreshing (G0). The write
 *                           only commits when the DB still holds this generation
 *                           and the mailbox is not DISABLED.
 */
export async function persistRotatedRefreshToken(
  mailboxId: string,
  newRefreshToken: string | undefined,
  expectedGeneration: string | null,
  deps: PersistRotatedRefreshTokenDeps = {},
): Promise<PersistRotatedRefreshTokenResult> {
  // No rotation → keep the existing encrypted token untouched. This is the
  // critical safety branch: overwriting with null/empty would brick the mailbox.
  if (!isNonEmptyString(newRefreshToken)) {
    return { rotated: false, persisted: false };
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
    return { rotated: false, persisted: false };
  }

  let count: number;
  try {
    // TASK-085 CAS: commit ONLY when the mailbox is not DISABLED AND still holds
    // the exact generation this operation started from. A `null` expected
    // generation compiles to `IS NULL` (defensive — real callers always pass the
    // ciphertext they read). The credential value never leaves the WHERE clause.
    const res = await prisma.mailbox.updateMany({
      where: {
        id: mailboxId,
        status: { not: MAILBOX_STATUS_DISABLED },
        encryptedRefreshToken: expectedGeneration,
      },
      data: {
        encryptedRefreshToken,
        tokenLastRefreshedAt: now(),
      },
    });
    count = res.count;
  } catch {
    // Real DB / infrastructure error — this is NOT a CAS conflict (a CAS conflict
    // is `count === 0`, handled below). Per the locked architecture it must NOT be
    // swallowed, must NOT set `casLost`, and must NOT be turned into an auth /
    // reconnect_required outcome. We also must never let the raw Prisma error —
    // which could embed the ciphertext credential from `data` — escape into caller
    // logs. So: surface a masked warning, then PROPAGATE a sanitized error and let
    // the operation fail. Every caller classifies an unknown error as transient
    // (never reconnect_required), so the mailbox is simply retried next cycle.
    logger.warn('Failed to persist rotated refresh token', { mailboxId });
    throw new Error('failed to persist rotated refresh token');
  }

  if (count === 0) {
    // CAS lost: the stored generation changed (another worker rotated, or an
    // OAuth reconnect wrote a fresh credential) or the mailbox became DISABLED.
    // Discard the rotated credential — do NOT overwrite, retry, or flag reconnect.
    logger.info(
      'Rotated credential not persisted — generation changed or mailbox disabled',
      { mailboxId },
    );
    return { rotated: true, persisted: false, casLost: true };
  }

  // Intentionally NOT logging the token. Only the safe identifier.
  logger.info('Persisted rotated Microsoft refresh token', { mailboxId });
  return { rotated: true, persisted: true, encryptedRefreshToken };
}
