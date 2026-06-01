import type {
  GraphSubscriptionStatusValue,
  MailboxListItem,
  MailboxStatusValue,
  TelegramMappingStatusValue,
} from '@/services/microsoft/mailbox-list.service';

// TASK-046 — pure, UI-free helpers for the mailbox list dashboard.
//
// All logic that powers search/filter/status lives here so it can be unit
// tested without a DOM. The table component is a thin presentation layer on
// top of these functions. SECURITY: these functions only ever NARROW the
// caller-supplied list (which is already scoped server-side by TASK-045). They
// never fetch, widen, or invent rows, so client-side filtering can never leak
// data outside a staff member's assignment scope.

/**
 * Derived operational readiness of a mailbox, computed from fields the list
 * service already returns (no new data, no migration). Higher-priority problem
 * states win over "needs mapping" / "ready" so the worst signal is surfaced.
 */
export type MailboxReadiness =
  | 'READY'
  | 'NEEDS_CUSTOMER'
  | 'NEEDS_MAPPING'
  | 'TOKEN_ISSUE'
  | 'SUBSCRIPTION_ISSUE'
  | 'WEBHOOK_ISSUE'
  | 'DISABLED'
  | 'ERROR';

export const READINESS_LABEL: Record<MailboxReadiness, string> = {
  READY: 'Ready',
  // TASK-047 — a connected mailbox with no customer is NOT ready to relay codes.
  NEEDS_CUSTOMER: 'Needs customer',
  NEEDS_MAPPING: 'Needs mapping',
  TOKEN_ISSUE: 'Token issue',
  SUBSCRIPTION_ISSUE: 'Subscription issue',
  WEBHOOK_ISSUE: 'Webhook issue',
  DISABLED: 'Disabled',
  ERROR: 'Error',
};

// Order shown in the readiness filter dropdown. Onboarding gaps (customer, then
// mapping) follow Ready; operational problems come last.
export const READINESS_ORDER: readonly MailboxReadiness[] = [
  'READY',
  'NEEDS_CUSTOMER',
  'NEEDS_MAPPING',
  'TOKEN_ISSUE',
  'SUBSCRIPTION_ISSUE',
  'WEBHOOK_ISSUE',
  'DISABLED',
  'ERROR',
];

const ALL = 'ALL' as const;
export type AllOption = typeof ALL;
export const ALL_OPTION: AllOption = ALL;

/**
 * Human label used both in the Customer column and for the customer filter.
 * Falls back to the denormalised ownerCustomerName, then a dash.
 */
export function mailboxCustomerLabel(item: MailboxListItem): string {
  return item.customerName ?? item.ownerCustomerName ?? '—';
}

/**
 * Minimal shape needed to compute readiness. `MailboxListItem` satisfies it, and
 * the mailbox detail page builds the same shape from its richer data, so list
 * and detail share ONE definition of "is this mailbox ready?" (TASK-047).
 */
export interface MailboxReadinessInput {
  status: MailboxStatusValue;
  customerName: string | null;
  ownerCustomerName: string | null;
  telegramMappingStatus: TelegramMappingStatusValue | null;
  subscriptionStatus: GraphSubscriptionStatusValue | null;
}

/** True when the mailbox is attached to a customer (joined or denormalised). */
export function mailboxHasCustomer(input: {
  customerName: string | null;
  ownerCustomerName: string | null;
}): boolean {
  return Boolean(input.customerName ?? input.ownerCustomerName);
}

function hasActiveMapping(input: MailboxReadinessInput): boolean {
  return input.telegramMappingStatus === 'ACTIVE';
}

/**
 * Derive a single readiness signal. Problem states (token/subscription/webhook/
 * error/disabled) take precedence so a broken mailbox is never mislabelled
 * "Ready". TASK-047: a mailbox is only READY when it is ACTIVE, attached to a
 * customer, AND has an active Telegram destination — otherwise it surfaces the
 * specific onboarding gap (Needs customer / Needs mapping). Only data already
 * present on the input is used (no new columns, no migration).
 */
export function deriveMailboxReadiness(
  input: MailboxReadinessInput,
): MailboxReadiness {
  switch (input.status) {
    case 'DISABLED':
      return 'DISABLED';
    case 'RECONNECT_REQUIRED':
      return 'TOKEN_ISSUE';
    case 'SUBSCRIPTION_EXPIRED':
      return 'SUBSCRIPTION_ISSUE';
    case 'WEBHOOK_FAILED':
      return 'WEBHOOK_ISSUE';
    case 'ERROR':
      return 'ERROR';
    default:
      break;
  }

  // status === 'ACTIVE'. A degraded Graph subscription is still worth flagging
  // even when the mailbox row itself is ACTIVE.
  if (
    input.subscriptionStatus === 'EXPIRED' ||
    input.subscriptionStatus === 'FAILED'
  ) {
    return 'SUBSCRIPTION_ISSUE';
  }

  if (!mailboxHasCustomer(input)) return 'NEEDS_CUSTOMER';

  return hasActiveMapping(input) ? 'READY' : 'NEEDS_MAPPING';
}

export interface MailboxListFilters {
  /** Free-text search over email + customer label. */
  query: string;
  /** Customer label to match exactly, or ALL. */
  customer: string | AllOption;
  /** Raw mailbox status to match, or ALL. */
  status: MailboxStatusValue | AllOption;
  /** Derived readiness to match, or ALL. */
  readiness: MailboxReadiness | AllOption;
}

export const EMPTY_FILTERS: MailboxListFilters = {
  query: '',
  customer: ALL,
  status: ALL,
  readiness: ALL,
};

function matchesQuery(item: MailboxListItem, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (needle.length === 0) return true;
  const haystack = `${item.emailAddress} ${mailboxCustomerLabel(item)}`.toLowerCase();
  return haystack.includes(needle);
}

/**
 * Narrow a (server-scoped) list by the active filters. Pure: returns a new
 * array that is always a subset of `items` in the same order.
 */
export function filterMailboxes(
  items: readonly MailboxListItem[],
  filters: MailboxListFilters,
): MailboxListItem[] {
  return items.filter((item) => {
    if (!matchesQuery(item, filters.query)) return false;
    if (filters.customer !== ALL && mailboxCustomerLabel(item) !== filters.customer) {
      return false;
    }
    if (filters.status !== ALL && item.status !== filters.status) return false;
    if (
      filters.readiness !== ALL &&
      deriveMailboxReadiness(item) !== filters.readiness
    ) {
      return false;
    }
    return true;
  });
}

/** Distinct customer labels present in the list, sorted for a stable dropdown. */
export function collectCustomerOptions(
  items: readonly MailboxListItem[],
): string[] {
  const labels = new Set<string>();
  for (const item of items) {
    labels.add(mailboxCustomerLabel(item));
  }
  return Array.from(labels).sort((a, b) => a.localeCompare(b));
}

/** Distinct raw statuses present in the list, sorted for a stable dropdown. */
export function collectStatusOptions(
  items: readonly MailboxListItem[],
): MailboxStatusValue[] {
  const values = new Set<MailboxStatusValue>();
  for (const item of items) {
    values.add(item.status);
  }
  return Array.from(values).sort((a, b) => a.localeCompare(b));
}
