import { NextResponse, type NextRequest } from 'next/server';
import { createLogger } from '@/lib/logger';
import {
  handleMicrosoftGraphNotifications,
  parseNotificationCollection,
  type AcceptedMicrosoftMailNotification,
  type WebhookNotificationDeps,
} from '@/services/microsoft/webhook-notification.service';
import {
  EMAIL_WEBHOOK_JOB_SOURCE,
  type EmailWebhookJobData,
} from '@/services/queue/email-job.types';
import {
  enqueueMicrosoftGraphMessageJob,
  type EnqueueResult,
} from '@/services/queue/email-queue';

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

type EnqueueFn = (data: EmailWebhookJobData) => Promise<EnqueueResult>;

export interface WebhookRouteDeps extends WebhookNotificationDeps {
  enqueue?: EnqueueFn;
  now?: () => Date;
}

function toEmailWebhookJobData(
  accepted: AcceptedMicrosoftMailNotification,
  queuedAtIso: string,
): EmailWebhookJobData {
  return {
    mailboxId: accepted.mailboxId,
    graphMessageId: accepted.graphMessageId,
    subscriptionId: accepted.subscriptionId,
    resource: accepted.resource.length > 0 ? accepted.resource : undefined,
    changeType: accepted.changeType,
    clientStateValidated: true,
    queuedAt: queuedAtIso,
    source: EMAIL_WEBHOOK_JOB_SOURCE,
  };
}

async function enqueueAcceptedNotifications(
  accepted: AcceptedMicrosoftMailNotification[],
  enqueue: EnqueueFn,
  nowIso: string,
): Promise<{ enqueued: number; failed: number }> {
  let enqueued = 0;
  let failed = 0;
  for (const item of accepted) {
    try {
      await enqueue(toEmailWebhookJobData(item, nowIso));
      enqueued += 1;
    } catch {
      failed += 1;
      // Detailed error logged by enqueueMicrosoftGraphMessageJob. Do not log
      // notification body here — it may contain identifiers we already log
      // via the queue layer.
      logger.error('Failed to enqueue Microsoft Graph notification', {
        mailboxId: item.mailboxId,
        graphMessageId: item.graphMessageId,
      });
    }
  }
  return { enqueued, failed };
}

async function handleWebhookRequest(
  request: NextRequest,
  deps: WebhookRouteDeps = {},
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
    const enqueueFn = deps.enqueue ?? enqueueMicrosoftGraphMessageJob;
    const nowIso = (deps.now ? deps.now() : new Date()).toISOString();
    const enqueueResult = await enqueueAcceptedNotifications(
      result.accepted,
      enqueueFn,
      nowIso,
    );
    logger.info('Microsoft webhook notification batch handled', {
      received: result.received,
      accepted: result.accepted.length,
      skipped: result.skipped.length,
      enqueued: enqueueResult.enqueued,
      enqueueFailed: enqueueResult.failed,
    });

    // TASK-073 — If ANY accepted notification failed to enqueue, do NOT report
    // success. Returning a non-2xx (503) lets Microsoft Graph redeliver the
    // whole batch so we never silently drop a verification email. The batch is
    // safe to redeliver: each notification carries a deterministic jobId
    // ("microsoft-webhook:{mailboxId}:{graphMessageId}"), so already-enqueued
    // items deduplicate at the queue level and the pipeline's ProcessedMessage
    // unique constraint prevents a duplicate Telegram send. Skipped (e.g.
    // invalid clientState) notifications are NOT failures and never force 503.
    const hasEnqueueFailure = enqueueResult.failed > 0;
    const responseBody = {
      ok: !hasEnqueueFailure,
      received: result.received,
      accepted: result.accepted.length,
      skipped: result.skipped.length,
      enqueued: enqueueResult.enqueued,
      enqueueFailed: enqueueResult.failed,
    };
    return NextResponse.json(responseBody, {
      status: hasEnqueueFailure ? 503 : 202,
    });
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
