import { randomUUID } from 'node:crypto';

import { hashSensitiveValue } from '@/lib/security/redact';

import {
  DELIVERY_LEASE_MS,
  DELIVERY_OWNERSHIP_POLL_MS,
  MAX_DELIVERY_ATTEMPTS,
} from './delivery-ownership-policy';

// TASK-068A — raised by a `ProcessedMessageStore.create` when the underlying
// store rejects the insert because a row for the SAME (mailboxId, graphMessageId)
// already exists. The Prisma-backed store maps a P2002 unique-constraint
// violation onto this; the in-memory store enforces the same invariant. It lets
// `claimMessageForProcessing` turn a lost race (webhook vs delta polling, or two
// worker replicas) into a clean duplicate skip instead of an unhandled throw.
export class ProcessedMessageDuplicateError extends Error {
  constructor() {
    super('ProcessedMessage already exists for this mailbox/graphMessageId');
    this.name = 'ProcessedMessageDuplicateError';
  }
}

export function isProcessedMessageDuplicateError(err: unknown): boolean {
  return err instanceof ProcessedMessageDuplicateError;
}

export type DeduplicationInput = {
  mailboxId: string;
  graphMessageId?: string | null;
  internetMessageId?: string | null;
  receivedAt?: Date | string | null;
  senderEmail?: string | null;
  subject?: string | null;
  verificationCode?: string | null;
};

export type DeduplicationReason =
  | 'NEW_MESSAGE'
  | 'DUPLICATE_GRAPH_MESSAGE_ID'
  | 'DUPLICATE_INTERNET_MESSAGE_ID'
  | 'DUPLICATE_CODE_TIME_BUCKET'
  | 'INVALID_INPUT';

export type DeduplicationResult = {
  shouldProcess: boolean;
  isDuplicate: boolean;
  reason: DeduplicationReason;
  processedMessageId?: string;
  dedupeKey?: string;
  // TASK-090 — when a fresh identity claim succeeds, the winner also holds the
  // initial delivery-ownership lease under this opaque token. All completion
  // writes (markSent / markFailed) must be fenced on it.
  deliveryOwnerToken?: string;
};

export type ProcessedMessageStatus =
  | 'DETECTED'
  | 'SENT'
  | 'FAILED'
  | 'SKIPPED_LOW_CONFIDENCE'
  | 'DUPLICATE';

export type ProcessedMessageRecord = {
  id: string;
  mailboxId: string;
  graphMessageId: string;
  internetMessageId: string | null;
  codeHash: string | null;
  receivedAt: Date;
  receivedAtBucket: string | null;
  senderEmail: string | null;
  subjectHash: string | null;
  status: ProcessedMessageStatus;
  sentToTelegramAt: Date | null;
  // TASK-090 — delivery-ownership state (see prisma/schema.prisma).
  deliveryAttempts: number;
  deliveryLeaseUntil: Date | null;
  deliveryOwner: string | null;
  deliveryFailureReason: string | null;
  createdAt: Date;
};

export type CreateProcessedMessageInput = {
  mailboxId: string;
  graphMessageId: string;
  internetMessageId: string | null;
  codeHash: string | null;
  receivedAt: Date;
  receivedAtBucket: string | null;
  senderEmail: string | null;
  subjectHash: string | null;
  // TASK-090 — optional initial delivery ownership, written atomically with the
  // identity-claim INSERT so the claim winner is also the first delivery owner.
  // Omitted (legacy/mock callers) ⇒ attempts 0, no lease, no owner.
  deliveryOwner?: string | null;
  deliveryLeaseUntil?: Date | null;
  deliveryAttempts?: number;
};

// TASK-090 — atomic delivery-ownership claim input. The store MUST apply this
// as ONE conditional write (CAS): claim succeeds only when the row is still
// DETECTED, the current lease is absent/expired at `now`, and the attempt
// budget is not exhausted. On success the store sets owner + lease and
// increments `deliveryAttempts` in the same write.
export type ClaimDeliveryInput = {
  processedMessageId: string;
  ownerToken: string;
  now: Date;
  leaseUntil: Date;
  maxAttempts: number;
};

