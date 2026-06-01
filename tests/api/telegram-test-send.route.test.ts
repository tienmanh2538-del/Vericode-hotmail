import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { AuthUser } from '@/lib/auth/session';

const { getCurrentUserMock, sendTelegramMessageMock } = vi.hoisted(() => ({
  getCurrentUserMock: vi.fn<() => Promise<AuthUser | null>>(),
  sendTelegramMessageMock: vi.fn(),
}));

vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => getCurrentUserMock(),
}));

vi.mock('@/services/telegram/telegram-sender.service', () => ({
  sendTelegramMessage: (...args: unknown[]) => sendTelegramMessageMock(...args),
  // Re-export a minimal error class so the route's `instanceof` checks compile.
  TelegramSendError: class TelegramSendError extends Error {
    kind: string;
    constructor(kind: string, message: string) {
      super(message);
      this.kind = kind;
    }
  },
}));

import { POST } from '@/app/api/telegram/test-send/route';

function postRequest(body: unknown): Request {
  return new Request('http://localhost/api/telegram/test-send', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  getCurrentUserMock.mockReset();
  sendTelegramMessageMock.mockReset();
});

describe('POST /api/telegram/test-send — auth guard (TASK-045)', () => {
  it('returns 403 for STAFF_READ_ONLY (no MANAGE_TELEGRAM_MAPPINGS)', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'staff-1',
      email: 'staff@example.com',
      role: 'STAFF_READ_ONLY',
    });

    const res = await POST(postRequest({ chatId: '-100123' }));

    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toEqual({ ok: false, error: 'Forbidden' });
    // Guard must short-circuit before the sender is ever touched.
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
  });

  it('returns 403 when no user is signed in', async () => {
    getCurrentUserMock.mockResolvedValue(null);

    const res = await POST(postRequest({ chatId: '-100123' }));

    expect(res.status).toBe(403);
    expect(sendTelegramMessageMock).not.toHaveBeenCalled();
  });

  it('lets an ADMIN send a test message', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'admin-1',
      email: 'admin@example.com',
      role: 'ADMIN',
    });
    sendTelegramMessageMock.mockResolvedValue({
      chatId: '-100123',
      messageId: 42,
    });

    const res = await POST(postRequest({ chatId: '-100123', text: 'hi' }));

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      chatId: '-100123',
      messageId: 42,
    });
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
  });

  it('lets an OWNER send a test message', async () => {
    getCurrentUserMock.mockResolvedValue({
      id: 'owner-1',
      email: 'owner@example.com',
      role: 'OWNER',
    });
    sendTelegramMessageMock.mockResolvedValue({
      chatId: '-100999',
      messageId: 7,
    });

    const res = await POST(postRequest({ chatId: '-100999' }));

    expect(res.status).toBe(200);
    expect(sendTelegramMessageMock).toHaveBeenCalledTimes(1);
  });
});
