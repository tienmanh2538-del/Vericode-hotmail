// TASK-038 — End-to-end (integration) test for the Microsoft test mailbox flow.
//
// Flow under test (NO real Microsoft Graph, NO real Telegram, NO real DB, NO
// network — every external boundary is mocked):
//
//   Microsoft Graph notification (webhook)  ─┐
//                                            ├─→ {mailboxId, graphMessageId}
//   Microsoft Graph delta page (polling)    ─┘        │
//                                                     ▼
//                              graph-message-pipeline.service (real)
//                                  → fetch Graph message  (mock port)
//                                  → facebook-detector     (real)
//                                  → code-extractor        (real)
//                                  → deduplication store   (real, in-memory)
//                                  → Telegram sender        (mock spy)
//
// Both ingestion paths converge on ONE pipeline (`processGraphMessageJob`) and
// share ONE ProcessedMessage store, exactly as production does (the BullMQ
// worker forwards both webhook and delta-polling jobs into the same pipeline).
//
// The headline requirement from TASK-031 / ROADMAP:
//   webhook and delta polling can both surface the SAME graphMessageId.
//   When (mailboxId, graphMessageId) collides, the Telegram sender must be
//   invoked EXACTLY ONCE. Dedup is anchored on the ProcessedMessage unique
//   key [mailboxId, graphMessageId] (prisma/schema.prisma @@unique).
//
// SECURITY (docs/SECURITY_RULES.md):
//   - No real secret, token, mailbox, chat id, or verification code appears
//     in this file or its fixtures. Every value here is synthetic.
//   - The full verification code is only ever delivered to the (mocked)
//     Telegram payload — never to application logs, the result envelope, the
//     dedup store, or the code event log.
//   - .env / .env.local are never read.
//
// WHY dynamic imports + vi.resetModules: several services build a module-level
// logger whose sink binds `console.*` at import time. To assert the real
// pipeline never leaks a secret into application logs (Cases 4 & 5), the
// console spies must be installed BEFORE the service modules evaluate. We
// therefore reset the module registry and import the services inside
// beforeEach. This is a test-only technique; no service logic is modified.

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import fbGraphJson from '@/tests/fixtures/graph-messages/microsoft-graph-facebook-e2e.json';
import newsletterGraphJson from '@/tests/fixtures/graph-messages/microsoft-graph-newsletter-e2e.json';

import type {
  GraphMessageFetchPort,
  GraphMessagePipelineDeps,
  GraphMessageProcessingJob,
  MailboxLookupRecord,
  TelegramMappingPort,
  TelegramSendPort,
  AccessTokenPort,
  MailboxLookupPort,
} from '@/services/email/graph-message-pipeline.service';
import type { ProcessedMessageStore } from '@/services/email/deduplication.service';
import type { GraphMailMessage } from '@/services/microsoft/graph-mail.service';
import type {
  MicrosoftGraphChangeNotificationCollection,
  PrismaClientLike,
} from '@/services/microsoft/webhook-notification.service';
import type {
  DeltaPollingDeps,
  DeltaPollingMailbox,
} from '@/services/microsoft/delta-polling.service';

// ---------------------------------------------------------------------------
// Synthetic constants — NONE of these are real.
// ---------------------------------------------------------------------------

const MAILBOX_ID = 'mailbox_e2e_ms_alpha';
const MAILBOX_EMAIL = 'relay.e2e@example.test';
const CUSTOMER_NAME = 'Client Alpha (E2E)';

const SUBSCRIPTION_ID = 'sub-e2e-038-0001';
const CLIENT_STATE_PLAINTEXT = 'e2e-client-state-not-a-real-secret';

const CHAT_ID = '-1009000000038';
const TELEGRAM_GROUP = 'Client Alpha Group (E2E)';

// Codes embedded in the fixtures. The full value must only ever reach Telegram.
const FB_CODE = '739216';
const FB_MASKED_CODE = '73****';
const NEWSLETTER_NUMBER = '884512';

// A non-bootstrap delta cursor (opaque @odata.deltaLink). Its presence is what
// makes the polling run enqueue messages instead of silently bootstrapping.
const DELTA_CURSOR =
  'https://graph.microsoft.com/v1.0/me/mailFolders(%27inbox%27)/messages/delta?$deltatoken=SYNTHETIC';
