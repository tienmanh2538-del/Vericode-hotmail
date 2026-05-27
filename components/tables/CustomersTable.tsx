import Link from "next/link";
import type { CustomerRecord } from "@/services/customers/customer.service";

interface CustomersTableProps {
  customers: CustomerRecord[];
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function CustomersTable({ customers }: CustomersTableProps) {
  if (customers.length === 0) {
    return (
      <p className="customers-empty">
        No customers yet. Use <strong>New customer</strong> to add the first one.
      </p>
    );
  }

  return (
    <table className="customers-table" aria-label="Customers">
      <thead>
        <tr>
          <th scope="col">Name</th>
          <th scope="col">Status</th>
          <th scope="col">Created</th>
          <th scope="col">Actions</th>
        </tr>
      </thead>
      <tbody>
        {customers.map((customer) => (
          <tr key={customer.id}>
            <td>{customer.name}</td>
            <td>
              <span
                className={`customer-status customer-status--${customer.status.toLowerCase()}`}
              >
                {customer.status}
              </span>
            </td>
            <td>{formatDate(customer.createdAt)}</td>
            <td>
              <Link
                href={`/admin/customers/${customer.id}/edit`}
                className="customers-table__action"
              >
                Edit
              </Link>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
