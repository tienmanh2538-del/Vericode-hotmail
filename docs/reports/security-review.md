# Security Review — TASK-036 (Security Hardening Review)

- **Sprint:** 9 — Security & staging readiness
- **Scope:** Verification Code Relay Tool — sensitive flows (Microsoft OAuth /
  Graph, token storage & rotation, delta polling, webhook, Telegram relay,
  logging).
- **Reviewer:** Claude Code (coder). Independent review pending (Gemini).
- **Date:** 2026-05-30
- **Branch:** TASK-036 feature branch
> This review covers TASK-036 only. It does **not** perform TASK-037/038
> (E2E), TASK-039 (staging) or TASK-040 (acceptance). No Microsoft scope was
> added or changed. No `.env` / `.env.local` content was read, printed, or
> modified. No database schema change was required.

---

## 1. Overall verdict

**PASS** — with the two roadmap-flagged hardening items now fixed.

No Critical or High issue remains open in the reviewed flows. The two issues
that were rated High (refresh-token rotation loss) and Medium (unbounded
bootstrap scan) are fixed in this task with tests. Remaining items are Low and
recorded for later tasks (mostly staging/infra concerns outside MVP code).

| Severity | Open | Fixed in TASK-036 | Deferred |
|----------|------|-------------------|----------|
| Critical | 0    | 0                 | 0        |
| High     | 0    | 1 (H-1)           | 0        |
| Medium   | 0    | 1 (M-1)           | 0        |
| Low      | 0    | 0                 | 3 (L-1..L-3) |

---

## 2. Risk checklist

| # | Area | Status | Evidence |
|---|------|--------|----------|
| 1 | Secret / env safety | PASS | `lib/env.ts` returns a result (no throw) and never logs values; required secrets validated per-module via `require*Env`. `.env*` gitignored; only `.env.example` committed (placeholders). |
| 2 | Microsoft OAuth token handling | PASS | Access tokens are short-lived, passed only in the `Authorization` header (never in URLs/logs). OAuth callback (`app/api/microsoft/oauth/callback/route.ts`) returns a redirect — never returns tokens to the client. |
| 3 | Refresh token encryption | PASS | `lib/security/encryption.ts` — AES-256-GCM, 32-byte key validated, random 12-byte IV per encryption, auth tag verified on decrypt. Refresh tokens stored only as ciphertext (`mailbox.encryptedRefreshToken`). |
| 4 | **Refresh token rotation** | **FIXED (H-1)** | New: `services/microsoft/refresh-token-rotation.service.ts`. Both access-token ports now persist a rotated refresh token (encrypted) and keep the old one when Microsoft returns none. See §3. |
| 5 | Telegram bot token safety | PASS | Bot token lives only in env (`TELEGRAM_BOT_TOKEN`); not stored in DB (only chat IDs). Logger masks `telegrambottoken`. |
| 6 | Telegram chat mapping isolation | PASS | `@@unique([mailboxId, telegramChatId])`; delivery is keyed per mapping. Delta polling/webhook never send Telegram directly — they only enqueue `graphMessageId`. |
| 7 | Verification code masking / hashing | PASS | `maskVerificationCode()` → `sha256:<12-hex>` (one-way). Logger redacts `code` / `verificationcode` keys. |
| 8 | Logging / error sanitization | PASS | `lib/logger.ts` masks sensitive keys + truncates body keys; `redactSensitiveText` scrubs `key=value` secrets and long opaque tokens in free text. New tests in `tests/unit/security/`. |
| 9 | Webhook clientState validation | PASS | `services/microsoft/webhook-notification.service.ts` rejects `missing_clientState` / `invalid_clientState` via `verifyGraphClientState` against a stored hash; comment confirms the notification body (which may contain clientState) is not logged. |
| 10 | **Delta polling bootstrap safety** | **FIXED (M-1)** | `services/microsoft/delta-polling.service.ts` — first-run scan is now time-bounded with `$filter=receivedDateTime ge {ts}` (Graph-supported, ≤5,000 messages) plus the existing hard page cap. See §4. |
| 11 | Dedup between webhook and polling | PASS (unchanged) | `@@unique([mailboxId, graphMessageId])` on `ProcessedMessage`. TASK-036 did not change dedup behavior; delta polling still enqueues only IDs and relies on pipeline-level dedup. |
| 12 | Database sensitive fields | PASS | Only `encryptedRefreshToken` (ciphertext) is persisted; no plaintext token/secret columns. No schema change needed (`tokenLastRefreshedAt` already exists). |
| 13 | UI does not expose token/secret/full code | PASS | No `app/**` page renders tokens. The two API routes touching tokens use them server-side only (`callback` → redirect; `inbox-test` → returns message id/subject/from, not tokens). |
| 14 | Test data uses no real data | PASS | All new tests use synthetic tokens/ids (`token-A`, `rotated-refresh`, `cipher`, fake base64 "encryption"). No real secret/token/code present. |

---

## 3. H-1 — Refresh token rotation loss (FIXED)

