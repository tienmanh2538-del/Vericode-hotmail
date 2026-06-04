// TASK-068C — Infrastructure observability loader (scope-gated, safe).
//
// Combines the queue backlog snapshot + the worker metrics snapshot into one
// read-only object for the health dashboard. Global infra signals are
// OWNER/ADMIN-only: a STAFF_READ_ONLY (assigned) scope gets `null` because this
// data cannot be scoped per-customer (defence in depth — the page also hides
// the section). It NEVER throws: every read is best-effort and degrades to an
// UNKNOWN snapshot so `/admin/health` keeps rendering.

import type { CustomerScope } from '@/lib/auth/access-scope';

import { EMAIL_QUEUE_NAME } from '@/services/queue/email-job.types';
import {
  loadQueueBacklogSnapshot,
  withObservabilityTimeout,
} from './queue-observability.service';
import { readWorkerMetricsSnapshot } from './redis-worker-metrics';
import {
  emptyWorkerSnapshot,
  WORKER_METRICS_DEFAULT_WINDOW_MS,
} from './worker-metrics';
import type {
  InfraObservability,
  QueueBacklogSnapshot,
  WorkerMetricsSnapshot,
} from './observability.types';

export type InfraObservabilityLoader = (
  scope: CustomerScope,
  now: Date,
) => Promise<InfraObservability | null>;

/** Cap on the worker-metrics Redis read before degrading to UNKNOWN. */
export const WORKER_METRICS_READ_TIMEOUT_MS = 1_500;

function unknownQueueSnapshot(now: Date): QueueBacklogSnapshot {
  return {
    queueName: EMAIL_QUEUE_NAME,
    availability: 'UNKNOWN',
    counts: null,
    backlogTotal: null,
    oldestWaitingAgeMs: null,
    oldestDelayedAgeMs: null,
    status: 'UNKNOWN',
    generatedAt: now,
  };
}

async function loadWorkerSnapshotSafe(now: Date): Promise<WorkerMetricsSnapshot> {
  try {
    return await withObservabilityTimeout(
      readWorkerMetricsSnapshot(now.getTime()),
      WORKER_METRICS_READ_TIMEOUT_MS,
    );
  } catch {
    return emptyWorkerSnapshot('UNKNOWN', WORKER_METRICS_DEFAULT_WINDOW_MS, now);
  }
}

/**
 * Load infra observability for the given scope. Returns null for any non-`all`
 * scope (STAFF) so global infrastructure metrics never cross the scope
 * boundary. For OWNER/ADMIN it always resolves to an object — UNKNOWN parts
 * when a signal is unreachable, never a thrown error.
 */
export async function loadInfraObservability(
  scope: CustomerScope,
  now: Date = new Date(),
): Promise<InfraObservability | null> {
  if (scope.kind !== 'all') return null;

  try {
    const [queue, worker] = await Promise.all([
      loadQueueBacklogSnapshot({ now }),
      loadWorkerSnapshotSafe(now),
    ]);
    return { queue, worker };
  } catch {
    // Both readers are already best-effort; this is a final safety net.
    return {
      queue: unknownQueueSnapshot(now),
      worker: emptyWorkerSnapshot('UNKNOWN', WORKER_METRICS_DEFAULT_WINDOW_MS, now),
    };
  }
}
