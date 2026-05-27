import { describe, it, expect, beforeEach } from 'vitest';
import {
  buildProcessedMessageDedupeKey,
  checkProcessedMessageDuplicate,
  claimMessageForProcessing,
  createInMemoryProcessedMessageStore,
  markMessageAsSent,
  normalizeMessageId,
  roundReceivedAtToBucket,
  type DeduplicationInput,
  type ProcessedMessageStore,
} from '@/services/email/deduplication.service';

// All fixtures below use intentionally fake identifiers:
//   - .test TLD (RFC 6761 reserved) for sender domains
//   - "mailbox_test_*" for mailbox IDs
//   - "graph-msg-test-*" / "<msg-test-*@example.test>" for message IDs
//   - "123456" / "654321" / "987654" for verification codes
// No real customer email, token, or secret is present.

const MAILBOX_A = 'mailbox_test_alpha';
const MAILBOX_B = 'mailbox_test_beta';
const CODE_A = '123456';
const CODE_B = '987654';
const RECEIVED_AT_T0 = '2025-01-01T10:00:30.000Z';
const RECEIVED_AT_SAME_BUCKET = '2025-01-01T10:02:00.000Z';
const RECEIVED_AT_DIFFERENT_BUCKET = '2025-01-01T11:00:00.000Z';

function baseInput(overrides: Partial<DeduplicationInput> = {}): DeduplicationInput {
  return {
    mailboxId: MAILBOX_A,
    graphMessageId: 'graph-msg-test-001',
    internetMessageId: '<msg-test-001@example.test>',
    receivedAt: RECEIVED_AT_T0,
    senderEmail: 'security@example.test',
    subject: 'Your verification code',
    verificationCode: CODE_A,
    ...overrides,
  };
}

describe('normalizeMessageId', () => {
  it('returns null for non-string input', () => {
    expect(normalizeMessageId(undefined)).toBeNull();
    expect(normalizeMessageId(null)).toBeNull();
    expect(normalizeMessageId(123)).toBeNull();
  });

  it('returns null for empty / whitespace strings', () => {
    expect(normalizeMessageId('')).toBeNull();
    expect(normalizeMessageId('   ')).toBeNull();
    expect(normalizeMessageId('<>')).toBeNull();
  });

  it('strips wrapping angle brackets used in internet message IDs', () => {
    expect(normalizeMessageId('<abc@example.test>')).toBe('abc@example.test');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeMessageId('  graph-msg-test-1  ')).toBe('graph-msg-test-1');
  });
});

describe('roundReceivedAtToBucket', () => {
  it('returns null for missing input', () => {
    expect(roundReceivedAtToBucket(null)).toBeNull();
    expect(roundReceivedAtToBucket(undefined)).toBeNull();
  });

  it('returns null for invalid date strings', () => {
    expect(roundReceivedAtToBucket('not-a-date')).toBeNull();
  });

  it('floors timestamps to the configured bucket boundary', () => {
    expect(roundReceivedAtToBucket('2025-01-01T10:02:30.000Z')).toBe(
      '2025-01-01T10:00:00.000Z',
    );
    expect(roundReceivedAtToBucket('2025-01-01T10:06:30.000Z')).toBe(
      '2025-01-01T10:05:00.000Z',
    );
  });

  it('two timestamps inside the same bucket round to the same value', () => {
    const a = roundReceivedAtToBucket(RECEIVED_AT_T0);
    const b = roundReceivedAtToBucket(RECEIVED_AT_SAME_BUCKET);
    expect(a).toBe(b);
  });

  it('timestamps in different buckets round to different values', () => {
    const a = roundReceivedAtToBucket(RECEIVED_AT_T0);
    const b = roundReceivedAtToBucket(RECEIVED_AT_DIFFERENT_BUCKET);
    expect(a).not.toBe(b);
  });
});

