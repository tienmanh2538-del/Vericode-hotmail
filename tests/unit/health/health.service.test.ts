import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mailboxFindMany, processedGroupBy, processedAggregate, subscriptionAggregate } =
  vi.hoisted(() => ({
    mailboxFindMany: vi.fn(),
    processedGroupBy: vi.fn(),
    processedAggregate: vi.fn(),
    subscriptionAggregate: vi.fn(),
  }));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    mailbox: { findMany: mailboxFindMany },
    processedMessage: { groupBy: processedGroupBy, aggregate: processedAggregate },
    graphSubscription: { aggregate: subscriptionAggregate },
  },
}));

import {
  aggregateOverallHealth,
  buildCustomerWorkload,
  classifyDeltaPolling,
  classifyEmailWorkerWiring,
  classifyMailboxHealth,
  classifySubscriptionRenewal,
  classifyTelegramReliability,
  classifyWebhookHealth,
  gatherEmailWorkerWiringEvidence,
  loadHealthDashboard,
  SUBSCRIPTION_EXPIRING_SOON_MS,
  DELTA_POLLING_STALE_MS,
  TELEGRAM_FAILURE_CRITICAL_COUNT,
} from '@/services/health/health.service';
import type { CustomerScope } from '@/lib/auth/access-scope';
import type { MailboxHealthRow } from '@/services/health/health.types';

const NOW = new Date('2026-05-29T12:00:00.000Z');

// OWNER/ADMIN scope — sees everything. STAFF scope is { kind: 'assigned', … }.
const ALL_SCOPE: CustomerScope = { kind: 'all' };

function baseMailboxInput(
  overrides: Partial<Parameters<typeof classifyMailboxHealth>[0]> = {},
): Parameters<typeof classifyMailboxHealth>[0] {
  return {
    status: 'ACTIVE',
    provider: 'MICROSOFT',
    hasActiveTelegramMapping: true,
    subscriptionStatus: 'ACTIVE',
    subscriptionExpiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
    lastPolledAt: new Date(NOW.getTime() - 60_000),
    deltaLastErrorAt: null,
    recentTelegramFailureCount: 0,
    now: NOW,
    ...overrides,
  };
}

describe('classifyMailboxHealth', () => {
  it('returns OK for a fully healthy active mailbox', () => {
    expect(classifyMailboxHealth(baseMailboxInput()).level).toBe('OK');
  });

  it('is CRITICAL when reconnect is required', () => {
    const result = classifyMailboxHealth(
      baseMailboxInput({ status: 'RECONNECT_REQUIRED' }),
    );
    expect(result.level).toBe('CRITICAL');
    expect(result.reasons).toContain('Reconnect required');
  });

  it('is CRITICAL when the subscription has already expired', () => {
    const result = classifyMailboxHealth(
      baseMailboxInput({
        subscriptionStatus: 'ACTIVE',
        subscriptionExpiresAt: new Date(NOW.getTime() - 1000),
      }),
    );
    expect(result.level).toBe('CRITICAL');
  });

  it('is CRITICAL when there are recent Telegram failures', () => {
    const result = classifyMailboxHealth(
      baseMailboxInput({ recentTelegramFailureCount: 2 }),
    );
    expect(result.level).toBe('CRITICAL');
  });

  it('is WARNING when the subscription expires within 24h', () => {
    const result = classifyMailboxHealth(
      baseMailboxInput({
        subscriptionExpiresAt: new Date(
          NOW.getTime() + SUBSCRIPTION_EXPIRING_SOON_MS - 1000,
        ),
      }),
    );
    expect(result.level).toBe('WARNING');
    expect(result.reasons).toContain('Subscription expiring within 24h');
  });

  it('is WARNING when there is no active Telegram mapping', () => {
    const result = classifyMailboxHealth(
      baseMailboxInput({ hasActiveTelegramMapping: false }),
    );
    expect(result.level).toBe('WARNING');
  });

  it('is WARNING when polling is stale for a Microsoft mailbox', () => {
    const result = classifyMailboxHealth(
      baseMailboxInput({
        lastPolledAt: new Date(NOW.getTime() - DELTA_POLLING_STALE_MS - 1000),
      }),
    );
    expect(result.level).toBe('WARNING');
    expect(result.reasons).toContain('Delta polling stale');
  });

  it('does not flag a MOCK mailbox for stale polling', () => {
    const result = classifyMailboxHealth(
      baseMailboxInput({
        provider: 'MOCK',
        subscriptionStatus: null,
        subscriptionExpiresAt: null,
        lastPolledAt: null,
      }),
    );
    expect(result.level).toBe('OK');
  });

  it('treats DISABLED as UNKNOWN, not a fault', () => {
    const result = classifyMailboxHealth(baseMailboxInput({ status: 'DISABLED' }));
    expect(result.level).toBe('UNKNOWN');
  });
});

