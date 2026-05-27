import { maskSecret } from './mask';
import type { LogLevel } from './env';

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const SENSITIVE_KEY = /token|secret|password|code|key|auth/i;
const MAX_DEPTH = 4;

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
  if (typeof input === 'string' || typeof input === 'number' || typeof input === 'boolean') {
    return input;
  }
  if (Array.isArray(input)) {
    return input.map((item) => sanitize(item, depth + 1));
  }
  if (typeof input === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEY.test(key)) {
        result[key] = typeof value === 'string' ? maskSecret(value) : '[Redacted]';
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
    const safeContext = context ? sanitize(context) : undefined;
    const line = `[${target}] ${msg}`;
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
