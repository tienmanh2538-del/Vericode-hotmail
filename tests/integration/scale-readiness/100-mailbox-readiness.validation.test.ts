// TASK-068D — 100-Mailbox Readiness Validation (synthetic, staging-safe).
//
// This integration test proves the system is ready to BEGIN testing at the
// ~100-mailbox mark, using ONLY synthetic data. It drives the REAL worker +
// pipeline code path (TASK-027/055/068A/068B/068C seams) with mocked Microsoft
// Graph and mocked Telegram boundaries — no real Graph/Telegram call, no real
// mailbox/customer/chat, no real token, and no real verification code.
//
// Scenarios (see docs/tasks/TASK-068D-...):
//   A — ~100 ready mailboxes process synthetic verification messages → all sent.
//   B — webhook + delta duplicate for the same graphMessageId → exactly one send.
//   C — many mailboxes sharing a destination route correctly, never broadcast.
//   D — DISABLED / unmapped mailboxes never relay (safe skip).
//   E — busy/defer + throttle/backpressure are bounded (no infinite retry/wait).
//   F — observability aggregate is safe: numbers only, no payload/email/code/token.
//
// WHY dynamic import of the worker in beforeEach: the email-worker module binds
// a module-level logger to `console.*` at import time. Importing it fresh after
// the console spies are installed keeps the (noisy, per-job) worker logs out of
// the test output. The pipeline itself logs through a captured, sanitized sink
// injected by the harness, which Scenario F asserts on.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import type { GraphMessagePipelineResult } from '@/services/email/graph-message-pipeline.service';
import {
  buildSyntheticDataset,
  createScaleHarness,
  makeDeltaJob,
  makeJobClock,
  makeWebhookJob,
  FAKE_ACCESS_TOKEN,
  type MinimalJob,
  type ScaleHarness,
  type SyntheticDataset,
} from '@/tests/helpers/scale-readiness-fixtures';
import { DEFAULT_DESTINATION_MAX_WAIT_MS } from '@/services/queue/destination-throttle';
import { DEFAULT_GLOBAL_SEND_MAX_WAIT_MS } from '@/services/queue/global-send-throttle';

let workerMod: typeof import('@/services/queue/workers/email-worker');

beforeEach(async () => {
  vi.spyOn(console, 'debug').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});

  // Re-evaluate the worker module so its module-level logger binds to the
  // silenced console installed above.
  vi.resetModules();
  workerMod = await import('@/services/queue/workers/email-worker');
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Drive one job through the REAL worker function and unwrap the safe envelope
// the worker re-throws for retryable (FAILED_*/DEFERRED_*) statuses.
async function runWorkerJob(
  harness: ScaleHarness,
  job: MinimalJob,
): Promise<GraphMessagePipelineResult> {
  try {
    const result = await workerMod.processEmailWebhookJob(
      job as unknown as Parameters<typeof workerMod.processEmailWebhookJob>[0],
      harness.pipeline,
      { metrics: harness.metrics.recorder, now: makeJobClock() },
    );
    return result as GraphMessagePipelineResult;
  } catch (err) {
    if (err instanceof workerMod.EmailWorkerProcessingError) {
      return err.result;
    }
    throw err;
  }
}

function destinationKey(chatId: string, threadId: string | undefined): string {
  return `${chatId}::${threadId ?? ''}`;
}

// Collect every synthetic secret-shaped value so leak assertions are exhaustive.
function collectSyntheticSecrets(dataset: SyntheticDataset): string[] {
  const values = new Set<string>();
  values.add(FAKE_ACCESS_TOKEN);
  for (const mailbox of dataset.mailboxes) {
    values.add(mailbox.verificationCode);
    values.add(mailbox.emailAddress);
    if (mailbox.destinationChatId) values.add(mailbox.destinationChatId);
  }
  return [...values];
}

