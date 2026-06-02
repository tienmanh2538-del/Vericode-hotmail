'use server';

import { revalidatePath } from 'next/cache';
import { requirePermission } from '@/lib/auth/guards';
import {
  disconnectMailbox,
  MailboxDisconnectError,
} from './mailbox-disconnect.service';
import { buildDefaultMailboxDisconnectRemoteCleanup } from './mailbox-disconnect-remote-cleanup';
import type { DisconnectMailboxState } from './mailbox-disconnect-form-state';

// TASK-052 — disconnecting a mailbox is a MANAGE_MAILBOXES action, so
// STAFF_READ_ONLY is fail-closed server-side (redirected to /login by
// requirePermission) regardless of whether the UI hides the button. `mailboxId`
// is bound by the page; the client form only submits a confirmation.
export async function disconnectMailboxAction(
  mailboxId: string,
  _prev: DisconnectMailboxState,
  formData: FormData,
): Promise<DisconnectMailboxState> {
  const user = await requirePermission('MANAGE_MAILBOXES');

  // Require an explicit confirmation so a stray POST cannot disconnect a mailbox.
  const confirmed = (formData.get('confirm') ?? '').toString() === 'on';
  if (!confirmed) {
    return {
      status: 'error',
      error: 'Vui lòng xác nhận trước khi ngắt kết nối mailbox.',
    };
  }

  try {
    const result = await disconnectMailbox(mailboxId, {
      remoteCleanup: buildDefaultMailboxDisconnectRemoteCleanup(),
      actor: { userId: user.id, email: user.email },
    });
    revalidatePath(`/admin/mailboxes/${mailboxId}`);
    revalidatePath('/admin/mailboxes');
    return {
      status: 'success',
      summary: {
        disabledMappingCount: result.disabledMappingCount,
        deactivatedSubscriptionCount: result.deactivatedSubscriptionCount,
        remoteSubscriptionsFailed: result.remoteCleanup.failed,
      },
    };
  } catch (error) {
    const message =
      error instanceof MailboxDisconnectError && error.kind === 'not_found'
        ? 'Không tìm thấy mailbox.'
        : 'Không ngắt kết nối được mailbox. Vui lòng thử lại.';
    return { status: 'error', error: message };
  }
}
