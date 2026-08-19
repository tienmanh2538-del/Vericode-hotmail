// Safe, in-memory code event log for TASK-015.
//
// This service intentionally does NOT touch the database schema and does NOT
// store the full verification code, full email body, or any token/secret. UI
// callers receive a masked code only — the full code never leaves the email
// processing pipeline.
//
// A future task (audit log, TASK-016) may replace the in-memory store with a
// Prisma-backed implementation. The shape of `CodeEventLogItem` is the public
// contract — keep changes additive.

export type CodeEventStatus =
  | 'CODE_DETECTED'
  | 'CODE_SENT'
  | 'CODE_SKIPPED_DUPLICATE'
  | 'CODE_SKIPPED_LOW_CONFIDENCE'
  // TASK-080 — the verification email was older than the max relay age at
  // processing time (e.g. drained from a backlog after a worker outage) and was
  // deliberately NOT relayed. The DB `CodeEvent.status` column is a free String,
  // so this needs no schema/migration.
  | 'CODE_SKIPPED_STALE'
  | 'DETECTOR_REJECTED'
  | 'EXTRACTOR_FAILED'
  | 'TELEGRAM_SEND_FAILED';

export type CodeEventPlatform = 'Facebook/Meta';

export type CodeEventSource = 'mock' | 'webhook' | 'polling';

export interface CodeEventLogItem {
  id: string;
  createdAt: string;
  receivedAt?: string;
  mailboxEmail: string;
  customerName?: string;
  platform: CodeEventPlatform;
  status: CodeEventStatus;
  maskedCode?: string;
  confidence?: number;
  telegramGroupName?: string;
  source: CodeEventSource;
  message?: string;
}

export interface CodeEventSummary {
  total: number;
  sent: number;
  skippedDuplicate: number;
  lowConfidence: number;
  failed: number;
  detected: number;
}

export interface RecordCodeEventInput {
  createdAt?: string | Date;
  receivedAt?: string | Date;
  mailboxEmail: string;
  customerName?: string;
  platform?: CodeEventPlatform;
  status: CodeEventStatus;
  // SECURITY: callers MUST pre-mask the verification code. Anything that looks
  // like a full numeric code is rejected (see assertSafeMaskedCode below).
  maskedCode?: string;
  confidence?: number;
  telegramGroupName?: string;
  source?: CodeEventSource;
  message?: string;
}

export interface CodeEventLogStore {
  list(): readonly CodeEventLogItem[];
  add(item: CodeEventLogItem): void;
  clear(): void;
}

const FAILED_STATUSES: ReadonlySet<CodeEventStatus> = new Set<CodeEventStatus>([
  'EXTRACTOR_FAILED',
  'DETECTOR_REJECTED',
  'TELEGRAM_SEND_FAILED',
]);

const FULL_NUMERIC_CODE = /^\d{4,}$/;
const SAFE_MASKED_CODE = /^(?:\*+|\d{1,3}\*{2,}|sha256:[a-f0-9]{4,64})$/i;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function toIsoString(value: string | Date | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return undefined;
  return date.toISOString();
}

function assertSafeMaskedCode(value: string): string {
  // Defence in depth: callers should already mask, but reject anything that
  // looks like a raw verification code so a bad caller cannot leak it.
  if (FULL_NUMERIC_CODE.test(value)) {
    throw new Error('code-event-log: refused to record full verification code');
  }
  if (!SAFE_MASKED_CODE.test(value)) {
    throw new Error('code-event-log: maskedCode must be a masked or hashed value');
  }
  return value;
}

function clampConfidence(value: number | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  if (value < 0) return 0;
  if (value > 100) return 100;
  return value;
}

let counter = 0;
function nextId(createdAtIso: string): string {
  counter += 1;
  return `cev_${createdAtIso}_${counter}`;
}

