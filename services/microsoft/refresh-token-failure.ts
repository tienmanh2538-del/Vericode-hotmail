// TASK-069C — Shared classification for Microsoft refresh-token exchange failures.
//
// Every worker that exchanges a stored refresh token (email worker, delta polling
// backup, subscription renewal) must answer the SAME question the same way:
//
//   "Did this refresh fail because the grant is genuinely gone (the human must
//    reconnect), or because of a transient blip (just retry next cycle)?"
//
// Marking a mailbox RECONNECT_REQUIRED on a transient network/429/5xx blip is a
// false positive: it stops the mailbox from relaying codes until a human
// reconnects, even though the very next cycle would have succeeded. This module
// is the single source of truth so the three workers can never drift apart.
//
// Security: this helper only reads an error's `kind` and the OAuth error CODE
// string (e.g. "invalid_grant"). It never touches token plaintext and never logs.

import { RefreshAccessTokenError } from './refresh-access-token.service';

/**
 * - `reconnect_required`: the refresh grant is revoked/expired or needs an
 *   interactive sign-in. Only a human re-consent fixes it → mark the mailbox.
 * - `transient`: network/timeout/429/5xx or an unknown error that may clear on
 *   its own → DO NOT change mailbox status; let the existing retry path run.
 * - `config`: Microsoft OAuth is not configured. Affects every mailbox equally,
 *   so it must NOT be blamed on (or mark) a single mailbox.
 */
export type RefreshTokenFailureKind = 'reconnect_required' | 'transient' | 'config';

/**
 * Microsoft OAuth error codes that mean the refresh grant can no longer mint
 * access tokens and the only remedy is a human reconnect. Kept intentionally
 * narrow — anything outside this set is treated as retryable.
 */
export const REVOKED_GRANT_ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid_grant',
  'interaction_required',
]);

/**
 * Classify an error thrown by `refreshMicrosoftAccessToken` (or a decrypt step).
 * The default for anything unrecognised is `transient` so a single odd error can
 * never brick a mailbox.
 */
export function classifyRefreshTokenError(error: unknown): RefreshTokenFailureKind {
  if (error instanceof RefreshAccessTokenError) {
    if (
      error.kind === 'token_endpoint' &&
      error.microsoftErrorCode !== undefined &&
      REVOKED_GRANT_ERROR_CODES.has(error.microsoftErrorCode)
    ) {
      return 'reconnect_required';
    }
    if (error.kind === 'config') {
      return 'config';
    }
    // network, token_endpoint without a revoke code (429/5xx/unknown), validation
    // → all retryable. The next worker cycle is the backstop.
    return 'transient';
  }
  // Unknown / unexpected error shape: assume transient rather than reconnect, so
  // a DB hiccup or programming error never flips a healthy mailbox to
  // RECONNECT_REQUIRED.
  return 'transient';
}

/**
 * A worker token-port error that carries a precomputed classification. The
 * consuming service duck-types this field via {@link shouldMarkReconnectRequired}
 * so it never has to import a concrete worker error class.
 */
export interface ClassifiedTokenError {
  classification: RefreshTokenFailureKind;
}

function hasClassification(error: unknown): error is ClassifiedTokenError {
  return (
    typeof error === 'object' &&
    error !== null &&
    'classification' in error &&
    typeof (error as { classification?: unknown }).classification === 'string'
  );
}

/**
 * Whether a token error thrown by a worker access-token port should flip the
 * mailbox to RECONNECT_REQUIRED. Only an explicit `reconnect_required`
 * classification qualifies; everything else (including an unclassified error) is
 * treated as transient so we never mark on a blip.
 */
export function shouldMarkReconnectRequired(error: unknown): boolean {
  return hasClassification(error) && error.classification === 'reconnect_required';
}
