# MVP Acceptance Review — Verification Code Relay Tool

- **Review date:** 2026-05-31
- **Branch:** `feature/task-040-mvp-acceptance-review`
- **Current commit:** `2c0b77f`
- **Reviewer:** Claude Code
- **Scope:** Review only. No application code, tests, configs, or `.env*` files were modified. Findings are recorded, not fixed.

---

## Executive Summary

**Final result: CONDITIONAL PASS**

The MVP core flow (connect mailbox → detect Facebook/Meta verification email → extract code → dedupe → send to the correct Telegram group → log safely → health/alert for operations) is implemented, dependency-wired, and covered by an automated test suite that passes end-to-end. `npm run verify` (lint + typecheck + test + build) completes successfully with **0 failing tests (56 test files, 670 tests passed)** and a successful production build. The two highest-risk reliability items flagged in the roadmap are resolved in code: (1) the production email worker is now wired to a **real** Prisma/Graph/Telegram pipeline (no longer a type-only stub, per the TASK-031 warning), and (2) the Microsoft refresh-token rotation is **persisted** to the database (per the TASK-036 warning). Security controls (AES-256-GCM token encryption, auto-masking logger, clientState validation, customer isolation, exactly-once dedup) are present and unit-tested.

The result is **CONDITIONAL PASS** rather than full PASS because the MVP acceptance criteria that require **live, human-observed evidence** — a real Microsoft test mailbox round-trip, a real Telegram test-group delivery, and a green GitHub Actions run on this branch — are satisfied **at the code/test/mock level only**. The repository ships these as documented manual checklists and mock-injected E2E tests (no live network), which is appropriate for the MVP scope ("chưa kết nối Hotmail thật", "chưa deploy production") but means the acceptance criteria cannot be marked fully PASS purely from static review. Those live confirmations are the explicit conditions for upgrading to full PASS.

---

## Source Documents Reviewed

| Document | Exists? | Used as |
|---|---|---|
| `docs/PRODUCT_SPEC.md` | Yes | Authoritative MVP scope, security requirements, and the 8 official acceptance criteria |
| `docs/ARCHITECTURE.md` | Yes | System decomposition (admin, API, DB, processor, extractor, Telegram sender, audit) |
| `docs/SECURITY_RULES.md` | Yes | §1–§11 mandatory security checklist (see Security Acceptance) |
| `docs/ROADMAP.md` | Yes | Sprint plan TASK-001..TASK-040; embedded TASK-031/036/038 warnings |
| `docs/MICROSOFT_SETUP.md` | Yes | Microsoft app-registration / OAuth setup reference |
| `docs/STAGING_DEPLOYMENT.md` | Yes | Staging deployment setup (TASK-039) |
| `docs/tasks/TASK-040-mvp-acceptance-review.md` | Yes | This task's spec; §8 report structure and §8.4 acceptance areas |
| `docs/tasks/TASK-040-preflight-operational-readiness.md` | Yes | Preflight operational-readiness task spec |
| `docs/tasks/TASK-001..TASK-039` | Yes | Per-sprint acceptance criteria referenced as evidence |
| `docs/reports/gemini-ecc-review.md` | Yes | Prior ECC/Gemini review (cited as security/quality evidence) |
| `docs/reports/security-review.md` | Yes | TASK-036 security hardening review (cited as security evidence) |
| `docs/reports/TASK-038-microsoft-test-mailbox-manual-checklist.md` | Yes | Manual checklist for the Microsoft test-mailbox E2E |
| `CLAUDE.md`, `AGENTS.md`, `GEMINI.md` | Yes | Agent roles and mandatory workflow |
| `PROJECT_CONTEXT.md`, `PROJECT_STRUCTURE.md` | NOT FOUND at repo root | n/a (content covered by ARCHITECTURE/ROADMAP) |

All listed documents were read in full during this review; the code-level controls they describe were additionally verified directly in source (see Security Acceptance).

---

## Commands Run

