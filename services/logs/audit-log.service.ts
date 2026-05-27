// Safe, in-memory audit log service for TASK-016.
//
// Audit logs trace admin/system actions (who, what, on which entity, when).
// This service intentionally does NOT touch the Prisma schema; like the code
// event log from TASK-015, it lives in process memory. A later DB-backed
// implementation can replace this without changing call sites — the public
// shapes (CreateAuditLogInput, AuditLogListItem) are the contract.
//
// SECURITY:
//   - Metadata is always sanitized before storage; sensitive fields are
//     replaced with the literal string "[REDACTED]".
//   - The service never accepts or stores tokens, secrets, passwords, full
//     verification codes, cookies, or authorization headers.

export type AuditLogAction =
  | 'CUSTOMER_CREATED'
  | 'CUSTOMER_UPDATED'
  | 'CUSTOMER_DELETED'
  | 'TELEGRAM_MAPPING_CREATED'
  | 'TELEGRAM_MAPPING_UPDATED'
  | 'TELEGRAM_MAPPING_DELETED'
  | 'TELEGRAM_TEST_SEND_REQUESTED'
  | 'TELEGRAM_TEST_SEND_SUCCEEDED'
  | 'TELEGRAM_TEST_SEND_FAILED'
  | 'CODE_DETECTED'
  | 'CODE_SENT'
  | 'CODE_SKIPPED_LOW_CONFIDENCE'
  | 'CODE_DUPLICATE_SKIPPED'
  | 'MAILBOX_CONNECTED'
  | 'MAILBOX_DISCONNECTED'
  | 'MAILBOX_RECONNECT_REQUIRED'
  | 'SUBSCRIPTION_RENEWED'
  | 'TOKEN_REFRESH_FAILED'
  | 'ADMIN_LOGIN'
  | 'ADMIN_LOGOUT'
  | 'SYSTEM_ERROR';

export type AuditLogEntityType =
  | 'customer'
  | 'mailbox'
  | 'telegram_mapping'
  | 'code_event'
  | 'subscription'
  | 'user'
  | 'system';

export type AuditLogSeverity = 'info' | 'notice' | 'warning' | 'error';

export type AuditLogMetadata = Record<string, unknown>;

export interface CreateAuditLogInput {
  action: AuditLogAction;
  entityType: AuditLogEntityType;
  entityId?: string | null;
  actorUserId?: string | null;
  actorEmail?: string | null;
  ipAddress?: string | null;
  severity?: AuditLogSeverity;
  summary?: string | null;
  metadata?: AuditLogMetadata | null;
  createdAt?: string | Date;
}

export interface AuditLogListItem {
  id: string;
  createdAt: string;
  action: AuditLogAction;
  entityType: AuditLogEntityType;
  entityId: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  ipAddress: string | null;
  severity: AuditLogSeverity;
  summary: string | null;
  metadata: AuditLogMetadata | null;
}

export interface AuditLogListFilters {
  action?: AuditLogAction;
  entityType?: AuditLogEntityType;
  entityId?: string;
  search?: string;
  from?: string | Date;
  to?: string | Date;
  limit?: number;
}

export interface AuditLogListResult {
  items: AuditLogListItem[];
  total: number;
  appliedFilters: AuditLogListFilters;
}

export interface AuditLogStore {
  list(): readonly AuditLogListItem[];
  add(item: AuditLogListItem): void;
  clear(): void;
}

// ---------------------------------------------------------------------------
// Sanitization
// ---------------------------------------------------------------------------

// Field names that must never reach storage or the UI. Match is
// case-insensitive and ignores common separators (snake/kebab/space) so a key
// like "Access-Token" or "access_token" is treated the same as "accessToken".
const SENSITIVE_FIELD_NAMES: readonly string[] = [
  'password',
  'token',
  'accessToken',
  'refreshToken',
  'clientSecret',
  'secret',
  'telegramBotToken',
  'code',
  'verificationCode',
  'otp',
  'authorization',
  'cookie',
];

const REDACTED = '[REDACTED]';
const MAX_SANITIZE_DEPTH = 6;

function normalizeKey(key: string): string {
  return key.replace(/[-_\s]+/g, '').toLowerCase();
}

const SENSITIVE_KEY_SET: ReadonlySet<string> = new Set(
  SENSITIVE_FIELD_NAMES.map(normalizeKey),
);

function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_SET.has(normalizeKey(key));
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_SANITIZE_DEPTH) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    return sanitizeObject(value as Record<string, unknown>, depth + 1);
  }
  // Functions, symbols, bigints, etc. — drop to keep metadata JSON-safe.
  return undefined;
}

