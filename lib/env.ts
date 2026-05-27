import {
  APP_ENV_VALUES,
  DATABASE_REQUIRED,
  ENCRYPTION_REQUIRED,
  LOG_LEVEL_VALUES,
  MICROSOFT_REQUIRED,
  TELEGRAM_REQUIRED,
  type AppEnv,
  type EnvKey,
  type EnvLoadResult,
  type EnvValues,
  type LogLevel,
} from './env.schema';

function pickEnum<T extends string>(
  raw: string | undefined,
  allowed: readonly T[],
  fallback: T,
  warnings: string[],
  key: string,
): T {
  if (raw === undefined || raw === '') return fallback;
  if ((allowed as readonly string[]).includes(raw)) return raw as T;
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

  const appEnv: AppEnv = pickEnum(
    source.APP_ENV,
    APP_ENV_VALUES,
    'development',
    warnings,
    'APP_ENV',
  );
  const logLevel: LogLevel = pickEnum(
    source.LOG_LEVEL,
    LOG_LEVEL_VALUES,
    'info',
    warnings,
    'LOG_LEVEL',
  );
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

  return { values, warnings };
}

export class MissingEnvError extends Error {
  readonly missing: EnvKey[];
  readonly module: string;

  constructor(moduleName: string, missing: EnvKey[]) {
    super(
      `Missing required environment variables for ${moduleName}: ${missing.join(', ')}`,
    );
    this.name = 'MissingEnvError';
    this.module = moduleName;
    this.missing = missing;
  }
}

function assertRequired(
  moduleName: string,
  values: EnvValues,
  keys: EnvKey[],
): void {
  const missing = keys.filter((k) => !values[k]);
  if (missing.length > 0) throw new MissingEnvError(moduleName, missing);
}

export function requireMicrosoftEnv(values: EnvValues = loadEnv().values): {
  clientId: string;
  clientSecret: string;
  tenantId: string;
  redirectUri: string;
} {
  assertRequired('microsoft-oauth', values, MICROSOFT_REQUIRED);
  return {
    clientId: values.MICROSOFT_CLIENT_ID as string,
    clientSecret: values.MICROSOFT_CLIENT_SECRET as string,
    tenantId: values.MICROSOFT_TENANT_ID as string,
    redirectUri: values.MICROSOFT_REDIRECT_URI as string,
  };
}

export function requireTelegramEnv(values: EnvValues = loadEnv().values): {
  botToken: string;
  adminAlertChatId?: string;
} {
  assertRequired('telegram', values, TELEGRAM_REQUIRED);
  return {
    botToken: values.TELEGRAM_BOT_TOKEN as string,
    adminAlertChatId: values.TELEGRAM_ADMIN_ALERT_CHAT_ID,
  };
}

export function requireDatabaseEnv(values: EnvValues = loadEnv().values): {
  url: string;
} {
  assertRequired('database', values, DATABASE_REQUIRED);
  return { url: values.DATABASE_URL as string };
}

export function requireEncryptionEnv(values: EnvValues = loadEnv().values): {
  key: string;
} {
  assertRequired('encryption', values, ENCRYPTION_REQUIRED);
  return { key: values.ENCRYPTION_KEY as string };
}

export type { AppEnv, EnvLoadResult, EnvValues, LogLevel, EnvKey };
