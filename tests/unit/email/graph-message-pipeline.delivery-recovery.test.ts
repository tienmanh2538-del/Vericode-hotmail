import { describe, it, expect, vi } from 'vitest';

import {
  processGraphMessageJob,
  type GraphMessagePipelineDeps,
  type GraphMessageProcessingJob,
} from '@/services/email/graph-message-pipeline.service';
import {
  createInMemoryProcessedMessageStore,
  type ProcessedMessageStore,
} from '@/services/email/deduplication.service';
import {
  DELIVERY_LEASE_MS,
  MAX_DELIVERY_ATTEMPTS,
} from '@/services/email/delivery-ownership-policy';
import {
  processEmailWebhookJob,
  EmailWorkerProcessingError,
} from '@/services/queue/workers/email-worker';
import type { GraphMailMessage } from '@/services/microsoft/graph-mail.service';
import { TelegramSendError } from '@/services/telegram/telegram-sender.service';
import type { Job } from 'bullmq';
import type { EmailJobData } from '@/services/queue/email-job.types';

// TASK-090 — post-claim delivery failure recovery & delivery state safety.
//
// All identifiers are synthetic (".test" domains, fake ids, fake numeric code).
// No real mailbox, chat id, token, or customer data appears anywhere here.

const MAILBOX_ID = 'mailbox_test_alpha';
const MAILBOX_EMAIL = 'agent.test@example.test';
const GRAPH_MESSAGE_ID = 'graph-msg-test-090-001';
const INTERNET_MESSAGE_ID = '<imid-090-001@example.test>';
const CHAT_ID = '-1009999999999';
const VERIFICATION_CODE = '824739';

const BASE_NOW_MS = Date.parse('2026-09-01T10:00:00.000Z');

