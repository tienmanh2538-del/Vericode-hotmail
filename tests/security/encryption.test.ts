import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  EncryptionError,
  decryptSecret,
  encryptSecret,
  validateEncryptionKey,
} from '@/lib/security/encryption';

function generateKey(): string {
  return randomBytes(32).toString('base64');
}

describe('validateEncryptionKey', () => {
  it('throws when key is missing or empty', () => {
    expect(() => validateEncryptionKey(undefined)).toThrow(EncryptionError);
    expect(() => validateEncryptionKey('')).toThrow(EncryptionError);
    expect(() => validateEncryptionKey('   ')).toThrow(EncryptionError);
  });

  it('throws when key contains characters outside the base64 alphabet', () => {
    expect(() => validateEncryptionKey('not_base64_!!!')).toThrow(
      EncryptionError,
    );
    expect(() => validateEncryptionKey('@@@@')).toThrow(EncryptionError);
  });

  it('throws when decoded key length is not 32 bytes', () => {
    const shortKey = randomBytes(16).toString('base64');
    const longKey = randomBytes(48).toString('base64');
    expect(() => validateEncryptionKey(shortKey)).toThrow(EncryptionError);
    expect(() => validateEncryptionKey(longKey)).toThrow(EncryptionError);
  });

  it('returns a 32-byte Buffer when key is valid', () => {
    const key = generateKey();
    const decoded = validateEncryptionKey(key);
    expect(Buffer.isBuffer(decoded)).toBe(true);
    expect(decoded.length).toBe(32);
  });

  it('does not include the raw key value in error messages', () => {
    const badKey = 'definitely-not-base64-!@#$%';
    try {
      validateEncryptionKey(badKey);
      expect.unreachable('validateEncryptionKey should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(EncryptionError);
      expect((err as Error).message).not.toContain(badKey);
    }
  });
});

describe('encryptSecret / decryptSecret', () => {
  const originalKey = process.env.ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ENCRYPTION_KEY = generateKey();
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = originalKey;
    }
  });

  it('round-trips a refresh-token-like string', () => {
    const plaintext = 'refresh-token-test-value';
    const encrypted = encryptSecret(plaintext);
    expect(encrypted).not.toBe(plaintext);
    expect(encrypted).not.toContain(plaintext);
    expect(decryptSecret(encrypted)).toBe(plaintext);
  });

  it('produces a versioned 4-part payload', () => {
    const encrypted = encryptSecret('hello-world');
    const parts = encrypted.split(':');
    expect(parts.length).toBe(4);
    expect(parts[0]).toBe('v1');
    parts.slice(1).forEach((part) => {
      expect(part.length).toBeGreaterThan(0);
    });
  });

  it('produces different ciphertext for the same plaintext (random IV)', () => {
    const plaintext = 'same-refresh-token';
    const a = encryptSecret(plaintext);
    const b = encryptSecret(plaintext);
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe(plaintext);
    expect(decryptSecret(b)).toBe(plaintext);
  });

  it('rejects empty or non-string plaintext', () => {
    expect(() => encryptSecret('')).toThrow(EncryptionError);
    // @ts-expect-error testing runtime guard
    expect(() => encryptSecret(undefined)).toThrow(EncryptionError);
    // @ts-expect-error testing runtime guard
    expect(() => encryptSecret(null)).toThrow(EncryptionError);
  });

  it('fails safely on malformed payloads', () => {
    expect(() => decryptSecret('')).toThrow(EncryptionError);
    expect(() => decryptSecret('not-a-valid-payload')).toThrow(EncryptionError);
    expect(() => decryptSecret('v1:missing:parts')).toThrow(EncryptionError);
    expect(() => decryptSecret('v2:abc:def:ghi')).toThrow(EncryptionError);
    expect(() => decryptSecret('v1:@@@:###:$$$')).toThrow(EncryptionError);
  });

  it('rejects payloads with incorrect IV or auth-tag length', () => {
    const encrypted = encryptSecret('payload-for-length-check');
    const parts = encrypted.split(':');
    const bogusIv = Buffer.alloc(8).toString('base64');
    const badIvPayload = ['v1', bogusIv, parts[2], parts[3]].join(':');
    expect(() => decryptSecret(badIvPayload)).toThrow(EncryptionError);

    const bogusTag = Buffer.alloc(8).toString('base64');
    const badTagPayload = ['v1', parts[1], bogusTag, parts[3]].join(':');
    expect(() => decryptSecret(badTagPayload)).toThrow(EncryptionError);
  });

  it('fails when payload has been tampered (auth tag verification)', () => {
    const encrypted = encryptSecret('token-to-tamper');
    const parts = encrypted.split(':');
    const ct = Buffer.from(parts[3], 'base64');
    ct[0] = ct[0] ^ 0x01;
    parts[3] = ct.toString('base64');
    const tampered = parts.join(':');
    expect(() => decryptSecret(tampered)).toThrow(EncryptionError);
  });

  it('fails when decrypted with a different key', () => {
    const plaintext = 'super-refresh-token';
    const encrypted = encryptSecret(plaintext);
    process.env.ENCRYPTION_KEY = generateKey();
    expect(() => decryptSecret(encrypted)).toThrow(EncryptionError);
  });

  it('fails when encryption key is missing at runtime', () => {
    delete process.env.ENCRYPTION_KEY;
    expect(() => encryptSecret('whatever')).toThrow(EncryptionError);
    expect(() => decryptSecret('v1:aaaa:bbbb:cccc')).toThrow(EncryptionError);
  });

  it('does not leak plaintext, ciphertext, or key in error messages', () => {
    const tokenLike = 'super-secret-refresh-abcdef123456';
    const encrypted = encryptSecret(tokenLike);
    const parts = encrypted.split(':');
    const ct = Buffer.from(parts[3], 'base64');
    ct[0] = ct[0] ^ 0x01;
    parts[3] = ct.toString('base64');
    const tampered = parts.join(':');
    const keyValue = process.env.ENCRYPTION_KEY as string;

    try {
      decryptSecret(tampered);
      expect.unreachable('decryptSecret should have thrown');
    } catch (err) {
      const message = (err as Error).message;
      expect(message).not.toContain(tokenLike);
      expect(message).not.toContain(parts[3]);
      expect(message).not.toContain(keyValue);
    }
  });
});
