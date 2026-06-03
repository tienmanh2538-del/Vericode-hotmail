import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  processGraphMessageJob,
  type GraphMessagePipelineDeps,
  type GraphMessageProcessingJob,
  type MailboxLookupRecord,
} from '@/services/email/graph-message-pipeline.service';
import { createInMemoryProcessedMessageStore } from '@/services/email/deduplication.service';
import type { GraphMailMessage } from '@/services/microsoft/graph-mail.service';
import {
  createInMemoryMailboxProcessingLock,
  type MailboxProcessingLock,
} from '@/services/queue/mailbox-processing-lock';
import {
  buildDestinationKey,
  createInMemoryDestinationThrottle,
  type DestinationThrottle,
} from '@/services/queue/destination-throttle';

// Everything below is synthetic — no real mailbox, token, chat id, or code.
const MAILBOX_ID = 'mailbox_test_alpha';
const MAILBOX_EMAIL = 'agent.test@example.test';
const GRAPH_MESSAGE_ID = 'graph-msg-test-055-001';
const CHAT_ID = '-1009999999999';
const VERIFICATION_CODE = '824739';
const FAKE_ACCESS_TOKEN = 'fake-token-do-not-leak';

function makeMailbox(
  overrides: Partial<MailboxLookupRecord> = {},
): MailboxLookupRecord {
  return {
    id: MAILBOX_ID,
    emailAddress: MAILBOX_EMAIL,
    status: 'ACTIVE',
    customerName: 'Client Alpha',
    ...overrides,
  };
}

