// TASK-068C — Queue backlog snapshot (read-only).
//
// Reads BullMQ job counts + oldest-job ages for the email queue so OWNER/ADMIN
// can see whether the backlog is healthy before the 100-mailbox validation
// (TASK-068D). It NEVER throws into the caller: any Redis/BullMQ failure (or a
// slow connection) degrades to an UNKNOWN snapshot so `/admin/health` keeps
// rendering. The Redis URL is never logged or returned.

import { createLogger } from '@/lib/logger';
import { EMAIL_QUEUE_NAME } from '@/services/queue/email-job.types';

import type {
  ObservabilityStatus,
  QueueBacklogSnapshot,
  QueueJobCounts,
} from './observability.types';

const logger = createLogger();

/** Default cap on how long we wait for queue reads before degrading. */
export const QUEUE_OBSERVABILITY_TIMEOUT_MS = 1_500;

// Backlog thresholds (named constants — display-only heuristics).
export const QUEUE_BACKLOG_WARN = 50;
export const QUEUE_BACKLOG_CRITICAL = 200;
export const QUEUE_OLDEST_WAIT_WARN_MS = 5 * 60_000;
export const QUEUE_OLDEST_WAIT_CRITICAL_MS = 15 * 60_000;

interface QueueBacklogJob {
  timestamp?: number;
}

/** Minimal BullMQ Queue surface used here. Tests pass a stub matching it. */
export interface QueueBacklogPort {
  name: string;
  getJobCounts(...types: string[]): Promise<Record<string, number>>;
  getWaiting(start?: number, end?: number): Promise<QueueBacklogJob[]>;
  getDelayed(start?: number, end?: number): Promise<QueueBacklogJob[]>;
}

export interface LoadQueueBacklogDeps {
  queue?: QueueBacklogPort;
  now?: Date;
  timeoutMs?: number;
}

/** Reject `promise` if it does not settle within `ms`. */
export async function withObservabilityTimeout<T>(
  promise: Promise<T>,
  ms: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('observability read timed out')),
          ms,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function normalizeCounts(raw: Record<string, number>): QueueJobCounts {
  const value = (key: string): number => {
    const n = raw[key];
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : 0;
  };
  return {
    waiting: value('waiting'),
    active: value('active'),
    delayed: value('delayed'),
    failed: value('failed'),
    completed: value('completed'),
  };
}

function oldestAgeMs(jobs: QueueBacklogJob[], now: Date): number | null {
  const first = jobs[0];
  if (!first || typeof first.timestamp !== 'number') return null;
  const age = now.getTime() - first.timestamp;
  return age >= 0 ? age : null;
}

export function classifyQueueBacklog(
  counts: QueueJobCounts,
  oldestWaitingAgeMs: number | null,
): ObservabilityStatus {
  const backlog = counts.waiting + counts.delayed;
  const oldest = oldestWaitingAgeMs ?? 0;
  if (backlog >= QUEUE_BACKLOG_CRITICAL || oldest >= QUEUE_OLDEST_WAIT_CRITICAL_MS) {
    return 'CRITICAL';
  }
  if (backlog >= QUEUE_BACKLOG_WARN || oldest >= QUEUE_OLDEST_WAIT_WARN_MS) {
    return 'WARN';
  }
  return 'OK';
}

function unknownSnapshot(queueName: string, now: Date): QueueBacklogSnapshot {
  return {
    queueName,
    availability: 'UNKNOWN',
    counts: null,
    backlogTotal: null,
    oldestWaitingAgeMs: null,
    oldestDelayedAgeMs: null,
    status: 'UNKNOWN',
    generatedAt: now,
  };
}

async function resolveDefaultQueue(): Promise<QueueBacklogPort> {
  const { getEmailQueue } = await import('@/services/queue/email-queue');
  return getEmailQueue() as unknown as QueueBacklogPort;
}

/**
 * Build a safe queue backlog snapshot. Counts come first (the primary signal);
 * oldest-job ages are an independent best-effort read so a failure there still
 * yields AVAILABLE counts. Any failure to read counts degrades to UNKNOWN.
 */
export async function loadQueueBacklogSnapshot(
  deps: LoadQueueBacklogDeps = {},
): Promise<QueueBacklogSnapshot> {
  const now = deps.now ?? new Date();
  const timeoutMs = deps.timeoutMs ?? QUEUE_OBSERVABILITY_TIMEOUT_MS;

  let queue: QueueBacklogPort;
  try {
    queue = deps.queue ?? (await resolveDefaultQueue());
  } catch {
    // Could not even construct the queue (e.g. invalid env) — never crash.
    logger.warn('Queue observability: unable to resolve email queue');
    return unknownSnapshot(EMAIL_QUEUE_NAME, now);
  }

  const queueName = queue.name || EMAIL_QUEUE_NAME;

  try {
    const rawCounts = await withObservabilityTimeout(
      queue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed'),
      timeoutMs,
    );
    const counts = normalizeCounts(rawCounts);

    // Oldest-age reads are best-effort and must not flip AVAILABLE → UNKNOWN.
    let oldestWaitingAgeMs: number | null = null;
    let oldestDelayedAgeMs: number | null = null;
    try {
      const [waiting, delayed] = await withObservabilityTimeout(
        Promise.all([queue.getWaiting(0, 0), queue.getDelayed(0, 0)]),
        timeoutMs,
      );
      oldestWaitingAgeMs = oldestAgeMs(waiting, now);
      oldestDelayedAgeMs = oldestAgeMs(delayed, now);
    } catch {
      // Leave ages null; counts are still trustworthy.
    }

    return {
      queueName,
      availability: 'AVAILABLE',
      counts,
      backlogTotal: counts.waiting + counts.delayed,
      oldestWaitingAgeMs,
      oldestDelayedAgeMs,
      status: classifyQueueBacklog(counts, oldestWaitingAgeMs),
      generatedAt: now,
    };
  } catch {
    // Redis down / slow / BullMQ error — degrade safely. No URL is logged.
    logger.warn('Queue observability: failed to read queue job counts', {
      queueName,
    });
    return unknownSnapshot(queueName, now);
  }
}
