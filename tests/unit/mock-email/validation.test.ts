import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import {
  toSafePreview,
  validateMockEmailInput,
} from '@/lib/validation/mock-email';

const VALID_INPUT = {
  mailboxEmail: 'mock-mailbox-1@example.com',
  fromEmail: 'security@facebookmail.example',
  fromName: 'Facebook',
  subject: 'Your verification code',
  receivedAt: '2025-01-15T08:30:00Z',
  bodyPreview: 'Your code is 123456.',
  body: 'Hello,\n\nYour verification code is 123456.\n',
};

describe('validateMockEmailInput - success', () => {
  it('accepts a complete valid input', () => {
    const result = validateMockEmailInput(VALID_INPUT);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.mailboxEmail).toBe('mock-mailbox-1@example.com');
      expect(result.data.fromName).toBe('Facebook');
      expect(result.data.bodyPreview).toBe('Your code is 123456.');
    }
  });

  it('trims whitespace from string fields', () => {
    const result = validateMockEmailInput({
      ...VALID_INPUT,
      mailboxEmail: '  mock-mailbox-1@example.com  ',
      subject: '  Your code  ',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.mailboxEmail).toBe('mock-mailbox-1@example.com');
      expect(result.data.subject).toBe('Your code');
    }
  });

  it('treats empty optional fields as undefined', () => {
    const result = validateMockEmailInput({
      ...VALID_INPUT,
      fromName: '   ',
      bodyPreview: '',
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.fromName).toBeUndefined();
      expect(result.data.bodyPreview).toBeUndefined();
    }
  });
});

describe('validateMockEmailInput - failure', () => {
  it('rejects missing required fields', () => {
    const result = validateMockEmailInput({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.mailboxEmail).toBeDefined();
      expect(result.errors.fromEmail).toBeDefined();
      expect(result.errors.subject).toBeDefined();
      expect(result.errors.receivedAt).toBeDefined();
      expect(result.errors.body).toBeDefined();
    }
  });

  it('rejects malformed emails', () => {
    const result = validateMockEmailInput({
      ...VALID_INPUT,
      mailboxEmail: 'not-an-email',
      fromEmail: 'also-not-an-email',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.mailboxEmail).toMatch(/valid email/);
      expect(result.errors.fromEmail).toMatch(/valid email/);
    }
  });

  it('rejects non-ISO receivedAt', () => {
    const result = validateMockEmailInput({
      ...VALID_INPUT,
      receivedAt: 'tomorrow at noon',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.receivedAt).toMatch(/ISO 8601/);
    }
  });

  it('rejects suspicious secret-like content in subject or from name', () => {
    const result = validateMockEmailInput({
      ...VALID_INPUT,
      fromName: 'BotToken Notifier',
      subject: 'Your api_key has been issued',
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.fromName).toMatch(/secrets|tokens/);
      expect(result.errors.subject).toMatch(/secrets|tokens/);
    }
  });

  it('rejects oversized body', () => {
    const result = validateMockEmailInput({
      ...VALID_INPUT,
      body: 'a'.repeat(50_001),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.body).toMatch(/50000/);
    }
  });
});

describe('toSafePreview', () => {
  it('returns only a snippet of the body, not the full text', () => {
    const longBody = 'X'.repeat(1000);
    const preview = toSafePreview({
      mailboxEmail: 'm@example.com',
      fromEmail: 'f@example.com',
      subject: 's',
      receivedAt: '2025-01-15T08:30:00Z',
      body: longBody,
    });
    expect(preview.bodyLength).toBe(1000);
    expect(preview.bodySnippet.length).toBeLessThanOrEqual(200);
    expect(preview.bodySnippet.length).toBeLessThan(longBody.length);
  });

  it('omits undefined optional fields', () => {
    const preview = toSafePreview({
      mailboxEmail: 'm@example.com',
      fromEmail: 'f@example.com',
      subject: 's',
      receivedAt: '2025-01-15T08:30:00Z',
      body: 'short',
    });
    expect('fromName' in preview).toBe(false);
    expect('bodyPreview' in preview).toBe(false);
  });
});

describe('email-sample fixtures', () => {
  const FIXTURES_DIR = path.resolve(
    __dirname,
    '..',
    '..',
    'fixtures',
    'email-samples',
  );

  it('contains at least the four expected fixtures', () => {
    const files = readdirSync(FIXTURES_DIR).filter((name) =>
      name.endsWith('.json'),
    );
    expect(files).toContain('facebook-verification-basic.json');
    expect(files).toContain('facebook-security-code-vi.json');
    expect(files).toContain('non-facebook-newsletter.json');
    expect(files).toContain('non-code-security-alert.json');
  });

  it('each fixture validates successfully', () => {
    const files = readdirSync(FIXTURES_DIR).filter((name) =>
      name.endsWith('.json'),
    );
    expect(files.length).toBeGreaterThan(0);

    for (const file of files) {
      const raw = readFileSync(path.join(FIXTURES_DIR, file), 'utf8');
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const { _meta, ...input } = parsed;
      const result = validateMockEmailInput(input);
      if (!result.ok) {
        throw new Error(
          `Fixture ${file} failed validation: ${JSON.stringify(result.errors)}`,
        );
      }
      expect(result.ok).toBe(true);
      expect(_meta).toBeDefined();
    }
  });
});
