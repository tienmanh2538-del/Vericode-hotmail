import { describe, it, expect, vi, beforeEach } from 'vitest';

import type { CustomerScope } from '@/lib/auth/access-scope';
import type {
  QueueBacklogSnapshot,
  WorkerMetricsSnapshot,
} from '@/services/observability/observability.types';

const NOW = new Date('2026-06-04T12:00:00.000Z');

const fakeQueueSnapshot: QueueBacklogSnapshot = {
  queueName: 'email-processing',
  availability: 'AVAILABLE',
  counts: { waiting: 1, active: 0, delayed: 0, failed: 0, completed: 5 },
  backlogTotal: 1,
  oldestWaitingAgeMs: null,
  oldestDelayedAgeMs: null,
  status: 'OK',
  generatedAt: NOW,
};

const fakeWorkerSnapshot: WorkerMetricsSnapshot = {
  windowMs: 3_600_000,
  availability: 'AVAILABLE',
  jobs: { completed: 1, failed: 0, skipped: 0, deferred: 0 },
  queueWait: null,
  processing: null,
  mailboxBusyDefer: { count: 0 },
  destinationThrottle: null,
  globalThrottle: null,
  status: 'OK',
  generatedAt: NOW,
};

const loadQueueMock = vi.fn(async () => fakeQueueSnapshot);
const readWorkerMock = vi.fn(async () => fakeWorkerSnapshot);

vi.mock('@/services/observability/queue-observability.service', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/services/observability/queue-observability.service')
    >();
  return {
    ...actual,
    loadQueueBacklogSnapshot: (...args: unknown[]) => loadQueueMock(...(args as [])),
  };
});

vi.mock('@/services/observability/redis-worker-metrics', () => ({
  readWorkerMetricsSnapshot: (...args: unknown[]) => readWorkerMock(...(args as [])),
}));

import { loadInfraObservability } from '@/services/observability/infra-observability.service';

const ALL_SCOPE: CustomerScope = { kind: 'all' };
const STAFF_SCOPE: CustomerScope = { kind: 'assigned', customerIds: ['cust_1'] };

describe('loadInfraObservability', () => {
  beforeEach(() => {
    loadQueueMock.mockReset();
    readWorkerMock.mockReset();
    loadQueueMock.mockResolvedValue(fakeQueueSnapshot);
    readWorkerMock.mockResolvedValue(fakeWorkerSnapshot);
  });

  it('returns null for an assigned (STAFF) scope and performs no infra reads', async () => {
    const result = await loadInfraObservability(STAFF_SCOPE, NOW);

    expect(result).toBeNull();
    expect(loadQueueMock).not.toHaveBeenCalled();
    expect(readWorkerMock).not.toHaveBeenCalled();
  });

  it('returns queue + worker snapshots for OWNER/ADMIN (all scope)', async () => {
    const result = await loadInfraObservability(ALL_SCOPE, NOW);

    expect(result).not.toBeNull();
    expect(result?.queue).toEqual(fakeQueueSnapshot);
    expect(result?.worker).toEqual(fakeWorkerSnapshot);
  });

  it('degrades the worker snapshot to UNKNOWN (never crashes) when the read fails', async () => {
    readWorkerMock.mockRejectedValueOnce(new Error('redis down'));

    const result = await loadInfraObservability(ALL_SCOPE, NOW);

    expect(result).not.toBeNull();
    expect(result?.worker.availability).toBe('UNKNOWN');
    expect(result?.worker.status).toBe('UNKNOWN');
    // The queue snapshot still resolves independently.
    expect(result?.queue).toEqual(fakeQueueSnapshot);
  });
});
