import { describe, it, expect } from 'vitest';

import {
  maskSecret,
  hashSensitiveValue,
  maskVerificationCode,
  redactSensitiveText,
} from '@/lib/security/redact';

describe('maskSecret', () => {
  it('masks the middle of a long secret while keeping head/tail for fingerprinting', () => {
    const masked = maskSecret('supersecretvalue123');
    expect(masked.startsWith('su')).toBe(true);
    expect(masked.endsWith('23')).toBe(true);
    expect(masked).not.toContain('persecretvalue1');
    expect(masked).toContain('*');
  });

  it('fully masks short values and handles empty input', () => {
    expect(maskSecret('abcd')).toBe('****');
    expect(maskSecret('')).toBe('');
  });
});

describe('maskVerificationCode', () => {
  it('returns a one-way sha256 reference, never the raw code', () => {
    const ref = maskVerificationCode('123456');
    expect(ref).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(ref).not.toContain('123456');
  });

  it('is deterministic for the same code', () => {
    expect(maskVerificationCode('999000')).toBe(maskVerificationCode('999000'));
    expect(hashSensitiveValue('999000')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('redactSensitiveText', () => {
  it('redacts key=value secret pairs', () => {
    const out = redactSensitiveText('authorization: Bearer abc.def.ghi token=shhh');
    expect(out).not.toContain('shhh');
    expect(out).toContain('[REDACTED]');
  });

  it('redacts long opaque tokens that look like credentials', () => {
    const longToken = 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0';
    const out = redactSensitiveText(`refresh_token value is ${longToken}`);
    expect(out).not.toContain(longToken);
    expect(out).toContain('[REDACTED]');
  });

  it('leaves harmless text untouched', () => {
    expect(redactSensitiveText('hello world')).toBe('hello world');
  });
});