describe('classifyEmailWorkerWiring', () => {
  it('returns CRITICAL when no production entrypoint exists', () => {
    const result = classifyEmailWorkerWiring({
      canInspect: true,
      hasNpmScript: false,
      hasRunnerFile: false,
    });
    expect(result.status).toBe('CRITICAL');
  });

  it('returns WARNING when wiring is only partially present', () => {
    expect(
      classifyEmailWorkerWiring({
        canInspect: true,
        hasNpmScript: true,
        hasRunnerFile: false,
      }).status,
    ).toBe('WARNING');
  });

  it('returns PASS only with both npm script and runner file', () => {
    expect(
      classifyEmailWorkerWiring({
        canInspect: true,
        hasNpmScript: true,
        hasRunnerFile: true,
      }).status,
    ).toBe('PASS');
  });

  it('returns UNKNOWN when wiring cannot be inspected', () => {
    expect(
      classifyEmailWorkerWiring({
        canInspect: false,
        hasNpmScript: false,
        hasRunnerFile: false,
      }).status,
    ).toBe('UNKNOWN');
  });
});

describe('gatherEmailWorkerWiringEvidence (real repo)', () => {
  it('reports the production entrypoint now exists (TASK-040)', () => {
    // TASK-040 ground truth: the worker:email npm script and
    // scripts/run-email-worker.ts runner are now present and wired to the real
    // Graph message pipeline.
    const evidence = gatherEmailWorkerWiringEvidence();
    expect(evidence.canInspect).toBe(true);
    expect(evidence.hasNpmScript).toBe(true);
    expect(evidence.hasRunnerFile).toBe(true);
    expect(classifyEmailWorkerWiring(evidence).status).toBe('PASS');
  });

  it('returns canInspect=false for a non-existent root', () => {
    const evidence = gatherEmailWorkerWiringEvidence(
      '/this/path/should/not/exist/anywhere',
    );
    expect(evidence.canInspect).toBe(false);
  });
});

describe('classifySubscriptionRenewal', () => {
  it('is UNKNOWN with no subscriptions', () => {
    expect(classifySubscriptionRenewal([], NOW).status).toBe('UNKNOWN');
  });

  it('is CRITICAL when a subscription is expired', () => {
    expect(
      classifySubscriptionRenewal(
        [{ status: 'ACTIVE', expiresAt: new Date(NOW.getTime() - 1000) }],
        NOW,
      ).status,
    ).toBe('CRITICAL');
  });

  it('is WARNING when expiring within 24h', () => {
    expect(
      classifySubscriptionRenewal(
        [
          {
            status: 'ACTIVE',
            expiresAt: new Date(NOW.getTime() + SUBSCRIPTION_EXPIRING_SOON_MS - 1000),
          },
        ],
        NOW,
      ).status,
    ).toBe('WARNING');
  });

  it('is PASS when all are safely active', () => {
    expect(
      classifySubscriptionRenewal(
        [
          {
            status: 'ACTIVE',
            expiresAt: new Date(NOW.getTime() + 5 * 24 * 60 * 60 * 1000),
          },
        ],
        NOW,
      ).status,
    ).toBe('PASS');
  });
});

