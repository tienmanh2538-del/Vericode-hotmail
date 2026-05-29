import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  processGraphMessageJob,
  type GraphMessageFetchPort,
  type GraphMessagePipelineDeps,
  type GraphMessageProcessingJob,
  type MailboxLookupPort,
  type MailboxLookupRecord,
  type TelegramMappingPort,
  type TelegramSendPort,
  type AccessTokenPort,
  type AuditPort,
} from '@/services/email/graph-message-pipeline.service';
import { createInMemoryProcessedMessageStore } from '@/services/email/deduplication.service';
import {
  GraphMailError,
  type GraphMailMessage,
} from '@/services/microsoft/graph-mail.service';
import { TelegramSendError } from '@/services/telegram/telegram-sender.service';

// All identifiers below are synthetic. No real customer email, refresh token,
// Telegram chat id, or bot token appears anywhere in this file.

const MAILBOX_ID = 'mailbox_test_alpha';
const MAILBOX_EMAIL = 'agent.test@example.test';
const GRAPH_MESSAGE_ID = 'graph-msg-test-027-001';
const INTERNET_MESSAGE_ID = '<imid-027-001@example.test>';
const CHAT_ID = '-1009999999999';
const TELEGRAM_GROUP = 'Client Alpha Group';
const CUSTOMER_NAME = 'Client Alpha';
const VERIFICATION_CODE = '824739';
const FAKE_ACCESS_TOKEN = 'fake-token-do-not-leak';

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
    receivedDateTime: new Date().toISOString(),
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

interface PipelineHarness {
  deps: GraphMessagePipelineDeps;
  mailboxes: MailboxLookupPort & {
    findByIdMock: ReturnType<typeof vi.fn>;
    markReconnectRequiredMock: ReturnType<typeof vi.fn>;
  };
  accessToken: AccessTokenPort & {
    getMock: ReturnType<typeof vi.fn>;
  };
  graphMail: GraphMessageFetchPort & {
    fetchMock: ReturnType<typeof vi.fn>;
  };
  telegramMapping: TelegramMappingPort & {
    lookupMock: ReturnType<typeof vi.fn>;
  };
  telegramSender: TelegramSendPort & {
    sendMock: ReturnType<typeof vi.fn>;
  };
  audit: AuditPort & {
    codeEventMock: ReturnType<typeof vi.fn>;
    auditMock: ReturnType<typeof vi.fn>;
  };
}

function makeHarness(
  options: {
    mailbox?: MailboxLookupRecord | null;
    mailboxLookupThrows?: boolean;
    accessTokenThrows?: boolean;
    graphMessage?: GraphMailMessage;
    graphError?: Error;
    mapping?:
      | { telegramChatId: string; telegramGroupName?: string | null }
      | null;
    sendError?: Error;
  } = {},
): PipelineHarness {
  const findByIdMock = vi.fn(async () => {
    if (options.mailboxLookupThrows) throw new Error('db down');
    if (options.mailbox === null) return null;
    return options.mailbox ?? makeMailbox();
  });
  const markReconnectRequiredMock = vi.fn(async () => undefined);

  const mailboxes = {
    findById: findByIdMock,
    markReconnectRequired: markReconnectRequiredMock,
    findByIdMock,
    markReconnectRequiredMock,
  } as PipelineHarness['mailboxes'];

  const getMock = vi.fn(async () => {
    if (options.accessTokenThrows) throw new Error('refresh failed');
    return FAKE_ACCESS_TOKEN;
  });
  const accessToken = {
    getAccessTokenForMailbox: getMock,
    getMock,
  } as PipelineHarness['accessToken'];

  const fetchMock = vi.fn(async () => {
    if (options.graphError) throw options.graphError;
    return options.graphMessage ?? makeGraphMessage();
  });
  const graphMail = {
    fetchMessage: fetchMock,
    fetchMock,
  } as PipelineHarness['graphMail'];

  const lookupMock = vi.fn(async () => {
    if (options.mapping === null) return null;
    return (
      options.mapping ?? {
        telegramChatId: CHAT_ID,
        telegramGroupName: TELEGRAM_GROUP,
      }
    );
  });
  const telegramMapping = {
    findActiveMappingForMailboxId: lookupMock,
    lookupMock,
  } as PipelineHarness['telegramMapping'];

  const sendMock = vi.fn(async () => {
    if (options.sendError) throw options.sendError;
    return { ok: true as const, chatId: CHAT_ID, messageId: 1 };
  });
  const telegramSender = {
    sendTelegramMessage: sendMock,
    sendMock,
  } as PipelineHarness['telegramSender'];

  const codeEventMock = vi.fn();
  const auditMock = vi.fn();
  const audit = {
    recordCodeEvent: codeEventMock,
    createAuditLog: auditMock,
    codeEventMock,
    auditMock,
  } as PipelineHarness['audit'];

  const deps: GraphMessagePipelineDeps = {
    store: createInMemoryProcessedMessageStore(),
    mailboxes,
    accessToken,
    graphMail,
    telegramMapping,
    telegramSender,
    audit,
    now: () => new Date('2026-05-29T12:00:00.000Z'),
  };

  return {
    deps,
    mailboxes,
    accessToken,
    graphMail,
    telegramMapping,
    telegramSender,
    audit,
  };
}

