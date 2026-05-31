import Link from "next/link";

export const dynamic = "force-dynamic";

interface LogLink {
  href: string;
  label: string;
  description: string;
}

const LOG_LINKS: LogLink[] = [
  {
    href: "/admin/logs/code-events",
    label: "Code Events",
    description:
      "Verification code delivery events captured from the email pipeline.",
  },
  {
    href: "/admin/logs/audit",
    label: "Audit Logs",
    description:
      "Read-only audit trail of admin and system actions.",
  },
];

export default function LogsIndexPage() {
  return (
    <>
      <h2 className="admin-page__heading">Logs</h2>

      <section className="admin-card-grid" aria-label="Log sections">
        {LOG_LINKS.map((link) => (
          <Link key={link.href} href={link.href} className="admin-card">
            <p className="admin-card__value">{link.label}</p>
            <p className="admin-card__label">{link.description}</p>
          </Link>
        ))}
      </section>
    </>
  );
}
