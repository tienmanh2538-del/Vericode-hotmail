// TASK-031 — Enqueue helper for jobs discovered by the backup delta polling
// worker. Pushes onto the SAME BullMQ queue as the webhook receiver so the
// existing TASK-027 worker pipeline handles both sources uniformly.
//
// This file is intentionally separate from `email-queue.ts` so the delta
// polling code path is easy to grep for and its validator stays distinct from
// the webhook validator (which requires `clientStateValidated: true`).

import type { JobsOptions, Queue } from 'bullmq';

import { createLogger } from '@/lib/logger';

import {
  EMAIL_DELTA_POLLING_JOB_SOURCE,
  EMAIL_QUEUE_JOB_NAMES,
  type EmailDeltaPollingJobData,
} from './email-job.types';
import {
  getDefaultDeltaPollingJobOptions,
  validateEmailDeltaPollingJobData,
} from './email-job-options';
import { getEmailQueue } from './email-queue';

const logger = createLogger();

/**
 * Minimal queue surface used by `enqueueDeltaPollingMessageJob`. Tests pass a
 * stub matching this shape to avoid a real BullMQ / Redis connection.
 */
export interface DeltaPollingQueueLike {
  add: (
    name: string,
    data: EmailDeltaPollingJobData,
    opts?: JobsOptions,
  ) => Promise<{ id?: string | null }>;
}

export interface EnqueueDeltaPollingMessageDeps {
  queue?: DeltaPollingQueueLike;
}

export interface EnqueueDeltaPollingResult {
  jobId: string;
  jobName: string;
}

export interface EnqueueDeltaPollingMessageInput {
  mailboxId: string;
  graphMessageId: string;
  queuedAt: string;
}

/**
 * Validate and enqueue a single Microsoft Graph message id discovered via the
 * delta polling worker. The worker pipeline (TASK-027 + dedup TASK-013) is
 * responsible for actually fetching the body, detecting Facebook codes, and
 * forwarding to Telegram — the polling layer never touches any of that.
 */
export async function enqueueDeltaPollingMessageJob(
  input: EnqueueDeltaPollingMessageInput,
  deps: EnqueueDeltaPollingMessageDeps = {},
): Promise<EnqueueDeltaPollingResult> {
  const data: EmailDeltaPollingJobData = {
    mailboxId: input.mailboxId,
    graphMessageId: input.graphMessageId,
    queuedAt: input.queuedAt,
    source: EMAIL_DELTA_POLLING_JOB_SOURCE,
  };
  validateEmailDeltaPollingJobData(data);

  const jobOptions = getDefaultDeltaPollingJobOptions(data);
  const jobName = EMAIL_QUEUE_JOB_NAMES.PROCESS_MICROSOFT_GRAPH_MESSAGE;
  const queue: DeltaPollingQueueLike =
    deps.queue ?? (getEmailQueue() as unknown as Queue<EmailDeltaPollingJobData>);

  try {
    await queue.add(jobName, data, jobOptions);
  } catch (error) {
    logger.error('Failed to enqueue delta polling Graph message job', {
      jobName,
      mailboxId: data.mailboxId,
      // graphMessageId is an opaque identifier (not a secret) and helps
      // operators correlate polling → queue → worker without leaking content.
      graphMessageId: data.graphMessageId,
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    throw error;
  }

  logger.info('Delta polling Graph message job enqueued', {
    jobName,
    mailboxId: data.mailboxId,
    graphMessageId: data.graphMessageId,
  });

  return {
    jobId: jobOptions.jobId as string,
    jobName,
  };
}
