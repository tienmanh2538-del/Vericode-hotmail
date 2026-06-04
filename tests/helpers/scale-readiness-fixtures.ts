// TASK-068D — Fixtures + harness for the ~100-mailbox readiness validation.
//
// Everything here is SYNTHETIC. There is no real mailbox, customer, Telegram
// chat id, Microsoft Graph token, or verification code anywhere in this file.
// The harness drives the REAL production code path:
//
//   makeWebhookJob/makeDeltaJob  →  processEmailWebhookJob (worker, real)
//                                       →  processGraphMessageJob (pipeline, real)
//                                            → in-memory ProcessedMessage store (real)
//                                            → in-memory mailbox lock (real, TASK-055/068A)
//                                            → in-memory destination + global throttle
//                                              (real, TASK-055/068B)
//                                            → worker-metrics recorder (real builders,
//                                              TASK-068C aggregation)
//                                            → MOCK Microsoft Graph fetch port
//                                            → MOCK Telegram send port (counts only)
//
// SECURITY (docs/SECURITY_RULES.md + AGENTS.md):
//   - No `.env*` is read. No real Graph/Telegram call is made. No real token.
//   - The Telegram sender is a counter spy; it records destination + a flag only.
//   - The synthetic verification "code" is a fake 6-digit number; it reaches the
//     mocked Telegram payload exactly as production would, but never the metrics
//     snapshot, the result envelope, or the captured (sanitized) logs.

import {
  createInMemoryProcessedMessageStore,
  type ProcessedMessageStore,
} from '@/services/email/deduplication.service';
import type {
  AccessTokenPort,
  AuditPort,
  GraphMessageFetchPort,
  GraphMessagePipelineDeps,
  GraphMessagePipelineResult,
  GraphMessageProcessingJob,
  MailboxLookupPort,
  MailboxLookupRecord,
  TelegramMappingPort,
  TelegramSendPort,
} from '@/services/email/graph-message-pipeline.service';
import { processGraphMessageJob } from '@/services/email/graph-message-pipeline.service';
import type { GraphMailMessage } from '@/services/microsoft/graph-mail.service';
import {
  createInMemoryMailboxProcessingLock,
  type SyncMailboxProcessingLock,
} from '@/services/queue/mailbox-processing-lock';
import {
  createInMemoryDestinationThrottle,
  DEFAULT_DESTINATION_MAX_WAIT_MS,
} from '@/services/queue/destination-throttle';
import {
  createInMemoryGlobalSendThrottle,
  DEFAULT_GLOBAL_SEND_MAX_WAIT_MS,
} from '@/services/queue/global-send-throttle';
import {
  aggregateBuckets,
  buildDestinationThrottleMutations,
  buildGlobalThrottleMutations,
  buildJobResultMutations,
  buildMailboxBusyDeferMutations,
  WORKER_METRICS_DEFAULT_WINDOW_MS,
  type MetricMutation,
  type WorkerMetricsRecorder,
} from '@/services/observability/worker-metrics';
import type { WorkerMetricsSnapshot } from '@/services/observability/observability.types';
import {
  EMAIL_DELTA_POLLING_JOB_SOURCE,
  EMAIL_QUEUE_JOB_NAMES,
  EMAIL_WEBHOOK_JOB_SOURCE,
  type EmailJobData,
} from '@/services/queue/email-job.types';
import { createLogger } from '@/lib/logger';

// ---------------------------------------------------------------------------
// Synthetic dataset shape + sizing knobs. All values are FAKE.
// ---------------------------------------------------------------------------

/** ~10 synthetic customers. */
export const SYNTHETIC_CUSTOMER_COUNT = 10;
/** ~100 ready mailboxes (ACTIVE + one ACTIVE Telegram mapping). */
export const SYNTHETIC_READY_MAILBOXES = 100;
/** A few DISABLED mailboxes (should never relay — Scenario D). */
export const SYNTHETIC_DISABLED_MAILBOXES = 6;
/** A few ACTIVE-but-unmapped mailboxes (should never relay — Scenario D). */
export const SYNTHETIC_UNMAPPED_MAILBOXES = 6;
/** A small pool of reusable destinations shared by many mailboxes (Scenario C). */
export const SYNTHETIC_SHARED_DESTINATIONS = 12;

