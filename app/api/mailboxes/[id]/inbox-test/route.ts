import { NextResponse } from 'next/server';
import { loadEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { prisma } from '@/lib/prisma';
import { hasPermission } from '@/lib/auth/permissions';
import { getCurrentUser } from '@/lib/auth/session';
import { decryptSecret, EncryptionError } from '@/lib/security/encryption';
import {
  GraphMailError,
  listInboxMessages,
  type GraphMailMessage,
} from '@/services/microsoft/graph-mail.service';
import {
  RefreshAccessTokenError,
  refreshMicrosoftAccessToken,
} from '@/services/microsoft/refresh-access-token.service';

export const dynamic = 'force-dynamic';

const logger = createLogger();

const MIN_LIMIT = 1;
const MAX_LIMIT = 25;
const DEFAULT_LIMIT = 5;

interface RouteContext {
  params: { id: string };
}

interface SanitizedMessage {
  id: string;
  internetMessageId: string | null;
  fromAddress: string | null;
  fromName: string | null;
  subject: string | null;
  receivedDateTime: string | null;
  bodyPreview: string | null;
}

function parseLimit(raw: string | null): number {
  if (raw === null || raw === '') return DEFAULT_LIMIT;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_LIMIT;
  const integer = Math.floor(parsed);
  if (integer < MIN_LIMIT) return MIN_LIMIT;
  if (integer > MAX_LIMIT) return MAX_LIMIT;
  return integer;
}

function sanitizeMessage(message: GraphMailMessage): SanitizedMessage {
  const fromAddress = message.from?.emailAddress?.address ?? null;
  const fromName = message.from?.emailAddress?.name ?? null;
  return {
    id: message.id,
    internetMessageId: message.internetMessageId ?? null,
    fromAddress,
    fromName,
    subject: message.subject ?? null,
    receivedDateTime: message.receivedDateTime ?? null,
    bodyPreview: message.bodyPreview ?? null,
  };
}

function mapGraphErrorStatus(err: GraphMailError): number {
  switch (err.kind) {
    case 'auth':
      return 401;
    case 'permission':
      return 403;
    case 'not_found':
      return 404;
    case 'rate_limited':
      return 429;
    case 'temporary':
      return 502;
    case 'validation':
      return 400;
    case 'network':
    case 'parse':
    case 'http':
    default:
      return 502;
  }
}

export async function GET(
  request: Request,
  context: RouteContext,
): Promise<NextResponse> {
  const { values: env } = loadEnv();
  if (env.APP_ENV === 'production') {
    return NextResponse.json(
      { ok: false, error: 'Inbox test endpoint is disabled in production' },
      { status: 404 },
    );
  }

  const user = await getCurrentUser();
  if (!user || !hasPermission(user.role, 'MANAGE_MAILBOXES')) {
    return NextResponse.json({ ok: false, error: 'Forbidden' }, { status: 403 });
  }

  const { id: mailboxId } = context.params;
  if (typeof mailboxId !== 'string' || mailboxId.trim().length === 0) {
    return NextResponse.json(
      { ok: false, error: 'Mailbox id is required' },
      { status: 400 },
    );
  }

  const url = new URL(request.url);
  const limit = parseLimit(url.searchParams.get('limit'));

  let mailbox;
  try {
    mailbox = await prisma.mailbox.findUnique({
      where: { id: mailboxId },
      select: {
        id: true,
        emailAddress: true,
        provider: true,
        status: true,
        encryptedRefreshToken: true,
      },
    });
  } catch {
    logger.error('Inbox test mailbox lookup failed', { mailboxId });
    return NextResponse.json(
      { ok: false, error: 'Failed to load mailbox' },
      { status: 500 },
    );
  }

  if (!mailbox) {
    return NextResponse.json(
      { ok: false, error: 'Mailbox not found' },
      { status: 404 },
    );
  }

  if (mailbox.provider !== 'MICROSOFT') {
    return NextResponse.json(
      { ok: false, error: 'Mailbox is not a Microsoft mailbox' },
      { status: 400 },
    );
  }

  if (!mailbox.encryptedRefreshToken) {
    return NextResponse.json(
      { ok: false, error: 'Mailbox is missing a refresh token; reconnect required' },
      { status: 409 },
    );
  }

  let refreshToken: string;
  try {
    refreshToken = decryptSecret(mailbox.encryptedRefreshToken);
  } catch (err: unknown) {
    if (err instanceof EncryptionError) {
      logger.warn('Inbox test refresh token decrypt failed', { mailboxId });
    } else {
      logger.error('Inbox test refresh token decrypt unexpected error', { mailboxId });
    }
    return NextResponse.json(
      { ok: false, error: 'Failed to decrypt mailbox credentials' },
      { status: 500 },
    );
  }

  let accessToken: string;
  try {
    const refreshed = await refreshMicrosoftAccessToken(refreshToken, { env });
    accessToken = refreshed.accessToken;
  } catch (err: unknown) {
    if (err instanceof RefreshAccessTokenError) {
      logger.warn('Inbox test access token refresh failed', {
        mailboxId,
        kind: err.kind,
        httpStatus: err.httpStatus,
        microsoftErrorCode: err.microsoftErrorCode,
      });
      const status = err.kind === 'config' ? 500 : 401;
      const message =
        err.kind === 'config'
          ? 'Microsoft OAuth is not configured'
          : 'Failed to refresh Microsoft access token';
      return NextResponse.json({ ok: false, error: message }, { status });
    }
    logger.error('Inbox test access token refresh unexpected error', { mailboxId });
    return NextResponse.json(
      { ok: false, error: 'Failed to refresh Microsoft access token' },
      { status: 500 },
    );
  }

  let messages: GraphMailMessage[];
  try {
    messages = await listInboxMessages(accessToken, { top: limit });
  } catch (err: unknown) {
    if (err instanceof GraphMailError) {
      logger.warn('Inbox test Graph call failed', {
        mailboxId,
        kind: err.kind,
        httpStatus: err.httpStatus,
        retryAfterSeconds: err.retryAfterSeconds,
      });
      return NextResponse.json(
        { ok: false, error: err.message, kind: err.kind },
        { status: mapGraphErrorStatus(err) },
      );
    }
    logger.error('Inbox test Graph call unexpected error', { mailboxId });
    return NextResponse.json(
      { ok: false, error: 'Unexpected error reading inbox' },
      { status: 500 },
    );
  }

  const sanitized = messages.map(sanitizeMessage);

  return NextResponse.json({
    ok: true,
    mailboxId: mailbox.id,
    emailAddress: mailbox.emailAddress,
    count: sanitized.length,
    messages: sanitized,
  });
}
