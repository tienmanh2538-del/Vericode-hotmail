import { NextResponse } from 'next/server';
import { resolveCustomerScope } from '@/lib/auth/access-scope';
import { hasPermission } from '@/lib/auth/permissions';
import { getCurrentUser } from '@/lib/auth/session';
import {
  deleteTelegramMapping,
  disableTelegramMapping,
  TelegramDestinationMappingConflictError,
  TelegramDestinationMappingValidationError,
  updateTelegramMappingFromDestination,
} from '@/services/telegram/telegram-mapping.service';
import { TelegramScopeError } from '@/services/telegram/telegram-scope-error';

export const dynamic = 'force-dynamic';

async function requireMappingManager() {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user.role, 'MANAGE_TELEGRAM_MAPPINGS')) {
    return null;
  }
  return user;
}

interface RouteContext {
  params: { id: string };
}

interface MappingForSerialize {
  id: string;
  mailboxId: string;
  mailboxEmail: string | null;
  telegramChatId: string;
  telegramGroupName: string | null;
  telegramThreadId: string | null;
  telegramTopicName: string | null;
  destinationId: string | null;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}

function serialize(mapping: MappingForSerialize) {
  return {
    id: mapping.id,
    mailboxId: mapping.mailboxId,
    mailboxEmail: mapping.mailboxEmail,
    telegramChatId: mapping.telegramChatId,
    telegramGroupName: mapping.telegramGroupName,
    telegramThreadId: mapping.telegramThreadId,
    telegramTopicName: mapping.telegramTopicName,
    destinationId: mapping.destinationId,
    status: mapping.status,
    createdAt: mapping.createdAt.toISOString(),
    updatedAt: mapping.updatedAt.toISOString(),
  };
}

export async function PATCH(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const user = await requireMappingManager();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  const { id } = context.params;
  if (!id) {
    return NextResponse.json(
      { ok: false, error: 'Mapping id is required' },
      { status: 400 },
    );
  }

  const url = new URL(request.url);
  const action = url.searchParams.get('action');

  // TASK-078 — every mutation is scoped to the caller's customers. OWNER/ADMIN
  // resolve to the unrestricted 'all' scope (no-op); a restricted caller cannot
  // disable/update a mapping outside their scope.
  const scope = await resolveCustomerScope(user);

  try {
    if (action === 'disable') {
      const updated = await disableTelegramMapping(id, scope);
      return NextResponse.json({ ok: true, data: serialize(updated) });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { ok: false, error: 'Invalid JSON body' },
        { status: 400 },
      );
    }
    if (typeof body !== 'object' || body === null) {
      return NextResponse.json(
        { ok: false, error: 'Request body must be an object' },
        { status: 400 },
      );
    }

    // TASK-065 — route the legacy update through the destination-based service
    // path so customer isolation is enforced (mailbox and destination must share
    // a customer). Raw `telegramChatId`/group/thread are no longer trusted; the
    // caller supplies a `destinationId`. The viewer scope (resolved above) is
    // passed so a restricted caller cannot move a mapping onto an out-of-scope
    // mailbox.
    const updated = await updateTelegramMappingFromDestination(
      id,
      body as Record<string, unknown>,
      scope,
    );
    return NextResponse.json({ ok: true, data: serialize(updated) });
  } catch (error) {
    // Out-of-scope is reported as 404 so a restricted caller cannot confirm the
    // mapping exists.
    if (error instanceof TelegramScopeError) {
      return NextResponse.json(
        { ok: false, error: 'Telegram mapping not found' },
        { status: 404 },
      );
    }
    if (error instanceof TelegramDestinationMappingValidationError) {
      return NextResponse.json(
        { ok: false, error: 'Validation failed', fields: error.errors },
        { status: 400 },
      );
    }
    if (error instanceof TelegramDestinationMappingConflictError) {
      return NextResponse.json(
        {
          ok: false,
          error: error.message,
          fields: { [error.field]: error.message },
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { ok: false, error: 'Could not update Telegram mapping' },
      { status: 500 },
    );
  }
}

export async function DELETE(
  _request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const user = await requireMappingManager();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  const { id } = context.params;
  if (!id) {
    return NextResponse.json(
      { ok: false, error: 'Mapping id is required' },
      { status: 400 },
    );
  }

  // TASK-078 — scope the delete to the caller's customers. OWNER/ADMIN resolve to
  // the unrestricted 'all' scope (no-op); a restricted caller cannot delete a
  // mapping outside their scope (reported as 404, not 403, to avoid leaking
  // existence).
  const scope = await resolveCustomerScope(user);

  try {
    await deleteTelegramMapping(id, scope);
    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof TelegramScopeError) {
      return NextResponse.json(
        { ok: false, error: 'Telegram mapping not found' },
        { status: 404 },
      );
    }
    return NextResponse.json(
      { ok: false, error: 'Could not delete Telegram mapping' },
      { status: 500 },
    );
  }
}
