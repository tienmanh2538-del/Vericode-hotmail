-- TASK-041 — Flexible Telegram routing: many mailboxes → one group/topic.
--
-- Adds optional Telegram forum-topic routing columns. Both are nullable so
-- existing plain-group mappings are untouched. There is deliberately NO unique
-- constraint added on telegramChatId or (telegramChatId, telegramThreadId):
-- multiple mailboxes are allowed to share the same destination. The existing
-- UNIQUE (mailboxId, telegramChatId) is kept unchanged — it only stops one
-- mailbox from holding duplicate rows to the same chat.

-- AlterTable
ALTER TABLE "TelegramMapping" ADD COLUMN "telegramThreadId" TEXT;
ALTER TABLE "TelegramMapping" ADD COLUMN "telegramTopicName" TEXT;

-- CreateIndex
CREATE INDEX "TelegramMapping_telegramChatId_idx" ON "TelegramMapping"("telegramChatId");
