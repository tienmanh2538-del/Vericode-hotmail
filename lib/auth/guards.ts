import { redirect } from 'next/navigation';
import { hasPermission, type Permission } from './permissions';
import { getCurrentUser, type AuthUser } from './session';

export async function requireAdminAccess(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user.role, 'VIEW_ADMIN')) {
    redirect('/login');
  }
  return user;
}

/**
 * TASK-045 — gate a write/management surface on a specific permission.
 *
 * STAFF_READ_ONLY holds only VIEW_ADMIN/VIEW_LOGS, so calling this with any
 * MANAGE_* permission fails closed for staff (and for anyone not signed in).
 * Fails by redirecting to /login — the same fail-closed path requireAdminAccess
 * uses — so no out-of-scope data or error detail leaks to the caller.
 */
export async function requirePermission(permission: Permission): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user.role, permission)) {
    redirect('/login');
  }
  return user;
}
