import { Worker, type Job } from 'bullmq';

import { loadQueueEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';

import {
  EMAIL_QUEUE_JOB_NAMES,
  EMAIL_QUEUE_NAME,
  type EmailWebhookJobData,
} from '../email-job.types';
import { getRedisConnectionOptions } from '../redis-connection';

const logger = createLogger();

/**
 * TASK-026 worker foundation. This worker accepts
 * `PROCESS_MICROSOFT_GRAPH_MESSAGE` jobs and logs safe metadata only.
 *
 * TASK-027 will implement the real email processing pipeline:
 *   Graph message → Facebook detector → code extractor → dedupe → Telegram.
 *
 * Until then, the processor is a no-op placeholder.
 */
export async function processEmailWebhookJob(
  job: Job<EmailWebhookJobData>,
): Promise<{ acknowledged: true }> {
  if (job.name !== EMAIL_QUEUE_JOB_NAMES.PROCESS_MICROSOFT_GRAPH_MESSAGE) {
    logger.warn('Email worker received unknown job name', {
      jobName: job.name,
    });
    return { acknowledged: true };
  }

  // Only log opaque identifiers — never the full payload.
  logger.info(
    'Email worker received Microsoft Graph notification (TASK-027 will implement real pipeline)',
    {
      jobName: job.name,
      jobId: typeof job.id === 'string' ? job.id : undefined,
      mailboxId: job.data.mailboxId,
      graphMessageId: job.data.graphMessageId,
      attemptsMade: job.attemptsMade,
    },
  );

  return { acknowledged: true };
}

export interface CreateEmailWorkerOptions {
  /** Override queue name (defaults to EMAIL_QUEUE_NAME / env). */
  queueName?: string;
  /** Override concurrency (defaults to EMAIL_WORKER_CONCURRENCY env). */
  concurrency?: number;
}

/**
 * Create a BullMQ Worker bound to the email queue. The worker is started
 * immediately by BullMQ, so callers (typically a dedicated worker script)
 * should manage its lifecycle. This factory is NEVER called at import time.
 */
export function createEmailWorker(
  options: CreateEmailWorkerOptions = {},
): Worker<EmailWebhookJobData> {
  const { emailQueueName, emailWorkerConcurrency } = loadQueueEnv();
  const queueName = options.queueName ?? emailQueueName ?? EMAIL_QUEUE_NAME;
  const concurrency = options.concurrency ?? emailWorkerConcurrency;

  const worker = new Worker<EmailWebhookJobData>(
    queueName,
    processEmailWebhookJob,
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
