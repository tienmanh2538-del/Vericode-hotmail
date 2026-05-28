import { createLogger } from '@/lib/logger';

const logger = createLogger();

const GRAPH_BASE_URL = 'https://graph.microsoft.com/v1.0';
const INBOX_MESSAGES_PATH = '/me/mailFolders/inbox/messages';
const MESSAGE_BY_ID_PATH = '/me/messages';

const DEFAULT_TOP = 10;
const MIN_TOP = 1;
const MAX_TOP = 25;

const BASE_SELECT_FIELDS = [
  'id',
  'internetMessageId',
  'from',
  'sender',
  'subject',
  'receivedDateTime',
  'bodyPreview',
  'toRecipients',
] as const;

const BODY_SELECT_FIELD = 'body';

export type GraphMailErrorKind =
  | 'validation'
  | 'auth'
  | 'permission'
  | 'not_found'
  | 'rate_limited'
  | 'temporary'
  | 'http'
  | 'network'
  | 'parse';

export class GraphMailError extends Error {
  readonly kind: GraphMailErrorKind;
  readonly httpStatus?: number;
  readonly retryAfterSeconds?: number;

  constructor(
    kind: GraphMailErrorKind,
    message: string,
    options?: { httpStatus?: number; retryAfterSeconds?: number },
  ) {
    super(message);
    this.name = 'GraphMailError';
    this.kind = kind;
    this.httpStatus = options?.httpStatus;
    this.retryAfterSeconds = options?.retryAfterSeconds;
  }
}

export interface GraphMailEmailAddress {
  name?: string | null;
  address?: string | null;
}

export interface GraphMailRecipient {
  emailAddress?: GraphMailEmailAddress | null;
}

export interface GraphMailBody {
  contentType?: 'text' | 'html' | string;
  content?: string | null;
}

export interface GraphMailMessage {
  id: string;
  internetMessageId?: string | null;
  from?: GraphMailRecipient | null;
  sender?: GraphMailRecipient | null;
  subject?: string | null;
  receivedDateTime?: string | null;
  bodyPreview?: string | null;
  body?: GraphMailBody | null;
  toRecipients?: GraphMailRecipient[];
}

export interface ListInboxMessagesOptions {
  top?: number;
  includeBody?: boolean;
  preferTextBody?: boolean;
  fetchImpl?: typeof fetch;
}

export interface GetMessageOptions {
  preferTextBody?: boolean;
  fetchImpl?: typeof fetch;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  return value;
}

function clampTop(value: number | undefined): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return DEFAULT_TOP;
  const integer = Math.floor(value);
  if (integer < MIN_TOP) return MIN_TOP;
  if (integer > MAX_TOP) return MAX_TOP;
  return integer;
}

function parseRetryAfter(headerValue: string | null): number | undefined {
  if (headerValue === null) return undefined;
  const trimmed = headerValue.trim();
  if (trimmed.length === 0) return undefined;
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.floor(asNumber);
  }
  // HTTP-date form. Best-effort parse without exposing parse failures.
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    const diffMs = asDate - Date.now();
    return diffMs > 0 ? Math.ceil(diffMs / 1000) : 0;
  }
  return undefined;
}

function buildSelect(includeBody: boolean): string {
  const fields = includeBody
    ? [...BASE_SELECT_FIELDS, BODY_SELECT_FIELD]
    : [...BASE_SELECT_FIELDS];
  return fields.join(',');
}

function buildHeaders(accessToken: string, preferTextBody: boolean): HeadersInit {
  const headers: Record<string, string> = {
    authorization: `Bearer ${accessToken}`,
    accept: 'application/json',
  };
  if (preferTextBody) {
    headers.prefer = 'outlook.body-content-type="text"';
  }
  return headers;
}

function mapHttpStatusToError(
  status: number,
  retryAfterSeconds: number | undefined,
): GraphMailError {
  if (status === 401) {
    return new GraphMailError('auth', 'GRAPH_AUTH_FAILED', { httpStatus: status });
  }
  if (status === 403) {
    return new GraphMailError('permission', 'GRAPH_PERMISSION_DENIED', {
      httpStatus: status,
    });
  }
  if (status === 404) {
    return new GraphMailError('not_found', 'GRAPH_NOT_FOUND', { httpStatus: status });
  }
  if (status === 429) {
    return new GraphMailError('rate_limited', 'GRAPH_RATE_LIMITED', {
      httpStatus: status,
      retryAfterSeconds,
    });
  }
  if (status >= 500 && status <= 599) {
    return new GraphMailError('temporary', 'GRAPH_TEMPORARY_ERROR', {
      httpStatus: status,
    });
  }
  return new GraphMailError('http', 'GRAPH_REQUEST_FAILED', { httpStatus: status });
}

function normalizeEmailAddress(value: unknown): GraphMailEmailAddress | null {
  if (!isRecord(value)) return null;
  return {
    name: readNullableString(value.name),
    address: readNullableString(value.address),
  };
}