| Command | Result | Notes |
|---|---|---|
| `git rev-parse --short HEAD` | `2c0b77f` | Current commit on the review branch |
| `git branch --show-current` | `feature/task-040-mvp-acceptance-review` | Correct review branch |
| `git status --short` | Only the new report file is untracked | No tracked application files were modified by this review. Temporary `_verify_out.txt` / `_verify_clean.txt` capture files created during review were deleted and must not be committed. |
| `npm run verify` | **PASS — exit code 0** | Runs `lint && typecheck && test && build`; the chain reaching exit 0 means every step passed (build only runs if tests pass). |
| └ `eslint .` (lint) | PASS | No lint errors reported |
| └ `tsc --noEmit` (typecheck) | PASS | No type errors |
| └ `vitest run` (test) | PASS | **Test Files 56 passed (56); Tests 670 passed (670); 0 failed.** Includes `tests/e2e/mock-flow.spec.ts` (4) and `tests/e2e/microsoft-test-mailbox.spec.ts` (8). Numerous `[warn]`/`[error]`/`prisma:error` lines in output are deliberate negative-path assertions inside passing tests, not failures. |
| └ `next build` (build) | PASS | `✓ Compiled successfully`, 14 pages generated, all 24 routes built (incl. `/api/webhooks/microsoft/mail`, `/admin/health`) |

**Failing tests:** None. There are no failing tests to assess as bug-vs-stale.

---

## MVP Acceptance Matrix

Columns: # | Area | Expected | Evidence | Status | Notes

