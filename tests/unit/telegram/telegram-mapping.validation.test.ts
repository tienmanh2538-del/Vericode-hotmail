import { describe, it, expect } from 'vitest';
import {
  TELEGRAM_MAPPING_STATUS_VALUES,
  validateTelegramMappingInput,
} from '@/lib/validation/telegram-mapping';

const VALID_INPUT = {
  mailboxId: 'mb_1',
  telegramChatId: '-1001234567890',
  telegramGroupName: 'Client A verification',
  status: 'ACTIVE',
};

describe('validateTelegramMappingInput — success', () => {
  it('accepts a minimal valid input', () => {
    const result = validateTelegramMappingInput(VALID_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        mailboxId: 'mb_1',
        telegramChatId: '-1001234567890',
        telegramGroupName: 'Client A verification',
        status: 'ACTIVE',
      });
    }
  });

  it('trims whitespace from string fields', () => {
    const result = validateTelegramMappingInput({
      mailboxId: '  mb_1  ',
      telegramChatId: '  -1001234567890  ',
      telegramGroupName: '  My Group  ',
      status: 'ACTIVE',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.mailboxId).toBe('mb_1');
      expect(result.data.telegramChatId).toBe('-1001234567890');
      expect(result.data.telegramGroupName).toBe('My Group');
    }
  });

  it('defaults status to ACTIVE when missing', () => {
    const result = validateTelegramMappingInput({
      ...VALID_INPUT,
      status: undefined,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.status).toBe('ACTIVE');
  });

  it('accepts every documented status value', () => {
    for (const status of TELEGRAM_MAPPING_STATUS_VALUES) {
      const result = validateTelegramMappingInput({ ...VALID_INPUT, status });
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.data.status).toBe(status);
    }
  });

  it('accepts @channel handle as chat id', () => {
    const result = validateTelegramMappingInput({
      ...VALID_INPUT,
      telegramChatId: '@my_channel',
    });
    expect(result.ok).toBe(true);
  });
});

describe('validateTelegramMappingInput — failure', () => {
  it('rejects missing mailboxId', () => {
    const result = validateTelegramMappingInput({
      ...VALID_INPUT,
      mailboxId: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.mailboxId).toBeTruthy();
  });

  it('rejects missing telegramChatId', () => {
    const result = validateTelegramMappingInput({
      ...VALID_INPUT,
      telegramChatId: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.telegramChatId).toBeTruthy();
  });

  it('rejects missing telegramGroupName', () => {
    const result = validateTelegramMappingInput({
      ...VALID_INPUT,
      telegramGroupName: '',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.telegramGroupName).toBeTruthy();
  });

  it('rejects telegramChatId that looks like a bot token', () => {
    const result = validateTelegramMappingInput({
      ...VALID_INPUT,
      telegramChatId: '123456789:AAAAAAAAAAAAAAAAAA',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.telegramChatId).toBeTruthy();
  });

  it('rejects garbage chat id', () => {
    const result = validateTelegramMappingInput({
      ...VALID_INPUT,
      telegramChatId: 'not-a-chat-id',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.telegramChatId).toBeTruthy();
  });

  it('rejects telegramGroupName containing the word "token"', () => {
    const result = validateTelegramMappingInput({
      ...VALID_INPUT,
      telegramGroupName: 'Bot Token leak',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.telegramGroupName).toBeTruthy();
  });

  it('rejects unknown status', () => {
    const result = validateTelegramMappingInput({
      ...VALID_INPUT,
      status: 'PAUSED',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.status).toBeTruthy();
  });

  it('collects multiple errors at once', () => {
    const result = validateTelegramMappingInput({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.mailboxId).toBeTruthy();
      expect(result.errors.telegramChatId).toBeTruthy();
      expect(result.errors.telegramGroupName).toBeTruthy();
    }
  });
});
