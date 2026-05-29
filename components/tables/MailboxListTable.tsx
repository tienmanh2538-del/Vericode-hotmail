import { MailboxStatusBadge } from '@/components/status/MailboxStatusBadge';
import { SubscriptionStatusBadge } from '@/components/status/SubscriptionStatusBadge';
import { TelegramMappingStatusBadge } from '@/components/status/TelegramMappingStatusBadge';
import type { MailboxListItem } from '@/services/microsoft/mailbox-list.service';

interface MailboxListTableProps {
  mailboxes: MailboxListItem[];
}

function formatDate(value: Date | null): string {
  if (!value) return '—';
  return value.toISOString().slice(0, 10);
}

function formatDateTime(value: Date | null): string {
  if (!value) return '—';
  return value.toISOString().slice(0, 16).replace('T', ' ');
}

function joinTelegram(groupName: string | null, chatMasked: string | null): string {
  if (groupName && chatMasked) return `${groupName} (${chatMasked})`;
  if (groupName) return groupName;
  if (chatMasked) return chatMasked;
  return '—';
}

export function MailboxListTable({ mailboxes }: MailboxListTableProps) {
  if (mailboxes.length === 0) {
    return (
      <p className="customers-empty">
        Chưa có mailbox nào được kết nối. Mailbox sau khi OAuth thành công sẽ
        xuất hiện tại đây.
      </p>
    );
  }

  return (
    <table className="customers-table" aria-label="Mailboxes">
      <thead>
        <tr>
          <th scope="col">Email</th>
          <th scope="col">Provider</th>
          <th scope="col">Customer</th>
          <th scope="col">Status</th>
          <th scope="col">Telegram</th>
          <th scope="col">Subscription</th>
          <th scope="col">Sub. expires</th>
          <th scope="col">Last sync</th>
          <th scope="col">Created</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {mailboxes.map((mailbox) => {
          const customerLabel =
            mailbox.customerName ?? mailbox.ownerCustomerName ?? '—';
          return (
            <tr key={mailbox.id}>
              <td>{mailbox.emailAddress}</td>
              <td>{mailbox.provider}</td>
              <td>{customerLabel}</td>
              <td>
                <MailboxStatusBadge status={mailbox.status} />
              </td>
              <td>
                <div
                  style={{
                    display: 'flex',
                    flexDirection: 'column',
                    gap: '0.25rem',
                  }}
                >
                  <TelegramMappingStatusBadge status={mailbox.telegramMappingStatus} />
                  <span style={{ fontSize: '0.8rem', color: '#475569' }}>
                    {joinTelegram(mailbox.telegramGroupName, mailbox.telegramChatIdMasked)}
                  </span>
                </div>
              </td>
              <td>
                <SubscriptionStatusBadge status={mailbox.subscriptionStatus} />
              </td>
              <td>{formatDateTime(mailbox.subscriptionExpiresAt)}</td>
              <td>{formatDateTime(mailbox.lastSuccessfulSyncAt)}</td>
              <td>{formatDate(mailbox.createdAt)}</td>
              <td>
                <span style={{ color: '#64748b', fontSize: '0.85rem' }}>
                  Chi tiết — sẽ làm ở TASK-029
                </span>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
