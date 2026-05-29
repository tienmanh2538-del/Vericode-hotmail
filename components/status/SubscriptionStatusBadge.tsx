import styles from './mailbox-badges.module.css';
import type { GraphSubscriptionStatusValue } from '@/services/microsoft/mailbox-list.service';

interface SubscriptionStatusBadgeProps {
  status: GraphSubscriptionStatusValue | null;
}

const LABEL: Record<GraphSubscriptionStatusValue, string> = {
  ACTIVE: 'Active',
  EXPIRED: 'Hết hạn',
  FAILED: 'Lỗi',
  RENEWING: 'Đang renew',
};

const VARIANT: Record<GraphSubscriptionStatusValue, string> = {
  ACTIVE: styles.subActive,
  RENEWING: styles.subRenewing,
  EXPIRED: styles.subExpired,
  FAILED: styles.subFailed,
};

export function SubscriptionStatusBadge({ status }: SubscriptionStatusBadgeProps) {
  if (!status) {
    return <span className={styles.muted}>—</span>;
  }
  return (
    <span className={`${styles.badge} ${VARIANT[status] ?? ''}`}>
      {LABEL[status] ?? status}
    </span>
  );
}
