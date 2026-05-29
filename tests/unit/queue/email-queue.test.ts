import { describe, it, expect, vi } from 'vitest';

import { InvalidEmailWebhookJobDataError } from '@/services/queue/email-job-options';
import {
  EMAIL_QUEUE_JOB_NAMES,
  EMAIL_WEBHOOK_JOB_SOURCE,
  type EmailWebhookJobData,
} from '@/services/queue/email-job.types';
import {
  enqueueMicrosoftGraphMessageJob,
  type EmailQueueLike,
} from '@/services/queue/email-queue';

function makeData(
  overrides: Partial<EmailWebhookJobData> = {},
): EmailWebhookJobData {
  return {
    mailboxId: 'mailbox-1',
    graphMessageId: 'message-1',
    subscriptionId: 'sub-1',
    resource: 'users/abc/messages/message-1',
    changeType: 'created',
    tenantId: 'tenant-1',
    clientStateValidated: true,
    queuedAt: '2026-05-29T00:00:00.000Z',
    source: EMAIL_WEBHOOK_JOB_SOURCE,
    ...overrides,
  };
}

function createFakeQueue(): EmailQueueLike & {
  calls: Array<{ name: string; data: EmailWebhookJobData; opts?: unknown }>;
} {
  const calls: Array<{
    name: string;
    data: EmailWebhookJobData;
    opts?: unknown;
  }> = [];
  const queue: EmailQueueLike = {
    add: vi.fn(async (name, data, opts) => {
      calls.push({ name, data, opts });
      return { id: typeof opts?.jobId === 'string' ? opts.jobId : null };
    }),
  };
  return Object.assign(queue, { calls });
}

describe('enqueueMicrosoftGraphMessageJob', () => {
  it('adds a job using the PROCESS_MICROSOFT_GRAPH_MESSAGE name and stable jobId', async () => {
    const queue = createFakeQueue();
    const data = makeData();

    const result = await enqueueMicrosoftGraphMessageJob(data, { queue });

    expect(queue.calls).toHaveLength(1);
    expect(queue.calls[0].name).toBe(
      EMAIL_QUEUE_JOB_NAMES.PROCESS_MICROSOFT_GRAPH_MESSAGE,
    );
    expect(result.jobName).toBe(
      EMAIL_QUEUE_JOB_NAMES.PROCESS_MICROSOFT_GRAPH_MESSAGE,
    );
    expect(result.jobId).toBe(
      `microsoft-webhook:${data.mailboxId}:${data.graphMessageId}`,
    );
    expect(result.queueName.length).toBeGreaterThan(0);
  });

  it('forwards the validated payload unchanged to the queue', async () => {
    const queue = createFakeQueue();
    const data = makeData();

    await enqueueMicrosoftGraphMessageJob(data, { queue });

    expect(queue.calls[0].data).toEqual(data);
  });

  it('attaches retry/backoff options to the job', async () => {
    const queue = createFakeQueue();

    await enqueueMicrosoftGraphMessageJob(makeData(), { queue });

    const opts = queue.calls[0].opts as {
      attempts: number;
      backoff: { type: string; delay: number };
      removeOnComplete: { age: number; count: number };
      removeOnFail: { age: number; count: number };
    };
    expect(opts.attempts).toBe(3);
    expect(opts.backoff).toEqual({ type: 'exponential', delay: 5_000 });
    expect(opts.removeOnComplete.age).toBe(86_400);
    expect(opts.removeOnFail.age).toBe(604_800);
  });

  it('throws InvalidEmailWebhookJobDataError when mailboxId is missing', async () => {
    const queue = createFakeQueue();
    await expect(
      enqueueMicrosoftGraphMessageJob(makeData({ mailboxId: '' }), { queue }),
    ).rejects.toBeInstanceOf(InvalidEmailWebhookJobDataError);
    expect(queue.calls).toHaveLength(0);
  });

  it('throws InvalidEmailWebhookJobDataError when graphMessageId is missing', async () => {
    const queue = createFakeQueue();
    await expect(
      enqueueMicrosoftGraphMessageJob(makeData({ graphMessageId: '' }), {
        queue,
      }),
    ).rejects.toBeInstanceOf(InvalidEmailWebhookJobDataError);
    expect(queue.calls).toHaveLength(0);
  });

  it('rejects payloads that smuggle in sensitive fields', async () => {
    const queue = createFakeQueue();
    const data = {
      ...makeData(),
      accessToken: 'leaked',
    } as unknown as EmailWebhookJobData;
    await expect(
      enqueueMicrosoftGraphMessageJob(data, { queue }),
    ).rejects.toBeInstanceOf(InvalidEmailWebhookJobDataError);
    expect(queue.calls).toHaveLength(0);
  });

  it('propagates queue.add errors after validation succeeds', async () => {
    const queue: EmailQueueLike = {
      add: vi.fn(async () => {
        throw new Error('redis down');
      }),
    };
    await expect(
      enqueueMicrosoftGraphMessageJob(makeData(), { queue }),
    ).rejects.toThrow('redis down');
  });
});
