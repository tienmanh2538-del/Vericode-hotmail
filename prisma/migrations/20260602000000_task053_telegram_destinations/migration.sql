-- TASK-053 — Reusable Telegram destinations.
--
-- Additive migration. Nothing is dropped or rewritten:
--   1. New "TelegramDestination" table (customer-scoped saved group/topic).
--   2. New nullable "TelegramMapping"."destinationId" link + FK + index.
--
-- Legacy mappings keep destinationId = NULL and continue routing from their own
-- snapshot columns, so this migration is safe to apply without any data backfill.
-- The destination "status" column reuses the existing "TelegramMappingStatus"
-- enum (ACTIVE/DISABLED) — no new enum is created.

-- CreateTable
CREATE TABLE "TelegramDestination" (
    "id" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "telegramGroupName" TEXT NOT NULL,
    "telegramTopicName" TEXT,
    "telegramChatId" TEXT NOT NULL,
    "telegramThreadId" TEXT,
    "status" "TelegramMappingStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramDestination_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TelegramDestination_customerId_idx" ON "TelegramDestination"("customerId");

-- CreateIndex
CREATE INDEX "TelegramDestination_status_idx" ON "TelegramDestination"("status");

-- AddForeignKey
ALTER TABLE "TelegramDestination" ADD CONSTRAINT "TelegramDestination_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramDestination" ADD CONSTRAINT "TelegramDestination_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "TelegramMapping" ADD COLUMN "destinationId" TEXT;

-- CreateIndex
CREATE INDEX "TelegramMapping_destinationId_idx" ON "TelegramMapping"("destinationId");

-- AddForeignKey
ALTER TABLE "TelegramMapping" ADD CONSTRAINT "TelegramMapping_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "TelegramDestination"("id") ON DELETE SET NULL ON UPDATE CASCADE;
