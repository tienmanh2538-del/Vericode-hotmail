# deployment/staging

Staging deployment artifacts for the **Verification Code Relay Tool**.

Staging is a pre-production environment used for end-to-end testing before the
TASK-040 MVP acceptance review. It must **not** use real customers, real
customer Telegram groups, real customer mailboxes, or the production database.

## Files in this folder

| File | Purpose |
|------|---------|
| `README.md` | This file — quick reference for the staging folder. |
| `env.staging.example` | Placeholder-only template of the staging environment variables. |

## How to use `env.staging.example`

1. **Do not** copy this file into a committed `.env.staging`. This folder must
   never contain real secrets.
2. Use it as a checklist of which variables the staging environment needs.
3. Set the real values in the deploy platform's **secret manager / environment
   settings** (Vercel, Railway, Render, Fly, etc.), or in an injected `.env`
   that stays gitignored and is never committed.
4. Generate a fresh `ENCRYPTION_KEY` for staging — do not reuse the local/dev key:
   ```bash
   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
   ```

## Security warning

- **Never** store real secrets, tokens, client secrets, bot tokens, or
  production connection strings in this folder.
- `env.staging.example` is committed and contains **placeholders only**.
- Real values belong in a secret manager, never in git.

## Full guide

See **[../../docs/STAGING_DEPLOYMENT.md](../../docs/STAGING_DEPLOYMENT.md)** for
the complete staging deployment guide: architecture, required services,
environment variables, Microsoft / Telegram / database / worker setup, smoke
tests, rollback plan, and the security checklist.
