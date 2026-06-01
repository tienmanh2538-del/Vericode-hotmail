import Link from "next/link";
import { ConnectMailboxButton } from "@/components/admin/ConnectMailboxButton";
import { requireAdminAccess } from "@/lib/auth/guards";
import { hasPermission } from "@/lib/auth/permissions";

export const dynamic = "force-dynamic";

interface PlaceholderCard {
  label: string;
  value: string;
}

const PLACEHOLDER_CARDS: PlaceholderCard[] = [
  { label: "Connected mailboxes", value: "Coming soon" },
  { label: "Telegram mappings", value: "Coming soon" },
  { label: "Recent code events", value: "Coming soon" },
  { label: "System health", value: "Coming soon" },
];

const NEXT_STEPS: string[] = [
  "TASK-006: Authentication & admin role skeleton",
  "TASK-007: Customer management (minimal)",
  "TASK-008+: Telegram bot config, mailbox connect, code relay flow",
];

type OAuthStatus = "success" | "error";

type OAuthReason =
  | "access_denied"
  | "oauth_error"
  | "invalid_request"
  | "invalid_state"
  | "missing_code"
  | "token_exchange_failed"
  | "mailbox_save_failed";

const OAUTH_REASON_MESSAGES: Record<OAuthReason, string> = {
  access_denied: "Bạn đã từ chối cấp quyền cho Microsoft.",
  oauth_error: "Microsoft trả về lỗi OAuth không xác định.",
  invalid_request: "Yêu cầu OAuth không hợp lệ.",
  invalid_state:
    "Phiên kết nối đã hết hạn hoặc cookie state bị mất. Hãy bấm Connect Hotmail lại từ đầu.",
  missing_code: "Microsoft không trả về authorization code.",
  token_exchange_failed:
    "Không lấy được token từ Microsoft. Kiểm tra cấu hình App Registration.",
  mailbox_save_failed:
    "Đã lấy được token nhưng không lưu được mailbox vào database.",
};

function parseStatus(value: string | string[] | undefined): OAuthStatus | null {
  if (value === "success" || value === "error") return value;
  return null;
}

function parseReason(value: string | string[] | undefined): OAuthReason | null {
  if (typeof value !== "string") return null;
  return value in OAUTH_REASON_MESSAGES ? (value as OAuthReason) : null;
}

interface AdminDashboardPageProps {
  searchParams?: {
    oauth?: string | string[];
    reason?: string | string[];
  };
}

export default async function AdminDashboardPage({
  searchParams,
}: AdminDashboardPageProps) {
  // TASK-047 — connect mailbox is an onboarding action: OWNER/ADMIN only.
  // STAFF_READ_ONLY (no MANAGE_MAILBOXES) sees the dashboard but not the action.
  const user = await requireAdminAccess();
  const canManageMailboxes = hasPermission(user.role, "MANAGE_MAILBOXES");
  const status = parseStatus(searchParams?.oauth);
  const reason = parseReason(searchParams?.reason);

  return (
    <>
      <h2 className="admin-page__heading">Dashboard</h2>

      {status === "success" ? (
        <div
          className="admin-banner admin-banner--success"
          role="status"
          aria-live="polite"
        >
          Mailbox đã connect thành công.{" "}
          <Link href="/admin/mailboxes">
            Mở danh sách mailbox để hoàn tất thiết lập (gắn customer + Telegram
            mapping) trước khi coi là Ready →
          </Link>
        </div>
      ) : null}

      {status === "error" ? (
        <div className="admin-banner admin-banner--error" role="alert">
          <strong>Connect mailbox thất bại.</strong>{" "}
          {reason
            ? OAUTH_REASON_MESSAGES[reason]
            : "Lỗi không xác định. Hãy thử lại."}
        </div>
      ) : null}

      {canManageMailboxes ? <ConnectMailboxButton /> : null}

      <section className="admin-card-grid" aria-label="System overview">
        {PLACEHOLDER_CARDS.map((card) => (
          <article key={card.label} className="admin-card">
            <p className="admin-card__label">{card.label}</p>
            <p className="admin-card__value">{card.value}</p>
          </article>
        ))}
      </section>
      <section className="admin-next-steps" aria-label="Next setup steps">
        <h3 className="admin-next-steps__title">Next setup steps</h3>
        <ol className="admin-next-steps__list">
          {NEXT_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
      </section>
    </>
  );
}
