import { describe, it, expect } from 'vitest';

import {
  buildEmailJobId,
  getDefaultEmailJobOptions,
  InvalidEmailWebhookJobDataError,
  validateEmailWebhookJobData,
} from '@/services/queue/email-job-options';
import {
  EMAIL_WEBHOOK_JOB_SOURCE,
  type EmailWebhookJobData,
} from '@/services/queue/email-job.types';

function makeData(
  overrides: Partial<EmailWebhookJobData> = {},
): EmailWebhookJobData {
  return {
    mailboxId: 'mailbox-1',
    graphMessageId: 'AAMkAGNiYzAxNjAtY2Y0ZS00OWQ0',
    subscriptionId: 'sub-1',
    resource: "users/abc/mailFolders('Inbox')/messages/AAMkAG",
    changeType: 'created',
    tenantId: 'tenant-1',
    clientStateValidated: true,
    queuedAt: '2026-05-29T00:00:00.000Z',
    source: EMAIL_WEBHOOK_JOB_SOURCE,
    ...overrides,
  };
}

describe('buildEmailJobId', () => {
  it('produces the same jobId for identical mailboxId+graphMessageId', () => {
    const data1 = makeData();
    const data2 = makeData({
      // changing non-identity fields must not affect the jobId
      subscriptionId: 'sub-2',
      resource: 'different-resource',
      queuedAt: '2099-01-01T00:00:00.000Z',
    });
    expect(buildEmailJobId(data1)).toBe(buildEmailJobId(data2));
  });

  it('produces a different jobId when graphMessageId changes', () => {
    expect(buildEmailJobId(makeData())).not.toBe(
      buildEmailJobId(makeData({ graphMessageId: 'different-message' })),
    );
  });

  it('produces a different jobId when mailboxId changes', () => {
    expect(buildEmailJobId(makeData())).not.toBe(
      buildEmailJobId(makeData({ mailboxId: 'other-mailbox' })),
    );
  });

  it('uses the microsoft-webhook prefix to namespace the jobId', () => {
    const id = buildEmailJobId(makeData());
    expect(id.startsWith('microsoft-webhook:')).toBe(true);
    expect(id).toContain('mailbox-1');
    expect(id).toContain('AAMkAGNiYzAxNjAtY2Y0ZS00OWQ0');
  });
});

describe('getDefaultEmailJobOptions', () => {
  it('includes a deterministic jobId, retry attempts, and backoff', () => {
    const opts = getDefaultEmailJobOptions(makeData());
    expect(opts.jobId).toBe(buildEmailJobId(makeData()));
    expect(opts.attempts).toBe(3);
    expect(opts.backoff).toEqual({ type: 'exponential', delay: 5_000 });
  });

  it('keeps completed jobs short-term and failed jobs longer for debugging', () => {
    const opts = getDefaultEmailJobOptions(makeData());
    expect(opts.removeOnComplete).toEqual({ age: 86_400, count: 1_000 });
    expect(opts.removeOnFail).toEqual({ age: 604_800, count: 5_000 });
  });
});

describe('validateEmailWebhookJobData', () => {
  it('throws when mailboxId is missing', () => {
    const data = makeData({ mailboxId: '' });
    expect(() => validateEmailWebhookJobData(data)).toThrow(
      InvalidEmailWebhookJobDataError,
    );
  });

  it('throws when graphMessageId is missing', () => {
    const data = makeData({ graphMessageId: '' });
    expect(() => validateEmailWebhookJobData(data)).toThrow(
      InvalidEmailWebhookJobDataError,
    );
  });

  it('throws when clientStateValidated is not true', () => {
    // @ts-expect-error — deliberately invalid for the test
    const data = makeData({ clientStateValidated: false });
    expect(() => validateEmailWebhookJobData(data)).toThrow(
      InvalidEmailWebhookJobDataError,
    );
  });

  it('throws when source is not microsoft-webhook', () => {
    // @ts-expect-error — deliberately invalid for the test
    const data = makeData({ source: 'unknown' });
    expect(() => validateEmailWebhookJobData(data)).toThrow(
      InvalidEmailWebhookJobDataError,
    );
  });

  it.each([
    'accessToken',
    'refreshToken',
    'clientSecret',
    'telegramBotToken',
    'verificationCode',
    'password',
    'body',
    'emailBody',
  ])('throws when payload contains forbidden key "%s"', (forbidden) => {
    const data = { ...makeData(), [forbidden]: 'leaked-value' };
    expect(() => validateEmailWebhookJobData(data)).toThrow(
      InvalidEmailWebhookJobDataError,
    );
  });

  it('accepts a minimally valid payload', () => {
    const data = makeData({
      subscriptionId: undefined,
      resource: undefined,
      changeType: undefined,
      tenantId: undefined,
    });
    expect(() => validateEmailWebhookJobData(data)).not.toThrow();
  });
});
