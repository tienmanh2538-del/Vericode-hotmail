import { describe, it, expect } from 'vitest';
import {
  maskSecret,
  maskVerificationCode,
  hashSensitiveValue,
  redactSensitiveText,
} from '@/lib/security/redact';

describe('maskSecret', () => {
  it('returns empty string for empty input', () => {
    expect(maskSecret('')).toBe('');
  });

  it('fully masks short values', () => {
    expect(maskSecret('abc')).toBe('***');
    expect(maskSecret('12345678')).toBe('********');
  });

  it('keeps only two head/tail characters for long values', () => {
    const masked = maskSecret('supersecret-token-1234567890');
    expect(masked).toMatch(/^su\*+90$/);
    expect(masked).not.toContain('supersecret');
  });
});

describe('hashSensitiveValue', () => {
  it('is deterministic and one-way', () => {
    expect(hashSensitiveValue('123456')).toBe(hashSensitiveValue('123456'));
    expect(hashSensitiveValue('123456')).not.toBe(hashSensitiveValue('123457'));
    expect(hashSensitiveValue('123456')).not.toContain('123456');
  });
});

describe('maskVerificationCode', () => {
  it('returns short sha256 prefix, never the plaintext', () => {
    const out = maskVerificationCode('987654');
    expect(out.startsWith('sha256:')).toBe(true);
    expect(out).not.toContain('987654');
    expect(out.length).toBe('sha256:'.length + 12);
  });

  it('returns empty for empty input', () => {
    expect(maskVerificationCode('')).toBe('');
  });
});

describe('redactSensitiveText', () => {
  it('redacts key=value patterns', () => {
    const out = redactSensitiveText('login token=abc123secret password: hunter2hunter');
    expect(out).not.toContain('abc123secret');
    expect(out).not.toContain('hunter2hunter');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts long alphanumeric tokens', () => {
    const long = 'A'.repeat(40);
    const out = redactSensitiveText(`some text ${long} more`);
    expect(out).not.toContain(long);
    expect(out).toContain('[REDACTED]');
  });

  it('leaves normal sentences alone', () => {
    const out = redactSensitiveText('User alice logged in successfully.');
    expect(out).toBe('User alice logged in successfully.');
  });

  it('returns empty string for empty input', () => {
    expect(redactSensitiveText('')).toBe('');
  });
});
