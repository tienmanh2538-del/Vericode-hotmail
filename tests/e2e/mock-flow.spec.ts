// TASK-037 — End-to-end (integration) test for the internal mock flow.
//
// Flow under test (no Microsoft Graph, no real Telegram, no DB, no network):
//
//   mock email fixture
//     → facebook-detector.service       (real)
//     → code-extractor.service          (real)
//     → deduplication.service           (real, in-memory store)
//     → email-processing.service        (real orchestrator, processMockEmail)
//     → Telegram sender                 (mock spy — never calls the Bot API)
//     → code-event-log.service          (real, in-memory store — the audit/log surface)
//
// SECURITY (docs/SECURITY_RULES.md):
//   - No secret, token, real email, or real chat id appears in this file.
//   - The full verification code is only ever delivered to the (mocked) Telegram
//     payload — never to the application log nor the code event log.
//
// WHY dynamic imports + vi.resetModules: the services build a module-level
// logger whose sink binds `console.*` at import time. To assert the real
// pipeline never leaks a secret into application logs (Case 4), the console
// spies must be installed BEFORE the service modules evaluate. We therefore
// reset the module registry and import the services inside beforeEach. This is
// a test-only technique; no service logic is modified.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import fbJson from '@/tests/fixtures/email-samples/facebook-verification-e2e.json';
import newsletterJson from '@/tests/fixtures/email-samples/non-facebook-newsletter-e2e.json';

import type {
  EmailProcessingDependencies,
  EmailProcessingResult,
  EmailProcessingStatus,
  ProcessMockEmailInput,
} from '@/services/email/email-processing.service';
import type { ProcessedMessageStore } from '@/services/email/deduplication.service';
import type {
  CodeEventLogStore,
  CodeEventStatus,
} from '@/services/logs/code-event-log.service';

interface MockEmailFixture {
  messageId: string;
  mailboxId: string;
  mailboxEmail: string;
  fromEmail: string;
  fromName?: string;
  subject: string;
  receivedAt: string;
  bodyPreview?: string;
  body: string;
}

const fbFixture: MockEmailFixture = fbJson;
const newsletterFixture: MockEmailFixture = newsletterJson;

// Synthetic constants. None of these are real.
const FB_CODE = '362844';
const FB_MASKED_CODE = '36****';
const NEWSLETTER_NUMBER = '123456';
const MOCK_CHAT_ID = '-1009000000001';
// A recent timestamp keeps the detector's staleness heuristic happy regardless
// of the wall clock when CI runs the suite.
const RECENT_ISO = new Date().toISOString();

// Map the orchestrator result onto the code event log surface. This mirrors how
// a UI/worker would persist an auditable event for each processed message.
const STATUS_TO_EVENT: Partial<Record<EmailProcessingStatus, CodeEventStatus>> = {
  SENT: 'CODE_SENT',
  SKIPPED_DUPLICATE: 'CODE_SKIPPED_DUPLICATE',
  SKIPPED_LOW_CONFIDENCE: 'CODE_SKIPPED_LOW_CONFIDENCE',
  SKIPPED_NO_CODE: 'EXTRACTOR_FAILED',
  SKIPPED_NOT_FACEBOOK_VERIFICATION: 'DETECTOR_REJECTED',
  SKIPPED_NO_TELEGRAM_MAPPING: 'CODE_DETECTED',
  FAILED_TELEGRAM_SEND: 'TELEGRAM_SEND_FAILED',
};

// Service modules are imported fresh in beforeEach so their loggers bind to the
// console spies installed below.
let processing: typeof import('@/services/email/email-processing.service');
let dedup: typeof import('@/services/email/deduplication.service');
let codeLog: typeof import('@/services/logs/code-event-log.service');

let logs: string[] = [];

function formatLogArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  try {
    return JSON.stringify(arg);
  } catch {
    return String(arg);
  }
}

function buildFrom(fixture: MockEmailFixture): string {
  return fixture.fromName
    ? `${fixture.fromName} <${fixture.fromEmail}>`
    : fixture.fromEmail;
}

