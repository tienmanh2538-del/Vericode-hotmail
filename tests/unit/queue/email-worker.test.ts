import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Job } from 'bullmq';

import {
  EmailWorkerProcessingError,
  processEmailWebhookJob,
  type EmailWorkerPipeline,
} from '@/services/queue/workers/email-worker';
import {
  EMAIL_QUEUE_JOB_NAMES,
  EMAIL_WEBHOOK_JOB_SOURCE,
  type EmailWebhookJobData,
} from '@/services/queue/email-job.types';
import type { GraphMessagePipelineResult } from '@/services/email/graph-message-pipeline.service';

function makeJobData(
  overrides: Partial<EmailWebhookJobData> = {},
): EmailWebhookJobData {
  return {
    mailboxId: 'mailbox_test_alpha',
    graphMessageId: 'graph-msg-test-027-001',
    subscriptionId: 'sub-test-1',
    resource: 'users/abc/messages/graph-msg-test-027-001',
    changeType: 'created',
    tenantId: 'tenant-test',
    clientStateValidated: true,
    queuedAt: '2026-05-29T12:00:00.000Z',
    source: EMAIL_WEBHOOK_JOB_SOURCE,
    ...overrides,
  };
}

function makeJob(
  data: EmailWebhookJobData = makeJobData(),
  name: string = EMAIL_QUEUE_JOB_NAMES.PROCESS_MICROSOFT_GRAPH_MESSAGE,
): Job<EmailWebhookJobData> {
  return {
    id: `microsoft-webhook:${data.mailboxId}:${data.graphMessageId}`,
    name,
    data,
    attemptsMade: 0,
  } as unknown as Job<EmailWebhookJobData>;
}

type PipelineHandle = {
  fn: EmailWorkerPipeline;
  spy: ReturnType<typeof vi.fn>;
};

function pipelineReturning(
  result: GraphMessagePipelineResult,
): PipelineHandle {
  const spy = vi.fn(async () => result);
  return { fn: spy as unknown as EmailWorkerPipeline, spy };
}

describe('processEmailWebhookJob — worker → pipeline wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('delegates to the pipeline with mailboxId/graphMessageId only (no body or tokens)', async () => {
    const pipeline = pipelineReturning({
      ok: true,
      status: 'CODE_SENT',
      mailboxId: 'mailbox_test_alpha',
      graphMessageId: 'graph-msg-test-027-001',
      maskedCode: '82****',
      sentToTelegram: true,
    });

    const result = await processEmailWebhookJob(makeJob(), pipeline.fn);

    expect(pipeline.spy).toHaveBeenCalledTimes(1);
    const arg = pipeline.spy.mock.calls[0][0];
    expect(arg).toEqual({
      mailboxId: 'mailbox_test_alpha',
      graphMessageId: 'graph-msg-test-027-001',
      source: 'webhook',
      subscriptionId: 'sub-test-1',
      receivedNotificationAt: '2026-05-29T12:00:00.000Z',
    });
    expect((result as GraphMessagePipelineResult).status).toBe('CODE_SENT');
  });

  it('returns the pipeline envelope unchanged for terminal skip statuses', async () => {
    const pipeline = pipelineReturning({
      ok: false,
      status: 'SKIPPED_NO_TELEGRAM_MAPPING',
      mailboxId: 'mailbox_test_alpha',
      graphMessageId: 'graph-msg-test-027-001',
      maskedCode: '82****',
      sentToTelegram: false,
      reason: 'no_active_mapping',
    });

    const result = await processEmailWebhookJob(makeJob(), pipeline.fn);
    expect((result as GraphMessagePipelineResult).status).toBe(
      'SKIPPED_NO_TELEGRAM_MAPPING',
    );
  });

  it.each([
    'FAILED_GRAPH_FETCH',
    'FAILED_RECONNECT_REQUIRED',
    'FAILED_TELEGRAM_SEND',
    'FAILED_UNEXPECTED',
    // TASK-055 — a deferred (mailbox-busy) job must be retried, not dropped.
    'DEFERRED_MAILBOX_BUSY',
  ] as const)(
    'throws EmailWorkerProcessingError so BullMQ can retry when pipeline returns %s',
    async (status) => {
      const pipeline = pipelineReturning({
        ok: false,
        status,
        mailboxId: 'mailbox_test_alpha',
        graphMessageId: 'graph-msg-test-027-001',
        sentToTelegram: false,
      });
      await expect(
        processEmailWebhookJob(makeJob(), pipeline.fn),
      ).rejects.toBeInstanceOf(EmailWorkerProcessingError);
    },
  );

  it('acknowledges unknown job names without calling the pipeline', async () => {
    const pipeline = pipelineReturning({
      ok: true,
      status: 'CODE_SENT',
      mailboxId: 'mailbox_test_alpha',
      graphMessageId: 'graph-msg-test-027-001',
      sentToTelegram: true,
    });

    const result = await processEmailWebhookJob(
      makeJob(makeJobData(), 'something-else'),
      pipeline.fn,
    );

    expect(result).toEqual({ acknowledged: true });
    expect(pipeline.spy).not.toHaveBeenCalled();
  });
});
