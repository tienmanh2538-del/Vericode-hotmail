-- TASK-045 — Internal staff ownership / assignment model.
--
-- Adds the StaffAssignment join table linking a STAFF_READ_ONLY user to the
-- customers they may see and operate. Scope is customer-level: a mailbox
-- inherits visibility from its customer, so no mailbox-level assignment column
-- is needed. OWNER/ADMIN are never constrained by this table (enforced in the
-- service layer). FKs cascade on user/customer delete; assignedById is SET NULL
-- so removing the actor keeps the assignment. No data backfill: existing STAFF
-- users start with zero assignments (fail-closed — they see nothing until
-- explicitly assigned).

-- CreateTable
CREATE TABLE "StaffAssignment" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "customerId" TEXT NOT NULL,
    "assignedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StaffAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StaffAssignment_userId_idx" ON "StaffAssignment"("userId");

-- CreateIndex
CREATE INDEX "StaffAssignment_customerId_idx" ON "StaffAssignment"("customerId");

-- CreateIndex
CREATE UNIQUE INDEX "StaffAssignment_userId_customerId_key" ON "StaffAssignment"("userId", "customerId");

-- AddForeignKey
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StaffAssignment" ADD CONSTRAINT "StaffAssignment_assignedById_fkey" FOREIGN KEY ("assignedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
