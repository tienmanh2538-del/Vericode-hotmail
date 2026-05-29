import styles from './mailbox-badges.module.css';
import type { TelegramMappingStatusValue } from '@/services/microsoft/mailbox-list.service';

interface TelegramMappingStatusBadgeProps {
  status: TelegramMappingStatusValue | null;
}

const LABEL: Record<TelegramMappingStatusValue, string> = {
  ACTIVE: 'Active',
  DISABLED: 'Disabled',
};

const VARIANT: Record<TelegramMappingStatusValue, string> = {
  ACTIVE: styles.telegramActive,
  DISABLED: styles.telegramDisabled,
};

export function TelegramMappingStatusBadge({ status }: TelegramMappingStatusBadgeProps) {
  if (!status) {
    return <span className={styles.muted}>Chưa map</span>;
  }
  return (
    <span className={`${styles.badge} ${VARIANT[status] ?? ''}`}>
      {LABEL[status] ?? status}
    </span>
  );
}
