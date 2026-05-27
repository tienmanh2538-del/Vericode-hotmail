import { NextResponse } from 'next/server';
import { hasPermission } from '@/lib/auth/permissions';
import { getCurrentUser } from '@/lib/auth/session';
import {
  deleteTelegramMapping,
  disableTelegramMapping,
  TelegramMappingConflictError,
  TelegramMappingValidationError,
  updateTelegramMapping,
} from '@/services/telegram/telegram-mapping.service';

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

  try {
    if (action === 'disable') {
      const updated = await disableTelegramMapping(id);
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

    const updated = await updateTelegramMapping(id, body as Record<string, unknown>);
    return NextResponse.json({ ok: true, data: serialize(updated) });
  } catch (error) {
    if (error instanceof TelegramMappingValidationError) {
      return NextResponse.json(
        { ok: false, error: 'Validation failed', fields: error.errors },
        { status: 400 },
      );
    }
    if (error instanceof TelegramMappingConflictError) {
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

  try {
    await deleteTelegramMapping(id);
    return NextResponse.json({ ok: true });
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Could not delete Telegram mapping' },
      { status: 500 },
    );
  }
}
