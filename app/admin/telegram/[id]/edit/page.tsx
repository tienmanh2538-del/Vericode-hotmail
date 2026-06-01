import Link from "next/link";
import { notFound } from "next/navigation";
import { TelegramMappingForm } from "@/components/forms/TelegramMappingForm";
import { requirePermission } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";
import { updateTelegramMappingAction } from "@/services/telegram/mapping-actions";
import type { TelegramMappingFormState } from "@/services/telegram/mapping-form-state";
import { getTelegramMappingById } from "@/services/telegram/telegram-mapping.service";
import "../../../customers/customers.css";
import "../../telegram.css";

export const dynamic = "force-dynamic";

interface EditMappingPageProps {
  params: { id: string };
}

async function listMailboxesForForm(extraMailboxId?: string | null) {
  const mailboxes = await prisma.mailbox.findMany({
    orderBy: { emailAddress: "asc" },
    select: {
      id: true,
      emailAddress: true,
      customer: { select: { name: true } },
    },
  });
  const result = mailboxes.map((mailbox) => ({
    id: mailbox.id,
    emailAddress: mailbox.emailAddress,
    customerName: mailbox.customer?.name ?? null,
  }));

  // Keep the mapping's current mailbox selectable even if it has been removed
  // from the mailbox list, so editing a stale mapping does not break the form.
  if (extraMailboxId && !result.some((m) => m.id === extraMailboxId)) {
    result.push({ id: extraMailboxId, emailAddress: extraMailboxId, customerName: null });
  }
  return result;
}

export default async function EditTelegramMappingPage({
  params,
}: EditMappingPageProps) {
  // TASK-045 — editing mappings is a MANAGE_TELEGRAM_MAPPINGS action; STAFF blocked.
  await requirePermission("MANAGE_TELEGRAM_MAPPINGS");
  const mapping = await getTelegramMappingById(params.id);
  if (!mapping) {
    notFound();
  }

  const mailboxes = await listMailboxesForForm(mapping.mailboxId);

  const boundAction: (
    state: TelegramMappingFormState,
    formData: FormData,
  ) => Promise<TelegramMappingFormState> = updateTelegramMappingAction.bind(
    null,
    mapping.id,
  );

  return (
    <>
      <div className="customers-header">
        <div>
          <h2 className="admin-page__heading">Edit Telegram mapping</h2>
          <p className="customers-subtitle">
            Update group name, chat ID, or status for{" "}
            {mapping.mailboxEmail ?? mapping.mailboxId}.
          </p>
        </div>
        <Link href="/admin/telegram" className="customers-header__back">
          Back to list
        </Link>
      </div>
      <TelegramMappingForm
        action={boundAction}
        mailboxes={mailboxes}
        initialValues={{
          mailboxId: mapping.mailboxId,
          telegramChatId: mapping.telegramChatId,
          telegramGroupName: mapping.telegramGroupName ?? "",
          telegramThreadId: mapping.telegramThreadId ?? "",
          telegramTopicName: mapping.telegramTopicName ?? "",
          status: mapping.status,
        }}
        submitLabel="Save changes"
      />
    </>
  );
}
