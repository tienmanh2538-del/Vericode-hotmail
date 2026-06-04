// TASK-034 — Health dashboard types.
//
// Shared, UI-safe shapes for the admin health dashboard. Nothing in here ever
// carries a token, refresh token, client secret, clientState(Hash), full
// verification code, or email body — only derived status + sanitized strings.

import type { InfraObservability } from '@/services/observability/observability.types';
import type { MailboxReadiness } from '@/lib/mailboxes/mailbox-list-filter';
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
  | 'QUEUE_REDIS'
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
  /** Customer id, or null for an unassigned mailbox. Used for scope/grouping. */
  customerId: string | null;
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
  /**
   * Single at-a-glance readiness signal (Ready / Needs mapping / Token issue …),
   * shared with the mailbox list so "is this mailbox ready?" has one definition.
   */
  readiness: MailboxReadiness;
  /** Recent (24h) Telegram send failures for this mailbox. */
  recentTelegramFailureCount: number;
  /** Sanitized + truncated last error message, or null when none. */
  lastErrorShort: string | null;
  level: HealthLevel;
  /** Reasons that drove the level — shown as a tooltip/secondary text. */
  reasons: string[];
}

/**
 * Per-customer workload roll-up. STAFF_READ_ONLY only ever receives rows for
 * customers in their assignment scope (the rows are built from already-scoped
 * mailbox data, so out-of-scope customers can never appear here).
 */
export interface CustomerWorkloadRow {
  /** Customer id, or null for the synthetic "Unassigned" bucket. */
  customerId: string | null;
  customerName: string;
  totalMailboxes: number;
  readyMailboxes: number;
  needsMapping: number;
  /** Mailboxes in a token/subscription/webhook/error/disabled state. */
  errorOrDisconnected: number;
  /** Recent (24h) Telegram send failures across the customer's mailboxes. */
  recentIssueCount: number;
}

export interface HealthOverview {
  totalMailboxes: number;
  activeMailboxes: number;
  reconnectRequired: number;
  disabledOrError: number;
  /** Mailboxes that are READY to relay a code right now (derived readiness). */
  readyMailboxes: number;
  /** ACTIVE + has-customer mailboxes that lack an active Telegram mapping. */
  needsMapping: number;
  /** Connected mailboxes not yet attached to a customer. */
  needsCustomer: number;
  subscriptionExpired: number;
  subscriptionExpiringSoon: number;
  missingTelegramMapping: number;
  pollingStale: number;
  recentTelegramFailures: number;
  lastCodeSentAt: Date | null;
  /** Most recent email the pipeline processed (any ProcessedMessage). */
  lastProcessedEmailAt: Date | null;
  /** Most recent delta-polling cycle across all mailboxes. */
  lastPollingRunAt: Date | null;
  /** Most recent subscription renewal across all subscriptions. */
  lastRenewalRunAt: Date | null;
  /** Sanitized + truncated most-recent mailbox error, or null. */
  lastErrorShort: string | null;
  overall: HealthLevel;
}

export interface HealthDashboardData {
  overview: HealthOverview;
  mailboxes: MailboxHealthRow[];
  /** Per-customer workload roll-up (scope-safe). */
  workload: CustomerWorkloadRow[];
  /**
   * System-wide operational checks (email worker, queue/Redis, …). Only built
   * for the unrestricted ('all') scope — STAFF_READ_ONLY receives an empty list
   * so global infrastructure signals never leak across the scope boundary.
   */
  operationalChecks: OperationalCheck[];
  /**
   * TASK-068C — queue backlog + worker latency + throttle/defer observability.
   * Global infrastructure signals, so this is only populated for OWNER/ADMIN
   * (unrestricted scope); STAFF_READ_ONLY always receives null.
   */
  infra: InfraObservability | null;
  /** True for OWNER/ADMIN; false when the data is narrowed to assigned scope. */
  isUnrestricted: boolean;
  generatedAt: Date;
}

export type HealthLoadResult =
  | { ok: true; data: HealthDashboardData }
  | { ok: false; message: string };
