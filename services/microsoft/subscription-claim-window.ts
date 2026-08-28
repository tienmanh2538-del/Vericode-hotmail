// TASK-084 / TASK-086 — the single shared definition of the renewal claim
// staleness window.
//
// TASK-084 introduced the atomic renewal claim: a worker flips a
// GraphSubscription row to RENEWING and stamps its own `updatedAt` as the claim
// generation. A claim older than this window is considered abandoned (the
// claimant died or stalled) and may be reclaimed.
//
// TASK-086 needs the SAME window when it normalises time-expired rows before
// provisioning: a FRESH RENEWING claim must never be stolen, while a STALE one
// may be transitioned to EXPIRED. Duplicating the constant would let the two
// meanings drift apart, so it lives here — a leaf module with no imports — and
// both the renewal runner and the provisioning seam consume it.
//
// It is intentionally a code-level constant (never an env variable), exactly as
// TASK-084 locked it.

/** How long a RENEWING claim stays "fresh" before it may be reclaimed. */
export const STALE_CLAIM_CUTOFF_MS = 30 * 60 * 1000;

/**
 * The instant before which a claim generation counts as stale. A row whose
 * `updatedAt` is strictly older than this may be reclaimed / normalised; a row
 * at or after it is a fresh claim and must be left alone.
 */
export function computeStaleClaimCutoff(now: Date): Date {
  return new Date(now.getTime() - STALE_CLAIM_CUTOFF_MS);
}