/** Synthetic access token returned by the mock token port. Never a real token. */
export const FAKE_ACCESS_TOKEN = 'synthetic-access-token-not-a-real-secret';

/** A fixed clock used for deterministic throttle accounting (epoch ms). */
export const SYNTHETIC_THROTTLE_NOW_MS = 1_700_000_000_000;
/** A fixed worker "queue enqueued" base used for deterministic latency. */
export const SYNTHETIC_WORKER_NOW_MS = 1_700_000_500_000;
/** Synthetic, fixed queue-wait and processing durations (ms) for the metrics. */
export const SYNTHETIC_QUEUE_WAIT_MS = 200;
export const SYNTHETIC_PROCESSING_MS = 50;

export type SyntheticMailboxKind = 'ready' | 'disabled' | 'unmapped';

export interface SyntheticDestination {
  chatId: string;
  groupName: string;
  threadId: string | null;
}

export interface SyntheticMailbox {
  id: string;
  emailAddress: string;
  status: 'ACTIVE' | 'DISABLED';
  customerId: string;
  customerName: string;
  kind: SyntheticMailboxKind;
  graphMessageId: string;
  internetMessageId: string;
  /** Synthetic fake 6-digit code. Not a real verification code. */
  verificationCode: string;
  destinationChatId: string | null;
  destinationGroupName: string | null;
  destinationThreadId: string | null;
}

export interface SyntheticDataset {
  customers: ReadonlyArray<{ id: string; name: string }>;
  destinations: ReadonlyArray<SyntheticDestination>;
  mailboxes: ReadonlyArray<SyntheticMailbox>;
  ready: ReadonlyArray<SyntheticMailbox>;
  disabled: ReadonlyArray<SyntheticMailbox>;
  unmapped: ReadonlyArray<SyntheticMailbox>;
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, '0');
}

/** Deterministic, distinct, fake 6-digit synthetic code. */
function syntheticCode(index: number): string {
  return String(100000 + index);
}

export interface BuildDatasetOptions {
  readyCount?: number;
  disabledCount?: number;
  unmappedCount?: number;
  sharedDestinations?: number;
  customerCount?: number;
}

/**
 * Build the full synthetic dataset deterministically: ~10 customers, ~100 ready
 * mailboxes spread across a small pool of reusable destinations (so many
 * mailboxes share a destination), plus a handful of DISABLED / unmapped
 * mailboxes for the skip-safety scenario.
 */
