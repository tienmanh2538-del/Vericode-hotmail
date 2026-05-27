import { hashSensitiveValue } from '@/lib/security/redact';

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
};

export interface ProcessedMessageStore {
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
  markSent(processedMessageId: string, sentAt: Date): Promise<void>;
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

export async function claimMessageForProcessing(
  input: DeduplicationInput,
  store: ProcessedMessageStore,
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

  const record = await store.create({
    mailboxId,
    graphMessageId: effectiveGraphMessageId,
    internetMessageId,
    codeHash,
    receivedAt: receivedAtDate ?? new Date(),
    receivedAtBucket,
    senderEmail,
    subjectHash,
  });

  return {
    shouldProcess: true,
    isDuplicate: false,
    reason: 'NEW_MESSAGE',
    processedMessageId: record.id,
    dedupeKey: buildProcessedMessageDedupeKey(input),
  };
}

export async function markMessageAsSent(
  processedMessageId: string,
  store: ProcessedMessageStore,
  sentAt?: Date,
): Promise<void> {
  if (!isNonEmptyString(processedMessageId)) {
    throw new Error('processedMessageId is required');
  }
  await store.markSent(processedMessageId.trim(), sentAt ?? new Date());
}

export function createInMemoryProcessedMessageStore(): ProcessedMessageStore {
  const records: ProcessedMessageRecord[] = [];
  let counter = 0;

  return {
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
        createdAt: new Date(),
      };
      records.push(record);
      return record;
    },
    async markSent(processedMessageId, sentAt) {
      const target = records.find((r) => r.id === processedMessageId);
      if (target) {
        target.status = 'SENT';
        target.sentToTelegramAt = sentAt;
      }
    },
  };
}
