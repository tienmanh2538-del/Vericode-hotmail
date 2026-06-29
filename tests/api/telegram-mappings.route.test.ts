import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthUser } from '@/lib/auth/session';

// TASK-065 — these tests drive the legacy REST mapping routes end-to-end (real
// service, mocked Prisma) to prove customer isolation is enforced at the HTTP
// boundary: a mailbox of customer A can never be mapped onto a destination of
// customer B, even for OWNER/ADMIN, and raw telegramChatId is no longer trusted.

const {
  getCurrentUserMock,
  mailboxFindUnique,
  destinationFindUnique,
  mappingFindFirst,
  mappingFindUnique,
  mappingCreate,
  mappingUpdate,
  mappingDelete,
} = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn<() => Promise<AuthUser | null>>(),
  mailboxFindUnique: vi.fn(),
  destinationFindUnique: vi.fn(),
  mappingFindFirst: vi.fn(),
  mappingFindUnique: vi.fn(),
  mappingCreate: vi.fn(),
  mappingUpdate: vi.fn(),
  mappingDelete: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => getCurrentUserMock(),
}));

vi.mock('@/lib/prisma', () => ({
  prisma: {
    mailbox: { findUnique: mailboxFindUnique },
    telegramDestination: { findUnique: destinationFindUnique },
    telegramMapping: {
      findFirst: mappingFindFirst,
      findUnique: mappingFindUnique,
      create: mappingCreate,
      update: mappingUpdate,
      delete: mappingDelete,
    },
  },
}));

import { POST } from '@/app/api/telegram/mappings/route';
import { PATCH, DELETE } from '@/app/api/telegram/mappings/[id]/route';

const ADMIN: AuthUser = { id: 'admin-1', email: 'admin@example.com', role: 'ADMIN' };
const OWNER: AuthUser = { id: 'owner-1', email: 'owner@example.com', role: 'OWNER' };
const STAFF: AuthUser = {
  id: 'staff-1',
  email: 'staff@example.com',
  role: 'STAFF_READ_ONLY',
};

const ACTIVE_DESTINATION_CU1 = {
  id: 'dest_1',
  customerId: 'cu_1',
  status: 'ACTIVE',
  telegramChatId: '-1001234567890',
  telegramGroupName: 'Client A group',
  telegramThreadId: '42',
  telegramTopicName: 'Codes',
};

const CREATED_ROW = {
  id: 'tm_1',
  mailboxId: 'mb_1',
  telegramChatId: '-1001234567890',
  telegramGroupName: 'Client A group',
  telegramThreadId: '42',
  telegramTopicName: 'Codes',
  status: 'ACTIVE',
  destinationId: 'dest_1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-02T00:00:00.000Z'),
  mailbox: {
    emailAddress: 'client-a@hotmail.com',
    customerId: 'cu_1',
    customer: { id: 'cu_1', name: 'Client A' },
  },
  destination: { ...ACTIVE_DESTINATION_CU1, displayName: 'Client A group' },
};

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/telegram/mappings', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function patchRequest(body: unknown): Request {
  return new Request('http://localhost/api/telegram/mappings/tm_1', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function disableRequest(): Request {
  return new Request('http://localhost/api/telegram/mappings/tm_1?action=disable', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
  });
}

function deleteRequest(): Request {
  return new Request('http://localhost/api/telegram/mappings/tm_1', {
    method: 'DELETE',
  });
}

beforeEach(() => {
  getCurrentUserMock.mockReset();
  mailboxFindUnique.mockReset();
  destinationFindUnique.mockReset();
  mappingFindFirst.mockReset();
  mappingFindUnique.mockReset();
  mappingCreate.mockReset();
  mappingUpdate.mockReset();
  mappingDelete.mockReset();
});

