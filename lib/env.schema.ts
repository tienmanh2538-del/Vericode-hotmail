export type AppEnv = 'development' | 'test' | 'production';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export const APP_ENV_VALUES: readonly AppEnv[] = ['development', 'test', 'production'] as const;
export const LOG_LEVEL_VALUES: readonly LogLevel[] = ['debug', 'info', 'warn', 'error'] as const;

export interface EnvValues {
  APP_ENV: AppEnv;
  APP_URL: string;
  LOG_LEVEL: LogLevel;
  DATABASE_URL?: string;
  MICROSOFT_CLIENT_ID?: string;
  MICROSOFT_CLIENT_SECRET?: string;
  MICROSOFT_TENANT_ID?: string;
  MICROSOFT_REDIRECT_URI?: string;
  MICROSOFT_GRAPH_NOTIFICATION_URL?: string;
  MICROSOFT_GRAPH_LIFECYCLE_NOTIFICATION_URL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_ADMIN_ALERT_CHAT_ID?: string;
  ENCRYPTION_KEY?: string;
  AUTH_DEV_DEMO_USER?: string;
  REDIS_URL?: string;
  EMAIL_QUEUE_NAME?: string;
  EMAIL_WORKER_CONCURRENCY?: string;
  DELTA_POLLING_ENABLED?: string;
  DELTA_POLLING_INTERVAL_SECONDS?: string;
  DELTA_POLLING_MAX_PAGES_PER_MAILBOX?: string;
  SUBSCRIPTION_RENEWAL_ENABLED?: string;
  SUBSCRIPTION_RENEWAL_INTERVAL_SECONDS?: string;
  SUBSCRIPTION_RENEWAL_WINDOW_HOURS?: string;
}

export interface EnvLoadResult {
  values: EnvValues;
  warnings: string[];
}

export type EnvKey = keyof EnvValues;

export const MICROSOFT_REQUIRED: EnvKey[] = [
  'MICROSOFT_CLIENT_ID',
  'MICROSOFT_CLIENT_SECRET',
  'MICROSOFT_TENANT_ID',
  'MICROSOFT_REDIRECT_URI',
];

export const TELEGRAM_REQUIRED: EnvKey[] = ['TELEGRAM_BOT_TOKEN'];

export const DATABASE_REQUIRED: EnvKey[] = ['DATABASE_URL'];

export const ENCRYPTION_REQUIRED: EnvKey[] = ['ENCRYPTION_KEY'];

export const GRAPH_SUBSCRIPTION_REQUIRED: EnvKey[] = [
  'MICROSOFT_GRAPH_NOTIFICATION_URL',
];
