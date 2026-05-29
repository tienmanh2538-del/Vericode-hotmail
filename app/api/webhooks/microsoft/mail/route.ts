import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';

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

// Placeholder for TASK-025: real Microsoft Graph notification handling
// (clientState verification, payload parsing, queue dispatch, Telegram, etc.)
// will be implemented there. In TASK-024 we deliberately do NOT:
//   - parse the request body,
//   - call Microsoft Graph,
//   - enqueue work,
//   - send Telegram messages.
function buildPlaceholderResponse(): NextResponse {
  return NextResponse.json(
    {
      ok: true,
      received: true,
      message: 'Notification handling will be implemented in TASK-025',
    },
    { status: 202 },
  );
}

function getValidationToken(request: NextRequest): string | null {
  const token = new URL(request.url).searchParams.get(VALIDATION_TOKEN_PARAM);
  if (typeof token !== 'string' || token.length === 0) return null;
  return token;
}

export async function POST(request: NextRequest): Promise<Response> {
  const validationToken = getValidationToken(request);

  if (validationToken !== null) {
    logger.info('Microsoft webhook validation request received', {
      method: 'POST',
    });
    return buildValidationResponse(validationToken);
  }

  logger.info('Microsoft webhook POST received without validationToken', {
    method: 'POST',
    note: 'placeholder until TASK-025',
  });
  return buildPlaceholderResponse();
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