function makeGraphMessage(
  overrides: Partial<GraphMailMessage> = {},
): GraphMailMessage {
  return {
    id: GRAPH_MESSAGE_ID,
    internetMessageId: INTERNET_MESSAGE_ID,
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
    receivedDateTime: new Date(BASE_NOW_MS - 60_000).toISOString(),
    bodyPreview: `Your security code is ${VERIFICATION_CODE}.`,
    body: {
      contentType: 'text',
      content: `Your security code is ${VERIFICATION_CODE}. Use it to log in to your account.`,
    },
    toRecipients: [
      { emailAddress: { name: 'Client', address: MAILBOX_EMAIL } },
    ],
  ...overrides,
  };
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

interface Harness {
  deps: GraphMessagePipelineDeps;
  store: ProcessedMessageStore;
  sendMock: ReturnType<typeof vi.fn>;
  /** Fake clock (ms). `sleep` advances it so lease waits are deterministic. */
  clock: { nowMs: number };
}

function makeHarness(
  options: {
    store?: ProcessedMessageStore;
    graphMessage?: GraphMailMessage;
    mapping?: { telegramChatId: string } | null;
    sendImpl?: (harness: () => Harness) => Promise<unknown>;
    /** Called on every ownership-wait sleep tick (after the clock advanced). */
    onSleepTick?: (harness: Harness) => Promise<void> | void;
  } = {},
): Harness {
  const store = options.store ?? createInMemoryProcessedMessageStore();
  const clock = { nowMs: BASE_NOW_MS };
  const graphMessage = options.graphMessage ?? makeGraphMessage();

  const sendMock = vi.fn<(input: unknown) => Promise<unknown>>(async () => ({
    ok: true as const,
    chatId: CHAT_ID,
  }));

  const harness: Harness = {
    store,
    clock,
    sendMock,
    deps: undefined as unknown as GraphMessagePipelineDeps,
  };

  if (options.sendImpl) {
    sendMock.mockImplementation(() => options.sendImpl!(() => harness));
  }

  harness.deps = {
    store,
    mailboxes: {
      findById: async () => ({
        id: MAILBOX_ID,
        emailAddress: MAILBOX_EMAIL,
        status: 'ACTIVE',
        customerName: 'Client Alpha',
      }),
    },
    accessToken: {
      getAccessTokenForMailbox: async () => 'fake-token-do-not-leak',
    },
    graphMail: { fetchMessage: async () => graphMessage },
    telegramMapping: {
      findActiveMappingForMailboxId: async () =>
        options.mapping === undefined
          ? { telegramChatId: CHAT_ID }
          : options.mapping,
    },
    telegramSender: {
      sendTelegramMessage: sendMock as never,
    },
    audit: { recordCodeEvent: vi.fn(), createAuditLog: vi.fn() },
    now: () => new Date(clock.nowMs),
    sleep: async (ms: number) => {
      clock.nowMs += ms;
      await options.onSleepTick?.(harness);
    },
  };

  return harness;
}

async function seedRow(
  store: ProcessedMessageStore,
  overrides: {
    deliveryOwner?: string | null;
    deliveryLeaseUntil?: Date | null;
    deliveryAttempts?: number;
    graphMessageId?: string;
    internetMessageId?: string | null;
  } = {},
) {
  return store.create({
    mailboxId: MAILBOX_ID,
    graphMessageId: overrides.graphMessageId ?? GRAPH_MESSAGE_ID,
    internetMessageId:
      overrides.internetMessageId === undefined
        ? 'imid-090-001@example.test'
        : overrides.internetMessageId,
    codeHash: null,
    receivedAt: new Date(BASE_NOW_MS - 60_000),
    receivedAtBucket: null,
    senderEmail: null,
    subjectHash: null,
    deliveryOwner: overrides.deliveryOwner ?? null,
    deliveryLeaseUntil: overrides.deliveryLeaseUntil ?? null,
    deliveryAttempts: overrides.deliveryAttempts ?? 0,
  });
}

function retryableSendError(statusCode = 502): TelegramSendError {
  return new TelegramSendError('telegram_api', 'Telegram send failed', {
    statusCode,
    retryable: true,
  });
}

function permanentSendError(statusCode = 400): TelegramSendError {
  return new TelegramSendError('telegram_api', 'Telegram send failed', {
    statusCode,
    retryable: false,
  });
}

describe('TASK-090 — normal path and terminal duplicates', () => {
  it('fresh success: identity claim takes initial ownership, send, then SENT clears the lease', async () => {
    const h = makeHarness();

    const result = await processGraphMessageJob(makeJob(), h.deps);

    expect(result.status).toBe('CODE_SENT');
    expect(h.sendMock).toHaveBeenCalledTimes(1);

    const row = await h.store.findByGraphMessageId(MAILBOX_ID, GRAPH_MESSAGE_ID);
    expect(row?.status).toBe('SENT');
    expect(row?.sentToTelegramAt).not.toBeNull();
    expect(row?.deliveryAttempts).toBe(1);
    expect(row?.deliveryLeaseUntil).toBeNull();
  });

  it('SENT row: terminal duplicate skip, Telegram is never called again', async () => {
    const h = makeHarness();
    const first = await processGraphMessageJob(makeJob(), h.deps);
    expect(first.status).toBe('CODE_SENT');

    const second = await processGraphMessageJob(makeJob(), h.deps);
    expect(second.status).toBe('SKIPPED_DUPLICATE');
    expect(second.reason).toBe('duplicate_graph_message_id');
    expect(h.sendMock).toHaveBeenCalledTimes(1);
  });

  it('FAILED row: terminal skip, never auto-resent', async () => {
    const store = createInMemoryProcessedMessageStore();
    const seeded = await seedRow(store, { deliveryOwner: 'o1', deliveryAttempts: 1 });
    await store.markFailedByOwner(seeded.id, 'o1', 'telegram_api_400');

    const h = makeHarness({ store });
    const result = await processGraphMessageJob(makeJob(), h.deps);

    expect(result.status).toBe('SKIPPED_DUPLICATE');
    expect(result.reason).toBe('duplicate_terminal_failed');
    expect(h.sendMock).not.toHaveBeenCalled();
  });
});

describe('TASK-090 — S1: retryable Telegram failure is recoverable, not terminal', () => {
  it('failed attempt releases the lease; the NEXT attempt reaches the send path again (no false SKIPPED_DUPLICATE)', async () => {
    const store = createInMemoryProcessedMessageStore();

    // Attempt 1 — internal retries exhausted (simulated by one throw from the
    // retrying sender port) ⇒ retryable classification.
    const h1 = makeHarness({ store });
    h1.sendMock.mockRejectedValueOnce(retryableSendError());
    const first = await processGraphMessageJob(makeJob(), h1.deps);
    expect(first.status).toBe('FAILED_TELEGRAM_SEND');

    const afterFail = await store.findByGraphMessageId(MAILBOX_ID, GRAPH_MESSAGE_ID);
    expect(afterFail?.status).toBe('DETECTED');
    expect(afterFail?.deliveryAttempts).toBe(1);
    // Known failure ⇒ lease released so the BullMQ re-attempt reclaims at once.
    expect(afterFail?.deliveryLeaseUntil).toBeNull();
    expect(afterFail?.deliveryOwner).toBeNull();

    // Attempt 2 (BullMQ retry) — must NOT be terminally skipped as duplicate.
    const h2 = makeHarness({ store });
    const second = await processGraphMessageJob(makeJob(), h2.deps);
    expect(second.status).toBe('CODE_SENT');
    expect(h2.sendMock).toHaveBeenCalledTimes(1);

    const row = await store.findByGraphMessageId(MAILBOX_ID, GRAPH_MESSAGE_ID);
    expect(row?.status).toBe('SENT');
    expect(row?.deliveryAttempts).toBe(2);
  });

  it('bounded budget: after MAX_DELIVERY_ATTEMPTS failed claims the row is terminally FAILED and no further send happens', async () => {
    const store = createInMemoryProcessedMessageStore();
    let totalSends = 0;

    for (let i = 0; i < MAX_DELIVERY_ATTEMPTS; i += 1) {
      const h = makeHarness({ store });
      h.sendMock.mockRejectedValueOnce(retryableSendError());
      const result = await processGraphMessageJob(makeJob(), h.deps);
      expect(result.status).toBe('FAILED_TELEGRAM_SEND');
      totalSends += h.sendMock.mock.calls.length;
    }
    expect(totalSends).toBe(MAX_DELIVERY_ATTEMPTS);

    // The next job for the same identity terminalizes the exhausted row.
    const h = makeHarness({ store });
    const result = await processGraphMessageJob(makeJob(), h.deps);
    expect(result.status).toBe('SKIPPED_DUPLICATE');
    expect(result.reason).toBe('delivery_attempts_exhausted');
    expect(h.sendMock).not.toHaveBeenCalled();

    const row = await store.findByGraphMessageId(MAILBOX_ID, GRAPH_MESSAGE_ID);
    expect(row?.status).toBe('FAILED');
    expect(row?.deliveryFailureReason).toBe('delivery_attempts_exhausted');
  });
});

describe('TASK-090 — S2: crash after claim before send is recoverable', () => {
  it('a crashed owner’s active lease is waited out (bounded), then the row is reclaimed and delivered', async () => {
    const store = createInMemoryProcessedMessageStore();
    // Simulated crash seam: the previous owner claimed (attempts=1, lease
    // active) and died before any Telegram call — exactly the durable state a
    // crash between claim and send leaves behind.
    await seedRow(store, {
      deliveryOwner: 'dead-owner',
      deliveryLeaseUntil: new Date(BASE_NOW_MS + DELIVERY_LEASE_MS),
      deliveryAttempts: 1,
    });

    const h = makeHarness({ store });
    const result = await processGraphMessageJob(makeJob(), h.deps);

    expect(result.status).toBe('CODE_SENT');
    expect(h.sendMock).toHaveBeenCalledTimes(1);
    // The fake clock had to advance past the dead owner's lease.
    expect(h.clock.nowMs).toBeGreaterThanOrEqual(BASE_NOW_MS + DELIVERY_LEASE_MS);

    const row = await store.findByGraphMessageId(MAILBOX_ID, GRAPH_MESSAGE_ID);
    expect(row?.status).toBe('SENT');
    expect(row?.deliveryAttempts).toBe(2);
  });

  it('before lease expiry the row is NOT reclaimable (store-level CAS)', async () => {
    const store = createInMemoryProcessedMessageStore();
    const seeded = await seedRow(store, {
      deliveryOwner: 'alive-owner',
      deliveryLeaseUntil: new Date(BASE_NOW_MS + DELIVERY_LEASE_MS),
      deliveryAttempts: 1,
    });

    const before = await store.claimDelivery({
      processedMessageId: seeded.id,
      ownerToken: 'challenger',
      now: new Date(BASE_NOW_MS + DELIVERY_LEASE_MS - 1),
      leaseUntil: new Date(BASE_NOW_MS + 2 * DELIVERY_LEASE_MS),
      maxAttempts: MAX_DELIVERY_ATTEMPTS,
    });
    expect(before).toBe(false);

    const after = await store.claimDelivery({
      processedMessageId: seeded.id,
      ownerToken: 'challenger',
      now: new Date(BASE_NOW_MS + DELIVERY_LEASE_MS),
      leaseUntil: new Date(BASE_NOW_MS + 2 * DELIVERY_LEASE_MS),
      maxAttempts: MAX_DELIVERY_ATTEMPTS,
    });
    expect(after).toBe(true);

    const row = await store.findById(seeded.id);
    expect(row?.deliveryOwner).toBe('challenger');
    expect(row?.deliveryAttempts).toBe(2);
  });
});

describe('TASK-090 — atomic re-claim and multi-claimant safety', () => {
  it('two concurrent CAS claims on the same unfinished row: exactly one wins', async () => {
    const store = createInMemoryProcessedMessageStore();
    const seeded = await seedRow(store, { deliveryAttempts: 1 });

    const now = new Date(BASE_NOW_MS);
    const leaseUntil = new Date(BASE_NOW_MS + DELIVERY_LEASE_MS);
    const [a, b] = await Promise.all([
      store.claimDelivery({
        processedMessageId: seeded.id,
        ownerToken: 'worker-a',
        now,
        leaseUntil,
        maxAttempts: MAX_DELIVERY_ATTEMPTS,
      }),
      store.claimDelivery({
        processedMessageId: seeded.id,
        ownerToken: 'worker-b',
        now,
        leaseUntil,
        maxAttempts: MAX_DELIVERY_ATTEMPTS,
      }),
    ]);

    expect([a, b].filter(Boolean)).toHaveLength(1);
    const row = await store.findById(seeded.id);
    expect(row?.deliveryAttempts).toBe(2);
    expect(['worker-a', 'worker-b']).toContain(row?.deliveryOwner);
  });

  it('a claimant blocked by a LIVE owner polls, sees the owner finish (SENT), and skips without calling Telegram', async () => {
    const store = createInMemoryProcessedMessageStore();
    const seeded = await seedRow(store, {
      deliveryOwner: 'live-owner',
      deliveryLeaseUntil: new Date(BASE_NOW_MS + DELIVERY_LEASE_MS),
      deliveryAttempts: 1,
    });

    let finished = false;
    const h = makeHarness({
      store,
      onSleepTick: async () => {
        if (!finished) {
          finished = true;
          // The live owner completes mid-wait (unfenced markSent stands in
          // for the owner's own fenced write here).
          await store.markSent(seeded.id, new Date(BASE_NOW_MS + 1_000));
        }
      },
    });

    const result = await processGraphMessageJob(makeJob(), h.deps);
    expect(result.status).toBe('SKIPPED_DUPLICATE');
    expect(result.reason).toBe('duplicate_graph_message_id');
    expect(h.sendMock).not.toHaveBeenCalled();
  });

  it('lost-ownership completion: a stale owner can neither mark SENT nor mark FAILED over the new owner', async () => {
    const store = createInMemoryProcessedMessageStore();
    const seeded = await seedRow(store, {
      deliveryOwner: 'old-owner',
      deliveryLeaseUntil: new Date(BASE_NOW_MS - 1), // already expired
      deliveryAttempts: 1,
    });

    // A new claimant takes over after expiry.
    const claimed = await store.claimDelivery({
      processedMessageId: seeded.id,
      ownerToken: 'new-owner',
      now: new Date(BASE_NOW_MS),
      leaseUntil: new Date(BASE_NOW_MS + DELIVERY_LEASE_MS),
      maxAttempts: MAX_DELIVERY_ATTEMPTS,
    });
    expect(claimed).toBe(true);

    expect(await store.markSent(seeded.id, new Date(), 'old-owner')).toBe(false);
    expect(
      await store.markFailedByOwner(seeded.id, 'old-owner', 'telegram_api_400'),
    ).toBe(false);

    const row = await store.findById(seeded.id);
    expect(row?.status).toBe('DETECTED');
    expect(row?.deliveryOwner).toBe('new-owner');
  });

  it('ambiguous remote success: send lands but ownership was taken over — the stale owner never overwrites the new owner (bounded-duplicate window, documented)', async () => {
    const store = createInMemoryProcessedMessageStore();
    const seeded = await seedRow(store, { deliveryAttempts: 0 });

    const h = makeHarness({
      store,
      sendImpl: async (get) => {
        const harness = get();
        // The send hangs long enough for the lease to expire and a reclaimer
        // to take over (simulates a hung request that DID reach Telegram).
        harness.clock.nowMs += DELIVERY_LEASE_MS + 1;
        await store.claimDelivery({
          processedMessageId: seeded.id,
          ownerToken: 'takeover-owner',
          now: new Date(harness.clock.nowMs),
          leaseUntil: new Date(harness.clock.nowMs + DELIVERY_LEASE_MS),
          maxAttempts: MAX_DELIVERY_ATTEMPTS,
        });
        return { ok: true, chatId: CHAT_ID };
      },
    });

    const result = await processGraphMessageJob(makeJob(), h.deps);

    // The external side effect happened, so the envelope reports CODE_SENT…
    expect(result.status).toBe('CODE_SENT');
    // …but the fenced SENT write lost, and the new owner's state is intact.
    const row = await store.findById(seeded.id);
    expect(row?.status).toBe('DETECTED');
    expect(row?.deliveryOwner).toBe('takeover-owner');
  });
});

describe('TASK-090 — stale guard ordering (TASK-080 preserved)', () => {
  it('a recoverable row whose message is already stale is terminalized without any Telegram call (historical-row safety)', async () => {
    const store = createInMemoryProcessedMessageStore();
    const seeded = await seedRow(store, { deliveryAttempts: 0 });

    const h = makeHarness({
      store,
      graphMessage: makeGraphMessage({
        receivedDateTime: new Date(BASE_NOW_MS - 31 * 60_000).toISOString(),
      }),
    });

    const result = await processGraphMessageJob(makeJob(), h.deps);
    expect(result.status).toBe('SKIPPED_STALE');
    expect(h.sendMock).not.toHaveBeenCalled();

    const row = await store.findById(seeded.id);
    expect(row?.status).toBe('FAILED');
    expect(row?.deliveryFailureReason).toBe('stale_before_delivery');
  });

  it('exactly at the 30m boundary the message is still fresh (TASK-080 boundary unchanged) and recovery delivers it', async () => {
    const store = createInMemoryProcessedMessageStore();
    await seedRow(store, { deliveryAttempts: 1 });

    const h = makeHarness({
      store,
      graphMessage: makeGraphMessage({
        receivedDateTime: new Date(BASE_NOW_MS - 30 * 60_000).toISOString(),
      }),
    });

    const result = await processGraphMessageJob(makeJob(), h.deps);
    expect(result.status).toBe('CODE_SENT');
    expect(h.sendMock).toHaveBeenCalledTimes(1);
  });

  it('freshness is re-checked AFTER the ownership wait: a message that goes stale while waiting out a dead lease is never sent', async () => {
    const store = createInMemoryProcessedMessageStore();
    // Message is 26 minutes old — fresh at the first stale check…
    const seeded = await seedRow(store, {
      deliveryOwner: 'dead-owner',
      deliveryLeaseUntil: new Date(BASE_NOW_MS + DELIVERY_LEASE_MS),
      deliveryAttempts: 1,
    });

    const h = makeHarness({
      store,
      graphMessage: makeGraphMessage({
        receivedDateTime: new Date(BASE_NOW_MS - 26 * 60_000).toISOString(),
      }),
    });

    const result = await processGraphMessageJob(makeJob(), h.deps);

    // …but the 5-minute lease wait pushed it past 30m: terminal stale, 0 sends.
    expect(result.status).toBe('SKIPPED_STALE');
    expect(h.sendMock).not.toHaveBeenCalled();

    const row = await store.findById(seeded.id);
    expect(row?.status).toBe('FAILED');
    expect(row?.deliveryFailureReason).toBe('stale_before_delivery');
  });
});

describe('TASK-090 — permanent vs retryable Telegram classification (DF-90-4)', () => {
  it('permanent failure: row FAILED with sanitized category, pipeline returns FAILED_TELEGRAM_PERMANENT, and the worker does NOT throw', async () => {
    const store = createInMemoryProcessedMessageStore();
    const h = makeHarness({ store });
    h.sendMock.mockRejectedValueOnce(permanentSendError(400));

    const result = await processGraphMessageJob(makeJob(), h.deps);
    expect(result.status).toBe('FAILED_TELEGRAM_PERMANENT');
    expect(JSON.stringify(result)).not.toContain(VERIFICATION_CODE);

    const row = await store.findByGraphMessageId(MAILBOX_ID, GRAPH_MESSAGE_ID);
    expect(row?.status).toBe('FAILED');
    expect(row?.deliveryFailureReason).toBe('telegram_api_400');

    // Worker contract: FAILED_TELEGRAM_PERMANENT resolves (no BullMQ retry).
    const workerResult = await processEmailWebhookJob(
      {
        name: 'PROCESS_MICROSOFT_GRAPH_MESSAGE',
        data: {
          mailboxId: MAILBOX_ID,
          graphMessageId: GRAPH_MESSAGE_ID,
          clientStateValidated: true,
          queuedAt: new Date(BASE_NOW_MS).toISOString(),
          source: 'microsoft-webhook',
        },
        attemptsMade: 0,
      } as unknown as Job<EmailJobData>,
      async () => result,
    );
    expect(workerResult).toBe(result);

    // A later duplicate job for the same identity stays terminally skipped.
    const h2 = makeHarness({ store });
    const again = await processGraphMessageJob(makeJob(), h2.deps);
    expect(again.status).toBe('SKIPPED_DUPLICATE');
    expect(again.reason).toBe('duplicate_terminal_failed');
    expect(h2.sendMock).not.toHaveBeenCalled();
  });

  it('retryable failure (e.g. 429/5xx verdict) keeps the throwing FAILED_TELEGRAM_SEND path so BullMQ retries', async () => {
    const store = createInMemoryProcessedMessageStore();
    const h = makeHarness({ store });
    // 429 carries retryable:true from telegram-error.ts — it must never be
    // treated as permanent just because it is an HTTP 4xx.
    h.sendMock.mockRejectedValueOnce(retryableSendError(429));

    const result = await processGraphMessageJob(makeJob(), h.deps);
    expect(result.status).toBe('FAILED_TELEGRAM_SEND');

    const row = await store.findByGraphMessageId(MAILBOX_ID, GRAPH_MESSAGE_ID);
    expect(row?.status).toBe('DETECTED'); // NOT terminal

    await expect(
      processEmailWebhookJob(
        {
          name: 'PROCESS_MICROSOFT_GRAPH_MESSAGE',
          data: {
            mailboxId: MAILBOX_ID,
            graphMessageId: GRAPH_MESSAGE_ID,
            clientStateValidated: true,
            queuedAt: new Date(BASE_NOW_MS).toISOString(),
            source: 'microsoft-webhook',
          },
          attemptsMade: 0,
        } as unknown as Job<EmailJobData>,
        async () => result,
      ),
    ).rejects.toBeInstanceOf(EmailWorkerProcessingError);
  });

  it('an UNCLASSIFIED TelegramSendError keeps the conservative retryable path (previous behaviour)', async () => {
    const store = createInMemoryProcessedMessageStore();
    const h = makeHarness({ store });
    h.sendMock.mockRejectedValueOnce(
      new TelegramSendError('telegram_api', 'Telegram send failed', {
        telegramDescription: 'chat not found',
      }),
    );

    const result = await processGraphMessageJob(makeJob(), h.deps);
    expect(result.status).toBe('FAILED_TELEGRAM_SEND');
    const row = await store.findByGraphMessageId(MAILBOX_ID, GRAPH_MESSAGE_ID);
    expect(row?.status).toBe('DETECTED');
  });
});

describe('TASK-090 — routing safety during recovery', () => {
  it('recovery with a disabled/removed mapping: no send, ownership released, no fallback destination', async () => {
    const store = createInMemoryProcessedMessageStore();
    const seeded = await seedRow(store, { deliveryAttempts: 1 });

    const h = makeHarness({ store, mapping: null });
    const result = await processGraphMessageJob(makeJob(), h.deps);

    expect(result.status).toBe('SKIPPED_NO_TELEGRAM_MAPPING');
    expect(h.sendMock).not.toHaveBeenCalled();

    const row = await store.findById(seeded.id);
    expect(row?.status).toBe('DETECTED');
    expect(row?.deliveryOwner).toBeNull();
    expect(row?.deliveryLeaseUntil).toBeNull();
    expect(row?.deliveryAttempts).toBe(2); // budget stays consumed (bounded)
  });

  it('mapping re-resolved at send time: a remapped destination is honoured on the recovery attempt', async () => {
    const store = createInMemoryProcessedMessageStore();
    await seedRow(store, { deliveryAttempts: 1 });

    const NEW_CHAT_ID = '-1008888888888';
    const h = makeHarness({ store, mapping: { telegramChatId: NEW_CHAT_ID } });
    const result = await processGraphMessageJob(makeJob(), h.deps);

    expect(result.status).toBe('CODE_SENT');
    const sentArg = h.sendMock.mock.calls[0][0] as { chatId: string };
    expect(sentArg.chatId).toBe(NEW_CHAT_ID);
  });
});
