import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  processGraphMessageJob,
  type GraphMessagePipelineDeps,
  type GraphMessageProcessingJob,
} from '@/services/email/graph-message-pipeline.service';
import { createInMemoryProcessedMessageStore } from '@/services/email/deduplication.service';
import {
  createInMemoryMailboxProcessingLock,
  type MailboxLockHandle,
  type MailboxProcessingLock,
} from '@/services/queue/mailbox-processing-lock';
import type { GlobalSendThrottle } from '@/services/queue/global-send-throttle';
import type { DestinationThrottle } from '@/services/queue/destination-throttle';
import type { GraphMailMessage } from '@/services/microsoft/graph-mail.service';

// Everything below is synthetic — no real mailbox, token, chat id, or code.
const MAILBOX_ID = 'mailbox_test_alpha';
const MAILBOX_EMAIL = 'agent.test@example.test';
const GRAPH_MESSAGE_ID = 'graph-msg-test-068b-001';
const CHAT_ID = '-1009999999999';
const VERIFICATION_CODE = '824739';
const FAKE_ACCESS_TOKEN = 'fake-token-do-not-leak';

function makeGraphMessage(): GraphMailMessage {
  return {
    id: GRAPH_MESSAGE_ID,
    internetMessageId: '<imid-068b-001@example.test>',
    from: {
      emailAddress: {
        name: 'Facebook Security',
        address: 'security@facebookmail.com',
      },
    },
    sender: {
      emailAddress: {
        name: 'Facebook Security',
        address: 'security@facebookmail.com',
      },
    },
    subject: 'Your Facebook security code',
    receivedDateTime: '2026-05-29T12:00:00.000Z',
    bodyPreview: `Your security code is ${VERIFICATION_CODE}.`,
    body: {
      contentType: 'text',
      content: `Your security code is ${VERIFICATION_CODE}. Use it to log in to your account.`,
    },
    toRecipients: [{ emailAddress: { name: 'Client', address: MAILBOX_EMAIL } }],
  };
}

interface DepsOverrides {
  store?: GraphMessagePipelineDeps['store'];
  lock?: MailboxProcessingLock;
  destinationThrottle?: DestinationThrottle;
  globalSendThrottle?: GlobalSendThrottle;
  busyDeferRetry?: GraphMessagePipelineDeps['busyDeferRetry'];
  sleep?: (ms: number) => Promise<void>;
  sendMock?: ReturnType<typeof vi.fn>;
}

function makeDeps(overrides: DepsOverrides = {}) {
  const sendMock =
    overrides.sendMock ??
    vi.fn(async () => ({ ok: true as const, chatId: CHAT_ID, messageId: 1 }));

  const deps: GraphMessagePipelineDeps = {
    store: overrides.store ?? createInMemoryProcessedMessageStore(),
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
    now: () => new Date('2026-05-29T12:00:00.000Z'),
    lock: overrides.lock,
    destinationThrottle: overrides.destinationThrottle,
    globalSendThrottle: overrides.globalSendThrottle,
    busyDeferRetry: overrides.busyDeferRetry,
    sleep: overrides.sleep,
  };

  return { deps, sendMock };
}

function makeJob(
  overrides: Partial<GraphMessageProcessingJob> = {},
): GraphMessageProcessingJob {
  return {
    mailboxId: MAILBOX_ID,
    graphMessageId: GRAPH_MESSAGE_ID,
    source: 'webhook',
    ...overrides,
  };
}

/**
 * A lock that reports "busy" (null) for the first `busyForCalls` acquire calls,
 * then hands out a real handle. `Infinity` ⇒ permanently busy.
 */
function makeCountingLock(busyForCalls: number): {
  lock: MailboxProcessingLock;
  acquireCalls: () => number;
} {
  let calls = 0;
  const lock: MailboxProcessingLock = {
    acquire(): MailboxLockHandle | null {
      calls += 1;
      if (calls <= busyForCalls) return null;
      return { release: () => undefined };
    },
  };
  return { lock, acquireCalls: () => calls };
}

