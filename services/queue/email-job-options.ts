import type { JobsOptions } from 'bullmq';

import {
  EMAIL_WEBHOOK_JOB_SOURCE,
  FORBIDDEN_JOB_DATA_KEYS,
  type EmailWebhookJobData,
} from './email-job.types';

const JOB_ID_PREFIX = 'microsoft-webhook';

const DEFAULT_ATTEMPTS = 3;
const DEFAULT_BACKOFF_DELAY_MS = 5_000;
const REMOVE_ON_COMPLETE_AGE_SECONDS = 24 * 60 * 60; // 24 hours
const REMOVE_ON_COMPLETE_COUNT = 1_000;
const REMOVE_ON_FAIL_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days
const REMOVE_ON_FAIL_COUNT = 5_000;

export class InvalidEmailWebhookJobDataError extends Error {
  readonly field: string;

  constructor(field: string, message: string) {
    super(message);
    this.name = 'InvalidEmailWebhookJobDataError';
    this.field = field;
  }
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Validates the minimal shape of an EmailWebhookJobData payload before it is
 * pushed onto the queue. Throws InvalidEmailWebhookJobDataError on the first
 * failure so callers can surface a precise error to logs and tests.
 *
 * Also enforces that forbidden sensitive keys never appear on the payload.
 */
export function validateEmailWebhookJobData(
  data: unknown,
): asserts data is EmailWebhookJobData {
  if (typeof data !== 'object' || data === null) {
    throw new InvalidEmailWebhookJobDataError(
      'data',
      'Email webhook job data must be an object',
    );
  }
  const record = data as Record<string, unknown>;

  if (!isNonEmptyString(record.mailboxId)) {
    throw new InvalidEmailWebhookJobDataError(
      'mailboxId',
      'Email webhook job data is missing mailboxId',
    );
  }
  if (!isNonEmptyString(record.graphMessageId)) {
    throw new InvalidEmailWebhookJobDataError(
      'graphMessageId',
      'Email webhook job data is missing graphMessageId',
    );
  }
  if (record.clientStateValidated !== true) {
    throw new InvalidEmailWebhookJobDataError(
      'clientStateValidated',
      'Email webhook job data must have clientStateValidated === true',
    );
  }
  if (!isNonEmptyString(record.queuedAt)) {
    throw new InvalidEmailWebhookJobDataError(
      'queuedAt',
      'Email webhook job data is missing queuedAt timestamp',
    );
  }
  if (record.source !== EMAIL_WEBHOOK_JOB_SOURCE) {
    throw new InvalidEmailWebhookJobDataError(
      'source',
      `Email webhook job data source must equal "${EMAIL_WEBHOOK_JOB_SOURCE}"`,
    );
  }

  for (const forbidden of FORBIDDEN_JOB_DATA_KEYS) {
    if (Object.prototype.hasOwnProperty.call(record, forbidden)) {
      throw new InvalidEmailWebhookJobDataError(
        forbidden,
        `Email webhook job data must not contain "${forbidden}"`,
      );
    }
  }
}

/**
 * Build a stable, deterministic jobId so retries and duplicate notifications
 * deduplicate at the queue level. Format: "microsoft-webhook:{mailboxId}:{graphMessageId}".
 */
export function buildEmailJobId(data: EmailWebhookJobData): string {
  validateEmailWebhookJobData(data);
  return `${JOB_ID_PREFIX}:${data.mailboxId}:${data.graphMessageId}`;
}

/**
 * Default BullMQ job options for Microsoft Graph email notifications.
 * - attempts: 3 retries
 * - backoff: exponential, 5s base delay
 * - removeOnComplete: keep 24h or last 1000
 * - removeOnFail: keep 7 days or last 5000 (so failures can be inspected)
 */
export function getDefaultEmailJobOptions(
  data: EmailWebhookJobData,
): JobsOptions {
  return {
    jobId: buildEmailJobId(data),
    attempts: DEFAULT_ATTEMPTS,
    backoff: {
      type: 'exponential',
      delay: DEFAULT_BACKOFF_DELAY_MS,
    },
    removeOnComplete: {
      age: REMOVE_ON_COMPLETE_AGE_SECONDS,
      count: REMOVE_ON_COMPLETE_COUNT,
    },
    removeOnFail: {
      age: REMOVE_ON_FAIL_AGE_SECONDS,
      count: REMOVE_ON_FAIL_COUNT,
    },
  };
}