describe('TASK-068D — 100-mailbox readiness validation (synthetic)', () => {
  it('Scenario A — ~100 ready mailboxes each relay their synthetic code exactly once', async () => {
    const dataset = buildSyntheticDataset();
    const harness = createScaleHarness(dataset);

    expect(dataset.ready.length).toBe(100);

    const results: GraphMessagePipelineResult[] = [];
    for (const mailbox of dataset.ready) {
      const job = makeWebhookJob(mailbox.id, mailbox.graphMessageId);
      results.push(await runWorkerJob(harness, job));
    }

    // Every ready mailbox produced exactly one CODE_SENT to its own destination.
    expect(results.every((r) => r.status === 'CODE_SENT')).toBe(true);
    expect(results.every((r) => r.sentToTelegram === true)).toBe(true);
    expect(harness.sends.length).toBe(dataset.ready.length);

    // Each send targeted the mailbox's mapped chat id (not a fallback/broadcast).
    for (let i = 0; i < dataset.ready.length; i += 1) {
      expect(harness.sends[i].chatId).toBe(dataset.ready[i].destinationChatId);
    }

    // Every message is recorded SENT exactly once in the dedup store.
    for (const mailbox of dataset.ready) {
      const row = await harness.store.findByGraphMessageId(
        mailbox.id,
        mailbox.graphMessageId,
      );
      expect(row?.status).toBe('SENT');
      expect(row?.sentToTelegramAt).not.toBeNull();
    }

    // Worker metrics: all jobs classified completed, none failed/deferred.
    const snapshot = harness.snapshot();
    expect(snapshot.jobs?.completed).toBe(dataset.ready.length);
    expect(snapshot.jobs?.failed).toBe(0);
    expect(snapshot.jobs?.deferred).toBe(0);
    expect(snapshot.jobs?.skipped).toBe(0);
  });

  it('Scenario B — webhook + delta duplicate for one graphMessageId yields a single send', async () => {
    const dataset = buildSyntheticDataset();
    const harness = createScaleHarness(dataset);
    const mailbox = dataset.ready[0];

    // 1) Webhook surfaces the message and relays it.
    const first = await runWorkerJob(
      harness,
      makeWebhookJob(mailbox.id, mailbox.graphMessageId, { jobId: 'wh-1' }),
    );
    expect(first.status).toBe('CODE_SENT');
    expect(first.sentToTelegram).toBe(true);

    // 2) Delta polling independently surfaces the SAME graphMessageId.
    const second = await runWorkerJob(
      harness,
      makeDeltaJob(mailbox.id, mailbox.graphMessageId, { jobId: 'delta-1' }),
    );
    expect(second.status).toBe('SKIPPED_DUPLICATE');
    expect(second.sentToTelegram).toBe(false);
    expect(second.reason).toBe('duplicate_graph_message_id');

    // The mock Telegram sender fired exactly once across both ingestion paths.
    expect(harness.sends.length).toBe(1);

    const row = await harness.store.findByGraphMessageId(
      mailbox.id,
      mailbox.graphMessageId,
    );
    expect(row?.status).toBe('SENT');

    const snapshot = harness.snapshot();
    expect(snapshot.jobs?.completed).toBe(1);
    expect(snapshot.jobs?.skipped).toBe(1);
  });

  it('Scenario C — many mailboxes sharing a destination route correctly, never broadcast', async () => {
    const dataset = buildSyntheticDataset();
    const harness = createScaleHarness(dataset);

    // Confirm the dataset genuinely reuses destinations across many mailboxes.
    const distinctDestinations = new Set(
      dataset.ready.map((m) =>
        destinationKey(m.destinationChatId!, m.destinationThreadId ?? undefined),
      ),
    );
    expect(distinctDestinations.size).toBeLessThan(dataset.ready.length);
    expect(distinctDestinations.size).toBe(dataset.destinations.length);

    for (const mailbox of dataset.ready) {
      await runWorkerJob(harness, makeWebhookJob(mailbox.id, mailbox.graphMessageId));
    }

    // NO broadcast: exactly one send per processed message.
    expect(harness.sends.length).toBe(dataset.ready.length);

    // Per-destination send counts match the per-destination mailbox assignment.
    const expected = new Map<string, number>();
    for (const mailbox of dataset.ready) {
      const key = destinationKey(
        mailbox.destinationChatId!,
        mailbox.destinationThreadId ?? undefined,
      );
      expected.set(key, (expected.get(key) ?? 0) + 1);
    }
    const actual = new Map<string, number>();
    for (const send of harness.sends) {
      const key = destinationKey(send.chatId, send.threadId);
      actual.set(key, (actual.get(key) ?? 0) + 1);
    }
    expect(actual).toEqual(expected);

    // Every send went to a known destination chat id (no stray/fallback chat).
    const knownChats = new Set(dataset.destinations.map((d) => d.chatId));
    expect(harness.sends.every((s) => knownChats.has(s.chatId))).toBe(true);
  });

  it('Scenario D — DISABLED and unmapped mailboxes never relay', async () => {
    const dataset = buildSyntheticDataset();
    const harness = createScaleHarness(dataset);

    const disabledResults: GraphMessagePipelineResult[] = [];
    for (const mailbox of dataset.disabled) {
      disabledResults.push(
        await runWorkerJob(harness, makeWebhookJob(mailbox.id, mailbox.graphMessageId)),
      );
    }

    const unmappedResults: GraphMessagePipelineResult[] = [];
    for (const mailbox of dataset.unmapped) {
      unmappedResults.push(
        await runWorkerJob(harness, makeWebhookJob(mailbox.id, mailbox.graphMessageId)),
      );
    }

    // DISABLED mailboxes skip before any Graph/Telegram work.
    expect(
      disabledResults.every((r) => r.status === 'SKIPPED_MAILBOX_NOT_ACTIVE'),
    ).toBe(true);
    // ACTIVE-but-unmapped mailboxes skip before sending (no fallback chat).
    expect(
      unmappedResults.every((r) => r.status === 'SKIPPED_NO_TELEGRAM_MAPPING'),
    ).toBe(true);

    // Nothing was relayed for either group.
    expect(harness.sends.length).toBe(0);

    // These are deterministic skips, never failures (so the worker won't retry).
    const snapshot = harness.snapshot();
    expect(snapshot.jobs?.skipped).toBe(
      dataset.disabled.length + dataset.unmapped.length,
    );
    expect(snapshot.jobs?.failed).toBe(0);
  });

  it('Scenario E — mailbox-busy defer is bounded and the message is still delivered once', async () => {
    const dataset = buildSyntheticDataset({ readyCount: 4 });
    const busyDeferRetry = { maxRetries: 3, delayMs: 1, maxTotalWaitMs: 1000 };
    const harness = createScaleHarness(dataset, { busyDeferRetry });
    const mailbox = dataset.ready[0];

    // Hold the per-mailbox lock so the next job for it is forced to defer.
    const externalHold = harness.lock.acquire(mailbox.id);
    expect(externalHold).not.toBeNull();

    const acquireSpy = vi.spyOn(harness.lock, 'acquire');

    const deferred = await runWorkerJob(
      harness,
      makeWebhookJob(mailbox.id, mailbox.graphMessageId, { jobId: 'busy-1' }),
    );

    expect(deferred.status).toBe('DEFERRED_MAILBOX_BUSY');
    expect(deferred.sentToTelegram).toBe(false);
    expect(harness.sends.length).toBe(0);
    // Bounded: the deferred job tried to acquire exactly 1 + maxRetries times.
    expect(acquireSpy.mock.calls.length).toBe(1 + busyDeferRetry.maxRetries);

    // Release the lock and re-attempt: the message is now delivered exactly once.
    await externalHold!.release();
    const retried = await runWorkerJob(
      harness,
      makeWebhookJob(mailbox.id, mailbox.graphMessageId, { jobId: 'busy-2' }),
    );
    expect(retried.status).toBe('CODE_SENT');
    expect(harness.sends.length).toBe(1);

    const snapshot = harness.snapshot();
    expect(snapshot.jobs?.deferred).toBe(1);
    expect(snapshot.jobs?.completed).toBe(1);
    expect(snapshot.mailboxBusyDefer?.count).toBe(1);
  });

  it('Scenario E — shared-destination + global throttle waits stay bounded under burst', async () => {
    // 30 mailboxes all routed to ONE destination → maximal per-destination burst.
    const dataset = buildSyntheticDataset({
      readyCount: 30,
      disabledCount: 0,
      unmappedCount: 0,
      sharedDestinations: 1,
    });
    const harness = createScaleHarness(dataset);

    for (const mailbox of dataset.ready) {
      const result = await runWorkerJob(
        harness,
        makeWebhookJob(mailbox.id, mailbox.graphMessageId),
      );
      expect(result.status).toBe('CODE_SENT');
    }

    // Backpressure never drops a message: all 30 still delivered.
    expect(harness.sends.length).toBe(30);

    const snapshot = harness.snapshot();
    // Per-send waits are capped — never unbounded.
    expect(snapshot.destinationThrottle?.maxWaitMs).toBeLessThanOrEqual(
      DEFAULT_DESTINATION_MAX_WAIT_MS,
    );
    expect(snapshot.globalThrottle?.maxWaitMs).toBeLessThanOrEqual(
      DEFAULT_GLOBAL_SEND_MAX_WAIT_MS,
    );
    // The burst genuinely exercised both throttles (some waits were recorded).
    expect(snapshot.destinationThrottle?.count ?? 0).toBeGreaterThan(0);
  });

  it('Scenario F — observability aggregate carries safe numbers only (no payload/email/code/token)', async () => {
    const dataset = buildSyntheticDataset();
    const harness = createScaleHarness(dataset);

    for (const mailbox of dataset.ready) {
      await runWorkerJob(harness, makeWebhookJob(mailbox.id, mailbox.graphMessageId));
    }

    const snapshot = harness.snapshot();

    // The aggregate is available and internally consistent.
    expect(snapshot.availability).toBe('AVAILABLE');
    expect(snapshot.jobs?.completed).toBe(dataset.ready.length);
    expect(snapshot.queueWait?.count).toBe(dataset.ready.length);
    expect(snapshot.queueWait?.avgMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.processing?.count).toBe(dataset.ready.length);
    expect(snapshot.processing?.avgMs).toBeGreaterThanOrEqual(0);
    expect(snapshot.globalThrottle?.maxWaitMs).toBeLessThanOrEqual(
      DEFAULT_GLOBAL_SEND_MAX_WAIT_MS,
    );

    // The serialized snapshot must not leak any synthetic secret-shaped value.
    const serialized = JSON.stringify(snapshot);
    for (const secret of collectSyntheticSecrets(dataset)) {
      expect(serialized).not.toContain(secret);
    }
    expect(serialized).not.toContain('facebookmail');
    expect(serialized).not.toContain('redis://');

    // The captured (sanitized) pipeline logs never contain a full code or token.
    const logBlob = harness.logLines.join('\n');
    expect(logBlob).not.toContain(FAKE_ACCESS_TOKEN);
    for (const mailbox of dataset.ready) {
      expect(logBlob).not.toContain(mailbox.verificationCode);
    }
  });
});