export function buildSyntheticDataset(
  options: BuildDatasetOptions = {},
): SyntheticDataset {
  const customerCount = options.customerCount ?? SYNTHETIC_CUSTOMER_COUNT;
  const readyCount = options.readyCount ?? SYNTHETIC_READY_MAILBOXES;
  const disabledCount = options.disabledCount ?? SYNTHETIC_DISABLED_MAILBOXES;
  const unmappedCount = options.unmappedCount ?? SYNTHETIC_UNMAPPED_MAILBOXES;
  const sharedCount = options.sharedDestinations ?? SYNTHETIC_SHARED_DESTINATIONS;

  const customers = Array.from({ length: customerCount }, (_, i) => ({
    id: `cust-${pad(i, 2)}`,
    name: `Synthetic Customer ${pad(i, 2)} (FAKE)`,
  }));

  const destinations: SyntheticDestination[] = Array.from(
    { length: sharedCount },
    (_, i) => ({
      // Synthetic Telegram supergroup-style ids — not real chats.
      chatId: `-100900000${pad(i, 4)}`,
      groupName: `Synthetic Group ${pad(i, 2)} (FAKE)`,
      // Give half the destinations a forum topic id to exercise topic routing.
      threadId: i % 2 === 0 ? null : String(1000 + i),
    }),
  );

  let codeIndex = 0;
  const mailboxes: SyntheticMailbox[] = [];

  const customerFor = (globalIndex: number): { id: string; name: string } =>
    customers[globalIndex % customers.length];

  // Ready mailboxes: ACTIVE + one ACTIVE mapping to a reusable destination.
  const ready: SyntheticMailbox[] = [];
  for (let i = 0; i < readyCount; i += 1) {
    const customer = customerFor(i);
    const destination = destinations[i % destinations.length];
    const id = `mbx-ready-${pad(i, 3)}`;
    const mailbox: SyntheticMailbox = {
      id,
      emailAddress: `relay+${pad(i, 3)}@synthetic.invalid`,
      status: 'ACTIVE',
      customerId: customer.id,
      customerName: customer.name,
      kind: 'ready',
      graphMessageId: `gm-${id}`,
      internetMessageId: `<imid-${id}@synthetic.invalid>`,
      verificationCode: syntheticCode(codeIndex++),
      destinationChatId: destination.chatId,
      destinationGroupName: destination.groupName,
      destinationThreadId: destination.threadId,
    };
    ready.push(mailbox);
    mailboxes.push(mailbox);
  }

  // DISABLED mailboxes: a mapping exists, but the mailbox is not ACTIVE so the
  // pipeline must skip BEFORE any Graph/Telegram side effect.
  const disabled: SyntheticMailbox[] = [];
  for (let i = 0; i < disabledCount; i += 1) {
    const customer = customerFor(readyCount + i);
    const destination = destinations[i % destinations.length];
    const id = `mbx-disabled-${pad(i, 3)}`;
    const mailbox: SyntheticMailbox = {
      id,
      emailAddress: `relay-disabled+${pad(i, 3)}@synthetic.invalid`,
      status: 'DISABLED',
      customerId: customer.id,
      customerName: customer.name,
      kind: 'disabled',
      graphMessageId: `gm-${id}`,
      internetMessageId: `<imid-${id}@synthetic.invalid>`,
      verificationCode: syntheticCode(codeIndex++),
      destinationChatId: destination.chatId,
      destinationGroupName: destination.groupName,
      destinationThreadId: destination.threadId,
    };
    disabled.push(mailbox);
    mailboxes.push(mailbox);
  }

  // Unmapped mailboxes: ACTIVE but no active Telegram mapping → skip before send.
  const unmapped: SyntheticMailbox[] = [];
  for (let i = 0; i < unmappedCount; i += 1) {
    const customer = customerFor(readyCount + disabledCount + i);
    const id = `mbx-unmapped-${pad(i, 3)}`;
    const mailbox: SyntheticMailbox = {
      id,
      emailAddress: `relay-unmapped+${pad(i, 3)}@synthetic.invalid`,
      status: 'ACTIVE',
      customerId: customer.id,
      customerName: customer.name,
      kind: 'unmapped',
      graphMessageId: `gm-${id}`,
      internetMessageId: `<imid-${id}@synthetic.invalid>`,
      verificationCode: syntheticCode(codeIndex++),
      destinationChatId: null,
      destinationGroupName: null,
      destinationThreadId: null,
    };
    unmapped.push(mailbox);
    mailboxes.push(mailbox);
  }

  return { customers, destinations, mailboxes, ready, disabled, unmapped };
}

/**
 * Build a synthetic Facebook/Meta verification email in the GraphMailMessage
 * shape. The sender + subject + body mirror a real verification email closely
 * enough to pass the detector and extractor, but every value is synthetic. The
 * `receivedDateTime` defaults to "now" so the detector never treats it as stale.
 */
