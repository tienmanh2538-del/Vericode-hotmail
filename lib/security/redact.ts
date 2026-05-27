import { createHash } from 'node:crypto';

const MIN_KEEP_LENGTH = 8;

export function maskSecret(value: string): string {
  if (value === undefined || value === null) return '';
  const str = String(value);
  if (str.length === 0) return '';
  if (str.length <= MIN_KEEP_LENGTH) return '*'.repeat(str.length);
  const head = str.slice(0, 2);
  const tail = str.slice(-2);
  return `${head}${'*'.repeat(str.length - 4)}${tail}`;
}

export function hashSensitiveValue(value: string): string {
  return createHash('sha256').update(String(value ?? ''), 'utf8').digest('hex');
}

export function maskVerificationCode(code: string): string {
  if (!code) return '';
  return `sha256:${hashSensitiveValue(String(code)).slice(0, 12)}`;
}

const KV_PATTERN =
  /\b(token|secret|password|api[_-]?key|bearer|client[_-]?secret|access[_-]?token|refresh[_-]?token)\s*[=:]\s*([^\s,;"']+)/gi;
const LONG_TOKEN_PATTERN = /\b[A-Za-z0-9_\-]{32,}\b/g;

export function redactSensitiveText(text: string): string {
  if (!text) return '';
  const str = String(text);
  return str
    .replace(KV_PATTERN, (_match, key: string) => `${key}=[REDACTED]`)
    .replace(LONG_TOKEN_PATTERN, '[REDACTED]');
}
