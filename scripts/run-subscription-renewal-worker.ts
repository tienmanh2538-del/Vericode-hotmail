// TASK-032 — CLI entry for the subscription renewal worker.
//
// Usage:
//   tsx scripts/run-subscription-renewal-worker.ts          # long-running scheduler
//   tsx scripts/run-subscription-renewal-worker.ts --once   # single cycle, then exit
//
// The script intentionally has zero side effects on import — the scheduler is
// only started inside main(). This keeps the file safe to import from tooling
// without auto-starting the loop.

import { loadSubscriptionRenewalEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { runSubscriptionRenewalOnce } from '@/services/microsoft/subscription-renewal.service';
import {
  buildDefaultSubscriptionRenewalDeps,
  startSubscriptionRenewalScheduler,
} from '@/services/queue/workers/subscription-renewal-runner';

const logger = createLogger();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runOnce = args.includes('--once');

  const env = loadSubscriptionRenewalEnv();

  if (!env.enabled && !runOnce) {
    logger.warn('Subscription renewal is disabled via SUBSCRIPTION_RENEWAL_ENABLED', {
      intervalSeconds: env.intervalSeconds,
    });
    return;
  }

  if (runOnce) {
    const deps = buildDefaultSubscriptionRenewalDeps();
    const result = await runSubscriptionRenewalOnce(deps);
    logger.info('Subscription renewal single cycle completed', { ...result });
    return;
  }

  const handle = startSubscriptionRenewalScheduler({
    intervalMs: env.intervalSeconds * 1_000,
  });

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('Subscription renewal worker received shutdown signal', { signal });
    try {
      await handle.stop();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', (signal) => {
    void shutdown(signal);
  });
  process.on('SIGTERM', (signal) => {
    void shutdown(signal);
  });
}

main().catch((error) => {
  logger.error('Subscription renewal worker entry failed', {
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
  process.exit(1);
});