describe('buildProcessedMessageDedupeKey', () => {
  it('prefers graphMessageId when present', () => {
    const key = buildProcessedMessageDedupeKey(baseInput());
    expect(key).toBe(`${MAILBOX_A}|gmid|graph-msg-test-001`);
  });

  it('falls back to internetMessageId when graphMessageId is missing', () => {
    const key = buildProcessedMessageDedupeKey(
      baseInput({ graphMessageId: null }),
    );
    expect(key).toBe(`${MAILBOX_A}|imid|msg-test-001@example.test`);
  });

  it('falls back to code+bucket when both message ids are missing', () => {
    const key = buildProcessedMessageDedupeKey(
      baseInput({ graphMessageId: null, internetMessageId: null }),
    );
    expect(key).toMatch(
      new RegExp(`^${MAILBOX_A}\\|code\\|[0-9a-f]{64}\\|.+Z$`),
    );
    expect(key).not.toContain(CODE_A);
  });

  it('returns empty string when no dedupe identifier is available', () => {
    const key = buildProcessedMessageDedupeKey({
      mailboxId: MAILBOX_A,
    });
    expect(key).toBe('');
  });
});

describe('deduplication service - stateful operations', () => {
  let store: ProcessedMessageStore;

  beforeEach(() => {
    store = createInMemoryProcessedMessageStore();
  });

  it('first-time message returns shouldProcess: true (test #1)', async () => {
    const result = await claimMessageForProcessing(baseInput(), store);

    expect(result.shouldProcess).toBe(true);
    expect(result.isDuplicate).toBe(false);
    expect(result.reason).toBe('NEW_MESSAGE');
    expect(result.processedMessageId).toBeTruthy();
  });

  it('same mailboxId + graphMessageId returns duplicate (test #2)', async () => {
    await claimMessageForProcessing(baseInput(), store);

    const second = await checkProcessedMessageDuplicate(
      baseInput({
        // different internet id + different code so only gmid can collide
        internetMessageId: '<msg-test-OTHER@example.test>',
        verificationCode: CODE_B,
      }),
      store,
    );

    expect(second.isDuplicate).toBe(true);
    expect(second.shouldProcess).toBe(false);
    expect(second.reason).toBe('DUPLICATE_GRAPH_MESSAGE_ID');
    expect(second.processedMessageId).toBeTruthy();
  });

  it('same mailboxId + internetMessageId returns duplicate (test #3)', async () => {
    await claimMessageForProcessing(baseInput(), store);

    const second = await checkProcessedMessageDuplicate(
      baseInput({
        graphMessageId: 'graph-msg-test-DIFFERENT',
        verificationCode: CODE_B,
        receivedAt: RECEIVED_AT_DIFFERENT_BUCKET,
      }),
      store,
    );

    expect(second.isDuplicate).toBe(true);
    expect(second.reason).toBe('DUPLICATE_INTERNET_MESSAGE_ID');
  });

  it('same mailboxId + codeHash + receivedAtBucket returns duplicate (test #4)', async () => {
    await claimMessageForProcessing(
      baseInput({ graphMessageId: null, internetMessageId: null }),
      store,
    );

    const second = await checkProcessedMessageDuplicate(
      baseInput({
        graphMessageId: null,
        internetMessageId: null,
        receivedAt: RECEIVED_AT_SAME_BUCKET,
      }),
      store,
    );

    expect(second.isDuplicate).toBe(true);
    expect(second.reason).toBe('DUPLICATE_CODE_TIME_BUCKET');
  });

  it('same code in a different mailbox is not a duplicate (test #5)', async () => {
    await claimMessageForProcessing(
      baseInput({ graphMessageId: null, internetMessageId: null }),
      store,
    );

    const second = await checkProcessedMessageDuplicate(
      baseInput({
        mailboxId: MAILBOX_B,
        graphMessageId: null,
        internetMessageId: null,
      }),
      store,
    );

    expect(second.isDuplicate).toBe(false);
    expect(second.shouldProcess).toBe(true);
    expect(second.reason).toBe('NEW_MESSAGE');
  });

  it('same code in same mailbox but different time bucket is not duplicate (test #6)', async () => {
    await claimMessageForProcessing(
      baseInput({ graphMessageId: null, internetMessageId: null }),
      store,
    );

    const second = await checkProcessedMessageDuplicate(
      baseInput({
        graphMessageId: null,
        internetMessageId: null,
        receivedAt: RECEIVED_AT_DIFFERENT_BUCKET,
      }),
      store,
    );

    expect(second.isDuplicate).toBe(false);
    expect(second.shouldProcess).toBe(true);
    expect(second.reason).toBe('NEW_MESSAGE');
  });

  it('missing mailboxId returns INVALID_INPUT (test #7)', async () => {
    const result = await checkProcessedMessageDuplicate(
      baseInput({ mailboxId: '' }),
      store,
    );

    expect(result.reason).toBe('INVALID_INPUT');
    expect(result.shouldProcess).toBe(false);
    expect(result.isDuplicate).toBe(false);
  });

  it('missing all dedupe identifiers returns INVALID_INPUT (test #8)', async () => {
    const result = await checkProcessedMessageDuplicate(
      {
        mailboxId: MAILBOX_A,
        graphMessageId: null,
        internetMessageId: null,
        verificationCode: null,
        receivedAt: null,
      },
      store,
    );

    expect(result.reason).toBe('INVALID_INPUT');
    expect(result.shouldProcess).toBe(false);

    // verificationCode present but receivedAt missing → still INVALID_INPUT
    // (code alone is not a dedupe key without a time bucket).
    const codeOnly = await checkProcessedMessageDuplicate(
      {
        mailboxId: MAILBOX_A,
        verificationCode: CODE_A,
      },
      store,
    );
    expect(codeOnly.reason).toBe('INVALID_INPUT');
  });

  it('result does not expose plaintext verification code (test #9)', async () => {
    const input = baseInput({ verificationCode: CODE_A });
    const claimed = await claimMessageForProcessing(input, store);

    expect(claimed).not.toHaveProperty('verificationCode');
    expect(claimed).not.toHaveProperty('code');
    expect(JSON.stringify(claimed)).not.toContain(CODE_A);

    // Duplicate path must also not leak the plaintext code.
    const duplicate = await checkProcessedMessageDuplicate(input, store);
    expect(duplicate).not.toHaveProperty('verificationCode');
    expect(duplicate).not.toHaveProperty('code');
    expect(JSON.stringify(duplicate)).not.toContain(CODE_A);

    // Code-only branch also masks the plaintext code in dedupeKey.
    const codeOnlyClaim = await claimMessageForProcessing(
      baseInput({
        graphMessageId: null,
        internetMessageId: null,
        verificationCode: CODE_B,
      }),
      store,
    );
    expect(codeOnlyClaim.dedupeKey).toBeDefined();
    expect(codeOnlyClaim.dedupeKey).not.toContain(CODE_B);
    expect(JSON.stringify(codeOnlyClaim)).not.toContain(CODE_B);
  });

  it('fixtures contain no real token / secret / customer email (test #10)', () => {
    // Sanity-check the constants used in this file. The .test TLD is reserved
    // by RFC 6761 and can never resolve to a real mailbox, and the mailbox /
    // message identifiers are obviously synthetic.
    const fixtureValues = [
      MAILBOX_A,
      MAILBOX_B,
      'graph-msg-test-001',
      '<msg-test-001@example.test>',
      'security@example.test',
      'Your verification code',
      CODE_A,
      CODE_B,
    ];
    for (const v of fixtureValues) {
      expect(v).not.toMatch(/@(gmail|outlook|hotmail|yahoo|live|icloud)\.com$/i);
      expect(v).not.toMatch(/bearer|api[_-]?key|client[_-]?secret/i);
    }
    for (const v of fixtureValues) {
      if (v.includes('@')) {
        expect(v.endsWith('.test') || v.endsWith('.test>')).toBe(true);
      }
    }
  });

  it('claimMessageForProcessing followed by another claim returns duplicate', async () => {
    const first = await claimMessageForProcessing(baseInput(), store);
    expect(first.shouldProcess).toBe(true);

    const second = await claimMessageForProcessing(baseInput(), store);
    expect(second.shouldProcess).toBe(false);
    expect(second.isDuplicate).toBe(true);
    expect(second.reason).toBe('DUPLICATE_GRAPH_MESSAGE_ID');
  });

  it('markMessageAsSent transitions status to SENT', async () => {
    const claimed = await claimMessageForProcessing(baseInput(), store);
    expect(claimed.processedMessageId).toBeTruthy();

    const sentAt = new Date('2025-01-01T10:01:00.000Z');
    await markMessageAsSent(claimed.processedMessageId!, store, sentAt);

    // The record should now report SENT via a fresh lookup.
    const found = await store.findByGraphMessageId(
      MAILBOX_A,
      'graph-msg-test-001',
    );
    expect(found?.status).toBe('SENT');
    expect(found?.sentToTelegramAt?.toISOString()).toBe(sentAt.toISOString());
  });

  it('markMessageAsSent throws when given empty id', async () => {
    await expect(markMessageAsSent('', store)).rejects.toThrow();
    await expect(markMessageAsSent('   ', store)).rejects.toThrow();
  });
});
