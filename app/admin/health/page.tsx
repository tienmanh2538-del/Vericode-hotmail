import { loadHealthDashboard } from '@/services/health/health.service';
import type {
  HealthLevel,
  MailboxHealthRow,
  OperationalCheck,
  OperationalCheckStatus,
} from '@/services/health/health.types';
import '../admin.css';
import './health.css';

export const dynamic = 'force-dynamic';

const LEVEL_CLASS: Record<HealthLevel, string> = {
  OK: 'health-badge health-badge--ok',
  WARNING: 'health-badge health-badge--warning',
  CRITICAL: 'health-badge health-badge--critical',
  UNKNOWN: 'health-badge health-badge--unknown',
};

const CHECK_CLASS: Record<OperationalCheckStatus, string> = {
  PASS: 'health-badge health-badge--ok',
  WARNING: 'health-badge health-badge--warning',
  CRITICAL: 'health-badge health-badge--critical',
  UNKNOWN: 'health-badge health-badge--unknown',
};

function formatDateTime(date: Date | null): string {
  if (!date) return '—';
  // Deterministic UTC formatting avoids server/client locale drift.
  const iso = date.toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)} UTC`;
}

function HealthBadge({ level }: { level: HealthLevel }) {
  return <span className={LEVEL_CLASS[level]}>{level}</span>;
}

function CheckBadge({ status }: { status: OperationalCheckStatus }) {
  return <span className={CHECK_CLASS[status]}>{status}</span>;
}

interface OverviewCardProps {
  label: string;
  value: string | number;
  tone?: 'neutral' | 'warning' | 'critical';
}

function OverviewCard({ label, value, tone = 'neutral' }: OverviewCardProps) {
  const toneClass =
    tone === 'critical'
      ? ' health-card--critical'
      : tone === 'warning'
        ? ' health-card--warning'
        : '';
  return (
    <div className={`admin-card${toneClass}`}>
      <p className="admin-card__label">{label}</p>
      <p className="admin-card__value health-card__value">{value}</p>
    </div>
  );
}

function OperationalChecksSection({ checks }: { checks: OperationalCheck[] }) {
  return (
    <section className="health-section" aria-labelledby="health-ops-heading">
      <h3 id="health-ops-heading" className="health-section__title">
        Operational checks
      </h3>
      <ul className="health-checks">
        {checks.map((check) => (
          <li key={check.id} className="health-check">
            <div className="health-check__head">
              <span className="health-check__label">{check.label}</span>
              <CheckBadge status={check.status} />
            </div>
            <p className="health-check__detail">{check.detail}</p>
          </li>
        ))}
      </ul>
    </section>
  );
}

function MailboxHealthTable({ mailboxes }: { mailboxes: MailboxHealthRow[] }) {
  return (
    <section className="health-section" aria-labelledby="health-mailboxes-heading">
      <h3 id="health-mailboxes-heading" className="health-section__title">
        Mailbox health
      </h3>
      <div className="health-table-wrap">
        <table className="health-table">
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Owner</th>
              <th scope="col">Mailbox</th>
              <th scope="col">Token</th>
              <th scope="col">Telegram</th>
              <th scope="col">Subscription</th>
              <th scope="col">Expires</th>
              <th scope="col">Last sync</th>
              <th scope="col">Last poll</th>
              <th scope="col">Last code sent</th>
              <th scope="col">Last error</th>
              <th scope="col">Health</th>
            </tr>
          </thead>
          <tbody>
            {mailboxes.map((row) => (
              <tr key={row.id}>
                <td>{row.emailAddress}</td>
                <td>{row.customerName ?? row.ownerCustomerName ?? '—'}</td>
                <td>{row.mailboxStatus}</td>
                <td>{row.tokenStatus}</td>
                <td>{row.telegramMappingStatus ?? 'None'}</td>
                <td>{row.subscriptionStatus ?? '—'}</td>
                <td>{formatDateTime(row.subscriptionExpiresAt)}</td>
                <td>{formatDateTime(row.lastSuccessfulSyncAt)}</td>
                <td>{formatDateTime(row.lastPolledAt)}</td>
                <td>{formatDateTime(row.lastCodeSentAt)}</td>
                <td className="health-table__error" title={row.reasons.join('; ')}>
                  {row.lastErrorShort ?? '—'}
                </td>
                <td>
                  <HealthBadge level={row.level} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export default async function HealthDashboardPage() {
  const result = await loadHealthDashboard();

  return (
    <>
      <div className="health-header">
        <div>
          <h2 className="admin-page__heading">Health Dashboard</h2>
          <p className="health-subtitle">
            Tổng quan tình trạng vận hành: mailbox, Microsoft Graph subscription,
            delta polling, email worker và Telegram delivery.
          </p>
        </div>
        {result.ok ? <HealthBadge level={result.data.overview.overall} /> : null}
      </div>

      {!result.ok ? (
        <div className="admin-banner admin-banner--error" role="alert">
          <strong>{result.message}</strong> Vui lòng kiểm tra database/dev server
          rồi thử lại.
        </div>
      ) : result.data.overview.totalMailboxes === 0 ? (
        <>
          <div className="mailboxes-empty">
            <h3 className="mailboxes-empty__title">
              Chưa có mailbox nào để kiểm tra health.
            </h3>
            <p className="mailboxes-empty__description">
              Hãy connect mailbox trước, sau đó quay lại trang Health.
            </p>
          </div>
          <OperationalChecksSection checks={result.data.operationalChecks} />
        </>
      ) : (
        <>
          <section
            className="admin-card-grid health-overview"
            aria-label="Health overview"
          >
            <OverviewCard
              label="Total mailboxes"
              value={result.data.overview.totalMailboxes}
            />
            <OverviewCard
              label="Active mailboxes"
              value={result.data.overview.activeMailboxes}
            />
            <OverviewCard
              label="Reconnect required"
              value={result.data.overview.reconnectRequired}
              tone={result.data.overview.reconnectRequired > 0 ? 'critical' : 'neutral'}
            />
            <OverviewCard
              label="Disabled / error"
              value={result.data.overview.disabledOrError}
              tone={result.data.overview.disabledOrError > 0 ? 'warning' : 'neutral'}
            />
            <OverviewCard
              label="Subscription expired"
              value={result.data.overview.subscriptionExpired}
              tone={result.data.overview.subscriptionExpired > 0 ? 'critical' : 'neutral'}
            />
            <OverviewCard
              label="Expiring < 24h"
              value={result.data.overview.subscriptionExpiringSoon}
              tone={result.data.overview.subscriptionExpiringSoon > 0 ? 'warning' : 'neutral'}
            />
            <OverviewCard
              label="Missing Telegram mapping"
              value={result.data.overview.missingTelegramMapping}
              tone={result.data.overview.missingTelegramMapping > 0 ? 'warning' : 'neutral'}
            />
            <OverviewCard
              label="Polling stale"
              value={result.data.overview.pollingStale}
              tone={result.data.overview.pollingStale > 0 ? 'warning' : 'neutral'}
            />
            <OverviewCard
              label="Telegram failures (24h)"
              value={result.data.overview.recentTelegramFailures}
              tone={result.data.overview.recentTelegramFailures > 0 ? 'critical' : 'neutral'}
            />
            <OverviewCard
              label="Last code sent"
              value={formatDateTime(result.data.overview.lastCodeSentAt)}
            />
            <OverviewCard
              label="Last processed email"
              value={formatDateTime(result.data.overview.lastProcessedEmailAt)}
            />
            <OverviewCard
              label="Last polling run"
              value={formatDateTime(result.data.overview.lastPollingRunAt)}
            />
            <OverviewCard
              label="Last renewal run"
              value={formatDateTime(result.data.overview.lastRenewalRunAt)}
            />
          </section>

          {result.data.overview.lastErrorShort ? (
            <div className="admin-banner admin-banner--warning" role="status">
              <strong>Last error:</strong> {result.data.overview.lastErrorShort}
            </div>
          ) : null}

          <OperationalChecksSection checks={result.data.operationalChecks} />

          <MailboxHealthTable mailboxes={result.data.mailboxes} />
        </>
      )}
    </>
  );
}