describe('classifyDeltaPolling', () => {
  it('is UNKNOWN when there are no Microsoft mailboxes', () => {
    expect(
      classifyDeltaPolling([{ provider: 'MOCK', lastPolledAt: null }], NOW).status,
    ).toBe('UNKNOWN');
  });

  it('is WARNING when no Microsoft mailbox was ever polled', () => {
    expect(
      classifyDeltaPolling([{ provider: 'MICROSOFT', lastPolledAt: null }], NOW)
        .status,
    ).toBe('WARNING');
  });

  it('is PASS when at least one mailbox polled recently', () => {
    expect(
      classifyDeltaPolling(
        [{ provider: 'MICROSOFT', lastPolledAt: new Date(NOW.getTime() - 1000) }],
        NOW,
      ).status,
    ).toBe('PASS');
  });

  it('is WARNING when all Microsoft mailboxes are overdue', () => {
    expect(
      classifyDeltaPolling(
        [
          {
            provider: 'MICROSOFT',
            lastPolledAt: new Date(NOW.getTime() - DELTA_POLLING_STALE_MS - 1000),
          },
        ],
        NOW,
      ).status,
    ).toBe('WARNING');
  });
});

describe('classifyTelegramReliability', () => {
  it('is PASS with no failures and prior sends', () => {
    expect(classifyTelegramReliability(0, true).status).toBe('PASS');
  });

  it('is UNKNOWN with no failures and no sends', () => {
    expect(classifyTelegramReliability(0, false).status).toBe('UNKNOWN');
  });

  it('is WARNING for a small number of failures', () => {
    expect(classifyTelegramReliability(1, true).status).toBe('WARNING');
  });

  it('is CRITICAL once failures hit the threshold', () => {
    expect(
      classifyTelegramReliability(TELEGRAM_FAILURE_CRITICAL_COUNT, true).status,
    ).toBe('CRITICAL');
  });
});

describe('classifyWebhookHealth', () => {
  it('is CRITICAL when a mailbox is webhook-failed', () => {
    expect(classifyWebhookHealth(['ACTIVE', 'WEBHOOK_FAILED']).status).toBe(
      'CRITICAL',
    );
  });

  it('is UNKNOWN (never a fake PASS) when nothing is failed', () => {
    expect(classifyWebhookHealth(['ACTIVE']).status).toBe('UNKNOWN');
  });
});

describe('aggregateOverallHealth', () => {
  it('returns CRITICAL when any input is critical', () => {
    expect(aggregateOverallHealth(['OK'], ['CRITICAL'])).toBe('CRITICAL');
  });

  it('returns WARNING when worst is a warning', () => {
    expect(aggregateOverallHealth(['OK', 'WARNING'], ['PASS'])).toBe('WARNING');
  });

  it('returns OK when only OK/PASS/UNKNOWN are present', () => {
    expect(aggregateOverallHealth(['OK'], ['UNKNOWN'])).toBe('OK');
  });

  it('returns UNKNOWN when everything is unknown', () => {
    expect(aggregateOverallHealth(['UNKNOWN'], ['UNKNOWN'])).toBe('UNKNOWN');
  });
});

