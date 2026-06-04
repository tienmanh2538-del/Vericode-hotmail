import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ConnectMailboxButton } from '@/components/admin/ConnectMailboxButton';
import { MailboxCustomerAssignForm } from '@/components/admin/MailboxCustomerAssignForm';
import { MailboxDisconnectForm } from '@/components/admin/MailboxDisconnectForm';
import { MailboxReadinessBadge } from '@/components/status/MailboxReadinessBadge';
import { MailboxStatusBadge } from '@/components/status/MailboxStatusBadge';
import { SubscriptionStatusBadge } from '@/components/status/SubscriptionStatusBadge';
import { TelegramMappingStatusBadge } from '@/components/status/TelegramMappingStatusBadge';
import { resolveCustomerScope, type CustomerScope } from '@/lib/auth/access-scope';
import { requireAdminAccess } from '@/lib/auth/guards';
import { hasPermission } from '@/lib/auth/permissions';
import { createLogger } from '@/lib/logger';
import {
  deriveMailboxReadiness,
  mailboxHasCustomer,
  mailboxNeedsReconnect,
} from '@/lib/mailboxes/mailbox-list-filter';
import { listCustomers } from '@/services/customers/customer.service';
import { assignMailboxCustomerAction } from '@/services/microsoft/mailbox-assign-actions';
import type { AssignMailboxCustomerState } from '@/services/microsoft/mailbox-assign-form-state';
import { disconnectMailboxAction } from '@/services/microsoft/mailbox-disconnect-actions';
import type { DisconnectMailboxState } from '@/services/microsoft/mailbox-disconnect-form-state';
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

