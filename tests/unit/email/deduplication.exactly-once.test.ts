import { describe, it, expect } from 'vitest';

import {
  claimMessageForProcessing,
  createInMemoryProcessedMessageStore,
  isProcessedMessageDuplicateError,
  ProcessedMessageDuplicateError,
  type DeduplicationInput,
  type ProcessedMessageRecord,
  type ProcessedMessageStore,
} from '@/services/email/deduplication.service';
import { createPrismaProcessedMessageStore } from '@/services/email/prisma-processed-message-store';

// TASK-068A — exactly-once guarantees under concurrency.
//
// All identifiers are synthetic: "mailbox_test_*" ids, "graph-msg-test-*" message
// ids, ".test" (RFC 6761 reserved) sender domains, and a fake numeric code. No
// real mailbox, token, secret, or customer data appears.
const MAILBOX_A = 'mailbox_test_alpha';
const GRAPH_MESSAGE_ID = 'graph-msg-test-068a';
const CODE = '424242';

function baseInput(overrides: Partial<DeduplicationInput> = {}): DeduplicationInput {
  return {
    mailboxId: MAILBOX_A,
    graphMessageId: GRAPH_MESSAGE_ID,
    internetMessageId: '<imid-068a@example.test>',
    receivedAt: '2026-06-04T10:00:30.000Z',
    senderEmail: 'security@example.test',
    subject: 'Your verification code',
    verificationCode: CODE,
    ...overrides,
  };
}

describe('claimMessageForProcessing — exactly-once under concurrency', () => {
  it('two parallel flows for the SAME graphMessageId claim it exactly once', async () => {
    const store = createInMemoryProcessedMessageStore();

    // Simulate webhook + delta-polling (or two worker replicas) racing on the
    // same message. The in-memory store now enforces the same unique constraint
    // the DB does, so only one insert can win.
    const [r1, r2] = await Promise.all([
      claimMessageForProcessing(baseInput(), store),
      claimMessageForProcessing(baseInput(), store),
    ]);

    const successes = [r1, r2].filter((r) => r.shouldProcess);
    const duplicates = [r1, r2].filter((r) => r.isDuplicate);

    expect(successes).toHaveLength(1);
    expect(duplicates).toHaveLength(1);
    expect(duplicates[0].reason).toBe('DUPLICATE_GRAPH_MESSAGE_ID');

    // Exactly one row persisted — no double claim.
    const persisted = await store.findByGraphMessageId(MAILBOX_A, GRAPH_MESSAGE_ID);
    expect(persisted).not.toBeNull();
    expect(persisted?.id).toBe(successes[0].processedMessageId);
  });

  it('treats a create-time unique-constraint collision as a clean duplicate skip', async () => {
    // Rigged store: the pre-check sees nothing (the race window), the insert
    // collides (P2002 → ProcessedMessageDuplicateError), and the post-collision
    // re-read finds the row a sibling flow already wrote.
    const existing: ProcessedMessageRecord = {
      id: 'pm_existing',
      mailboxId: MAILBOX_A,
      graphMessageId: GRAPH_MESSAGE_ID,
      internetMessageId: null,
      codeHash: null,
      receivedAt: new Date('2026-06-04T10:00:30.000Z'),
      receivedAtBucket: null,
      senderEmail: null,
      subjectHash: null,
      status: 'DETECTED',
      sentToTelegramAt: null,
      createdAt: new Date('2026-06-04T10:00:31.000Z'),
    };

    let firstFind = true;
    let createCalls = 0;
    const store: ProcessedMessageStore = {
      async findByGraphMessageId() {
        if (firstFind) {
          firstFind = false;
          return null; // pre-check during the race window
        }
        return existing; // post-collision re-read
      },
      async findByInternetMessageId() {
        return null;
      },
      async findByCodeBucket() {
        return null;
      },
      async create() {
        createCalls += 1;
        throw new ProcessedMessageDuplicateError();
      },
      async markSent() {
        /* unused */
      },
    };

    const result = await claimMessageForProcessing(baseInput(), store);

    expect(createCalls).toBe(1); // attempted once, then gave up cleanly
    expect(result.shouldProcess).toBe(false);
    expect(result.isDuplicate).toBe(true);
    expect(result.reason).toBe('DUPLICATE_GRAPH_MESSAGE_ID');
    expect(result.processedMessageId).toBe('pm_existing');
    // The duplicate result must never carry the plaintext code.
    expect(JSON.stringify(result)).not.toContain(CODE);
  });

  it('re-throws non-duplicate create errors instead of swallowing them', async () => {
    const store: ProcessedMessageStore = {
      async findByGraphMessageId() {
        return null;
      },
      async findByInternetMessageId() {
        return null;
      },
      async findByCodeBucket() {
        return null;
      },
      async create() {
        throw new Error('database unreachable');
      },
      async markSent() {
        /* unused */
      },
    };

    await expect(claimMessageForProcessing(baseInput(), store)).rejects.toThrow(
      'database unreachable',
    );
  });
});

describe('createInMemoryProcessedMessageStore — unique constraint', () => {
  it('throws ProcessedMessageDuplicateError on a duplicate (mailbox, graphMessageId)', async () => {
    const store = createInMemoryProcessedMessageStore();
    const input = {
      mailboxId: MAILBOX_A,
      graphMessageId: GRAPH_MESSAGE_ID,
      internetMessageId: null,
      codeHash: null,
      receivedAt: new Date('2026-06-04T10:00:30.000Z'),
      receivedAtBucket: null,
      senderEmail: null,
      subjectHash: null,
    };
    await store.create(input);
    await expect(store.create(input)).rejects.toBeInstanceOf(
      ProcessedMessageDuplicateError,
    );
  });
});

describe('createPrismaProcessedMessageStore — P2002 mapping', () => {
  function makeClient(createImpl: () => Promise<unknown>) {
    return {
      processedMessage: {
        findUnique: async () => null,
        findFirst: async () => null,
        create: createImpl,
        update: async () => undefined,
      },
    } as never;
  }

  it('maps a Prisma P2002 unique-constraint violation to ProcessedMessageDuplicateError', async () => {
    const store = createPrismaProcessedMessageStore(
      makeClient(async () => {
        throw { code: 'P2002', meta: { target: ['mailboxId', 'graphMessageId'] } };
      }),
    );
    const err = await store
      .create({
        mailboxId: MAILBOX_A,
        graphMessageId: GRAPH_MESSAGE_ID,
        internetMessageId: null,
        codeHash: null,
        receivedAt: new Date('2026-06-04T10:00:30.000Z'),
        receivedAtBucket: null,
        senderEmail: null,
        subjectHash: null,
      })
      .catch((e: unknown) => e);
    expect(isProcessedMessageDuplicateError(err)).toBe(true);
  });

  it('propagates non-P2002 errors unchanged', async () => {
    const store = createPrismaProcessedMessageStore(
      makeClient(async () => {
        throw new Error('connection reset');
      }),
    );
    await expect(
      store.create({
        mailboxId: MAILBOX_A,
        graphMessageId: GRAPH_MESSAGE_ID,
        internetMessageId: null,
        codeHash: null,
        receivedAt: new Date('2026-06-04T10:00:30.000Z'),
        receivedAtBucket: null,
        senderEmail: null,
        subjectHash: null,
      }),
    ).rejects.toThrow('connection reset');
  });
});
