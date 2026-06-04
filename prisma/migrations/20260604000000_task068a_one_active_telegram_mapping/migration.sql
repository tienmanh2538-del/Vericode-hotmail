-- TASK-068A — Enforce "at most one ACTIVE Telegram mapping per mailbox" at the
-- database level (defence in depth for finding M2 / the one-active TOCTOU race).
--
-- Why this is needed:
--   The service-layer guard (assertNoConflictForDestination) is a check-then-write
--   pre-check. Under two near-simultaneous create/update requests for the same
--   mailbox, both can read "no ACTIVE mapping yet" before either row is written,
--   and both inserts succeed — leaving a mailbox with two ACTIVE mappings. A
--   PARTIAL unique index makes the database the single serialisation point: the
--   second writer fails with a unique-constraint violation (P2002), which the
--   service translates into a friendly 409 conflict.
--
-- Why a raw migration (not the Prisma schema):
--   Prisma's schema language cannot express a partial (filtered / WHERE) unique
--   index, so this index is defined here in raw SQL. It is intentionally absent
--   from schema.prisma (see the note on TelegramMapping.@@unique there).
--
-- Why it is safe:
--   * PARTIAL — it only constrains rows WHERE status = 'ACTIVE'. DISABLED mappings
--     are unconstrained, so a mailbox may keep many DISABLED mappings and the
--     "many mailboxes share one reusable destination" rule (TASK-041/TASK-053) is
--     untouched (the index is on mailboxId, not on the chat id).
--   * IF NOT EXISTS — re-running the migration is a no-op.
--   * Additive — nothing is dropped, rewritten, or backfilled. The service layer
--     has always enforced one-active-per-mailbox, so existing data should already
--     satisfy the constraint; if a legacy duplicate exists, index creation will
--     fail loudly during `migrate deploy` and must be reconciled operationally
--     rather than silently ignored.

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "TelegramMapping_mailboxId_active_unique"
  ON "TelegramMapping" ("mailboxId")
  WHERE "status" = 'ACTIVE';
