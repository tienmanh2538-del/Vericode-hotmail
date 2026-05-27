import { prisma } from '@/lib/prisma';
import type { CustomerInput, CustomerStatus } from '@/lib/validation/customer';

export interface CustomerRecord {
  id: string;
  name: string;
  status: CustomerStatus;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export async function listCustomers(): Promise<CustomerRecord[]> {
  const rows = await prisma.customer.findMany({
    orderBy: { createdAt: 'desc' },
  });
  return rows.map(toRecord);
}

export async function getCustomerById(id: string): Promise<CustomerRecord | null> {
  if (!id) return null;
  const row = await prisma.customer.findUnique({ where: { id } });
  return row ? toRecord(row) : null;
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