function sanitizeObject(
  input: Record<string, unknown>,
  depth: number,
): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(input)) {
    if (isSensitiveKey(key)) {
      output[key] = REDACTED;
      continue;
    }
    const cleaned = sanitizeValue(raw, depth);
    if (cleaned !== undefined) {
      output[key] = cleaned;
    }
  }
  return output;
}

export function sanitizeAuditMetadata(
  metadata: AuditLogMetadata | null | undefined,
): AuditLogMetadata | null {
  if (metadata === null || metadata === undefined) return null;
  if (typeof metadata !== 'object' || Array.isArray(metadata)) {
    return null;
  }
  return sanitizeObject(metadata as Record<string, unknown>, 0);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function toIsoString(value: string | Date | undefined | null): string | undefined {
  if (value === undefined || value === null) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

let counter = 0;
function nextId(createdAtIso: string): string {
  counter += 1;
  return `aud_${createdAtIso}_${counter}`;
}

function isAuditLogAction(value: unknown): value is AuditLogAction {
  return typeof value === 'string' && AUDIT_LOG_ACTIONS.has(value as AuditLogAction);
}

function isAuditLogEntityType(value: unknown): value is AuditLogEntityType {
  return (
    typeof value === 'string' && AUDIT_LOG_ENTITY_TYPES.has(value as AuditLogEntityType)
  );
}

// ---------------------------------------------------------------------------
// Public constants (used by UI + tests)
// ---------------------------------------------------------------------------

export const AUDIT_LOG_ACTIONS: ReadonlySet<AuditLogAction> = new Set<AuditLogAction>([
  'CUSTOMER_CREATED',
  'CUSTOMER_UPDATED',
  'CUSTOMER_DELETED',
  'TELEGRAM_MAPPING_CREATED',
  'TELEGRAM_MAPPING_UPDATED',
  'TELEGRAM_MAPPING_DELETED',
  'TELEGRAM_TEST_SEND_REQUESTED',
  'TELEGRAM_TEST_SEND_SUCCEEDED',
  'TELEGRAM_TEST_SEND_FAILED',
  'CODE_DETECTED',
  'CODE_SENT',
  'CODE_SKIPPED_LOW_CONFIDENCE',
  'CODE_DUPLICATE_SKIPPED',
  'MAILBOX_CONNECTED',
  'MAILBOX_DISCONNECTED',
  'MAILBOX_RECONNECT_REQUIRED',
  'SUBSCRIPTION_RENEWED',
  'TOKEN_REFRESH_FAILED',
  'ADMIN_LOGIN',
  'ADMIN_LOGOUT',
  'SYSTEM_ERROR',
]);

export const AUDIT_LOG_ENTITY_TYPES: ReadonlySet<AuditLogEntityType> = new Set<AuditLogEntityType>([
  'customer',
  'mailbox',
  'telegram_mapping',
  'code_event',
  'subscription',
  'user',
  'system',
]);

export const AUDIT_LOG_ACTION_LABELS: Record<AuditLogAction, string> = {
  CUSTOMER_CREATED: 'Customer created',
  CUSTOMER_UPDATED: 'Customer updated',
  CUSTOMER_DELETED: 'Customer deleted',
  TELEGRAM_MAPPING_CREATED: 'Telegram mapping created',
  TELEGRAM_MAPPING_UPDATED: 'Telegram mapping updated',
  TELEGRAM_MAPPING_DELETED: 'Telegram mapping deleted',
  TELEGRAM_TEST_SEND_REQUESTED: 'Telegram test-send requested',
  TELEGRAM_TEST_SEND_SUCCEEDED: 'Telegram test-send succeeded',
  TELEGRAM_TEST_SEND_FAILED: 'Telegram test-send failed',
  CODE_DETECTED: 'Code detected',
  CODE_SENT: 'Code sent',
  CODE_SKIPPED_LOW_CONFIDENCE: 'Code skipped (low confidence)',
  CODE_DUPLICATE_SKIPPED: 'Code skipped (duplicate)',
  MAILBOX_CONNECTED: 'Mailbox connected',
  MAILBOX_DISCONNECTED: 'Mailbox disconnected',
  MAILBOX_RECONNECT_REQUIRED: 'Mailbox reconnect required',
  SUBSCRIPTION_RENEWED: 'Subscription renewed',
  TOKEN_REFRESH_FAILED: 'Token refresh failed',
  ADMIN_LOGIN: 'Admin login',
  ADMIN_LOGOUT: 'Admin logout',
  SYSTEM_ERROR: 'System error',
};

const DEFAULT_SEVERITY: AuditLogSeverity = 'info';
const SEVERITY_BY_ACTION: Partial<Record<AuditLogAction, AuditLogSeverity>> = {
  TELEGRAM_TEST_SEND_FAILED: 'error',
  CODE_SKIPPED_LOW_CONFIDENCE: 'notice',
  CODE_DUPLICATE_SKIPPED: 'notice',
  MAILBOX_RECONNECT_REQUIRED: 'warning',
  MAILBOX_DISCONNECTED: 'warning',
  TOKEN_REFRESH_FAILED: 'error',
  SYSTEM_ERROR: 'error',
};

function defaultSeverityFor(action: AuditLogAction): AuditLogSeverity {
  return SEVERITY_BY_ACTION[action] ?? DEFAULT_SEVERITY;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export function createInMemoryAuditLogStore(): AuditLogStore {
  const items: AuditLogListItem[] = [];
  return {
    list() {
      return items;
    },
    add(item) {
      items.push(item);
    },
    clear() {
      items.length = 0;
    },
  };
}

const defaultStore: AuditLogStore = createInMemoryAuditLogStore();

export function getDefaultAuditLogStore(): AuditLogStore {
  return defaultStore;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function createAuditLog(
  input: CreateAuditLogInput,
  store: AuditLogStore = defaultStore,
): AuditLogListItem {
  if (!isAuditLogAction(input?.action)) {
    throw new Error('audit-log: action is required and must be a known AuditLogAction');
  }
  if (!isAuditLogEntityType(input?.entityType)) {
    throw new Error(
      'audit-log: entityType is required and must be a known AuditLogEntityType',
    );
  }

  const createdAt = toIsoString(input.createdAt) ?? new Date().toISOString();
  const sanitizedMetadata = sanitizeAuditMetadata(input.metadata ?? null);

  const item: AuditLogListItem = {
    id: nextId(createdAt),
    createdAt,
    action: input.action,
    entityType: input.entityType,
    entityId: isNonEmptyString(input.entityId) ? input.entityId.trim() : null,
    actorUserId: isNonEmptyString(input.actorUserId) ? input.actorUserId.trim() : null,
    actorEmail: isNonEmptyString(input.actorEmail) ? input.actorEmail.trim() : null,
    ipAddress: isNonEmptyString(input.ipAddress) ? input.ipAddress.trim() : null,
    severity: input.severity ?? defaultSeverityFor(input.action),
    summary: isNonEmptyString(input.summary) ? input.summary.trim() : null,
    metadata: sanitizedMetadata,
  };

  store.add(item);
  return item;
}

function compareNewestFirst(a: AuditLogListItem, b: AuditLogListItem): number {
  if (a.createdAt === b.createdAt) return 0;
  return a.createdAt < b.createdAt ? 1 : -1;
}

function matchesFilters(
  item: AuditLogListItem,
  filters: AuditLogListFilters,
  fromIso: string | undefined,
  toIso: string | undefined,
): boolean {
  if (filters.action && item.action !== filters.action) return false;
  if (filters.entityType && item.entityType !== filters.entityType) return false;
  if (filters.entityId && item.entityId !== filters.entityId) return false;
  if (fromIso && item.createdAt < fromIso) return false;
  if (toIso && item.createdAt > toIso) return false;

  if (isNonEmptyString(filters.search)) {
    const needle = filters.search.trim().toLowerCase();
    const haystack = [
      item.action,
      item.entityType,
      item.entityId ?? '',
      item.actorEmail ?? '',
      item.actorUserId ?? '',
      item.summary ?? '',
      item.ipAddress ?? '',
    ]
      .join(' ')
      .toLowerCase();
    if (!haystack.includes(needle)) return false;
  }

  return true;
}

export function listAuditLogs(
  filters: AuditLogListFilters = {},
  store: AuditLogStore = defaultStore,
): AuditLogListResult {
  const fromIso = toIsoString(filters.from);
  const toIso = toIsoString(filters.to);

  const all = [...store.list()].sort(compareNewestFirst);
  const filtered = all.filter((item) => matchesFilters(item, filters, fromIso, toIso));

  const limit =
    typeof filters.limit === 'number' && Number.isFinite(filters.limit) && filters.limit > 0
      ? Math.min(Math.floor(filters.limit), 1000)
      : undefined;

  const items = limit ? filtered.slice(0, limit) : filtered;

  return {
    items,
    total: filtered.length,
    appliedFilters: { ...filters },
  };
}
