import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import {
  handleMicrosoftGraphNotifications,
  parseNotificationCollection,
  type WebhookNotificationDeps,
} from '@/services/microsoft/webhook-notification.service';

export const dynamic = 'force-dynamic';

const logger = createLogger();

const VALIDATION_TOKEN_PARAM = 'validationToken';

function buildValidationResponse(validationToken: string): Response {
  return new Response(validationToken, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}

function getValidationToken(request: NextRequest): string | null {
  const token = new URL(request.url).searchParams.get(VALIDATION_TOKEN_PARAM);
  if (typeof token !== 'string' || token.length === 0) return null;
  return token;
}

async function readJsonSafely(request: NextRequest): Promise<unknown | undefined> {
  try {
    const text = await request.text();
    if (text.length === 0) return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

async function handleWebhookRequest(
  request: NextRequest,
  deps: WebhookNotificationDeps = {},
): Promise<Response> {
  const validationToken = getValidationToken(request);

  if (validationToken !== null) {
    logger.info('Microsoft webhook validation request received', {
      method: 'POST',
    });
    return buildValidationResponse(validationToken);
  }

  const rawBody = await readJsonSafely(request);
  const collection = parseNotificationCollection(rawBody);
  if (collection === null) {
    logger.warn('Microsoft webhook received malformed notification body');
    return NextResponse.json(
      { ok: false, error: 'Invalid Microsoft Graph notification payload' },
      { status: 400 },
    );
  }

  try {
    const result = await handleMicrosoftGraphNotifications(collection, deps);
    logger.info('Microsoft webhook notification batch handled', {
      received: result.received,
      accepted: result.accepted.length,
      skipped: result.skipped.length,
    });
    return NextResponse.json(
      {
        ok: true,
        received: result.received,
        accepted: result.accepted.length,
        skipped: result.skipped.length,
      },
      { status: 202 },
    );
  } catch {
    logger.error('Microsoft webhook notification handling failed');
    return NextResponse.json(
      { ok: false, error: 'Webhook notification handling failed' },
      { status: 500 },
    );
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  return handleWebhookRequest(request);
}

export async function GET(request: NextRequest): Promise<Response> {
  const validationToken = getValidationToken(request);

  if (validationToken !== null) {
    logger.info('Microsoft webhook validation request received', {
      method: 'GET',
    });
    return buildValidationResponse(validationToken);
  }

  return NextResponse.json(
    {
      ok: true,
      message: 'Microsoft webhook endpoint is alive. Use POST for real validation.',
    },
    { status: 200 },
  );
}
