import { describe, it, expect } from 'vitest';
import {
  createInMemoryCodeEventLogStore,
  listCodeEvents,
  recordCodeEvent,
  summarizeCodeEvents,
  type CodeEventLogItem,
} from '@/services/logs/code-event-log.service';

const MAILBOX = 'client-a@hotmail.com';

describe('recordCodeEvent', () => {
  it('rejects when mailboxEmail is missing', () => {
    const store = createInMemoryCodeEventLogStore();
    expect(() =>
      recordCodeEvent(
        {
          mailboxEmail: '',
          status: 'CODE_DETECTED',
        },
        store,
      ),
    ).toThrow(/mailboxEmail/);
    expect(store.list()).toHaveLength(0);
  });

  it('refuses to record a full numeric verification code as maskedCode', () => {
    const store = createInMemoryCodeEventLogStore();
    expect(() =>
      recordCodeEvent(
        {
          mailboxEmail: MAILBOX,
          status: 'CODE_SENT',
          maskedCode: '123456',
        },
        store,
      ),
    ).toThrow(/full verification code/);
    expect(store.list()).toHaveLength(0);
  });

  it('accepts a star-masked code', () => {
    const store = createInMemoryCodeEventLogStore();
    const item = recordCodeEvent(
      {
        mailboxEmail: MAILBOX,
        status: 'CODE_SENT',
        maskedCode: '12****',
        confidence: 92,
      },
      store,
    );
    expect(item.maskedCode).toBe('12****');
    expect(item.confidence).toBe(92);
    expect(store.list()).toHaveLength(1);
  });

  it('accepts a sha256:short hashed code', () => {
    const store = createInMemoryCodeEventLogStore();
    const item = recordCodeEvent(
      {
        mailboxEmail: MAILBOX,
        status: 'CODE_DETECTED',
        maskedCode: 'sha256:abc12345',
      },
      store,
    );
    expect(item.maskedCode).toBe('sha256:abc12345');
  });

  it('clamps confidence to [0, 100]', () => {
    const store = createInMemoryCodeEventLogStore();
    const a = recordCodeEvent(
      { mailboxEmail: MAILBOX, status: 'CODE_DETECTED', confidence: 250 },
      store,
    );
    const b = recordCodeEvent(
      { mailboxEmail: MAILBOX, status: 'CODE_DETECTED', confidence: -10 },
      store,
    );
    expect(a.confidence).toBe(100);
    expect(b.confidence).toBe(0);
  });

  it('drops non-finite confidence values', () => {
    const store = createInMemoryCodeEventLogStore();
    const item = recordCodeEvent(
      {
        mailboxEmail: MAILBOX,
        status: 'CODE_DETECTED',
        confidence: Number.NaN,
      },
      store,
    );
    expect(item.confidence).toBeUndefined();
  });

  it('defaults platform and source', () => {
    const store = createInMemoryCodeEventLogStore();
    const item = recordCodeEvent(
      { mailboxEmail: MAILBOX, status: 'CODE_DETECTED' },
      store,
    );
    expect(item.platform).toBe('Facebook/Meta');
    expect(item.source).toBe('mock');
  });
});

describe('listCodeEvents', () => {
  it('returns [] for an empty store without crashing', () => {
    const store = createInMemoryCodeEventLogStore();
    expect(listCodeEvents(store)).toEqual([]);
    expect(summarizeCodeEvents(listCodeEvents(store))).toEqual({
      total: 0,
      sent: 0,
      skippedDuplicate: 0,
      lowConfidence: 0,
      failed: 0,
      detected: 0,
    });
  });

  it('returns events newest first', () => {
    const store = createInMemoryCodeEventLogStore();
    recordCodeEvent(
      {
        mailboxEmail: MAILBOX,
        status: 'CODE_DETECTED',
        createdAt: '2026-01-01T00:00:00.000Z',
      },
      store,
    );
    recordCodeEvent(
      {
        mailboxEmail: MAILBOX,
        status: 'CODE_SENT',
        createdAt: '2026-01-03T00:00:00.000Z',
      },
      store,
    );
    recordCodeEvent(
      {
        mailboxEmail: MAILBOX,
        status: 'CODE_SKIPPED_DUPLICATE',
        createdAt: '2026-01-02T00:00:00.000Z',
      },
      store,
    );

    const result = listCodeEvents(store);
    expect(result.map((e) => e.createdAt)).toEqual([
      '2026-01-03T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z',
    ]);
  });

  it('returns a copy so callers cannot mutate the store', () => {
    const store = createInMemoryCodeEventLogStore();
    recordCodeEvent(
      { mailboxEmail: MAILBOX, status: 'CODE_DETECTED' },
      store,
    );
    const a = listCodeEvents(store);
    a.length = 0;
    expect(listCodeEvents(store)).toHaveLength(1);
  });
});

describe('summarizeCodeEvents', () => {
  function makeItem(
    overrides: Partial<CodeEventLogItem> & Pick<CodeEventLogItem, 'status'>,
  ): CodeEventLogItem {
    return {
      id: overrides.id ?? 'cev_test',
      createdAt: overrides.createdAt ?? '2026-01-01T00:00:00.000Z',
      mailboxEmail: overrides.mailboxEmail ?? MAILBOX,
      platform: overrides.platform ?? 'Facebook/Meta',
      source: overrides.source ?? 'mock',
      ...overrides,
    };
  }

  it('counts each status bucket exactly once', () => {
    const items: CodeEventLogItem[] = [
      makeItem({ status: 'CODE_SENT' }),
      makeItem({ status: 'CODE_SENT' }),
      makeItem({ status: 'CODE_SKIPPED_DUPLICATE' }),
      makeItem({ status: 'CODE_SKIPPED_LOW_CONFIDENCE' }),
      makeItem({ status: 'CODE_DETECTED' }),
      makeItem({ status: 'TELEGRAM_SEND_FAILED' }),
      makeItem({ status: 'EXTRACTOR_FAILED' }),
      makeItem({ status: 'DETECTOR_REJECTED' }),
    ];
    expect(summarizeCodeEvents(items)).toEqual({
      total: 8,
      sent: 2,
      skippedDuplicate: 1,
      lowConfidence: 1,
      failed: 3,
      detected: 1,
    });
  });
});

describe('safety guarantees', () => {
  it('never returns a property called code or fullCode on items', () => {
    const store = createInMemoryCodeEventLogStore();
    recordCodeEvent(
      {
        mailboxEmail: MAILBOX,
        status: 'CODE_SENT',
        maskedCode: '12****',
      },
      store,
    );
    const item = listCodeEvents(store)[0] as unknown as Record<string, unknown>;
    expect(item.code).toBeUndefined();
    expect(item.fullCode).toBeUndefined();
    expect(item.body).toBeUndefined();
    expect(item.token).toBeUndefined();
  });
});
