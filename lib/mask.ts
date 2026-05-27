import { createHash } from 'node:crypto';

const MIN_KEEP_LENGTH = 8;

export function maskSecret(value: string | undefined | null, visible = 2): string {
  if (value === undefined || value === null) return '';
  const str = String(value);
  if (str.length === 0) return '';
  if (str.length <= MIN_KEEP_LENGTH || visible <= 0) {
    return '*'.repeat(Math.max(str.length, 1));
  }
  const head = str.slice(0, visible);
  const tail = str.slice(-visible);
  const middle = '*'.repeat(Math.max(str.length - visible * 2, 1));
  return `${head}${middle}${tail}`;
}

export function hashCode(code: string): string {
  return createHash('sha256').update(code, 'utf8').digest('hex');
}

export function maskCode(code: string | undefined | null): string {
  if (!code) return '';
  return `sha256:${hashCode(String(code)).slice(0, 12)}`;
}
