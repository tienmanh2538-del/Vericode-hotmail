import { prisma } from '@/lib/prisma';
import type { CustomerScope } from '@/lib/auth/access-scope';
import { scopeAllowsCustomer } from '@/lib/auth/access-scope';
import { TelegramScopeError } from './telegram-scope-error';
import {
  validateTelegramDestinationInput,
  type RawTelegramDestinationInput,
  type TelegramDestinationInput,
} from '@/lib/validation/telegram-destination';
import type { TelegramMappingStatus } from '@/lib/validation/telegram-mapping';

export interface TelegramDestinationRecord {
  id: string;
  customerId: string;
  customerName: string | null;
  displayName: string;
  telegramGroupName: string;
  telegramTopicName: string | null;
  telegramChatId: string;
  telegramThreadId: string | null;
  status: TelegramMappingStatus;
  // How many Telegram mappings currently point at this destination. Many
  // mailboxes sharing one destination is expected (TASK-041 routing rule).
  mappingCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export class TelegramDestinationValidationError extends Error {
  readonly errors: Partial<Record<keyof TelegramDestinationInput, string>>;

  constructor(errors: Partial<Record<keyof TelegramDestinationInput, string>>) {
    super('Telegram destination input is invalid');
    this.name = 'TelegramDestinationValidationError';
    this.errors = errors;
  }
}

export class TelegramDestinationConflictError extends Error {
  readonly field: keyof TelegramDestinationInput;

