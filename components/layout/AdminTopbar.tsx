import { loadEnv } from "@/lib/env";
import { isStagingAdminConfigured } from "@/lib/auth/staging-session";

export function AdminTopbar() {
  const { values } = loadEnv();
  const showStagingLogout =
    values.APP_ENV === "staging" && isStagingAdminConfigured(values);

  return (
    <header className="admin-topbar">
      <div className="admin-topbar__heading">
        <h1 className="admin-topbar__title">Admin Dashboard</h1>
        <p className="admin-topbar__description">
          Internal tool for verification code relay
        </p>
      </div>
      <div className="admin-topbar__actions">
        <span className="admin-topbar__badge">MVP Setup</span>
        {showStagingLogout ? (
          <form method="post" action="/api/auth/staging-logout">
            <button type="submit" className="admin-topbar__logout">
              Log out
            </button>
          </form>
        ) : null}
      </div>
    </header>
  );
}
