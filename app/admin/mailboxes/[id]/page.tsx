import Link from 'next/link';
import { notFound } from 'next/navigation';
import { MailboxStatusBadge } from '@/components/status/MailboxStatusBadge';
import { SubscriptionStatusBadge } from '@/components/status/SubscriptionStatusBadge';
import { TelegramMappingStatusBadge } from '@/components/status/TelegramMappingStatusBadge';
import { createLogger } from '@/lib/logger';
import {
  getMailboxDetailById,
  type MailboxDetail,
  type MailboxDetailGraphSubscription,
  type MailboxDetailProcessedMessage,
  type MailboxDetailTelegramMapping,
} from '@/services/microsoft/mailbox-detail.service';
import './mailbox-detail.css';

export const dynamic = 'force-dynamic';

const logger = createLogger({ level: 'warn' });

interface MailboxDetailPageProps {
  params: { id: string };
}

type LoadResult =
  | { ok: true; detail: MailboxDetail | null }
  | { ok: false };

async function loadDetail(id: string): Promise<LoadResult> {
  try {
    const detail = await getMailboxDetailById(id);
    return { ok: true, detail };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    logger.error('Failed to load mailbox detail', {
      mailboxId: id,
      errorMessage: message,
    });
    return { ok: false };
  }
}

function formatDateTime(value: Date | null): string {
  if (!value) return '—';
  return value.toISOString().slice(0, 16).replace('T', ' ');
}

function formatDate(value: Date | null): string {
  if (!value) return '—';
  return value.toISOString().slice(0, 10);
}

const PROCESSED_STATUS_LABEL: Record<
  MailboxDetailProcessedMessage['status'],
  string
> = {
  DETECTED: 'Detected',
  SENT: 'Sent',
  FAILED: 'Failed',
  SKIPPED_LOW_CONFIDENCE: 'Skipped (low confidence)',
  DUPLICATE: 'Duplicate',
};

export default async function MailboxDetailPage({
  params,
}: MailboxDetailPageProps) {
  const result = await loadDetail(params.id);

  if (!result.ok) {
    return (
      <>
        <div className="mailbox-detail__header">
          <div>
            <h2 className="mailbox-detail__heading">Mailbox detail</h2>
          </div>
          <Link href="/admin/mailboxes" className="mailbox-detail__back">
            ← Back to list
          </Link>
        </div>
        <div className="admin-banner admin-banner--error" role="alert">
          <strong>Không tải được mailbox detail.</strong>{' '}
          Vui lòng kiểm tra database/dev server rồi thử lại.
        </div>
      </>
    );
  }

  if (!result.detail) {
    notFound();
  }

  const { mailbox, telegramMappings, graphSubscriptions, recentProcessedMessages } =
    result.detail;

  const customerLabel =
    mailbox.customerName ?? mailbox.ownerCustomerName ?? '—';
  const latestMapping = telegramMappings[0] ?? null;
  const latestSubscription = graphSubscriptions[0] ?? null;

  return (
    <>
      <div className="mailbox-detail__header">
        <div>
          <h2 className="mailbox-detail__heading">{mailbox.emailAddress}</h2>
          <p className="mailbox-detail__subtitle">
            <span>{mailbox.provider}</span>
            <span aria-hidden="true">·</span>
            <MailboxStatusBadge status={mailbox.status} />
          </p>
        </div>
        <Link href="/admin/mailboxes" className="mailbox-detail__back">
          ← Back to list
        </Link>
      </div>

      <section className="mailbox-detail__summary" aria-label="Summary">
        <div className="admin-card">
          <p className="admin-card__label">Customer</p>
          <p className="admin-card__value">{customerLabel}</p>
        </div>
        <div className="admin-card">
          <p className="admin-card__label">Last successful sync</p>
          <p className="admin-card__value">
            {formatDateTime(mailbox.lastSuccessfulSyncAt)}
          </p>
        </div>
        <div className="admin-card">
          <p className="admin-card__label">Subscription</p>
          <p className="admin-card__value">
            <SubscriptionStatusBadge
              status={latestSubscription?.status ?? null}
            />
            {latestSubscription ? (
              <span
                className="mailbox-detail__muted"
                style={{ marginLeft: '0.5rem', fontSize: '0.85rem' }}
              >
                hết hạn {formatDateTime(latestSubscription.expirationDateTime)}
              </span>
            ) : null}
          </p>
        </div>
        <div className="admin-card">
          <p className="admin-card__label">Telegram mapping</p>
          <p className="admin-card__value">
            <TelegramMappingStatusBadge
              status={latestMapping?.status ?? null}
            />
          </p>
        </div>
      </section>

      <section
        className="mailbox-detail__section"
        aria-label="Mailbox information"
      >
        <h3 className="mailbox-detail__section-title">Mailbox information</h3>
        <dl className="mailbox-detail__definition">
          <dt>Email</dt>
          <dd>{mailbox.emailAddress}</dd>

          <dt>Provider</dt>
          <dd>{mailbox.provider}</dd>

          <dt>Status</dt>
          <dd>
            <MailboxStatusBadge status={mailbox.status} />
          </dd>

          <dt>Customer</dt>
          <dd>{customerLabel}</dd>

          <dt>Token last refreshed</dt>
          <dd>{formatDateTime(mailbox.tokenLastRefreshedAt)}</dd>

          <dt>Last successful sync</dt>
          <dd>{formatDateTime(mailbox.lastSuccessfulSyncAt)}</dd>

          <dt>Created</dt>
          <dd>{formatDateTime(mailbox.createdAt)}</dd>

          <dt>Updated</dt>
          <dd>{formatDateTime(mailbox.updatedAt)}</dd>
        </dl>
      </section>

      <section
        className="mailbox-detail__section"
        aria-label="Telegram mapping"
      >
        <h3 className="mailbox-detail__section-title">Telegram mapping</h3>
        {telegramMappings.length === 0 ? (
          <p className="mailbox-detail__empty">
            Chưa có Telegram mapping cho mailbox này.
          </p>
        ) : (
          <TelegramMappingTable mappings={telegramMappings} />
        )}
      </section>

      <section
        className="mailbox-detail__section"
        aria-label="Graph subscription"
      >
        <h3 className="mailbox-detail__section-title">Graph subscription</h3>
        {graphSubscriptions.length === 0 ? (
          <p className="mailbox-detail__empty">
            Chưa có Microsoft Graph subscription cho mailbox này.
          </p>
        ) : (
          <SubscriptionTable subscriptions={graphSubscriptions} />
        )}
      </section>

      <section
        className="mailbox-detail__section"
        aria-label="Recent processed messages"
      >
        <h3 className="mailbox-detail__section-title">
          Recent processed messages
        </h3>
        {recentProcessedMessages.length === 0 ? (
          <p className="mailbox-detail__empty">
            Chưa có processed message nào được ghi nhận cho mailbox này.
          </p>
        ) : (
          <ProcessedMessageTable messages={recentProcessedMessages} />
        )}
      </section>
    </>
  );
}

