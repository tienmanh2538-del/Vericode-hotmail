import { prisma } from '@/lib/prisma';
import type { CustomerScope } from '@/lib/auth/access-scope';
import { scopeAllowsCustomer } from '@/lib/auth/access-scope';
import {
  validateTelegramMappingInput,
  validateTelegramDestinationMappingInput,
  type RawTelegramMappingInput,
  type RawTelegramDestinationMappingInput,
  type TelegramMappingInput,
  type TelegramMappingStatus,
} from '@/lib/validation/telegram-mapping';

export type { TelegramMappingStatus } from '@/lib/validation/telegram-mapping';

export interface TelegramMappingRecord {
  id: string;
  mailboxId: string;
  mailboxEmail: string | null;
  customerId: string | null;
  customerName: string | null;
  telegramChatId: string;
  telegramGroupName: string | null;
  telegramThreadId: string | null;
  telegramTopicName: string | null;
  status: TelegramMappingStatus;
  // TASK-053 — the reusable destination this mapping routes through (null for
  // legacy mappings that pre-date destinations). `destinationStatus` lets the UI
  // surface "destination disabled → not delivering" without a second query.
  destinationId: string | null;
  destinationName: string | null;
  destinationStatus: TelegramMappingStatus | null;
  createdAt: Date;
  updatedAt: Date;
}

export class TelegramMappingValidationError extends Error {
  readonly errors: Partial<Record<keyof TelegramMappingInput, string>>;

  constructor(errors: Partial<Record<keyof TelegramMappingInput, string>>) {
    super('Telegram mapping input is invalid');
    this.name = 'TelegramMappingValidationError';
    this.errors = errors;
  }
}

export class TelegramMappingConflictError extends Error {
  readonly field: keyof TelegramMappingInput;

  constructor(field: keyof TelegramMappingInput, message: string) {
    super(message);
    this.name = 'TelegramMappingConflictError';
    this.field = field;
  }
}

// TASK-053 — errors for the destination-based mapping path. They are keyed by the
// fields the new form actually exposes (mailbox / destination / status), so the
// UI can attach the message to the right control. Kept separate from the legacy
// direct-input errors above so the existing API/tests are untouched.
export type TelegramMappingFormField = 'mailboxId' | 'destinationId' | 'status';

export class TelegramDestinationMappingValidationError extends Error {
  readonly errors: Partial<Record<TelegramMappingFormField, string>>;

  constructor(errors: Partial<Record<TelegramMappingFormField, string>>) {
    super('Telegram mapping input is invalid');
    this.name = 'TelegramDestinationMappingValidationError';
    this.errors = errors;
  }
}

export class TelegramDestinationMappingConflictError extends Error {
  readonly field: TelegramMappingFormField;

  constructor(field: TelegramMappingFormField, message: string) {
    super(message);
    this.name = 'TelegramDestinationMappingConflictError';
    this.field = field;
  }
}

interface DestinationRelation {
  id: string;
  displayName: string;
  telegramGroupName: string;
  telegramTopicName: string | null;
  telegramChatId: string;
  telegramThreadId: string | null;
  status: string;
}

interface MappingRow {
  id: string;
  mailboxId: string;
  telegramChatId: string;
  telegramGroupName: string | null;
  telegramThreadId: string | null;
  telegramTopicName: string | null;
  status: string;
  destinationId: string | null;
  createdAt: Date;
  updatedAt: Date;
  mailbox?: {
    emailAddress: string;
    customerId: string | null;
    customer?: { id: string; name: string } | null;
  } | null;
  destination?: DestinationRelation | null;
}

