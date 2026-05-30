// TASK-040 preflight — CLI entry for the production email worker.
//
// Usage:
//   tsx scripts/run-email-worker.ts        # long-running BullMQ worker
//   npm run worker:email
//
// The worker consumes PROCESS_MICROSOFT_GRAPH_MESSAGE jobs (enqueued by the
// webhook receiver and the delta-polling backup) and runs the REAL pipeline:
//   load mailbox → refresh token (persist rotated refresh token) → fetch Graph
//   message → Facebook/Meta detector → code extractor → dedupe → Telegram send.
//
// Zero side effects on import — the worker is only created inside main().

import { createLogger } from '@/lib/logger';
import { createEmailWorker } from '@/services/queue/workers/email-worker';
import { buildDefaultEmailPipeline } from '@/services/queue/workers/email-worker-runner';

const logger = createLogger();

async function main(): Promise<void> {
  // Build the real pipeline explicitly so a wiring failure surfaces here at
  // startup rather than on the first job.
  const pipeline = buildDefaultEmailPipeline();
  const worker = createEmailWorker({ pipeline });

  logger.info('Email worker started — consuming Microsoft Graph message jobs');

  let stopping = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (stopping) return;
    stopping = true;
    logger.info('Email worker received shutdown signal', { signal });
    try {
      await worker.close();
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
  logger.error('Email worker entry failed', {
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
  process.exit(1);
});
