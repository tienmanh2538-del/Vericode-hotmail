// TASK-035 — Alert service types.
//
// Shared, transport-agnostic shapes for operational alerts. An Alert describes
// *what went wrong* in a structured, sanitizer-friendly way; the message
// formatter + alert service decide how it reaches the admin Telegram group.
//
// SECURITY (docs/SECURITY_RULES.md): nothing in an Alert is trusted to be safe.
// Both `title` and every value in `context` are run through the alert sanitizer
// before they reach Telegram or the logger, so a caller can never leak an access
// token, refresh token, client secret, bot token, password, full verification
// code, or full email body — even by accident.

/** Severity ladder. Mirrors the health dashboard's OK/WARNING/CRITICAL idea. */
export type AlertSeverity = 'INFO' | 'WARNING' | 'CRITICAL';

/**
 * Stable identifiers for the operational failures worth paging an admin about.
 * Kept aligned with the health dashboard's operational checks (TASK-034).
 */
export type AlertType =
  | 'TELEGRAM_SEND_FAILED'
  | 'SUBSCRIPTION_RENEWAL_FAILED'
  | 'SUBSCRIPTION_EXPIRED'
  | 'DELTA_POLLING_FAILED'
  | 'HEALTH_CRITICAL';

export interface Alert {
  type: AlertType;
  severity: AlertSeverity;
  /** Short human-readable summary. Redacted before sending. */
  title: string;
  /**
   * Structured supporting context (e.g. mailboxId, attempts, failureReason).
   * Sanitized before it reaches Telegram/logs — sensitive keys are masked and
   * secret-shaped values are redacted, so callers may pass operational fields
   * freely without hand-masking each one.
   */
  context?: Record<string, unknown>;
}

/** Why an alert was not delivered. Never an exception — alerts never throw. */
export type AlertSkipReason = 'not_configured' | 'no_bot_token' | 'send_failed';

export type AlertDeliveryResult =
  | { delivered: true; chatId: string }
  | { delivered: false; reason: AlertSkipReason };

/** Default severity per alert type when a caller does not override it. */
export const DEFAULT_SEVERITY_BY_TYPE: Record<AlertType, AlertSeverity> = {
  TELEGRAM_SEND_FAILED: 'CRITICAL',
  SUBSCRIPTION_RENEWAL_FAILED: 'WARNING',
  SUBSCRIPTION_EXPIRED: 'CRITICAL',
  DELTA_POLLING_FAILED: 'WARNING',
  HEALTH_CRITICAL: 'CRITICAL',
};
