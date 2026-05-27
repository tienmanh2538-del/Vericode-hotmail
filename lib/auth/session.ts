import { loadEnv } from '../env';
import type { Role } from './roles';

export interface AuthUser {
  id: string;
  email: string;
  role: Role;
}

const DEMO_USER: AuthUser = {
  id: 'dev-demo-user',
  email: 'demo@local.test',
  role: 'OWNER',
};

function isTruthyFlag(value: string | undefined): boolean {
  if (!value) return false;
  return value.trim().toLowerCase() === 'true';
}

export async function getCurrentUser(
  source: Record<string, string | undefined> = process.env,
): Promise<AuthUser | null> {
  const { values } = loadEnv(source);

  if (values.APP_ENV === 'development' && isTruthyFlag(values.AUTH_DEV_DEMO_USER)) {
    return DEMO_USER;
  }

  return null;
}
