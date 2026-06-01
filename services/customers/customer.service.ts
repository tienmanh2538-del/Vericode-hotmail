import { prisma } from '@/lib/prisma';
import type { CustomerScope } from '@/lib/auth/access-scope';
import { scopeAllowsCustomer } from '@/lib/auth/access-scope';
import type { CustomerInput, CustomerStatus } from '@/lib/validation/customer';

export interface CustomerRecord {
  id: string;
  name: string;
  status: CustomerStatus;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// TASK-045 — when a scope is provided and it is the 'assigned' (STAFF) kind,
// constrain the query to the assigned customer ids. Omitting scope preserves
// the original unscoped behavior for internal/admin callers.
export async function listCustomers(
  scope?: CustomerScope,
): Promise<CustomerRecord[]> {
  const rows = await prisma.customer.findMany({
    orderBy: { createdAt: 'desc' },
    ...(scope && scope.kind === 'assigned'
      ? { where: { id: { in: scope.customerIds } } }
      : {}),
  });
  return rows.map(toRecord);
}

export async function getCustomerById(
  id: string,
  scope?: CustomerScope,
): Promise<CustomerRecord | null> {
  if (!id) return null;
  const row = await prisma.customer.findUnique({ where: { id } });
  if (!row) return null;
  // Fail closed: a staff viewer never receives a customer outside their scope.
  if (scope && !scopeAllowsCustomer(scope, row.id)) return null;
  return toRecord(row);
}

export async function createCustomer(input: CustomerInput): Promise<CustomerRecord> {
  const row = await prisma.customer.create({
    data: {
      name: input.name,
      status: input.status,
      notes: input.notes,
    },
  });
  return toRecord(row);
}

export async function updateCustomer(
  id: string,
  input: CustomerInput,
): Promise<CustomerRecord> {
  const row = await prisma.customer.update({
    where: { id },
    data: {
      name: input.name,
      status: input.status,
      notes: input.notes,
    },
  });
  return toRecord(row);
}

interface PrismaCustomerRow {
  id: string;
  name: string;
  status: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toRecord(row: PrismaCustomerRow): CustomerRecord {
  return {
    id: row.id,
    name: row.name,
    status: row.status as CustomerStatus,
    notes: row.notes,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
