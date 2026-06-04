import {
  APP_ENV_VALUES,
  DATABASE_REQUIRED,
  ENCRYPTION_REQUIRED,
  GRAPH_SUBSCRIPTION_REQUIRED,
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
    MICROSOFT_GRAPH_NOTIFICATION_URL: pickString(
      source.MICROSOFT_GRAPH_NOTIFICATION_URL,
    ),
    MICROSOFT_GRAPH_LIFECYCLE_NOTIFICATION_URL: pickString(
      source.MICROSOFT_GRAPH_LIFECYCLE_NOTIFICATION_URL,
    ),
    TELEGRAM_BOT_TOKEN: pickString(source.TELEGRAM_BOT_TOKEN),
    TELEGRAM_ADMIN_ALERT_CHAT_ID: pickString(source.TELEGRAM_ADMIN_ALERT_CHAT_ID),
    ENCRYPTION_KEY: pickString(source.ENCRYPTION_KEY),
    AUTH_DEV_DEMO_USER: pickString(source.AUTH_DEV_DEMO_USER),
    STAGING_ADMIN_PASSWORD: pickString(source.STAGING_ADMIN_PASSWORD),
    STAGING_ADMIN_SESSION_SECRET: pickString(source.STAGING_ADMIN_SESSION_SECRET),
    REDIS_URL: pickString(source.REDIS_URL),
    EMAIL_QUEUE_NAME: pickString(source.EMAIL_QUEUE_NAME),
    EMAIL_WORKER_CONCURRENCY: pickString(source.EMAIL_WORKER_CONCURRENCY),
    EMAIL_WORKER_RATE_MAX: pickString(source.EMAIL_WORKER_RATE_MAX),
    EMAIL_WORKER_RATE_DURATION_MS: pickString(source.EMAIL_WORKER_RATE_DURATION_MS),
    DELTA_POLLING_ENABLED: pickString(source.DELTA_POLLING_ENABLED),
    DELTA_POLLING_INTERVAL_SECONDS: pickString(
      source.DELTA_POLLING_INTERVAL_SECONDS,
    ),
    DELTA_POLLING_MAX_PAGES_PER_MAILBOX: pickString(
      source.DELTA_POLLING_MAX_PAGES_PER_MAILBOX,
    ),
    DELTA_POLLING_BOOTSTRAP_LOOKBACK_HOURS: pickString(
      source.DELTA_POLLING_BOOTSTRAP_LOOKBACK_HOURS,
    ),
    SUBSCRIPTION_RENEWAL_ENABLED: pickString(
      source.SUBSCRIPTION_RENEWAL_ENABLED,
    ),
    SUBSCRIPTION_RENEWAL_INTERVAL_SECONDS: pickString(
      source.SUBSCRIPTION_RENEWAL_INTERVAL_SECONDS,
    ),
    SUBSCRIPTION_RENEWAL_WINDOW_HOURS: pickString(
      source.SUBSCRIPTION_RENEWAL_WINDOW_HOURS,
    ),
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

export function requireGraphSubscriptionEnv(
  values: EnvValues = loadEnv().values,
): {
  notificationUrl: string;
  lifecycleNotificationUrl?: string;
} {
  assertRequired('graph-subscription', values, GRAPH_SUBSCRIPTION_REQUIRED);
  return {
    notificationUrl: values.MICROSOFT_GRAPH_NOTIFICATION_URL as string,
    lifecycleNotificationUrl: values.MICROSOFT_GRAPH_LIFECYCLE_NOTIFICATION_URL,
  };
}

const DEFAULT_REDIS_URL = 'redis://127.0.0.1:6379';
const DEFAULT_EMAIL_QUEUE_NAME = 'email-processing';
const DEFAULT_EMAIL_WORKER_CONCURRENCY = 2;
// TASK-068B — upper clamp on email-worker concurrency. The baseline (TASK-054)
// is 2; scaling toward ~100 mailboxes may raise it, but an unbounded value would
// let one process open too many parallel Graph/Telegram calls and trip provider
// rate limits. Anything above this cap is clamped down (safe default preserved).
export const MAX_EMAIL_WORKER_CONCURRENCY = 20;

export function loadQueueEnv(values: EnvValues = loadEnv().values): {
  redisUrl: string;
  emailQueueName: string;
  emailWorkerConcurrency: number;
} {
  const redisUrl = values.REDIS_URL ?? DEFAULT_REDIS_URL;
  const emailQueueName = values.EMAIL_QUEUE_NAME ?? DEFAULT_EMAIL_QUEUE_NAME;
  const rawConcurrency = values.EMAIL_WORKER_CONCURRENCY;
  let emailWorkerConcurrency = DEFAULT_EMAIL_WORKER_CONCURRENCY;
  if (rawConcurrency !== undefined) {
    const parsed = Number.parseInt(rawConcurrency, 10);
    if (Number.isFinite(parsed) && parsed > 0) {
      // Clamp to the safe upper bound — never below 1, never above the cap.
      emailWorkerConcurrency = Math.min(parsed, MAX_EMAIL_WORKER_CONCURRENCY);
    }
  }
  return { redisUrl, emailQueueName, emailWorkerConcurrency };
}

// TASK-068B — queue-level rate limiter for the email worker. Conservative
// defaults: at most 20 jobs may START per 1s window. This is a ceiling that
// smooths bursts (webhook + delta polling overlapping at ~100 mailboxes) so the
// worker never stampedes Microsoft Graph / Telegram; it does NOT fail or retry
// jobs — BullMQ simply delays the next job until the window frees up.
const DEFAULT_EMAIL_WORKER_RATE_MAX = 20;
const DEFAULT_EMAIL_WORKER_RATE_DURATION_MS = 1_000;
const MIN_EMAIL_WORKER_RATE_MAX = 1;
const MIN_EMAIL_WORKER_RATE_DURATION_MS = 100;

export function loadEmailWorkerRateLimitEnv(
  values: EnvValues = loadEnv().values,
): { max: number; durationMs: number } {
  const max = parsePositiveIntEnv(
    values.EMAIL_WORKER_RATE_MAX,
    DEFAULT_EMAIL_WORKER_RATE_MAX,
    MIN_EMAIL_WORKER_RATE_MAX,
  );
  const durationMs = parsePositiveIntEnv(
    values.EMAIL_WORKER_RATE_DURATION_MS,
    DEFAULT_EMAIL_WORKER_RATE_DURATION_MS,
    MIN_EMAIL_WORKER_RATE_DURATION_MS,
  );
  return { max, durationMs };
}

// TASK-031 — delta polling backup worker config. Defaults mirror the spec:
// enabled by default, 30s interval, max 10 Graph delta pages per mailbox.
const DEFAULT_DELTA_POLLING_ENABLED = true;
const DEFAULT_DELTA_POLLING_INTERVAL_SECONDS = 30;
const DEFAULT_DELTA_POLLING_MAX_PAGES_PER_MAILBOX = 10;
const MIN_DELTA_POLLING_INTERVAL_SECONDS = 5;
const MIN_DELTA_POLLING_MAX_PAGES = 1;
// TASK-036 — bootstrap (first-run) delta sync is time-bounded so a very large
// mailbox never triggers an unbounded historical scan. Microsoft Graph supports
// $filter=receivedDateTime ge {ts} on the messages delta query (and caps such a
// filtered query at 5,000 messages). Default: 24h lookback. Safe default keeps
// local dev / CI working with no env set.
const DEFAULT_DELTA_POLLING_BOOTSTRAP_LOOKBACK_HOURS = 24;
const MIN_DELTA_POLLING_BOOTSTRAP_LOOKBACK_HOURS = 1;

function parseBoolEnv(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined) return fallback;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes') return true;
  if (normalized === 'false' || normalized === '0' || normalized === 'no') return false;
  return fallback;
}

