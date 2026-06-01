import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthUser } from '@/lib/auth/session';

const redirectMock = vi.fn((path: string) => {
  throw new Error(`REDIRECT:${path}`);
});

const getCurrentUserMock = vi.fn<() => Promise<AuthUser | null>>();

vi.mock('next/navigation', () => ({
  redirect: (path: string) => redirectMock(path),
}));

vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => getCurrentUserMock(),
}));

import { requireAdminAccess, requirePermission } from '@/lib/auth/guards';

beforeEach(() => {
  redirectMock.mockClear();
  getCurrentUserMock.mockReset();
});

describe('requireAdminAccess', () => {
  it('redirects to /login when no user is signed in', async () => {
    getCurrentUserMock.mockResolvedValue(null);

    await expect(requireAdminAccess()).rejects.toThrow('REDIRECT:/login');
    expect(redirectMock).toHaveBeenCalledWith('/login');
  });

  it('redirects to /login when user lacks VIEW_ADMIN', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'u1',
      email: 'nobody@example.com',
      role: 'OUTSIDER' as unknown as AuthUser['role'],
    });

    await expect(requireAdminAccess()).rejects.toThrow('REDIRECT:/login');
    expect(redirectMock).toHaveBeenCalledWith('/login');
  });

  it('returns the user when role grants VIEW_ADMIN', async () => {
    const owner: AuthUser = {
      id: 'owner-1',
      email: 'owner@example.com',
      role: 'OWNER',
    };
    getCurrentUserMock.mockResolvedValue(owner);

    const result = await requireAdminAccess();
    expect(result).toEqual(owner);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('allows STAFF_READ_ONLY into /admin because VIEW_ADMIN is granted', async () => {
    const staff: AuthUser = {
      id: 'staff-1',
      email: 'staff@example.com',
      role: 'STAFF_READ_ONLY',
    };
    getCurrentUserMock.mockResolvedValue(staff);

    const result = await requireAdminAccess();
    expect(result).toEqual(staff);
    expect(redirectMock).not.toHaveBeenCalled();
  });
});

describe('requirePermission', () => {
  // TASK-045 — write surfaces gate on MANAGE_* so STAFF_READ_ONLY is blocked.
  it('redirects STAFF_READ_ONLY away from a MANAGE_CUSTOMERS surface', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'staff-1',
      email: 'staff@example.com',
      role: 'STAFF_READ_ONLY',
    });

    await expect(requirePermission('MANAGE_CUSTOMERS')).rejects.toThrow(
      'REDIRECT:/login',
    );
    expect(redirectMock).toHaveBeenCalledWith('/login');
  });

  it('redirects STAFF_READ_ONLY away from a MANAGE_TELEGRAM_MAPPINGS surface', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'staff-1',
      email: 'staff@example.com',
      role: 'STAFF_READ_ONLY',
    });

    await expect(
      requirePermission('MANAGE_TELEGRAM_MAPPINGS'),
    ).rejects.toThrow('REDIRECT:/login');
  });

  it('redirects when no user is signed in', async () => {
    getCurrentUserMock.mockResolvedValue(null);
    await expect(requirePermission('MANAGE_CUSTOMERS')).rejects.toThrow(
      'REDIRECT:/login',
    );
  });

  it('returns the user when an ADMIN holds the permission', async () => {
    const admin: AuthUser = {
      id: 'admin-1',
      email: 'admin@example.com',
      role: 'ADMIN',
    };
    getCurrentUserMock.mockResolvedValue(admin);

    const result = await requirePermission('MANAGE_CUSTOMERS');
    expect(result).toEqual(admin);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it('returns the user when an OWNER holds MANAGE_STAFF_ASSIGNMENTS', async () => {
    const owner: AuthUser = {
      id: 'owner-1',
      email: 'owner@example.com',
      role: 'OWNER',
    };
    getCurrentUserMock.mockResolvedValue(owner);

    const result = await requirePermission('MANAGE_STAFF_ASSIGNMENTS');
    expect(result).toEqual(owner);
  });
});