function makeJob(
  overrides: Partial<GraphMessageProcessingJob> = {},
): GraphMessageProcessingJob {
  return {
    mailboxId: MAILBOX_ID,
    graphMessageId: GRAPH_MESSAGE_ID,
    source: 'webhook',
    subscriptionId: 'sub-test-1',
    receivedNotificationAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('processGraphMessageJob', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('Case 1 — sends Telegram and records masked code on the happy path', async () => {
    const harness = makeHarness();

    const result = await processGraphMessageJob(makeJob(), harness.deps);

    expect(result.ok).toBe(true);
    expect(result.status).toBe('CODE_SENT');
    expect(result.sentToTelegram).toBe(true);
    expect(result.maskedCode).toBe('82****');
    expect(result.detectorConfidence ?? 0).toBeGreaterThanOrEqual(70);

    expect(harness.graphMail.fetchMock).toHaveBeenCalledTimes(1);
    expect(harness.graphMail.fetchMock).toHaveBeenCalledWith(
      FAKE_ACCESS_TOKEN,
      GRAPH_MESSAGE_ID,
    );

    expect(harness.telegramMapping.lookupMock).toHaveBeenCalledWith(MAILBOX_ID);
    expect(harness.telegramSender.sendMock).toHaveBeenCalledTimes(1);
    const sentArg = harness.telegramSender.sendMock.mock.calls[0][0] as {
      chatId: string;
      text: string;
    };
    expect(sentArg.chatId).toBe(CHAT_ID);
    expect(sentArg.text).toContain(MAILBOX_EMAIL);
    expect(sentArg.text).toContain(VERIFICATION_CODE);

    // Result envelope must not leak the plaintext code.
    expect(JSON.stringify(result)).not.toContain(VERIFICATION_CODE);

    // Code event + audit log were written with masked / safe metadata.
    const codeEvents = harness.audit.codeEventMock.mock.calls.map(
      ([input]) => input,
    );
    expect(codeEvents.some((e) => e.status === 'CODE_SENT')).toBe(true);
    expect(
      codeEvents.every((e) => !JSON.stringify(e).includes(VERIFICATION_CODE)),
    ).toBe(true);

    const auditCalls = harness.audit.auditMock.mock.calls.map(([input]) => input);
    expect(auditCalls.some((a) => a.action === 'CODE_SENT')).toBe(true);
    expect(
      auditCalls.every((a) => !JSON.stringify(a).includes(VERIFICATION_CODE)),
    ).toBe(true);
  });

  it('Case 2 — returns SKIPPED_DUPLICATE when the same Graph message id was already processed', async () => {
    const harness = makeHarness();

    const first = await processGraphMessageJob(makeJob(), harness.deps);
    expect(first.status).toBe('CODE_SENT');

    const second = await processGraphMessageJob(makeJob(), harness.deps);
    expect(second.status).toBe('SKIPPED_DUPLICATE');
    expect(second.sentToTelegram).toBe(false);
    expect(harness.telegramSender.sendMock).toHaveBeenCalledTimes(1);
  });

  it('Case 3 — returns SKIPPED_NOT_FACEBOOK_VERIFICATION for newsletter-style email', async () => {
    const harness = makeHarness({
      graphMessage: makeGraphMessage({
        from: {
          emailAddress: {
            name: 'Acme News',
            address: 'hello@news.example.test',
          },
        },
        sender: {
          emailAddress: {
            name: 'Acme News',
            address: 'hello@news.example.test',
          },
        },
        subject: 'Weekly newsletter from Acme',
        bodyPreview: 'Check our latest products. Promo 12345 inside.',
        body: {
          contentType: 'text',
          content:
            'Check our latest products. Promo 12345 inside. Unsubscribe anytime.',
        },
      }),
    });

    const result = await processGraphMessageJob(makeJob(), harness.deps);

    expect(result.status).toBe('SKIPPED_NOT_FACEBOOK_VERIFICATION');
    expect(result.sentToTelegram).toBe(false);
    expect(harness.telegramSender.sendMock).not.toHaveBeenCalled();
    expect(harness.telegramMapping.lookupMock).not.toHaveBeenCalled();
  });

  it('Case 4 — returns SKIPPED_LOW_CONFIDENCE when extractor cannot lock onto a code', async () => {
    const harness = makeHarness({
      graphMessage: makeGraphMessage({
        subject: 'Your security code',
        bodyPreview:
          'A code 123456 was seen earlier. Use a code 987654 elsewhere too.',
        body: {
          contentType: 'text',
          content:
            'A code 123456 was seen earlier. Please use a code 987654 elsewhere too.',
        },
      }),
    });

    const result = await processGraphMessageJob(makeJob(), harness.deps);

    expect(['SKIPPED_LOW_CONFIDENCE', 'SKIPPED_NO_CODE']).toContain(result.status);
    expect(result.sentToTelegram).toBe(false);
    expect(harness.telegramSender.sendMock).not.toHaveBeenCalled();
  });

  it('Case 5 — returns SKIPPED_NO_TELEGRAM_MAPPING when no active mapping exists', async () => {
    const harness = makeHarness({ mapping: null });

    const result = await processGraphMessageJob(makeJob(), harness.deps);

    expect(result.status).toBe('SKIPPED_NO_TELEGRAM_MAPPING');
    expect(result.sentToTelegram).toBe(false);
    expect(harness.telegramSender.sendMock).not.toHaveBeenCalled();
    expect(harness.telegramMapping.lookupMock).toHaveBeenCalledWith(MAILBOX_ID);
  });

  it('Case 6 — returns FAILED_GRAPH_FETCH for a 5xx Graph response', async () => {
    const harness = makeHarness({
      graphError: new GraphMailError('temporary', 'GRAPH_TEMPORARY_ERROR', {
        httpStatus: 503,
      }),
    });

    const result = await processGraphMessageJob(makeJob(), harness.deps);

    expect(result.status).toBe('FAILED_GRAPH_FETCH');
    expect(result.reason).toBe('temporary');
    expect(harness.telegramSender.sendMock).not.toHaveBeenCalled();
  });

  it('Case 6b — returns FAILED_RECONNECT_REQUIRED and flags mailbox on a 401', async () => {
    const harness = makeHarness({
      graphError: new GraphMailError('auth', 'GRAPH_AUTH_FAILED', {
        httpStatus: 401,
      }),
    });

    const result = await processGraphMessageJob(makeJob(), harness.deps);

    expect(result.status).toBe('FAILED_RECONNECT_REQUIRED');
    expect(harness.mailboxes.markReconnectRequiredMock).toHaveBeenCalledWith(
      MAILBOX_ID,
    );
    expect(harness.telegramSender.sendMock).not.toHaveBeenCalled();
    const auditCalls = harness.audit.auditMock.mock.calls.map(([input]) => input);
    expect(
      auditCalls.some((a) => a.action === 'MAILBOX_RECONNECT_REQUIRED'),
    ).toBe(true);
  });

  it('Case 7 — returns FAILED_TELEGRAM_SEND safely when the Telegram sender throws', async () => {
    const harness = makeHarness({
      sendError: new TelegramSendError('telegram_api', 'Telegram send failed', {
        telegramDescription: 'chat not found',
      }),
    });

    const result = await processGraphMessageJob(makeJob(), harness.deps);

    expect(result.status).toBe('FAILED_TELEGRAM_SEND');
    expect(result.sentToTelegram).toBe(false);
    expect(result.reason).toBe('telegram_api');
    // No leaked code or bot-token-looking strings.
    expect(JSON.stringify(result)).not.toContain(VERIFICATION_CODE);
    expect(JSON.stringify(result)).not.toMatch(/bot\d+:/);

    const stored = await harness.deps.store.findByGraphMessageId(
      MAILBOX_ID,
      GRAPH_MESSAGE_ID,
    );
    expect(stored?.status).toBe('DETECTED');
    expect(stored?.sentToTelegramAt).toBeNull();
  });

  it('skips when the mailbox is not ACTIVE', async () => {
    const harness = makeHarness({
      mailbox: makeMailbox({ status: 'RECONNECT_REQUIRED' }),
    });

    const result = await processGraphMessageJob(makeJob(), harness.deps);

    expect(result.status).toBe('SKIPPED_MAILBOX_NOT_ACTIVE');
    expect(harness.graphMail.fetchMock).not.toHaveBeenCalled();
    expect(harness.telegramSender.sendMock).not.toHaveBeenCalled();
  });

  it('returns FAILED_UNEXPECTED for invalid input without calling downstream services', async () => {
    const harness = makeHarness();

    const result = await processGraphMessageJob(
      { mailboxId: '', graphMessageId: '' } as GraphMessageProcessingJob,
      harness.deps,
    );

    expect(result.status).toBe('FAILED_UNEXPECTED');
    expect(harness.mailboxes.findByIdMock).not.toHaveBeenCalled();
    expect(harness.graphMail.fetchMock).not.toHaveBeenCalled();
    expect(harness.telegramSender.sendMock).not.toHaveBeenCalled();
  });

  it('returns FAILED_RECONNECT_REQUIRED when the access token cannot be acquired', async () => {
    const harness = makeHarness({ accessTokenThrows: true });

    const result = await processGraphMessageJob(makeJob(), harness.deps);

    expect(result.status).toBe('FAILED_RECONNECT_REQUIRED');
    expect(result.reason).toBe('token_refresh_failed');
    expect(harness.mailboxes.markReconnectRequiredMock).toHaveBeenCalledWith(
      MAILBOX_ID,
    );
    expect(harness.graphMail.fetchMock).not.toHaveBeenCalled();
    expect(harness.telegramSender.sendMock).not.toHaveBeenCalled();
  });

  it('never lets the plaintext verification code leak into the result envelope or logs', async () => {
    const harness = makeHarness();

    const result = await processGraphMessageJob(makeJob(), harness.deps);

    expect(result.maskedCode?.startsWith('82')).toBe(true);
    expect(result.maskedCode?.length).toBe(VERIFICATION_CODE.length);
    expect(JSON.stringify(result)).not.toContain(VERIFICATION_CODE);

    const codeEvents = harness.audit.codeEventMock.mock.calls.map(
      ([input]) => JSON.stringify(input),
    );
    expect(codeEvents.every((s) => !s.includes(VERIFICATION_CODE))).toBe(true);
  });
});
