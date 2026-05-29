import { describe, it, expect } from 'vitest';

import {
  EMAIL_QUEUE_JOB_NAMES,
  EMAIL_QUEUE_NAME,
  EMAIL_WEBHOOK_JOB_SOURCE,
  FORBIDDEN_JOB_DATA_KEYS,
  type EmailWebhookJobData,
} from '@/services/queue/email-job.types';

describe('email-job.types — constants', () => {
  it('exposes the expected default queue name', () => {
    expect(EMAIL_QUEUE_NAME).toBe('email-processing');
  });

  it('exposes PROCESS_MICROSOFT_GRAPH_MESSAGE job name only', () => {
    expect(EMAIL_QUEUE_JOB_NAMES).toEqual({
      PROCESS_MICROSOFT_GRAPH_MESSAGE: 'PROCESS_MICROSOFT_GRAPH_MESSAGE',
    });
  });

  it('exposes microsoft-webhook as the source literal', () => {
    expect(EMAIL_WEBHOOK_JOB_SOURCE).toBe('microsoft-webhook');
  });

  it('lists forbidden sensitive keys', () => {
    for (const forbidden of [
      'accessToken',
      'refreshToken',
      'clientSecret',
      'telegramBotToken',
      'verificationCode',
      'password',
      'body',
    ]) {
      expect(FORBIDDEN_JOB_DATA_KEYS).toContain(forbidden);
    }
  });
});

describe('email-job.types — EmailWebhookJobData shape (compile-only)', () => {
  it('compiles with the documented payload', () => {
    const data: EmailWebhookJobData = {
      mailboxId: 'mailbox-1',
      graphMessageId: 'message-1',
      subscriptionId: 'sub-1',
      resource: "users/abc/mailFolders('Inbox')/messages/message-1",
      changeType: 'created',
      tenantId: 'tenant-1',
      clientStateValidated: true,
      queuedAt: '2026-05-29T00:00:00.000Z',
      source: EMAIL_WEBHOOK_JOB_SOURCE,
    };
    expect(data.clientStateValidated).toBe(true);
    expect(data.source).toBe('microsoft-webhook');
  });
});
