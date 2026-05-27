import type { ReactNode } from "react";
import { AdminSidebar } from "./AdminSidebar";
import { AdminTopbar } from "./AdminTopbar";

interface AdminShellProps {
  children: ReactNode;
}

export function AdminShell({ children }: AdminShellProps) {
  return (
    <div className="admin-shell">
      <AdminSidebar />
      <div className="admin-shell__main">
        <AdminTopbar />
        <main className="admin-shell__content">{children}</main>
      </div>
    </div>
  );
}
