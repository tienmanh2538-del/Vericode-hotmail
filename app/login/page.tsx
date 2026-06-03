import { loadEnv } from "@/lib/env";
import { isStagingAdminConfigured } from "@/lib/auth/staging-session";

export const metadata = {
  title: "Login — Verification Tool",
};

export const dynamic = "force-dynamic";

interface LoginPageProps {
  searchParams?: { error?: string };
}

const ERROR_MESSAGES: Record<string, string> = {
  invalid: "Sai mật khẩu staging. Vui lòng thử lại.",
  unconfigured:
    "Staging admin login chưa được cấu hình (thiếu STAGING_ADMIN_PASSWORD). Admin vẫn bị khóa.",
};

function StagingLoginForm({ error }: { error?: string }) {
  const message = error ? ERROR_MESSAGES[error] : undefined;
  return (
    <form method="post" action="/api/auth/staging-login" style={{ marginTop: "1.5rem" }}>
      {message ? (
        <p role="alert" style={{ color: "#b91c1c", marginBottom: "1rem" }}>
          {message}
        </p>
      ) : null}
      <label htmlFor="staging-password" style={{ display: "block", marginBottom: "0.5rem" }}>
        Mật khẩu staging admin
      </label>
      <input
        id="staging-password"
        name="password"
        type="password"
        autoComplete="current-password"
        required
        style={{
          width: "100%",
          padding: "0.6rem 0.75rem",
          fontSize: "1rem",
          border: "1px solid #cbd5e1",
          borderRadius: "0.375rem",
        }}
      />
      <button
        type="submit"
        style={{
          marginTop: "1rem",
          padding: "0.6rem 1.25rem",
          fontSize: "1rem",
          fontWeight: 600,
          color: "#ffffff",
          background: "#1d4ed8",
          border: "none",
          borderRadius: "0.375rem",
          cursor: "pointer",
        }}
      >
        Đăng nhập
      </button>
    </form>
  );
}

export default function LoginPage({ searchParams }: LoginPageProps) {
  const { values } = loadEnv();
  const isStaging = values.APP_ENV === "staging";
  const isDevelopment = values.APP_ENV === "development";
  const stagingConfigured = isStagingAdminConfigured(values);

  return (
    <main style={{ padding: "3rem", maxWidth: "32rem", margin: "0 auto" }}>
      <h1>Login</h1>

      {isStaging && stagingConfigured ? (
        <>
          <p>Đăng nhập admin cho môi trường staging.</p>
          <StagingLoginForm error={searchParams?.error} />
        </>
      ) : isStaging ? (
        <p role="alert" style={{ color: "#b91c1c" }}>
          {ERROR_MESSAGES.unconfigured}
        </p>
      ) : isDevelopment ? (
        <p>
          Local development. Admin access uses the dev-only demo user when its
          flag is enabled; no real sign-in is required.
        </p>
      ) : (
        // TASK-057 — production (and any non-dev/non-staging runtime) is
        // fail-closed: there is no real sign-in provider yet, so admin access is
        // denied. The message stays generic — it never names env vars, the
        // staging passphrase, or any other mechanism that could aid an attacker.
        <p role="alert" style={{ color: "#b91c1c" }}>
          Admin sign-in is not available. A production authentication provider
          has not been configured, so access is locked.
        </p>
      )}
    </main>
  );
}
