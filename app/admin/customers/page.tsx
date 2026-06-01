import Link from "next/link";
import { CustomersTable } from "@/components/tables/CustomersTable";
import { resolveCustomerScope } from "@/lib/auth/access-scope";
import { requireAdminAccess } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { listCustomers } from "@/services/customers/customer.service";
import "./customers.css";

export const dynamic = "force-dynamic";

export default async function CustomersListPage() {
  // TASK-045 — STAFF_READ_ONLY only sees assigned customers; OWNER/ADMIN see all.
  const user = await requireAdminAccess();
  const scope = await resolveCustomerScope(user);
  // TASK-046 — hide create/edit actions from STAFF_READ_ONLY (no MANAGE_CUSTOMERS
  // grant). Backend customer mutations stay guarded regardless of this hiding.
  const canManage = hasPermission(user.role, "MANAGE_CUSTOMERS");
  const customers = await listCustomers(scope);

  return (
    <>
      <div className="customers-header">
        <div>
          <h2 className="admin-page__heading">Customers</h2>
          <p className="customers-subtitle">Manage agency customers.</p>
        </div>
        {canManage ? (
          <Link href="/admin/customers/new" className="customers-header__cta">
            New customer
          </Link>
        ) : null}
      </div>
      <CustomersTable customers={customers} canManage={canManage} />
    </>
  );
}
