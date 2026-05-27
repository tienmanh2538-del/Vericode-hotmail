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
            Paste or build a synthetic email payload for parser development.
            Nothing here is sent to Telegram or read from Microsoft Graph. The
            preview is server-validated and only echoes a short body snippet.
            Use fake addresses and fake verification codes only.
          </p>
        </div>
      </div>

      <section className="telegram-section" aria-label="Mock email form">
        <MockEmailForm />
      </section>
    </>
  );
}