export function buildSyntheticVerificationMessage(
  mailbox: SyntheticMailbox,
  receivedAt: Date = new Date(),
): GraphMailMessage {
  return {
    id: mailbox.graphMessageId,
    internetMessageId: mailbox.internetMessageId,
    from: { emailAddress: { name: 'Facebook', address: 'security@facebookmail.com' } },
    sender: { emailAddress: { name: 'Facebook', address: 'security@facebookmail.com' } },
    subject: 'Your Facebook security code',
    receivedDateTime: receivedAt.toISOString(),
    bodyPreview: `Your Facebook security code is ${mailbox.verificationCode}.`,
    body: {
      contentType: 'text',
      content: `Hi,\n\nYour Facebook security code is ${mailbox.verificationCode}. Use it to log in to your account.\n\nThanks,\nThe Facebook team`,
    },
    toRecipients: [
      { emailAddress: { name: 'Relay', address: mailbox.emailAddress } },
    ],
  };
}

// ---------------------------------------------------------------------------
// In-memory worker-metrics recorder built from the REAL aggregation helpers.
// ---------------------------------------------------------------------------

export interface InMemoryWorkerMetrics {
  recorder: WorkerMetricsRecorder;
  snapshot(): WorkerMetricsSnapshot;
}

/**
 * A single-process metrics sink that folds the production metric mutations into
 * one bucket hash and reads them back through the real `aggregateBuckets`. This
 * exercises the exact aggregate-only shape the cross-process Redis store would
 * produce in TASK-068C, without any Redis.
 */
export function createInMemoryWorkerMetrics(): InMemoryWorkerMetrics {
  const hash: Record<string, number> = {};

  const apply = (mutations: MetricMutation[]): void => {
    for (const mutation of mutations) {
      const current = hash[mutation.field] ?? 0;
      hash[mutation.field] =
        mutation.op === 'incr'
          ? current + mutation.value
          : Math.max(current, mutation.value);
    }
  };

  const recorder: WorkerMetricsRecorder = {
    recordJobResult: (input) => apply(buildJobResultMutations(input)),
    recordMailboxBusyDefer: () => apply(buildMailboxBusyDeferMutations()),
    recordDestinationThrottleWait: (waitMs) =>
      apply(buildDestinationThrottleMutations(waitMs)),
    recordGlobalThrottleWait: (waitMs) =>
      apply(buildGlobalThrottleMutations(waitMs)),
  };

  const snapshot = (): WorkerMetricsSnapshot => {
    const stringHash: Record<string, string> = {};
    for (const [field, value] of Object.entries(hash)) {
      stringHash[field] = String(value);
    }
    return aggregateBuckets(
      [stringHash],
      WORKER_METRICS_DEFAULT_WINDOW_MS,
      new Date(),
    );
  };

  return { recorder, snapshot };
}

// ---------------------------------------------------------------------------
// Harness: wires the real pipeline deps with mocked Graph/Telegram boundaries.
// ---------------------------------------------------------------------------

export interface CapturedSend {
  chatId: string;
  threadId: string | undefined;
  /** True only — proves a send happened; the payload text is not retained. */
  sent: true;
}

export type PipelineRunner = (
  job: GraphMessageProcessingJob,
) => Promise<GraphMessagePipelineResult>;

export interface ScaleHarnessOptions {
  busyDeferRetry?: GraphMessagePipelineDeps['busyDeferRetry'];
  destinationMaxWaitMs?: number;
  globalMaxWaitMs?: number;
  throttleNow?: () => number;
}

export interface ScaleHarness {
  deps: GraphMessagePipelineDeps;
  pipeline: PipelineRunner;
  store: ProcessedMessageStore;
  lock: SyncMailboxProcessingLock;
  sends: CapturedSend[];
  metrics: InMemoryWorkerMetrics;
  snapshot: () => WorkerMetricsSnapshot;
  logLines: string[];
  /** Register/override the Graph message returned for a graphMessageId. */
  registerMessage(graphMessageId: string, message: GraphMailMessage): void;
}

