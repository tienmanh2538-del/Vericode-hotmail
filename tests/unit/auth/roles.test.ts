import { describe, it, expect } from 'vitest';
import {
  hasPermission,
  isAdminRole,
  ROLE_PERMISSIONS,
  type Permission,
} from '@/lib/auth/permissions';
import { ROLE_VALUES, isRole, type Role } from '@/lib/auth/roles';

const MANAGE_PERMS: Permission[] = [
  'MANAGE_MAILBOXES',
  'MANAGE_TELEGRAM_MAPPINGS',
  'MANAGE_CUSTOMERS',
  // TASK-045 — OWNER/ADMIN only; STAFF_READ_ONLY must be denied.
  'MANAGE_STAFF_ASSIGNMENTS',
];

const VIEW_PERMS: Permission[] = ['VIEW_ADMIN', 'VIEW_LOGS', 'VIEW_HEALTH'];

describe('role constants', () => {
  it('exposes exactly the three skeleton roles', () => {
    expect([...ROLE_VALUES]).toEqual(['OWNER', 'ADMIN', 'STAFF_READ_ONLY']);
  });

  it('isRole accepts known roles and rejects unknown values', () => {
    for (const role of ROLE_VALUES) {
      expect(isRole(role)).toBe(true);
    }
    expect(isRole('SUPERADMIN')).toBe(false);
    expect(isRole('')).toBe(false);
    expect(isRole(undefined)).toBe(false);
    expect(isRole(null)).toBe(false);
    expect(isRole(42)).toBe(false);
  });
});

describe('isAdminRole', () => {
  it('returns true for OWNER and ADMIN', () => {
    expect(isAdminRole('OWNER')).toBe(true);
    expect(isAdminRole('ADMIN')).toBe(true);
  });

  it('returns false for STAFF_READ_ONLY and missing role', () => {
    expect(isAdminRole('STAFF_READ_ONLY')).toBe(false);
    expect(isAdminRole(null)).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
  });
});

describe('hasPermission — OWNER', () => {
  it('grants every defined permission', () => {
    for (const perm of [...VIEW_PERMS, ...MANAGE_PERMS]) {
      expect(hasPermission('OWNER', perm)).toBe(true);
    }
  });
});

describe('hasPermission — ADMIN', () => {
  it('grants every defined permission', () => {
    for (const perm of [...VIEW_PERMS, ...MANAGE_PERMS]) {
      expect(hasPermission('ADMIN', perm)).toBe(true);
    }
  });
});

describe('hasPermission — STAFF_READ_ONLY', () => {
  it('grants only VIEW_ADMIN and VIEW_LOGS', () => {
    expect(hasPermission('STAFF_READ_ONLY', 'VIEW_ADMIN')).toBe(true);
    expect(hasPermission('STAFF_READ_ONLY', 'VIEW_LOGS')).toBe(true);
  });

  it('denies all manage permissions', () => {
    for (const perm of MANAGE_PERMS) {
      expect(hasPermission('STAFF_READ_ONLY', perm)).toBe(false);
    }
  });

  it('denies VIEW_HEALTH (read-only does not imply health view)', () => {
    expect(hasPermission('STAFF_READ_ONLY', 'VIEW_HEALTH')).toBe(false);
  });
});

describe('hasPermission — missing/invalid role', () => {
  it('returns false when role is null or undefined', () => {
    expect(hasPermission(null, 'VIEW_ADMIN')).toBe(false);
    expect(hasPermission(undefined, 'VIEW_ADMIN')).toBe(false);
  });

  it('returns false when role is unknown at runtime', () => {
    const bogus = 'SUPERADMIN' as unknown as Role;
    expect(hasPermission(bogus, 'VIEW_ADMIN')).toBe(false);
  });
});

describe('ROLE_PERMISSIONS shape', () => {
  it('defines a grant list for every role', () => {
    for (const role of ROLE_VALUES) {
      expect(Array.isArray(ROLE_PERMISSIONS[role])).toBe(true);
    }
  });
});
