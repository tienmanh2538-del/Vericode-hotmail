import styles from './mailbox-badges.module.css';
import {
  READINESS_LABEL,
  type MailboxReadiness,
} from '@/lib/mailboxes/mailbox-list-filter';

interface MailboxReadinessBadgeProps {
  readiness: MailboxReadiness;
}

const VARIANT: Record<MailboxReadiness, string> = {
  READY: styles.readyOk,
  NEEDS_MAPPING: styles.readyNeedsMapping,
  TOKEN_ISSUE: styles.readyTokenIssue,
  SUBSCRIPTION_ISSUE: styles.readySubscriptionIssue,
  WEBHOOK_ISSUE: styles.readyWebhookIssue,
  DISABLED: styles.readyDisabled,
  ERROR: styles.readyError,
};

// TASK-046 — single at-a-glance signal answering "can this mailbox deliver a
// code right now?". Derived from existing list fields; see deriveMailboxReadiness.
export function MailboxReadinessBadge({ readiness }: MailboxReadinessBadgeProps) {
  return (
    <span className={`${styles.badge} ${VARIANT[readiness] ?? ''}`}>
      {READINESS_LABEL[readiness]}
    </span>
  );
}
