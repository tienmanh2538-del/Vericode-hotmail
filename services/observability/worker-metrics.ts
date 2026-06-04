// TASK-068C — Worker metrics: recorder seam + pure aggregation helpers.
//
// The email worker and the web (health dashboard) run in SEPARATE processes, so
// in-process counters are invisible to the dashboard. To keep cross-process
// visibility (and survive multiple worker replicas) the metrics are written to
// short-TTL Redis buckets; the Redis glue lives in `redis-worker-metrics.ts`.
//
// This module is PURE and side-effect free: it defines the recorder interface,
// a no-op recorder, the Redis key/field schema, and the bucket aggregation +
// status classification used by both the writer and the reader. Everything is
// aggregate-only — counts and millisecond durations, never a code/email/token.

import type {
  LatencyAggregate,
  ObservabilityStatus,
  ThrottleAggregate,
  WorkerJobCounts,
  WorkerMetricsSnapshot,
} from './observability.types';

// ---------------------------------------------------------------------------
// Recorder seam (write side)
// ---------------------------------------------------------------------------

export type WorkerJobResult = 'completed' | 'failed' | 'skipped' | 'deferred';

export interface RecordJobResultInput {
  result: WorkerJobResult;
  /** ms the job waited in queue before processing. Null = not measurable. */
  queueWaitMs: number | null;
  /** ms spent running the pipeline. Null = not measurable. */
  processingDurationMs: number | null;
}

/**
 * Best-effort metrics sink. Every method is fire-and-forget and MUST NOT throw
 * or block the caller — observability can never break code delivery. Callers
 * still wrap invocations defensively (see `recordWorkerMetricSafely`).
 */
export interface WorkerMetricsRecorder {
  recordJobResult(input: RecordJobResultInput): void;
  recordMailboxBusyDefer(): void;
  recordDestinationThrottleWait(waitMs: number): void;
  recordGlobalThrottleWait(waitMs: number): void;
}

export function createNoopWorkerMetricsRecorder(): WorkerMetricsRecorder {
  return {
    recordJobResult() {},
    recordMailboxBusyDefer() {},
    recordDestinationThrottleWait() {},
    recordGlobalThrottleWait() {},
  };
}

/**
 * Invoke a recorder action with a hard safety net. Observability writes must
 * never bubble an error into the delivery pipeline or the worker loop.
 */
export function recordWorkerMetricSafely(action: () => void): void {
  try {
    action();
  } catch {
    // Intentionally swallowed — metrics are best-effort by contract.
  }
}

// ---------------------------------------------------------------------------
// Redis key / field schema (shared by writer + reader)
// ---------------------------------------------------------------------------

export const WORKER_METRICS_KEY_PREFIX = 'obs:wm:';
/** Bucket width. Events fold into the bucket for their wall-clock minute slot. */
export const WORKER_METRICS_BUCKET_MS = 5 * 60_000;
/** How long each bucket is retained (also the default read window). */
export const WORKER_METRICS_RETENTION_MS = 60 * 60_000;
export const WORKER_METRICS_DEFAULT_WINDOW_MS = 60 * 60_000;

/** Hash field names. Short + opaque — never a code/email/token/customer id. */
export const WORKER_METRIC_FIELDS = {
  jobsCompleted: 'j.completed',
  jobsFailed: 'j.failed',
  jobsSkipped: 'j.skipped',
  jobsDeferred: 'j.deferred',
  queueWaitCount: 'qw.c',
  queueWaitSum: 'qw.s',
  queueWaitMax: 'qw.m',
  processingCount: 'pr.c',
  processingSum: 'pr.s',
  processingMax: 'pr.m',
  deferCount: 'df.c',
  destinationCount: 'dt.c',
  destinationSum: 'dt.s',
  destinationMax: 'dt.m',
  globalCount: 'gt.c',
  globalSum: 'gt.s',
  globalMax: 'gt.m',
} as const;

export type MetricOp = 'incr' | 'max';

export interface MetricMutation {
  field: string;
  op: MetricOp;
  value: number;
}

const JOB_RESULT_FIELD: Record<WorkerJobResult, string> = {
  completed: WORKER_METRIC_FIELDS.jobsCompleted,
  failed: WORKER_METRIC_FIELDS.jobsFailed,
  skipped: WORKER_METRIC_FIELDS.jobsSkipped,
  deferred: WORKER_METRIC_FIELDS.jobsDeferred,
};

