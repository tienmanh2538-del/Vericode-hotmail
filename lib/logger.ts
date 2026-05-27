import { maskSecret, redactSensitiveText } from './security/redact';
import type { LogLevel } from './env.schema';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEYS = new Set([
  'token',
  'accesstoken',
  'refreshtoken',
  'password',
  'secret',
  'clientsecret',
  'code',
  'verificationcode',
  'telegrambottoken',
  'apikey',
  'encryptionkey',
  'authorization',
]);

const BODY_KEYS = new Set(['body', 'emailbody', 'html', 'text']);
const BODY_PREVIEW_LIMIT = 64;
const MAX_DEPTH = 4;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-]/g, '');
}

export interface Logger {
  debug: (msg: string, context?: Record<string, unknown>) => void;
  info: (msg: string, context?: Record<string, unknown>) => void;
  warn: (msg: string, context?: Record<string, unknown>) => void;
  error: (msg: string, context?: Record<string, unknown>) => void;
}

export interface LoggerOptions {
  level?: LogLevel;
  sink?: {
    debug: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
  };
}

export function sanitize(input: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[Truncated]';
  if (input === null || input === undefined) return input;
  if (typeof input === 'string') return redactSensitiveText(input);
  if (typeof input === 'number' || typeof input === 'boolean') return input;
  if (Array.isArray(input)) return input.map((item) => sanitize(item, depth + 1));
  if (typeof input === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      const norm = normalizeKey(key);
      if (SENSITIVE_KEYS.has(norm)) {
        result[key] = typeof value === 'string' ? maskSecret(value) : '[Redacted]';
      } else if (BODY_KEYS.has(norm) && typeof value === 'string') {
        const preview = value.slice(0, BODY_PREVIEW_LIMIT);
        result[key] = `${redactSensitiveText(preview)}${value.length > BODY_PREVIEW_LIMIT ? '…[truncated]' : ''}`;
      } else {
        result[key] = sanitize(value, depth + 1);
      }
    }
    return result;
  }
  return '[Unloggable]';
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? 'info';
  const minRank = LEVEL_RANK[level];
  const sink = options.sink ?? {
    debug: console.debug.bind(console),
    info: console.info.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
  };

  function emit(target: LogLevel, msg: string, context?: Record<string, unknown>): void {
    if (LEVEL_RANK[target] < minRank) return;
    const safeMsg = redactSensitiveText(msg);
    const safeContext = context ? sanitize(context) : undefined;
    const line = `[${target}] ${safeMsg}`;
    if (safeContext === undefined) {
      sink[target](line);
    } else {
      sink[target](line, safeContext);
    }
  }

  return {
    debug: (msg, ctx) => emit('debug', msg, ctx),
    info: (msg, ctx) => emit('info', msg, ctx),
    warn: (msg, ctx) => emit('warn', msg, ctx),
    error: (msg, ctx) => emit('error', msg, ctx),
  };
}
