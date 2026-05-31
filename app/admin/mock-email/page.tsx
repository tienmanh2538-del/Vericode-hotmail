import { MockEmailForm } from "@/components/forms/MockEmailForm";
import "../customers/customers.css";
import "./mock-email.css";

export const dynamic = "force-dynamic";

export default function MockEmailPage() {
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
        <MockEmailForm />
      </section>
    </>
  );
}
