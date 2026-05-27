import { redirect } from 'next/navigation';
import { hasPermission } from './permissions';
import { getCurrentUser, type AuthUser } from './session';

export async function requireAdminAccess(): Promise<AuthUser> {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user.role, 'VIEW_ADMIN')) {
    redirect('/login');
  }
  return user;
}
