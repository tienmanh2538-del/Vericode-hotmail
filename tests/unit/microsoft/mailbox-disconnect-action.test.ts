import { describe, it, expect, vi, beforeEach } from 'vitest';

// --- Mocks for the server-action collaborators -----------------------------
const requirePermissionMock = vi.fn();
vi.mock('@/lib/auth/guards', () => ({
  requirePermission: (...args: unknown[]) => requirePermissionMock(...args),
}));

const disconnectMailboxMock = vi.fn();
vi.mock('@/services/microsoft/mailbox-disconnect.service', () => ({
  disconnectMailbox: (...args: unknown[]) => disconnectMailboxMock(...args),
  // Lightweight stand-in so the action's `instanceof` check still works.
  MailboxDisconnectError: class MailboxDisconnectError extends Error {
    kind: string;
    constructor(kind: string, message: string) {
      super(message);
      this.kind = kind;
    }
  },
}));

vi.mock('@/services/microsoft/mailbox-disconnect-remote-cleanup', () => ({
  buildDefaultMailboxDisconnectRemoteCleanup: () => ({
    deleteRemoteSubscription: vi.fn(),
  }),
}));

const revalidatePathMock = vi.fn();
vi.mock('next/cache', () => ({
  revalidatePath: (...args: unknown[]) => revalidatePathMock(...args),
}));

import { disconnectMailboxAction } from '@/services/microsoft/mailbox-disconnect-actions';
import { MailboxDisconnectError } from '@/services/microsoft/mailbox-disconnect.service';
import { INITIAL_DISCONNECT_MAILBOX_STATE } from '@/services/microsoft/mailbox-disconnect-form-state';

const MAILBOX_ID = 'mbx_action_052';

function confirmedFormData(): FormData {
  const fd = new FormData();
  fd.set('confirm', 'on');
  return fd;
}

beforeEach(() => {
  requirePermissionMock.mockReset();
  disconnectMailboxMock.mockReset();
  revalidatePathMock.mockReset();
});

describe('disconnectMailboxAction — server-side permission enforcement', () => {
  it('requires MANAGE_MAILBOXES and disconnects for an authorized OWNER/ADMIN', async () => {
    requirePermissionMock.mockResolvedValue({
      id: 'u_owner',
      email: 'owner@test.local',
      role: 'OWNER',
    });
    disconnectMailboxMock.mockResolvedValue({
      mailboxId: MAILBOX_ID,
      alreadyDisconnected: false,
      disabledMappingCount: 1,
      deactivatedSubscriptionCount: 1,
      remoteCleanup: { attempted: 1, deleted: 1, failed: 0 },
    });

    const result = await disconnectMailboxAction(
      MAILBOX_ID,
      INITIAL_DISCONNECT_MAILBOX_STATE,
      confirmedFormData(),
    );

    expect(requirePermissionMock).toHaveBeenCalledWith('MANAGE_MAILBOXES');
    expect(disconnectMailboxMock).toHaveBeenCalledTimes(1);
    const [calledId, deps] = disconnectMailboxMock.mock.calls[0];
    expect(calledId).toBe(MAILBOX_ID);
    expect(deps.actor).toEqual({ userId: 'u_owner', email: 'owner@test.local' });
    expect(result.status).toBe('success');
    expect(revalidatePathMock).toHaveBeenCalledWith(`/admin/mailboxes/${MAILBOX_ID}`);
  });

  it('blocks STAFF_READ_ONLY: when the guard redirects, the service is never called', async () => {
    // requirePermission redirects (throws) for a role lacking MANAGE_MAILBOXES.
    requirePermissionMock.mockRejectedValue(new Error('NEXT_REDIRECT'));

    await expect(
      disconnectMailboxAction(
        MAILBOX_ID,
        INITIAL_DISCONNECT_MAILBOX_STATE,
        confirmedFormData(),
      ),
    ).rejects.toThrow();

    expect(disconnectMailboxMock).not.toHaveBeenCalled();
  });

  it('requires explicit confirmation before disconnecting', async () => {
    requirePermissionMock.mockResolvedValue({
      id: 'u_owner',
      email: 'owner@test.local',
      role: 'ADMIN',
    });

    const result = await disconnectMailboxAction(
      MAILBOX_ID,
      INITIAL_DISCONNECT_MAILBOX_STATE,
      new FormData(),
    );

    expect(result.status).toBe('error');
    expect(disconnectMailboxMock).not.toHaveBeenCalled();
  });

  it('returns a safe error message when the mailbox is not found', async () => {
    requirePermissionMock.mockResolvedValue({
      id: 'u_owner',
      email: 'owner@test.local',
      role: 'OWNER',
    });
    disconnectMailboxMock.mockRejectedValue(
      new MailboxDisconnectError('not_found', 'mailbox not found'),
    );

    const result = await disconnectMailboxAction(
      MAILBOX_ID,
      INITIAL_DISCONNECT_MAILBOX_STATE,
      confirmedFormData(),
    );

    expect(result.status).toBe('error');
    expect(result.error).toContain('Không tìm thấy mailbox');
  });
});