// TASK-090 — conditional terminal-FAILED write for a row nobody currently
// owns (lease absent/expired at `now`). Used to terminalize exhausted or stale
// rows without stealing a live owner's state. `minAttempts` (when set) guards
// the budget-exhausted transition.
export type MarkFailedIfUnclaimedInput = {
  processedMessageId: string;
  reason: string;
  now: Date;
  minAttempts?: number;
};

export interface ProcessedMessageStore {
  findById(processedMessageId: string): Promise<ProcessedMessageRecord | null>;
  findByGraphMessageId(
    mailboxId: string,
    graphMessageId: string,
  ): Promise<ProcessedMessageRecord | null>;
  findByInternetMessageId(
    mailboxId: string,
    internetMessageId: string,
  ): Promise<ProcessedMessageRecord | null>;
  findByCodeBucket(
    mailboxId: string,
    codeHash: string,
    receivedAtBucket: string,
  ): Promise<ProcessedMessageRecord | null>;
  create(input: CreateProcessedMessageInput): Promise<ProcessedMessageRecord>;
  /**
   * TASK-090 — mark the row SENT. When `ownerToken` is provided the write is
   * conditional on the row still carrying that delivery-owner token (CAS
   * fencing: a stale owner must never overwrite a newer owner's state).
   * Returns true when a row was updated, false when ownership was lost or the
   * row is gone. Without a token (legacy mock flow, which has no concurrent
   * delivery claimants) the write is unconditional by id.
   */
  markSent(
    processedMessageId: string,
    sentAt: Date,
    ownerToken?: string,
  ): Promise<boolean>;
  /** TASK-090 — atomic delivery-ownership CAS claim. True ⇔ claim won. */
  claimDelivery(input: ClaimDeliveryInput): Promise<boolean>;
  /**
   * TASK-090 — release the lease after a KNOWN-failed (retryable) attempt so
   * the next BullMQ attempt can reclaim immediately instead of waiting out the
   * lease. Conditional on owner token + status DETECTED; attempts are kept.
   */
  releaseDelivery(
    processedMessageId: string,
    ownerToken: string,
  ): Promise<boolean>;
  /**
   * TASK-090 — terminal FAILED written by the CURRENT owner (permanent
   * Telegram failure, or stale detected after ownership was acquired).
   * Conditional on owner token + status DETECTED.
   */
  markFailedByOwner(
    processedMessageId: string,
    ownerToken: string,
    reason: string,
  ): Promise<boolean>;
  /** TASK-090 — see MarkFailedIfUnclaimedInput. */
  markFailedIfUnclaimed(input: MarkFailedIfUnclaimedInput): Promise<boolean>;
}

export const DEFAULT_BUCKET_MINUTES = 5;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function normalizeMessageId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  let s = value.trim();
  if (s.length === 0) return null;
  if (s.startsWith('<') && s.endsWith('>')) {
    s = s.slice(1, -1).trim();
  }
  if (s.length === 0) return null;
  return s;
}

export function roundReceivedAtToBucket(
  receivedAt: Date | string | null | undefined,
  bucketMinutes: number = DEFAULT_BUCKET_MINUTES,
): string | null {
  if (receivedAt === null || receivedAt === undefined) return null;
  if (!Number.isFinite(bucketMinutes) || bucketMinutes <= 0) return null;
  const date = receivedAt instanceof Date ? receivedAt : new Date(receivedAt);
  const ms = date.getTime();
  if (!Number.isFinite(ms) || Number.isNaN(ms)) return null;
  const bucketMs = bucketMinutes * 60 * 1000;
  const rounded = Math.floor(ms / bucketMs) * bucketMs;
  return new Date(rounded).toISOString();
}

function hashCode(verificationCode: string): string {
  return hashSensitiveValue(verificationCode);
}

function hashSubject(subject: string): string {
  return hashSensitiveValue(subject);
}