| # | Area | Expected | Evidence | Status | Notes |
|---|---|---|---|---|---|
| 1 | Admin dashboard | Basic admin shell / dashboard | `app/` admin surface; staging-login auth (`app/api/auth/staging-login`, `lib/auth/staging-session.ts`); TASK-005/006 | PASS | Auth is a staging/demo admin session for MVP, not full RBAC (by design — PRODUCT_SPEC "chưa phân quyền phức tạp") |
| 2 | Customer management | Create/manage customers | `services/customers/customer.service.ts`, `lib/validation/customer.ts`; `tests/unit/customers/*` | PASS | Service + validation unit-tested |
| 3 | Telegram mapping | Map customer ↔ Telegram group | `services/telegram/telegram-mapping.service.ts`; `app/api/telegram/mappings/*`; `tests/unit/telegram/telegram-mapping.*` | PASS | One active mapping resolved per mailbox |
| 4 | Telegram test-send | Admin test-send to a group | `app/api/telegram/test-send/route.ts`; `services/telegram/telegram-sender.service.ts`; `tests/unit/telegram/telegram-sender.service.test.ts` | PASS | Sender never leaks bot token/full URL (tested) |
| 5 | Facebook/Meta detector | Detect FB/Meta verification email | `services/email/facebook-detector.service.ts`; `tests/unit/email/facebook-detector.service.test.ts` (29 tests) | PASS | |
| 6 | Code extractor | Extract verification code | `services/email/code-extractor.service.ts`; `tests/unit/email/code-extractor.service.test.ts` (30 tests) | PASS | |
| 7 | Deduplication | Reject duplicate messages | `services/email/deduplication.service.ts`; Prisma `@@unique([mailboxId, graphMessageId])`; `tests/unit/email/deduplication.service.test.ts` (26 tests) | PASS | DB unique constraint backs exactly-once |
| 8 | Mock flow | mock email → detect → extract → dedupe → Telegram | `services/email/email-processing.service.ts`; `tests/unit/email/email-processing.service.test.ts` | PASS | Test log shows masked-code send + all skip paths |
| 9 | Code event log | Record processed/sent/failed | `services/logs/code-event-log.service.ts`, `prisma-code-event-store.ts`; `tests/unit/logs/code-event-log.service.test.ts` | PASS | |
| 10 | Audit log | Audit sensitive actions | `services/logs/audit-log.service.ts`, `prisma-audit-log-store.ts`; `tests/unit/logs/audit-log.service.test.ts` (17 tests) | PASS | |
| 11 | Microsoft OAuth connect URL | Build consent URL | `services/microsoft/oauth-connect-url.service.ts`; `app/api/mailboxes/connect-url`; `tests/unit/microsoft/oauth-connect-url.service.test.ts` | PASS | |
| 12 | Microsoft OAuth callback | Exchange code for tokens | `services/microsoft/oauth-token-exchange.service.ts`; `app/api/microsoft/oauth/callback`; `tests/api/microsoft-oauth-callback.route.test.ts` | PASS | Secret hygiene tested (no token/secret in errors) |
| 13 | Token encryption | AES-256-GCM, random IV + auth tag | `lib/security/encryption.ts`; `tests/security/encryption.test.ts` (15 tests) | PASS | `aes-256-gcm`, 12-byte random IV, 16-byte tag, versioned `v1:iv:tag:ct`; strict base64 + 32-byte key validation |
| 14 | Mailbox persistence | Save mailbox after connect | `services/microsoft/mailbox-connect.service.ts`, `mailbox-list/detail.service.ts`; `tests/unit/microsoft/mailbox-*` | PASS | |
| 15 | Graph mail read | Read inbox / get message | `services/microsoft/graph-mail.service.ts`; `app/api/mailboxes/[id]/inbox-test`; `tests/unit/microsoft/graph-mail.service.test.ts` (26 tests) | PASS | HTTP errors mapped to safe kinds; token never logged |
| 16 | Graph subscription | Create/renew/delete subscription | `services/microsoft/graph-subscription.service.ts`; `tests/unit/microsoft/graph-subscription.service.test.ts` (33 tests) | PASS | |
| 17 | Webhook verification | Echo `validationToken` | `app/api/webhooks/microsoft/mail/route.ts` GET handler; `tests/api/microsoft-webhook-verification.route.test.ts` | PASS | Returns text/plain validationToken (tested) |
| 18 | Webhook receiver | Accept notifications, validate clientState, enqueue | `app/api/webhooks/microsoft/mail/route.ts` POST; `services/microsoft/webhook-notification.service.ts`; `tests/api/microsoft-webhook-notification.test.ts` (11 tests) | PASS | clientState mismatch → skip; 202 always; clientState never logged/returned (tested) |
| 19 | Queue/worker | BullMQ queue + worker foundation | `services/queue/email-queue.ts`, `redis-connection.ts`, `workers/email-worker.ts`; `tests/unit/queue/*` | PASS | |
| 20 | Real Graph message processing pipeline | Production worker runs the REAL pipeline (not a stub) | `services/queue/workers/email-worker-runner.ts` (`buildDefaultEmailPipeline` wires Prisma mailbox lookup, decrypt+refresh+rotate token, Graph fetch, Telegram mapping, retrying sender, DB audit); `email-worker.ts` lazily resolves it; `scripts/run-email-worker.ts` builds it at startup; `tests/unit/queue/email-worker-runner.test.ts` (9 tests) | PASS | **TASK-031 warning resolved**: pipeline is real dependency-wired code, not a type-only cast. See Reliability Acceptance. |
| 21 | Delta polling backup | Backup path via Graph delta | `services/microsoft/delta-polling.service.ts`, `services/queue/workers/delta-polling-runner.ts`, `scripts/run-delta-polling-worker.ts`; `tests/unit/microsoft/delta-polling.service.test.ts` | PASS | Bootstrap is time-bounded (24h default) per TASK-036 |
| 22 | Subscription renewal | Renew before expiry | `services/microsoft/subscription-renewal.service.ts`, `workers/subscription-renewal-runner.ts`; `tests/unit/microsoft/subscription-renewal.service.test.ts` (22 tests) | PASS | Handles renew/expire/reconnect/transient-retry |
| 23 | Telegram retry/failure handling | Backoff + non-retryable handling | `services/telegram/telegram-retry.service.ts`; `tests/unit/telegram/telegram-retry.service.test.ts` | PASS | 5s/15s/30s schedule, honours 429 retry_after (capped), no retry on 4xx |
| 24 | Health dashboard | Surface operational status | `services/health/health.service.ts`, `health.types.ts`; `tests/unit/health/health.service.test.ts` (37 tests), `queue-redis.test.ts` | PASS | Service layer + tests present; UI surface assumed wired (build passes) |
| 25 | Alert service | Admin alerts w/ anti-spam | `services/alerts/alert.service.ts`, `alert-message.ts`, `alert-sanitizer.ts`; `tests/unit/alerts/*` | PASS | 5-min cooldown; skips safely when chat id / bot token unset; sanitized payload |
| 26 | Security hardening | SECURITY_RULES enforced | See Security Acceptance section; `docs/reports/security-review.md` (TASK-036) | PASS | Code-level controls verified directly |
| 27 | Mock E2E | mock-flow end-to-end | `tests/e2e/mock-flow.spec.ts` (ran & passed in verify) | PASS | TASK-037 |
| 28 | Microsoft mailbox E2E | Graph→Telegram E2E | `tests/e2e/microsoft-test-mailbox.spec.ts` (mock-injected, no real network — ran & passed); `docs/reports/TASK-038-...-manual-checklist.md` for live run | PARTIAL | Automated path is mock-injected; live test-mailbox round-trip is a documented manual checklist, not auto-verified in this review |
| 29 | Staging deployment setup | Staging config/docs, no prod secrets | `docs/STAGING_DEPLOYMENT.md` (full §5.1–§5.11), `deployment/staging/`; staging auth in code; recent commits "staging deployment setup" | PARTIAL | Docs/config complete and reviewed in full; live staging deploy + smoke-test not exercised in this review |
| 30 | Operational preflight readiness | Worker wiring + ops checks before acceptance | `docs/tasks/TASK-040-preflight-operational-readiness.md`; worker-runner + run-email-worker (preflight deliverables) present and tested | PASS | Preflight's core code deliverable (real worker wiring) verified |