function TelegramMappingTable({
  mappings,
}: {
  mappings: MailboxDetailTelegramMapping[];
}) {
  return (
    <table
      className="mailbox-detail__table"
      aria-label="Telegram mappings"
    >
      <thead>
        <tr>
          <th scope="col">Status</th>
          <th scope="col">Group</th>
          <th scope="col">Chat ID</th>
          <th scope="col">Created</th>
          <th scope="col">Updated</th>
        </tr>
      </thead>
      <tbody>
        {mappings.map((mapping) => (
          <tr key={mapping.id}>
            <td>
              <TelegramMappingStatusBadge status={mapping.status} />
            </td>
            <td>{mapping.telegramGroupName ?? '—'}</td>
            <td>
              <span className="mailbox-detail__mono">
                {mapping.telegramChatIdMasked}
              </span>
            </td>
            <td>{formatDate(mapping.createdAt)}</td>
            <td>{formatDate(mapping.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function SubscriptionTable({
  subscriptions,
}: {
  subscriptions: MailboxDetailGraphSubscription[];
}) {
  return (
    <table
      className="mailbox-detail__table"
      aria-label="Graph subscriptions"
    >
      <thead>
        <tr>
          <th scope="col">Status</th>
          <th scope="col">Subscription ID</th>
          <th scope="col">Resource</th>
          <th scope="col">Expires</th>
          <th scope="col">Last renewed</th>
        </tr>
      </thead>
      <tbody>
        {subscriptions.map((subscription) => (
          <tr key={subscription.id}>
            <td>
              <SubscriptionStatusBadge status={subscription.status} />
            </td>
            <td>
              <span className="mailbox-detail__mono">
                {subscription.subscriptionIdMasked}
              </span>
            </td>
            <td>
              <span className="mailbox-detail__mono">
                {subscription.resource}
              </span>
            </td>
            <td>{formatDateTime(subscription.expirationDateTime)}</td>
            <td>{formatDateTime(subscription.lastRenewedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ProcessedMessageTable({
  messages,
}: {
  messages: MailboxDetailProcessedMessage[];
}) {
  return (
    <table
      className="mailbox-detail__table"
      aria-label="Recent processed messages"
    >
      <thead>
        <tr>
          <th scope="col">Received</th>
          <th scope="col">From</th>
          <th scope="col">Status</th>
          <th scope="col">Graph message</th>
          <th scope="col">Sent to Telegram</th>
        </tr>
      </thead>
      <tbody>
        {messages.map((message) => (
          <tr key={message.id}>
            <td>{formatDateTime(message.receivedAt)}</td>
            <td>{message.senderEmail}</td>
            <td>{PROCESSED_STATUS_LABEL[message.status] ?? message.status}</td>
            <td>
              <span className="mailbox-detail__mono">
                {message.graphMessageIdTruncated}
              </span>
            </td>
            <td>{formatDateTime(message.sentToTelegramAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