function normalizeSenderEmail(value: unknown): string | null {
  if (!isNonEmptyString(value)) return null;
  return value.trim().toLowerCase();
}

export function buildProcessedMessageDedupeKey(
  input: DeduplicationInput,
): string {
  if (!input || typeof input !== 'object') return '';
  const mailboxId = isNonEmptyString(input.mailboxId)
    ? input.mailboxId.trim()
    : '';
  if (!mailboxId) return '';

  const gmid = normalizeMessageId(input.graphMessageId);
  if (gmid) return `${mailboxId}|gmid|${gmid}`;

  const imid = normalizeMessageId(input.internetMessageId);
  if (imid) return `${mailboxId}|imid|${imid}`;

  const code = isNonEmptyString(input.verificationCode)
    ? input.verificationCode.trim()
    : null;
  const bucket = roundReceivedAtToBucket(input.receivedAt);
  if (code && bucket) {
    return `${mailboxId}|code|${hashCode(code)}|${bucket}`;
  }
  return '';
}

function invalidInputResult(): DeduplicationResult {
  return {
    shouldProcess: false,
    isDuplicate: false,
    reason: 'INVALID_INPUT',
  };
}

type ValidatedInput = {
  mailboxId: string;
  graphMessageId: string | null;
  internetMessageId: string | null;
  codeHash: string | null;
  receivedAtDate: Date | null;
  receivedAtBucket: string | null;
  senderEmail: string | null;
  subjectHash: string | null;
};

function validateInput(input: DeduplicationInput): ValidatedInput | null {
  if (!input || typeof input !== 'object') return null;
  if (!isNonEmptyString(input.mailboxId)) return null;

  const mailboxId = input.mailboxId.trim();
  const graphMessageId = normalizeMessageId(input.graphMessageId);
  const internetMessageId = normalizeMessageId(input.internetMessageId);

  const code = isNonEmptyString(input.verificationCode)
    ? input.verificationCode.trim()
    : null;

  let receivedAtDate: Date | null = null;
  if (input.receivedAt !== null && input.receivedAt !== undefined) {
    const d =
      input.receivedAt instanceof Date
        ? input.receivedAt
        : new Date(input.receivedAt);
    if (!Number.isNaN(d.getTime())) {
      receivedAtDate = d;
    }
  }

  const receivedAtBucket = receivedAtDate
    ? roundReceivedAtToBucket(receivedAtDate)
    : null;

  const codeHash = code ? hashCode(code) : null;
  const hasCodeAndBucket = codeHash !== null && receivedAtBucket !== null;

  if (!graphMessageId && !internetMessageId && !hasCodeAndBucket) {
    return null;
  }

  return {
    mailboxId,
    graphMessageId,
    internetMessageId,
    codeHash,
    receivedAtDate,
    receivedAtBucket,
    senderEmail: normalizeSenderEmail(input.senderEmail),
    subjectHash: isNonEmptyString(input.subject)
      ? hashSubject(input.subject.trim())
      : null,
  };
}

function duplicateResult(
  reason: Exclude<DeduplicationReason, 'NEW_MESSAGE' | 'INVALID_INPUT'>,
  existing: ProcessedMessageRecord,
  dedupeKey: string,
): DeduplicationResult {
  return {
    shouldProcess: false,
    isDuplicate: true,
    reason,
    processedMessageId: existing.id,
    dedupeKey,
  };
}

