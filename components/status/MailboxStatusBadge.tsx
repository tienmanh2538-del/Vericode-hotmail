import styles from './mailbox-badges.module.css';
import type { MailboxStatusValue } from '@/services/microsoft/mailbox-list.service';

interface MailboxStatusBadgeProps {
  status: MailboxStatusValue;
}

const LABEL: Record<MailboxStatusValue, string> = {
  ACTIVE: 'Active',
  RECONNECT_REQUIRED: 'Cần reconnect',
  SUBSCRIPTION_EXPIRED: 'Subscription hết hạn',
  WEBHOOK_FAILED: 'Webhook lỗi',
  DISABLED: 'Đã tắt',
  ERROR: 'Lỗi',
};

const VARIANT: Record<MailboxStatusValue, string> = {
  ACTIVE: styles.mailboxActive,
  RECONNECT_REQUIRED: styles.mailboxReconnect,
  SUBSCRIPTION_EXPIRED: styles.mailboxSubExpired,
  WEBHOOK_FAILED: styles.mailboxWebhookFailed,
  DISABLED: styles.mailboxDisabled,
  ERROR: styles.mailboxError,
};

export function MailboxStatusBadge({ status }: MailboxStatusBadgeProps) {
  const variantClass = VARIANT[status] ?? '';
  return (
    <span className={`${styles.badge} ${variantClass}`}>{LABEL[status] ?? status}</span>
  );
}
