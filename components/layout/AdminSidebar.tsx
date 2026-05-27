"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

interface NavItem {
  label: string;
  href: string;
}

const NAV_ITEMS: NavItem[] = [
  { label: "Dashboard", href: "/admin" },
  { label: "Customers", href: "/admin/customers" },
  { label: "Mailboxes", href: "/admin/mailboxes" },
  { label: "Telegram", href: "/admin/telegram" },
  { label: "Mock Email", href: "/admin/mock-email" },
  { label: "Logs", href: "/admin/logs" },
  { label: "Health", href: "/admin/health" },
];

function isItemActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/admin") return pathname === "/admin";
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function AdminSidebar() {
  const pathname = usePathname();
  return (
    <aside className="admin-sidebar" aria-label="Admin navigation">
      <div className="admin-sidebar__brand">Verification Tool</div>
      <nav className="admin-sidebar__nav">
        {NAV_ITEMS.map((item) => {
          const active = isItemActive(pathname, item.href);
          const className = active
            ? "admin-sidebar__link admin-sidebar__link--active"
            : "admin-sidebar__link";
          return (
            <Link
              key={item.href}
              href={item.href}
              className={className}
              aria-current={active ? "page" : undefined}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
