import Link from "next/link";
import { notFound } from "next/navigation";
import { TelegramDestinationForm } from "@/components/forms/TelegramDestinationForm";
import { requirePermission } from "@/lib/auth/guards";
import { resolveCustomerScope } from "@/lib/auth/access-scope";
import { updateTelegramDestinationAction } from "@/services/telegram/destination-actions";
import type { TelegramDestinationFormState } from "@/services/telegram/destination-form-state";
import { getTelegramDestinationById } from "@/services/telegram/telegram-destination.service";
import { listCustomers } from "@/services/customers/customer.service";
import "../../../../customers/customers.css";
import "../../../telegram.css";

export const dynamic = "force-dynamic";

interface EditDestinationPageProps {
  params: { id: string };
}

export default async function EditTelegramDestinationPage({
  params,
}: EditDestinationPageProps) {
  // Editing a destination is a MANAGE_TELEGRAM_MAPPINGS action; STAFF blocked.
  const user = await requirePermission("MANAGE_TELEGRAM_MAPPINGS");
  // TASK-078 — fail closed: an out-of-scope destination resolves to null → notFound.
  const scope = await resolveCustomerScope(user);
  const destination = await getTelegramDestinationById(params.id, scope);
  if (!destination) {
    notFound();
  }

  const customers = await listCustomers();
  // Keep the destination's current customer selectable even if archived/hidden.
  if (!customers.some((c) => c.id === destination.customerId)) {
    customers.push({
      id: destination.customerId,
      name: destination.customerName ?? destination.customerId,
      status: "ACTIVE",
      notes: null,
      createdAt: destination.createdAt,
      updatedAt: destination.updatedAt,
    });
  }

  const boundAction: (
    state: TelegramDestinationFormState,
    formData: FormData,
  ) => Promise<TelegramDestinationFormState> =
    updateTelegramDestinationAction.bind(null, destination.id);

  return (
    <>
      <div className="customers-header">
        <div>
          <h2 className="admin-page__heading">Edit Telegram destination</h2>
          <p className="customers-subtitle">
            Update the saved group/topic for{" "}
            <strong>{destination.displayName}</strong>.
          </p>
        </div>
        <Link href="/admin/telegram" className="customers-header__back">
          Back to list
        </Link>
      </div>
      <TelegramDestinationForm
        action={boundAction}
        customers={customers.map((c) => ({ id: c.id, name: c.name }))}
        initialValues={{
          customerId: destination.customerId,
          displayName: destination.displayName,
          telegramGroupName: destination.telegramGroupName,
          telegramChatId: destination.telegramChatId,
          telegramTopicName: destination.telegramTopicName ?? "",
          telegramThreadId: destination.telegramThreadId ?? "",
          status: destination.status,
        }}
        submitLabel="Save changes"
      />
    </>
  );
}
