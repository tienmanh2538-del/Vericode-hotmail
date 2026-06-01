import Link from "next/link";
import { notFound } from "next/navigation";
import { CustomerForm } from "@/components/forms/CustomerForm";
import { requirePermission } from "@/lib/auth/guards";
import { updateCustomerAction } from "@/services/customers/actions";
import type { CustomerFormState } from "@/services/customers/form-state";
import { getCustomerById } from "@/services/customers/customer.service";
import "../../customers.css";

export const dynamic = "force-dynamic";

interface EditCustomerPageProps {
  params: { id: string };
}

export default async function EditCustomerPage({ params }: EditCustomerPageProps) {
  // TASK-045 — editing customers is a MANAGE_CUSTOMERS action; STAFF blocked.
  await requirePermission("MANAGE_CUSTOMERS");
  const customer = await getCustomerById(params.id);
  if (!customer) {
    notFound();
  }

  const boundAction: (
    state: CustomerFormState,
    formData: FormData,
  ) => Promise<CustomerFormState> = updateCustomerAction.bind(null, customer.id);

  return (
    <>
      <div className="customers-header">
        <div>
          <h2 className="admin-page__heading">Edit customer</h2>
          <p className="customers-subtitle">Update {customer.name}.</p>
        </div>
        <Link href="/admin/customers" className="customers-header__back">
          Back to list
        </Link>
      </div>
      <CustomerForm
        action={boundAction}
        initialValues={{
          name: customer.name,
          status: customer.status,
          notes: customer.notes,
        }}
        submitLabel="Save changes"
      />
    </>
  );
}