**Problem.** Microsoft's token endpoint may return a **new** `refresh_token`
on a refresh-grant exchange (rolling refresh tokens). The two callers that
exchange the refresh token —
`createPrismaAccessTokenPort` (delta polling) and
`createPrismaRenewalAccessTokenPort` (subscription renewal) — consumed only the
access token and **discarded** `exchanged.refreshToken`. After Microsoft
rotated the token, the stored (now-stale) token would fail with `invalid_grant`
on the next cycle and the mailbox would silently require a manual reconnect.

**Fix.**
- New shared helper `services/microsoft/refresh-token-rotation.service.ts:persistRotatedRefreshToken()`:
  - When Microsoft returns a new refresh token → **encrypt** it
    (`encryptSecret`) and update `mailbox.encryptedRefreshToken` +
    `tokenLastRefreshedAt`.
  - When Microsoft returns **no** new token → **no-op**; the existing ciphertext
    is kept (never overwritten with null/empty).
  - Failure to encrypt/persist is non-fatal (the access token this cycle is
    still valid) and is logged with **mailbox id only** — never the token or the
    underlying error message.
- Wired into both runners (the only refresh call sites):
  `services/queue/workers/delta-polling-runner.ts`,
  `services/queue/workers/subscription-renewal-runner.ts`.

**Guarantees enforced by tests.**
- New refresh token ⇒ DB updated with the encrypted value, not plaintext.
- No new refresh token ⇒ no DB write; old token retained.
- Encrypt failure / DB failure ⇒ non-fatal, no token leak in logs.

---

## 4. M-1 — Unbounded bootstrap scan on a large mailbox (FIXED)

**Problem.** On a mailbox with no saved cursor, the delta query walked from the
beginning of the folder to reach the first `@odata.deltaLink`. On a very large
mailbox this never converged within the page cap, so no cursor was saved and
**every cycle re-scanned from scratch** — wasted Graph quota and a permanently
ineffective backup poller.

**Fix.** `services/microsoft/delta-polling.service.ts`:
- The first (bootstrap) request is now time-bounded:
  `$filter=receivedDateTime ge (now - bootstrapLookbackHours)`. Microsoft Graph
  supports `receivedDateTime ge/gt` on the messages delta query and caps such a
  filtered query at 5,000 messages — so bootstrap converges quickly. The filter
  is encoded into the returned delta/next links, so forward incremental polling
  is unaffected (all new mail has `receivedDateTime` ≥ the lookback start).
- The existing hard page cap (`maxPagesPerMailbox`) remains as a backstop, so
  the scan is bounded even if a deltaLink is never returned.
- New env var `DELTA_POLLING_BOOTSTRAP_LOOKBACK_HOURS` (default **24h**, min 1h).
  Safe default — local dev / CI work with no env set.

Unchanged safety properties (still verified by tests): bootstrap never enqueues
historical messages; dedup behavior is untouched; delta polling never sends
Telegram, never logs bodies or codes, never persists plaintext tokens.

---

## 5. Deferred items (Low — not in TASK-036 scope)

| ID | Severity | Item | Why deferred |
|----|----------|------|--------------|
| L-1 | Low | Production CSP / security headers (HSTS, X-Content-Type-Options, frame-ancestors) | Infra/staging concern → TASK-039. |
| L-2 | Low | Secret-pattern grep step in CI as defense-in-depth (SECURITY_RULES §8) | CI/staging hardening → TASK-039. |
| L-3 | Low | Persisted-rotation failure could benefit from an operational alert (currently masked warn only) | Optional follow-up; relies on the alert service (TASK-035). |

None of these block the MVP security posture.

---

## 6. Commands run

```powershell
npm run verify   # lint + typecheck + test + build
```

Result: **PASS**

- ESLint: PASS (no errors).
- `tsc --noEmit`: PASS.
- Vitest: **626 passed** (49 files), including the new TASK-036 tests.
- `next build`: PASS (compiled + 14 pages generated).

Targeted suites:

```powershell
npm test -- --run tests/unit/microsoft
npm test -- --run tests/unit/security
npm test -- --run tests/unit/queue
```

---

## 7. Tests added / updated in TASK-036

- `tests/unit/microsoft/refresh-token-rotation.service.test.ts` (new) — rotation
  persistence, keep-old-on-no-rotation, encrypt-before-write, non-fatal failure,
  no token leak.
- `tests/unit/queue/delta-polling-runner.test.ts` (new) — access-token port
  persists rotated token / keeps old token / missing-token error.
- `tests/unit/queue/subscription-renewal-runner.test.ts` (updated) — added
  rotation persistence assertions.
- `tests/unit/microsoft/delta-polling.service.test.ts` (updated) — bootstrap
  time-filter, custom lookback, hard page-cap bound.
- `tests/unit/security/redact.test.ts` (new) — mask/hash/redact utilities.
- `tests/unit/security/logger-sanitize.test.ts` (new) — logger masks sensitive
  keys and never leaks secrets through the sink.

---

## 8. Secret / token / plaintext scan

No real secret, token, client secret, encryption key, verification code, or
full email body was found in source, tests, or this report. All test data is
synthetic. No `.env` / `.env.local` was read or modified. No new Microsoft
scope was requested.
