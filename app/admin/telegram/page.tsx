import { TelegramMappingForm } from "@/components/forms/TelegramMappingForm";
import { TelegramMappingTable } from "@/components/tables/TelegramMappingTable";
import { prisma } from "@/lib/prisma";
import { createTelegramMappingAction } from "@/services/telegram/mapping-actions";
import { listTelegramMappings } from "@/services/telegram/telegram-mapping.service";
import "../customers/customers.css";
import "./telegram.css";

export const dynamic = "force-dynamic";

async function listMailboxesForForm() {
  const mailboxes = await prisma.mailbox.findMany({
    orderBy: { emailAddress: "asc" },
    select: {
      id: true,
      emailAddress: true,
      customer: { select: { name: true } },
    },
  });
  return mailboxes.map((mailbox) => ({
    id: mailbox.id,
    emailAddress: mailbox.emailAddress,
    customerName: mailbox.customer?.name ?? null,
  }));
}

export default async function TelegramMappingsPage() {
  const [mappings, mailboxes] = await Promise.all([
    listTelegramMappings(),
    listMailboxesForForm(),
  ]);

  return (
    <>
      <div className="customers-header">
        <div>
          <h2 className="admin-page__heading">Telegram mappings</h2>
          <p className="telegram-page__intro">
            Map a customer mailbox to a Telegram group so the system can deliver
            verification codes to the right place. Chat IDs are stored in the
            database, never hardcoded. Bot tokens stay server-side.
          </p>
        </div>
      </div>

      <section className="telegram-section" aria-label="Existing mappings">
        <h3 className="telegram-section__heading">Existing mappings</h3>
        <TelegramMappingTable mappings={mappings} />
      </section>

      <section className="telegram-section" aria-label="Add new mapping">
        <h3 className="telegram-section__heading">New mapping</h3>
        <TelegramMappingForm
          action={createTelegramMappingAction}
          mailboxes={mailboxes}
          submitLabel="Create mapping"
        />
      </section>
    </>
  );
}
