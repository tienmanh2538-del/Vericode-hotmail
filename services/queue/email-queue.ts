import { Queue, type JobsOptions } from 'bullmq';

import { loadQueueEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';

import {
  EMAIL_QUEUE_JOB_NAMES,
  EMAIL_QUEUE_NAME,
  type EmailJobData,
  type EmailWebhookJobData,
} from './email-job.types';
import {
  getDefaultEmailJobOptions,
  validateEmailWebhookJobData,
} from './email-job-options';
import { getRedisConnectionOptions } from './redis-connection';

const logger = createLogger();

/**
 * Minimal queue surface used by `enqueueMicrosoftGraphMessageJob`. Tests can
 * pass a stub matching this shape to avoid a real BullMQ / Redis connection.
 */
export interface EmailQueueLike {
  add: (
    name: string,
    data: EmailWebhookJobData,
    opts?: JobsOptions,
  ) => Promise<{ id?: string | null }>;
}

// TASK-031 — Both webhook and delta-polling payloads land on the same BullMQ
// queue so the existing TASK-027 worker pipeline processes them uniformly.
type EmailQueue = Queue<EmailJobData>;

let cachedQueue: EmailQueue | null = null;

function resolveQueueName(): string {
  const { emailQueueName } = loadQueueEnv();
  if (emailQueueName.length === 0) return EMAIL_QUEUE_NAME;
  return emailQueueName;
}

/**
 * Lazily build (and cache) the singleton BullMQ Queue. The Redis connection
 * is created on first call only. Import-time side effects are avoided.
 */
export function getEmailQueue(): EmailQueue {
  if (cachedQueue !== null) return cachedQueue;
  const queue: EmailQueue = new Queue<EmailJobData>(resolveQueueName(), {
    connection: getRedisConnectionOptions(),
    defaultJobOptions: {
      removeOnComplete: true,
      removeOnFail: false,
    },
  });
  cachedQueue = queue;
  return queue;
}

/**
 * For testing only: drop the cached Queue without touching Redis.
 */
export function __resetEmailQueueForTests(): void {
  cachedQueue = null;
}

export interface EnqueueMicrosoftGraphMessageDeps {
  queue?: EmailQueueLike;
}

export interface EnqueueResult {
  jobId: string;
  jobName: string;
  queueName: string;
}

/**
 * Validate and enqueue a single Microsoft Graph webhook notification.
 *
 * Callers MUST only invoke this after clientState has been validated against
 * the stored subscription hash — see `webhook-notification.service.ts`.
 *
 * The function does NOT call the Graph API, the Facebook detector, the code
 * extractor, or Telegram. Those land in TASK-027+.
 */
export async function enqueueMicrosoftGraphMessageJob(
  data: EmailWebhookJobData,
  deps: EnqueueMicrosoftGraphMessageDeps = {},
): Promise<EnqueueResult> {
  validateEmailWebhookJobData(data);

  const jobOptions = getDefaultEmailJobOptions(data);
  const jobName = EMAIL_QUEUE_JOB_NAMES.PROCESS_MICROSOFT_GRAPH_MESSAGE;
  const queue = deps.queue ?? getEmailQueue();
  const queueName = resolveQueueName();

  try {
    await queue.add(jobName, data, jobOptions);
  } catch (error) {
    logger.error('Failed to enqueue Microsoft Graph message job', {
      jobName,
      queueName,
      hasJobId: typeof jobOptions.jobId === 'string',
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    throw error;
  }

  logger.info('Microsoft Graph message job enqueued', {
    jobName,
    queueName,
    mailboxId: data.mailboxId,
    // graphMessageId is an opaque identifier, not a secret. Logging helps
    // operators correlate webhook → queue → worker without exposing content.
    graphMessageId: data.graphMessageId,
  });

  return {
    jobId: jobOptions.jobId as string,
    jobName,
    queueName,
  };
}
