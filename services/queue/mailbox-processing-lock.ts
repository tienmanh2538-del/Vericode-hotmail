// TASK-055 — Per-mailbox processing lock.
//
// Guarantees that, within a single worker process, at most ONE job per
// `mailboxId` runs the Graph → detector → extractor → Telegram critical section
// at a time. Two notifications for the same mailbox (webhook + delta polling, or
// a retry racing the original) therefore cannot hammer Microsoft Graph / Telegram
// in parallel.
//
// Scope (minimal, per TASK-055):
//   - The lock is in-process. The baseline deployment (see TASK-054) runs a
//     single email worker with concurrency 2, so in-process serialization is the
//     concurrency boundary that actually matters here. A cross-process
//     (Redis-backed) lock is intentionally out of scope and can be added later
//     behind the same interface without touching the pipeline.
//   - Each held lock carries an expiry (TTL). If a job crashes or hangs and never
//     calls `release()`, the lock self-expires so the mailbox is not wedged
//     forever.
//   - `acquire()` is non-blocking: it returns a handle when the lock is free, or
//     `null` when the mailbox is currently busy. The caller decides how to defer.

/** Default time a held lock survives without an explicit release. */
export const DEFAULT_MAILBOX_LOCK_TTL_MS = 60_000;

export interface MailboxLockHandle {
  /** Release the lock. Safe to call multiple times; only the first call acts. */
  release(): void;
}

export interface MailboxProcessingLock {
  /**
   * Try to acquire the lock for `mailboxId`. Returns a handle on success, or
   * `null` when the mailbox is already locked by another in-flight job.
   */
  acquire(mailboxId: string): MailboxLockHandle | null;
}

export interface InMemoryMailboxLockOptions {
  /** How long a held lock survives without release. Defaults to 60s. */
  ttlMs?: number;
  /** Clock source in epoch ms. Injectable so tests run deterministically. */
  now?: () => number;
}

/**
 * Build an in-memory, TTL-guarded per-mailbox lock. The returned instance is a
 * singleton-style guard: share ONE instance across every job the worker
 * processes so the `mailboxId → expiry` map is shared.
 */
export function createInMemoryMailboxProcessingLock(
  options: InMemoryMailboxLockOptions = {},
): MailboxProcessingLock {
  const ttlMs =
    typeof options.ttlMs === 'number' && options.ttlMs > 0
      ? options.ttlMs
      : DEFAULT_MAILBOX_LOCK_TTL_MS;
  const now = options.now ?? (() => Date.now());

  // mailboxId → epoch ms at which the current holder's lease expires.
  const heldUntil = new Map<string, number>();

  return {
    acquire(mailboxId: string): MailboxLockHandle | null {
      const key = typeof mailboxId === 'string' ? mailboxId.trim() : '';
      // An empty key cannot be serialized safely — refuse rather than collapse
      // every empty-id job onto one lock.
      if (key.length === 0) return null;

      const current = now();
      const existingExpiry = heldUntil.get(key);
      if (existingExpiry !== undefined && existingExpiry > current) {
        // Still held by a live lease → busy.
        return null;
      }

      // Free (never held, or the previous lease expired) → take it.
      const myExpiry = current + ttlMs;
      heldUntil.set(key, myExpiry);

      let released = false;
      return {
        release(): void {
          if (released) return;
          released = true;
          // Only clear the slot if it is still OUR lease. If our lease had
          // already expired and another job re-acquired, we must not delete
          // their lease.
          if (heldUntil.get(key) === myExpiry) {
            heldUntil.delete(key);
          }
        },
      };
    },
  };
}