export async function checkProcessedMessageDuplicate(
  input: DeduplicationInput,
  store: ProcessedMessageStore,
): Promise<DeduplicationResult> {
  const validated = validateInput(input);
  if (!validated) return invalidInputResult();

  const { mailboxId, graphMessageId, internetMessageId, codeHash, receivedAtBucket } =
    validated;

  if (graphMessageId) {
    const existing = await store.findByGraphMessageId(mailboxId, graphMessageId);
    if (existing) {
      return duplicateResult(
        'DUPLICATE_GRAPH_MESSAGE_ID',
        existing,
        `${mailboxId}|gmid|${graphMessageId}`,
      );
    }
  }

  if (internetMessageId) {
    const existing = await store.findByInternetMessageId(
      mailboxId,
      internetMessageId,
    );
    if (existing) {
      return duplicateResult(
        'DUPLICATE_INTERNET_MESSAGE_ID',
        existing,
        `${mailboxId}|imid|${internetMessageId}`,
      );
    }
  }

  if (codeHash && receivedAtBucket) {
    const existing = await store.findByCodeBucket(
      mailboxId,
      codeHash,
      receivedAtBucket,
    );
    if (existing) {
      return duplicateResult(
        'DUPLICATE_CODE_TIME_BUCKET',
        existing,
        `${mailboxId}|code|${codeHash}|${receivedAtBucket}`,
      );
    }
  }

  return {
    shouldProcess: true,
    isDuplicate: false,
    reason: 'NEW_MESSAGE',
    dedupeKey: buildProcessedMessageDedupeKey(input),
  };
}

// TASK-090 — options for the identity claim. The claim winner now also takes
// the INITIAL delivery-ownership lease atomically with the INSERT, so there is
// never a DETECTED row that is "unowned but mid-flight" between claim and send.
export type ClaimMessageOptions = {
  now?: () => Date;
  leaseMs?: number;
  /** Injectable for deterministic tests; defaults to a random UUID. */
  ownerToken?: string;
};

export async function claimMessageForProcessing(
  input: DeduplicationInput,
  store: ProcessedMessageStore,
  options: ClaimMessageOptions = {},
): Promise<DeduplicationResult> {
  const validated = validateInput(input);
  if (!validated) return invalidInputResult();

  const check = await checkProcessedMessageDuplicate(input, store);
  if (!check.shouldProcess) return check;

  const {
    mailboxId,
    graphMessageId,
    internetMessageId,
    codeHash,
    receivedAtDate,
    receivedAtBucket,
    senderEmail,
    subjectHash,
  } = validated;

  // Prisma ProcessedMessage requires graphMessageId. If absent, synthesize a
  // deterministic id from the remaining identifiers so a same-input retry still
  // hits the unique constraint instead of inserting a second row.
  const effectiveGraphMessageId =
    graphMessageId ??
    (internetMessageId ? `synthetic:imid:${internetMessageId}` : null) ??
    (codeHash && receivedAtBucket
      ? `synthetic:code:${codeHash}:${receivedAtBucket}`
      : null);

  if (!effectiveGraphMessageId) return invalidInputResult();

  // TASK-090 — the identity-claim INSERT doubles as the FIRST delivery-
  // ownership claim: owner token + lease + attempts=1 are written atomically
  // with the row, so the winner may proceed straight to the send path.
  const now = options.now ?? (() => new Date());
  const leaseMs = options.leaseMs ?? DELIVERY_LEASE_MS;
  const ownerToken = options.ownerToken ?? randomUUID();

  let record: ProcessedMessageRecord;
  try {
    record = await store.create({
      mailboxId,
      graphMessageId: effectiveGraphMessageId,
      internetMessageId,
      codeHash,
      receivedAt: receivedAtDate ?? new Date(),
      receivedAtBucket,
      senderEmail,
      subjectHash,
      deliveryOwner: ownerToken,
      deliveryLeaseUntil: new Date(now().getTime() + leaseMs),
      deliveryAttempts: 1,
    });
  } catch (err) {
    // TASK-068A — exactly-once backstop. The duplicate check above passed, but a
    // concurrent flow (webhook vs delta polling, or a second worker replica)
    // inserted the SAME message between our check and our insert. The store's
    // unique constraint rejects our insert; treat it as a clean duplicate skip so
    // the caller does NOT relay a second time and the worker does NOT retry a
    // message another flow already owns. Never re-throw a duplicate. No raw code
    // or email body is touched here.
    if (isProcessedMessageDuplicateError(err)) {
      const settled = await checkProcessedMessageDuplicate(input, store);
      if (settled.isDuplicate) return settled;
      const existing = await store.findByGraphMessageId(
        mailboxId,
        effectiveGraphMessageId,
      );
      return {
        shouldProcess: false,
        isDuplicate: true,
        reason: 'DUPLICATE_GRAPH_MESSAGE_ID',
        processedMessageId: existing?.id,
        dedupeKey: buildProcessedMessageDedupeKey(input),
      };
    }
    throw err;
  }

  return {
    shouldProcess: true,
    isDuplicate: false,
    reason: 'NEW_MESSAGE',
    processedMessageId: record.id,
    dedupeKey: buildProcessedMessageDedupeKey(input),
    deliveryOwnerToken: ownerToken,
  };
}

