import Link from "next/link";
import { CustomerForm } from "@/components/forms/CustomerForm";
import { createCustomerAction } from "@/services/customers/actions";
import "../customers.css";

export const dynamic = "force-dynamic";

export default function NewCustomerPage() {
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