const DELTA_NEXT_CURSOR =
  'https://graph.microsoft.com/v1.0/me/mailFolders(%27inbox%27)/messages/delta?$deltatoken=SYNTHETIC_NEXT';

// Synthetic access token returned by the mocked token port. Must never be
// logged by any service under test.
const FAKE_ACCESS_TOKEN = 'fake-access-token-do-not-leak';

const fbGraphMessage = fbGraphJson as unknown as GraphMailMessage;
const newsletterGraphMessage = newsletterGraphJson as unknown as GraphMailMessage;

// ---------------------------------------------------------------------------
// Service modules — imported fresh in beforeEach so their module-level loggers
// bind to the console spies installed below.
// ---------------------------------------------------------------------------

let pipelineMod: typeof import('@/services/email/graph-message-pipeline.service');
let dedupMod: typeof import('@/services/email/deduplication.service');
let webhookMod: typeof import('@/services/microsoft/webhook-notification.service');
let deltaMod: typeof import('@/services/microsoft/delta-polling.service');
let subscriptionMod: typeof import('@/services/microsoft/graph-subscription.service');

let logs: string[] = [];

function formatLogArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

beforeEach(async () => {
  logs = [];
  const record = (...args: unknown[]): void => {
    logs.push(args.map(formatLogArg).join(' '));
  };
  // Capture (and silence) every application log line emitted during the flow.
  vi.spyOn(console, 'debug').mockImplementation(record);
  vi.spyOn(console, 'info').mockImplementation(record);
  vi.spyOn(console, 'warn').mockImplementation(record);
  vi.spyOn(console, 'error').mockImplementation(record);

  // Re-evaluate the service modules so their loggers bind to the spies above.
  vi.resetModules();
  pipelineMod = await import('@/services/email/graph-message-pipeline.service');
  dedupMod = await import('@/services/email/deduplication.service');
  webhookMod = await import('@/services/microsoft/webhook-notification.service');
  deltaMod = await import('@/services/microsoft/delta-polling.service');
  subscriptionMod = await import('@/services/microsoft/graph-subscription.service');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Shared pipeline harness — ONE store + ONE Telegram sender spy across BOTH
// ingestion paths, mirroring the single production worker/pipeline.
// ---------------------------------------------------------------------------

interface PipelineHarness {
  deps: GraphMessagePipelineDeps;
  store: ProcessedMessageStore;
  sendMock: ReturnType<typeof vi.fn>;
  fetchMock: ReturnType<typeof vi.fn>;
  mappingMock: ReturnType<typeof vi.fn>;
}

function makeMailbox(
  overrides: Partial<MailboxLookupRecord> = {},
): MailboxLookupRecord {
  return {
    id: MAILBOX_ID,
    emailAddress: MAILBOX_EMAIL,
    status: 'ACTIVE',
    customerName: CUSTOMER_NAME,
    ...overrides,
  };
}

// Return the fixture message but with a fresh receivedDateTime so the detector
// never classifies it as stale, regardless of the wall clock in CI.
function freshGraphMessage(base: GraphMailMessage): GraphMailMessage {
  return { ...base, receivedDateTime: new Date().toISOString() };
}

function makePipelineHarness(
  options: {
    graphMessageById?: Record<string, GraphMailMessage>;
    mapping?: { telegramChatId: string; telegramGroupName?: string | null } | null;
  } = {},
): PipelineHarness {
  const store = dedupMod.createInMemoryProcessedMessageStore();

  const findById = vi.fn(async (): Promise<MailboxLookupRecord | null> =>
    makeMailbox(),
  );
  const markReconnectRequired = vi.fn(async () => undefined);
  const mailboxes: MailboxLookupPort = { findById, markReconnectRequired };

  const getAccessTokenForMailbox = vi.fn(async () => FAKE_ACCESS_TOKEN);
  const accessToken: AccessTokenPort = { getAccessTokenForMailbox };

  // The Graph fetch port resolves whichever fixture matches the requested id.
  // Both ingestion paths request the SAME id in the duplicate case, so they
  // both receive the same message.
  const byId = options.graphMessageById ?? {
    [fbGraphMessage.id]: freshGraphMessage(fbGraphMessage),
  };
  const fetchMock = vi.fn(
    async (_token: string, graphMessageId: string): Promise<GraphMailMessage> => {
      const message = byId[graphMessageId];
      if (!message) {
        throw new Error(`unexpected graphMessageId in test: ${graphMessageId}`);
      }
      return freshGraphMessage(message);
    },
  );
  const graphMail: GraphMessageFetchPort = { fetchMessage: fetchMock };

  const mappingMock = vi.fn(async () => {
    if (options.mapping === null) return null;
    return (
      options.mapping ?? {
        telegramChatId: CHAT_ID,
        telegramGroupName: TELEGRAM_GROUP,
      }
    );
  });
  const telegramMapping: TelegramMappingPort = {
    findActiveMappingForMailboxId: mappingMock,
  };

  const sendMock = vi.fn(async () => ({
    ok: true as const,
    chatId: CHAT_ID,
    messageId: 1,
  }));
  const telegramSender: TelegramSendPort = { sendTelegramMessage: sendMock };

  const deps: GraphMessagePipelineDeps = {
    store,
    mailboxes,
    accessToken,
    graphMail,
    telegramMapping,
    telegramSender,
  };

  return { deps, store, sendMock, fetchMock, mappingMock };
}

// ---------------------------------------------------------------------------
// Webhook path — derive {mailboxId, graphMessageId} from a REAL Graph
// notification via the real webhook-notification service.
// ---------------------------------------------------------------------------

function buildNotificationCollection(
  graphMessageId: string,
): MicrosoftGraphChangeNotificationCollection {
  return {
    value: [
      {
        subscriptionId: SUBSCRIPTION_ID,
        clientState: CLIENT_STATE_PLAINTEXT,
        changeType: 'created',
        resource: `users/${MAILBOX_ID}/messages/${graphMessageId}`,
        resourceData: { id: graphMessageId },
      },
    ],
  };
}

function makeWebhookPrisma(): PrismaClientLike {
  const clientStateHash = subscriptionMod.hashClientState(CLIENT_STATE_PLAINTEXT);
  return {
    graphSubscription: {
      findUnique: async ({ where }) =>
        where.subscriptionId === SUBSCRIPTION_ID
          ? { mailboxId: MAILBOX_ID, clientStateHash, status: 'ACTIVE' }
          : null,
    },
  };
}

// Run the full webhook ingestion: notification → validation → pipeline job.
async function runWebhookPath(
  graphMessageId: string,
  harness: PipelineHarness,
) {
  const collection = buildNotificationCollection(graphMessageId);
  const result = await webhookMod.handleMicrosoftGraphNotifications(collection, {
    prisma: makeWebhookPrisma(),
  });

  // Exactly one notification accepted, carrying the expected identifiers.
  expect(result.accepted).toHaveLength(1);
  const accepted = result.accepted[0];
  expect(accepted.mailboxId).toBe(MAILBOX_ID);
  expect(accepted.graphMessageId).toBe(graphMessageId);

  const job: GraphMessageProcessingJob = {
    mailboxId: accepted.mailboxId,
    graphMessageId: accepted.graphMessageId,
    source: 'webhook',
    subscriptionId: accepted.subscriptionId,
    receivedNotificationAt: accepted.receivedAt,
  };
  return pipelineMod.processGraphMessageJob(job, harness.deps);
}

// ---------------------------------------------------------------------------
// Delta polling path — derive {mailboxId, graphMessageId} from a REAL delta
// page via the real delta-polling service, then run the pipeline.
// ---------------------------------------------------------------------------

interface EnqueuedDeltaJob {
  mailboxId: string;
  graphMessageId: string;
  queuedAt: string;
}

function makeDeltaDeps(
  graphMessageId: string,
  collected: EnqueuedDeltaJob[],
): DeltaPollingDeps {
  const mailbox: DeltaPollingMailbox = {
    id: MAILBOX_ID,
    emailAddress: MAILBOX_EMAIL,
    // Non-null cursor → NOT a bootstrap run → messages are enqueued.
    microsoftDeltaCursor: DELTA_CURSOR,
  };

  const repo: DeltaPollingDeps['repo'] = {
    listActiveMicrosoftMailboxes: async () => [mailbox],
    saveDeltaCursor: async () => undefined,
    recordDeltaError: async () => undefined,
    markReconnectRequired: async () => undefined,
  };

  const accessToken: DeltaPollingDeps['accessToken'] = {
    getAccessTokenForMailbox: async () => FAKE_ACCESS_TOKEN,
  };

  const enqueue: DeltaPollingDeps['enqueue'] = {
    enqueueMessage: async (input) => {
      collected.push(input);
    },
  };

  // One delta page: the same id the webhook surfaced, then a deltaLink so the
  // run converges immediately. $select=id means Graph returns id-only items.
  const fetchImpl = vi.fn(async () => {
    return new Response(
      JSON.stringify({
        value: [{ id: graphMessageId }],
        '@odata.deltaLink': DELTA_NEXT_CURSOR,
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }) as unknown as typeof fetch;

  return { repo, accessToken, enqueue, fetchImpl };
}

async function runDeltaPollingPath(
  graphMessageId: string,
  harness: PipelineHarness,
) {
  const collected: EnqueuedDeltaJob[] = [];
  const runResult = await deltaMod.runDeltaPollingOnce(
    makeDeltaDeps(graphMessageId, collected),
  );

  // The polling run discovered exactly the one new message.
  expect(runResult.enqueuedMessageCount).toBe(1);
  expect(collected).toHaveLength(1);
  expect(collected[0].mailboxId).toBe(MAILBOX_ID);
  expect(collected[0].graphMessageId).toBe(graphMessageId);

  const job: GraphMessageProcessingJob = {
    mailboxId: collected[0].mailboxId,
    graphMessageId: collected[0].graphMessageId,
    // The production worker labels both sources 'webhook' to the pipeline; the
    // pipeline behaviour is identical either way. We keep that here.
    source: 'webhook',
    subscriptionId: null,
    receivedNotificationAt: collected[0].queuedAt,
  };
  return pipelineMod.processGraphMessageJob(job, harness.deps);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Microsoft test mailbox (E2E): webhook + delta polling → pipeline → Telegram', () => {
  it('Case 1 — a Microsoft test message reaches Telegram via the webhook path', async () => {
    const harness = makePipelineHarness();

    const result = await runWebhookPath(fbGraphMessage.id, harness);

    expect(result.ok).toBe(true);
    expect(result.status).toBe('CODE_SENT');
    expect(result.sentToTelegram).toBe(true);

    // Telegram sender invoked exactly once with the customer chat id.
    expect(harness.sendMock).toHaveBeenCalledTimes(1);
    const sent = harness.sendMock.mock.calls[0][0] as {
      chatId: string;
      text: string;
    };
    expect(sent.chatId).toBe(CHAT_ID);
    expect(sent.text).toContain(MAILBOX_EMAIL);
    // The full code IS delivered to Telegram on purpose (the product goal).
    expect(sent.text).toContain(FB_CODE);

    // The dedup store holds exactly one SENT row keyed by graphMessageId.
    const stored = await harness.store.findByGraphMessageId(
      MAILBOX_ID,
      fbGraphMessage.id,
    );
    expect(stored?.status).toBe('SENT');
    expect(stored?.sentToTelegramAt).not.toBeNull();

    // The result envelope never carries the plaintext code.
    expect(JSON.stringify(result)).not.toContain(FB_CODE);
  });

  it('Case 2 — a non Facebook/Meta email is rejected and never sent to Telegram', async () => {
    const harness = makePipelineHarness({
      graphMessageById: {
        [newsletterGraphMessage.id]: freshGraphMessage(newsletterGraphMessage),
      },
    });

    const result = await runWebhookPath(newsletterGraphMessage.id, harness);

    expect(result.status).toBe('SKIPPED_NOT_FACEBOOK_VERIFICATION');
    expect(result.sentToTelegram).toBe(false);

    // No mapping lookup, no Telegram send for a rejected email.
    expect(harness.mappingMock).not.toHaveBeenCalled();
    expect(harness.sendMock).not.toHaveBeenCalled();

    // The order number in the body must never be treated as a code.
    expect(JSON.stringify(result)).not.toContain(NEWSLETTER_NUMBER);
  });

  it('Case 3 — the extractor locks onto the correct code and only exposes a masked form', async () => {
    const harness = makePipelineHarness();

    const result = await runWebhookPath(fbGraphMessage.id, harness);

    expect(result.status).toBe('CODE_SENT');
    expect(result.maskedCode).toBe(FB_MASKED_CODE);
    expect(result.maskedCode?.length).toBe(FB_CODE.length);

    // Telegram got the full code; nothing else (store, result) did.
    const sent = harness.sendMock.mock.calls[0][0] as { text: string };
    expect(sent.text).toContain(FB_CODE);

    const stored = await harness.store.findByGraphMessageId(
      MAILBOX_ID,
      fbGraphMessage.id,
    );
    expect(JSON.stringify(stored)).not.toContain(FB_CODE);
    expect(JSON.stringify(result)).not.toContain(FB_CODE);
  });

  it('Case 4 — the full verification code never leaks into application logs', async () => {
    const harness = makePipelineHarness();

    await runWebhookPath(fbGraphMessage.id, harness);

    // The pipeline did emit logs, captured via the console sink.
    expect(logs.length).toBeGreaterThan(0);
    const logBlob = logs.join('\n');
    expect(logBlob).not.toContain(FB_CODE);
  });

  it('Case 5 — no access token, refresh token, client secret, or Telegram bot token leaks into logs', async () => {
    const harness = makePipelineHarness();

    // Exercise BOTH ingestion paths so token-handling on each is logged.
    await runWebhookPath(fbGraphMessage.id, harness);
    await runDeltaPollingPath(fbGraphMessage.id, harness);

    const logBlob = logs.join('\n');

    expect(logBlob).not.toContain(FAKE_ACCESS_TOKEN);
    expect(logBlob).not.toContain(CLIENT_STATE_PLAINTEXT);
    for (const forbidden of [
      'access-token',
      'refresh-token',
      'client-secret',
      'telegram-bot-token',
    ]) {
      expect(logBlob).not.toContain(forbidden);
    }
    // No Telegram bot-token-shaped material (e.g. "bot123456:AA...").
    expect(logBlob).not.toMatch(/bot\d+:[A-Za-z0-9_-]+/i);
  });

  it('Case 6 — HEADLINE: webhook + delta polling see the same graphMessageId → Telegram fires exactly once', async () => {
    const harness = makePipelineHarness();
    const sharedGraphMessageId = fbGraphMessage.id;

    // 1) Webhook surfaces graphMessageId = X and the pipeline sends it.
    const webhookResult = await runWebhookPath(sharedGraphMessageId, harness);
    expect(webhookResult.status).toBe('CODE_SENT');
    expect(webhookResult.sentToTelegram).toBe(true);

    // 2) Delta polling independently surfaces the SAME graphMessageId = X.
    const pollingResult = await runDeltaPollingPath(sharedGraphMessageId, harness);

    // The pipeline dedups on the ProcessedMessage [mailboxId, graphMessageId]
    // unique key and skips the second occurrence BEFORE any second send.
    expect(pollingResult.status).toBe('SKIPPED_DUPLICATE');
    expect(pollingResult.sentToTelegram).toBe(false);
    expect(pollingResult.reason).toBe('duplicate_graph_message_id');

    // THE assertion: Telegram sender invoked exactly once across both paths.
    expect(harness.sendMock).toHaveBeenCalledTimes(1);

    // Exactly one ProcessedMessage row exists for (mailboxId, graphMessageId).
    const stored = await harness.store.findByGraphMessageId(
      MAILBOX_ID,
      sharedGraphMessageId,
    );
    expect(stored).not.toBeNull();
    expect(stored?.status).toBe('SENT');
  });

  it('Case 6b — order-independent: delta polling first, then webhook → still exactly one Telegram send', async () => {
    const harness = makePipelineHarness();
    const sharedGraphMessageId = fbGraphMessage.id;

    const pollingResult = await runDeltaPollingPath(sharedGraphMessageId, harness);
    expect(pollingResult.status).toBe('CODE_SENT');
    expect(pollingResult.sentToTelegram).toBe(true);

    const webhookResult = await runWebhookPath(sharedGraphMessageId, harness);
    expect(webhookResult.status).toBe('SKIPPED_DUPLICATE');
    expect(webhookResult.sentToTelegram).toBe(false);

    expect(harness.sendMock).toHaveBeenCalledTimes(1);
  });

  it('Dedup requirement — ProcessedMessage enforces a unique key on [mailboxId, graphMessageId]', () => {
    // The runtime dedup above relies on a DB-level unique constraint so a
    // webhook/polling race cannot double-insert. Assert the schema still
    // declares it (the source of truth for the constraint).
    const schemaPath = path.resolve(__dirname, '../../prisma/schema.prisma');
    const schema = readFileSync(schemaPath, 'utf8');
    expect(schema).toContain('model ProcessedMessage');
    expect(schema).toMatch(/@@unique\(\[\s*mailboxId\s*,\s*graphMessageId\s*\]\)/);
  });
});
