import { Worker, type Job } from 'bullmq';

import { loadEmailWorkerRateLimitEnv, loadQueueEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import type {
  GraphMessagePipelineDeps,
  GraphMessagePipelineResult,
  GraphMessagePipelineStatus,
  GraphMessageProcessingJob,
} from '@/services/email/graph-message-pipeline.service';
import {
  createNoopWorkerMetricsRecorder,
  recordWorkerMetricSafely,
  type WorkerJobResult,
  type WorkerMetricsRecorder,
} from '@/services/observability/worker-metrics';
import { getWorkerMetricsRecorder } from '@/services/observability/redis-worker-metrics';

import {
  EMAIL_DELTA_POLLING_JOB_SOURCE,
  EMAIL_QUEUE_JOB_NAMES,
  EMAIL_QUEUE_NAME,
  type EmailJobData,
} from '../email-job.types';
import { getRedisConnectionOptions } from '../redis-connection';

const logger = createLogger();

export type EmailWorkerPipeline = (
  job: GraphMessageProcessingJob,
) => Promise<GraphMessagePipelineResult>;

/**
 * Lazily-built production pipeline. The real dependency wiring lives in
 * `email-worker-runner` (Prisma + Graph + Telegram + DB audit). It is imported
 * dynamically so this module stays free of DB/Telegram imports at load time and
 * so unit tests (which always inject a fake pipeline) never construct it.
 */
let cachedDefaultPipeline: EmailWorkerPipeline | null = null;

async function resolveDefaultPipeline(): Promise<EmailWorkerPipeline> {
  if (cachedDefaultPipeline === null) {
    const { buildDefaultEmailPipeline } = await import('./email-worker-runner');
    cachedDefaultPipeline = buildDefaultEmailPipeline();
  }
  return cachedDefaultPipeline;
}

/**
 * Translate a BullMQ job payload into the pipeline-facing
 * `GraphMessageProcessingJob` shape. The worker never trusts the body fields
 * for downstream parsing — only the mailbox / message identifiers cross over.
 *
 * TASK-031: the same pipeline handles both webhook and delta-polling jobs.
 * The discriminated union is narrowed by `source`.
 */
function toPipelineJob(
  data: EmailJobData,
): GraphMessageProcessingJob {
  if (data.source === EMAIL_DELTA_POLLING_JOB_SOURCE) {
    return {
      mailboxId: data.mailboxId,
      graphMessageId: data.graphMessageId,
      source: 'webhook',
      subscriptionId: null,
      receivedNotificationAt: data.queuedAt ?? null,
    };
  }
  return {
    mailboxId: data.mailboxId,
    graphMessageId: data.graphMessageId,
    source: 'webhook',
    subscriptionId: data.subscriptionId ?? null,
    receivedNotificationAt: data.queuedAt ?? null,
  };
}

/**
 * Error wrapper that carries the safe pipeline envelope back to BullMQ's
 * failure handler. It deliberately exposes no token/code material — the
 * envelope already lacks them.
 */
export class EmailWorkerProcessingError extends Error {
  readonly result: GraphMessagePipelineResult;

  constructor(result: GraphMessagePipelineResult) {
    super(`Email worker pipeline failed: ${result.status}`);
    this.name = 'EmailWorkerProcessingError';
    this.result = result;
  }
}

/**
 * TASK-068C — map a pipeline status to the coarse worker-metrics category. Only
 * the category (not the full status) is recorded, keeping metrics aggregate.
 */
export function classifyWorkerJobResult(
  status: GraphMessagePipelineStatus,
): WorkerJobResult {
  if (status === 'CODE_SENT') return 'completed';
  if (status === 'DEFERRED_MAILBOX_BUSY') return 'deferred';
  if (status.startsWith('FAILED_')) return 'failed';
  return 'skipped';
}

export interface ProcessEmailWebhookJobOptions {
  /** Best-effort metrics sink. Defaults to a no-op (existing callers/tests). */
  metrics?: WorkerMetricsRecorder;
  /** Epoch-ms clock, injectable for deterministic latency tests. */
  now?: () => number;
}

const noopWorkerMetricsRecorder = createNoopWorkerMetricsRecorder();

/**
 * Time a job waited in the queue: now (processing start) minus the job's
 * enqueue timestamp. Returns null when the timestamp is missing/implausible
 * (e.g. a hand-built test job) so we never record a bogus negative latency.
 */
function computeQueueWaitMs(
  job: Job<EmailJobData>,
  startedAtMs: number,
): number | null {
  const timestamp = (job as { timestamp?: number }).timestamp;
  if (
    typeof timestamp === 'number' &&
    Number.isFinite(timestamp) &&
    timestamp <= startedAtMs
  ) {
    return startedAtMs - timestamp;
  }
  return null;
}

/**
 * TASK-027 worker. Receives validated `PROCESS_MICROSOFT_GRAPH_MESSAGE` jobs
 * and forwards them to the Graph message pipeline (load mailbox → fetch Graph
 * → detector → extractor → dedupe → Telegram).
 *
 * The processor itself never throws on a domain skip — it returns a status so
 * BullMQ does not retry deterministic skips like NO_TELEGRAM_MAPPING. It does
 * throw for transient failures (FAILED_GRAPH_FETCH, FAILED_RECONNECT_REQUIRED,
 * FAILED_TOKEN_TRANSIENT, FAILED_TELEGRAM_SEND) so BullMQ retries based on
 * `attempts/backoff`.
 *
 * TASK-068C — measures queue-wait + processing-duration and records an
 * aggregate worker-metrics sample (best-effort; never blocks or throws, and
 * carries only the result category + two ms durations — no payload).
 */
export async function processEmailWebhookJob(
  job: Job<EmailJobData>,
  pipeline?: EmailWorkerPipeline,
  options: ProcessEmailWebhookJobOptions = {},
): Promise<GraphMessagePipelineResult | { acknowledged: true }> {
  const metrics = options.metrics ?? noopWorkerMetricsRecorder;
  const nowMs = options.now ?? (() => Date.now());

  if (job.name !== EMAIL_QUEUE_JOB_NAMES.PROCESS_MICROSOFT_GRAPH_MESSAGE) {
    logger.warn('Email worker received unknown job name', {
      jobName: job.name,
    });
    return { acknowledged: true };
  }

  // No injected pipeline (production worker) ⇒ build the real one lazily.
  const runPipeline = pipeline ?? (await resolveDefaultPipeline());

  // Only opaque identifiers are logged — never the payload contents.
  logger.info('Email worker received Microsoft Graph notification', {
    jobName: job.name,
    jobId: typeof job.id === 'string' ? job.id : undefined,
    mailboxId: job.data.mailboxId,
    graphMessageId: job.data.graphMessageId,
    attemptsMade: job.attemptsMade,
  });

  const startedAtMs = nowMs();
  const queueWaitMs = computeQueueWaitMs(job, startedAtMs);

  const result = await runPipeline(toPipelineJob(job.data));

  const processingDurationMs = Math.max(0, nowMs() - startedAtMs);

  logger.info('Email worker pipeline result', {
    jobName: job.name,
    jobId: typeof job.id === 'string' ? job.id : undefined,
    mailboxId: result.mailboxId,
    graphMessageId: result.graphMessageId,
    status: result.status,
    sentToTelegram: result.sentToTelegram ?? false,
  });

  // TASK-068C — aggregate worker-metrics sample. Best-effort and payload-free.
  recordWorkerMetricSafely(() =>
    metrics.recordJobResult({
      result: classifyWorkerJobResult(result.status),
      queueWaitMs,
      processingDurationMs,
    }),
  );

  // Transient failures should trigger BullMQ retry. Skips and CODE_SENT are
  // terminal — returning the envelope lets the queue treat them as complete.
  //
  // TASK-055: DEFERRED_MAILBOX_BUSY is also retryable — another job for the same
  // mailbox holds the per-mailbox lock, so this job throws to be re-attempted
  // later with backoff (bounded by the job's `attempts`, never an infinite loop).
  //
  // TASK-090: FAILED_TELEGRAM_PERMANENT is deliberately NOT in this list — a
  // permanent Telegram failure (non-retryable 4xx/validation/config) already
  // marked the ProcessedMessage terminally FAILED, so throwing here would only
  // burn a pointless BullMQ attempt. FAILED_TELEGRAM_SEND (retryable,
  // internal retries exhausted) still throws: with the TASK-090 delivery-state
  // recovery the re-attempt can actually reach the send path again.
  if (
    result.status === 'FAILED_GRAPH_FETCH' ||
    result.status === 'FAILED_RECONNECT_REQUIRED' ||
    // TASK-069C — transient token-refresh failures retry (no reconnect mark).
    result.status === 'FAILED_TOKEN_TRANSIENT' ||
    result.status === 'FAILED_TELEGRAM_SEND' ||
    result.status === 'FAILED_UNEXPECTED' ||
    result.status === 'DEFERRED_MAILBOX_BUSY'
  ) {
    throw new EmailWorkerProcessingError(result);
  }

  return result;
}

export interface CreateEmailWorkerOptions {
  /** Override queue name (defaults to EMAIL_QUEUE_NAME / env). */
  queueName?: string;
  /** Override concurrency (defaults to EMAIL_WORKER_CONCURRENCY env). */
  concurrency?: number;
  /**
   * TASK-068B — override the queue rate limiter. Defaults to the env-configured
   * limiter (EMAIL_WORKER_RATE_MAX per EMAIL_WORKER_RATE_DURATION_MS). The
   * limiter only delays job starts; it never fails or infinitely retries a job.
   */
  limiter?: { max: number; duration: number };
  /**
   * Custom pipeline implementation. Tests inject a fake; the worker script
   * passes a Prisma/Graph/Telegram-backed default constructed elsewhere.
   */
  pipeline?: EmailWorkerPipeline;
}

/**
 * Create a BullMQ Worker bound to the email queue. The worker is started
 * immediately by BullMQ, so callers (typically a dedicated worker script)
 * should manage its lifecycle. This factory is NEVER called at import time.
 */
export function createEmailWorker(
  options: CreateEmailWorkerOptions = {},
): Worker<EmailJobData> {
  const { emailQueueName, emailWorkerConcurrency } = loadQueueEnv();
  const queueName = options.queueName ?? emailQueueName ?? EMAIL_QUEUE_NAME;
  const concurrency = options.concurrency ?? emailWorkerConcurrency;
  const pipeline = options.pipeline;

  // TASK-068B — queue-level rate limiter. Caps how many jobs the worker starts
  // per window so overlapping webhook + delta-polling bursts at scale do not
  // stampede Microsoft Graph / Telegram. BullMQ delays (never drops/fails) jobs
  // that exceed the window, so this can never cause an infinite retry loop.
  const { max, durationMs } = loadEmailWorkerRateLimitEnv();
  const limiter = options.limiter ?? { max, duration: durationMs };

  // TASK-068C — production worker records aggregate latency/result metrics to
  // the shared Redis store so OWNER/ADMIN can see worker health. Best-effort.
  const metrics = getWorkerMetricsRecorder();

  const worker = new Worker<EmailJobData>(
    queueName,
    (job) => processEmailWebhookJob(job, pipeline, { metrics }),
    {
      connection: getRedisConnectionOptions(),
      concurrency,
      limiter,
    },
  );

  worker.on('failed', (job, error) => {
    logger.error('Email worker job failed', {
      jobName: job?.name,
      jobId: typeof job?.id === 'string' ? job.id : undefined,
      attemptsMade: job?.attemptsMade,
      errorName: error.name,
    });
  });

  worker.on('error', (error) => {
    logger.error('Email worker emitted error', {
      errorName: error.name,
    });
  });

  return worker;
}

export type { GraphMessagePipelineDeps, GraphMessagePipelineResult };
