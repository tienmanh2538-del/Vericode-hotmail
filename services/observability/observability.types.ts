// TASK-068C — Observability types for queue backlog, worker latency, and
// throttle/defer signals.
//
// These shapes are strictly UI-safe and aggregate-only. Nothing here ever
// carries a token, refresh token, client secret, Telegram bot token, database
// URL, Redis URL, verification code, or email body — only derived counts,
// durations (ms), and status enums. They exist so OWNER/ADMIN can judge whether
// the system is ready for the 100-mailbox validation (TASK-068D) without
// exposing any per-customer / per-code detail.

/** Whether a signal could be read at all. AVAILABLE = real numbers present. */
export type ObservabilityAvailability = 'AVAILABLE' | 'DEGRADED' | 'UNKNOWN';

/** Derived health summary for a single observability signal. */
export type ObservabilityStatus = 'OK' | 'WARN' | 'CRITICAL' | 'UNKNOWN';

export interface QueueJobCounts {
  waiting: number;
  active: number;
  delayed: number;
  failed: number;
  completed: number;
}

export interface QueueBacklogSnapshot {
  queueName: string;
  availability: ObservabilityAvailability;
  /** Null when the queue/Redis could not be read (availability !== AVAILABLE). */
  counts: QueueJobCounts | null;
  /** waiting + delayed; null when counts are unavailable. */
  backlogTotal: number | null;
  /** Age (ms) of the oldest waiting job, best-effort. Null when not readable. */
  oldestWaitingAgeMs: number | null;
  /** Age (ms) of the oldest delayed job, best-effort. Null when not readable. */
  oldestDelayedAgeMs: number | null;
  status: ObservabilityStatus;
  generatedAt: Date;
}

/** Latency roll-up. avgMs is derived from totalMs/count (null when count = 0). */
export interface LatencyAggregate {
  count: number;
  totalMs: number;
  maxMs: number;
  avgMs: number | null;
}

/** Throttle/wait roll-up. avgWaitMs is derived (null when count = 0). */
export interface ThrottleAggregate {
  count: number;
  totalWaitMs: number;
  maxWaitMs: number;
  avgWaitMs: number | null;
}

export interface WorkerJobCounts {
  completed: number;
  failed: number;
  skipped: number;
  deferred: number;
}

export interface WorkerMetricsSnapshot {
  /** Lookback window the aggregates cover. */
  windowMs: number;
  availability: ObservabilityAvailability;
  jobs: WorkerJobCounts | null;
  /** Time a job waited in the queue before processing started. */
  queueWait: LatencyAggregate | null;
  /** Time spent processing a job (pipeline run duration). */
  processing: LatencyAggregate | null;
  /** Mailbox-busy fairness defers (TASK-068B). */
  mailboxBusyDefer: { count: number } | null;
  /** Per-destination throttle waits (TASK-055). */
  destinationThrottle: ThrottleAggregate | null;
  /** Global Telegram bot pacing waits (TASK-068B). */
  globalThrottle: ThrottleAggregate | null;
  status: ObservabilityStatus;
  generatedAt: Date;
}

/** Combined infrastructure observability surfaced to OWNER/ADMIN only. */
export interface InfraObservability {
  queue: QueueBacklogSnapshot;
  worker: WorkerMetricsSnapshot;
}
