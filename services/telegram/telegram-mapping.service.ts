import { prisma } from '@/lib/prisma';
import {
  validateTelegramMappingInput,
  type RawTelegramMappingInput,
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
  status: TelegramMappingStatus;
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

interface MappingRow {
  id: string;
  mailboxId: string;
  telegramChatId: string;
  telegramGroupName: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  mailbox?: {
    emailAddress: string;
    customerId: string | null;
    customer?: { id: string; name: string } | null;
  } | null;
}

function toRecord(row: MappingRow): TelegramMappingRecord {
  return {
    id: row.id,
    mailboxId: row.mailboxId,
    mailboxEmail: row.mailbox?.emailAddress ?? null,
    customerId: row.mailbox?.customer?.id ?? row.mailbox?.customerId ?? null,
    customerName: row.mailbox?.customer?.name ?? null,
    telegramChatId: row.telegramChatId,
    telegramGroupName: row.telegramGroupName,
    status: row.status as TelegramMappingStatus,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const INCLUDE_MAILBOX = {
  mailbox: {
    include: { customer: true },
  },
} as const;

export async function listTelegramMappings(): Promise<TelegramMappingRecord[]> {
  const rows = await prisma.telegramMapping.findMany({
    orderBy: { createdAt: 'desc' },
    include: INCLUDE_MAILBOX,
  });
  return rows.map(toRecord);
}

export async function getTelegramMappingById(
  id: string,
): Promise<TelegramMappingRecord | null> {
  if (!id) return null;
  const row = await prisma.telegramMapping.findUnique({
    where: { id },
    include: INCLUDE_MAILBOX,
  });
  return row ? toRecord(row) : null;
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
      status: input.status,
    },
    include: INCLUDE_MAILBOX,
  });
  // TODO(TASK-016): record audit log TELEGRAM_MAPPING_UPDATED.
  return toRecord(row);
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
  return row ? toRecord(row) : null;
}
