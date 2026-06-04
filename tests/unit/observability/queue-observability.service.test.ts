import { describe, it, expect, vi } from 'vitest';

import {
  classifyQueueBacklog,
  loadQueueBacklogSnapshot,
  QUEUE_BACKLOG_CRITICAL,
  QUEUE_BACKLOG_WARN,
  type QueueBacklogPort,
} from '@/services/observability/queue-observability.service';

const NOW = new Date('2026-06-04T12:00:00.000Z');

interface QueueOpts {
  counts?: Record<string, number>;
  countsError?: boolean;
  waiting?: Array<{ timestamp?: number }>;
  delayed?: Array<{ timestamp?: number }>;
  listError?: boolean;
  name?: string;
}

function makeQueue(opts: QueueOpts = {}): QueueBacklogPort {
  return {
    name: opts.name ?? 'email-processing',
    getJobCounts: vi.fn(async () => {
      if (opts.countsError) throw new Error('redis down at redis://secret');
      return opts.counts ?? {};
    }),
    getWaiting: vi.fn(async () => {
      if (opts.listError) throw new Error('redis down');
      return opts.waiting ?? [];
    }),
    getDelayed: vi.fn(async () => {
      if (opts.listError) throw new Error('redis down');
      return opts.delayed ?? [];
    }),
  };
}

describe('loadQueueBacklogSnapshot', () => {
  it('returns AVAILABLE counts + backlog + oldest age when the queue is readable', async () => {
    const queue = makeQueue({
      counts: { waiting: 3, active: 1, delayed: 2, failed: 0, completed: 10 },
      waiting: [{ timestamp: NOW.getTime() - 60_000 }],
    });

    const snapshot = await loadQueueBacklogSnapshot({ queue, now: NOW });

    expect(snapshot.availability).toBe('AVAILABLE');
    expect(snapshot.counts).toEqual({
      waiting: 3,
      active: 1,
      delayed: 2,
      failed: 0,
      completed: 10,
    });
    expect(snapshot.backlogTotal).toBe(5);
    expect(snapshot.oldestWaitingAgeMs).toBe(60_000);
    expect(snapshot.status).toBe('OK');
    expect(snapshot.queueName).toBe('email-processing');
  });

  it('degrades to UNKNOWN (never throws) when the queue read fails', async () => {
    const queue = makeQueue({ countsError: true });

    const snapshot = await loadQueueBacklogSnapshot({ queue, now: NOW });

    expect(snapshot.availability).toBe('UNKNOWN');
    expect(snapshot.counts).toBeNull();
    expect(snapshot.backlogTotal).toBeNull();
    expect(snapshot.status).toBe('UNKNOWN');
  });

  it('keeps AVAILABLE counts when the oldest-age read fails (best-effort)', async () => {
    const queue = makeQueue({
      counts: { waiting: 1, active: 0, delayed: 0, failed: 0, completed: 0 },
      listError: true,
    });

    const snapshot = await loadQueueBacklogSnapshot({ queue, now: NOW });

    expect(snapshot.availability).toBe('AVAILABLE');
    expect(snapshot.counts?.waiting).toBe(1);
    expect(snapshot.oldestWaitingAgeMs).toBeNull();
    expect(snapshot.oldestDelayedAgeMs).toBeNull();
  });

  it('does not leak the Redis URL in any returned field', async () => {
    const queue = makeQueue({ countsError: true });
    const snapshot = await loadQueueBacklogSnapshot({ queue, now: NOW });
    expect(JSON.stringify(snapshot)).not.toMatch(/redis:\/\//);
  });
});

describe('classifyQueueBacklog', () => {
  const zero = { waiting: 0, active: 0, delayed: 0, failed: 0, completed: 0 };

  it('is OK for a small backlog and fresh oldest job', () => {
    expect(classifyQueueBacklog({ ...zero, waiting: 5 }, 1_000)).toBe('OK');
  });

  it('is WARN at the warn backlog threshold', () => {
    expect(
      classifyQueueBacklog({ ...zero, waiting: QUEUE_BACKLOG_WARN }, 0),
    ).toBe('WARN');
  });

  it('is CRITICAL at the critical backlog threshold', () => {
    expect(
      classifyQueueBacklog({ ...zero, waiting: QUEUE_BACKLOG_CRITICAL }, 0),
    ).toBe('CRITICAL');
  });

  it('escalates on a very old oldest waiting job', () => {
    expect(classifyQueueBacklog(zero, 20 * 60_000)).toBe('CRITICAL');
  });
});