describe('loadHealthDashboard', () => {
  beforeEach(() => {
    mailboxFindMany.mockReset();
    processedGroupBy.mockReset();
    processedAggregate.mockReset();
    subscriptionAggregate.mockReset();
    // TASK-040 added two runtime "last run" aggregates; default them to empty.
    processedAggregate.mockResolvedValue({ _max: { createdAt: null } });
    subscriptionAggregate.mockResolvedValue({ _max: { lastRenewedAt: null } });
  });

  it('returns a safe error result when the DB read fails', async () => {
    mailboxFindMany.mockRejectedValue(new Error('connection refused at db://secret'));
    processedGroupBy.mockResolvedValue([]);

    const result = await loadHealthDashboard(ALL_SCOPE, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toBe('Không thể tải health dashboard lúc này.');
      // The raw DB error (and any embedded connection string) must not leak.
      expect(result.message).not.toContain('secret');
    }
  });

  it('returns an empty dashboard (no crash) when there are no mailboxes', async () => {
    mailboxFindMany.mockResolvedValue([]);
    processedGroupBy.mockResolvedValue([]);

    const result = await loadHealthDashboard(ALL_SCOPE, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.overview.totalMailboxes).toBe(0);
      expect(result.data.mailboxes).toHaveLength(0);
      // Operational checks always render, even with no mailboxes.
      expect(result.data.operationalChecks.length).toBeGreaterThan(0);
      const worker = result.data.operationalChecks.find(
        (c) => c.id === 'EMAIL_WORKER_PIPELINE',
      );
      // TASK-040 wired the production entrypoint, so this is now PASS.
      expect(worker?.status).toBe('PASS');
    }
  });

  it('uses a whitelisted select that excludes sensitive fields', async () => {
    mailboxFindMany.mockResolvedValue([]);
    processedGroupBy.mockResolvedValue([]);

    await loadHealthDashboard(ALL_SCOPE, NOW);

    const call = mailboxFindMany.mock.calls[0]?.[0];
    expect(call).toBeDefined();
    expect(call.select.encryptedRefreshToken).toBeUndefined();
    expect(call.select.microsoftUserId).toBeUndefined();
    expect(call.select.graphSubscriptions.select.clientStateHash).toBeUndefined();
    expect(call.select.graphSubscriptions.select.subscriptionId).toBeUndefined();
    // OWNER/ADMIN scope is unrestricted — no customer filter is applied.
    expect(call.where).toBeUndefined();
  });

  it('restricts the mailbox query to the assigned customers for STAFF', async () => {
    mailboxFindMany.mockResolvedValue([]);
    processedGroupBy.mockResolvedValue([]);

    const staffScope: CustomerScope = {
      kind: 'assigned',
      customerIds: ['cust_1', 'cust_2'],
    };
    await loadHealthDashboard(staffScope, NOW);

    const call = mailboxFindMany.mock.calls[0]?.[0];
    expect(call.where).toEqual({ customerId: { in: ['cust_1', 'cust_2'] } });
  });

  it('fails closed for a STAFF viewer with no assignment (no global leak)', async () => {
    mailboxFindMany.mockResolvedValue([]);
    processedGroupBy.mockResolvedValue([]);

    const emptyScope: CustomerScope = { kind: 'assigned', customerIds: [] };
    const result = await loadHealthDashboard(emptyScope, NOW);

    const call = mailboxFindMany.mock.calls[0]?.[0];
    // An empty assigned scope filters to `in: []` → zero rows.
    expect(call.where).toEqual({ customerId: { in: [] } });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.isUnrestricted).toBe(false);
      expect(result.data.overview.totalMailboxes).toBe(0);
      // System-wide operational checks are never exposed to staff.
      expect(result.data.operationalChecks).toHaveLength(0);
    }
  });

  it('omits global operational checks for an assigned (STAFF) scope', async () => {
    mailboxFindMany.mockResolvedValue([]);
    processedGroupBy.mockResolvedValue([]);

    const staffScope: CustomerScope = {
      kind: 'assigned',
      customerIds: ['cust_1'],
    };
    const result = await loadHealthDashboard(staffScope, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.operationalChecks).toHaveLength(0);
      expect(result.data.isUnrestricted).toBe(false);
    }
  });

  it('builds rows and sanitizes the last error message', async () => {
    mailboxFindMany.mockResolvedValue([
      {
        id: 'mbx_1',
        emailAddress: 'a@example.com',
        provider: 'MICROSOFT',
        status: 'ACTIVE',
        ownerCustomerName: 'Owner A',
        tokenLastRefreshedAt: NOW,
        lastSuccessfulSyncAt: NOW,
        deltaLastPolledAt: new Date(NOW.getTime() - 1000),
        deltaLastErrorAt: null,
        deltaLastErrorMessage: 'failed token=abcdef1234567890abcdef1234567890',
        customer: { name: 'Customer A' },
        telegramMappings: [{ status: 'ACTIVE' }],
        graphSubscriptions: [
          {
            status: 'ACTIVE',
            expirationDateTime: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
          },
        ],
      },
    ]);
    processedGroupBy
      .mockResolvedValueOnce([
        { mailboxId: 'mbx_1', _max: { sentToTelegramAt: NOW } },
      ])
      .mockResolvedValueOnce([]);

    const result = await loadHealthDashboard(ALL_SCOPE, NOW);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const row = result.data.mailboxes[0];
      expect(row.level).toBe('OK');
      expect(row.readiness).toBe('READY');
      expect(row.customerName).toBe('Customer A');
      expect(row.lastCodeSentAt?.getTime()).toBe(NOW.getTime());
      // Redaction kicked in — the raw token is gone.
      expect(row.lastErrorShort).not.toContain('abcdef1234567890');
      expect(row.lastErrorShort).toContain('[REDACTED]');
    }
  });
});