### Mapping to the 8 official PRODUCT_SPEC acceptance criteria

| # | Official criterion | Status | Evidence |
|---|---|---|---|
| 1 | Admin can create a test customer | PASS | Customer service + validation + tests (Area 2) |
| 2 | Admin can configure a test Telegram group | PASS | Telegram mapping module + tests (Area 3) |
| 3 | System processes a sample email | PASS | Mock flow + email-processing tests (Area 8) |
| 4 | System extracts the correct verification code | PASS | Code extractor (30 tests) + pipeline masked-code logs (Area 6) |
| 5 | System sends the correct code to the correct Telegram group | PASS (code/test) | Pipeline resolves per-mailbox mapping then sends; E2E mock asserts delivery. Live group delivery is a manual checklist (Area 28) |
| 6 | Log shows processing status clearly | PASS | Code event log + audit log (Areas 9, 10) |
| 7 | Gemini review has no remaining Critical/High | PARTIAL | `docs/reports/security-review.md` (TASK-036) explicitly concludes **PASS with 0 Critical / 0 High** (independent Gemini review noted as "pending" in that report). TASK-040-preflight records a Gemini verdict of PASS with only Low items. A fresh Gemini review of THIS branch + the new report is still required per TASK-040 §9 |
| 8 | GitHub Actions pass | NOT VERIFIED | No push performed in this review; CI on this branch not yet observed green |

---

## Security Acceptance (SECURITY_RULES.md §1–§11)

| Rule | Verdict | Evidence |
|---|---|---|
| §1 No hardcoded secrets; `.env`/`.env.local` gitignored; `.env.example` placeholders only; `loadEnv` validates | PASS | Secrets resolved from `process.env` only (`lib/env.ts`, `lib/security/encryption.ts`); `loadEnv` checks required variable **names** and returns warnings without throwing or printing values. `.env`, `.env.local` exist locally and were **not** read/printed. `.gitignore` lists `.env`, `.env.local`, `.env.*.local`. `.env.example` contains placeholders/empty values (the committed `ENCRYPTION_KEY` is a documented example/dev value with a generate-your-own note, not a production secret) |
| §2 Verification codes never logged in plaintext; `maskCode` used; persisted codes expire | PASS | `maskVerificationCode()` → `sha256:<12hex>` (`lib/security/redact.ts`); logger masks `code`/`verificationcode` keys; test logs show `maskedCode: '82****'` only, never the full code |
| §3 Tokens encrypted at rest; never logged; bot token only in env | PASS | AES-256-GCM at rest (`encryption.ts`); refresh tokens stored encrypted; `requireTelegramEnv` reads bot token from env (never persisted to DB); logger masks token keys |
| §4 Use `createLogger`; no `console.log` in prod paths; structured context | PASS | `createLogger()` auto-masks keys matching token/secret/password/code/key/auth and truncates body keys (`lib/logger.ts`); services use the logger, not console |
| §5 Customer isolation: one customer ↔ one Telegram group; no cross-customer routing even on retry | PASS | Pipeline resolves the **active mapping for the specific mailbox** before sending (`telegram-mapping.service` `findActiveMappingForMailbox`); no global/broadcast send path; retry reuses the same resolved chat id |
| §6 Error messages exclude raw secrets/codes/full email bodies | PASS | Graph/Telegram/OAuth services tested to exclude tokens; pipeline envelope carries status only; email body never placed in errors |
| §7 Local DB only for MVP; connection strings in env, never logged | PASS | `DATABASE_URL` via env (`requireDatabaseEnv`); not logged |
| §8 CI runs `npm run verify`; secret-pattern grep as defense-in-depth | PARTIAL | `verify` script exists and passes locally; `.github/` workflows present but CI run on this branch NOT observed (no push). Note: security-review L-2 records the CI secret-grep step as a deferred Low item |
| §9 AI agent rules (declare files, no `.env` printing) | PASS | This review declared scope, modified only the report file, and did not read/print `.env*` |
| §10 Incident response | N/A | No secret/code leak detected during review |
| §11 Rules are source of truth | PASS | No security rule was weakened to reach a verdict |
| Webhook validates `clientState` | PASS | `webhook-notification.service.ts` compares against stored hash; mismatch → `invalid_clientState` skip; clientState never logged/returned (tested) |
| No code sent to an unmapped group | PASS | Pipeline returns `SKIPPED_NO_TELEGRAM_MAPPING` when no active mapping (tested) |
| No full email body to Telegram or logs | PASS | Only the extracted (masked-in-logs) code + safe identifiers cross to Telegram; body keys truncated by logger |

