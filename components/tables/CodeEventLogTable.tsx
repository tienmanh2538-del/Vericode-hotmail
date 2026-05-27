import { CodeEventStatusBadge } from "@/components/status/CodeEventStatusBadge";
import type { CodeEventLogItem } from "@/services/logs/code-event-log.service";

interface CodeEventLogTableProps {
  events: readonly CodeEventLogItem[];
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toISOString().replace("T", " ").slice(0, 19) + "Z";
}

function formatConfidence(value: number | undefined): string {
  if (value === undefined) return "—";
  return `${Math.round(value)}%`;
}

export function CodeEventLogTable({ events }: CodeEventLogTableProps) {
  if (events.length === 0) {
    return (
      <p className="customers-empty">
        No code events recorded yet. Once the mock email pipeline processes
        verification emails, masked events will appear here.
      </p>
    );
  }

  return (
    <table className="customers-table code-event-table" aria-label="Code event log">
      <thead>
        <tr>
          <th scope="col">Time</th>
          <th scope="col">Mailbox</th>
          <th scope="col">Customer</th>
          <th scope="col">Platform</th>
          <th scope="col">Status</th>
          <th scope="col">Masked code</th>
          <th scope="col">Confidence</th>
          <th scope="col">Telegram group</th>
          <th scope="col">Source</th>
          <th scope="col">Message</th>
        </tr>
      </thead>
      <tbody>
        {events.map((event) => (
          <tr key={event.id}>
            <td>
              <time dateTime={event.createdAt}>
                {formatTimestamp(event.createdAt)}
              </time>
            </td>
            <td>{event.mailboxEmail}</td>
            <td>{event.customerName ?? "—"}</td>
            <td>{event.platform}</td>
            <td>
              <CodeEventStatusBadge status={event.status} />
            </td>
            <td>
              <code className="code-event-table__masked">
                {event.maskedCode ?? "—"}
              </code>
            </td>
            <td>{formatConfidence(event.confidence)}</td>
            <td>{event.telegramGroupName ?? "—"}</td>
            <td>{event.source}</td>
            <td className="code-event-table__message">
              {event.message ?? "—"}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