function parsePositiveIntEnv(
  raw: string | undefined,
  fallback: number,
  minimum: number,
): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < minimum) return minimum;
  return parsed;
}

export function loadDeltaPollingEnv(values: EnvValues = loadEnv().values): {
  enabled: boolean;
  intervalSeconds: number;
  maxPagesPerMailbox: number;
  bootstrapLookbackHours: number;
} {
  const enabled = parseBoolEnv(
    values.DELTA_POLLING_ENABLED,
    DEFAULT_DELTA_POLLING_ENABLED,
  );
  const intervalSeconds = parsePositiveIntEnv(
    values.DELTA_POLLING_INTERVAL_SECONDS,
    DEFAULT_DELTA_POLLING_INTERVAL_SECONDS,
    MIN_DELTA_POLLING_INTERVAL_SECONDS,
  );
  const maxPagesPerMailbox = parsePositiveIntEnv(
    values.DELTA_POLLING_MAX_PAGES_PER_MAILBOX,
    DEFAULT_DELTA_POLLING_MAX_PAGES_PER_MAILBOX,
    MIN_DELTA_POLLING_MAX_PAGES,
  );
  const bootstrapLookbackHours = parsePositiveIntEnv(
    values.DELTA_POLLING_BOOTSTRAP_LOOKBACK_HOURS,
    DEFAULT_DELTA_POLLING_BOOTSTRAP_LOOKBACK_HOURS,
    MIN_DELTA_POLLING_BOOTSTRAP_LOOKBACK_HOURS,
  );
  return { enabled, intervalSeconds, maxPagesPerMailbox, bootstrapLookbackHours };
}

// TASK-032 — subscription renewal worker config. Defaults mirror the spec:
// enabled by default, runs every 15 minutes, renews when a subscription has
// <= 24h left before Microsoft expires it.
const DEFAULT_SUBSCRIPTION_RENEWAL_ENABLED = true;
const DEFAULT_SUBSCRIPTION_RENEWAL_INTERVAL_SECONDS = 15 * 60;
const DEFAULT_SUBSCRIPTION_RENEWAL_WINDOW_HOURS = 24;
const MIN_SUBSCRIPTION_RENEWAL_INTERVAL_SECONDS = 60;
const MIN_SUBSCRIPTION_RENEWAL_WINDOW_HOURS = 1;

export function loadSubscriptionRenewalEnv(
  values: EnvValues = loadEnv().values,
): {
  enabled: boolean;
  intervalSeconds: number;
  windowHours: number;
  renewWithinMs: number;
} {
  const enabled = parseBoolEnv(
    values.SUBSCRIPTION_RENEWAL_ENABLED,
    DEFAULT_SUBSCRIPTION_RENEWAL_ENABLED,
  );
  const intervalSeconds = parsePositiveIntEnv(
    values.SUBSCRIPTION_RENEWAL_INTERVAL_SECONDS,
    DEFAULT_SUBSCRIPTION_RENEWAL_INTERVAL_SECONDS,
    MIN_SUBSCRIPTION_RENEWAL_INTERVAL_SECONDS,
  );
  const windowHours = parsePositiveIntEnv(
    values.SUBSCRIPTION_RENEWAL_WINDOW_HOURS,
    DEFAULT_SUBSCRIPTION_RENEWAL_WINDOW_HOURS,
    MIN_SUBSCRIPTION_RENEWAL_WINDOW_HOURS,
  );
  return {
    enabled,
    intervalSeconds,
    windowHours,
    renewWithinMs: windowHours * 60 * 60 * 1000,
  };
}

export type { AppEnv, EnvLoadResult, EnvValues, LogLevel, EnvKey };