  constructor(field: keyof TelegramDestinationInput, message: string) {
    super(message);
    this.name = 'TelegramDestinationConflictError';
    this.field = field;
  }
}

interface DestinationRow {
  id: string;
  customerId: string;
  displayName: string;
  telegramGroupName: string;
  telegramTopicName: string | null;
  telegramChatId: string;
  telegramThreadId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
  customer?: { name: string } | null;
  _count?: { mappings: number } | null;
}

function toRecord(row: DestinationRow): TelegramDestinationRecord {
  return {
    id: row.id,
    customerId: row.customerId,
    customerName: row.customer?.name ?? null,
    displayName: row.displayName,
    telegramGroupName: row.telegramGroupName,
    telegramTopicName: row.telegramTopicName ?? null,
    telegramChatId: row.telegramChatId,
    telegramThreadId: row.telegramThreadId ?? null,
    status: row.status as TelegramMappingStatus,
    mappingCount: row._count?.mappings ?? 0,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

const INCLUDE_RELATIONS = {
  customer: { select: { name: true } },
  _count: { select: { mappings: true } },
} as const;

// TASK-045 — STAFF only sees destinations of assigned customers. Worker/system
// callers omit the scope, keeping full (unscoped) behavior.
export async function listTelegramDestinations(
  scope?: CustomerScope,
): Promise<TelegramDestinationRecord[]> {
  const rows = await prisma.telegramDestination.findMany({
    orderBy: { createdAt: 'desc' },
    include: INCLUDE_RELATIONS,
    ...(scope && scope.kind === 'assigned'
      ? { where: { customerId: { in: scope.customerIds } } }
      : {}),
  });
  return rows.map(toRecord);
}

export async function getTelegramDestinationById(
  id: string,
  scope?: CustomerScope,
): Promise<TelegramDestinationRecord | null> {
  if (!id) return null;
  const row = await prisma.telegramDestination.findUnique({
    where: { id },
    include: INCLUDE_RELATIONS,
  });
  if (!row) return null;
  // Fail closed: staff never receives a destination outside their scope.
  if (scope && !scopeAllowsCustomer(scope, row.customerId)) {
    return null;
  }
  return toRecord(row);
}

// Same chat + thread inside one customer is treated as the SAME destination, so
// operators do not accidentally create duplicates. Different customers may of
// course reuse the same chat id (their own group), so the check is per-customer.
async function assertNoDuplicate(
  input: TelegramDestinationInput,
  options: { excludeId?: string } = {},
): Promise<void> {
  const duplicate = await prisma.telegramDestination.findFirst({
    where: {
      customerId: input.customerId,
      telegramChatId: input.telegramChatId,
      telegramThreadId: input.telegramThreadId,
      ...(options.excludeId ? { NOT: { id: options.excludeId } } : {}),
    },
    select: { id: true },
  });
  if (duplicate) {
    throw new TelegramDestinationConflictError(
      'telegramChatId',
      'A destination with this chat ID and topic already exists for this customer.',
    );
  }
}

// TASK-078 — fail closed on the caller's scope before touching an existing
// destination. Only the restricted ('assigned') scope needs a lookup; 'all' is a
// no-op and an omitted scope keeps the legacy worker/system behavior. An
// out-of-scope OR missing row both raise TelegramScopeError so the caller can
// neither mutate nor confirm a destination it cannot see.
async function assertDestinationInScope(
  id: string,
  scope: CustomerScope,
): Promise<void> {
  if (scope.kind === 'all') return;
  const row = await prisma.telegramDestination.findUnique({
    where: { id },
    select: { customerId: true },
  });
  if (!row || !scopeAllowsCustomer(scope, row.customerId)) {
    throw new TelegramScopeError(
      'You do not have access to this Telegram destination.',
    );
  }
}

export async function createTelegramDestination(
  raw: RawTelegramDestinationInput,
  scope?: CustomerScope,
): Promise<TelegramDestinationRecord> {
  const result = validateTelegramDestinationInput(raw);
  if (!result.ok) {
    throw new TelegramDestinationValidationError(result.errors);
  }
  const input = result.data;

  // Fail closed: a restricted caller cannot create a destination for a customer
  // outside their scope.
  if (scope && !scopeAllowsCustomer(scope, input.customerId)) {
    throw new TelegramScopeError('You do not have access to this customer.');
  }

  await assertNoDuplicate(input);

  const row = await prisma.telegramDestination.create({
    data: {
      customerId: input.customerId,
      displayName: input.displayName,
      telegramGroupName: input.telegramGroupName,
      telegramTopicName: input.telegramTopicName,
      telegramChatId: input.telegramChatId,
      telegramThreadId: input.telegramThreadId,
      status: input.status,
    },
    include: INCLUDE_RELATIONS,
  });
  return toRecord(row);
}

export async function updateTelegramDestination(
  id: string,
  raw: RawTelegramDestinationInput,
  scope?: CustomerScope,
): Promise<TelegramDestinationRecord> {
  if (!id) {
    throw new TelegramDestinationValidationError({
      displayName: 'Destination id is required.',
    });
  }
  const result = validateTelegramDestinationInput(raw);
  if (!result.ok) {
    throw new TelegramDestinationValidationError(result.errors);
  }
  const input = result.data;

  // Fail closed on BOTH sides: a restricted caller cannot edit a destination of a
  // customer outside their scope, nor reassign it to a customer outside their
  // scope.
  if (scope) {
    await assertDestinationInScope(id, scope);
    if (!scopeAllowsCustomer(scope, input.customerId)) {
      throw new TelegramScopeError('You do not have access to the target customer.');
    }
  }

  await assertNoDuplicate(input, { excludeId: id });

  const row = await prisma.telegramDestination.update({
    where: { id },
    data: {
      customerId: input.customerId,
      displayName: input.displayName,
      telegramGroupName: input.telegramGroupName,
      telegramTopicName: input.telegramTopicName,
      telegramChatId: input.telegramChatId,
      telegramThreadId: input.telegramThreadId,
      status: input.status,
    },
    include: INCLUDE_RELATIONS,
  });
  return toRecord(row);
}

export async function disableTelegramDestination(
  id: string,
  scope?: CustomerScope,
): Promise<TelegramDestinationRecord> {
  if (!id) {
    throw new TelegramDestinationValidationError({
      displayName: 'Destination id is required.',
    });
  }
  if (scope) await assertDestinationInScope(id, scope);
  // Disabling a destination does NOT touch linked mappings; the resolve pipeline
  // refuses to send through a DISABLED destination, so disabling here is enough
  // to stop delivery without rewriting mapping rows.
  const row = await prisma.telegramDestination.update({
    where: { id },
    data: { status: 'DISABLED' },
    include: INCLUDE_RELATIONS,
  });
  return toRecord(row);
}
