import { NextResponse } from 'next/server';
import { hasPermission } from '@/lib/auth/permissions';
import { getCurrentUser } from '@/lib/auth/session';
import {
  toSafePreview,
  validateMockEmailInput,
  type RawMockEmailInput,
} from '@/lib/validation/mock-email';

export const dynamic = 'force-dynamic';

async function requireAdminViewer() {
  const user = await getCurrentUser();
  if (!user || !hasPermission(user.role, 'VIEW_ADMIN')) {
    return null;
  }
  return user;
}

export async function GET(): Promise<NextResponse> {
  const user = await requireAdminViewer();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
  }

  return NextResponse.json({
    ok: true,
    data: {
      info: 'Mock email input endpoint. POST a mock email payload to validate it and receive a safe JSON preview. Nothing is persisted, sent, or forwarded.',
      schema: {
        mailboxEmail: 'string (email, required)',
        fromEmail: 'string (email, required)',
        fromName: 'string (optional)',
        subject: 'string (required)',
        receivedAt: 'string (ISO 8601 datetime, required)',
        bodyPreview: 'string (optional, <= 500 chars)',
        body: 'string (required, <= 50000 chars)',
      },
    },
  });
}

export async function POST(request: Request): Promise<NextResponse> {
  const user = await requireAdminViewer();
  if (!user) {
    return NextResponse.json({ ok: false, error: 'Unauthorized' }, { status: 401 });
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

  const result = validateMockEmailInput(body as RawMockEmailInput);
  if (!result.ok) {
    return NextResponse.json(
      { ok: false, error: 'Validation failed', fields: result.errors },
      { status: 400 },
    );
  }

  return NextResponse.json({
    ok: true,
    data: toSafePreview(result.data),
  });
}
