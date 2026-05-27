import { NextResponse } from 'next/server';
import {
  sendTelegramMessage,
  TelegramSendError,
} from '@/services/telegram/telegram-sender.service';

export const dynamic = 'force-dynamic';

const DEFAULT_TEST_MESSAGE = '✅ Verification Tool Telegram test message';

interface TestSendBody {
  chatId?: unknown;
  text?: unknown;
}

function readChatId(body: TestSendBody): string | null {
  if (typeof body.chatId !== 'string') return null;
  const trimmed = body.chatId.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readText(body: TestSendBody): string {
  if (typeof body.text !== 'string') return DEFAULT_TEST_MESSAGE;
  const trimmed = body.text.trim();
  return trimmed.length === 0 ? DEFAULT_TEST_MESSAGE : trimmed;
}

export async function POST(request: Request): Promise<NextResponse> {
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

  try {
    const result = await sendTelegramMessage({ chatId, text });
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
