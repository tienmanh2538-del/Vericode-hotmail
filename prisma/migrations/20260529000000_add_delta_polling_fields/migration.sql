-- TASK-031: backup delta polling worker.
-- Adds per-mailbox cursor + last-poll-error tracking. All columns are nullable
-- so existing mailboxes keep working before the polling worker runs.

ALTER TABLE "Mailbox" ADD COLUMN "microsoftDeltaCursor" TEXT;
ALTER TABLE "Mailbox" ADD COLUMN "deltaLastPolledAt" TIMESTAMP(3);
ALTER TABLE "Mailbox" ADD COLUMN "deltaLastErrorAt" TIMESTAMP(3);
ALTER TABLE "Mailbox" ADD COLUMN "deltaLastErrorMessage" TEXT;