function toProcessInput(
  fixture: MockEmailFixture,
  overrides: Partial<ProcessMockEmailInput> = {},
): ProcessMockEmailInput {
  return {
    messageId: fixture.messageId,
    mailboxId: fixture.mailboxId,
    mailboxEmail: fixture.mailboxEmail,
    from: buildFrom(fixture),
    subject: fixture.subject,
    textBody: fixture.body,
    bodyPreview: fixture.bodyPreview,
    receivedAt: RECENT_ISO,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<EmailProcessingDependencies> = {}): {
  deps: EmailProcessingDependencies;
  store: ProcessedMessageStore;
  sendSpy: ReturnType<typeof vi.fn>;
  resolveSpy: ReturnType<typeof vi.fn>;
} {
  const store = dedup.createInMemoryProcessedMessageStore();
  const sendSpy = vi.fn(async () => ({
    ok: true as const,
    chatId: MOCK_CHAT_ID,
    messageId: 1,
  }));
  const resolveSpy = vi.fn(async () => ({
    chatId: MOCK_CHAT_ID,
    threadId: null,
  }));
  const deps: EmailProcessingDependencies = {
    store,
    resolveTelegramDestination: resolveSpy,
    sendTelegramMessage: sendSpy,
    ...overrides,
  };
  return { deps, store, sendSpy, resolveSpy };
}

// Persist an auditable, masked event for a processed message — the terminal
// "→ log" step of the mock flow.
function recordResultEvent(
  result: EmailProcessingResult,
  store: CodeEventLogStore,
): void {
  const status = STATUS_TO_EVENT[result.status];
  if (!status) return;
  codeLog.recordCodeEvent(
    {
      mailboxEmail: result.mailboxEmail,
      status,
      maskedCode: result.maskedCode,
      confidence: result.confidence,
      source: 'mock',
      receivedAt: RECENT_ISO,
    },
    store,
  );
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
  processing = await import('@/services/email/email-processing.service');
  dedup = await import('@/services/email/deduplication.service');
  codeLog = await import('@/services/logs/code-event-log.service');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('mock flow (E2E): mock email → detect → extract → dedupe → Telegram mock → log', () => {
  it('Case 1 — happy path: a valid Facebook email is detected, extracted, sent to the Telegram mock, and logged with a masked code', async () => {
    const { deps, store, sendSpy, resolveSpy } = makeDeps();
    const eventStore = codeLog.createInMemoryCodeEventLogStore();

    const result = await processing.processMockEmail(toProcessInput(fbFixture), deps);
    recordResultEvent(result, eventStore);

    // Detector + extractor + orchestrator
    expect(result.status).toBe('SENT');
    expect(result.success).toBe(true);
    expect(result.platform).toBe('facebook_meta');
    expect(result.maskedCode).toBe(FB_MASKED_CODE);

    // Telegram mapping resolved by mailbox, then the mock sender invoked once
    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalledWith(fbFixture.mailboxId);
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sent = sendSpy.mock.calls[0][0] as {
      chatId: string;
      text: string;
      messageThreadId?: string;
    };
    expect(sent.chatId).toBe(MOCK_CHAT_ID);
    expect(sent.messageThreadId).toBeUndefined();
    expect(sent.text).toContain(fbFixture.mailboxEmail);
    // The full code is delivered to the Telegram group on purpose (product goal).
    expect(sent.text).toContain(FB_CODE);

    // Dedup store row was claimed and flipped to SENT
    const stored = await store.findByGraphMessageId(
      fbFixture.mailboxId,
      fbFixture.messageId,
    );
    expect(stored?.status).toBe('SENT');
    expect(stored?.sentToTelegramAt).not.toBeNull();

    // Code event log holds exactly one masked CODE_SENT event, never the raw code
    const events = codeLog.listCodeEvents(eventStore);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('CODE_SENT');
    expect(events[0].maskedCode).toBe(FB_MASKED_CODE);
    expect(JSON.stringify(events)).not.toContain(FB_CODE);

    // The result envelope never carries the plaintext code
    expect(JSON.stringify(result)).not.toContain(FB_CODE);
  });

  it('Case 2 — submitting the same email twice is deduped and not re-sent to Telegram', async () => {
    const { deps, sendSpy } = makeDeps();
    const eventStore = codeLog.createInMemoryCodeEventLogStore();

    const first = await processing.processMockEmail(toProcessInput(fbFixture), deps);
    recordResultEvent(first, eventStore);
    const second = await processing.processMockEmail(toProcessInput(fbFixture), deps);
    recordResultEvent(second, eventStore);

    expect(first.status).toBe('SENT');
    expect(second.status).toBe('SKIPPED_DUPLICATE');
    expect(second.success).toBe(false);

    // The Telegram mock must have been hit exactly once (the first call only)
    expect(sendSpy).toHaveBeenCalledTimes(1);

    const events = codeLog.listCodeEvents(eventStore);
    expect(events.filter((e) => e.status === 'CODE_SENT')).toHaveLength(1);
    expect(events.filter((e) => e.status === 'CODE_SKIPPED_DUPLICATE')).toHaveLength(1);
    expect(JSON.stringify(events)).not.toContain(FB_CODE);
  });

  it('Case 3 — a non Facebook/Meta email is rejected, not sent to Telegram, and its number is not treated as a code', async () => {
    const { deps, sendSpy, resolveSpy } = makeDeps();
    const eventStore = codeLog.createInMemoryCodeEventLogStore();

    const result = await processing.processMockEmail(
      toProcessInput(newsletterFixture),
      deps,
    );
    recordResultEvent(result, eventStore);

    expect(result.status).toBe('SKIPPED_NOT_FACEBOOK_VERIFICATION');
    expect(result.success).toBe(false);
    expect(result.maskedCode).toBeUndefined();

    // Nothing forwarded: neither mapping lookup nor Telegram send happened
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();

    const events = codeLog.listCodeEvents(eventStore);
    expect(events).toHaveLength(1);
    expect(events[0].status).toBe('DETECTOR_REJECTED');
    expect(events[0].maskedCode).toBeUndefined();
    // The invoice number must never surface as a (masked) verification code
    expect(JSON.stringify(events)).not.toContain(NEWSLETTER_NUMBER);
  });

  it('Case 4 — no secret or full verification code leaks into application logs or the code event log', async () => {
    const { deps } = makeDeps();
    const eventStore = codeLog.createInMemoryCodeEventLogStore();

    const result = await processing.processMockEmail(toProcessInput(fbFixture), deps);
    recordResultEvent(result, eventStore);

    // The pipeline did emit logs, and we captured them via the console sink.
    expect(logs.length).toBeGreaterThan(0);
    const logBlob = logs.join('\n');

    // The full verification code never appears in application logs.
    expect(logBlob).not.toContain(FB_CODE);

    // No fake/forbidden token strings leaked into logs.
    for (const forbidden of [
      'test-token',
      'refresh-token',
      'telegram-bot-token',
    ]) {
      expect(logBlob).not.toContain(forbidden);
    }
    // No Telegram bot-token-shaped material (e.g. "bot123456:AA...").
    expect(logBlob).not.toMatch(/bot\d+:[A-Za-z0-9_-]+/i);

    // The code event log stores only the masked code, never the raw value.
    const events = codeLog.listCodeEvents(eventStore);
    expect(JSON.stringify(events)).not.toContain(FB_CODE);
    expect(events[0]?.maskedCode).toBe(FB_MASKED_CODE);
  });
});
