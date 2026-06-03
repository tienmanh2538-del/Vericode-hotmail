import { resolveCustomerScope } from '@/lib/auth/access-scope';
import { requireAdminAccess } from '@/lib/auth/guards';
import { loadHealthDashboard } from '@/services/health/health.service';
import type {
  CustomerWorkloadRow,
  HealthLevel,
  MailboxHealthRow,
  OperationalCheck,
  OperationalCheckStatus,
} from '@/services/health/health.types';
import {
  READINESS_LABEL,
  type MailboxReadiness,
} from '@/lib/mailboxes/mailbox-list-filter';
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

function ReadinessText({ readiness }: { readiness: MailboxReadiness }) {
  return <>{READINESS_LABEL[readiness]}</>;
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

function WorkloadSection({ rows }: { rows: CustomerWorkloadRow[] }) {
  if (rows.length === 0) return null;
  return (
    <section className="health-section" aria-labelledby="health-workload-heading">
      <h3 id="health-workload-heading" className="health-section__title">
        Workload by customer
      </h3>
      <div className="health-table-wrap">
        <table className="health-table">
          <thead>
            <tr>
              <th scope="col">Customer</th>
              <th scope="col">Total mailboxes</th>
              <th scope="col">Ready</th>
              <th scope="col">Needs mapping</th>
              <th scope="col">Error / disconnected</th>
              <th scope="col">Recent issues (24h)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.customerId ?? `unassigned:${row.customerName}`}>
                <td>{row.customerName}</td>
                <td>{row.totalMailboxes}</td>
                <td>{row.readyMailboxes}</td>
                <td>{row.needsMapping}</td>
                <td>{row.errorOrDisconnected}</td>
                <td>{row.recentIssueCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function OperationalChecksSection({ checks }: { checks: OperationalCheck[] }) {
  if (checks.length === 0) return null;
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
        Mailbox issues
      </h3>
      <div className="health-table-wrap">
        <table className="health-table">
          <thead>
            <tr>
              <th scope="col">Email</th>
              <th scope="col">Customer</th>
              <th scope="col">Readiness</th>
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
                <td>
                  <ReadinessText readiness={row.readiness} />
                </td>
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
  // TASK-056 — STAFF_READ_ONLY only sees the operational health of mailboxes
  // belonging to their assigned customers. Scope is enforced in the service
  // layer (loadHealthDashboard); the UI only decides how to present the result.
  const user = await requireAdminAccess();
  const scope = await resolveCustomerScope(user);

  // Staff with no assignment must see a safe empty state — never a global view.
  const hasNoAssignment =
    scope.kind === 'assigned' && scope.customerIds.length === 0;

  if (hasNoAssignment) {
    return (
      <>
        <div className="health-header">
          <div>
            <h2 className="admin-page__heading">Health Dashboard</h2>
            <p className="health-subtitle">
              Tình trạng vận hành của mailbox trong phạm vi được phân công.
            </p>
          </div>
        </div>
        <div className="mailboxes-empty">
          <h3 className="mailboxes-empty__title">
            Bạn chưa được phân công customer nào.
          </h3>
          <p className="mailboxes-empty__description">
            Khi được OWNER/ADMIN phân công, health của các mailbox tương ứng sẽ
            hiển thị ở đây.
          </p>
        </div>
      </>
    );
  }

  const result = await loadHealthDashboard(scope);

  return (
    <>
      <div className="health-header">
        <div>
          <h2 className="admin-page__heading">Health Dashboard</h2>
          <p className="health-subtitle">
            Tổng quan tình trạng vận hành: mailbox readiness, mapping, Microsoft
            Graph subscription, delta polling và Telegram delivery.
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
              label="Ready"
              value={result.data.overview.readyMailboxes}
            />
            <OverviewCard
              label="Active mailboxes"
              value={result.data.overview.activeMailboxes}
            />
            <OverviewCard
              label="Needs mapping"
              value={result.data.overview.needsMapping}
              tone={result.data.overview.needsMapping > 0 ? 'warning' : 'neutral'}
            />
            <OverviewCard
              label="Needs customer"
              value={result.data.overview.needsCustomer}
              tone={result.data.overview.needsCustomer > 0 ? 'warning' : 'neutral'}
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
          </section>

          {result.data.overview.lastErrorShort ? (
            <div className="admin-banner admin-banner--warning" role="status">
              <strong>Last error:</strong> {result.data.overview.lastErrorShort}
            </div>
          ) : null}

          <WorkloadSection rows={result.data.workload} />

          <OperationalChecksSection checks={result.data.operationalChecks} />

          <MailboxHealthTable mailboxes={result.data.mailboxes} />
        </>
      )}
    </>
  );
}