const DEFAULT_BUSY_DEFER_RETRY: GraphMessagePipelineDeps['busyDeferRetry'] = {
  maxRetries: 3,
  delayMs: 5,
  maxTotalWaitMs: 50,
};

/**
 * Build a harness over a synthetic dataset. The store, lock, throttles and
 * metrics recorder are all REAL (in-memory) so distributed-safety, throughput
 * and observability seams are genuinely exercised. Only the Microsoft Graph
 * fetch and the Telegram send are mocked, and a no-op audit port keeps the run
 * free of any database I/O.
 */
export function createScaleHarness(
  dataset: SyntheticDataset,
  options: ScaleHarnessOptions = {},
): ScaleHarness {
  const store = createInMemoryProcessedMessageStore();
  const lock = createInMemoryMailboxProcessingLock();
  const throttleNow = options.throttleNow ?? (() => SYNTHETIC_THROTTLE_NOW_MS);

  const destinationThrottle = createInMemoryDestinationThrottle({
    now: throttleNow,
    maxWaitMs: options.destinationMaxWaitMs ?? DEFAULT_DESTINATION_MAX_WAIT_MS,
  });
  const globalSendThrottle = createInMemoryGlobalSendThrottle({
    now: throttleNow,
    maxWaitMs: options.globalMaxWaitMs ?? DEFAULT_GLOBAL_SEND_MAX_WAIT_MS,
  });

  const metrics = createInMemoryWorkerMetrics();

  const logLines: string[] = [];
  const recordLine = (...args: unknown[]): void => {
    logLines.push(
      args
        .map((arg) => {
          if (typeof arg === 'string') return arg;
          try {
            return JSON.stringify(arg);
          } catch {
            return String(arg);
          }
        })
        .join(' '),
    );
  };
  const logger = createLogger({
    sink: {
      debug: recordLine,
      info: recordLine,
      warn: recordLine,
      error: recordLine,
    },
  });

  const mailboxById = new Map<string, SyntheticMailbox>();
  const messageById = new Map<string, GraphMailMessage>();
  for (const mailbox of dataset.mailboxes) {
    mailboxById.set(mailbox.id, mailbox);
    messageById.set(
      mailbox.graphMessageId,
      buildSyntheticVerificationMessage(mailbox),
    );
  }

  const mailboxes: MailboxLookupPort = {
    async findById(mailboxId): Promise<MailboxLookupRecord | null> {
      const mailbox = mailboxById.get(mailboxId);
      if (!mailbox) return null;
      return {
        id: mailbox.id,
        emailAddress: mailbox.emailAddress,
        status: mailbox.status,
        customerName: mailbox.customerName,
      };
    },
    async markReconnectRequired(): Promise<void> {
      // No-op: no real mailbox to flip in this synthetic run.
    },
  };

  const accessToken: AccessTokenPort = {
    async getAccessTokenForMailbox(): Promise<string> {
      return FAKE_ACCESS_TOKEN;
    },
  };

  const graphMail: GraphMessageFetchPort = {
    async fetchMessage(_token, graphMessageId): Promise<GraphMailMessage> {
      const message = messageById.get(graphMessageId);
      if (!message) {
        throw new Error(
          `synthetic harness: no message registered for ${graphMessageId}`,
        );
      }
      return message;
    },
  };

  const telegramMapping: TelegramMappingPort = {
    async findActiveMappingForMailboxId(mailboxId) {
      const mailbox = mailboxById.get(mailboxId);
      if (!mailbox || mailbox.destinationChatId === null) return null;
      return {
        telegramChatId: mailbox.destinationChatId,
        telegramGroupName: mailbox.destinationGroupName,
        telegramThreadId: mailbox.destinationThreadId,
      };
    },
  };

  const sends: CapturedSend[] = [];
  const telegramSender: TelegramSendPort = {
    async sendTelegramMessage(input) {
      // Counter spy only: record the destination, never the payload text/code.
      sends.push({
        chatId: input.chatId,
        threadId: input.messageThreadId,
        sent: true,
      });
      return { ok: true, chatId: input.chatId, messageId: sends.length };
    },
  };

  // No-op audit so the synthetic run never touches the audit/code-event DB path.
  const audit: AuditPort = {
    recordCodeEvent() {},
    createAuditLog() {},
  };

  const deps: GraphMessagePipelineDeps = {
    store,
    mailboxes,
    accessToken,
    graphMail,
    telegramMapping,
    telegramSender,
    audit,
    logger,
    lock,
    destinationThrottle,
    globalSendThrottle,
    busyDeferRetry: options.busyDeferRetry ?? DEFAULT_BUSY_DEFER_RETRY,
    // Instant sleep so throttle/defer delays are exercised without wall-clock cost.
    sleep: async () => undefined,
    metrics: metrics.recorder,
  };

  const pipeline: PipelineRunner = (job) => processGraphMessageJob(job, deps);

  return {
    deps,
    pipeline,
    store,
    lock,
    sends,
    metrics,
    snapshot: metrics.snapshot,
    logLines,
    registerMessage(graphMessageId, message) {
      messageById.set(graphMessageId, message);
    },
  };
}

