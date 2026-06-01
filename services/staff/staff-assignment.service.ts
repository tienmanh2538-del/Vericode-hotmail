import { prisma } from '@/lib/prisma';

// TASK-045 — Internal staff ownership / assignment model (service layer).
//
// Customer-level assignment: linking a STAFF_READ_ONLY user to a customer grants
// that user visibility to the customer AND every mailbox/Telegram mapping under
// it (scope is resolved in lib/auth/access-scope.ts). There is intentionally no
// mailbox-level assignment — the existing Mailbox.customerId relation already
// expresses "which customer a mailbox belongs to", so customer assignment is
// enough and avoids a second source of truth.
//
// These mutations are management operations: callers MUST gate them on the
// MANAGE_STAFF_ASSIGNMENTS permission (OWNER/ADMIN only). The service does not
// guard auth itself so it stays unit-testable in isolation.

export interface StaffAssignmentRecord {
  id: string;
  userId: string;
  customerId: string;
  assignedById: string | null;
  createdAt: Date;
}

interface StaffAssignmentRow {
  id: string;
  userId: string;
  customerId: string;
  assignedById: string | null;
  createdAt: Date;
}

function toRecord(row: StaffAssignmentRow): StaffAssignmentRecord {
  return {
    id: row.id,
    userId: row.userId,
    customerId: row.customerId,
    assignedById: row.assignedById ?? null,
    createdAt: row.createdAt,
  };
}

/**
 * The customer ids a staff user is assigned to. Used by access-scope to build
 * the STAFF visibility filter. Returns [] for an unknown/empty user id so the
 * caller fails closed (sees nothing) rather than open.
 */
export async function listAssignedCustomerIds(userId: string): Promise<string[]> {
  const key = userId?.trim();
  if (!key) return [];
  const rows = await prisma.staffAssignment.findMany({
    where: { userId: key },
    select: { customerId: true },
  });
  return rows.map((row) => row.customerId);
}

export async function listAssignmentsForUser(
  userId: string,
): Promise<StaffAssignmentRecord[]> {
  const key = userId?.trim();
  if (!key) return [];
  const rows = await prisma.staffAssignment.findMany({
    where: { userId: key },
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toRecord);
}

export interface AssignCustomerInput {
  userId: string;
  customerId: string;
  assignedById?: string | null;
}

/**
 * Idempotent assign: re-assigning an existing (user, customer) pair returns the
 * existing row instead of throwing on the @@unique constraint.
 */
export async function assignCustomerToStaff(
  input: AssignCustomerInput,
): Promise<StaffAssignmentRecord> {
  const userId = input.userId?.trim();
  const customerId = input.customerId?.trim();
  if (!userId || !customerId) {
    throw new Error('staff-assignment: userId and customerId are required');
  }

  const row = await prisma.staffAssignment.upsert({
    where: { userId_customerId: { userId, customerId } },
    update: {},
    create: {
      userId,
      customerId,
      assignedById: input.assignedById?.trim() || null,
    },
  });
  return toRecord(row);
}

/**
 * Remove an assignment. No-op (does not throw) when the pair does not exist, so
 * unassigning twice is safe.
 */
export async function removeStaffAssignment(input: {
  userId: string;
  customerId: string;
}): Promise<void> {
  const userId = input.userId?.trim();
  const customerId = input.customerId?.trim();
  if (!userId || !customerId) return;

  await prisma.staffAssignment.deleteMany({
    where: { userId, customerId },
  });
}
