import { describe, it, expect, vi } from 'vitest';

import { deriveMailboxReadiness } from '@/lib/mailboxes/mailbox-list-filter';
import { classifySubscription } from '@/services/microsoft/subscription-renewal.service';
import { createPrismaDeltaPollingRepo } from '@/services/queue/workers/delta-polling-runner';
import { createPrismaSubscriptionRenewalRepo } from '@/services/queue/workers/subscription-renewal-runner';
import {
  processGraphMessageJob,
  type GraphMessagePipelineDeps,
} from '@/services/email/graph-message-pipeline.service';

// TASK-052 — a disconnected mailbox (status DISABLED) must be inert across every
// path that could otherwise poll, renew, or relay. These tests lock in that the
// existing DISABLED gating covers all of them, so no migration/new state is
// needed for the disconnect flow to be safe.

describe('disconnected mailbox is never treated as Ready', () => {
  it('derives DISABLED (not READY) for a disconnected mailbox', () => {
    const readiness = deriveMailboxReadiness({
      status: 'DISABLED',
      customerName: 'Acme',
      ownerCustomerName: null,
      telegramMappingStatus: 'ACTIVE',
      subscriptionStatus: 'ACTIVE',
    });
    expect(readiness).toBe('DISABLED');
    expect(readiness).not.toBe('READY');
  });
});

describe('delta polling skips disconnected mailboxes', () => {
  it('only lists ACTIVE Microsoft mailboxes (DISABLED excluded)', async () => {
    const findMany = vi.fn(async (_args: unknown) => [] as unknown[]);
    const repo = createPrismaDeltaPollingRepo({
      mailbox: { findMany, update: vi.fn() },
    } as never);

    await repo.listActiveMicrosoftMailboxes();

    const args = findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(args.where).toMatchObject({ provider: 'MICROSOFT', status: 'ACTIVE' });
  });
});

describe('subscription renewal skips disconnected mailboxes', () => {
  it('classifies a DISABLED mailbox candidate as skip', () => {
    const decision = classifySubscription(
      {
        id: 'sub_1',
        mailboxId: 'mbx_1',
        subscriptionId: 'graph_sub_1',
        emailAddress: 'a@example.test',
        mailboxStatus: 'DISABLED',
        expirationDateTime: new Date('2026-01-01T00:00:00.000Z'),
      },
      new Date('2025-12-31T00:00:00.000Z'),
      24 * 60 * 60 * 1000,
    );
    expect(decision).toBe('skip');
  });

  it('excludes mailboxes with status DISABLED from the renewable candidate query', async () => {
    const findMany = vi.fn(async (_args: unknown) => [] as unknown[]);
    const repo = createPrismaSubscriptionRenewalRepo({
      graphSubscription: { findMany, update: vi.fn() },
      mailbox: { update: vi.fn() },
    } as never);

    await repo.listRenewableCandidates();

    const args = findMany.mock.calls[0][0] as { where: Record<string, unknown> };
    expect(args.where.mailbox).toEqual({ is: { status: { not: 'DISABLED' } } });
  });
});

describe('email pipeline re-checks mailbox status at job time', () => {
  it('skips a job whose mailbox was disconnected after the job was enqueued', async () => {
    const sendTelegramMessage = vi.fn();
    const getAccessTokenForMailbox = vi.fn();

    // The mailbox lookup happens at PROCESSING time and returns the now-DISABLED
    // status, even though the job may have been enqueued while it was ACTIVE.
    const deps = {
      store: {
        findByGraphMessageId: vi.fn(),
        findByInternetMessageId: vi.fn(),
      },
      mailboxes: {
        findById: vi.fn(async () => ({
          id: 'mbx_1',
          emailAddress: 'agent@example.test',
          status: 'DISABLED',
          customerName: 'Acme',
        })),
      },
      accessToken: { getAccessTokenForMailbox },
      graphMail: { fetchMessage: vi.fn() },
      telegramMapping: { findActiveMappingForMailboxId: vi.fn() },
      telegramSender: { sendTelegramMessage },
    } as unknown as GraphMessagePipelineDeps;

    const result = await processGraphMessageJob(
      { mailboxId: 'mbx_1', graphMessageId: 'graph_msg_1', source: 'webhook' },
      deps,
    );

    expect(result.status).toBe('SKIPPED_MAILBOX_NOT_ACTIVE');
    expect(result.sentToTelegram).toBe(false);
    // No token minted, no Telegram send — the credential is never used.
    expect(getAccessTokenForMailbox).not.toHaveBeenCalled();
    expect(sendTelegramMessage).not.toHaveBeenCalled();
  });
});
