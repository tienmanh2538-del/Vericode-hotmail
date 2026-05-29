import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

import { hashClientState } from '@/services/microsoft/graph-subscription.service';
import type { GraphSubscriptionStatus } from '@/services/microsoft/graph-subscription.service';

// Hoisted state for the mocked prisma client. The mock factory runs before any
// `import` is evaluated, so we cannot close over a top-level `let`. Use
// `vi.hoisted` to share state between the factory and the test body.
const mockState = vi.hoisted(() => {
  const rows: Array<{
    subscriptionId: string;
    mailboxId: string;
    clientStateHash: string;
    status: 'ACTIVE' | 'EXPIRED' | 'FAILED' | 'RENEWING';
  }> = [];
  return { rows };
});

vi.mock('@/lib/prisma', () => ({
  prisma: {
    graphSubscription: {
      findUnique: async ({ where }: { where: { subscriptionId: string } }) => {
        return (
          mockState.rows.find((r) => r.subscriptionId === where.subscriptionId) ??
          null
        );
      },
    },
  },
}));

// Mock the queue module so tests never touch Redis. The TASK-026 wiring
// pushes accepted notifications onto BullMQ; in unit tests we just record
// the calls and return a fake result.
const enqueueCalls = vi.hoisted(() => ({
  list: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/services/queue/email-queue', () => ({
  enqueueMicrosoftGraphMessageJob: vi.fn(async (data: Record<string, unknown>) => {
    enqueueCalls.list.push(data);
    return {
      jobId: `microsoft-webhook:${String(data.mailboxId)}:${String(data.graphMessageId)}`,
      jobName: 'PROCESS_MICROSOFT_GRAPH_MESSAGE',
      queueName: 'email-processing',
    };
  }),
}));

const { POST } = await import('@/app/api/webhooks/microsoft/mail/route');

const ROUTE_BASE = 'http://localhost:3000/api/webhooks/microsoft/mail';

const SUBSCRIPTION_ID = 'sub-guid-route-aaaa';
const MAILBOX_ID = 'mailbox-route-1';
const CLIENT_STATE = 'route-client-state-very-secret';
const WRONG_CLIENT_STATE = 'wrong-state';
const MESSAGE_ID = 'AAMkAGNiYzAxRoute';
const RESOURCE = `users/abc/mailFolders('Inbox')/messages/${MESSAGE_ID}`;

function seedActiveSubscription(
  status: GraphSubscriptionStatus = 'ACTIVE',
): void {
  mockState.rows.length = 0;
  mockState.rows.push({
    subscriptionId: SUBSCRIPTION_ID,
    mailboxId: MAILBOX_ID,
    clientStateHash: hashClientState(CLIENT_STATE),
    status,
  });
}

function makePostNotificationRequest(body: unknown, qs?: string): NextRequest {
  const url = qs ? `${ROUTE_BASE}?${qs}` : ROUTE_BASE;
  return new NextRequest(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function buildNotification(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    subscriptionId: SUBSCRIPTION_ID,
    clientState: CLIENT_STATE,
    changeType: 'created',
    resource: RESOURCE,
    resourceData: { id: MESSAGE_ID },
    subscriptionExpirationDateTime: '2026-06-04T12:00:00.000Z',
    tenantId: 'tenant-route',
    ...overrides,
  };
}

beforeEach(() => {
  mockState.rows.length = 0;
  enqueueCalls.list.length = 0;
});

describe('POST /api/webhooks/microsoft/mail — validationToken still wins', () => {
  it('returns text/plain validationToken even with a JSON body', async () => {
    const request = makePostNotificationRequest(
      { value: [buildNotification()] },
      'validationToken=abc-token',
    );

    const response = await POST(request);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const text = await response.text();
    expect(text).toBe('abc-token');
  });
});

describe('POST /api/webhooks/microsoft/mail — invalid body shape', () => {
  it('returns 400 when value is missing', async () => {
    const response = await POST(makePostNotificationRequest({}));
    expect(response.status).toBe(400);
    const payload = (await response.json()) as { ok: boolean; error: string };
    expect(payload.ok).toBe(false);
    expect(payload.error).toContain('Invalid');
  });

  it('returns 400 when value is not an array', async () => {
    const response = await POST(makePostNotificationRequest({ value: {} }));
    expect(response.status).toBe(400);
  });

  it('returns 400 for malformed JSON body', async () => {
    const request = new NextRequest(ROUTE_BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not-json',
    });
    const response = await POST(request);
    expect(response.status).toBe(400);
  });
});

