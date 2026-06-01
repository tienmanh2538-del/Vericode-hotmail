import Link from "next/link";
import { CustomerForm } from "@/components/forms/CustomerForm";
import { requirePermission } from "@/lib/auth/guards";
import { createCustomerAction } from "@/services/customers/actions";
import "../customers.css";

export const dynamic = "force-dynamic";

export default async function NewCustomerPage() {
  // TASK-045 — creating customers is a MANAGE_CUSTOMERS action; STAFF blocked.
  await requirePermission("MANAGE_CUSTOMERS");
  return (
    <>
      <div className="customers-header">
        <div>
          <h2 className="admin-page__heading">New customer</h2>
          <p className="customers-subtitle">Add a new agency customer.</p>
        </div>
        <Link href="/admin/customers" className="customers-header__back">
          Back to list
        </Link>
      </div>
      <CustomerForm action={createCustomerAction} submitLabel="Create customer" />
    </>
  );
}
