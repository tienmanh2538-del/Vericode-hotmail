import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthUser } from '@/lib/auth/session';

// TASK-051 follow-up — the mock-email process API must enforce the per-mailbox
// customer scope on the backend (the UI dropdown already hides out-of-scope
// mailboxes, but the API must protect itself). OWNER/ADMIN process any mailbox;
// STAFF_READ_ONLY only mailboxes whose customer is assigned to them; an
// out-of-scope mailbox is indistinguishable from an unknown one (no info leak).

const {
  getCurrentUserMock,
  findUniqueMock,
  listAssignedCustomerIdsMock,
  processMockEmailMock,
} = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn<() => Promise<AuthUser | null>>(),
  findUniqueMock: vi.fn(),
  listAssignedCustomerIdsMock: vi.fn<(userId: string) => Promise<string[]>>(),
  processMockEmailMock: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => getCurrentUserMock(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: { mailbox: { findUnique: (...args: unknown[]) => findUniqueMock(...args) } },
}));

vi.mock('@/services/staff/staff-assignment.service', () => ({
  listAssignedCustomerIds: (userId: string) => listAssignedCustomerIdsMock(userId),
}));

vi.mock('@/services/email/email-processing.service', () => ({
  processMockEmail: (...args: unknown[]) => processMockEmailMock(...args),
  createDefaultEmailProcessingDependencies: () => ({}),
}));

vi.mock('@/services/email/prisma-processed-message-store', () => ({
  createPrismaProcessedMessageStore: () => ({}),
}));

vi.mock('@/services/logs/prisma-code-event-store', () => ({
  recordCodeEventToDb: vi.fn().mockResolvedValue(undefined),
}));

import { POST } from '@/app/api/mock-email/process/route';

function postRequest(): Request {
  return new Request('http://localhost/api/mock-email/process', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      mailboxEmail: 'test@example.com',
      fromEmail: 'security@facebookmail.com',
      subject: 'Your login code',
      receivedAt: '2025-01-15T08:30:00Z',
      body: 'Your Facebook verification code is 123456.',
    }),
  });
}

function sentResult() {
  return {
    status: 'SENT',
    success: true,
    mailboxEmail: 'test@example.com',
    platform: 'facebook',
    confidence: 0.99,
    maskedCode: '••••56',
    reason: undefined,
  };
}

beforeEach(() => {
  getCurrentUserMock.mockReset();
  findUniqueMock.mockReset();
  listAssignedCustomerIdsMock.mockReset();
  processMockEmailMock.mockReset();
});

describe('POST /api/mock-email/process — per-mailbox scope guard (TASK-051)', () => {
  it('rejects an unauthenticated request before any mailbox lookup', async () => {
    getCurrentUserMock.mockResolvedValue(null);

    const res = await POST(postRequest());

    expect(res.status).toBe(401);
    expect(findUniqueMock).not.toHaveBeenCalled();
    expect(processMockEmailMock).not.toHaveBeenCalled();
  });

  it('treats a mailbox outside STAFF scope exactly like an unknown mailbox', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'staff-1',
      email: 'staff@example.com',
      role: 'STAFF_READ_ONLY',
    });
    listAssignedCustomerIdsMock.mockResolvedValue(['customer-allowed']);
    findUniqueMock.mockResolvedValue({ id: 'mbx-1', customerId: 'customer-other' });

    const res = await POST(postRequest());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({
      ok: true,
      data: {
        status: 'SKIPPED_NO_TELEGRAM_MAPPING',
        success: false,
        reason: 'unknown_mailbox',
      },
    });
    // Fail closed: processing must never run for an out-of-scope mailbox.
    expect(processMockEmailMock).not.toHaveBeenCalled();
  });

  it('treats a mailbox with no customer as out of scope for STAFF', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'staff-1',
      email: 'staff@example.com',
      role: 'STAFF_READ_ONLY',
    });
    listAssignedCustomerIdsMock.mockResolvedValue(['customer-allowed']);
    findUniqueMock.mockResolvedValue({ id: 'mbx-1', customerId: null });

    const res = await POST(postRequest());

    await expect(res.json()).resolves.toMatchObject({
      data: { reason: 'unknown_mailbox' },
    });
    expect(processMockEmailMock).not.toHaveBeenCalled();
  });

  it('processes a mailbox whose customer is assigned to the STAFF viewer', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'staff-1',
      email: 'staff@example.com',
      role: 'STAFF_READ_ONLY',
    });
    listAssignedCustomerIdsMock.mockResolvedValue(['customer-allowed']);
    findUniqueMock.mockResolvedValue({ id: 'mbx-1', customerId: 'customer-allowed' });
    processMockEmailMock.mockResolvedValue(sentResult());

    const res = await POST(postRequest());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ ok: true, data: { status: 'SENT' } });
    expect(processMockEmailMock).toHaveBeenCalledTimes(1);
  });

  it('lets an OWNER process any mailbox without consulting assignments', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'owner-1',
      email: 'owner@example.com',
      role: 'OWNER',
    });
    findUniqueMock.mockResolvedValue({ id: 'mbx-1', customerId: 'customer-other' });
    processMockEmailMock.mockResolvedValue(sentResult());

    const res = await POST(postRequest());

    expect(res.status).toBe(200);
    expect(processMockEmailMock).toHaveBeenCalledTimes(1);
    // The unrestricted 'all' scope short-circuits before any assignment lookup.
    expect(listAssignedCustomerIdsMock).not.toHaveBeenCalled();
  });

  it('returns the unknown-mailbox outcome when the mailbox does not exist', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'owner-1',
      email: 'owner@example.com',
      role: 'OWNER',
    });
    findUniqueMock.mockResolvedValue(null);

    const res = await POST(postRequest());

    await expect(res.json()).resolves.toMatchObject({
      data: { reason: 'unknown_mailbox' },
    });
    expect(processMockEmailMock).not.toHaveBeenCalled();
  });
});