function makeGraphMessage(): GraphMailMessage {
  return {
    id: GRAPH_MESSAGE_ID,
    internetMessageId: '<imid-055-001@example.test>',
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
  mailbox?: MailboxLookupRecord;
  mailboxLookupThrows?: boolean;
  sendError?: Error;
  lock?: MailboxProcessingLock;
  destinationThrottle?: DestinationThrottle;
  sleep?: (ms: number) => Promise<void>;
  fetchMessage?: () => Promise<GraphMailMessage>;
  mapping?: { telegramChatId: string; telegramThreadId?: string | null } | null;
}

function makeDeps(overrides: DepsOverrides = {}) {
  const fetchMock = vi.fn(
    overrides.fetchMessage ?? (async () => makeGraphMessage()),
  );
  const sendMock = vi.fn(async () => {
    if (overrides.sendError) throw overrides.sendError;
    return { ok: true as const, chatId: CHAT_ID, messageId: 1 };
  });
  const findByIdMock = vi.fn(async () => {
    if (overrides.mailboxLookupThrows) throw new Error('db down');
    return overrides.mailbox ?? makeMailbox();
  });

  const deps: GraphMessagePipelineDeps = {
    store: createInMemoryProcessedMessageStore(),
    mailboxes: { findById: findByIdMock },
    accessToken: { getAccessTokenForMailbox: async () => FAKE_ACCESS_TOKEN },
    graphMail: { fetchMessage: fetchMock },
    telegramMapping: {
      findActiveMappingForMailboxId: async () =>
        overrides.mapping === undefined
          ? { telegramChatId: CHAT_ID }
          : overrides.mapping,
    },
    telegramSender: { sendTelegramMessage: sendMock },
    now: () => new Date('2026-05-29T12:00:00.000Z'),
    lock: overrides.lock,
    destinationThrottle: overrides.destinationThrottle,
    sleep: overrides.sleep,
  };

  return { deps, fetchMock, sendMock, findByIdMock };
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

describe('processGraphMessageJob — TASK-055 per-mailbox lock', () => {
  beforeEach(() => vi.clearAllMocks());

  it('does not run Graph/Telegram for two jobs of the same mailbox in parallel', async () => {
    const lock = createInMemoryMailboxProcessingLock();

    // Job 1 blocks inside the Graph fetch (holding the lock) until we release it.
    let releaseFetch: () => void = () => undefined;
    const blockingFetch = () =>
      new Promise<GraphMailMessage>((resolve) => {
        releaseFetch = () => resolve(makeGraphMessage());
      });

    const a = makeDeps({ lock, fetchMessage: blockingFetch });
    const p1 = processGraphMessageJob(makeJob(), a.deps);

    // Let job 1 acquire the lock and park on the fetch.
    await Promise.resolve();
    await Promise.resolve();

    // Job 2 (same mailbox, different deps instance but SAME shared lock) must be
    // deferred without touching Graph or Telegram.
    const b = makeDeps({ lock });
    const r2 = await processGraphMessageJob(makeJob(), b.deps);

    expect(r2.status).toBe('DEFERRED_MAILBOX_BUSY');
    expect(b.fetchMock).not.toHaveBeenCalled();
    expect(b.sendMock).not.toHaveBeenCalled();

    // Now let job 1 finish; it (and only it) delivered.
    releaseFetch();
    const r1 = await p1;
    expect(r1.status).toBe('CODE_SENT');
    expect(a.fetchMock).toHaveBeenCalledTimes(1);
    expect(a.sendMock).toHaveBeenCalledTimes(1);
  });

  it('releases the lock after a successful job so the next job can proceed', async () => {
    const lock = createInMemoryMailboxProcessingLock();
    const a = makeDeps({ lock });

    const r1 = await processGraphMessageJob(makeJob(), a.deps);
    expect(r1.status).toBe('CODE_SENT');

    // Lock is free again — a fresh manual acquire succeeds.
    const handle = lock.acquire(MAILBOX_ID);
    expect(handle).not.toBeNull();
  });

  it('releases the lock even when the pipeline fails', async () => {
    const lock = createInMemoryMailboxProcessingLock();
    const a = makeDeps({ lock, mailboxLookupThrows: true });

    const r1 = await processGraphMessageJob(makeJob(), a.deps);
    expect(r1.status).toBe('FAILED_UNEXPECTED');

    // Despite the failure, the mailbox is not wedged.
    const handle = lock.acquire(MAILBOX_ID);
    expect(handle).not.toBeNull();
  });

  it('releases the lock after a Telegram send failure', async () => {
    const lock = createInMemoryMailboxProcessingLock();
    const a = makeDeps({
      lock,
      sendError: Object.assign(new Error('telegram down'), { name: 'X' }),
    });

    const r1 = await processGraphMessageJob(makeJob(), a.deps);
    expect(r1.status).toBe('FAILED_TELEGRAM_SEND');

    const handle = lock.acquire(MAILBOX_ID);
    expect(handle).not.toBeNull();
  });
});

describe('processGraphMessageJob — TASK-055 shared destination throttle', () => {
  beforeEach(() => vi.clearAllMocks());

  it('waits the reserved interval before sending to a throttled destination', async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    const throttle: DestinationThrottle = {
      reserve: () => ({ waitMs: 5_000 }),
    };

    const a = makeDeps({ destinationThrottle: throttle, sleep });
    const r = await processGraphMessageJob(makeJob(), a.deps);

    expect(r.status).toBe('CODE_SENT');
    expect(sleeps).toEqual([5_000]);
    // The send still happened (after the wait), exactly once, to the same chat.
    expect(a.sendMock).toHaveBeenCalledTimes(1);
    expect(a.sendMock).toHaveBeenCalledWith(
      expect.objectContaining({ chatId: CHAT_ID }),
    );
  });

  it('does not delay when the destination has spare capacity', async () => {
    const sleeps: number[] = [];
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    const throttle = createInMemoryDestinationThrottle({
      minIntervalMs: 1_000,
      now: () => 1_000,
    });

    const a = makeDeps({ destinationThrottle: throttle, sleep });
    const r = await processGraphMessageJob(makeJob(), a.deps);

    expect(r.status).toBe('CODE_SENT');
    // First send to the destination → no wait.
    expect(sleeps).toEqual([]);
  });

  it('keys the throttle by the resolved chat + topic (no broadcast, one destination)', async () => {
    const throttle = createInMemoryDestinationThrottle({
      minIntervalMs: 1_000,
      now: () => 0,
    });
    const reserveSpy = vi.spyOn(throttle, 'reserve');

    const a = makeDeps({
      destinationThrottle: throttle,
      sleep: async () => undefined,
      mapping: { telegramChatId: CHAT_ID, telegramThreadId: '7' },
    });
    await processGraphMessageJob(makeJob(), a.deps);

    expect(reserveSpy).toHaveBeenCalledWith(buildDestinationKey(CHAT_ID, '7'));
  });
});
