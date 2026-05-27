export type AppEnv = 'development' | 'test' | 'production';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface EnvValues {
  APP_ENV: AppEnv;
  APP_URL: string;
  LOG_LEVEL: LogLevel;
  DATABASE_URL?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  MICROSOFT_TENANT_ID?: string;
  MICROSOFT_REDIRECT_URI?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ADMIN_ALERT_CHAT_ID?: string;
  ENCRYPTION_KEY?: string;
}

export interface EnvLoadResult {
  ok: boolean;
  values: EnvValues;
  missing: string[];
  warnings: string[];
}

const APP_ENV_VALUES: AppEnv[] = ['development', 'test', 'production'];
const LOG_LEVEL_VALUES: LogLevel[] = ['debug', 'info', 'warn', 'error'];

function pickEnum<T extends string>(
  raw: string | undefined,
  allowed: T[],
  fallback: T,
  warnings: string[],
  key: string,
): T {
  if (raw === undefined || raw === '') return fallback;
  if ((allowed as string[]).includes(raw)) return raw as T;
  warnings.push(`${key} has unsupported value; falling back to "${fallback}"`);
  return fallback;
}

function pickString(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const trimmed = raw.trim();
  return trimmed === '' ? undefined : trimmed;
}

export function loadEnv(
  source: Record<string, string | undefined> = process.env,
): EnvLoadResult {
  const warnings: string[] = [];

  const appEnv = pickEnum(source.APP_ENV, APP_ENV_VALUES, 'development', warnings, 'APP_ENV');
  const logLevel = pickEnum(source.LOG_LEVEL, LOG_LEVEL_VALUES, 'info', warnings, 'LOG_LEVEL');
  const appUrl = pickString(source.APP_URL) ?? 'http://localhost:3000';

  const values: EnvValues = {
    APP_ENV: appEnv,
    APP_URL: appUrl,
    LOG_LEVEL: logLevel,
    DATABASE_URL: pickString(source.DATABASE_URL),
    MICROSOFT_CLIENT_ID: pickString(source.MICROSOFT_CLIENT_ID),
    MICROSOFT_CLIENT_SECRET: pickString(source.MICROSOFT_CLIENT_SECRET),
    MICROSOFT_TENANT_ID: pickString(source.MICROSOFT_TENANT_ID),
    MICROSOFT_REDIRECT_URI: pickString(source.MICROSOFT_REDIRECT_URI),
    TELEGRAM_BOT_TOKEN: pickString(source.TELEGRAM_BOT_TOKEN),
    TELEGRAM_ADMIN_ALERT_CHAT_ID: pickString(source.TELEGRAM_ADMIN_ALERT_CHAT_ID),
    ENCRYPTION_KEY: pickString(source.ENCRYPTION_KEY),
  };

  const productionRequired: (keyof EnvValues)[] = [
    'DATABASE_URL',
    'MICROSOFT_CLIENT_ID',
    'MICROSOFT_CLIENT_SECRET',
    'TELEGRAM_BOT_TOKEN',
    'ENCRYPTION_KEY',
  ];

  const missing: string[] = [];
  if (appEnv === 'production') {
    for (const key of productionRequired) {
      if (!values[key]) missing.push(key);
    }
  }

  return {
    ok: missing.length === 0,
    values,
    missing,
    warnings,
  };
}
