import type { Role } from './roles';

export const PERMISSION_VALUES = [
  'VIEW_ADMIN',
  'MANAGE_MAILBOXES',
  'MANAGE_TELEGRAM_MAPPINGS',
  'VIEW_HEALTH',
  'VIEW_LOGS',
  'MANAGE_CUSTOMERS',
  // TASK-045 — assign/unassign customers to staff. OWNER/ADMIN only.
  'MANAGE_STAFF_ASSIGNMENTS',
] as const;

export type Permission = (typeof PERMISSION_VALUES)[number];

const FULL_ADMIN: readonly Permission[] = [
  'VIEW_ADMIN',
  'MANAGE_MAILBOXES',
  'MANAGE_TELEGRAM_MAPPINGS',
  'VIEW_HEALTH',
  'VIEW_LOGS',
  'MANAGE_CUSTOMERS',
  'MANAGE_STAFF_ASSIGNMENTS',
];

// STAFF_READ_ONLY can read the admin area and logs, but holds NO MANAGE_*
// permission. Every write path (customer/telegram mapping/assignment) is gated
// on a MANAGE_* permission, so this role is effectively view-only. What it sees
// is further narrowed to assigned customers by the service-layer scope (see
// lib/auth/access-scope.ts).
const READ_ONLY: readonly Permission[] = ['VIEW_ADMIN', 'VIEW_LOGS'];

export const ROLE_PERMISSIONS: Readonly<Record<Role, readonly Permission[]>> = {
  OWNER: FULL_ADMIN,
  ADMIN: FULL_ADMIN,
  STAFF_READ_ONLY: READ_ONLY,
};

export function hasPermission(role: Role | null | undefined, permission: Permission): boolean {
  if (!role) return false;
  const grants = ROLE_PERMISSIONS[role];
  if (!grants) return false;
  return grants.includes(permission);
}

export function isAdminRole(role: Role | null | undefined): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}
