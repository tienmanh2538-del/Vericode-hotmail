import { describe, it, expect, vi } from 'vitest';
import {
  processMockEmail,
  type EmailProcessingDependencies,
  type ProcessMockEmailInput,
} from '@/services/email/email-processing.service';
import { createInMemoryProcessedMessageStore } from '@/services/email/deduplication.service';
import { TelegramSendError } from '@/services/telegram/telegram-sender.service';

// All fixtures intentionally use synthetic identifiers (RFC 6761 .test TLD,
// "mailbox_test_*" ids, fake codes). No real customer email, bot token, or
// Telegram chat id appears in this file.

const MAILBOX_EMAIL = 'agent.test@example.test';
const FROM_TRUSTED = 'Facebook Security <security@facebookmail.com>';
const FROM_NEWSLETTER = 'Daily Updates <hello@news.example.test>';
const CODE = '824739';
const CHAT_ID = '-1009999999999';
const MAILBOX_ID = 'mailbox_test_alpha';
const MESSAGE_ID = 'graph-msg-test-014-001';

function recentIso(): string {
  return new Date().toISOString();
}

function fbVerificationInput(
  overrides: Partial<ProcessMockEmailInput> = {},
): ProcessMockEmailInput {
  return {
    messageId: MESSAGE_ID,
    mailboxId: MAILBOX_ID,
    mailboxEmail: MAILBOX_EMAIL,
    from: FROM_TRUSTED,
    subject: 'Your Facebook security code',
    textBody: `Your security code is ${CODE}. Use it to log in to your account.`,
    receivedAt: recentIso(),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<EmailProcessingDependencies> = {}): {
  deps: EmailProcessingDependencies;
  sendSpy: ReturnType<typeof vi.fn>;
  resolveSpy: ReturnType<typeof vi.fn>;
} {
  const store = createInMemoryProcessedMessageStore();
  const sendSpy = vi.fn(async () => ({
    ok: true as const,
    chatId: CHAT_ID,
    messageId: 1,
  }));
  const resolveSpy = vi.fn(async () => ({
    chatId: CHAT_ID,
    threadId: null,
  }));
  const deps: EmailProcessingDependencies = {
    store,
    resolveTelegramDestination: resolveSpy,
    sendTelegramMessage: sendSpy,
    ...overrides,
  };
  return { deps, sendSpy, resolveSpy };
}

describe('processMockEmail', () => {
  it('Case 1: sends Telegram and marks processed for a valid Facebook verification email', async () => {
    const { deps, sendSpy, resolveSpy } = makeDeps();

    const result = await processMockEmail(fbVerificationInput(), deps);

    expect(result.status).toBe('SENT');
    expect(result.success).toBe(true);
    expect(result.platform).toBe('facebook_meta');
    expect(result.maskedCode).toBe('82****');
    expect(result.messageId).toBe(MESSAGE_ID);
    expect(result.mailboxEmail).toBe(MAILBOX_EMAIL);

    expect(resolveSpy).toHaveBeenCalledTimes(1);
    expect(resolveSpy).toHaveBeenCalledWith(MAILBOX_ID);

    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sentArg = sendSpy.mock.calls[0][0] as {
      chatId: string;
      text: string;
      messageThreadId?: string;
    };
    expect(sentArg.chatId).toBe(CHAT_ID);
    expect(sentArg.messageThreadId).toBeUndefined();
    expect(sentArg.text).toContain(MAILBOX_EMAIL);
    // The full code goes to Telegram on purpose, but never to the result.
    expect(sentArg.text).toContain(CODE);

    const stored = await deps.store.findByGraphMessageId(MAILBOX_ID, MESSAGE_ID);
    expect(stored?.status).toBe('SENT');
    expect(stored?.sentToTelegramAt).not.toBeNull();

    // Result envelope must not leak the plaintext code.
    expect(JSON.stringify(result)).not.toContain(CODE);
  });

  it('Case 1b: forwards message_thread_id to the sender when the mapping has a topic', async () => {
    const { deps, sendSpy, resolveSpy } = makeDeps({
      resolveTelegramDestination: vi.fn(async () => ({
        chatId: CHAT_ID,
        threadId: '42',
      })),
    });

    const result = await processMockEmail(fbVerificationInput(), deps);

    expect(result.status).toBe('SENT');
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sentArg = sendSpy.mock.calls[0][0] as {
      chatId: string;
      messageThreadId?: string;
    };
    expect(sentArg.chatId).toBe(CHAT_ID);
    expect(sentArg.messageThreadId).toBe('42');
  });

  it('Case 2: skips when the email is not a Facebook/Meta verification', async () => {
    const { deps, sendSpy, resolveSpy } = makeDeps();

    const result = await processMockEmail(
      fbVerificationInput({
        from: FROM_NEWSLETTER,
        subject: 'Weekly newsletter from our shop',
        textBody: 'Check out our products this week. Promo code 12345 inside.',
      }),
      deps,
    );

    expect(result.status).toBe('SKIPPED_NOT_FACEBOOK_VERIFICATION');
    expect(result.success).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('Case 3: skips with low confidence when extractor cannot lock onto a single code', async () => {
    const { deps, sendSpy, resolveSpy } = makeDeps();

    const result = await processMockEmail(
      fbVerificationInput({
        // Detector still passes (trusted sender + subject "security code" +
        // weak code-context keyword near digits), but the body offers two
        // weakly-supported candidates so the extractor stays under threshold.
        subject: 'Your security code',
        textBody:
          'A code 123456 was seen earlier. Please use a code 987654 elsewhere too.',
      }),
      deps,
    );

    // Task spec allows either SKIPPED_LOW_CONFIDENCE or SKIPPED_NO_CODE.
    expect(['SKIPPED_LOW_CONFIDENCE', 'SKIPPED_NO_CODE']).toContain(
      result.status,
    );
    expect(result.success).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('Case 4: skips duplicate when the same message id was already processed', async () => {
    const { deps, sendSpy } = makeDeps();

    const first = await processMockEmail(fbVerificationInput(), deps);
    expect(first.status).toBe('SENT');

    const second = await processMockEmail(fbVerificationInput(), deps);

    expect(second.status).toBe('SKIPPED_DUPLICATE');
    expect(second.success).toBe(false);
    // Telegram should only have been hit once total (the first call).
    expect(sendSpy).toHaveBeenCalledTimes(1);
  });

  it('Case 5: skips when no Telegram mapping resolves and does not mark sent', async () => {
    const resolveSpy = vi.fn(async () => null);
    const { deps, sendSpy } = makeDeps({ resolveTelegramDestination: resolveSpy });

    const result = await processMockEmail(fbVerificationInput(), deps);

    expect(result.status).toBe('SKIPPED_NO_TELEGRAM_MAPPING');
    expect(result.success).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(resolveSpy).toHaveBeenCalledTimes(1);

    const stored = await deps.store.findByGraphMessageId(MAILBOX_ID, MESSAGE_ID);
    // Dedup row exists (DETECTED) but was never flipped to SENT.
    expect(stored?.status).toBe('DETECTED');
    expect(stored?.sentToTelegramAt).toBeNull();
  });

  it('Case 6: returns FAILED_TELEGRAM_SEND safely when the sender throws', async () => {
    const sendSpy = vi.fn(async () => {
      throw new TelegramSendError('telegram_api', 'Telegram send failed', {
        telegramDescription: 'chat not found',
      });
    });
    const { deps } = makeDeps({ sendTelegramMessage: sendSpy });

    const result = await processMockEmail(fbVerificationInput(), deps);

    expect(result.status).toBe('FAILED_TELEGRAM_SEND');
    expect(result.success).toBe(false);
    expect(result.reason).toBe('telegram_api');
    // No leaked code or token fragments in the safe envelope.
    expect(JSON.stringify(result)).not.toContain(CODE);
    expect(JSON.stringify(result)).not.toMatch(/bot\d+:/);

    const stored = await deps.store.findByGraphMessageId(MAILBOX_ID, MESSAGE_ID);
    expect(stored?.status).toBe('DETECTED');
    expect(stored?.sentToTelegramAt).toBeNull();
  });

  it('uses an explicit telegramChatId and telegramThreadId from the input and skips the mapping resolver', async () => {
    const { deps, sendSpy, resolveSpy } = makeDeps();

    const result = await processMockEmail(
      fbVerificationInput({ telegramChatId: '-100777', telegramThreadId: '88' }),
      deps,
    );

    expect(result.status).toBe('SENT');
    expect(sendSpy).toHaveBeenCalledTimes(1);
    const sentArg = sendSpy.mock.calls[0][0] as {
      chatId: string;
      messageThreadId?: string;
    };
    expect(sentArg.chatId).toBe('-100777');
    expect(sentArg.messageThreadId).toBe('88');
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('returns FAILED_UNEXPECTED for blatantly invalid input without calling downstream services', async () => {
    const { deps, sendSpy, resolveSpy } = makeDeps();

    const result = await processMockEmail(
      fbVerificationInput({ messageId: '', mailboxEmail: '' }),
      deps,
    );

    expect(result.status).toBe('FAILED_UNEXPECTED');
    expect(result.success).toBe(false);
    expect(sendSpy).not.toHaveBeenCalled();
    expect(resolveSpy).not.toHaveBeenCalled();
  });

  it('never returns the plaintext verification code in the result envelope', async () => {
    const { deps } = makeDeps();
    const result = await processMockEmail(fbVerificationInput(), deps);
    expect(JSON.stringify(result)).not.toContain(CODE);
    expect(result.maskedCode?.length).toBe(CODE.length);
  });
});
