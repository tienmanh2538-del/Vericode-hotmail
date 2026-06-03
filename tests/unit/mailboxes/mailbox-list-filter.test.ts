import { describe, it, expect } from 'vitest';
import {
  EMPTY_FILTERS,
  collectCustomerOptions,
  collectStatusOptions,
  deriveMailboxReadiness,
  filterMailboxes,
  mailboxCustomerLabel,
  mailboxHasCustomer,
  type MailboxListFilters,
} from '@/lib/mailboxes/mailbox-list-filter';
import type { MailboxListItem } from '@/services/microsoft/mailbox-list.service';

// Synthetic fixtures only — no secrets, no real chat IDs, no real email bodies.
function makeMailbox(overrides: Partial<MailboxListItem> = {}): MailboxListItem {
  return {
    id: 'mbx_1',
    emailAddress: 'alice@hotmail.com',
    provider: 'MICROSOFT',
    status: 'ACTIVE',
    ownerCustomerName: null,
    customerName: 'Acme',
    telegramGroupName: 'Acme Group',
    telegramChatIdMasked: '••••6789',
    telegramMappingStatus: 'ACTIVE',
    subscriptionStatus: 'ACTIVE',
    subscriptionExpiresAt: new Date('2026-07-01T00:00:00.000Z'),
    lastSuccessfulSyncAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    ...overrides,
  };
}

describe('deriveMailboxReadiness', () => {
  it('is READY when mailbox is ACTIVE with an active mapping', () => {
    expect(deriveMailboxReadiness(makeMailbox())).toBe('READY');
  });

  it('is NEEDS_MAPPING when an ACTIVE mailbox has no active mapping', () => {
    expect(
      deriveMailboxReadiness(makeMailbox({ telegramMappingStatus: null })),
    ).toBe('NEEDS_MAPPING');
    expect(
      deriveMailboxReadiness(makeMailbox({ telegramMappingStatus: 'DISABLED' })),
    ).toBe('NEEDS_MAPPING');
  });

  it('surfaces TOKEN_ISSUE for RECONNECT_REQUIRED regardless of mapping', () => {
    expect(
      deriveMailboxReadiness(
        makeMailbox({ status: 'RECONNECT_REQUIRED', telegramMappingStatus: 'ACTIVE' }),
      ),
    ).toBe('TOKEN_ISSUE');
  });

  it('surfaces SUBSCRIPTION_ISSUE for an expired mailbox status', () => {
    expect(
      deriveMailboxReadiness(makeMailbox({ status: 'SUBSCRIPTION_EXPIRED' })),
    ).toBe('SUBSCRIPTION_ISSUE');
  });

  it('surfaces SUBSCRIPTION_ISSUE when an ACTIVE mailbox has a failed subscription', () => {
    expect(
      deriveMailboxReadiness(
        makeMailbox({ status: 'ACTIVE', subscriptionStatus: 'FAILED' }),
      ),
    ).toBe('SUBSCRIPTION_ISSUE');
  });

  it('maps WEBHOOK_FAILED / ERROR / DISABLED statuses to their signals', () => {
    expect(deriveMailboxReadiness(makeMailbox({ status: 'WEBHOOK_FAILED' }))).toBe(
      'WEBHOOK_ISSUE',
    );
    expect(deriveMailboxReadiness(makeMailbox({ status: 'ERROR' }))).toBe('ERROR');
    expect(deriveMailboxReadiness(makeMailbox({ status: 'DISABLED' }))).toBe(
      'DISABLED',
    );
  });

  // TASK-067 — a disconnected mailbox must never read as Ready, even when it
  // still carries an active mapping/destination, a customer, and a healthy
  // subscription (e.g. a stale ACTIVE mapping left over before reconnecting).
  it('DISABLED wins over an otherwise fully-ready mailbox', () => {
    expect(
      deriveMailboxReadiness(
        makeMailbox({
          status: 'DISABLED',
          customerName: 'Acme',
          telegramMappingStatus: 'ACTIVE',
          subscriptionStatus: 'ACTIVE',
        }),
      ),
    ).toBe('DISABLED');
  });
});

describe('deriveMailboxReadiness — customer requirement (TASK-047)', () => {
  it('is NEEDS_CUSTOMER when an ACTIVE mailbox has no customer, even with an active mapping', () => {
    expect(
      deriveMailboxReadiness(
        makeMailbox({
          status: 'ACTIVE',
          customerName: null,
          ownerCustomerName: null,
          telegramMappingStatus: 'ACTIVE',
        }),
      ),
    ).toBe('NEEDS_CUSTOMER');
  });

  it('accepts the denormalised ownerCustomerName as a customer', () => {
    expect(
      deriveMailboxReadiness(
        makeMailbox({
          customerName: null,
          ownerCustomerName: 'Legacy Co',
          telegramMappingStatus: 'ACTIVE',
        }),
      ),
    ).toBe('READY');
  });

  it('is only READY with BOTH a customer and an active destination', () => {
    expect(deriveMailboxReadiness(makeMailbox())).toBe('READY');
    expect(
      deriveMailboxReadiness(
        makeMailbox({ customerName: 'Acme', telegramMappingStatus: null }),
      ),
    ).toBe('NEEDS_MAPPING');
    expect(
      deriveMailboxReadiness(
        makeMailbox({
          customerName: null,
          ownerCustomerName: null,
          telegramMappingStatus: null,
        }),
      ),
    ).toBe('NEEDS_CUSTOMER');
  });
});

