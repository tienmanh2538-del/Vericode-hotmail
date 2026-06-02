import Link from "next/link";
import { disableTelegramDestinationAction } from "@/services/telegram/destination-actions";
import type { TelegramDestinationRecord } from "@/services/telegram/telegram-destination.service";

interface TelegramDestinationTableProps {
  destinations: TelegramDestinationRecord[];
  canManage: boolean;
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function TelegramDestinationTable({
  destinations,
  canManage,
}: TelegramDestinationTableProps) {
  if (destinations.length === 0) {
    return (
      <p className="customers-empty">
        No Telegram destinations yet.
        {canManage ? (
          <>
            {" "}
            Use <strong>New destination</strong> to add the first one.
          </>
        ) : null}
      </p>
    );
  }

  return (
    <table className="customers-table" aria-label="Telegram destinations">
      <thead>
        <tr>
          <th scope="col">Destination</th>
          <th scope="col">Customer</th>
          <th scope="col">Group</th>
          <th scope="col">Chat ID</th>
          <th scope="col">Topic</th>
          <th scope="col">Used by</th>
          <th scope="col">Status</th>
          <th scope="col">Created</th>
          {canManage ? <th scope="col">Actions</th> : null}
        </tr>
      </thead>
      <tbody>
        {destinations.map((destination) => {
          const disableAction = disableTelegramDestinationAction.bind(
            null,
            destination.id,
          );
          return (
            <tr key={destination.id}>
              <td>{destination.displayName}</td>
              <td>{destination.customerName ?? "—"}</td>
              <td>{destination.telegramGroupName}</td>
              <td>
                <code className="telegram-table__chat-id">
                  {destination.telegramChatId}
                </code>
              </td>
              <td>
                {destination.telegramThreadId ? (
                  <span className="telegram-table__topic">
                    {destination.telegramTopicName ?? "Topic"}{" "}
                    <code className="telegram-table__chat-id">
                      #{destination.telegramThreadId}
                    </code>
                  </span>
                ) : (
                  "—"
                )}
              </td>
              <td>
                {destination.mappingCount === 1
                  ? "1 mailbox"
                  : `${destination.mappingCount} mailboxes`}
              </td>
              <td>
                <span
                  className={`customer-status customer-status--${destination.status.toLowerCase()}`}
                >
                  {destination.status}
                </span>
              </td>
              <td>{formatDate(destination.createdAt)}</td>
              {canManage ? (
                <td>
                  <div className="telegram-table__actions">
                    <Link
                      href={`/admin/telegram/destinations/${destination.id}/edit`}
                      className="customers-table__action"
                    >
                      Edit
                    </Link>
                    {destination.status === "ACTIVE" ? (
                      <form action={disableAction}>
                        <button
                          type="submit"
                          className="telegram-table__action telegram-table__action--warn"
                        >
                          Disable
                        </button>
                      </form>
                    ) : null}
                  </div>
                </td>
              ) : null}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