async function loadDetail(id: string, scope: CustomerScope): Promise<LoadResult> {
  try {
    const detail = await getMailboxDetailById(id, scope);
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

// TASK-047 — human label for the Telegram destination a code would be sent to.
// Shows the group plus the forum topic (and its thread id) when present so the
// operator can confirm the exact target before relying on the mailbox.
function formatDestination(
  mapping: MailboxDetailTelegramMapping | null,
): string | null {
  if (!mapping) return null;
  const group = mapping.telegramGroupName ?? mapping.telegramChatIdMasked;
  if (mapping.telegramThreadId) {
    const topic = mapping.telegramTopicName ?? 'Topic';
    return `${group} › ${topic} (#${mapping.telegramThreadId})`;
  }
  return group;
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
  // TASK-045 — staff outside the mailbox's customer scope get notFound().
  const user = await requireAdminAccess();
  const scope = await resolveCustomerScope(user);
  const result = await loadDetail(params.id, scope);

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

  // TASK-047 — onboarding actions (create/edit mapping) are OWNER/ADMIN only.
  // STAFF_READ_ONLY sees the same readiness state but no management CTA. The
  // backend mapping actions stay guarded regardless of this UI hiding.
  const canManageMappings = hasPermission(user.role, 'MANAGE_TELEGRAM_MAPPINGS');
  // TASK-051 — assigning a mailbox to a customer is a MANAGE_MAILBOXES action.
  // Customers are loaded within the viewer's scope so STAFF never sees others.
  const canManageMailbox = hasPermission(user.role, 'MANAGE_MAILBOXES');
  const assignableCustomers = canManageMailbox
    ? (await listCustomers(scope)).map((customer) => ({
        id: customer.id,
        name: customer.name,
      }))
    : [];
  const assignCustomerAction: (
    state: AssignMailboxCustomerState,
    formData: FormData,
  ) => Promise<AssignMailboxCustomerState> = assignMailboxCustomerAction.bind(
    null,
    mailbox.id,
  );
  // TASK-052 — disconnecting a mailbox is OWNER/ADMIN only (MANAGE_MAILBOXES).
  const disconnectAction: (
    state: DisconnectMailboxState,
    formData: FormData,
  ) => Promise<DisconnectMailboxState> = disconnectMailboxAction.bind(
    null,
    mailbox.id,
  );
  const isDisconnected = mailbox.status === 'DISABLED';
  // TASK-069B — RECONNECT_REQUIRED (revoked/expired token) or DISABLED both mean
  // the Microsoft auth/token is no longer usable to relay codes; the remedy in
  // both cases is to re-run the OAuth connect flow. Distinguishing this from the
  // mailbox record simply "existing" stops the checklist from showing a green
  // "connected" tick while a mailbox actually needs reconnecting.
  const needsReconnect = mailboxNeedsReconnect(mailbox.status);
  const isTokenIssue = mailbox.status === 'RECONNECT_REQUIRED';

  const customerLabel =
    mailbox.customerName ?? mailbox.ownerCustomerName ?? '—';
  const latestMapping = telegramMappings[0] ?? null;
  const latestSubscription = graphSubscriptions[0] ?? null;

  // TASK-047 — compute onboarding readiness from existing data (no new columns).
  const activeMapping =
    telegramMappings.find((mapping) => mapping.status === 'ACTIVE') ?? null;
  const hasCustomer = mailboxHasCustomer(mailbox);
  const readiness = deriveMailboxReadiness({
    status: mailbox.status,
    customerName: mailbox.customerName,
    ownerCustomerName: mailbox.ownerCustomerName,
    telegramMappingStatus: activeMapping ? 'ACTIVE' : latestMapping?.status ?? null,
    subscriptionStatus: latestSubscription?.status ?? null,
  });
  const activeDestinationLabel = formatDestination(activeMapping);

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
        aria-label="Onboarding readiness"
      >
        <h3 className="mailbox-detail__section-title">
          Onboarding readiness{' '}
          <MailboxReadinessBadge readiness={readiness} />
        </h3>

        {readiness !== 'READY' ? (
          <div className="admin-banner admin-banner--warning" role="status">
            <strong>Mailbox chưa sẵn sàng relay code.</strong>{' '}
            {isDisconnected
              ? 'Mailbox đã bị ngắt kết nối nên không poll, không renew subscription và không relay code. Hãy reconnect Hotmail/Outlook để dùng lại — gán Telegram mapping KHÔNG bật lại mailbox.'
              : isTokenIssue
                ? 'Kết nối Microsoft đã hết hiệu lực (token cần cấp lại / cần đăng nhập lại) nên mailbox không đọc được email và không relay code. Hãy reconnect Hotmail/Outlook để cấp lại quyền. Customer và Telegram mapping hiện tại sẽ được giữ nguyên.'
                : !hasCustomer
                  ? 'Hãy gắn mailbox này vào đúng customer trước.'
                  : !activeMapping
                    ? 'Mailbox chưa có active Telegram destination. Cần tạo mapping trước khi coi là Ready.'
                    : 'Mailbox đang ở trạng thái lỗi vận hành (subscription/webhook). Kiểm tra chi tiết bên dưới.'}
          </div>
        ) : null}

        {/* TASK-069B — split "is the mailbox connected?" into two distinct
            signals so a green tick can never imply auth is healthy when it is
            not: (1) the mailbox record/provider exists, and (2) the Microsoft
            auth/token is actually usable. Customer + Telegram destination follow. */}
        <ul className="mailbox-detail__checklist">
          <li>
            <span aria-hidden="true">✓</span> Mailbox record &amp; provider:{' '}
            <strong>{mailbox.provider}</strong>
          </li>
          <li>
            <span aria-hidden="true">{needsReconnect ? '✗' : '✓'}</span>{' '}
            {needsReconnect ? (
              <>
                Microsoft auth/token:{' '}
                {isDisconnected
                  ? 'đã ngắt kết nối — cần reconnect'
                  : 'token hết hiệu lực — cần reconnect'}
              </>
            ) : (
              <>Microsoft auth/token đang khỏe</>
            )}
          </li>
          <li>
            <span aria-hidden="true">{hasCustomer ? '✓' : '✗'}</span> Gắn customer:{' '}
            <strong>{customerLabel}</strong>
          </li>
          <li>
            <span aria-hidden="true">{activeMapping ? '✓' : '✗'}</span> Active
            Telegram destination:{' '}
            {activeDestinationLabel ? (
              <strong>{activeDestinationLabel}</strong>
            ) : (
              <em>chưa có active mapping</em>
            )}
          </li>
        </ul>

        {/* TASK-069B — Reconnect CTA whenever the Microsoft auth/token needs
            re-authorising (DISABLED or RECONNECT_REQUIRED). It reuses the
            existing OAuth connect flow but pins the target mailbox id so a wrong
            account can't overwrite this mailbox. Gated by MANAGE_MAILBOXES; the
            backend save stays guarded regardless of this UI hiding. */}
        {needsReconnect && canManageMailbox ? (
          <div className="mailbox-detail__reconnect">
            <p className="mailbox-detail__muted">
              {isDisconnected
                ? 'Reconnect qua Microsoft OAuth để bật lại mailbox. Telegram mapping sẽ không tự bật lại mailbox.'
                : 'Reconnect qua Microsoft OAuth để cấp lại quyền đọc mail. Customer và Telegram mapping hiện tại được giữ nguyên.'}
            </p>
            <ConnectMailboxButton
              variant="compact"
              showIntro={false}
              buttonLabel="Reconnect Hotmail / Outlook"
              reconnectMailboxId={mailbox.id}
            />
          </div>
        ) : null}
        {needsReconnect && !canManageMailbox ? (
          <p className="mailbox-detail__muted">
            Mailbox cần reconnect Microsoft. Bạn chỉ có quyền xem — hãy báo
            OWNER/ADMIN để reconnect mailbox này.
          </p>
        ) : null}

        {readiness !== 'READY' && !needsReconnect && canManageMappings ? (
          <p className="mailbox-detail__cta">
            <Link href="/admin/telegram" className="customers-table__action">
              Mở Telegram mappings để hoàn tất thiết lập →
            </Link>
          </p>
        ) : null}
        {readiness !== 'READY' && !needsReconnect && !canManageMappings ? (
          <p className="mailbox-detail__muted">
            Bạn chỉ có quyền xem. Liên hệ OWNER/ADMIN để hoàn tất thiết lập mapping.
          </p>
        ) : null}
      </section>

      {canManageMailbox ? (
        <section className="mailbox-detail__section" aria-label="Gán customer">
          <h3 className="mailbox-detail__section-title">Gán customer</h3>
          <p className="mailbox-detail__muted">
            Hiện tại: <strong>{customerLabel}</strong>. Chọn customer để gắn
            mailbox này (hoặc bỏ trống để gỡ gán).
          </p>
          <MailboxCustomerAssignForm
            action={assignCustomerAction}
            customers={assignableCustomers}
            currentCustomerId={mailbox.customerId}
          />
        </section>
      ) : null}

      {canManageMailbox ? (
        <section
          className="mailbox-detail__section mailbox-detail__section--danger"
          aria-label="Ngắt kết nối mailbox"
        >
          <h3 className="mailbox-detail__section-title">Ngắt kết nối mailbox</h3>
          <MailboxDisconnectForm
            action={disconnectAction}
            alreadyDisconnected={isDisconnected}
          />
          {isDisconnected ? (
            <p className="mailbox-detail__muted">
              Mailbox đang ngắt kết nối. Dùng nút “Reconnect Hotmail / Outlook” ở
              mục Onboarding readiness phía trên để bật lại.
            </p>
          ) : null}
        </section>
      ) : null}

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
          <th scope="col">Topic</th>
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
              {mapping.telegramThreadId ? (
                <span>
                  {mapping.telegramTopicName ?? 'Topic'}{' '}
                  <span className="mailbox-detail__mono">
                    #{mapping.telegramThreadId}
                  </span>
                </span>
              ) : (
                '—'
              )}
            </td>
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
