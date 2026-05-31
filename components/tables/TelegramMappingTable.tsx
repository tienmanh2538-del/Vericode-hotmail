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

// A destination is a chat id plus (optional) forum topic. Two mailboxes that
// point at the same chat id + topic are deliberately allowed (TASK-041); this
// key lets the table show how many mailboxes share one destination.
function destinationKey(mapping: TelegramMappingRecord): string {
  return `${mapping.telegramChatId}::${mapping.telegramThreadId ?? ""}`;
}

function countMailboxesPerDestination(
  mappings: TelegramMappingRecord[],
): Map<string, number> {
  const byDestination = new Map<string, Set<string>>();
  for (const mapping of mappings) {
    const key = destinationKey(mapping);
    const mailboxes = byDestination.get(key) ?? new Set<string>();
    mailboxes.add(mapping.mailboxId);
    byDestination.set(key, mailboxes);
  }
  return new Map(
    Array.from(byDestination.entries()).map(([key, set]) => [key, set.size]),
  );
}

export function TelegramMappingTable({ mappings }: TelegramMappingTableProps) {
  if (mappings.length === 0) {
    return (
      <p className="customers-empty">
        No Telegram mappings yet. Use <strong>New mapping</strong> to add the first one.
      </p>
    );
  }

  const sharedCounts = countMailboxesPerDestination(mappings);

  return (
    <table className="customers-table" aria-label="Telegram mappings">
      <thead>
        <tr>
          <th scope="col">Mailbox</th>
          <th scope="col">Customer</th>
          <th scope="col">Group</th>
          <th scope="col">Chat ID</th>
          <th scope="col">Topic</th>
          <th scope="col">Shared by</th>
          <th scope="col">Status</th>
          <th scope="col">Created</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {mappings.map((mapping) => {
          const sharedBy = sharedCounts.get(destinationKey(mapping)) ?? 1;
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
                {mapping.telegramThreadId ? (
                  <span className="telegram-table__topic">
                    {mapping.telegramTopicName ?? "Topic"}{" "}
                    <code className="telegram-table__chat-id">
                      #{mapping.telegramThreadId}
                    </code>
                  </span>
                ) : (
                  "—"
                )}
              </td>
              <td>
                {sharedBy > 1 ? (
                  <span className="telegram-table__shared">
                    {sharedBy} mailboxes
                  </span>
                ) : (
                  "1 mailbox"
                )}
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
