// TASK-031 — CLI entry for the delta polling backup worker.
//
// Usage:
//   tsx scripts/run-delta-polling-worker.ts          # long-running scheduler
//   tsx scripts/run-delta-polling-worker.ts --once   # single cycle, then exit
//
// The script intentionally has zero side effects on import — the scheduler
// is only started inside main(). This keeps the file safe to import from
// other tooling without auto-starting the loop.

import { loadDeltaPollingEnv } from '@/lib/env';
import { createLogger } from '@/lib/logger';
import { runDeltaPollingOnce } from '@/services/microsoft/delta-polling.service';
import {
  buildDefaultDeltaPollingDeps,
  startDeltaPollingScheduler,
} from '@/services/queue/workers/delta-polling-runner';

const logger = createLogger();

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const runOnce = args.includes('--once');

  const env = loadDeltaPollingEnv();

  if (!env.enabled && !runOnce) {
    logger.warn('Delta polling is disabled via DELTA_POLLING_ENABLED', {
      intervalSeconds: env.intervalSeconds,
    });
    return;
  }

  if (runOnce) {
    const deps = buildDefaultDeltaPollingDeps();
    const result = await runDeltaPollingOnce(deps);
    logger.info('Delta polling single cycle completed', {
      ...result,
    });
    return;
  }

  const handle = startDeltaPollingScheduler({
    intervalMs: env.intervalSeconds * 1_000,
  });

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('Delta polling worker received shutdown signal', { signal });
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
  logger.error('Delta polling worker entry failed', {
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
  process.exit(1);
});