function isFiniteNonNegative(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function latencyMutations(
  countField: string,
  sumFieldName: string,
  maxFieldName: string,
  ms: number,
): MetricMutation[] {
  const rounded = Math.round(ms);
  return [
    { field: countField, op: 'incr', value: 1 },
    { field: sumFieldName, op: 'incr', value: rounded },
    { field: maxFieldName, op: 'max', value: rounded },
  ];
}

export function buildJobResultMutations(
  input: RecordJobResultInput,
): MetricMutation[] {
  const mutations: MetricMutation[] = [
    { field: JOB_RESULT_FIELD[input.result], op: 'incr', value: 1 },
  ];
  if (isFiniteNonNegative(input.queueWaitMs)) {
    mutations.push(
      ...latencyMutations(
        WORKER_METRIC_FIELDS.queueWaitCount,
        WORKER_METRIC_FIELDS.queueWaitSum,
        WORKER_METRIC_FIELDS.queueWaitMax,
        input.queueWaitMs,
      ),
    );
  }
  if (isFiniteNonNegative(input.processingDurationMs)) {
    mutations.push(
      ...latencyMutations(
        WORKER_METRIC_FIELDS.processingCount,
        WORKER_METRIC_FIELDS.processingSum,
        WORKER_METRIC_FIELDS.processingMax,
        input.processingDurationMs,
      ),
    );
  }
  return mutations;
}

export function buildMailboxBusyDeferMutations(): MetricMutation[] {
  return [{ field: WORKER_METRIC_FIELDS.deferCount, op: 'incr', value: 1 }];
}

export function buildDestinationThrottleMutations(waitMs: number): MetricMutation[] {
  if (!isFiniteNonNegative(waitMs)) return [];
  return latencyMutations(
    WORKER_METRIC_FIELDS.destinationCount,
    WORKER_METRIC_FIELDS.destinationSum,
    WORKER_METRIC_FIELDS.destinationMax,
    waitMs,
  );
}

export function buildGlobalThrottleMutations(waitMs: number): MetricMutation[] {
  if (!isFiniteNonNegative(waitMs)) return [];
  return latencyMutations(
    WORKER_METRIC_FIELDS.globalCount,
    WORKER_METRIC_FIELDS.globalSum,
    WORKER_METRIC_FIELDS.globalMax,
    waitMs,
  );
}

// ---------------------------------------------------------------------------
// Bucket key helpers
// ---------------------------------------------------------------------------

export function bucketKeyForEpoch(epochMs: number): string {
  return `${WORKER_METRICS_KEY_PREFIX}${Math.floor(epochMs / WORKER_METRICS_BUCKET_MS)}`;
}

/**
 * The bucket keys covering [now - windowMs, now], inclusive of both ends'
 * buckets. Always returns at least one key.
 */
export function bucketKeysForWindow(nowMs: number, windowMs: number): string[] {
  const span = Math.max(0, windowMs);
  const firstBucket = Math.floor((nowMs - span) / WORKER_METRICS_BUCKET_MS);
  const lastBucket = Math.floor(nowMs / WORKER_METRICS_BUCKET_MS);
  const keys: string[] = [];
  for (let bucket = firstBucket; bucket <= lastBucket; bucket += 1) {
    keys.push(`${WORKER_METRICS_KEY_PREFIX}${bucket}`);
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Aggregation (read side, pure)
// ---------------------------------------------------------------------------

function toInt(raw: string | undefined): number {
  if (raw === undefined) return 0;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : 0;
}

function sumField(hashes: ReadonlyArray<Record<string, string>>, field: string): number {
  return hashes.reduce((total, hash) => total + toInt(hash[field]), 0);
}

function maxField(hashes: ReadonlyArray<Record<string, string>>, field: string): number {
  return hashes.reduce((best, hash) => Math.max(best, toInt(hash[field])), 0);
}

function buildLatency(
  hashes: ReadonlyArray<Record<string, string>>,
  countField: string,
  sumFieldName: string,
  maxFieldName: string,
): LatencyAggregate {
  const count = sumField(hashes, countField);
  const totalMs = sumField(hashes, sumFieldName);
  const maxMs = maxField(hashes, maxFieldName);
  return {
    count,
    totalMs,
    maxMs,
    avgMs: count > 0 ? Math.round(totalMs / count) : null,
  };
}

function buildThrottle(
  hashes: ReadonlyArray<Record<string, string>>,
  countField: string,
  sumFieldName: string,
  maxFieldName: string,
): ThrottleAggregate {
  const count = sumField(hashes, countField);
  const totalWaitMs = sumField(hashes, sumFieldName);
  const maxWaitMs = maxField(hashes, maxFieldName);
  return {
    count,
    totalWaitMs,
    maxWaitMs,
    avgWaitMs: count > 0 ? Math.round(totalWaitMs / count) : null,
  };
}

// Status thresholds (named constants — no magic numbers). Display-only
// heuristics; they never change delivery behaviour.
export const WORKER_QUEUE_WAIT_WARN_MS = 30_000;
export const WORKER_QUEUE_WAIT_CRITICAL_MS = 120_000;
export const WORKER_FAILED_WARN = 1;
export const WORKER_FAILED_CRITICAL = 5;

export function classifyWorkerStatus(
  jobs: WorkerJobCounts | null,
  queueWait: LatencyAggregate | null,
): ObservabilityStatus {
  if (!jobs) return 'UNKNOWN';
  const total = jobs.completed + jobs.failed + jobs.skipped + jobs.deferred;
  if (total === 0) return 'UNKNOWN';

  const maxWait = queueWait?.maxMs ?? 0;
  if (jobs.failed >= WORKER_FAILED_CRITICAL || maxWait >= WORKER_QUEUE_WAIT_CRITICAL_MS) {
    return 'CRITICAL';
  }
  if (jobs.failed >= WORKER_FAILED_WARN || maxWait >= WORKER_QUEUE_WAIT_WARN_MS) {
    return 'WARN';
  }
  return 'OK';
}

export function emptyWorkerSnapshot(
  availability: WorkerMetricsSnapshot['availability'],
  windowMs: number,
  generatedAt: Date,
): WorkerMetricsSnapshot {
  return {
    windowMs,
    availability,
    jobs: null,
    queueWait: null,
    processing: null,
    mailboxBusyDefer: null,
    destinationThrottle: null,
    globalThrottle: null,
    status: 'UNKNOWN',
    generatedAt,
  };
}

/**
 * Fold the per-bucket hashes that cover the window into one snapshot. Missing
 * buckets arrive as empty objects, so an idle window yields zeroed aggregates
 * (status UNKNOWN — "no activity to judge"), never a crash.
 */
export function aggregateBuckets(
  hashes: ReadonlyArray<Record<string, string>>,
  windowMs: number,
  generatedAt: Date,
): WorkerMetricsSnapshot {
  const jobs: WorkerJobCounts = {
    completed: sumField(hashes, WORKER_METRIC_FIELDS.jobsCompleted),
    failed: sumField(hashes, WORKER_METRIC_FIELDS.jobsFailed),
    skipped: sumField(hashes, WORKER_METRIC_FIELDS.jobsSkipped),
    deferred: sumField(hashes, WORKER_METRIC_FIELDS.jobsDeferred),
  };
  const queueWait = buildLatency(
    hashes,
    WORKER_METRIC_FIELDS.queueWaitCount,
    WORKER_METRIC_FIELDS.queueWaitSum,
    WORKER_METRIC_FIELDS.queueWaitMax,
  );
  const processing = buildLatency(
    hashes,
    WORKER_METRIC_FIELDS.processingCount,
    WORKER_METRIC_FIELDS.processingSum,
    WORKER_METRIC_FIELDS.processingMax,
  );
  const destinationThrottle = buildThrottle(
    hashes,
    WORKER_METRIC_FIELDS.destinationCount,
    WORKER_METRIC_FIELDS.destinationSum,
    WORKER_METRIC_FIELDS.destinationMax,
  );
  const globalThrottle = buildThrottle(
    hashes,
    WORKER_METRIC_FIELDS.globalCount,
    WORKER_METRIC_FIELDS.globalSum,
    WORKER_METRIC_FIELDS.globalMax,
  );

  return {
    windowMs,
    availability: 'AVAILABLE',
    jobs,
    queueWait,
    processing,
    mailboxBusyDefer: { count: sumField(hashes, WORKER_METRIC_FIELDS.deferCount) },
    destinationThrottle,
    globalThrottle,
    status: classifyWorkerStatus(jobs, queueWait),
    generatedAt,
  };
}
