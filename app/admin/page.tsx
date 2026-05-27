interface PlaceholderCard {
  label: string;
  value: string;
}

const PLACEHOLDER_CARDS: PlaceholderCard[] = [
  { label: "Connected mailboxes", value: "Coming soon" },
  { label: "Telegram mappings", value: "Coming soon" },
  { label: "Recent code events", value: "Coming soon" },
  { label: "System health", value: "Coming soon" },
];

const NEXT_STEPS: string[] = [
  "TASK-006: Authentication & admin role skeleton",
  "TASK-007: Customer management (minimal)",
  "TASK-008+: Telegram bot config, mailbox connect, code relay flow",
];

export default function AdminDashboardPage() {
  return (
    <>
      <h2 className="admin-page__heading">Dashboard</h2>
      <section className="admin-card-grid" aria-label="System overview">
        {PLACEHOLDER_CARDS.map((card) => (
          <article key={card.label} className="admin-card">
            <p className="admin-card__label">{card.label}</p>
            <p className="admin-card__value">{card.value}</p>
          </article>
        ))}
      </section>
      <section className="admin-next-steps" aria-label="Next setup steps">
        <h3 className="admin-next-steps__title">Next setup steps</h3>
        <ol className="admin-next-steps__list">
          {NEXT_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>
    </>
  );
}
