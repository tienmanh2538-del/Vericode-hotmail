import { describe, it, expect, vi } from 'vitest';
import {
  MicrosoftProfileError,
  fetchMicrosoftProfile,
} from '@/services/microsoft/microsoft-profile.service';

const ACCESS_TOKEN = 'fake-access-token-xyz';
const GRAPH_ME_URL =
  'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName';

function stubFetch(payload: Record<string, unknown>, status = 200) {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
  ) as unknown as typeof fetch;
}

describe('fetchMicrosoftProfile — success', () => {
  it('returns id, mail, userPrincipalName, and displayName from Graph /me', async () => {
    const fetchImpl = stubFetch({
      id: 'ms-user-001',
      mail: 'client@example.com',
      userPrincipalName: 'client@example.onmicrosoft.com',
      displayName: 'Example Client',
    });

    const profile = await fetchMicrosoftProfile(ACCESS_TOKEN, { fetchImpl });

    expect(profile.id).toBe('ms-user-001');
    expect(profile.mail).toBe('client@example.com');
    expect(profile.userPrincipalName).toBe('client@example.onmicrosoft.com');
    expect(profile.displayName).toBe('Example Client');
  });

  it('returns mail=null when Graph returns null for mail', async () => {
    const fetchImpl = stubFetch({
      id: 'ms-user-002',
      mail: null,
      userPrincipalName: 'client@hotmail.com',
      displayName: null,
    });

    const profile = await fetchMicrosoftProfile(ACCESS_TOKEN, { fetchImpl });

    expect(profile.mail).toBeNull();
    expect(profile.userPrincipalName).toBe('client@hotmail.com');
    expect(profile.displayName).toBeNull();
  });

  it('calls the Graph /me endpoint with bearer auth and $select', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ id: 'ms-user-003' }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    );

    await fetchMicrosoftProfile(ACCESS_TOKEN, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(calledUrl).toBe(GRAPH_ME_URL);
    expect((init.headers as Record<string, string>).authorization).toBe(
      `Bearer ${ACCESS_TOKEN}`,
    );
  });
});

describe('fetchMicrosoftProfile — validation', () => {
  it('rejects empty access token without calling fetch', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}')) as unknown as typeof fetch;
    await expect(
      fetchMicrosoftProfile('', { fetchImpl }),
    ).rejects.toBeInstanceOf(MicrosoftProfileError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('fetchMicrosoftProfile — http failure', () => {
  it('throws http error with status when Graph returns non-2xx', async () => {
    const fetchImpl = stubFetch({ error: { code: 'unauthorized' } }, 401);
    try {
      await fetchMicrosoftProfile(ACCESS_TOKEN, { fetchImpl });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MicrosoftProfileError);
      const e = err as MicrosoftProfileError;
      expect(e.kind).toBe('http');
      expect(e.httpStatus).toBe(401);
      expect(e.message).not.toContain(ACCESS_TOKEN);
    }
  });
});

describe('fetchMicrosoftProfile — secret hygiene', () => {
  it('never includes the access token in thrown error messages', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch;

    try {
      await fetchMicrosoftProfile(ACCESS_TOKEN, { fetchImpl });
    } catch (err) {
      const e = err as MicrosoftProfileError;
      const serialized = JSON.stringify({
        message: e.message,
        kind: e.kind,
        httpStatus: e.httpStatus,
      });
      expect(serialized).not.toContain(ACCESS_TOKEN);
    }
  });
});

describe('fetchMicrosoftProfile — parse failures', () => {
  it('throws parse error when Graph returns invalid JSON', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response('not-json-{{{', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ) as unknown as typeof fetch;

    await expect(
      fetchMicrosoftProfile(ACCESS_TOKEN, { fetchImpl }),
    ).rejects.toMatchObject({ kind: 'parse' });
  });

  it('throws parse error when Graph response is missing id', async () => {
    const fetchImpl = stubFetch({ mail: 'no-id@example.com' });
    await expect(
      fetchMicrosoftProfile(ACCESS_TOKEN, { fetchImpl }),
    ).rejects.toMatchObject({ kind: 'parse' });
  });
});
