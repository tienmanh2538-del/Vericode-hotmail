# SECURITY_RULES.md

Foundation security rules for the Verification Tool. These rules apply to every
task in every sprint and must be respected by every AI agent (Claude Code,
Antigravity CLI, Cursor, ChatGPT). The independent reviewer/tester role moved
from Gemini CLI to Antigravity CLI in TASK-076.

## 1. Secrets

- Never hardcode tokens, API keys, passwords, client secrets, or encryption
  keys in source code, comments, commit messages, PR descriptions, or logs.
- Real values only live in `.env` / `.env.local`. Those files are gitignored
  and must never be read or printed by an AI agent except when the human
  operator explicitly authorizes it with a stated reason.
- `.env.example` is the only env file that may be committed. It contains
  placeholders only.
- Required production secrets are validated by `lib/env.ts` (`loadEnv`). The
  validator returns a result instead of throwing so that local dev and CI
  builds never fail just because a secret is unset.

## 2. Verification codes

- Verification codes are user data with very short lifetime. They MUST NOT be
  written to application logs in plaintext.
- Use `maskCode()` from `lib/mask.ts` to log a one-way reference
  (`sha256:<12-hex>`) instead of the raw code.
- Persisted codes (when required for debug or audit) must have an explicit
  expiry. Storage shape is decided in a later task (Sprint 3 / Sprint 4).

## 3. Tokens

- OAuth tokens, refresh tokens, and bot tokens must be encrypted at rest
  using `ENCRYPTION_KEY` (encryption itself is implemented in TASK-020).
- Tokens must never appear in logs. Use `maskSecret()` if a debug fingerprint
  is genuinely required.
- Telegram bot tokens live only in env vars; they must not be stored in the
  database (only chat IDs are persisted).

## 4. Logging

- Use `createLogger()` from `lib/logger.ts`. It auto-masks any object key
  matching `/token|secret|password|code|key|auth/i`.
- `console.log` is forbidden in production code paths. Use the logger.
- Logger context must always be structured (`{ key: value }`) so that the
  sanitizer can scrub keys. Do not interpolate secrets into the message
  string — they will not be masked.

## 5. Customer isolation

- Each customer maps to exactly one Telegram group. Verification messages
  destined for customer A must never be routed to customer B's chat ID,
  even on retry.
- Email source mappings are scoped per customer; cross-customer reads are
  forbidden.

## 6. Error messages

- Error messages surfaced to the UI must not include raw secret values,
  raw verification codes, or full email bodies.
- Internal error logs may include masked context via the logger but never
  plaintext credentials.

## 7. Database

- The MVP does not connect to a production database (see PRODUCT_SPEC §
  "Những việc chưa làm ở MVP"). Local DB only.
- When the DB layer is added (TASK-004 and later), connection strings live
  only in env vars and credentials are never logged.

## 8. CI

- CI must run `npm run verify` (lint + typecheck + test + build). Failing CI
  blocks merge.
- A basic secret-pattern grep runs in CI as a defense in depth, but the
  primary defense is human review plus the masking utilities above.

## 9. AI agent rules

- Claude Code: may edit code; must declare files before editing; must report
  results after editing.
- Antigravity CLI: review/test only; no file edits unless the prompt contains
  `ALLOW_ANTIGRAVITY_EDIT=true`. Must never read or print `.env*`, and must never
  log tokens, refresh tokens, client secrets, Telegram bot tokens, full
  verification codes, or full email bodies. Always concludes PASS or FAIL.
- ChatGPT: planning/explanation only; does not touch local code.
- No agent may read or print `.env` content without explicit, justified
  human approval.

## 10. Incident response

- If you suspect that a secret or verification code has been written to logs,
  the build pipeline, or any persisted store: immediately rotate the affected
  secret, purge the offending log entries, and open a PR fixing the offending
  code path before the next deploy.

## 11. Updating these rules

- This document is the source of truth. Changing it requires a PR and human
  review. Code that contradicts these rules must be fixed in the code, not
  by silently weakening this document.