---

## Reliability Acceptance

| Item | Verdict | Evidence |
|---|---|---|
| Webhook is the primary path | PASS | `app/api/webhooks/microsoft/mail` POST enqueues `PROCESS_MICROSOFT_GRAPH_MESSAGE` jobs |
| Delta polling is the backup path | PASS | `delta-polling.service.ts` + `delta-polling-runner.ts` enqueue the same job type |
| Dedup exactly-once when webhook + polling see the same `graphMessageId` | PASS | Prisma `@@unique([mailboxId, graphMessageId])` on ProcessedMessage; pipeline returns `SKIPPED_DUPLICATE`; covered by deduplication + pipeline tests (**TASK-038 requirement satisfied at code/test level**) |
| Subscription renewal works | PASS | `subscription-renewal.service.ts` (22 tests): renew/expire/reconnect/transient-retry all handled |
| Telegram retry / backoff | PASS | `telegram-retry.service.ts`: 5s/15s/30s schedule, 429 `retry_after` honoured & capped, no retry on 4xx |
| Alert service | PASS | `alert.service.ts`: delivers sanitized admin alerts, 5-min cooldown, safe no-op when unconfigured |
| Health dashboard surfaces operational state | PASS | `health.service.ts` (+ queue/redis health) with 37+ tests |
| **Production worker is a REAL pipeline, not a type-only stub** | PASS | `email-worker-runner.ts` `buildDefaultEmailPipeline()` constructs the real dependency graph (Prisma lookup → decrypt + `refreshMicrosoftAccessToken` + `persistRotatedRefreshToken` → `getMessageById` → detector/extractor/dedupe → retrying Telegram sender → DB audit). `email-worker.ts` resolves it lazily for production jobs; `scripts/run-email-worker.ts` builds it at startup so wiring failures surface immediately. **TASK-031 warning resolved.** |
| **Refresh-token rotation persisted (TASK-036)** | PASS | `persistRotatedRefreshToken()` encrypts the new refresh token and writes it; when Microsoft returns no new token it keeps the existing one (never overwrites with null); wired into the worker access-token port and shared with delta-polling/renewal workers. **TASK-036 token-loss risk resolved.** |
| Failing-tests bug-vs-stale assessment | N/A | No failing tests — nothing to classify |

---

## Staging / Operational Acceptance

| Item | Verdict | Evidence |
|---|---|---|
| Staging setup docs/config exist | PASS | `docs/STAGING_DEPLOYMENT.md` (full §5.1–§5.11: architecture, env table, Microsoft/Telegram/DB/worker setup, smoke-test, rollback, security checklist), `deployment/staging/`, staging auth (`lib/auth/staging-session.ts`, staging-login/logout routes), staging env keys in `lib/env.ts` |
| No production secrets in repo | PASS | Staging guide mandates secrets live only in the platform secret manager; `.env.example` uses placeholders; recent commits use staging secret **placeholders** ("docs: fix staging secret placeholders"); review did not read/print `.env*` |
| Env / staging checklist | PASS | `STAGING_DEPLOYMENT.md` §5.9 smoke-test and §5.11 security checklist are explicit and complete (HTTPS, redirect-URI match, no real customer group/mailbox, no prod DB, `prisma migrate deploy`) |
| Microsoft test-mailbox evidence | PARTIAL | `docs/reports/TASK-038-...-manual-checklist.md` is a complete checklist (webhook + delta + the dedup/exactly-once duplicate case + security spot-checks) but its "Result" table is **unfilled** — a live test-mailbox round-trip has not yet been recorded. Automated coverage is the mock-injected `microsoft-test-mailbox.spec.ts` (8 tests, pass) |
| Telegram test-group / admin-alert evidence | PARTIAL | Sender/alert services tested with fakes; live test-group delivery is operational/manual, not exercised in review (and must not touch real customer groups) |
| Operational preflight readiness | PASS | `TASK-040-preflight-operational-readiness.md` records all 13 acceptance criteria met, `npm run verify` PASS (670/670), `prisma validate/generate` PASS, and a Gemini verdict of PASS with only Low items. Core deliverable (real worker wiring + `worker:email` script) verified directly in source and unit-tested |