function toRecord(row: MappingRow): TelegramMappingRecord {
  // When a mapping is linked to a destination, the destination is the source of
  // truth for chat/group/thread/topic (it can be edited after the mapping was
  // created). Legacy mappings (no destination) fall back to their own snapshot
  // columns, so this stays correct for both.
  const dest = row.destination ?? null;
  return {
    id: row.id,
    mailboxId: row.mailboxId,
    mailboxEmail: row.mailbox?.emailAddress ?? null,
    customerId: row.mailbox?.customer?.id ?? row.mailbox?.customerId ?? null,
    customerName: row.mailbox?.customer?.name ?? null,
    telegramChatId: dest?.telegramChatId ?? row.telegramChatId,
    telegramGroupName: dest?.telegramGroupName ?? row.telegramGroupName,
    telegramThreadId: dest?.telegramThreadId ?? row.telegramThreadId ?? null,
    telegramTopicName: dest?.telegramTopicName ?? row.telegramTopicName ?? null,
    status: row.status as TelegramMappingStatus,
    destinationId: row.destinationId ?? dest?.id ?? null,
    destinationName: dest?.displayName ?? null,
    destinationStatus: dest ? (dest.status as TelegramMappingStatus) : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const INCLUDE_MAILBOX = {
  mailbox: {
    include: { customer: true },
  },
  destination: {
    select: {
      id: true,
      displayName: true,
      telegramGroupName: true,
      telegramTopicName: true,
      telegramChatId: true,
      telegramThreadId: true,
      status: true,
    },
  },
} as const;

// TASK-045 — STAFF only sees mappings whose mailbox belongs to an assigned
// customer. Mappings for mailboxes with no customer are never in scope. Scope
// is omitted by worker/system callers, which keeps full (unscoped) behavior.
export async function listTelegramMappings(
  scope?: CustomerScope,
): Promise<TelegramMappingRecord[]> {
  const rows = await prisma.telegramMapping.findMany({
    orderBy: { createdAt: 'desc' },
    include: INCLUDE_MAILBOX,
    ...(scope && scope.kind === 'assigned'
      ? { where: { mailbox: { customerId: { in: scope.customerIds } } } }
      : {}),
  });
  return rows.map(toRecord);
}

export async function getTelegramMappingById(
  id: string,
  scope?: CustomerScope,
): Promise<TelegramMappingRecord | null> {
  if (!id) return null;
  const row = await prisma.telegramMapping.findUnique({
    where: { id },
    include: INCLUDE_MAILBOX,
  });
  if (!row) return null;
  // Fail closed: staff never receives a mapping outside their scope.
  if (scope && !scopeAllowsCustomer(scope, row.mailbox?.customerId ?? null)) {
    return null;
  }
  return toRecord(row);
}

async function assertNoConflict(
  input: TelegramMappingInput,
  options: { excludeId?: string } = {},
): Promise<void> {
  // Same (mailbox, chatId) pair is enforced as @@unique at the DB level, but
  // we pre-check so we can return a field-level error instead of a P2002.
  const sameTarget = await prisma.telegramMapping.findFirst({
    where: {
      mailboxId: input.mailboxId,
      telegramChatId: input.telegramChatId,
      ...(options.excludeId ? { NOT: { id: options.excludeId } } : {}),
    },
    select: { id: true },
  });
  if (sameTarget) {
    throw new TelegramMappingConflictError(
      'telegramChatId',
      'A mapping for this mailbox and chat ID already exists.',
    );
  }

  if (input.status === 'ACTIVE') {
    const conflictingActive = await prisma.telegramMapping.findFirst({
      where: {
        mailboxId: input.mailboxId,
        status: 'ACTIVE',
        ...(options.excludeId ? { NOT: { id: options.excludeId } } : {}),
      },
      select: { id: true },
    });
    if (conflictingActive) {
      throw new TelegramMappingConflictError(
        'mailboxId',
        'This mailbox already has an active Telegram mapping. Disable it before adding another.',
      );
    }
  }
}

export async function createTelegramMapping(
  raw: RawTelegramMappingInput,
): Promise<TelegramMappingRecord> {
  const result = validateTelegramMappingInput(raw);
  if (!result.ok) {
    throw new TelegramMappingValidationError(result.errors);
  }
  const input = result.data;

  await assertNoConflict(input);

  const row = await prisma.telegramMapping.create({
    data: {
      mailboxId: input.mailboxId,
      telegramChatId: input.telegramChatId,
      telegramGroupName: input.telegramGroupName,
      telegramThreadId: input.telegramThreadId,
      telegramTopicName: input.telegramTopicName,
      status: input.status,
    },
    include: INCLUDE_MAILBOX,
  });
  // TODO(TASK-016): record audit log TELEGRAM_MAPPING_CREATED.
  return toRecord(row);
}

export async function updateTelegramMapping(
  id: string,
  raw: RawTelegramMappingInput,
): Promise<TelegramMappingRecord> {
  if (!id) {
    throw new TelegramMappingValidationError({ mailboxId: 'Mapping id is required.' });
  }
  const result = validateTelegramMappingInput(raw);
  if (!result.ok) {
    throw new TelegramMappingValidationError(result.errors);
  }
  const input = result.data;

  await assertNoConflict(input, { excludeId: id });

  const row = await prisma.telegramMapping.update({
    where: { id },
    data: {
      mailboxId: input.mailboxId,
      telegramChatId: input.telegramChatId,
      telegramGroupName: input.telegramGroupName,
      telegramThreadId: input.telegramThreadId,
      telegramTopicName: input.telegramTopicName,
      status: input.status,
    },
    include: INCLUDE_MAILBOX,
  });
  // TODO(TASK-016): record audit log TELEGRAM_MAPPING_UPDATED.
  return toRecord(row);
}

// ---------------------------------------------------------------------------
// TASK-053 — destination-based mapping create/update.
//
// The operator picks a mailbox + a saved destination; the chat/group/thread/
// topic are derived server-side from the destination. Customer isolation is
// enforced HERE (not just in the UI): the mailbox and the destination must
// belong to the same customer, and the destination must be ACTIVE. The existing
// one-active-mapping-per-mailbox rule is preserved via assertNoConflict.
// ---------------------------------------------------------------------------

interface ResolvedDestinationMapping {
  mailboxId: string;
  destinationId: string;
  status: TelegramMappingStatus;
  snapshot: {
    telegramChatId: string;
    telegramGroupName: string;
    telegramThreadId: string | null;
    telegramTopicName: string | null;
  };
}

async function resolveDestinationMapping(
  raw: RawTelegramDestinationMappingInput,
): Promise<ResolvedDestinationMapping> {
  const result = validateTelegramDestinationMappingInput(raw);
  if (!result.ok) {
    throw new TelegramDestinationMappingValidationError(result.errors);
  }
  const input = result.data;

  const mailbox = await prisma.mailbox.findUnique({
    where: { id: input.mailboxId },
    select: { id: true, customerId: true },
  });
  if (!mailbox) {
    throw new TelegramDestinationMappingConflictError(
      'mailboxId',
      'Selected mailbox no longer exists.',
    );
  }

  const destination = await prisma.telegramDestination.findUnique({
    where: { id: input.destinationId },
    select: { id: true, customerId: true, status: true, telegramChatId: true, telegramGroupName: true, telegramThreadId: true, telegramTopicName: true },
  });
  if (!destination) {
    throw new TelegramDestinationMappingConflictError(
      'destinationId',
      'Selected Telegram destination no longer exists.',
    );
  }

  // Customer isolation — the security boundary, enforced in the service layer.
  if (!mailbox.customerId || mailbox.customerId !== destination.customerId) {
    throw new TelegramDestinationMappingConflictError(
      'destinationId',
      'This destination belongs to a different customer than the mailbox.',
    );
  }

  // An ACTIVE mapping must not point at a DISABLED destination (it would never
  // deliver). Allow linking a DISABLED mapping to any destination of the same
  // customer so an operator can pre-stage and enable later.
  if (input.status === 'ACTIVE' && destination.status !== 'ACTIVE') {
    throw new TelegramDestinationMappingConflictError(
      'destinationId',
      'This destination is disabled. Enable the destination before activating the mapping.',
    );
  }

  return {
    mailboxId: input.mailboxId,
    destinationId: input.destinationId,
    status: input.status,
    snapshot: {
      telegramChatId: destination.telegramChatId,
      telegramGroupName: destination.telegramGroupName,
      telegramThreadId: destination.telegramThreadId ?? null,
      telegramTopicName: destination.telegramTopicName ?? null,
    },
  };
}

export async function createTelegramMappingFromDestination(
  raw: RawTelegramDestinationMappingInput,
): Promise<TelegramMappingRecord> {
  const resolved = await resolveDestinationMapping(raw);

  await assertNoConflictForDestination(resolved);

  const row = await prisma.telegramMapping.create({
    data: {
      mailboxId: resolved.mailboxId,
      destinationId: resolved.destinationId,
      telegramChatId: resolved.snapshot.telegramChatId,
      telegramGroupName: resolved.snapshot.telegramGroupName,
      telegramThreadId: resolved.snapshot.telegramThreadId,
      telegramTopicName: resolved.snapshot.telegramTopicName,
      status: resolved.status,
    },
    include: INCLUDE_MAILBOX,
  });
  return toRecord(row);
}

export async function updateTelegramMappingFromDestination(
  id: string,
  raw: RawTelegramDestinationMappingInput,
): Promise<TelegramMappingRecord> {
  if (!id) {
    throw new TelegramDestinationMappingValidationError({
      mailboxId: 'Mapping id is required.',
    });
  }
  const resolved = await resolveDestinationMapping(raw);

  await assertNoConflictForDestination(resolved, { excludeId: id });

  const row = await prisma.telegramMapping.update({
    where: { id },
    data: {
      mailboxId: resolved.mailboxId,
      destinationId: resolved.destinationId,
      telegramChatId: resolved.snapshot.telegramChatId,
      telegramGroupName: resolved.snapshot.telegramGroupName,
      telegramThreadId: resolved.snapshot.telegramThreadId,
      telegramTopicName: resolved.snapshot.telegramTopicName,
      status: resolved.status,
    },
    include: INCLUDE_MAILBOX,
  });
  return toRecord(row);
}

// Reuses the same invariants as the legacy path (no duplicate (mailbox, chat)
// row; at most one ACTIVE mapping per mailbox) but raises destination-shaped
// errors so the message lands on the right form control.
async function assertNoConflictForDestination(
  resolved: ResolvedDestinationMapping,
  options: { excludeId?: string } = {},
): Promise<void> {
  const sameTarget = await prisma.telegramMapping.findFirst({
    where: {
      mailboxId: resolved.mailboxId,
      telegramChatId: resolved.snapshot.telegramChatId,
      ...(options.excludeId ? { NOT: { id: options.excludeId } } : {}),
    },
    select: { id: true },
  });
  if (sameTarget) {
    throw new TelegramDestinationMappingConflictError(
      'destinationId',
      'This mailbox is already mapped to this destination.',
    );
  }

  if (resolved.status === 'ACTIVE') {
    const conflictingActive = await prisma.telegramMapping.findFirst({
      where: {
        mailboxId: resolved.mailboxId,
        status: 'ACTIVE',
        ...(options.excludeId ? { NOT: { id: options.excludeId } } : {}),
      },
      select: { id: true },
    });
    if (conflictingActive) {
      throw new TelegramDestinationMappingConflictError(
        'mailboxId',
        'This mailbox already has an active Telegram mapping. Disable it before adding another.',
      );
    }
  }
}

export async function disableTelegramMapping(
  id: string,
): Promise<TelegramMappingRecord> {
  if (!id) {
    throw new TelegramMappingValidationError({ mailboxId: 'Mapping id is required.' });
  }
  const row = await prisma.telegramMapping.update({
    where: { id },
    data: { status: 'DISABLED' },
    include: INCLUDE_MAILBOX,
  });
  // TODO(TASK-016): record audit log for Telegram mapping disable.
  return toRecord(row);
}

export async function deleteTelegramMapping(id: string): Promise<void> {
  if (!id) {
    throw new TelegramMappingValidationError({ mailboxId: 'Mapping id is required.' });
  }
  await prisma.telegramMapping.delete({ where: { id } });
  // TODO(TASK-016): record audit log for Telegram mapping delete.
}

export async function findActiveMappingForMailbox(
  mailboxIdOrEmail: string,
): Promise<TelegramMappingRecord | null> {
  const key = mailboxIdOrEmail?.trim();
  if (!key) return null;

  const row = await prisma.telegramMapping.findFirst({
    where: {
      status: 'ACTIVE',
      OR: [
        { mailboxId: key },
        { mailbox: { emailAddress: key } },
      ],
    },
    include: INCLUDE_MAILBOX,
  });
  if (!row) return null;

  // TASK-053 — a mapping linked to a DISABLED destination must NOT deliver, even
  // though the mapping row itself is still ACTIVE. The mapping-status query above
  // cannot express this (it filters the mapping, not the destination), so gate
  // here. Legacy mappings (no destination) are unaffected.
  if (row.destination && row.destination.status !== 'ACTIVE') {
    return null;
  }
  return toRecord(row);
}
