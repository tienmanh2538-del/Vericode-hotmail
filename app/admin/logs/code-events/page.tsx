import { CodeEventLogTable } from "@/components/tables/CodeEventLogTable";
import { summarizeCodeEvents } from "@/services/logs/code-event-log.service";
import { listCodeEventsFromDb } from "@/services/logs/prisma-code-event-store";
import "../../customers/customers.css";
import "./code-events.css";

export const dynamic = "force-dynamic";

interface SummaryCard {
  label: string;
  value: number;
}

export default async function CodeEventLogPage() {
  const events = await listCodeEventsFromDb();
  const summary = summarizeCodeEvents(events);

  const cards: SummaryCard[] = [
    { label: "Total", value: summary.total },
    { label: "Sent", value: summary.sent },
    { label: "Skipped duplicate", value: summary.skippedDuplicate },
    { label: "Low confidence", value: summary.lowConfidence },
    { label: "Failed", value: summary.failed },
  ];

  return (
    <>
      <div className="customers-header">
        <div>
          <h2 className="admin-page__heading">Code event log</h2>
          <p className="customers-subtitle">
            Recent verification code events from the mock email pipeline.
            Codes are shown masked only — the full code is never stored or
            displayed. Email bodies and Telegram bot tokens are never shown.
          </p>
        </div>
      </div>

      <section
        className="code-event-summary"
        aria-label="Code event summary"
      >
        {cards.map((card) => (
          <article key={card.label} className="code-event-summary__card">
            <p className="code-event-summary__label">{card.label}</p>
            <p className="code-event-summary__value">{card.value}</p>
          </article>
        ))}
      </section>

      <section aria-label="Code events">
        <CodeEventLogTable events={events} />
      </section>
    </>
  );
}
