'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import { MailboxReadinessBadge } from '@/components/status/MailboxReadinessBadge';
import { MailboxStatusBadge } from '@/components/status/MailboxStatusBadge';
import { SubscriptionStatusBadge } from '@/components/status/SubscriptionStatusBadge';
import { TelegramMappingStatusBadge } from '@/components/status/TelegramMappingStatusBadge';
import {
  ALL_OPTION,
  EMPTY_FILTERS,
  READINESS_ORDER,
  READINESS_LABEL,
  collectCustomerOptions,
  collectStatusOptions,
  deriveMailboxReadiness,
  filterMailboxes,
  mailboxCustomerLabel,
  type MailboxListFilters,
  type MailboxReadiness,
} from '@/lib/mailboxes/mailbox-list-filter';
import type {
  MailboxListItem,
  MailboxStatusValue,
} from '@/services/microsoft/mailbox-list.service';
import styles from './mailbox-list-table.module.css';

interface MailboxListTableProps {
  mailboxes: MailboxListItem[];
}

const STATUS_LABEL: Record<MailboxStatusValue, string> = {
  ACTIVE: 'Active',
  RECONNECT_REQUIRED: 'Cần reconnect',
  SUBSCRIPTION_EXPIRED: 'Subscription hết hạn',
  WEBHOOK_FAILED: 'Webhook lỗi',
  DISABLED: 'Đã tắt',
  ERROR: 'Lỗi',
};

function formatDate(value: Date | null): string {
  if (!value) return '—';
  return new Date(value).toISOString().slice(0, 10);
}

function formatDateTime(value: Date | null): string {
  if (!value) return '—';
  return new Date(value).toISOString().slice(0, 16).replace('T', ' ');
}

function joinTelegram(groupName: string | null, chatMasked: string | null): string {
  if (groupName && chatMasked) return `${groupName} (${chatMasked})`;
  if (groupName) return groupName;
  if (chatMasked) return chatMasked;
  return '—';
}

export function MailboxListTable({ mailboxes }: MailboxListTableProps) {
  const [filters, setFilters] = useState<MailboxListFilters>(EMPTY_FILTERS);

  const customerOptions = useMemo(
    () => collectCustomerOptions(mailboxes),
    [mailboxes],
  );
  const statusOptions = useMemo(
    () => collectStatusOptions(mailboxes),
    [mailboxes],
  );
  const visible = useMemo(
    () => filterMailboxes(mailboxes, filters),
    [mailboxes, filters],
  );

  if (mailboxes.length === 0) {
    return (
      <p className="customers-empty">
        Chưa có mailbox nào được kết nối. Mailbox sau khi OAuth thành công sẽ
        xuất hiện tại đây.
      </p>
    );
  }

  return (
    <div>
      <div className={styles.toolbar}>
        <div className={`${styles.field} ${styles.fieldSearch}`}>
          <label className={styles.label} htmlFor="mailbox-search">
            Tìm theo email hoặc customer
          </label>
          <input
            id="mailbox-search"
            type="search"
            className={styles.input}
            placeholder="vd: name@hotmail.com hoặc Acme"
            value={filters.query}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, query: event.target.value }))
            }
          />
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="mailbox-customer">
            Customer
          </label>
          <select
            id="mailbox-customer"
            className={styles.select}
            value={filters.customer}
            onChange={(event) =>
              setFilters((prev) => ({ ...prev, customer: event.target.value }))
            }
          >
            <option value={ALL_OPTION}>Tất cả customer</option>
            {customerOptions.map((customer) => (
              <option key={customer} value={customer}>
                {customer}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="mailbox-status">
            Mailbox status
          </label>
          <select
            id="mailbox-status"
            className={styles.select}
            value={filters.status}
            onChange={(event) =>
              setFilters((prev) => ({
                ...prev,
                status: event.target.value as MailboxStatusValue | typeof ALL_OPTION,
              }))
            }
          >
            <option value={ALL_OPTION}>Tất cả trạng thái</option>
            {statusOptions.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABEL[status] ?? status}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.field}>
          <label className={styles.label} htmlFor="mailbox-readiness">
            Mapping status
          </label>
          <select
            id="mailbox-readiness"
            className={styles.select}
            value={filters.readiness}
            onChange={(event) =>
              setFilters((prev) => ({
                ...prev,
                readiness: event.target.value as MailboxReadiness | typeof ALL_OPTION,
              }))
            }
          >
            <option value={ALL_OPTION}>Tất cả mapping</option>
            {READINESS_ORDER.map((readiness) => (
              <option key={readiness} value={readiness}>
                {READINESS_LABEL[readiness]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p className={styles.count}>
        Hiển thị {visible.length} / {mailboxes.length} mailbox
      </p>

      {visible.length === 0 ? (
        <p className={styles.empty}>
          Không có mailbox nào khớp bộ lọc hiện tại.
        </p>
      ) : (
        <table className="customers-table" aria-label="Mailboxes">
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Provider</th>
              <th scope="col">Customer</th>
              <th scope="col">Mapping</th>
              <th scope="col">Status</th>
              <th scope="col">Telegram</th>
              <th scope="col">Subscription</th>
              <th scope="col">Sub. expires</th>
              <th scope="col">Last sync</th>
              <th scope="col">Created</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((mailbox) => {
              const readiness = deriveMailboxReadiness(mailbox);
              return (
                <tr key={mailbox.id}>
                  <td>{mailbox.emailAddress}</td>
                  <td>{mailbox.provider}</td>
                  <td>{mailboxCustomerLabel(mailbox)}</td>
                  <td>
                    <MailboxReadinessBadge readiness={readiness} />
                  </td>
                  <td>
                    <MailboxStatusBadge status={mailbox.status} />
                  </td>
                  <td>
                    <div className={styles.telegramCell}>
                      <TelegramMappingStatusBadge
                        status={mailbox.telegramMappingStatus}
                      />
                      <span className={styles.telegramTarget}>
                        {joinTelegram(
                          mailbox.telegramGroupName,
                          mailbox.telegramChatIdMasked,
                        )}
                      </span>
                    </div>
                  </td>
                  <td>
                    <SubscriptionStatusBadge status={mailbox.subscriptionStatus} />
                  </td>
                  <td>{formatDateTime(mailbox.subscriptionExpiresAt)}</td>
                  <td>{formatDateTime(mailbox.lastSuccessfulSyncAt)}</td>
                  <td>{formatDate(mailbox.createdAt)}</td>
                  <td>
                    <Link
                      href={`/admin/mailboxes/${mailbox.id}`}
                      className="customers-table__action"
                    >
                      View details
                    </Link>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