export function createInMemoryCodeEventLogStore(): CodeEventLogStore {
  const items: CodeEventLogItem[] = [];
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

// Module-level singleton used by the admin page in dev/mock flow. It lives in
// process memory only — restarting the server clears the log. A future task
// can swap this for a Prisma-backed store without changing call sites.
const defaultStore: CodeEventLogStore = createInMemoryCodeEventLogStore();

export function getDefaultCodeEventLogStore(): CodeEventLogStore {
  return defaultStore;
}

/**
 * A validated code event WITHOUT a generated id. Shared by the in-memory store
 * (counter id) and the DB store (Prisma-generated id). The masked code is
 * already proven safe (never a raw verification code) here.
 */
export type NormalizedCodeEvent = Omit<CodeEventLogItem, 'id'>;

export function normalizeCodeEventInput(
  input: RecordCodeEventInput,
): NormalizedCodeEvent {
  if (!isNonEmptyString(input?.mailboxEmail)) {
    throw new Error('code-event-log: mailboxEmail is required');
  }

  const createdAt = toIsoString(input.createdAt) ?? new Date().toISOString();
  const safeMaskedCode = isNonEmptyString(input.maskedCode)
    ? assertSafeMaskedCode(input.maskedCode.trim())
    : undefined;

  return {
    createdAt,
    receivedAt: toIsoString(input.receivedAt),
    mailboxEmail: input.mailboxEmail.trim(),
    customerName: isNonEmptyString(input.customerName)
      ? input.customerName.trim()
      : undefined,
    platform: input.platform ?? 'Facebook/Meta',
    status: input.status,
    maskedCode: safeMaskedCode,
    confidence: clampConfidence(input.confidence),
    telegramGroupName: isNonEmptyString(input.telegramGroupName)
      ? input.telegramGroupName.trim()
      : undefined,
    source: input.source ?? 'mock',
    message: isNonEmptyString(input.message) ? input.message.trim() : undefined,
  };
}

export function recordCodeEvent(
  input: RecordCodeEventInput,
  store: CodeEventLogStore = defaultStore,
): CodeEventLogItem {
  const normalized = normalizeCodeEventInput(input);
  const item: CodeEventLogItem = {
    id: nextId(normalized.createdAt),
    ...normalized,
  };

  store.add(item);
  return item;
}

function compareNewestFirst(a: CodeEventLogItem, b: CodeEventLogItem): number {
  if (a.createdAt === b.createdAt) return 0;
  return a.createdAt < b.createdAt ? 1 : -1;
}

export function listCodeEvents(
  store: CodeEventLogStore = defaultStore,
): CodeEventLogItem[] {
  return [...store.list()].sort(compareNewestFirst);
}

export function summarizeCodeEvents(
  items: readonly CodeEventLogItem[],
): CodeEventSummary {
  const summary: CodeEventSummary = {
    total: items.length,
    sent: 0,
    skippedDuplicate: 0,
    lowConfidence: 0,
    failed: 0,
    detected: 0,
  };
  for (const item of items) {
    switch (item.status) {
      case 'CODE_SENT':
        summary.sent += 1;
        break;
      case 'CODE_SKIPPED_DUPLICATE':
        summary.skippedDuplicate += 1;
        break;
      case 'CODE_SKIPPED_LOW_CONFIDENCE':
        summary.lowConfidence += 1;
        break;
      case 'CODE_DETECTED':
        summary.detected += 1;
        break;
      default:
        if (FAILED_STATUSES.has(item.status)) {
          summary.failed += 1;
        }
        break;
    }
  }
  return summary;
}

export const CODE_EVENT_STATUS_LABELS: Record<CodeEventStatus, string> = {
  CODE_DETECTED: 'Detected',
  CODE_SENT: 'Sent',
  CODE_SKIPPED_DUPLICATE: 'Skipped (duplicate)',
  CODE_SKIPPED_LOW_CONFIDENCE: 'Skipped (low confidence)',
  CODE_SKIPPED_STALE: 'Skipped (stale)',
  DETECTOR_REJECTED: 'Detector rejected',
  EXTRACTOR_FAILED: 'Extractor failed',
  TELEGRAM_SEND_FAILED: 'Telegram failed',
};