describe('buildCustomerWorkload', () => {
  function row(overrides: Partial<MailboxHealthRow>): MailboxHealthRow {
    return {
      id: 'mbx',
      customerId: 'cust_1',
      emailAddress: 'a@example.com',
      ownerCustomerName: 'Customer A',
      customerName: 'Customer A',
      mailboxStatus: 'ACTIVE',
      provider: 'MICROSOFT',
      tokenStatus: 'OK',
      telegramMappingStatus: 'ACTIVE',
      subscriptionStatus: 'ACTIVE',
      subscriptionExpiresAt: new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000),
      lastSuccessfulSyncAt: NOW,
      lastPolledAt: NOW,
      lastCodeSentAt: NOW,
      readiness: 'READY',
      recentTelegramFailureCount: 0,
      lastErrorShort: null,
      level: 'OK',
      reasons: [],
      ...overrides,
    };
  }

  it('groups mailboxes by customer and counts readiness buckets', () => {
    const workload = buildCustomerWorkload([
      row({ id: 'm1', customerId: 'cust_1', readiness: 'READY' }),
      row({ id: 'm2', customerId: 'cust_1', readiness: 'NEEDS_MAPPING' }),
      row({ id: 'm3', customerId: 'cust_1', readiness: 'TOKEN_ISSUE' }),
    ]);

    expect(workload).toHaveLength(1);
    const group = workload[0];
    expect(group.customerId).toBe('cust_1');
    expect(group.totalMailboxes).toBe(3);
    expect(group.readyMailboxes).toBe(1);
    expect(group.needsMapping).toBe(1);
    expect(group.errorOrDisconnected).toBe(1);
  });

  it('counts a mailbox sharing a reusable destination as Ready (valid)', () => {
    // Two mailboxes of the same customer each map to the SAME reusable
    // destination; both have their own ACTIVE mapping, so both are READY.
    const workload = buildCustomerWorkload([
      row({ id: 'm1', telegramMappingStatus: 'ACTIVE', readiness: 'READY' }),
      row({ id: 'm2', telegramMappingStatus: 'ACTIVE', readiness: 'READY' }),
    ]);

    expect(workload[0].readyMailboxes).toBe(2);
    expect(workload[0].needsMapping).toBe(0);
  });

  it('never counts a disconnected mailbox as Ready', () => {
    const workload = buildCustomerWorkload([
      row({ id: 'm1', mailboxStatus: 'RECONNECT_REQUIRED', readiness: 'TOKEN_ISSUE' }),
    ]);

    expect(workload[0].readyMailboxes).toBe(0);
    expect(workload[0].errorOrDisconnected).toBe(1);
  });

  it('sums recent Telegram failures into the recent-issue count', () => {
    const workload = buildCustomerWorkload([
      row({ id: 'm1', recentTelegramFailureCount: 2 }),
      row({ id: 'm2', recentTelegramFailureCount: 3 }),
    ]);

    expect(workload[0].recentIssueCount).toBe(5);
  });

  it('separates customers and sorts Unassigned last', () => {
    const workload = buildCustomerWorkload([
      row({ id: 'm1', customerId: 'cust_b', customerName: 'Beta' }),
      row({
        id: 'm2',
        customerId: null,
        customerName: null,
        ownerCustomerName: null,
      }),
      row({ id: 'm3', customerId: 'cust_a', customerName: 'Alpha' }),
    ]);

    expect(workload.map((g) => g.customerName)).toEqual([
      'Alpha',
      'Beta',
      'Unassigned',
    ]);
  });
});
