"use client";

import { useState } from "react";

interface ConnectUrlResponse {
  ok: boolean;
  url?: string;
  error?: string;
}

export type ConnectMailboxButtonVariant = "default" | "compact";

export interface ConnectMailboxButtonProps {
  variant?: ConnectMailboxButtonVariant;
  showIntro?: boolean;
  buttonLabel?: string;
  // TASK-069B — when reconnecting a specific mailbox, pass its id so the OAuth
  // callback can refuse to overwrite a different mailbox if the wrong Microsoft
  // account signs in. Omitted for the fresh "Connect" flow.
  reconnectMailboxId?: string;
}

const DEFAULT_BUTTON_LABEL = "Connect Hotmail / Outlook";
const LOADING_LABEL = "Đang tạo liên kết Microsoft…";
const GENERIC_API_ERROR =
  "Không thể tạo liên kết kết nối Microsoft. Vui lòng kiểm tra cấu hình Microsoft OAuth trong .env.local.";
const NETWORK_ERROR =
  "Không kết nối được tới máy chủ. Vui lòng kiểm tra mạng rồi thử lại.";

export function ConnectMailboxButton({
  variant = "default",
  showIntro = true,
  buttonLabel = DEFAULT_BUTTON_LABEL,
  reconnectMailboxId,
}: ConnectMailboxButtonProps = {}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick(): Promise<void> {
    if (loading) return;
    setLoading(true);
    setError(null);

    try {
      const connectUrl =
        typeof reconnectMailboxId === "string" && reconnectMailboxId.length > 0
          ? `/api/mailboxes/connect-url?mailboxId=${encodeURIComponent(
              reconnectMailboxId,
            )}`
          : "/api/mailboxes/connect-url";
      const response = await fetch(connectUrl, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
      });

      let payload: ConnectUrlResponse | null = null;
      try {
        payload = (await response.json()) as ConnectUrlResponse;
      } catch {
        payload = null;
      }

      if (
        !response.ok ||
        !payload?.ok ||
        typeof payload.url !== "string" ||
        payload.url.length === 0
      ) {
        setError(GENERIC_API_ERROR);
        setLoading(false);
        return;
      }

      window.location.assign(payload.url);
    } catch {
      setError(NETWORK_ERROR);
      setLoading(false);
    }
  }

  const containerClass =
    variant === "compact"
      ? "admin-connect admin-connect--compact"
      : "admin-connect";

  return (
    <div className={containerClass}>
      {showIntro ? (
        <div className="admin-connect__intro">
          <p className="admin-connect__intro-text">
            Kết nối mailbox Hotmail/Outlook để hệ thống đọc email xác minh
            Facebook/Meta qua Microsoft OAuth.
          </p>
          <p className="admin-connect__intro-text admin-connect__intro-text--muted">
            Bạn sẽ được chuyển sang Microsoft để đăng nhập và cấp quyền. Hệ
            thống không lưu mật khẩu Hotmail/Outlook của bạn.
          </p>
        </div>
      ) : null}
      <button
        type="button"
        className="admin-connect__button"
        onClick={handleClick}
        disabled={loading}
        aria-busy={loading}
        aria-label={loading ? LOADING_LABEL : buttonLabel}
      >
        {loading ? LOADING_LABEL : buttonLabel}
      </button>
      {error ? (
        <p className="admin-connect__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