/**
 * TASK-090 — mark SENT, fenced on the delivery-owner token when supplied.
 * Returns false when the write matched no row (ownership lost to a newer
 * claimant, or row missing) — the caller must NOT retry the external side
 * effect in that case.
 */
export async function markMessageAsSent(
  processedMessageId: string,
  store: ProcessedMessageStore,
  sentAt?: Date,
  ownerToken?: string,
): Promise<boolean> {
  if (!isNonEmptyString(processedMessageId)) {
    throw new Error('processedMessageId is required');
  }
  return store.markSent(
    processedMessageId.trim(),
    sentAt ?? new Date(),
    ownerToken,
  );
}

// ---------------------------------------------------------------------------
// TASK-090 — delivery-ownership acquisition for an EXISTING row
// ---------------------------------------------------------------------------

/**
 * A row is delivery-recoverable when its identity was claimed but delivery
 * never reached a terminal outcome. SENT and FAILED are terminal; every other
 * status (today only DETECTED is ever written) is recoverable.
 */
export function isDeliveryRecoverableRow(
  record: Pick<ProcessedMessageRecord, 'status'>,
): boolean {
  return record.status !== 'SENT' && record.status !== 'FAILED';
}

export type DeliveryOwnershipAcquisition =
  | { kind: 'claimed'; ownerToken: string }
  /** Row reached terminal SENT (another owner delivered it). */
  | { kind: 'already_sent' }
  /** Row reached terminal FAILED. */
  | { kind: 'terminal_failed' }
  /** Attempt budget exhausted; the row was terminally marked FAILED. */
  | { kind: 'budget_exhausted' }
  /**
   * A live claimant currently owns delivery (its lease stayed active for the
   * whole bounded wait, or it won the CAS race just now). That claimant's own
   * job — including its BullMQ stalled-retry after a crash — is the recovery
   * driver, so the caller skips terminally and safely.
   */
  | { kind: 'owned_elsewhere' };

export type AcquireDeliveryOwnershipOptions = {
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  leaseMs?: number;
  maxAttempts?: number;
  pollMs?: number;
  /** Injectable for deterministic tests; defaults to a random UUID. */
  ownerToken?: string;
};

function defaultOwnershipSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * TASK-090 — acquire delivery ownership of an existing ProcessedMessage row.
 *
 * Correctness lives in `store.claimDelivery`, a single atomic conditional
 * write: at most one claimant can hold a valid lease at a time according to DB
 * state. This helper only decides WHEN to attempt that CAS:
 *
 *   - lease absent/expired + budget left  → CAS now; winner proceeds to send.
 *   - budget exhausted                    → conditional terminal FAILED
 *                                           (`delivery_attempts_exhausted`).
 *   - lease active (owner possibly dead)  → bounded poll-wait until the lease
 *     expires or the owner finishes. This wait is what makes a crashed owner's
 *     row recoverable by the crashed job's OWN BullMQ re-attempt (S2): with
 *     `attempts: 3` the retry chain is far shorter than the lease, so without
 *     waiting in place the re-attempt would exhaust before it could reclaim.
 *
 * Strictly bounded: total sleep ≤ lease + one poll tick, CAS tries ≤ 2, and a
 * defensive iteration cap guards against a non-advancing injected clock. The
 * loop performs NO external side effect — Telegram is only ever called by a
 * caller holding a freshly won token.
 */
