import { describe, it, expect } from 'vitest';
import { maskSecret, hashCode, maskCode } from '@/lib/mask';

describe('maskSecret', () => {
  it('returns empty string for nullish or empty input', () => {
    expect(maskSecret(undefined)).toBe('');
    expect(maskSecret(null)).toBe('');
    expect(maskSecret('')).toBe('');
  });

  it('fully masks short values', () => {
    expect(maskSecret('abc')).toBe('***');
    expect(maskSecret('12345678')).toBe('********');
  });

  it('keeps head and tail for longer values', () => {
    expect(maskSecret('supersecret-token-1234567890')).toMatch(/^su\*+90$/);
  });

  it('never includes the original middle in output', () => {
    const secret = 'ghp_abcdef1234567890xyzXYZ';
    const masked = maskSecret(secret);
    expect(masked).not.toContain('abcdef1234567890xyz');
  });
});

describe('hashCode / maskCode', () => {
  it('hashes deterministically', () => {
    expect(hashCode('123456')).toBe(hashCode('123456'));
    expect(hashCode('123456')).not.toBe(hashCode('123457'));
  });

  it('maskCode returns sha256-prefixed short hash and never the plaintext', () => {
    const out = maskCode('verify-987654');
    expect(out.startsWith('sha256:')).toBe(true);
    expect(out).not.toContain('987654');
    expect(out.length).toBe('sha256:'.length + 12);
  });

  it('maskCode returns empty for empty input', () => {
    expect(maskCode('')).toBe('');
    expect(maskCode(null)).toBe('');
  });
});
