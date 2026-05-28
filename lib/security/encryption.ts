import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH_BYTES = 32;
const IV_LENGTH_BYTES = 12;
const AUTH_TAG_LENGTH_BYTES = 16;
const VERSION = 'v1';
const BASE64_PATTERN = /^[A-Za-z0-9+/]+={0,2}$/;

const KEY_GENERATION_HINT =
  'Generate one with: node -e "console.log(require(\'node:crypto\').randomBytes(32).toString(\'base64\'))"';

export class EncryptionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EncryptionError';
  }
}

export function validateEncryptionKey(rawKey: string | undefined): Buffer {
  if (rawKey === undefined || rawKey === null) {
    throw new EncryptionError(
      `ENCRYPTION_KEY is not configured. ${KEY_GENERATION_HINT}`,
    );
  }
  const trimmed = String(rawKey).trim();
  if (trimmed === '') {
    throw new EncryptionError(
      `ENCRYPTION_KEY is empty. ${KEY_GENERATION_HINT}`,
    );
  }
  if (!BASE64_PATTERN.test(trimmed)) {
    throw new EncryptionError('ENCRYPTION_KEY is not a valid base64 string');
  }

  const decoded = Buffer.from(trimmed, 'base64');
  if (decoded.toString('base64') !== trimmed) {
    throw new EncryptionError('ENCRYPTION_KEY is not a valid base64 string');
  }
  if (decoded.length !== KEY_LENGTH_BYTES) {
    throw new EncryptionError(
      `ENCRYPTION_KEY must decode to exactly ${KEY_LENGTH_BYTES} bytes`,
    );
  }
  return decoded;
}

function resolveKey(): Buffer {
  return validateEncryptionKey(process.env.ENCRYPTION_KEY);
}

export function encryptSecret(plaintext: string): string {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new EncryptionError('encryptSecret requires a non-empty string');
  }

  const key = resolveKey();
  const iv = randomBytes(IV_LENGTH_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64'),
    authTag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

function decodeBase64Strict(value: string): Buffer {
  if (!BASE64_PATTERN.test(value)) {
    throw new EncryptionError('Encrypted payload is malformed');
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64') !== value) {
    throw new EncryptionError('Encrypted payload is malformed');
  }
  return decoded;
}

export function decryptSecret(encryptedPayload: string): string {
  if (typeof encryptedPayload !== 'string' || encryptedPayload.length === 0) {
    throw new EncryptionError('decryptSecret requires a non-empty string');
  }

  const parts = encryptedPayload.split(':');
  if (parts.length !== 4) {
    throw new EncryptionError('Encrypted payload is malformed');
  }

  const [version, ivB64, tagB64, ctB64] = parts;
  if (version !== VERSION) {
    throw new EncryptionError('Unsupported encrypted payload version');
  }

  const iv = decodeBase64Strict(ivB64);
  const authTag = decodeBase64Strict(tagB64);
  const ciphertext = decodeBase64Strict(ctB64);

  if (
    iv.length !== IV_LENGTH_BYTES ||
    authTag.length !== AUTH_TAG_LENGTH_BYTES ||
    ciphertext.length === 0
  ) {
    throw new EncryptionError('Encrypted payload is malformed');
  }

  const key = resolveKey();
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);

  let plaintext: Buffer;
  try {
    plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new EncryptionError('Failed to decrypt payload');
  }

  return plaintext.toString('utf8');
}
