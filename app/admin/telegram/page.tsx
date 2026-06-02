import { TelegramMappingForm } from "@/components/forms/TelegramMappingForm";
import { TelegramMappingTable } from "@/components/tables/TelegramMappingTable";
import { TelegramDestinationForm } from "@/components/forms/TelegramDestinationForm";
import { TelegramDestinationTable } from "@/components/tables/TelegramDestinationTable";
import { resolveCustomerScope } from "@/lib/auth/access-scope";
import { requireAdminAccess } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";
import { prisma } from "@/lib/prisma";
import { createTelegramMappingAction } from "@/services/telegram/mapping-actions";
import { createTelegramDestinationAction } from "@/services/telegram/destination-actions";
import { listTelegramMappings } from "@/services/telegram/telegram-mapping.service";
import { listTelegramDestinations } from "@/services/telegram/telegram-destination.service";
import { listCustomers } from "@/services/customers/customer.service";
import type { CustomerScope } from "@/lib/auth/access-scope";
import "../customers/customers.css";
import "./telegram.css";

export const dynamic = "force-dynamic";

async function listMailboxesForForm(scope: CustomerScope) {
  const mailboxes = await prisma.mailbox.findMany({
    orderBy: { emailAddress: "asc" },
    ...(scope.kind === "assigned"
      ? { where: { customerId: { in: scope.customerIds } } }
      : {}),
    select: {
      id: true,
      emailAddress: true,
      customerId: true,
      customer: { select: { name: true } },
    },
  });
  return mailboxes.map((mailbox) => ({
    id: mailbox.id,
    emailAddress: mailbox.emailAddress,
    customerId: mailbox.customerId,
    customerName: mailbox.customer?.name ?? null,
  }));
}

export default async function TelegramMappingsPage() {
  // TASK-045 / TASK-053 — STAFF_READ_ONLY only sees mappings + destinations of
  // assigned customers and cannot manage them. Every create/edit form is gated
  // on MANAGE_TELEGRAM_MAPPINGS (OWNER/ADMIN only).
  const user = await requireAdminAccess();
  const scope = await resolveCustomerScope(user);
  const canManage = hasPermission(user.role, "MANAGE_TELEGRAM_MAPPINGS");

  const [mappings, destinations] = await Promise.all([
    listTelegramMappings(scope),
    listTelegramDestinations(scope),
  ]);

  const mailboxes = canManage ? await listMailboxesForForm(scope) : [];
  const customers = canManage ? await listCustomers(scope) : [];
  const destinationOptions = destinations.map((destination) => ({
    id: destination.id,
    customerId: destination.customerId,
    displayName: destination.displayName,
    telegramGroupName: destination.telegramGroupName,
    telegramTopicName: destination.telegramTopicName,
    status: destination.status,
  }));

  return (
    <>
      <div className="customers-header">
        <div>
          <h2 className="admin-page__heading">Telegram</h2>
          <p className="telegram-page__intro">
            Configure reusable Telegram destinations once, then map each customer
            mailbox to a saved destination. Chat IDs are stored in the database,
            never hardcoded. Bot tokens stay server-side.
          </p>
        </div>
      </div>

      <section className="telegram-section" aria-label="Telegram destinations">
        <h3 className="telegram-section__heading">Destinations</h3>
        <TelegramDestinationTable
          destinations={destinations}
          canManage={canManage}
        />
        {canManage ? (
          <div className="telegram-subsection">
            <h4 className="telegram-section__heading">New destination</h4>
            <TelegramDestinationForm
              action={createTelegramDestinationAction}
              customers={customers}
              submitLabel="Create destination"
            />
          </div>
        ) : null}
      </section>

      <section className="telegram-section" aria-label="Existing mappings">
        <h3 className="telegram-section__heading">Mailbox mappings</h3>
        <TelegramMappingTable mappings={mappings} />
      </section>

      {canManage ? (
        <section className="telegram-section" aria-label="Add new mapping">
          <h3 className="telegram-section__heading">New mapping</h3>
          <TelegramMappingForm
            action={createTelegramMappingAction}
            mailboxes={mailboxes}
            destinations={destinationOptions}
            submitLabel="Create mapping"
          />
        </section>
      ) : null}
    </>
  );
}
