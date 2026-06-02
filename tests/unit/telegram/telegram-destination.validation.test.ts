import { describe, it, expect } from 'vitest';
import { validateTelegramDestinationInput } from '@/lib/validation/telegram-destination';
import { validateTelegramDestinationMappingInput } from '@/lib/validation/telegram-mapping';

const VALID_DESTINATION = {
  customerId: 'cu_1',
  displayName: 'Client A group',
  telegramGroupName: 'Client A verification',
  telegramChatId: '-1001234567890',
  status: 'ACTIVE',
};

describe('validateTelegramDestinationInput — success', () => {
  it('accepts a minimal group destination', () => {
    const result = validateTelegramDestinationInput(VALID_DESTINATION);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        customerId: 'cu_1',
        displayName: 'Client A group',
        telegramGroupName: 'Client A verification',
        telegramChatId: '-1001234567890',
        telegramThreadId: null,
        telegramTopicName: null,
        status: 'ACTIVE',
      });
    }
  });

  it('accepts an optional topic id and topic name', () => {
    const result = validateTelegramDestinationInput({
      ...VALID_DESTINATION,
      telegramThreadId: '42',
      telegramTopicName: 'Codes',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.telegramThreadId).toBe('42');
      expect(result.data.telegramTopicName).toBe('Codes');
    }
  });
});

describe('validateTelegramDestinationInput — failure', () => {
  it('rejects a missing customer', () => {
    const result = validateTelegramDestinationInput({ ...VALID_DESTINATION, customerId: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.customerId).toBeTruthy();
  });

  it('rejects a missing display name', () => {
    const result = validateTelegramDestinationInput({ ...VALID_DESTINATION, displayName: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.displayName).toBeTruthy();
  });

  it('rejects a chat id that looks like a bot token', () => {
    const result = validateTelegramDestinationInput({
      ...VALID_DESTINATION,
      telegramChatId: '123456789:AAAAAAAAAAAAAAAAAA',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.telegramChatId).toBeTruthy();
  });

  it('rejects a display name that leaks a secret', () => {
    const result = validateTelegramDestinationInput({
      ...VALID_DESTINATION,
      displayName: 'bot token group',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.displayName).toBeTruthy();
  });

  it('rejects a non-numeric topic id', () => {
    const result = validateTelegramDestinationInput({
      ...VALID_DESTINATION,
      telegramThreadId: 'general',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.telegramThreadId).toBeTruthy();
  });
});

describe('validateTelegramDestinationMappingInput', () => {
  it('accepts a mailbox + destination + status', () => {
    const result = validateTelegramDestinationMappingInput({
      mailboxId: 'mb_1',
      destinationId: 'dest_1',
      status: 'ACTIVE',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data).toEqual({
        mailboxId: 'mb_1',
        destinationId: 'dest_1',
        status: 'ACTIVE',
      });
    }
  });

  it('defaults status to ACTIVE when missing', () => {
    const result = validateTelegramDestinationMappingInput({
      mailboxId: 'mb_1',
      destinationId: 'dest_1',
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.status).toBe('ACTIVE');
  });

  it('rejects a missing destination', () => {
    const result = validateTelegramDestinationMappingInput({ mailboxId: 'mb_1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.destinationId).toBeTruthy();
  });

  it('rejects a missing mailbox', () => {
    const result = validateTelegramDestinationMappingInput({ destinationId: 'dest_1' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.mailboxId).toBeTruthy();
  });
});
