import { describe, it, expect } from 'vitest';
import type { Job } from 'bullmq';

import {
  classifyWorkerJobResult,
  EmailWorkerProcessingError,
  processEmailWebhookJob,
  type EmailWorkerPipeline,
} from '@/services/queue/workers/email-worker';
import {
  EMAIL_QUEUE_JOB_NAMES,
  EMAIL_WEBHOOK_JOB_SOURCE,
  type EmailWebhookJobData,
} from '@/services/queue/email-job.types';
import type {
  GraphMessagePipelineResult,
  GraphMessagePipelineStatus,
} from '@/services/email/graph-message-pipeline.service';
import type {
  RecordJobResultInput,
  WorkerMetricsRecorder,
} from '@/services/observability/worker-metrics';

const T0 = 1_700_000_000_000;

function makeJobData(): EmailWebhookJobData {
  return {
    mailboxId: 'mailbox_test_alpha',
    graphMessageId: 'graph-msg-068c-001',
    subscriptionId: 'sub-test-1',
    resource: 'users/abc/messages/graph-msg-068c-001',
    changeType: 'created',
    tenantId: 'tenant-test',
    clientStateValidated: true,
    queuedAt: '2026-06-04T12:00:00.000Z',
    source: EMAIL_WEBHOOK_JOB_SOURCE,
  };
}

function makeJob(jobOverrides: Record<string, unknown> = {}): Job<EmailWebhookJobData> {
  return {
    id: 'job-068c-1',
    name: EMAIL_QUEUE_JOB_NAMES.PROCESS_MICROSOFT_GRAPH_MESSAGE,
    data: makeJobData(),
    attemptsMade: 0,
    ...jobOverrides,
  } as unknown as Job<EmailWebhookJobData>;
}

function pipelineReturning(
  status: GraphMessagePipelineStatus,
): EmailWorkerPipeline {
  const result: GraphMessagePipelineResult = {
    ok: status === 'CODE_SENT',
    status,
    mailboxId: 'mailbox_test_alpha',
    graphMessageId: 'graph-msg-068c-001',
    sentToTelegram: status === 'CODE_SENT',
  };
  return (async () => result) as unknown as EmailWorkerPipeline;
}

function makeRecorder(): {
  recorder: WorkerMetricsRecorder;
  jobResults: RecordJobResultInput[];
} {
  const jobResults: RecordJobResultInput[] = [];
  const recorder: WorkerMetricsRecorder = {
    recordJobResult: (input) => jobResults.push(input),
    recordMailboxBusyDefer: () => {},
    recordDestinationThrottleWait: () => {},
    recordGlobalThrottleWait: () => {},
  };
  return { recorder, jobResults };
}

/** Clock yielding the processing-start time, then 200ms later. */
function makeClock(): () => number {
  const values = [T0, T0 + 200];
  let index = 0;
  return () => values[Math.min(index++, values.length - 1)];
}

describe('processEmailWebhookJob — TASK-068C metrics instrumentation', () => {
  it('measures queueWait + processing and records a completed job', async () => {
    const { recorder, jobResults } = makeRecorder();
    const job = makeJob({ timestamp: T0 - 1500 });

    const result = await processEmailWebhookJob(job, pipelineReturning('CODE_SENT'), {
      metrics: recorder,
      now: makeClock(),
    });

    expect('status' in result && result.status).toBe('CODE_SENT');
    expect(jobResults).toHaveLength(1);
    expect(jobResults[0]).toEqual({
      result: 'completed',
      queueWaitMs: 1500,
      processingDurationMs: 200,
    });
  });

  it('records only safe aggregate keys (no payload/body/code/token)', async () => {
    const { recorder, jobResults } = makeRecorder();
    const job = makeJob({ timestamp: T0 - 10 });

    await processEmailWebhookJob(job, pipelineReturning('CODE_SENT'), {
      metrics: recorder,
      now: makeClock(),
    });

    expect(Object.keys(jobResults[0]).sort()).toEqual([
      'processingDurationMs',
      'queueWaitMs',
      'result',
    ]);
  });

  it('records a deferred sample and still throws for the retryable status', async () => {
    const { recorder, jobResults } = makeRecorder();
    const job = makeJob({ timestamp: T0 - 50 });

    await expect(
      processEmailWebhookJob(job, pipelineReturning('DEFERRED_MAILBOX_BUSY'), {
        metrics: recorder,
        now: makeClock(),
      }),
    ).rejects.toBeInstanceOf(EmailWorkerProcessingError);

    expect(jobResults[0].result).toBe('deferred');
  });

  it('records null queueWait when the job has no enqueue timestamp', async () => {
    const { recorder, jobResults } = makeRecorder();
    const job = makeJob(); // no timestamp

    await processEmailWebhookJob(job, pipelineReturning('SKIPPED_NO_CODE'), {
      metrics: recorder,
      now: makeClock(),
    });

    expect(jobResults[0]).toMatchObject({ result: 'skipped', queueWaitMs: null });
  });
});

describe('classifyWorkerJobResult', () => {
  it('maps pipeline statuses to coarse categories', () => {
    expect(classifyWorkerJobResult('CODE_SENT')).toBe('completed');
    expect(classifyWorkerJobResult('DEFERRED_MAILBOX_BUSY')).toBe('deferred');
    expect(classifyWorkerJobResult('FAILED_GRAPH_FETCH')).toBe('failed');
    expect(classifyWorkerJobResult('SKIPPED_NO_TELEGRAM_MAPPING')).toBe('skipped');
  });
});
