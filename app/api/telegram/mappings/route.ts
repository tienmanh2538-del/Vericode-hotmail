import { NextResponse } from 'next/server';
import { resolveCustomerScope } from '@/lib/auth/access-scope';
import { hasPermission } from '@/lib/auth/permissions';
import { getCurrentUser } from '@/lib/auth/session';
import {
  createTelegramMapping,
  listTelegramMappings,
  TelegramMappingConflictError,
  TelegramMappingValidationError,
} from '@/services/telegram/telegram-mapping.service';

export const dynamic = 'force-dynamic';

async function requireMappingManager() {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user.role, 'MANAGE_TELEGRAM_MAPPINGS')) {
    return null;
  }
  return user;
}

export async function GET(): Promise<NextResponse> {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user.role, 'VIEW_ADMIN')) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  // TASK-045 — staff only see mappings of assigned customers.
  const scope = await resolveCustomerScope(user);
  const mappings = await listTelegramMappings(scope);
  return NextResponse.json({
    ok: true,
    data: mappings.map((m) => ({
      id: m.id,
      mailboxId: m.mailboxId,
      mailboxEmail: m.mailboxEmail,
      customerId: m.customerId,
      customerName: m.customerName,
      telegramChatId: m.telegramChatId,
      telegramGroupName: m.telegramGroupName,
      telegramThreadId: m.telegramThreadId,
      telegramTopicName: m.telegramTopicName,
      status: m.status,
      createdAt: m.createdAt.toISOString(),
      updatedAt: m.updatedAt.toISOString(),
    })),
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const user = await requireMappingManager();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
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

  try {
    const created = await createTelegramMapping(body as Record<string, unknown>);
    return NextResponse.json(
      {
        ok: true,
        data: {
          id: created.id,
          mailboxId: created.mailboxId,
          mailboxEmail: created.mailboxEmail,
          telegramChatId: created.telegramChatId,
          telegramGroupName: created.telegramGroupName,
          telegramThreadId: created.telegramThreadId,
          telegramTopicName: created.telegramTopicName,
          status: created.status,
          createdAt: created.createdAt.toISOString(),
          updatedAt: created.updatedAt.toISOString(),
        },
      },
      { status: 201 },
    );
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
      { ok: false, error: 'Could not create Telegram mapping' },
      { status: 500 },
    );
  }
}
