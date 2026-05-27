import Link from "next/link";
import { CustomersTable } from "@/components/tables/CustomersTable";
import { listCustomers } from "@/services/customers/customer.service";
import "./customers.css";

export const dynamic = "force-dynamic";

export default async function CustomersListPage() {
  const customers = await listCustomers();

  return (
    <>
      <div className="customers-header">
        <div>
          <h2 className="admin-page__heading">Customers</h2>
          <p className="customers-subtitle">Manage agency customers.</p>
        </div>
        <Link href="/admin/customers/new" className="customers-header__cta">
          New customer
        </Link>
      </div>
      <CustomersTable customers={customers} />
    </>
  );
}
