import Link from "next/link";
import {
  deleteTelegramMappingAction,
  disableTelegramMappingAction,
} from "@/services/telegram/mapping-actions";
import type { TelegramMappingRecord } from "@/services/telegram/telegram-mapping.service";

interface TelegramMappingTableProps {
  mappings: TelegramMappingRecord[];
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function TelegramMappingTable({ mappings }: TelegramMappingTableProps) {
  if (mappings.length === 0) {
    return (
      <p className="customers-empty">
        No Telegram mappings yet. Use <strong>New mapping</strong> to add the first one.
      </p>
    );
  }

  return (
    <table className="customers-table" aria-label="Telegram mappings">
      <thead>
        <tr>
          <th scope="col">Mailbox</th>
          <th scope="col">Customer</th>
          <th scope="col">Group</th>
          <th scope="col">Chat ID</th>
          <th scope="col">Status</th>
          <th scope="col">Created</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {mappings.map((mapping) => {
          const disableAction = disableTelegramMappingAction.bind(null, mapping.id);
          const deleteAction = deleteTelegramMappingAction.bind(null, mapping.id);
          return (
            <tr key={mapping.id}>
              <td>{mapping.mailboxEmail ?? mapping.mailboxId}</td>
              <td>{mapping.customerName ?? "—"}</td>
              <td>{mapping.telegramGroupName ?? "—"}</td>
              <td>
                <code className="telegram-table__chat-id">
                  {mapping.telegramChatId}
                </code>
              </td>
              <td>
                <span
                  className={`customer-status customer-status--${mapping.status.toLowerCase()}`}
                >
                  {mapping.status}
                </span>
              </td>
              <td>{formatDate(mapping.createdAt)}</td>
              <td>
                <div className="telegram-table__actions">
                  <Link
                    href={`/admin/telegram/${mapping.id}/edit`}
                    className="customers-table__action"
                  >
                    Edit
                  </Link>
                  {mapping.status === "ACTIVE" ? (
                    <form action={disableAction}>
                      <button
                        type="submit"
                        className="telegram-table__action telegram-table__action--warn"
                      >
                        Disable
                      </button>
                    </form>
                  ) : null}
                  <form action={deleteAction}>
                    <button
                      type="submit"
                      className="telegram-table__action telegram-table__action--danger"
                    >
                      Delete
                    </button>
                  </form>
                </div>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
