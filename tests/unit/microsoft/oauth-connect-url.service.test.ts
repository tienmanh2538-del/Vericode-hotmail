import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { loadEnv } from '@/lib/env';
import {
  MICROSOFT_OAUTH_SCOPES,
  MICROSOFT_OAUTH_STATE_COOKIE,
  MICROSOFT_OAUTH_STATE_TTL_SECONDS,
  MicrosoftOAuthConfigError,
  buildMicrosoftConnectUrl,
  generateOAuthState,
} from '@/services/microsoft/oauth-connect-url.service';

const CLIENT_ID = 'fake-client-id-1234';
const CLIENT_SECRET = 'fake-client-secret-do-not-leak';
const TENANT_ID = 'common';
const REDIRECT_URI = 'http://localhost:3000/api/microsoft/oauth/callback';

beforeEach(() => {
  vi.stubEnv('MICROSOFT_CLIENT_ID', CLIENT_ID);
  vi.stubEnv('MICROSOFT_CLIENT_SECRET', CLIENT_SECRET);
  vi.stubEnv('MICROSOFT_TENANT_ID', TENANT_ID);
  vi.stubEnv('MICROSOFT_REDIRECT_URI', REDIRECT_URI);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('generateOAuthState', () => {
  it('produces a base64url-safe string', () => {
    const state = generateOAuthState();
    expect(state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(state.length).toBeGreaterThanOrEqual(32);
  });

  it('produces different values on each call', () => {
    const a = generateOAuthState();
    const b = generateOAuthState();
    expect(a).not.toBe(b);
  });

  it('rejects byteLength < 16', () => {
    expect(() => generateOAuthState(8)).toThrow();
  });
});

describe('buildMicrosoftConnectUrl — happy path', () => {
  it('uses the Microsoft v2 authorize endpoint with the configured tenant', () => {
    const { url } = buildMicrosoftConnectUrl();
    expect(
      url.startsWith(
        `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/authorize?`,
      ),
    ).toBe(true);
  });

  it('includes every required query parameter', () => {
    const { url, state } = buildMicrosoftConnectUrl();
    const parsed = new URL(url);
    expect(parsed.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(parsed.searchParams.get('response_mode')).toBe('query');
    expect(parsed.searchParams.get('scope')).toBe(
      'Mail.Read offline_access User.Read',
    );
    expect(parsed.searchParams.get('prompt')).toBe('select_account');
    expect(parsed.searchParams.get('state')).toBe(state);
  });

  it('only requests the minimum scopes (no Mail.Send, Mail.ReadWrite, MailboxSettings)', () => {
    const { url } = buildMicrosoftConnectUrl();
    const scope = new URL(url).searchParams.get('scope') ?? '';
    const scopes = scope.split(/\s+/).filter(Boolean);

    expect(scopes).toEqual([...MICROSOFT_OAUTH_SCOPES]);
    expect(scopes).toContain('Mail.Read');
    expect(scopes).toContain('offline_access');
    expect(scopes).toContain('User.Read');
    expect(scopes).not.toContain('Mail.Send');
    expect(scopes).not.toContain('Mail.ReadWrite');
    expect(scopes).not.toContain('MailboxSettings.Read');
    expect(scopes).not.toContain('MailboxSettings.ReadWrite');
    expect(scopes).not.toContain('Files.Read');
    expect(scopes).not.toContain('Calendars.Read');
    expect(scopes).not.toContain('Contacts.Read');
  });

  it('generates a fresh random state on every call (not hardcoded)', () => {
    const a = buildMicrosoftConnectUrl();
    const b = buildMicrosoftConnectUrl();
    expect(a.state).not.toBe(b.state);
    expect(a.url).not.toBe(b.url);
  });

  it('accepts an explicit state override for callers (route, tests)', () => {
    const explicit = 'caller-supplied-state-abc';
    const { url, state } = buildMicrosoftConnectUrl({ state: explicit });
    expect(state).toBe(explicit);
    expect(new URL(url).searchParams.get('state')).toBe(explicit);
  });

  it('url-encodes the tenant segment in the path', () => {
    vi.stubEnv('MICROSOFT_TENANT_ID', 'tenant with space');
    const { url } = buildMicrosoftConnectUrl();
    expect(url).toContain(
      'https://login.microsoftonline.com/tenant%20with%20space/oauth2/v2.0/authorize?',
    );
  });
});

describe('buildMicrosoftConnectUrl — config errors', () => {
  it('throws MicrosoftOAuthConfigError when env is missing', () => {
    vi.stubEnv('MICROSOFT_CLIENT_ID', '');
    vi.stubEnv('MICROSOFT_CLIENT_SECRET', '');
    vi.stubEnv('MICROSOFT_TENANT_ID', '');
    vi.stubEnv('MICROSOFT_REDIRECT_URI', '');

    try {
      buildMicrosoftConnectUrl();
      throw new Error('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(MicrosoftOAuthConfigError);
      const e = err as MicrosoftOAuthConfigError;
      expect(e.kind).toBe('config');
      expect(e.message).not.toContain(CLIENT_ID);
      expect(e.message).not.toContain(CLIENT_SECRET);
      expect(e.message).not.toContain(REDIRECT_URI);
    }
  });
});

describe('buildMicrosoftConnectUrl — secret hygiene', () => {
  it('never includes the client secret in the URL', () => {
    const { url } = buildMicrosoftConnectUrl();
    expect(url).not.toContain(CLIENT_SECRET);
  });
});

describe('module exports — cookie + ttl constants', () => {
  it('exposes a stable cookie name and a positive ttl', () => {
    expect(MICROSOFT_OAUTH_STATE_COOKIE).toBe('ms_oauth_state');
    expect(MICROSOFT_OAUTH_STATE_TTL_SECONDS).toBeGreaterThan(0);
  });
});

describe('buildMicrosoftConnectUrl — explicit env override', () => {
  it('accepts an injected EnvValues for deterministic tests', () => {
    const { values } = loadEnv({
      MICROSOFT_CLIENT_ID: 'inject-client',
      MICROSOFT_CLIENT_SECRET: 'inject-secret',
      MICROSOFT_TENANT_ID: 'inject-tenant',
      MICROSOFT_REDIRECT_URI: 'https://example.test/cb',
    });
    const { url } = buildMicrosoftConnectUrl({ env: values });
    const parsed = new URL(url);
    expect(parsed.searchParams.get('client_id')).toBe('inject-client');
    expect(parsed.pathname).toBe('/inject-tenant/oauth2/v2.0/authorize');
  });
});
