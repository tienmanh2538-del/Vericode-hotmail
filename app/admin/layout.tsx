import type { ReactNode } from "react";
import { AdminShell } from "@/components/layout/AdminShell";
import { requireAdminAccess } from "@/lib/auth/guards";
import "./admin.css";

export default async function AdminLayout({ children }: { children: ReactNode }) {
  await requireAdminAccess();
  return <AdminShell>{children}</AdminShell>;
}
