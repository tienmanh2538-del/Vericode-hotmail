import { MockEmailForm } from "@/components/forms/MockEmailForm";
import { resolveCustomerScope } from "@/lib/auth/access-scope";
import { requireAdminAccess } from "@/lib/auth/guards";
import { createLogger } from "@/lib/logger";
import {
  listMockEmailMailboxOptions,
  type MockEmailMailboxOption,
} from "@/services/microsoft/mock-email-mailbox-options.service";
import "../customers/customers.css";
import "./mock-email.css";

export const dynamic = "force-dynamic";

const logger = createLogger({ level: "warn" });

export default async function MockEmailPage() {
  // Mock email is an admin testing tool; scope the mailbox list so STAFF only
  // sees their assigned mailboxes (consistent with the rest of /admin).
  const user = await requireAdminAccess();
  const scope = await resolveCustomerScope(user);

  let mailboxes: MockEmailMailboxOption[] = [];
  try {
    mailboxes = await listMockEmailMailboxOptions(scope);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    logger.error("Failed to load mailbox options for /admin/mock-email", {
      errorMessage: message,
    });
  }

  return (
    <>
      <div className="customers-header">
        <div>
          <h2 className="admin-page__heading">Mock email input</h2>
          <p className="telegram-page__intro">
            Build a synthetic email payload to exercise the verification
            pipeline. <strong>Validate mock email</strong> only server-validates
            the payload and echoes a short, safe JSON preview — nothing is sent.{" "}
            <strong>Process &amp; send to Telegram</strong> runs the full
            pipeline (detect → extract → dedupe) and, on success, delivers a real
            message to the mailbox&apos;s active Telegram mapping. Microsoft Graph
            is never read. Use fake addresses and fake verification codes only.
          </p>
        </div>
      </div>

      <section className="telegram-section" aria-label="Mock email form">
        <MockEmailForm mailboxes={mailboxes} />
      </section>
    </>
  );
}
