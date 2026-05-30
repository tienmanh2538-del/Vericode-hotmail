-- TASK-040 preflight: persist audit log + code event log to the DB so the Web
-- UI (Next process) and the email worker (separate process) share one store.

-- 1) AuditLog: widen `action` from the AuditAction enum to TEXT and add the
--    severity / summary / actorEmail columns the service already produces.
ALTER TABLE "AuditLog" ALTER COLUMN "action" TYPE TEXT USING "action"::text;
ALTER TABLE "AuditLog" ADD COLUMN "actorEmail" TEXT;
ALTER TABLE "AuditLog" ADD COLUMN "severity" TEXT NOT NULL DEFAULT 'info';
ALTER TABLE "AuditLog" ADD COLUMN "summary" TEXT;

-- The AuditAction enum is no longer referenced by any column.
DROP TYPE "AuditAction";

-- 2) CodeEvent: new table. No raw verification code, email body, or secret is
--    ever stored here — only a masked/hashed code reference and safe metadata.
CREATE TABLE "CodeEvent" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedAt" TIMESTAMP(3),
    "mailboxEmail" TEXT NOT NULL,
    "customerName" TEXT,
    "platform" TEXT NOT NULL DEFAULT 'Facebook/Meta',
    "status" TEXT NOT NULL,
    "maskedCode" TEXT,
    "confidence" INTEGER,
    "telegramGroupName" TEXT,
    "source" TEXT NOT NULL DEFAULT 'mock',
    "message" TEXT,

    CONSTRAINT "CodeEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CodeEvent_createdAt_idx" ON "CodeEvent"("createdAt");
CREATE INDEX "CodeEvent_status_idx" ON "CodeEvent"("status");
CREATE INDEX "CodeEvent_mailboxEmail_idx" ON "CodeEvent"("mailboxEmail");
