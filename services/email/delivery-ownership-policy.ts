// TASK-090 — delivery-ownership policy (leaf module).
//
// Single source of truth for the post-claim Telegram delivery recovery
// constants. Like `relay-freshness-policy.ts` this must stay a pure leaf:
// constants only — no I/O, no env reads, no imports of runtime services.
// Values are deliberately NOT env-tunable (same locked-decision style as the
// TASK-080 freshness window).
//
// How the values were chosen:
//
// DELIVERY_LEASE_MS (5 minutes)
//   The ownership lease must outlive one WORST-CASE normal delivery attempt so
//   a live owner is never overtaken mid-attempt. Every term of that worst case
//   now has a CODE-LEVEL bound (no reliance on runtime/socket defaults):
//
//     HTTP:     4 attempts × TELEGRAM_HTTP_TIMEOUT_MS (15s)  =  60s
//               (explicit AbortController timeout in telegram-sender.service.ts)
//     backoff:  3 waits × DEFAULT_MAX_RETRY_AFTER_MS (60s)   = 180s (429 worst)
//     pacing:   destination throttle cap 15s + global pacer cap 2s = 17s
//     overhead: DB CAS/lookup writes — millisecond-scale
//     ----------------------------------------------------------------
//     maximum normal ownership duration ≈ 257s < 300s lease
//     safety margin ≈ 43s (~14%), pinned by a deterministic test against the
//     REAL constants (telegram-sender.timeout.test.ts).
//
//   The lease also stays far below the 30-minute TASK-080 freshness bound so a
//   message recovered after an owner crash can still be relayed fresh. It
//   deliberately does NOT reuse the 30m stale window or any Graph-subscription
//   claim window — those have different semantics.
//
// MAX_DELIVERY_ATTEMPTS (3)
//   Delivery-ownership claims consumed per ProcessedMessage row, across ALL
//   jobs/processes (persisted in `deliveryAttempts`). Aligned with the BullMQ
//   job `attempts: 3` (services/queue/email-job-options.ts) so the total
//   external budget stays exactly the pre-approved bound: 3 ownership claims ×
//   up to 4 internal Telegram sends (TASK-033) = at most 12 Telegram HTTP
//   calls for a persistently retryable failure. This is a DB-level cap, not a
//   third retry loop — no new retry driver exists.
//
// DELIVERY_OWNERSHIP_POLL_MS (5 seconds)
//   While another owner's lease is active, a would-be claimant re-reads the row
//   every poll tick (bounded overall by the lease length) so it can stop
//   immediately when the owner finishes (SENT/FAILED) instead of sleeping the
//   whole lease blindly.

export const DELIVERY_LEASE_MS = 5 * 60_000;
export const MAX_DELIVERY_ATTEMPTS = 3;
export const DELIVERY_OWNERSHIP_POLL_MS = 5_000;