export async function acquireDeliveryOwnership(
  processedMessageId: string,
  store: ProcessedMessageStore,
  options: AcquireDeliveryOwnershipOptions = {},
): Promise<DeliveryOwnershipAcquisition> {
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? defaultOwnershipSleep;
  const leaseMs = options.leaseMs ?? DELIVERY_LEASE_MS;
  const maxAttempts = options.maxAttempts ?? MAX_DELIVERY_ATTEMPTS;
  const pollMs = Math.max(1, options.pollMs ?? DELIVERY_OWNERSHIP_POLL_MS);
  const ownerToken = options.ownerToken ?? randomUUID();

  const startMs = now().getTime();
  const deadlineMs = startMs + leaseMs + pollMs;
  // Defensive hard cap so a non-advancing test clock can never loop forever.
  const maxIterations = Math.ceil((leaseMs + pollMs) / pollMs) + 8;

  let casTries = 0;

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const row = await store.findById(processedMessageId);
    if (!row) {
      // No delete path exists for ProcessedMessage; treat a vanished row as
      // externally handled rather than inventing a recovery.
      return { kind: 'owned_elsewhere' };
    }
    if (row.status === 'SENT') return { kind: 'already_sent' };
    if (row.status === 'FAILED') return { kind: 'terminal_failed' };

    const nowMs = now().getTime();
    const leaseActive =
      row.deliveryLeaseUntil !== null &&
      row.deliveryLeaseUntil.getTime() > nowMs;

    if (!leaseActive) {
      if (row.deliveryAttempts >= maxAttempts) {
        await store.markFailedIfUnclaimed({
          processedMessageId,
          reason: 'delivery_attempts_exhausted',
          now: now(),
          minAttempts: maxAttempts,
        });
        return { kind: 'budget_exhausted' };
      }
      casTries += 1;
      const claimed = await store.claimDelivery({
        processedMessageId,
        ownerToken,
        now: now(),
        leaseUntil: new Date(nowMs + leaseMs),
        maxAttempts,
      });
      if (claimed) return { kind: 'claimed', ownerToken };
      if (casTries >= 2) {
        // Lost the CAS twice to claimants that are alive RIGHT NOW — their
        // jobs drive delivery (or their stalled re-runs will). Skip safely.
        return { kind: 'owned_elsewhere' };
      }
      continue; // Re-read to observe what the winner did.
    }

    if (nowMs >= deadlineMs) return { kind: 'owned_elsewhere' };
    const waitMs = Math.min(
      pollMs,
      Math.max(1, row.deliveryLeaseUntil!.getTime() - nowMs),
      Math.max(1, deadlineMs - nowMs),
    );
    await sleep(waitMs);
  }

  return { kind: 'owned_elsewhere' };
}