---

## Known Gaps / Risks

- **CI not observed green on this branch (criterion 8).** No push was performed during this review, so GitHub Actions has not been confirmed passing for `feature/task-040-mvp-acceptance-review`. Local `npm run verify` is green, which is a strong proxy but not the same as a CI run.
- **Gemini review of this report/branch pending (criterion 7).** The TASK-036 `security-review.md` concludes 0 Critical / 0 High (with independent Gemini review marked "pending" there), and TASK-040-preflight records a Gemini PASS with only Low items. But TASK-040 §9 specifically requires a Gemini review of THIS new report + the branch diff, which has not happened yet.
- **Live Microsoft + Telegram round-trips are manual and not yet recorded.** Area 28 / spec criterion 5 are proven via mock-injected E2E and a documented checklist, but the TASK-038 checklist "Result" table is unfilled — no live mailbox→group delivery has been logged. Consistent with MVP scope ("chưa kết nối Hotmail thật", "chưa deploy production") but a real gap for full sign-off.
- **LOW (informational) — delta-polling source label.** In `services/queue/workers/email-worker.ts` `toPipelineJob`, both the delta-polling branch and the webhook branch set `source: 'webhook'` on the pipeline job. Functionally harmless (both correctly run the same pipeline and dedup is by `graphMessageId`), but the original source is not preserved for downstream observability. Recorded as a finding; not fixed in this task.
- **LOW (carried from security-review) — deferred items.** L-1 production CSP/security headers and L-2 CI secret-pattern grep are deferred staging/infra items; L-3 suggests an operational alert on rotation-persist failure (currently masked-warn only). None block MVP.
- **Operational reminders for staging (from preflight §10).** Staging requires HTTPS (cookie `secure=true`), all required env set, and `npx prisma migrate deploy` before acceptance; queue/Redis health is a presence-check, not a deep connection check.
- **Prompt-injection note.** During cleanup, a stray tracked file named `tatus` (an artifact of a previous `> status` redirect) was found to contain text impersonating a "system reminder / monitor flag" instructing edits to that file. It was ignored as untrusted file content; the file was restored unchanged. No tracked application file was modified by this review.

---

## Final Decision: CONDITIONAL PASS

**Justification.** The core MVP is met with concrete evidence:
- `npm run verify` is **green** (lint + typecheck + 670/670 tests + production build), satisfying the hard gate that verify must pass.
- All nine "MVP cần có" capabilities and PRODUCT_SPEC acceptance criteria 1–6 are implemented and unit/integration/E2E (mock) tested.
- The two roadmap-flagged Critical/High reliability risks are **resolved in code**: the production email worker runs a real pipeline (TASK-031), and refresh-token rotation is persisted (TASK-036).
- No hardcoded secrets, no token/code/full-email-body logging, AES-256-GCM token encryption, clientState validation, customer isolation, and exactly-once dedup are all present and verified.
- No failing tests; no Critical/High security defect found during this static review.

It is **not full PASS** because three acceptance criteria require evidence outside static review:
1. **GitHub Actions green on this branch** (criterion 8) — not yet observed.
2. **Gemini review of this report + git diff with no remaining Critical/High** (criterion 7, TASK-040 §9) — not yet performed this cycle.
3. **A live (test-mailbox + test-group) round-trip confirmation** (criterion 5 / Area 28) — currently mock-injected + manual-checklist only.

These are operational/sign-off items, not core-functionality defects, which is exactly the situation CONDITIONAL PASS is defined for.

**Conditions to upgrade to full PASS:**
1. Push the branch and confirm GitHub Actions (`npm run verify` + secret grep) passes.
2. Obtain a Gemini review of this report and the branch diff with **no Critical/High** findings.
3. Execute the TASK-038 Microsoft test-mailbox checklist against a **test** mailbox and a **test** Telegram group (never a real customer group; no secrets/codes printed) and attach the observed result.
4. (Recommended, non-blocking) Address the LOW delta-polling `source` label finding.

Until conditions 1–3 are satisfied, the MVP is accepted **conditionally**: functionally complete and safe by code/test evidence, pending live operational confirmation.