describe('processGraphMessageJob — TASK-068B busy-defer bounded fairness', () => {
  beforeEach(() => vi.clearAllMocks());

  it('retries acquiring a briefly-busy lock and then delivers (no needless defer)', async () => {
    const sleeps: number[] = [];
    const { lock, acquireCalls } = makeCountingLock(1); // busy once, then free
    const { deps, sendMock } = makeDeps({
      lock,
      busyDeferRetry: { maxRetries: 3, delayMs: 250, maxTotalWaitMs: 1_000 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await processGraphMessageJob(makeJob(), deps);

    expect(result.status).toBe('CODE_SENT');
    expect(acquireCalls()).toBe(2); // first busy, second succeeds
    expect(sleeps).toEqual([250]); // exactly one bounded wait
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('defers after a BOUNDED number of retries when the lock stays busy (never infinite)', async () => {
    const sleeps: number[] = [];
    const { lock, acquireCalls } = makeCountingLock(Infinity); // always busy
    const { deps, sendMock } = makeDeps({
      lock,
      busyDeferRetry: { maxRetries: 2, delayMs: 250, maxTotalWaitMs: 1_000 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await processGraphMessageJob(makeJob(), deps);

    expect(result.status).toBe('DEFERRED_MAILBOX_BUSY');
    // 1 initial attempt + exactly maxRetries(2) re-tries = 3 acquire calls.
    expect(acquireCalls()).toBe(3);
    expect(sleeps).toEqual([250, 250]);
    // Total wait stays within the cap — proves the slot is never held unboundedly.
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(1_000);
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('honours maxTotalWaitMs as a hard cap even when maxRetries is large', async () => {
    const sleeps: number[] = [];
    const { lock, acquireCalls } = makeCountingLock(Infinity);
    const { deps } = makeDeps({
      lock,
      busyDeferRetry: { maxRetries: 100, delayMs: 250, maxTotalWaitMs: 1_000 },
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await processGraphMessageJob(makeJob(), deps);

    expect(result.status).toBe('DEFERRED_MAILBOX_BUSY');
    // 1000ms / 250ms = 4 waits, then the budget is exhausted → stop.
    expect(sleeps).toEqual([250, 250, 250, 250]);
    expect(acquireCalls()).toBe(5); // 1 initial + 4 bounded retries
  });

  it('defers immediately (no retry) when busyDeferRetry is not configured', async () => {
    const sleeps: number[] = [];
    const { lock, acquireCalls } = makeCountingLock(Infinity);
    const { deps } = makeDeps({
      lock,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await processGraphMessageJob(makeJob(), deps);

    expect(result.status).toBe('DEFERRED_MAILBOX_BUSY');
    expect(acquireCalls()).toBe(1); // single attempt — unchanged TASK-055 behaviour
    expect(sleeps).toEqual([]);
  });
});

describe('processGraphMessageJob — TASK-068B global bot pacing', () => {
  beforeEach(() => vi.clearAllMocks());

  it('waits the global-pacer interval before sending, then sends once', async () => {
    const sleeps: number[] = [];
    const globalSendThrottle: GlobalSendThrottle = {
      reserve: () => ({ waitMs: 40 }),
    };
    const { deps, sendMock } = makeDeps({
      globalSendThrottle,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await processGraphMessageJob(makeJob(), deps);

    expect(result.status).toBe('CODE_SENT');
    expect(sleeps).toEqual([40]);
    expect(sendMock).toHaveBeenCalledTimes(1);
    // Routing unchanged — still the single mapped chat id, no broadcast.
    expect(sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: CHAT_ID }),
    );
  });

  it('applies destination spacing AND global pacing (both bounded waits)', async () => {
    const sleeps: number[] = [];
    const destinationThrottle: DestinationThrottle = {
      reserve: () => ({ waitMs: 1_000 }),
    };
    const globalSendThrottle: GlobalSendThrottle = {
      reserve: () => ({ waitMs: 40 }),
    };
    const { deps, sendMock } = makeDeps({
      destinationThrottle,
      globalSendThrottle,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await processGraphMessageJob(makeJob(), deps);

    expect(result.status).toBe('CODE_SENT');
    expect(sleeps).toEqual([1_000, 40]); // destination first, then global
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  it('does not pace when the global throttle reports spare capacity', async () => {
    const sleeps: number[] = [];
    const globalSendThrottle: GlobalSendThrottle = {
      reserve: () => ({ waitMs: 0 }),
    };
    const { deps } = makeDeps({
      globalSendThrottle,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    const result = await processGraphMessageJob(makeJob(), deps);
    expect(result.status).toBe('CODE_SENT');
    expect(sleeps).toEqual([]);
  });
});

describe('processGraphMessageJob — TASK-068B keeps exactly-once intact', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not re-deliver a duplicate even with throughput guards enabled', async () => {
    // One shared store + lock + send across both jobs — the throughput guards
    // (busy-defer + global pacing) must not weaken TASK-068A exactly-once.
    const store = createInMemoryProcessedMessageStore();
    const lock = createInMemoryMailboxProcessingLock();
    const sendMock = vi.fn(async () => ({
      ok: true as const,
      chatId: CHAT_ID,
      messageId: 1,
    }));
    const globalSendThrottle: GlobalSendThrottle = {
      reserve: () => ({ waitMs: 0 }),
    };
    const busyDeferRetry = { maxRetries: 3, delayMs: 1, maxTotalWaitMs: 10 };
    const sleep = async () => undefined;

    const first = await processGraphMessageJob(
      makeJob(),
      makeDeps({ store, lock, globalSendThrottle, busyDeferRetry, sleep, sendMock })
        .deps,
    );
    const second = await processGraphMessageJob(
      makeJob(),
      makeDeps({ store, lock, globalSendThrottle, busyDeferRetry, sleep, sendMock })
        .deps,
    );

    expect(first.status).toBe('CODE_SENT');
    expect(second.status).toBe('SKIPPED_DUPLICATE');
    // The verification code is delivered exactly once.
    expect(sendMock).toHaveBeenCalledTimes(1);
  });
});
