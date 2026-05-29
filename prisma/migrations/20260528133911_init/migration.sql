-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'STAFF_READ_ONLY');

-- CreateEnum
CREATE TYPE "CustomerStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "MailboxProvider" AS ENUM ('MICROSOFT', 'MOCK');

-- CreateEnum
CREATE TYPE "MailboxStatus" AS ENUM ('ACTIVE', 'RECONNECT_REQUIRED', 'SUBSCRIPTION_EXPIRED', 'WEBHOOK_FAILED', 'DISABLED', 'ERROR');

-- CreateEnum
CREATE TYPE "TelegramMappingStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "GraphSubscriptionStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'FAILED', 'RENEWING');

-- CreateEnum
CREATE TYPE "ProcessedMessageStatus" AS ENUM ('DETECTED', 'SENT', 'FAILED', 'SKIPPED_LOW_CONFIDENCE', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "AuditAction" AS ENUM ('MAILBOX_CONNECTED', 'MAILBOX_DISCONNECTED', 'TELEGRAM_MAPPING_CREATED', 'TELEGRAM_MAPPING_UPDATED', 'CODE_DETECTED', 'CODE_SENT', 'CODE_SKIPPED_LOW_CONFIDENCE', 'SUBSCRIPTION_RENEWED', 'TOKEN_REFRESH_FAILED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "role" "UserRole" NOT NULL DEFAULT 'STAFF_READ_ONLY',
    "passwordHash" TEXT,
    "authProvider" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "CustomerStatus" NOT NULL DEFAULT 'ACTIVE',
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Mailbox" (
    "id" TEXT NOT NULL,
    "emailAddress" TEXT NOT NULL,
    "provider" "MailboxProvider" NOT NULL,
    "ownerCustomerName" TEXT,
    "customerId" TEXT,
    "status" "MailboxStatus" NOT NULL DEFAULT 'ACTIVE',
    "microsoftUserId" TEXT,
    "encryptedRefreshToken" TEXT,
    "tokenLastRefreshedAt" TIMESTAMP(3),
    "lastSuccessfulSyncAt" TIMESTAMP(3),
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Mailbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramMapping" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "telegramChatId" TEXT NOT NULL,
    "telegramGroupName" TEXT,
    "status" "TelegramMappingStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GraphSubscription" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "resource" TEXT NOT NULL,
    "clientStateHash" TEXT NOT NULL,
    "expirationDateTime" TIMESTAMP(3) NOT NULL,
    "status" "GraphSubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastRenewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GraphSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedMessage" (
    "id" TEXT NOT NULL,
    "mailboxId" TEXT NOT NULL,
    "graphMessageId" TEXT NOT NULL,
    "internetMessageId" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "senderEmail" TEXT NOT NULL,
    "subjectHash" TEXT,
    "codeHash" TEXT,
    "status" "ProcessedMessageStatus" NOT NULL DEFAULT 'DETECTED',
    "sentToTelegramAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "actorUserId" TEXT,
    "action" "AuditAction" NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "metadataJson" JSONB,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Mailbox_emailAddress_key" ON "Mailbox"("emailAddress");

-- CreateIndex
CREATE INDEX "Mailbox_customerId_idx" ON "Mailbox"("customerId");

-- CreateIndex
CREATE INDEX "Mailbox_status_idx" ON "Mailbox"("status");

-- CreateIndex
CREATE INDEX "TelegramMapping_status_idx" ON "TelegramMapping"("status");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramMapping_mailboxId_telegramChatId_key" ON "TelegramMapping"("mailboxId", "telegramChatId");

-- CreateIndex
CREATE UNIQUE INDEX "GraphSubscription_subscriptionId_key" ON "GraphSubscription"("subscriptionId");

-- CreateIndex
CREATE INDEX "GraphSubscription_mailboxId_idx" ON "GraphSubscription"("mailboxId");

-- CreateIndex
CREATE INDEX "GraphSubscription_status_idx" ON "GraphSubscription"("status");

-- CreateIndex
CREATE INDEX "ProcessedMessage_receivedAt_idx" ON "ProcessedMessage"("receivedAt");

-- CreateIndex
CREATE INDEX "ProcessedMessage_status_idx" ON "ProcessedMessage"("status");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessedMessage_mailboxId_graphMessageId_key" ON "ProcessedMessage"("mailboxId", "graphMessageId");

-- CreateIndex
CREATE INDEX "AuditLog_action_idx" ON "AuditLog"("action");

-- CreateIndex
CREATE INDEX "AuditLog_entityType_entityId_idx" ON "AuditLog"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "AuditLog_createdAt_idx" ON "AuditLog"("createdAt");

-- AddForeignKey
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Mailbox" ADD CONSTRAINT "Mailbox_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramMapping" ADD CONSTRAINT "TelegramMapping_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramMapping" ADD CONSTRAINT "TelegramMapping_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GraphSubscription" ADD CONSTRAINT "GraphSubscription_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessedMessage" ADD CONSTRAINT "ProcessedMessage_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "Mailbox"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
