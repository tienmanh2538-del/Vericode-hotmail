// TASK-057 — minimal, safe audit trail for admin auth events.
//
// Wraps the existing audit infrastructure (createAuditLogInDb) for the three
// auth events the security spec asks for: login success, login denied, and
// logout. The pre-provisioned ADMIN_LOGIN / ADMIN_LOGOUT actions are reused.
//
// SECURITY:
//   - Best-effort: every helper swallows its own errors so an audit-write
//     failure can NEVER break (or even slow) the auth response.
//   - Safe metadata only. No passphrase, token, session secret, cookie value,
//     or env value is ever passed in — just the outcome and the runtime env
//     label. Metadata is additionally scrubbed by normalizeAuditLogInput.

import type { AppEnv } from '../env';
import { createAuditLogInDb } from '@/services/logs/prisma-audit-log-store';
import { STAGING_ADMIN_USER } from './staging-session';

export type AdminLoginOutcome = 'success' | 'denied';

interface AuthAuditContext {
  /** Runtime environment label (e.g. 'staging'). Never a secret. */
  appEnv: AppEnv;
}

/**
 * Record an admin login attempt. `outcome: 'success'` attributes the event to
 * the staging admin identity; `outcome: 'denied'` records the rejection with no
 * actor (the submitted passphrase is never available here and never logged).
 */
export async function recordAdminLoginAudit(
  outcome: AdminLoginOutcome,
  context: AuthAuditContext,
): Promise<void> {
  try {
    await createAuditLogInDb({
      action: 'ADMIN_LOGIN',
      entityType: 'user',
      severity: outcome === 'success' ? 'info' : 'warning',
      actorUserId: outcome === 'success' ? STAGING_ADMIN_USER.id : null,
      actorEmail: outcome === 'success' ? STAGING_ADMIN_USER.email : null,
      summary:
        outcome === 'success'
          ? 'Admin login succeeded'
          : 'Admin login denied',
      metadata: { outcome, appEnv: context.appEnv },
    });
  } catch {
    // Best-effort only — never surface an audit failure to the auth flow.
  }
}

/** Record an admin logout. Best-effort; never throws. */
export async function recordAdminLogoutAudit(
  context: AuthAuditContext,
): Promise<void> {
  try {
    await createAuditLogInDb({
      action: 'ADMIN_LOGOUT',
      entityType: 'user',
      severity: 'info',
      actorUserId: STAGING_ADMIN_USER.id,
      actorEmail: STAGING_ADMIN_USER.email,
      summary: 'Admin logout',
      metadata: { appEnv: context.appEnv },
    });
  } catch {
    // Best-effort only.
  }
}
