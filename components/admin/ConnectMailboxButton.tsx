"use client";

import { useState } from "react";

interface ConnectUrlResponse {
  ok: boolean;
  url?: string;
  error?: string;
}

export function ConnectMailboxButton() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleClick(): Promise<void> {
    if (loading) return;
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/mailboxes/connect-url", {
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
        setError("Không khởi tạo được Microsoft OAuth. Thử lại sau.");
        setLoading(false);
        return;
      }

      window.location.assign(payload.url);
    } catch {
      setError("Không kết nối được tới máy chủ. Thử lại sau.");
      setLoading(false);
    }
  }

  return (
    <div className="admin-connect">
      <button
        type="button"
        className="admin-connect__button"
        onClick={handleClick}
        disabled={loading}
        aria-busy={loading}
      >
        {loading ? "Đang chuyển hướng…" : "Connect Hotmail"}
      </button>
      {error ? (
        <p className="admin-connect__error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
