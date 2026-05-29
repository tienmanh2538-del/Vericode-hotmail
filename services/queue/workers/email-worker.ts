import { Worker, type Job } from 'bullmq';

import { loadQueueEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import {
  processGraphMessageJob,
  type GraphMessagePipelineDeps,
  type GraphMessagePipelineResult,
  type GraphMessageProcessingJob,
} from '@/services/email/graph-message-pipeline.service';

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
 * TASK-027 worker. Receives validated `PROCESS_MICROSOFT_GRAPH_MESSAGE` jobs
 * and forwards them to the Graph message pipeline (load mailbox → fetch Graph
 * → detector → extractor → dedupe → Telegram).
 *
 * The processor itself never throws on a domain skip — it returns a status so
 * BullMQ does not retry deterministic skips like NO_TELEGRAM_MAPPING. It does
 * throw for transient failures (FAILED_GRAPH_FETCH, FAILED_RECONNECT_REQUIRED,
 * FAILED_TELEGRAM_SEND) so BullMQ retries based on `attempts/backoff`.
 */
export async function processEmailWebhookJob(
  job: Job<EmailJobData>,
  pipeline: EmailWorkerPipeline = processGraphMessageJob as EmailWorkerPipeline,
): Promise<GraphMessagePipelineResult | { acknowledged: true }> {
  if (job.name !== EMAIL_QUEUE_JOB_NAMES.PROCESS_MICROSOFT_GRAPH_MESSAGE) {
    logger.warn('Email worker received unknown job name', {
      jobName: job.name,
    });
    return { acknowledged: true };
  }

  // Only opaque identifiers are logged — never the payload contents.
  logger.info('Email worker received Microsoft Graph notification', {
    jobName: job.name,
    jobId: typeof job.id === 'string' ? job.id : undefined,
    mailboxId: job.data.mailboxId,
    graphMessageId: job.data.graphMessageId,
    attemptsMade: job.attemptsMade,
  });

  const result = await pipeline(toPipelineJob(job.data));

  logger.info('Email worker pipeline result', {
    jobName: job.name,
    jobId: typeof job.id === 'string' ? job.id : undefined,
    mailboxId: result.mailboxId,
    graphMessageId: result.graphMessageId,
    status: result.status,
    sentToTelegram: result.sentToTelegram ?? false,
  });

  // Transient failures should trigger BullMQ retry. Skips and CODE_SENT are
  // terminal — returning the envelope lets the queue treat them as complete.
  if (
    result.status === 'FAILED_GRAPH_FETCH' ||
    result.status === 'FAILED_RECONNECT_REQUIRED' ||
    result.status === 'FAILED_TELEGRAM_SEND' ||
    result.status === 'FAILED_UNEXPECTED'
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

  const worker = new Worker<EmailJobData>(
    queueName,
    (job) => processEmailWebhookJob(job, pipeline),
    {
      connection: getRedisConnectionOptions(),
      concurrency,
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
