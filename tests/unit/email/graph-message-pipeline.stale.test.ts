import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  processGraphMessageJob,
  type GraphMessagePipelineDeps,
  type GraphMessageProcessingJob,
  type MailboxLookupRecord,
} from '@/services/email/graph-message-pipeline.service';
import {
  classifyWorkerJobResult,
  processEmailWebhookJob,
} from '@/services/queue/workers/email-worker';
import { createInMemoryProcessedMessageStore } from '@/services/email/deduplication.service';
import type { GraphMailMessage } from '@/services/microsoft/graph-mail.service';
import type { EmailJobData } from '@/services/queue/email-job.types';

// TASK-080 — stale verification message relay protection. Freshness is measured
// against the Graph source `receivedDateTime`, max relay age = 30 minutes. All
// identifiers below are synthetic.

const MAILBOX_ID = 'mailbox_stale_alpha';
const MAILBOX_EMAIL = 'agent.stale@example.test';
const GRAPH_MESSAGE_ID = 'graph-msg-080-stale-001';
const CHAT_ID = '-1008888888888';
const VERIFICATION_CODE = '824739';
const NOW = new Date('2026-05-29T12:00:00.000Z');

function minutesAgoIso(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60_000).toISOString();
}

function makeMailbox(): MailboxLookupRecord {
  return {
    id: MAILBOX_ID,
    emailAddress: MAILBOX_EMAIL,
    status: 'ACTIVE',
    customerName: 'Client Stale',
  };
}

function makeGraphMessage(
  overrides: Partial<GraphMailMessage> = {},
): GraphMailMessage {
  return {
    id: GRAPH_MESSAGE_ID,
    internetMessageId: '<imid-080-stale-001@example.test>',
    from: {
      emailAddress: { name: 'Facebook Security', address: 'security@facebookmail.com' },
    },
    sender: {
      emailAddress: { name: 'Facebook Security', address: 'security@facebookmail.com' },
    },
    subject: 'Your Facebook security code',
    receivedDateTime: minutesAgoIso(10),
    bodyPreview: `Your security code is ${VERIFICATION_CODE}.`,
    body: {
      contentType: 'text',
      content: `Your Facebook security code is ${VERIFICATION_CODE}. Use it to log in.`,
    },
    ...overrides,
  };
}

interface Harness {
  deps: GraphMessagePipelineDeps;
  sendMock: ReturnType<typeof vi.fn>;
  codeEventMock: ReturnType<typeof vi.fn>;
  store: ReturnType<typeof createInMemoryProcessedMessageStore>;
}

function makeHarness(message: GraphMailMessage): Harness {
  const sendMock = vi.fn(async () => ({ ok: true as const, chatId: CHAT_ID, messageId: 1 }));
  const codeEventMock = vi.fn();
  const store = createInMemoryProcessedMessageStore();
  const deps: GraphMessagePipelineDeps = {
    store,
    mailboxes: {
      findById: async () => makeMailbox(),
      markReconnectRequired: async () => undefined,
    },
    accessToken: { getAccessTokenForMailbox: async () => 'fake-token-do-not-leak' },
    graphMail: { fetchMessage: async () => message },
    telegramMapping: {
      findActiveMappingForMailboxId: async () => ({
        telegramChatId: CHAT_ID,
        telegramGroupName: 'Client Stale Group',
        telegramThreadId: null,
      }),
    },
    telegramSender: { sendTelegramMessage: sendMock },
    audit: { recordCodeEvent: codeEventMock, createAuditLog: vi.fn() },
    now: () => NOW,
  };
  return { deps, sendMock, codeEventMock, store };
}

function makeJob(overrides: Partial<GraphMessageProcessingJob> = {}): GraphMessageProcessingJob {
  return {
    mailboxId: MAILBOX_ID,
    graphMessageId: GRAPH_MESSAGE_ID,
    source: 'webhook',
    receivedNotificationAt: NOW.toISOString(),
    ...overrides,
  };
}