describe('POST /api/telegram/mappings — customer isolation (TASK-065)', () => {
  it('returns 403 for STAFF_READ_ONLY without writing anything', async () => {
    getCurrentUserMock.mockResolvedValue(STAFF);

    const res = await POST(
      postRequest({ mailboxId: 'mb_1', destinationId: 'dest_1', status: 'ACTIVE' }),
    );

    expect(res.status).toBe(403);
    expect(mailboxFindUnique).not.toHaveBeenCalled();
    expect(mappingCreate).not.toHaveBeenCalled();
  });

  it('rejects mapping a customer-A mailbox onto a customer-B destination (409)', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN);
    mailboxFindUnique.mockResolvedValue({ id: 'mb_1', customerId: 'cu_1' });
    destinationFindUnique.mockResolvedValue({
      ...ACTIVE_DESTINATION_CU1,
      customerId: 'cu_other',
    });

    const res = await POST(
      postRequest({ mailboxId: 'mb_1', destinationId: 'dest_1', status: 'ACTIVE' }),
    );

    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.fields).toHaveProperty('destinationId');
    expect(mappingCreate).not.toHaveBeenCalled();
  });

  it('blocks OWNER too — admin role does not bypass customer isolation', async () => {
    getCurrentUserMock.mockResolvedValue(OWNER);
    mailboxFindUnique.mockResolvedValue({ id: 'mb_1', customerId: 'cu_1' });
    destinationFindUnique.mockResolvedValue({
      ...ACTIVE_DESTINATION_CU1,
      customerId: 'cu_other',
    });

    const res = await POST(
      postRequest({ mailboxId: 'mb_1', destinationId: 'dest_1', status: 'ACTIVE' }),
    );

    expect(res.status).toBe(409);
    expect(mappingCreate).not.toHaveBeenCalled();
  });

  it('no longer trusts a raw telegramChatId without a destinationId (400)', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN);

    const res = await POST(
      postRequest({
        mailboxId: 'mb_1',
        telegramChatId: '-1009999999999',
        telegramGroupName: 'Spoofed group',
        status: 'ACTIVE',
      }),
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.fields).toHaveProperty('destinationId');
    // Never reached the DB: the raw chat id is ignored, not persisted.
    expect(mailboxFindUnique).not.toHaveBeenCalled();
    expect(mappingCreate).not.toHaveBeenCalled();
  });

  it('creates a same-customer mapping through the destination path (201)', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN);
    mailboxFindUnique.mockResolvedValue({ id: 'mb_1', customerId: 'cu_1' });
    destinationFindUnique.mockResolvedValue(ACTIVE_DESTINATION_CU1);
    mappingFindFirst.mockResolvedValue(null);
    mappingCreate.mockResolvedValue(CREATED_ROW);

    const res = await POST(
      postRequest({ mailboxId: 'mb_1', destinationId: 'dest_1', status: 'ACTIVE' }),
    );

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.data.destinationId).toBe('dest_1');
    // chat/thread are derived from the destination, not from the request.
    expect(mappingCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          mailboxId: 'mb_1',
          destinationId: 'dest_1',
          telegramChatId: '-1001234567890',
        }),
      }),
    );
  });

  it('preserves one-active-destination-per-mailbox (409 on second active)', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN);
    mailboxFindUnique.mockResolvedValue({ id: 'mb_1', customerId: 'cu_1' });
    destinationFindUnique.mockResolvedValue(ACTIVE_DESTINATION_CU1);
    mappingFindFirst
      .mockResolvedValueOnce(null) // no duplicate (mailbox, chatId)
      .mockResolvedValueOnce({ id: 'already-active' }); // existing active mapping

    const res = await POST(
      postRequest({ mailboxId: 'mb_1', destinationId: 'dest_1', status: 'ACTIVE' }),
    );

    expect(res.status).toBe(409);
    expect(mappingCreate).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/telegram/mappings/[id] — customer isolation (TASK-065)', () => {
  it('rejects re-pointing a mapping onto a different customer destination (409)', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN);
    mailboxFindUnique.mockResolvedValue({ id: 'mb_1', customerId: 'cu_1' });
    destinationFindUnique.mockResolvedValue({
      ...ACTIVE_DESTINATION_CU1,
      customerId: 'cu_other',
    });

    const res = await PATCH(
      patchRequest({ mailboxId: 'mb_1', destinationId: 'dest_1', status: 'ACTIVE' }),
      { params: { id: 'tm_1' } },
    );

    expect(res.status).toBe(409);
    expect(mappingUpdate).not.toHaveBeenCalled();
  });

  it('updates a same-customer mapping through the destination path (200)', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN);
    mailboxFindUnique.mockResolvedValue({ id: 'mb_1', customerId: 'cu_1' });
    destinationFindUnique.mockResolvedValue(ACTIVE_DESTINATION_CU1);
    mappingFindFirst.mockResolvedValue(null);
    mappingUpdate.mockResolvedValue(CREATED_ROW);

    const res = await PATCH(
      patchRequest({ mailboxId: 'mb_1', destinationId: 'dest_1', status: 'ACTIVE' }),
      { params: { id: 'tm_1' } },
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(mappingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'tm_1' } }),
    );
  });

  it('returns 403 for STAFF_READ_ONLY without writing anything', async () => {
    getCurrentUserMock.mockResolvedValue(STAFF);

    const res = await PATCH(
      patchRequest({ mailboxId: 'mb_1', destinationId: 'dest_1', status: 'ACTIVE' }),
      { params: { id: 'tm_1' } },
    );

    expect(res.status).toBe(403);
    expect(mappingUpdate).not.toHaveBeenCalled();
  });
});

// TASK-078 — disable/delete are gated on MANAGE_TELEGRAM_MAPPINGS and scoped to
// the caller's customers. STAFF_READ_ONLY is blocked at the permission layer;
// OWNER/ADMIN resolve to the unrestricted scope and still operate normally.
describe('disable/delete scoping (TASK-078)', () => {
  it('disable returns 403 for STAFF_READ_ONLY without mutating', async () => {
    getCurrentUserMock.mockResolvedValue(STAFF);
    const res = await PATCH(disableRequest(), { params: { id: 'tm_1' } });
    expect(res.status).toBe(403);
    expect(mappingUpdate).not.toHaveBeenCalled();
  });

  it('delete returns 403 for STAFF_READ_ONLY without mutating', async () => {
    getCurrentUserMock.mockResolvedValue(STAFF);
    const res = await DELETE(deleteRequest(), { params: { id: 'tm_1' } });
    expect(res.status).toBe(403);
    expect(mappingDelete).not.toHaveBeenCalled();
  });

  it('ADMIN can disable (unrestricted scope skips the scope lookup)', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN);
    mappingUpdate.mockResolvedValue({ ...CREATED_ROW, status: 'DISABLED' });

    const res = await PATCH(disableRequest(), { params: { id: 'tm_1' } });

    expect(res.status).toBe(200);
    // 'all' scope never needs the per-row scope lookup.
    expect(mappingFindUnique).not.toHaveBeenCalled();
    expect(mappingUpdate).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'tm_1' }, data: { status: 'DISABLED' } }),
    );
  });

  it('ADMIN can delete (unrestricted scope skips the scope lookup)', async () => {
    getCurrentUserMock.mockResolvedValue(ADMIN);
    mappingDelete.mockResolvedValue(undefined);

    const res = await DELETE(deleteRequest(), { params: { id: 'tm_1' } });

    expect(res.status).toBe(200);
    expect(mappingFindUnique).not.toHaveBeenCalled();
    expect(mappingDelete).toHaveBeenCalledWith({ where: { id: 'tm_1' } });
  });
});
