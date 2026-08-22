// TASK-082 — One-shot operator CLI for Graph subscription reconciliation.
//
// Usage:
//   tsx scripts/run-subscription-reconciliation.ts                 # DRY-RUN (default)
//   tsx scripts/run-subscription-reconciliation.ts --limit 10     # dry-run, larger batch
//   tsx scripts/run-subscription-reconciliation.ts --apply        # mutating run
//   tsx scripts/run-subscription-reconciliation.ts --apply --limit 10
//
// Semantics (locked in docs/tasks/TASK-082):
//   - Never scheduled, never wired into deploy/startup/workers — it only runs
//     when an operator invokes it, and each invocation is a single pass.
//   - Default is a strictly non-mutating dry run; only --apply mutates.
//   - The batch is bounded (default 5) with a code-level hard maximum; larger
//     --limit values are deterministically clamped. Processing is sequential.

import { createLogger } from '@/lib/logger';
import { runSubscriptionReconciliationOnce } from '@/services/microsoft/subscription-reconciliation.service';
import {
  buildDefaultSubscriptionReconciliationDeps,
  parseReconciliationCliArgs,
} from '@/services/queue/workers/subscription-reconciliation-runner';

const logger = createLogger();

async function main(): Promise<void> {
  const parsed = parseReconciliationCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    logger.error('Subscription reconciliation CLI rejected arguments', {
      reason: parsed.error,
    });
    process.exitCode = 1;
    return;
  }

  const { mode, limit, limitClamped } = parsed.options;
  if (limitClamped) {
    logger.warn('Requested limit exceeds the hard maximum — clamped', { limit });
  }

  const deps = buildDefaultSubscriptionReconciliationDeps();
  const result = await runSubscriptionReconciliationOnce(deps, { mode, limit });

  // Sanitized summary only: counters + internal mailbox IDs, never email
  // addresses, tokens, or clientState.
  logger.info('Subscription reconciliation run completed', {
    mode: result.mode,
    limit: result.limit,
    candidateCount: result.candidateCount,
    checkedCount: result.checkedCount,
    createdCount: result.createdCount,
    skippedExistingCount: result.skippedExistingCount,
    skippedNotActiveCount: result.skippedNotActiveCount,
    reconnectRequiredCount: result.reconnectRequiredCount,
    transientFailureCount: result.transientFailureCount,
    failedCount: result.failedCount,
    disconnectRaceCount: result.disconnectRaceCount,
    aborted: result.aborted,
  });
  for (const record of result.outcomes) {
    logger.info('Reconciliation outcome', {
      mailboxId: record.mailboxId,
      outcome: record.outcome,
      remoteCleanup: record.remoteCleanup,
    });
  }

  if (result.aborted) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  logger.error('Subscription reconciliation CLI failed', {
    errorName: error instanceof Error ? error.name : 'UnknownError',
  });
  process.exitCode = 1;
});
