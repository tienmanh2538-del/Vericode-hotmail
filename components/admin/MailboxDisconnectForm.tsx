'use client';

import { useFormState, useFormStatus } from 'react-dom';
import {
  INITIAL_DISCONNECT_MAILBOX_STATE,
  type DisconnectMailboxState,
} from '@/services/microsoft/mailbox-disconnect-form-state';

interface MailboxDisconnectFormProps {
  action: (
    state: DisconnectMailboxState,
    formData: FormData,
  ) => Promise<DisconnectMailboxState>;
  /** Hide the action and show a passive note when already disconnected. */
  alreadyDisconnected: boolean;
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="mailbox-disconnect__submit"
      disabled={pending}
    >
      {pending ? 'Đang ngắt kết nối…' : 'Ngắt kết nối mailbox'}
    </button>
  );
}

// TASK-052 — OWNER/ADMIN only confirmation control. The destructive
// consequences are spelled out before the operator confirms. Server-side the
// action re-checks MANAGE_MAILBOXES, so hiding/showing this is UX only.
export function MailboxDisconnectForm({
  action,
  alreadyDisconnected,
}: MailboxDisconnectFormProps) {
  const [state, formAction] = useFormState(
    action,
    INITIAL_DISCONNECT_MAILBOX_STATE,
  );
  const safeState = state ?? INITIAL_DISCONNECT_MAILBOX_STATE;

  if (alreadyDisconnected) {
    return (
      <div className="admin-banner admin-banner--warning" role="status">
        <strong>Mailbox đã được ngắt kết nối.</strong> Mailbox này không còn được
        poll, renew subscription, hay relay code. Lịch sử logs và processed
        messages vẫn được giữ để audit.
      </div>
    );
  }

  return (
    <form action={formAction} className="mailbox-disconnect">
      <p className="mailbox-disconnect__lead">
        Khi ngắt kết nối mailbox này:
      </p>
      <ul className="mailbox-disconnect__consequences">
        <li>Mailbox sẽ ngừng được poll (delta polling).</li>
        <li>Mailbox sẽ ngừng renew Microsoft Graph subscription.</li>
        <li>Mailbox sẽ không relay verification code nữa.</li>
        <li>Active Telegram mapping của mailbox sẽ bị disable.</li>
        <li>Lịch sử logs và processed messages vẫn được giữ lại.</li>
      </ul>

      {safeState.status === 'error' && safeState.error ? (
        <p className="mailbox-disconnect__error" role="alert">
          {safeState.error}
        </p>
      ) : null}
      {safeState.status === 'success' ? (
        <p className="mailbox-disconnect__success" role="status">
          Đã ngắt kết nối mailbox. Disable {safeState.summary?.disabledMappingCount ?? 0}{' '}
          Telegram mapping, đánh dấu{' '}
          {safeState.summary?.deactivatedSubscriptionCount ?? 0} subscription
          inactive.
          {safeState.summary && safeState.summary.remoteSubscriptionsFailed > 0
            ? ' Lưu ý: xóa subscription phía Microsoft chưa thành công, nhưng mailbox đã được ngắt kết nối an toàn ở local.'
            : ''}
        </p>
      ) : null}

      <label className="mailbox-disconnect__confirm">
        <input type="checkbox" name="confirm" />
        <span>Tôi hiểu hậu quả và muốn ngắt kết nối mailbox này.</span>
      </label>

      <div className="mailbox-disconnect__actions">
        <SubmitButton />
      </div>
    </form>
  );
}
