import { describe, it, expect } from 'vitest';
import { NextRequest } from 'next/server';

const { POST, GET } = await import('@/app/api/webhooks/microsoft/mail/route');

const ROUTE_BASE = 'http://localhost:3000/api/webhooks/microsoft/mail';

function makePostRequest(qs?: string): NextRequest {
  const url = qs ? `${ROUTE_BASE}?${qs}` : ROUTE_BASE;
  return new NextRequest(url, { method: 'POST' });
}

function makeGetRequest(qs?: string): NextRequest {
  const url = qs ? `${ROUTE_BASE}?${qs}` : ROUTE_BASE;
  return new NextRequest(url, { method: 'GET' });
}

describe('POST /api/webhooks/microsoft/mail — validationToken handling', () => {
  it('returns plain text body with simple validationToken (Case 1)', async () => {
    const response = await POST(makePostRequest('validationToken=abc123'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const body = await response.text();
    expect(body).toBe('abc123');
  });

  it('URL-decodes a token containing %20 (Case 2)', async () => {
    const response = await POST(makePostRequest('validationToken=abc%20123'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const body = await response.text();
    expect(body).toBe('abc 123');
  });

  it('URL-decodes a token containing +, /, = symbols (Case 3)', async () => {
    const response = await POST(
      makePostRequest('validationToken=token%2Bwith%2Fsymbols%3D'),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const body = await response.text();
    expect(body).toBe('token+with/symbols=');
  });

  it('does not wrap token in JSON', async () => {
    const response = await POST(makePostRequest('validationToken=raw-token'));
    const body = await response.text();
    expect(body).toBe('raw-token');
    expect(body.startsWith('{')).toBe(false);
    expect(body.startsWith('"')).toBe(false);
  });

  it('sets Cache-Control: no-store on validation response', async () => {
    const response = await POST(makePostRequest('validationToken=cache-token'));
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('POST /api/webhooks/microsoft/mail — without validationToken (Case 4)', () => {
  it('returns 202 placeholder response without throwing', async () => {
    const response = await POST(makePostRequest());

    expect(response.status).toBe(202);
    const contentType = response.headers.get('content-type') ?? '';
    expect(contentType).toContain('application/json');

    const payload = (await response.json()) as {
      ok: boolean;
      received: boolean;
      message: string;
    };
    expect(payload.ok).toBe(true);
    expect(payload.received).toBe(true);
    expect(payload.message).toContain('TASK-025');
  });

  it('treats empty validationToken as missing', async () => {
    const response = await POST(makePostRequest('validationToken='));
    expect(response.status).toBe(202);
  });
});

describe('GET /api/webhooks/microsoft/mail — manual smoke test (Case 5)', () => {
  it('returns plain text body for GET with validationToken', async () => {
    const response = await GET(makeGetRequest('validationToken=abc123'));

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    const body = await response.text();
    expect(body).toBe('abc123');
  });

  it('returns a liveness JSON for GET without validationToken', async () => {
    const response = await GET(makeGetRequest());

    expect(response.status).toBe(200);
    const contentType = response.headers.get('content-type') ?? '';
    expect(contentType).toContain('application/json');
    const payload = (await response.json()) as { ok: boolean };
    expect(payload.ok).toBe(true);
  });
});
