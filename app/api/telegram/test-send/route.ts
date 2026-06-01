import { NextResponse } from 'next/server';
import { hasPermission } from '@/lib/auth/permissions';
import { getCurrentUser } from '@/lib/auth/session';
import {
  sendTelegramMessage,
  TelegramSendError,
} from '@/services/telegram/telegram-sender.service';

export const dynamic = 'force-dynamic';

// TASK-045 — sending a test message is a Telegram management operation, so it
// requires MANAGE_TELEGRAM_MAPPINGS (OWNER/ADMIN). STAFF_READ_ONLY, which holds
// no MANAGE_* permission, is rejected. Mirrors the guard on the mappings POST
// route: API callers get a JSON 403 rather than a redirect.
async function requireMappingManager() {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user.role, 'MANAGE_TELEGRAM_MAPPINGS')) {
    return null;
  }
  return user;
}

const DEFAULT_TEST_MESSAGE = '✅ Verification Tool Telegram test message';

interface TestSendBody {
  chatId?: unknown;
  text?: unknown;
  messageThreadId?: unknown;
}

function readChatId(body: TestSendBody): string | null {
  if (typeof body.chatId !== 'string') return null;
  const trimmed = body.chatId.trim();
  return trimmed.length === 0 ? null : trimmed;
}

// Optional forum topic. Returns undefined for "send to the main group". Format
// is validated by the sender; an empty value is treated as "no topic".
function readMessageThreadId(body: TestSendBody): string | undefined {
  if (typeof body.messageThreadId !== 'string') return undefined;
  const trimmed = body.messageThreadId.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}

function readText(body: TestSendBody): string {
  if (typeof body.text !== 'string') return DEFAULT_TEST_MESSAGE;
  const trimmed = body.text.trim();
  return trimmed.length === 0 ? DEFAULT_TEST_MESSAGE : trimmed;
}

export async function POST(request: Request): Promise<NextResponse> {
  const user = await requireMappingManager();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  let body: TestSendBody;
  try {
    body = (await request.json()) as TestSendBody;
  } catch {
    return NextResponse.json(
      { ok: false, error: 'Invalid JSON body' },
      { status: 400 },
    );
  }

  const chatId = readChatId(body);
  if (!chatId) {
    return NextResponse.json(
      { ok: false, error: 'chatId is required' },
      { status: 400 },
    );
  }

  const text = readText(body);
  const messageThreadId = readMessageThreadId(body);

  try {
    const result = await sendTelegramMessage({ chatId, text, messageThreadId });
    return NextResponse.json({
      ok: true,
      message: 'Telegram test message sent',
      chatId: result.chatId,
      messageId: result.messageId,
    });
  } catch (error: unknown) {
    if (error instanceof TelegramSendError) {
      if (error.kind === 'validation') {
        return NextResponse.json(
          { ok: false, error: error.message },
          { status: 400 },
        );
      }
      if (error.kind === 'config') {
        return NextResponse.json(
          { ok: false, error: 'Telegram bot token is not configured' },
          { status: 500 },
        );
      }
      return NextResponse.json(
        { ok: false, error: 'Telegram send failed' },
        { status: 500 },
      );
    }
    return NextResponse.json(
      { ok: false, error: 'Unexpected server error' },
      { status: 500 },
    );
  }
}
