import { AuditSeverityBadge } from "@/components/status/AuditSeverityBadge";
import {
  AUDIT_LOG_ACTION_LABELS,
  type AuditLogListItem,
} from "@/services/logs/audit-log.service";

interface AuditLogTableProps {
  items: readonly AuditLogListItem[];
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function formatActor(item: AuditLogListItem): string {
  if (item.actorEmail) return item.actorEmail;
  if (item.actorUserId) return item.actorUserId;
  return "system";
}

function formatMetadataPreview(
  metadata: AuditLogListItem["metadata"],
): string | null {
  if (!metadata) return null;
  const keys = Object.keys(metadata);
  if (keys.length === 0) return null;
  // Show sanitized JSON (already redacted by the service). Truncate to keep
  // the table row compact; the page intentionally does not offer a "raw"
  // view that would bypass the redaction layer.
  const json = JSON.stringify(metadata);
  if (json.length <= 160) return json;
  return `${json.slice(0, 157)}…`;
}

export function AuditLogTable({ items }: AuditLogTableProps) {
  if (items.length === 0) {
    return (
      <p className="customers-empty">
        No audit log entries match the current filters. Audit entries appear
        here when admins act or when the system records significant events.
      </p>
    );
  }

  return (
    <table className="customers-table audit-log-table" aria-label="Audit log">
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Actor</th>
          <th scope="col">Action</th>
          <th scope="col">Entity</th>
          <th scope="col">Entity ID</th>
          <th scope="col">IP address</th>
          <th scope="col">Severity</th>
          <th scope="col">Summary</th>
        </tr>
      </thead>
      <tbody>
        {items.map((item) => {
          const metadataPreview = formatMetadataPreview(item.metadata);
          return (
            <tr key={item.id}>
              <td>
                <time dateTime={item.createdAt}>
                  {formatTimestamp(item.createdAt)}
                </time>
              </td>
              <td>{formatActor(item)}</td>
              <td>{AUDIT_LOG_ACTION_LABELS[item.action] ?? item.action}</td>
              <td>{item.entityType}</td>
              <td>
                {item.entityId ? (
                  <code className="audit-log-table__entity-id">
                    {item.entityId}
                  </code>
                ) : (
                  "—"
                )}
              </td>
              <td>{item.ipAddress ?? "—"}</td>
              <td>
                <AuditSeverityBadge severity={item.severity} />
              </td>
              <td className="audit-log-table__summary">
                <div>{item.summary ?? "—"}</div>
                {metadataPreview ? (
                  <pre
                    className="audit-log-table__metadata"
                    aria-label="Sanitized metadata"
                  >
                    {metadataPreview}
                  </pre>
                ) : null}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