describe('graph message pipeline — stale relay protection (TASK-080)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('relays a fresh message (10 min old) — Telegram IS called', async () => {
    const h = makeHarness(makeGraphMessage({ receivedDateTime: minutesAgoIso(10) }));
    const result = await processGraphMessageJob(makeJob(), h.deps);

    expect(result.status).toBe('CODE_SENT');
    expect(h.sendMock).toHaveBeenCalledTimes(1);
  });

  it('treats a message exactly at the 30-minute boundary as fresh', async () => {
    const h = makeHarness(makeGraphMessage({ receivedDateTime: minutesAgoIso(30) }));
    const result = await processGraphMessageJob(makeJob(), h.deps);

    expect(result.status).toBe('CODE_SENT');
    expect(h.sendMock).toHaveBeenCalledTimes(1);
  });

  it('skips a stale message (31 min old) — Telegram is NOT called', async () => {
    const h = makeHarness(makeGraphMessage({ receivedDateTime: minutesAgoIso(31) }));
    const result = await processGraphMessageJob(makeJob(), h.deps);

    expect(result.status).toBe('SKIPPED_STALE');
    expect(result.ok).toBe(false);
    expect(result.sentToTelegram).toBe(false);
    expect(h.sendMock).not.toHaveBeenCalled();

    const codeEvents = h.codeEventMock.mock.calls.map(([i]) => i);
    expect(codeEvents.some((e) => e.status === 'CODE_SKIPPED_STALE')).toBe(true);
    // No masked code is recorded (we skip before extraction) and no full code leaks.
    const staleEvent = codeEvents.find((e) => e.status === 'CODE_SKIPPED_STALE');
    expect(staleEvent.maskedCode).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain(VERIFICATION_CODE);
  });

  it('uses the source timestamp, not enqueue time: old email freshly enqueued is stale', async () => {
    // receivedDateTime is 2 days old; the job was "just enqueued" (now).
    const h = makeHarness(makeGraphMessage({ receivedDateTime: minutesAgoIso(2 * 24 * 60) }));
    const result = await processGraphMessageJob(
      makeJob({ receivedNotificationAt: NOW.toISOString() }),
      h.deps,
    );

    expect(result.status).toBe('SKIPPED_STALE');
    expect(h.sendMock).not.toHaveBeenCalled();
  });

  it('fail-safe: missing receivedDateTime does NOT fall back to enqueue time and is processed', async () => {
    const h = makeHarness(makeGraphMessage({ receivedDateTime: null }));
    const result = await processGraphMessageJob(makeJob(), h.deps);

    // Anomaly (no source timestamp) → we proceed with normal processing rather
    // than drop a possibly-valid code, and we never substitute enqueue time.
    expect(result.status).toBe('CODE_SENT');
    expect(h.sendMock).toHaveBeenCalledTimes(1);
  });

  it('preserves duplicate precedence: a TERMINAL duplicate is reported as duplicate, not stale', async () => {
    const h = makeHarness(makeGraphMessage({ receivedDateTime: minutesAgoIso(5) }));
    // Seed a row that already reached a TERMINAL outcome (SENT) so the early
    // dedup (which runs BEFORE the stale guard) fires. TASK-090 made the early
    // dedup status-aware: only terminal rows (SENT/FAILED) short-circuit as
    // duplicates — an unfinished DETECTED row now flows to delivery recovery
    // instead (covered by the TASK-090 delivery-recovery test file).
    const seeded = await h.store.create({
      mailboxId: MAILBOX_ID,
      graphMessageId: GRAPH_MESSAGE_ID,
      internetMessageId: null,
      codeHash: null,
      receivedAt: NOW,
      receivedAtBucket: null,
      senderEmail: null,
      subjectHash: null,
    });
    await h.store.markSent(seeded.id, NOW);

    const result = await processGraphMessageJob(makeJob(), h.deps);
    expect(result.status).toBe('SKIPPED_DUPLICATE');
    expect(h.sendMock).not.toHaveBeenCalled();
  });

  it('stale is a terminal skip: the worker completes the job without retrying', async () => {
    // classifyWorkerJobResult maps SKIPPED_STALE to a non-retryable "skipped".
    expect(classifyWorkerJobResult('SKIPPED_STALE')).toBe('skipped');

    // processEmailWebhookJob must RESOLVE (not throw) for a stale result, so
    // BullMQ treats it as complete rather than re-attempting.
    const staleResult = {
      ok: false as const,
      status: 'SKIPPED_STALE' as const,
      mailboxId: MAILBOX_ID,
      graphMessageId: GRAPH_MESSAGE_ID,
      sentToTelegram: false,
    };
    const fakeJob = {
      name: 'PROCESS_MICROSOFT_GRAPH_MESSAGE',
      id: 'job-1',
      attemptsMade: 0,
      data: {
        mailboxId: MAILBOX_ID,
        graphMessageId: GRAPH_MESSAGE_ID,
        queuedAt: NOW.toISOString(),
        source: 'delta-polling',
      } as EmailJobData,
    } as unknown as Parameters<typeof processEmailWebhookJob>[0];

    await expect(
      processEmailWebhookJob(fakeJob, async () => staleResult),
    ).resolves.toMatchObject({ status: 'SKIPPED_STALE' });
  });
});
