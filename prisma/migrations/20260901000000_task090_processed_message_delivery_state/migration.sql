-- TASK-090 — Post-claim Telegram delivery failure recovery & delivery state
-- safety.
--
-- Adds the minimal delivery-ownership state to ProcessedMessage so a claimed
-- message whose Telegram delivery did not finish (send failure or crash after
-- the identity claim) can be recovered by a later worker attempt instead of
-- being terminally skipped as a duplicate (pre-existing at-most-once-after-
-- claim loss window, TASK-089 DF-1 / TASK-090 S1+S2).
--
--   deliveryAttempts      — delivery-ownership claims consumed (bounded in code).
--   deliveryLeaseUntil    — ownership lease expiry; NULL = unowned.
--   deliveryOwner         — opaque claim-generation token; completion writes
--                           (SENT/FAILED) are conditional on it (CAS fencing).
--   deliveryFailureReason — sanitized terminal-failure category only. Never a
--                           verification code, token, chat id, or email content.
--
-- Purely additive: no data is deleted or rewritten, the existing
-- @@unique(mailboxId, graphMessageId) identity invariant is untouched, and no
-- secret-bearing value is backfilled.
--
-- Historical-row semantics: existing DETECTED rows get attempts=0 / NULL lease /
-- NULL owner, which makes them technically claimable — but every delivery path
-- re-checks the TASK-080 freshness policy (30 minutes against the Microsoft
-- Graph receivedDateTime) immediately before any Telegram send, so old rows can
-- only ever be terminally marked, never re-delivered. Historical SENT rows stay
-- terminal SENT; historical FAILED rows (none are expected to exist) stay
-- terminal FAILED.

ALTER TABLE "ProcessedMessage"
  ADD COLUMN "deliveryAttempts" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deliveryLeaseUntil" TIMESTAMP(3),
  ADD COLUMN "deliveryOwner" TEXT,
  ADD COLUMN "deliveryFailureReason" TEXT;
