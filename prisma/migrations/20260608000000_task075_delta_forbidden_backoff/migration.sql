-- TASK-075: persistent delta 403 (forbidden) backoff/alert.
-- Adds per-mailbox persistent-403 backoff state so a repeated account/endpoint
-- -level Graph 403 is throttled (cooldown) instead of retried full-speed every
-- cycle, and survives a worker restart. Both columns are safe-by-default:
--   - deltaForbiddenCount defaults to 0 (no backoff for existing mailboxes).
--   - deltaForbiddenCooldownUntil is nullable (no cooldown until a 403 streak).
-- Neither column ever changes mailbox auth/status — a 403 is not a dead grant.

ALTER TABLE "Mailbox" ADD COLUMN "deltaForbiddenCount" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "Mailbox" ADD COLUMN "deltaForbiddenCooldownUntil" TIMESTAMP(3);
