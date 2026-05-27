import type { ReactNode } from "react";
import { AdminShell } from "@/components/layout/AdminShell";
import "./admin.css";

export default function AdminLayout({ children }: { children: ReactNode }) {
  return <AdminShell>{children}</AdminShell>;
}