// ---------------------------------------------------------------------------
// Minimal BullMQ-job builders + clock for driving the real worker function.
// ---------------------------------------------------------------------------

export interface MinimalJob {
  name: string;
  id: string;
  data: EmailJobData;
  timestamp: number;
  attemptsMade: number;
}

export interface MakeJobOptions {
  jobId?: string;
  /** Enqueue timestamp (epoch ms). Defaults to a fixed past so queueWait > 0. */
  timestamp?: number;
  attemptsMade?: number;
}

export function makeWebhookJob(
  mailboxId: string,
  graphMessageId: string,
  options: MakeJobOptions = {},
): MinimalJob {
  return {
    name: EMAIL_QUEUE_JOB_NAMES.PROCESS_MICROSOFT_GRAPH_MESSAGE,
    id: options.jobId ?? `job-wh-${graphMessageId}`,
    data: {
      mailboxId,
      graphMessageId,
      clientStateValidated: true,
      queuedAt: new Date(SYNTHETIC_WORKER_NOW_MS).toISOString(),
      source: EMAIL_WEBHOOK_JOB_SOURCE,
    },
    timestamp:
      options.timestamp ?? SYNTHETIC_WORKER_NOW_MS - SYNTHETIC_QUEUE_WAIT_MS,
    attemptsMade: options.attemptsMade ?? 0,
  };
}

export function makeDeltaJob(
  mailboxId: string,
  graphMessageId: string,
  options: MakeJobOptions = {},
): MinimalJob {
  return {
    name: EMAIL_QUEUE_JOB_NAMES.PROCESS_MICROSOFT_GRAPH_MESSAGE,
    id: options.jobId ?? `job-delta-${graphMessageId}`,
    data: {
      mailboxId,
      graphMessageId,
      queuedAt: new Date(SYNTHETIC_WORKER_NOW_MS).toISOString(),
      source: EMAIL_DELTA_POLLING_JOB_SOURCE,
    },
    timestamp:
      options.timestamp ?? SYNTHETIC_WORKER_NOW_MS - SYNTHETIC_QUEUE_WAIT_MS,
    attemptsMade: options.attemptsMade ?? 0,
  };
}

/**
 * A two-call clock for the worker: first call (processing start) returns the
 * fixed base; the second (processing end) returns base + processing duration.
 * This yields a deterministic processing latency in the worker metrics.
 */
export function makeJobClock(): () => number {
  let calls = 0;
  return () => {
    calls += 1;
    return calls === 1
      ? SYNTHETIC_WORKER_NOW_MS
      : SYNTHETIC_WORKER_NOW_MS + SYNTHETIC_PROCESSING_MS;
  };
}
