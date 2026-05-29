// TASK-034 — Health dashboard types.
//
// Shared, UI-safe shapes for the admin health dashboard. Nothing in here ever
// carries a token, refresh token, client secret, clientState(Hash), full
// verification code, or email body — only derived status + sanitized strings.

import type {
  GraphSubscriptionStatusValue,
  MailboxProviderValue,
  MailboxStatusValue,
  TelegramMappingStatusValue,
} from '@/services/microsoft/mailbox-list.service';

/** Aggregate health level used for mailboxes and the overall dashboard. */
export type HealthLevel = 'OK' | 'WARNING' | 'CRITICAL' | 'UNKNOWN';

/** Status used for individual operational checks. */
export type OperationalCheckStatus = 'PASS' | 'WARNING' | 'CRITICAL' | 'UNKNOWN';

/** Stable identifiers for the operational checks the dashboard renders. */
export type OperationalCheckId =
  | 'EMAIL_WORKER_PIPELINE'
  | 'DELTA_POLLING'
  | 'SUBSCRIPTION_RENEWAL'
  | 'TELEGRAM_RELIABILITY'
  | 'WEBHOOK_HEALTH';

export interface OperationalCheck {
  id: OperationalCheckId;
  label: string;
  status: OperationalCheckStatus;
  /** Short, human-readable, sanitized explanation. Never contains secrets. */
  detail: string;
}

export interface MailboxHealthRow {
  id: string;
  emailAddress: string;
  ownerCustomerName: string | null;
  customerName: string | null;
  mailboxStatus: MailboxStatusValue;
  provider: MailboxProviderValue;
  /** Derived token / reconnect state ("OK" | "Reconnect required" | "Error"). */
  tokenStatus: string;
  telegramMappingStatus: TelegramMappingStatusValue | null;
  subscriptionStatus: GraphSubscriptionStatusValue | null;
  subscriptionExpiresAt: Date | null;
  lastSuccessfulSyncAt: Date | null;
  lastPolledAt: Date | null;
  lastCodeSentAt: Date | null;
  /** Sanitized + truncated last error message, or null when none. */
  lastErrorShort: string | null;
  level: HealthLevel;
  /** Reasons that drove the level — shown as a tooltip/secondary text. */
  reasons: string[];
}

export interface HealthOverview {
  totalMailboxes: number;
  activeMailboxes: number;
  reconnectRequired: number;
  disabledOrError: number;
  subscriptionExpired: number;
  subscriptionExpiringSoon: number;
  missingTelegramMapping: number;
  pollingStale: number;
  recentTelegramFailures: number;
  lastCodeSentAt: Date | null;
  overall: HealthLevel;
}

export interface HealthDashboardData {
  overview: HealthOverview;
  mailboxes: MailboxHealthRow[];
  operationalChecks: OperationalCheck[];
  generatedAt: Date;
}

export type HealthLoadResult =
  | { ok: true; data: HealthDashboardData }
  | { ok: false; message: string };
