import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  processGraphMessageJob,
  type GraphMessagePipelineDeps,
  type GraphMessageProcessingJob,
} from '@/services/email/graph-message-pipeline.service';
import { createInMemoryProcessedMessageStore } from '@/services/email/deduplication.service';
import type { GraphMailMessage } from '@/services/microsoft/graph-mail.service';
import type { DestinationThrottle } from '@/services/queue/destination-throttle';
import type { GlobalSendThrottle } from '@/services/queue/global-send-throttle';
import type { MailboxProcessingLock } from '@/services/queue/mailbox-processing-lock';
import type { WorkerMetricsRecorder } from '@/services/observability/worker-metrics';

const MAILBOX_ID = 'mailbox_test_alpha';
const MAILBOX_EMAIL = 'agent.test@example.test';
const GRAPH_MESSAGE_ID = 'graph-msg-068c-010';
const CHAT_ID = '-1009999999999';
const VERIFICATION_CODE = '824739';
const FAKE_ACCESS_TOKEN = 'fake-token-do-not-leak';

function makeGraphMessage(): GraphMailMessage {
  return {
    id: GRAPH_MESSAGE_ID,
    internetMessageId: '<imid-068c-010@example.test>',
    from: {
      emailAddress: { name: 'Facebook Security', address: 'security@facebookmail.com' },
    },
    sender: {
      emailAddress: { name: 'Facebook Security', address: 'security@facebookmail.com' },
    },
    subject: 'Your Facebook security code',
    receivedDateTime: '2026-06-04T12:00:00.000Z',
    bodyPreview: `Your security code is ${VERIFICATION_CODE}.`,
    body: {
      contentType: 'text',
      content: `Your security code is ${VERIFICATION_CODE}. Use it to log in.`,
    },
    toRecipients: [{ emailAddress: { name: 'Client', address: MAILBOX_EMAIL } }],
  };
}

interface Overrides {
  lock?: MailboxProcessingLock;
  destinationThrottle?: DestinationThrottle;
  globalSendThrottle?: GlobalSendThrottle;
  metrics?: WorkerMetricsRecorder;
}

function makeDeps(overrides: Overrides) {
  const sendMock = vi.fn(async () => ({ ok: true as const, chatId: CHAT_ID, messageId: 1 }));
  const deps: GraphMessagePipelineDeps = {
    store: createInMemoryProcessedMessageStore(),
    mailboxes: {
      findById: async () => ({
        id: MAILBOX_ID,
        emailAddress: MAILBOX_EMAIL,
        status: 'ACTIVE',
        customerName: 'Client Alpha',
      }),
    },
    accessToken: { getAccessTokenForMailbox: async () => FAKE_ACCESS_TOKEN },
    graphMail: { fetchMessage: async () => makeGraphMessage() },
    telegramMapping: {
      findActiveMappingForMailboxId: async () => ({ telegramChatId: CHAT_ID }),
    },
    telegramSender: { sendTelegramMessage: sendMock },
    now: () => new Date('2026-06-04T12:00:00.000Z'),
    lock: overrides.lock,
    destinationThrottle: overrides.destinationThrottle,
    globalSendThrottle: overrides.globalSendThrottle,
    sleep: async () => undefined,
    metrics: overrides.metrics,
  };
  return { deps, sendMock };
}

function makeJob(): GraphMessageProcessingJob {
  return { mailboxId: MAILBOX_ID, graphMessageId: GRAPH_MESSAGE_ID, source: 'webhook' };
}

function makeMetrics() {
  const calls = { defer: 0, destination: [] as number[], global: [] as number[] };
  const metrics: WorkerMetricsRecorder = {
    recordJobResult: () => {},
    recordMailboxBusyDefer: () => {
      calls.defer += 1;
    },
    recordDestinationThrottleWait: (waitMs) => {
      calls.destination.push(waitMs);
    },
    recordGlobalThrottleWait: (waitMs) => {
      calls.global.push(waitMs);
    },
  };
  return { metrics, calls };
}

describe('processGraphMessageJob — TASK-068C throttle/defer signals', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records an aggregate mailbox-busy defer signal', async () => {
    const { metrics, calls } = makeMetrics();
    const lock: MailboxProcessingLock = { acquire: async () => null };
    const { deps, sendMock } = makeDeps({ lock, metrics });

    const result = await processGraphMessageJob(makeJob(), deps);

    expect(result.status).toBe('DEFERRED_MAILBOX_BUSY');
    expect(calls.defer).toBe(1);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('records the per-destination throttle wait', async () => {
    const { metrics, calls } = makeMetrics();
    const destinationThrottle: DestinationThrottle = {
      reserve: () => ({ waitMs: 5_000 }),
    };
    const { deps, sendMock } = makeDeps({ destinationThrottle, metrics });

    const result = await processGraphMessageJob(makeJob(), deps);

    expect(result.status).toBe('CODE_SENT');
    expect(calls.destination).toEqual([5_000]);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('records the global Telegram pacing wait', async () => {
    const { metrics, calls } = makeMetrics();
    const globalSendThrottle: GlobalSendThrottle = {
      reserve: () => ({ waitMs: 40 }),
    };
    const { deps } = makeDeps({ globalSendThrottle, metrics });

    const result = await processGraphMessageJob(makeJob(), deps);

    expect(result.status).toBe('CODE_SENT');
    expect(calls.global).toEqual([40]);
  });

  it('still delivers the code when the metrics recorder throws (best-effort)', async () => {
    const throwingMetrics: WorkerMetricsRecorder = {
      recordJobResult: () => {
        throw new Error('metrics down');
      },
      recordMailboxBusyDefer: () => {
        throw new Error('metrics down');
      },
      recordDestinationThrottleWait: () => {
        throw new Error('metrics down');
      },
      recordGlobalThrottleWait: () => {
        throw new Error('metrics down');
      },
    };
    const { deps, sendMock } = makeDeps({
      destinationThrottle: { reserve: () => ({ waitMs: 5_000 }) },
      globalSendThrottle: { reserve: () => ({ waitMs: 40 }) },
      metrics: throwingMetrics,
    });

    const result = await processGraphMessageJob(makeJob(), deps);

    expect(result.status).toBe('CODE_SENT');
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
