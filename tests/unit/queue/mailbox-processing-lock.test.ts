import { describe, it, expect } from 'vitest';

import {
  createInMemoryMailboxProcessingLock,
  DEFAULT_MAILBOX_LOCK_TTL_MS,
} from '@/services/queue/mailbox-processing-lock';

// All identifiers are synthetic. No real mailbox id, token, or code appears.
const MAILBOX_A = 'mailbox_test_alpha';
const MAILBOX_B = 'mailbox_test_beta';

describe('createInMemoryMailboxProcessingLock', () => {
  it('grants the lock when free and refuses a second concurrent acquire', () => {
    const lock = createInMemoryMailboxProcessingLock();

    const first = lock.acquire(MAILBOX_A);
    expect(first).not.toBeNull();

    // A second job for the SAME mailbox cannot proceed while the first holds it.
    const second = lock.acquire(MAILBOX_A);
    expect(second).toBeNull();
  });

  it('lets the next job acquire after the holder releases', () => {
    const lock = createInMemoryMailboxProcessingLock();

    const first = lock.acquire(MAILBOX_A);
    expect(first).not.toBeNull();
    first?.release();

    const second = lock.acquire(MAILBOX_A);
    expect(second).not.toBeNull();
  });

  it('does not serialize different mailboxes against each other', () => {
    const lock = createInMemoryMailboxProcessingLock();

    const a = lock.acquire(MAILBOX_A);
    const b = lock.acquire(MAILBOX_B);

    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
  });

  it('auto-expires a never-released lease after the TTL (crash safety)', () => {
    let nowMs = 1_000;
    const lock = createInMemoryMailboxProcessingLock({
      ttlMs: 5_000,
      now: () => nowMs,
    });

    const first = lock.acquire(MAILBOX_A);
    expect(first).not.toBeNull();

    // Still within TTL → busy.
    nowMs += 4_999;
    expect(lock.acquire(MAILBOX_A)).toBeNull();

    // Past TTL → the wedged lease is reclaimable even without a release().
    nowMs += 2;
    expect(lock.acquire(MAILBOX_A)).not.toBeNull();
  });

  it('refuses to lock an empty mailbox id rather than collapsing them together', () => {
    const lock = createInMemoryMailboxProcessingLock();
    expect(lock.acquire('')).toBeNull();
    expect(lock.acquire('   ')).toBeNull();
  });

  it('release is idempotent and never deletes a different holder lease', () => {
    let nowMs = 0;
    const lock = createInMemoryMailboxProcessingLock({
      ttlMs: 100,
      now: () => nowMs,
    });

    const stale = lock.acquire(MAILBOX_A);
    expect(stale).not.toBeNull();

    // The stale lease expires and a new job takes over.
    nowMs += 200;
    const fresh = lock.acquire(MAILBOX_A);
    expect(fresh).not.toBeNull();

    // The stale holder finally releases — it must NOT free the fresh holder's
    // lease. The mailbox is still busy for anyone else.
    stale?.release();
    stale?.release(); // idempotent
    expect(lock.acquire(MAILBOX_A)).toBeNull();
  });

  it('exposes a sane default TTL', () => {
    expect(DEFAULT_MAILBOX_LOCK_TTL_MS).toBeGreaterThan(0);
  });
});
