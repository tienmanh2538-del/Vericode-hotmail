import {
  AUDIT_LOG_ACTION_LABELS,
  AUDIT_LOG_ACTIONS,
  AUDIT_LOG_ENTITY_TYPES,
  type AuditLogAction,
  type AuditLogEntityType,
  type AuditLogListFilters,
  listAuditLogs,
} from "@/services/logs/audit-log.service";
import { AuditLogTable } from "@/components/tables/AuditLogTable";
import "../../customers/customers.css";
import "./audit-log.css";

export const dynamic = "force-dynamic";

interface AuditLogPageProps {
  searchParams?: {
    action?: string;
    entityType?: string;
    search?: string;
    from?: string;
    to?: string;
  };
}

function firstString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function parseAction(value: string | undefined): AuditLogAction | undefined {
  if (!value) return undefined;
  return AUDIT_LOG_ACTIONS.has(value as AuditLogAction)
    ? (value as AuditLogAction)
    : undefined;
}

function parseEntityType(
  value: string | undefined,
): AuditLogEntityType | undefined {
  if (!value) return undefined;
  return AUDIT_LOG_ENTITY_TYPES.has(value as AuditLogEntityType)
    ? (value as AuditLogEntityType)
    : undefined;
}

function trimOrUndefined(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export default function AuditLogPage({ searchParams }: AuditLogPageProps) {
  const rawAction = firstString(searchParams?.action);
  const rawEntityType = firstString(searchParams?.entityType);
  const rawSearch = firstString(searchParams?.search);
  const rawFrom = firstString(searchParams?.from);
  const rawTo = firstString(searchParams?.to);

  const filters: AuditLogListFilters = {
    action: parseAction(rawAction),
    entityType: parseEntityType(rawEntityType),
    search: trimOrUndefined(rawSearch),
    from: trimOrUndefined(rawFrom),
    to: trimOrUndefined(rawTo),
    limit: 500,
  };

  const result = listAuditLogs(filters);

  const actionOptions = Array.from(AUDIT_LOG_ACTIONS).sort();
  const entityTypeOptions = Array.from(AUDIT_LOG_ENTITY_TYPES).sort();

  return (
    <>
      <div className="customers-header">
        <div>
          <h2 className="admin-page__heading">Audit log</h2>
          <p className="customers-subtitle">
            Read-only audit trail of admin and system actions. Sensitive
            metadata fields (tokens, secrets, passwords, verification codes)
            are redacted before storage and display.
          </p>
        </div>
      </div>

      <form
        method="get"
        className="audit-log-filters"
        aria-label="Audit log filters"
      >
        <div className="audit-log-filters__field">
          <label htmlFor="audit-search" className="audit-log-filters__label">
            Search
          </label>
          <input
            id="audit-search"
            name="search"
            type="search"
            defaultValue={filters.search ?? ""}
            placeholder="Actor, entity, summary…"
            className="audit-log-filters__input"
          />
        </div>

        <div className="audit-log-filters__field">
          <label htmlFor="audit-action" className="audit-log-filters__label">
            Action
          </label>
          <select
            id="audit-action"
            name="action"
            defaultValue={filters.action ?? ""}
            className="audit-log-filters__select"
          >
            <option value="">All actions</option>
            {actionOptions.map((action) => (
              <option key={action} value={action}>
                {AUDIT_LOG_ACTION_LABELS[action] ?? action}
              </option>
            ))}
          </select>
        </div>

        <div className="audit-log-filters__field">
          <label
            htmlFor="audit-entity-type"
            className="audit-log-filters__label"
          >
            Entity type
          </label>
          <select
            id="audit-entity-type"
            name="entityType"
            defaultValue={filters.entityType ?? ""}
            className="audit-log-filters__select"
          >
            <option value="">All entities</option>
            {entityTypeOptions.map((entityType) => (
              <option key={entityType} value={entityType}>
                {entityType}
              </option>
            ))}
          </select>
        </div>

        <div className="audit-log-filters__field">
          <label htmlFor="audit-from" className="audit-log-filters__label">
            From
          </label>
          <input
            id="audit-from"
            name="from"
            type="date"
            defaultValue={filters.from ? String(filters.from).slice(0, 10) : ""}
            className="audit-log-filters__input"
          />
        </div>

        <div className="audit-log-filters__field">
          <label htmlFor="audit-to" className="audit-log-filters__label">
            To
          </label>
          <input
            id="audit-to"
            name="to"
            type="date"
            defaultValue={filters.to ? String(filters.to).slice(0, 10) : ""}
            className="audit-log-filters__input"
          />
        </div>

        <div className="audit-log-filters__actions">
          <button type="submit" className="audit-log-filters__submit">
            Apply
          </button>
          <a href="/admin/logs/audit" className="audit-log-filters__reset">
            Reset
          </a>
        </div>
      </form>

      <p className="audit-log-summary">
        Showing {result.items.length} of {result.total} matching audit entries.
      </p>

      <section aria-label="Audit log entries">
        <AuditLogTable items={result.items} />
      </section>
    </>
  );
}
