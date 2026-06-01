import { listAssignedCustomerIds } from '@/services/staff/staff-assignment.service';
import { isAdminRole } from './permissions';
import type { Role } from './roles';

// TASK-045 — data visibility scope.
//
// Resolves WHICH customers a viewer may see. OWNER/ADMIN get the unrestricted
// 'all' scope; STAFF_READ_ONLY gets an 'assigned' scope holding only the
// customer ids assigned to them. Read services accept a CustomerScope and
// translate it into a Prisma `where` filter, so scoping lives in ONE place and
// the backend never returns out-of-scope rows even if the UI forgets to hide
// them. An unknown/signed-out viewer resolves to an empty 'assigned' scope
// (fail-closed: sees nothing).

export type CustomerScope =
  | { kind: 'all' }
  | { kind: 'assigned'; customerIds: string[] };

export interface ScopeViewer {
  id: string;
  role: Role;
}

export function isUnrestrictedScope(
  scope: CustomerScope,
): scope is { kind: 'all' } {
  return scope.kind === 'all';
}

/**
 * True when `customerId` is visible under `scope`. A null/empty customerId is
 * only visible under the unrestricted ('all') scope — a mailbox with no
 * customer can never belong to a staff member's assigned set.
 */
export function scopeAllowsCustomer(
  scope: CustomerScope,
  customerId: string | null | undefined,
): boolean {
  if (scope.kind === 'all') return true;
  if (!customerId) return false;
  return scope.customerIds.includes(customerId);
}

export async function resolveCustomerScope(
  viewer: ScopeViewer | null | undefined,
): Promise<CustomerScope> {
  if (!viewer) return { kind: 'assigned', customerIds: [] };
  if (isAdminRole(viewer.role)) return { kind: 'all' };
  const customerIds = await listAssignedCustomerIds(viewer.id);
  return { kind: 'assigned', customerIds };
}