function normalizeRecipient(value: unknown): GraphMailRecipient | null {
  if (!isRecord(value)) return null;
  return {
    emailAddress: normalizeEmailAddress(value.emailAddress),
  };
}

function normalizeRecipientList(value: unknown): GraphMailRecipient[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item) => normalizeRecipient(item))
    .filter((item): item is GraphMailRecipient => item !== null);
}

function normalizeBody(value: unknown): GraphMailBody | null {
  if (!isRecord(value)) return null;
  const contentType = readOptionalString(value.contentType);
  const content = readOptionalString(value.content);
  return {
    contentType: contentType ?? undefined,
    content: content ?? null,
  };
}

function normalizeMessage(value: unknown): GraphMailMessage | null {
  if (!isRecord(value)) return null;
  const id = readNullableString(value.id);
  if (id === null) return null;
  return {
    id,
    internetMessageId: readNullableString(value.internetMessageId),
    from: normalizeRecipient(value.from),
    sender: normalizeRecipient(value.sender),
    subject: readNullableString(value.subject),
    receivedDateTime: readNullableString(value.receivedDateTime),
    bodyPreview: readNullableString(value.bodyPreview),
    body: value.body === undefined ? null : normalizeBody(value.body),
    toRecipients: normalizeRecipientList(value.toRecipients),
  };
}

function requireAccessToken(accessToken: unknown): string {
  if (typeof accessToken !== 'string' || accessToken.trim().length === 0) {
    throw new GraphMailError('validation', 'access token is required');
  }
  return accessToken;
}

async function performGraphRequest(
  url: string,
  accessToken: string,
  preferTextBody: boolean,
  fetchImpl: typeof fetch,
  operationLabel: string,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: buildHeaders(accessToken, preferTextBody),
    });
  } catch {
    // Token value is never logged — only the failure event.
    logger.error(`Microsoft Graph ${operationLabel} network call failed`);
    throw new GraphMailError('network', 'GRAPH_NETWORK_ERROR');
  }

  if (!response.ok) {
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
    logger.warn(`Microsoft Graph ${operationLabel} rejected request`, {
      httpStatus: response.status,
      retryAfterSeconds: retryAfter,
    });
    throw mapHttpStatusToError(response.status, retryAfter);
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    throw new GraphMailError('parse', 'GRAPH_RESPONSE_NOT_JSON', {
      httpStatus: response.status,
    });
  }
  return payload;
}

export async function listInboxMessages(
  accessToken: string,
  options: ListInboxMessagesOptions = {},
): Promise<GraphMailMessage[]> {
  const token = requireAccessToken(accessToken);
  const fetchImpl = options.fetchImpl ?? fetch;

  const top = clampTop(options.top);
  const includeBody = options.includeBody === true;
  const preferTextBody = includeBody && options.preferTextBody !== false;

  const params = new URLSearchParams({
    $top: String(top),
    $orderby: 'receivedDateTime desc',
    $select: buildSelect(includeBody),
  });
  const url = `${GRAPH_BASE_URL}${INBOX_MESSAGES_PATH}?${params.toString()}`;

  const payload = await performGraphRequest(
    url,
    token,
    preferTextBody,
    fetchImpl,
    'listInboxMessages',
  );

  if (!isRecord(payload) || !Array.isArray(payload.value)) {
    throw new GraphMailError('parse', 'GRAPH_RESPONSE_SHAPE_INVALID');
  }

  // @odata.nextLink is intentionally ignored at this layer. Callers asking
  // for more than `top` messages should request another page explicitly in a
  // later task — silently auto-paging would mask rate limits.
  return payload.value
    .map((item) => normalizeMessage(item))
    .filter((item): item is GraphMailMessage => item !== null);
}

export async function getMessageById(
  accessToken: string,
  messageId: string,
  options: GetMessageOptions = {},
): Promise<GraphMailMessage> {
  const token = requireAccessToken(accessToken);
  if (typeof messageId !== 'string' || messageId.trim().length === 0) {
    throw new GraphMailError('validation', 'message id is required');
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const preferTextBody = options.preferTextBody !== false;

  const encodedId = encodeURIComponent(messageId);
  const params = new URLSearchParams({
    $select: buildSelect(true),
  });
  const url = `${GRAPH_BASE_URL}${MESSAGE_BY_ID_PATH}/${encodedId}?${params.toString()}`;

  const payload = await performGraphRequest(
    url,
    token,
    preferTextBody,
    fetchImpl,
    'getMessageById',
  );

  const message = normalizeMessage(payload);
  if (message === null) {
    throw new GraphMailError('parse', 'GRAPH_RESPONSE_SHAPE_INVALID');
  }
  return message;
}

// Internal constants exposed for tests that need to assert on URL shape.
export const __internal = {
  GRAPH_BASE_URL,
  INBOX_MESSAGES_PATH,
  MESSAGE_BY_ID_PATH,
  DEFAULT_TOP,
  MIN_TOP,
  MAX_TOP,
  BASE_SELECT_FIELDS,
};
