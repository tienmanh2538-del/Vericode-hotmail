import { describe, it, expect, vi } from 'vitest';
import {
  GraphMailError,
  getMessageById,
  listInboxMessages,
} from '@/services/microsoft/graph-mail.service';

const ACCESS_TOKEN = 'fake-access-token-do-not-leak';

const INBOX_URL_PREFIX =
  'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?';
const MESSAGE_URL_PREFIX = 'https://graph.microsoft.com/v1.0/me/messages/';

function jsonResponse(payload: unknown, status = 200, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function stubFetch(payload: unknown, status = 200, headers: HeadersInit = {}) {
  return vi.fn(async () => jsonResponse(payload, status, headers)) as unknown as typeof fetch;
}

function captureCall(fetchMock: ReturnType<typeof vi.fn>): {
  url: string;
  init: RequestInit;
} {
  expect(fetchMock).toHaveBeenCalled();
  const [calledUrl, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return { url: calledUrl, init };
}

function parseQuery(url: string): URLSearchParams {
  const idx = url.indexOf('?');
  return new URLSearchParams(idx === -1 ? '' : url.slice(idx + 1));
}

describe('listInboxMessages — endpoint and query shape', () => {
  it('calls the /me/mailFolders/inbox/messages endpoint with Bearer auth', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ value: [] }));
    await listInboxMessages(ACCESS_TOKEN, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const { url, init } = captureCall(fetchMock);
    expect(url.startsWith(INBOX_URL_PREFIX)).toBe(true);
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Bearer ${ACCESS_TOKEN}`);
    expect(headers.accept).toBe('application/json');
  });

  it('defaults to $top=10, $orderby=receivedDateTime desc, and $select without body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ value: [] }));
    await listInboxMessages(ACCESS_TOKEN, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const { url } = captureCall(fetchMock);
    const qs = parseQuery(url);
    expect(qs.get('$top')).toBe('10');
    expect(qs.get('$orderby')).toBe('receivedDateTime desc');
    const select = qs.get('$select') ?? '';
    expect(select).toContain('id');
    expect(select).toContain('internetMessageId');
    expect(select).toContain('from');
    expect(select).toContain('sender');
    expect(select).toContain('subject');
    expect(select).toContain('receivedDateTime');
    expect(select).toContain('bodyPreview');
    expect(select).toContain('toRecipients');
    expect(select.split(',')).not.toContain('body');
  });

  it('clamps $top to [1, 25] when caller passes out-of-range values', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ value: [] }));
    await listInboxMessages(ACCESS_TOKEN, {
      top: 1000,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(parseQuery(captureCall(fetchMock).url).get('$top')).toBe('25');

    const fetchMock2 = vi.fn(async () => jsonResponse({ value: [] }));
    await listInboxMessages(ACCESS_TOKEN, {
      top: 0,
      fetchImpl: fetchMock2 as unknown as typeof fetch,
    });
    expect(parseQuery(captureCall(fetchMock2).url).get('$top')).toBe('1');

    const fetchMock3 = vi.fn(async () => jsonResponse({ value: [] }));
    await listInboxMessages(ACCESS_TOKEN, {
      top: -5,
      fetchImpl: fetchMock3 as unknown as typeof fetch,
    });
    expect(parseQuery(captureCall(fetchMock3).url).get('$top')).toBe('1');
  });

  it('includes body in $select and sets Prefer text header when includeBody=true', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ value: [] }));
    await listInboxMessages(ACCESS_TOKEN, {
      includeBody: true,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const { url, init } = captureCall(fetchMock);
    const select = parseQuery(url).get('$select') ?? '';
    expect(select.split(',')).toContain('body');
    const headers = init.headers as Record<string, string>;
    expect(headers.prefer).toBe('outlook.body-content-type="text"');
  });

  it('omits the Prefer header by default', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ value: [] }));
    await listInboxMessages(ACCESS_TOKEN, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const { init } = captureCall(fetchMock);
    const headers = init.headers as Record<string, string>;
    expect(headers.prefer).toBeUndefined();
  });
});

describe('listInboxMessages — response normalization', () => {
  it('parses value[] into normalized GraphMailMessage list', async () => {
    const fetchImpl = stubFetch({
      value: [
        {
          id: 'graph-msg-1',
          internetMessageId: '<msg-1@example.com>',
          from: { emailAddress: { name: 'Alice', address: 'alice@example.com' } },
          sender: { emailAddress: { name: 'Alice', address: 'alice@example.com' } },
          subject: 'Hello',
          receivedDateTime: '2026-05-28T10:00:00Z',
          bodyPreview: 'preview text',
          toRecipients: [
            { emailAddress: { name: 'Bob', address: 'bob@example.com' } },
          ],
        },
        {
          id: 'graph-msg-2',
          subject: null,
        },
      ],
    });

    const result = await listInboxMessages(ACCESS_TOKEN, { fetchImpl });
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe('graph-msg-1');
    expect(result[0].from?.emailAddress?.address).toBe('alice@example.com');
    expect(result[0].toRecipients?.[0].emailAddress?.address).toBe('bob@example.com');
    expect(result[1].id).toBe('graph-msg-2');
    expect(result[1].subject).toBeNull();
  });

  it('drops items without an id rather than crashing', async () => {
    const fetchImpl = stubFetch({
      value: [{ id: 'ok-1' }, { subject: 'no id' }, null, 'string-item'],
    });
    const result = await listInboxMessages(ACCESS_TOKEN, { fetchImpl });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('ok-1');
  });

  it('ignores @odata.nextLink without crashing or fetching another page', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        '@odata.nextLink': 'https://graph.microsoft.com/v1.0/$skiptoken=abc',
        value: [{ id: 'first-page-only' }],
      }),
    );
    const result = await listInboxMessages(ACCESS_TOKEN, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    expect(result).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('throws parse error when response is missing value[]', async () => {
    const fetchImpl = stubFetch({ notValue: 'oops' });
    await expect(
      listInboxMessages(ACCESS_TOKEN, { fetchImpl }),
    ).rejects.toMatchObject({ kind: 'parse' });
  });
});

describe('listInboxMessages — validation', () => {
  it('rejects empty access token without calling fetch', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    await expect(
      listInboxMessages('', { fetchImpl }),
    ).rejects.toBeInstanceOf(GraphMailError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects whitespace access token', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    await expect(
      listInboxMessages('   ', { fetchImpl }),
    ).rejects.toMatchObject({ kind: 'validation' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('listInboxMessages — http failures map to safe errors', () => {
  it('401 → kind=auth, no token in message', async () => {
    const fetchImpl = stubFetch({ error: { code: 'InvalidAuthenticationToken' } }, 401);
    try {
      await listInboxMessages(ACCESS_TOKEN, { fetchImpl });
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(GraphMailError);
      const e = err as GraphMailError;
      expect(e.kind).toBe('auth');
      expect(e.httpStatus).toBe(401);
      expect(JSON.stringify({ msg: e.message })).not.toContain(ACCESS_TOKEN);
    }
  });

  it('403 → kind=permission', async () => {
    const fetchImpl = stubFetch({}, 403);
    await expect(
      listInboxMessages(ACCESS_TOKEN, { fetchImpl }),
    ).rejects.toMatchObject({ kind: 'permission', httpStatus: 403 });
  });

  it('404 → kind=not_found', async () => {
    const fetchImpl = stubFetch({}, 404);
    await expect(
      listInboxMessages(ACCESS_TOKEN, { fetchImpl }),
    ).rejects.toMatchObject({ kind: 'not_found', httpStatus: 404 });
  });

  it('429 preserves numeric Retry-After header', async () => {
    const fetchImpl = stubFetch({}, 429, { 'retry-after': '37' });
    try {
      await listInboxMessages(ACCESS_TOKEN, { fetchImpl });
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as GraphMailError;
      expect(e.kind).toBe('rate_limited');
      expect(e.httpStatus).toBe(429);
      expect(e.retryAfterSeconds).toBe(37);
    }
  });

  it('429 without Retry-After still maps to rate_limited', async () => {
    const fetchImpl = stubFetch({}, 429);
    try {
      await listInboxMessages(ACCESS_TOKEN, { fetchImpl });
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as GraphMailError;
      expect(e.kind).toBe('rate_limited');
      expect(e.retryAfterSeconds).toBeUndefined();
    }
  });

  it('500 → kind=temporary', async () => {
    const fetchImpl = stubFetch({}, 500);
    await expect(
      listInboxMessages(ACCESS_TOKEN, { fetchImpl }),
    ).rejects.toMatchObject({ kind: 'temporary', httpStatus: 500 });
  });

  it('503 → kind=temporary', async () => {
    const fetchImpl = stubFetch({}, 503);
    await expect(
      listInboxMessages(ACCESS_TOKEN, { fetchImpl }),
    ).rejects.toMatchObject({ kind: 'temporary', httpStatus: 503 });
  });
});

describe('listInboxMessages — secret hygiene', () => {
  it('network error does not leak the access token in error message', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`underlying transport failure with ${ACCESS_TOKEN}`);
    }) as unknown as typeof fetch;

    try {
      await listInboxMessages(ACCESS_TOKEN, { fetchImpl });
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as GraphMailError;
      expect(e.kind).toBe('network');
      const serialized = JSON.stringify({
        message: e.message,
        kind: e.kind,
        httpStatus: e.httpStatus,
      });
      expect(serialized).not.toContain(ACCESS_TOKEN);
    }
  });

  it('http error response does not leak the access token in error message', async () => {
    const fetchImpl = stubFetch({ token: ACCESS_TOKEN }, 401);
    try {
      await listInboxMessages(ACCESS_TOKEN, { fetchImpl });
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as GraphMailError;
      expect(JSON.stringify({ msg: e.message })).not.toContain(ACCESS_TOKEN);
    }
  });
});

describe('getMessageById — endpoint shape', () => {
  it('URL-encodes the message id in the path', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 'returned' }));
    const tricky = 'AAMkAGI=/with weird+chars?&value';
    await getMessageById(ACCESS_TOKEN, tricky, {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const { url } = captureCall(fetchMock);
    expect(url.startsWith(MESSAGE_URL_PREFIX)).toBe(true);
    const pathSegment = url.slice(MESSAGE_URL_PREFIX.length).split('?')[0];
    expect(pathSegment).toBe(encodeURIComponent(tricky));
    // Decoding should return the original id — proves no double-encoding.
    expect(decodeURIComponent(pathSegment)).toBe(tricky);
  });

  it('includes body in $select and defaults to Prefer text body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 'm-1' }));
    await getMessageById(ACCESS_TOKEN, 'simple-id', {
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const { url, init } = captureCall(fetchMock);
    const select = parseQuery(url).get('$select') ?? '';
    expect(select.split(',')).toContain('body');
    const headers = init.headers as Record<string, string>;
    expect(headers.prefer).toBe('outlook.body-content-type="text"');
  });

  it('allows turning off Prefer text body', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ id: 'm-2' }));
    await getMessageById(ACCESS_TOKEN, 'simple-id', {
      preferTextBody: false,
      fetchImpl: fetchMock as unknown as typeof fetch,
    });
    const { init } = captureCall(fetchMock);
    const headers = init.headers as Record<string, string>;
    expect(headers.prefer).toBeUndefined();
  });

  it('rejects empty message id', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({})) as unknown as typeof fetch;
    await expect(
      getMessageById(ACCESS_TOKEN, '', { fetchImpl }),
    ).rejects.toMatchObject({ kind: 'validation' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('throws parse error when Graph returns no id', async () => {
    const fetchImpl = stubFetch({ subject: 'no id at all' });
    await expect(
      getMessageById(ACCESS_TOKEN, 'm-3', { fetchImpl }),
    ).rejects.toMatchObject({ kind: 'parse' });
  });

  it('error path does not include access token or full body', async () => {
    const FULL_BODY = 'This is a secret email body containing private data.';
    const fetchImpl = stubFetch(
      { id: 'm-4', body: { contentType: 'text', content: FULL_BODY } },
      403,
    );
    try {
      await getMessageById(ACCESS_TOKEN, 'm-4', { fetchImpl });
      throw new Error('should have thrown');
    } catch (err) {
      const e = err as GraphMailError;
      const serialized = JSON.stringify({
        message: e.message,
        kind: e.kind,
        httpStatus: e.httpStatus,
      });
      expect(serialized).not.toContain(ACCESS_TOKEN);
      expect(serialized).not.toContain(FULL_BODY);
    }
  });
});
