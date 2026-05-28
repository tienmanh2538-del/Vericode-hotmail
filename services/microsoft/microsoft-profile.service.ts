import { createLogger } from '@/lib/logger';

const logger = createLogger();

const GRAPH_ME_URL =
  'https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName';

export type MicrosoftProfileErrorKind =
  | 'validation'
  | 'http'
  | 'network'
  | 'parse';

export class MicrosoftProfileError extends Error {
  readonly kind: MicrosoftProfileErrorKind;
  readonly httpStatus?: number;

  constructor(
    kind: MicrosoftProfileErrorKind,
    message: string,
    options?: { httpStatus?: number },
  ) {
    super(message);
    this.name = 'MicrosoftProfileError';
    this.kind = kind;
    this.httpStatus = options?.httpStatus;
  }
}

export interface MicrosoftProfile {
  id: string;
  mail: string | null;
  userPrincipalName: string | null;
  displayName: string | null;
}

export interface FetchMicrosoftProfileOptions {
  fetchImpl?: typeof fetch;
}

function readNullableString(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export async function fetchMicrosoftProfile(
  accessToken: string,
  options: FetchMicrosoftProfileOptions = {},
): Promise<MicrosoftProfile> {
  if (typeof accessToken !== 'string' || accessToken.trim().length === 0) {
    throw new MicrosoftProfileError('validation', 'access token is required');
  }

  const fetchImpl = options.fetchImpl ?? fetch;

  let response: Response;
  try {
    response = await fetchImpl(GRAPH_ME_URL, {
      method: 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: 'application/json',
      },
    });
  } catch {
    // Token value is never logged — only the failure event.
    logger.error('Microsoft Graph /me network call failed');
    throw new MicrosoftProfileError(
      'network',
      'Microsoft Graph profile request failed',
    );
  }

  if (!response.ok) {
    logger.warn('Microsoft Graph /me rejected request', {
      httpStatus: response.status,
    });
    throw new MicrosoftProfileError(
      'http',
      'Microsoft Graph profile request failed',
      { httpStatus: response.status },
    );
  }

  let payload: unknown = null;
  try {
    payload = await response.json();
  } catch {
    throw new MicrosoftProfileError(
      'parse',
      'Microsoft Graph profile response was not JSON',
      { httpStatus: response.status },
    );
  }

  if (typeof payload !== 'object' || payload === null) {
    throw new MicrosoftProfileError(
      'parse',
      'Microsoft Graph profile response was not JSON',
      { httpStatus: response.status },
    );
  }

  const record = payload as Record<string, unknown>;
  const id = readNullableString(record.id);
  if (id === null) {
    throw new MicrosoftProfileError(
      'parse',
      'Microsoft Graph profile missing user id',
      { httpStatus: response.status },
    );
  }

  return {
    id,
    mail: readNullableString(record.mail),
    userPrincipalName: readNullableString(record.userPrincipalName),
    displayName: readNullableString(record.displayName),
  };
}