describe('POST /api/webhooks/microsoft/mail — notification routing', () => {
  it('accepts a valid created notification with matching clientState', async () => {
    seedActiveSubscription();
    const request = makePostNotificationRequest({
      value: [buildNotification()],
    });

    const response = await POST(request);
    expect(response.status).toBe(202);
    const payload = (await response.json()) as {
      ok: boolean;
      received: number;
      accepted: number;
      skipped: number;
      enqueued: number;
      enqueueFailed: number;
    };
    expect(payload).toEqual({
      ok: true,
      received: 1,
      accepted: 1,
      skipped: 0,
      enqueued: 1,
      enqueueFailed: 0,
    });
    expect(enqueueCalls.list).toHaveLength(1);
    expect(enqueueCalls.list[0]).toMatchObject({
      mailboxId: MAILBOX_ID,
      graphMessageId: MESSAGE_ID,
      clientStateValidated: true,
      source: 'microsoft-webhook',
    });
  });

  it('does not enqueue notifications that fail clientState validation', async () => {
    seedActiveSubscription();
    const request = makePostNotificationRequest({
      value: [buildNotification({ clientState: WRONG_CLIENT_STATE })],
    });

    const response = await POST(request);
    expect(response.status).toBe(202);
    const payload = (await response.json()) as {
      accepted: number;
      skipped: number;
      enqueued: number;
    };
    expect(payload.accepted).toBe(0);
    expect(payload.skipped).toBe(1);
    expect(payload.enqueued).toBe(0);
    expect(enqueueCalls.list).toHaveLength(0);
  });

  it('skips notification with wrong clientState (still 202)', async () => {
    seedActiveSubscription();
    const request = makePostNotificationRequest({
      value: [buildNotification({ clientState: WRONG_CLIENT_STATE })],
    });

    const response = await POST(request);
    expect(response.status).toBe(202);
    const payload = (await response.json()) as {
      received: number;
      accepted: number;
      skipped: number;
    };
    expect(payload.received).toBe(1);
    expect(payload.accepted).toBe(0);
    expect(payload.skipped).toBe(1);
  });

  it('skips notification missing subscriptionId', async () => {
    seedActiveSubscription();
    const request = makePostNotificationRequest({
      value: [buildNotification({ subscriptionId: undefined })],
    });

    const response = await POST(request);
    const payload = (await response.json()) as {
      received: number;
      accepted: number;
      skipped: number;
    };
    expect(payload).toMatchObject({ received: 1, accepted: 0, skipped: 1 });
  });

  it('handles a batch with mixed valid and invalid notifications', async () => {
    seedActiveSubscription();
    const request = makePostNotificationRequest({
      value: [
        buildNotification(),
        buildNotification({ clientState: WRONG_CLIENT_STATE }),
        buildNotification({ subscriptionId: undefined }),
      ],
    });

    const response = await POST(request);
    expect(response.status).toBe(202);
    const payload = (await response.json()) as {
      received: number;
      accepted: number;
      skipped: number;
    };
    expect(payload.received).toBe(3);
    expect(payload.accepted).toBe(1);
    expect(payload.skipped).toBe(2);
  });

  it('does not leak clientState in the response body', async () => {
    seedActiveSubscription();
    const request = makePostNotificationRequest({
      value: [buildNotification()],
    });

    const response = await POST(request);
    const text = await response.text();
    expect(text).not.toContain(CLIENT_STATE);
  });

  it('does not log the clientState (info/warn lines stay generic)', async () => {
    seedActiveSubscription();
    const logSpy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    try {
      const request = makePostNotificationRequest({
        value: [
          buildNotification(),
          buildNotification({ clientState: WRONG_CLIENT_STATE }),
        ],
      });
      await POST(request);

      const serializedInfo = JSON.stringify(logSpy.mock.calls);
      const serializedWarn = JSON.stringify(warnSpy.mock.calls);
      expect(serializedInfo).not.toContain(CLIENT_STATE);
      expect(serializedWarn).not.toContain(CLIENT_STATE);
      expect(serializedInfo).not.toContain(WRONG_CLIENT_STATE);
      expect(serializedWarn).not.toContain(WRONG_CLIENT_STATE);
    } finally {
      logSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