export function createInMemoryProcessedMessageStore(): ProcessedMessageStore {
  const records: ProcessedMessageRecord[] = [];
  let counter = 0;

  return {
    async findById(processedMessageId) {
      return records.find((r) => r.id === processedMessageId) ?? null;
    },
    async findByGraphMessageId(mailboxId, graphMessageId) {
      return (
        records.find(
          (r) =>
            r.mailboxId === mailboxId && r.graphMessageId === graphMessageId,
        ) ?? null
      );
    },
    async findByInternetMessageId(mailboxId, internetMessageId) {
      return (
        records.find(
          (r) =>
            r.mailboxId === mailboxId &&
            r.internetMessageId === internetMessageId,
        ) ?? null
      );
    },
    async findByCodeBucket(mailboxId, codeHash, receivedAtBucket) {
      return (
        records.find(
          (r) =>
            r.mailboxId === mailboxId &&
            r.codeHash === codeHash &&
            r.receivedAtBucket === receivedAtBucket,
        ) ?? null
      );
    },
    async create(input) {
      // Mirror the DB's @@unique([mailboxId, graphMessageId]) so tests can
      // exercise the same exactly-once race the Prisma store guards against.
      const clash = records.find(
        (r) =>
          r.mailboxId === input.mailboxId &&
          r.graphMessageId === input.graphMessageId,
      );
      if (clash) {
        throw new ProcessedMessageDuplicateError();
      }
      counter += 1;
      const record: ProcessedMessageRecord = {
        id: `pm_${counter}`,
        mailboxId: input.mailboxId,
        graphMessageId: input.graphMessageId,
        internetMessageId: input.internetMessageId,
        codeHash: input.codeHash,
        receivedAt: input.receivedAt,
        receivedAtBucket: input.receivedAtBucket,
        senderEmail: input.senderEmail,
        subjectHash: input.subjectHash,
        status: 'DETECTED',
        sentToTelegramAt: null,
        deliveryAttempts: input.deliveryAttempts ?? 0,
        deliveryLeaseUntil: input.deliveryLeaseUntil ?? null,
        deliveryOwner: input.deliveryOwner ?? null,
        deliveryFailureReason: null,
        createdAt: new Date(),
      };
      records.push(record);
      return record;
    },
    async markSent(processedMessageId, sentAt, ownerToken) {
      const target = records.find((r) => r.id === processedMessageId);
      if (!target) return false;
      // TASK-090 — with a token, mirror the Prisma store's fenced conditional
      // write: only the CURRENT owner of a still-DETECTED row may complete.
      if (ownerToken !== undefined) {
        if (target.status !== 'DETECTED' || target.deliveryOwner !== ownerToken) {
          return false;
        }
      }
      target.status = 'SENT';
      target.sentToTelegramAt = sentAt;
      target.deliveryLeaseUntil = null;
      return true;
    },
    async claimDelivery(input) {
      // Mirror the Prisma store's single conditional UPDATE (CAS). JS is
      // single-threaded per tick, so the check+mutate below is atomic exactly
      // like a row-level UPDATE ... WHERE in Postgres.
      const target = records.find((r) => r.id === input.processedMessageId);
      if (!target) return false;
      const leaseFree =
        target.deliveryLeaseUntil === null ||
        target.deliveryLeaseUntil.getTime() <= input.now.getTime();
      if (
        target.status !== 'DETECTED' ||
        !leaseFree ||
        target.deliveryAttempts >= input.maxAttempts
      ) {
        return false;
      }
      target.deliveryOwner = input.ownerToken;
      target.deliveryLeaseUntil = input.leaseUntil;
      target.deliveryAttempts += 1;
      return true;
    },
    async releaseDelivery(processedMessageId, ownerToken) {
      const target = records.find((r) => r.id === processedMessageId);
      if (
        !target ||
        target.status !== 'DETECTED' ||
        target.deliveryOwner !== ownerToken
      ) {
        return false;
      }
      target.deliveryLeaseUntil = null;
      target.deliveryOwner = null;
      return true;
    },
    async markFailedByOwner(processedMessageId, ownerToken, reason) {
      const target = records.find((r) => r.id === processedMessageId);
      if (
        !target ||
        target.status !== 'DETECTED' ||
        target.deliveryOwner !== ownerToken
      ) {
        return false;
      }
      target.status = 'FAILED';
      target.deliveryFailureReason = reason;
      target.deliveryLeaseUntil = null;
      return true;
    },
    async markFailedIfUnclaimed(input) {
      const target = records.find((r) => r.id === input.processedMessageId);
      if (!target || target.status !== 'DETECTED') return false;
      const leaseFree =
        target.deliveryLeaseUntil === null ||
        target.deliveryLeaseUntil.getTime() <= input.now.getTime();
      if (!leaseFree) return false;
      if (
        input.minAttempts !== undefined &&
        target.deliveryAttempts < input.minAttempts
      ) {
        return false;
      }
      target.status = 'FAILED';
      target.deliveryFailureReason = input.reason;
      target.deliveryLeaseUntil = null;
      return true;
    },
  };
}
