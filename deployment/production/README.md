# deployment/production

Production deployment artifacts for the **Verification Code Relay Tool**
(limited internal beta — TASK-059).

This is an **internal staff app**. Customers never log in; they only receive
verification codes in their mapped Telegram group/topic. Production is a
**limited internal beta**: a very small number of staff (1–2) and a very small
number of real mailboxes (5–10). It is **not** a full rollout.

## Files in this folder

| File | Purpose |
|------|---------|
| `README.md` | This file — quick reference for the production folder. |
| `env.production.example` | Placeholder-only template of the production environment variables. |

## Security warning (read first)

- **Never** store real secrets, tokens, client secrets, bot tokens, encryption
  keys, or production connection strings in this folder or anywhere in git.
- `env.production.example` is committed and contains **placeholders only**.
- Real values live **only** in the deploy platform's secret manager
  (Railway / Render / etc.), never in the repo, never pasted into AI chat,
  logs, docs, commit messages, or PRs.
- Do not read or print the contents of any real `.env*` file.
- Generate a **fresh** `ENCRYPTION_KEY` for production — never reuse the
  local/dev/staging key:
  ```bash
  node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
  ```

## Known blocker — production admin sign-in is fail-closed

TASK-057 hardened production auth to **fail closed**: in production
(`APP_ENV=production`), `lib/auth/session.ts` always returns no user, and
`app/login/page.tsx` shows a generic "access locked" message. There is **no
real production sign-in provider yet**.

Consequences for this beta:

- Staff **cannot** log into the production admin until a real production
  sign-in provider is added (a separate task).
- The staging passphrase login (`STAGING_ADMIN_PASSWORD`) and the dev demo user
  (`AUTH_DEV_DEMO_USER`) **must not** be used to open production. They are
  ignored when `APP_ENV=production` by design — do not try to re-enable them.

Until the provider lands, treat the production environment as **deploy- and
infra-verifiable only**; the staff-facing beta cannot be exercised through the
admin UI. See the TASK-059 report for the full blocker writeup.

## Production deployment topology (minimal)

Same shape as staging (TASK-048 chose **Railway**, with **Render** as an
equivalent fallback), but every resource is a **separate production resource**:

```text
Production project (separate from staging/local):
  1) web            Next.js — build `npm run build`, start `npm run start`
                    -> public HTTPS domain
                    -> serves /admin, OAuth callback, Graph webhook
  2) postgres       Managed PostgreSQL — PRODUCTION ONLY (never staging/local)
  3) redis          Managed Redis — PRODUCTION ONLY (never staging/local)
  4) worker-email   start: `npm run worker:email`   (BullMQ consumer)
  5) worker-delta   start: `npm run worker:delta`   (delta polling backup)
  6) worker-renewal start: `npm run worker:renewal` (subscription renewal)
```

Every start command above is an **existing** npm script (`package.json`); this
checklist does not invent commands.

### Database migration (production)

Apply only already-committed migrations with the deploy command — **never**
`prisma migrate dev` on production:

```bash
npx prisma migrate deploy   # apply committed migrations
npx prisma migrate status   # verify state after deploy
```

## Emergency worker kill switch

If a routing/mapping problem is suspected (e.g. a code could go to the wrong
destination), **stop the worker services immediately** before investigating:

- Stop `worker-email`, `worker-delta`, and `worker-renewal` in the deploy
  platform (each runs independently and can be stopped on its own).
- The web app can stay up so `/admin/health` remains viewable.
- Disconnecting a mailbox also stops it from being polled, renewed, or relayed
  (TASK-052 disconnect guard); a mailbox without a valid active mapping is never
  treated as Ready and never relays (TASK-055/TASK-056).

Detailed backup / restore / incident-response procedures live in the **TASK-060
runbook**: `docs/tasks/TASK-060-backup-restore-incident-response.md` (backup
strategy, isolated restore drill, per-incident response, emergency worker
shutdown). Verification notes:
`docs/reports/TASK-060-backup-restore-incident-response.md`.

## Beta guardrails (must hold)

- Only 1–2 internal staff in the beta. No public signup, no customer portal, no
  customer login, no billing/payment.
- Very small number of real mailboxes (5–10 max for the beta).
- Each mailbox must have a customer, a valid **reusable** Telegram destination,
  and **Ready** status before relay is enabled.
- Many mailboxes may share one reusable destination, but each mailbox has **at
  most one active destination**. Never one-mailbox-to-many; never broadcast.
- Verify each mapping with a **test-send** to the correct group/topic before
  enabling real relay.
- Check `/admin/health` **before and after** enabling workers.
- Production resources are separate from staging/local. **Never** run a local
  worker pointed at production database/Redis.

## Full reference

- `docs/tasks/TASK-060-backup-restore-incident-response.md` — backup, restore
  drill, and incident-response runbook for this beta.
- `docs/reports/TASK-059-production-deployment-limited-internal-beta.md` — this
  beta's verification results, blocker, and smoke-test checklist.
- `docs/reports/TASK-058-production-environment-secret-setup.md` — standardized
  production environment variable groups.
- `docs/STAGING_DEPLOYMENT.md` — full deployment guide (architecture, services,
  worker/queue, smoke tests, rollback); the production shape mirrors it with
  separate production resources.
- `docs/SECURITY_RULES.md` — foundation security rules.
