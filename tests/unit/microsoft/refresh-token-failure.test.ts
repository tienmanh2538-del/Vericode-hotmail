import { describe, it, expect } from 'vitest';

import { RefreshAccessTokenError } from '@/services/microsoft/refresh-access-token.service';
import {
  REVOKED_GRANT_ERROR_CODES,
  classifyRefreshTokenError,
  shouldMarkReconnectRequired,
} from '@/services/microsoft/refresh-token-failure';

describe('classifyRefreshTokenError', () => {
  it('classifies invalid_grant as reconnect_required', () => {
    const error = new RefreshAccessTokenError('token_endpoint', 'rejected', {
      microsoftErrorCode: 'invalid_grant',
      httpStatus: 400,
    });
    expect(classifyRefreshTokenError(error)).toBe('reconnect_required');
  });

  it('classifies interaction_required as reconnect_required', () => {
    const error = new RefreshAccessTokenError('token_endpoint', 'rejected', {
      microsoftErrorCode: 'interaction_required',
      httpStatus: 400,
    });
    expect(classifyRefreshTokenError(error)).toBe('reconnect_required');
  });

  it('classifies a network error as transient', () => {
    expect(
      classifyRefreshTokenError(new RefreshAccessTokenError('network', 'net')),
    ).toBe('transient');
  });

  it('classifies a Microsoft 429 (no revoke code) as transient', () => {
    const error = new RefreshAccessTokenError('token_endpoint', 'throttled', {
      microsoftErrorCode: 'temporarily_unavailable',
      httpStatus: 429,
    });
    expect(classifyRefreshTokenError(error)).toBe('transient');
  });

  it('classifies a Microsoft 5xx (non-JSON, no code) as transient', () => {
    const error = new RefreshAccessTokenError('token_endpoint', 'server error', {
      httpStatus: 503,
    });
    expect(classifyRefreshTokenError(error)).toBe('transient');
  });

  it('classifies a config error as config', () => {
    expect(
      classifyRefreshTokenError(new RefreshAccessTokenError('config', 'no env')),
    ).toBe('config');
  });

  it('classifies an unknown/odd error as transient (never bricks a mailbox)', () => {
    expect(classifyRefreshTokenError(new Error('boom'))).toBe('transient');
    expect(classifyRefreshTokenError(undefined)).toBe('transient');
    expect(classifyRefreshTokenError({ kind: 'token_endpoint' })).toBe('transient');
  });

  it('keeps the revoke set narrow', () => {
    expect(REVOKED_GRANT_ERROR_CODES.has('invalid_grant')).toBe(true);
    expect(REVOKED_GRANT_ERROR_CODES.has('interaction_required')).toBe(true);
    expect(REVOKED_GRANT_ERROR_CODES.has('temporarily_unavailable')).toBe(false);
    expect(REVOKED_GRANT_ERROR_CODES.has('invalid_request')).toBe(false);
  });
});

describe('shouldMarkReconnectRequired', () => {
  it('returns true only for an explicit reconnect_required classification', () => {
    expect(shouldMarkReconnectRequired({ classification: 'reconnect_required' })).toBe(
      true,
    );
  });

  it('returns false for transient / config / unclassified errors', () => {
    expect(shouldMarkReconnectRequired({ classification: 'transient' })).toBe(false);
    expect(shouldMarkReconnectRequired({ classification: 'config' })).toBe(false);
    expect(shouldMarkReconnectRequired(new Error('plain'))).toBe(false);
    expect(shouldMarkReconnectRequired(undefined)).toBe(false);
    expect(shouldMarkReconnectRequired({})).toBe(false);
  });
});