describe('mailboxHasCustomer', () => {
  it('is true with either a joined or denormalised customer name', () => {
    expect(
      mailboxHasCustomer({ customerName: 'Acme', ownerCustomerName: null }),
    ).toBe(true);
    expect(
      mailboxHasCustomer({ customerName: null, ownerCustomerName: 'Legacy Co' }),
    ).toBe(true);
  });

  it('is false when both are null', () => {
    expect(
      mailboxHasCustomer({ customerName: null, ownerCustomerName: null }),
    ).toBe(false);
  });
});

describe('mailboxCustomerLabel', () => {
  it('prefers the joined customer name', () => {
    expect(mailboxCustomerLabel(makeMailbox({ customerName: 'Acme' }))).toBe('Acme');
  });

  it('falls back to ownerCustomerName then a dash', () => {
    expect(
      mailboxCustomerLabel(
        makeMailbox({ customerName: null, ownerCustomerName: 'Legacy Co' }),
      ),
    ).toBe('Legacy Co');
    expect(
      mailboxCustomerLabel(
        makeMailbox({ customerName: null, ownerCustomerName: null }),
      ),
    ).toBe('—');
  });
});

describe('filterMailboxes', () => {
  const acme = makeMailbox({ id: 'a', emailAddress: 'alice@hotmail.com', customerName: 'Acme' });
  const beta = makeMailbox({
    id: 'b',
    emailAddress: 'bob@outlook.com',
    customerName: 'Beta',
    telegramMappingStatus: null,
  });
  const gamma = makeMailbox({
    id: 'c',
    emailAddress: 'carol@hotmail.com',
    customerName: 'Acme',
    status: 'RECONNECT_REQUIRED',
  });
  const all = [acme, beta, gamma];

  it('returns every row for empty filters', () => {
    expect(filterMailboxes(all, EMPTY_FILTERS)).toEqual(all);
  });

  it('searches across email and customer name, case-insensitively', () => {
    expect(filterMailboxes(all, { ...EMPTY_FILTERS, query: 'BOB' })).toEqual([beta]);
    expect(filterMailboxes(all, { ...EMPTY_FILTERS, query: 'acme' })).toEqual([
      acme,
      gamma,
    ]);
  });

  it('filters by exact customer label', () => {
    expect(filterMailboxes(all, { ...EMPTY_FILTERS, customer: 'Beta' })).toEqual([
      beta,
    ]);
  });

  it('filters by raw mailbox status', () => {
    expect(
      filterMailboxes(all, { ...EMPTY_FILTERS, status: 'RECONNECT_REQUIRED' }),
    ).toEqual([gamma]);
  });

  it('filters by derived readiness', () => {
    expect(
      filterMailboxes(all, { ...EMPTY_FILTERS, readiness: 'NEEDS_MAPPING' }),
    ).toEqual([beta]);
    expect(
      filterMailboxes(all, { ...EMPTY_FILTERS, readiness: 'READY' }),
    ).toEqual([acme]);
  });

  it('combines filters (AND semantics)', () => {
    const filters: MailboxListFilters = {
      query: 'hotmail',
      customer: 'Acme',
      status: 'ACTIVE',
      readiness: 'READY',
    };
    expect(filterMailboxes(all, filters)).toEqual([acme]);
  });

  // SECURITY (TASK-046 / TASK-045): client-side filtering must only ever NARROW
  // the server-scoped input — it can never surface a row that was not supplied.
  it('only ever returns a subset of the supplied (already-scoped) rows', () => {
    const filters: MailboxListFilters = {
      query: 'anything',
      customer: 'Nonexistent',
      status: 'ACTIVE',
      readiness: 'READY',
    };
    const result = filterMailboxes(all, filters);
    for (const row of result) {
      expect(all).toContain(row);
    }
    expect(result.length).toBeLessThanOrEqual(all.length);
  });
});

describe('option collectors', () => {
  it('collects distinct sorted customer labels', () => {
    const items = [
      makeMailbox({ customerName: 'Zeta' }),
      makeMailbox({ customerName: 'Acme' }),
      makeMailbox({ customerName: 'Acme' }),
    ];
    expect(collectCustomerOptions(items)).toEqual(['Acme', 'Zeta']);
  });

  it('collects distinct sorted statuses', () => {
    const items = [
      makeMailbox({ status: 'ACTIVE' }),
      makeMailbox({ status: 'ERROR' }),
      makeMailbox({ status: 'ACTIVE' }),
    ];
    expect(collectStatusOptions(items)).toEqual(['ACTIVE', 'ERROR']);
  });
});
