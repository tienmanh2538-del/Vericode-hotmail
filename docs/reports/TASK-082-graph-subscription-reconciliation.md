# TASK-082 — Report: Graph Subscription Reconciliation

> **Sanitized.** Không chứa secret/token/connection URL/plaintext clientState/
> full verification code/full email body. Reviewer độc lập: **Antigravity CLI**.
> **Không commit / không push / không production reconciliation.** ROADMAP chưa
> đổi (chỉ sau khi Antigravity review PASS).

## 1. Root problem

Mailbox Microsoft `ACTIVE` connect TRƯỚC TASK-081 chưa bao giờ có Graph
subscription: không có đường webhook, chỉ sống nhờ delta polling backup 30s.
TASK-081 chỉ đóng gap cho mailbox đi qua OAuth flow mới. TASK-082 bổ sung
capability cho operator reconcile nhóm mailbox hiện hữu này.

## 2. Locked architecture (human-approved)

- **Operator-invoked, one-shot.** Không periodic, không renewal-tick pass,
  không worker/scheduler mới, không startup/deploy scan, không auto backfill.
  Proposal cũ (reconciliation sau renewal tick + env flag gating) đã bị xóa
  khỏi task file và thay bằng scope khóa.
- **Không env flag.** Không sửa `.env*`/env schema/env docs. Semantics: không
  invoke → không chạy; invoke mặc định → dry-run; chỉ explicit apply → mutate.
- **Bounded + sequential.** Default limit 5, hard maximum 20 là hằng
  code-level (`MAX_RECONCILIATION_LIMIT`), không env-tunable; vượt max → clamp
  deterministic; xử lý tuần tự, concurrency 1, không có option concurrency;
  không retry loop ở bất kỳ lớp nào.

## 3. Operator invocation model

`npm run reconcile:subscriptions` → `tsx scripts/run-subscription-reconciliation.ts`
(runner `tsx` đã có sẵn, không dependency mới):

- không args → **dry-run**, limit 5;
- `--limit <n>` → bounded, clamp về 20 nếu vượt; giá trị không hợp lệ → reject
  exit 1;
- `--apply` → mutating run;
- unknown arg (kể cả mọi dạng concurrency option) → reject.

Không wire vào deploy/startup/worker; không public API/admin UI.

## 4. Dry-run / apply semantics

- **Dry-run (default):** chỉ đọc candidate qua một query local
  (`listReconciliationCandidates`); KHÔNG token refresh, KHÔNG Graph call,
  KHÔNG DB write, KHÔNG persistent audit. Trả counters + internal mailbox ID.
- **Apply:** per-candidate tuần tự:
  local pre-check (status + blocking row) → token refresh qua renewal port →
  **re-check ACTIVE** → ensure (TASK-081 seam, tự re-check blocking row ngay
  trước POST) → nếu created: **post-provision re-check ACTIVE** → nếu mailbox
  rời ACTIVE: mark row `EXPIRED` (fail-safe local trước) + đúng một best-effort
  remote DELETE. Config-level token failure → abort toàn run, không blame
  mailbox. Transient → skip mailbox đó, batch tiếp tục.

## 5. Candidate semantics

`provider MICROSOFT` + `status ACTIVE` + `encryptedRefreshToken` khác null +
không có row `GraphSubscription` potentially-live. Potentially-live reuse đúng
`BLOCKING_SUBSCRIPTION_STATUSES` của TASK-081 (`ACTIVE`/`RENEWING`/`FAILED` với
`expirationDateTime` còn tương lai) — hằng này được export từ chính module
TASK-081 (thay đổi duy nhất ở file đó, không đổi behavior) nên không tồn tại
định nghĩa thứ hai. `DISABLED`/`RECONNECT_REQUIRED`/`SUBSCRIPTION_EXPIRED` và
mọi status non-ACTIVE bị loại ngay trong query. Thứ tự deterministic
(`createdAt asc`), `take limit`.

## 6. Reused seams (chính xác)

- **Ensure/provisioning:** `ensureInboxSubscriptionForConnectedMailbox`
  (`services/microsoft/mailbox-subscription-provisioning.service.ts`) qua
  `createReconciliationEnsurePort` — giữ nguyên blocking-row re-check, timeout
  20 giây với cancellation thật, fail-open, và compensating DELETE khi
  remote-create-success/local-persist-failure (TASK-081, không duplicate).
- **Token:** `createPrismaRenewalAccessTokenPort`
  (`services/queue/workers/subscription-renewal-runner.ts`) — decrypt →
  `refreshMicrosoftAccessToken` → `persistRotatedRefreshToken` (rotated
  credential encrypt trước khi ghi DB) → access token chỉ in-memory. Không
  viết token path mới, không persist access token. Sau review-fix (mục 15):
  port nhận optional `timeoutMs` và reconciliation truyền finite timeout
  (reuse hằng 20 giây của TASK-081) — token request có cancellation thật qua
  `fetchWithTimeout`; renewal caller không truyền nên behavior renewal giữ
  nguyên.
- **Classification:** TASK-069C đã nhúng trong port trên
  (`classifyRefreshTokenError` → `SubscriptionRenewalTokenError.kind`);
  service chỉ đọc `kind` duck-typed, default transient — không sửa TASK-069C.
- **Remote cleanup:** `deleteGraphSubscription` (idempotent với 404, tự mark
  row EXPIRED) qua `createReconciliationRemoteCleanupPort`, bọc fetch bằng
  `fetchWithTimeout` cùng hằng 20 giây của TASK-081.

## 7. Disconnect-race protection

- Re-check mailbox `ACTIVE` sau token refresh và post-provision (mục 4).
- Mailbox rời ACTIVE trước provisioning → Graph create không bao giờ được gọi.
- Blocking row xuất hiện sau selection → ensure seam trả `skipped_existing`,
  không blind-create.
- Post-create disconnect → local row bị mark `EXPIRED` TRƯỚC (webhook chỉ nhận
  `ACTIVE`/`RENEWING`, renewal chỉ list `ACTIVE`/`RENEWING`/`FAILED` → row
  inert ở mọi lớp), rồi đúng một remote DELETE best-effort; DELETE fail → log
  sanitized, dừng, vẫn fail-safe.
- Reconnect-marking là **conditional** (`updateMany` với điều kiện status còn
  `ACTIVE`) → không bao giờ overwrite `DISABLED` thành `RECONNECT_REQUIRED`.
  (`persistRotatedRefreshToken` chỉ ghi credential + timestamp, không đụng
  status, nên rotation trong lúc disconnect không resurrect state.)

## 8. Compensation behavior

Remote create success + local persist failure: xử lý bên trong
`createInboxSubscription` (TASK-081) — một compensating DELETE, không retry,
không fake local row — reconciliation reuse nguyên trạng qua ensure seam
(regression tests giữ nguyên PASS).

## 9. Batch semantics

Một invocation = một pass bounded; per-mailbox lỗi transient/unexpected được
isolate (counters `failed_transient`/`failed`), batch tiếp tục; chỉ config
failure abort run; mỗi mailbox đúng một token attempt và tối đa một ensure
attempt (bên trong ensure là đúng một create attempt của TASK-081).

## 10. Tests

Mới: 3 file, 43 tests (40 của lượt implementation + 3 của review-fix mục 15).

- `tests/unit/microsoft/subscription-reconciliation.service.test.ts` (26):
  limit resolve/clamp/reject; kind reader; dry-run default + non-mutating
  (không token/Graph/DB-write); apply mới mutate; limit enforce; sequential
  max-in-flight 1; no-op khi blocking row (pre-check, ensure-level, và real
  ensure seam với fake prisma — create spy 0 call); token semantics
  (reconnect_required mark conditional, mark-decline khi concurrent
  disconnect, transient không flip + đúng 1 attempt, config abort không blame);
  TOCTOU (rời ACTIVE trước provisioning → 0 Graph call; rời ACTIVE sau create
  → row EXPIRED + đúng 1 cleanup; cleanup fail → vẫn fail-safe); batch
  isolation; sanitized results/logs.
- `tests/unit/queue/subscription-reconciliation-runner.test.ts` (16): candidate
  query đúng locked filter + reuse `BLOCKING_SUBSCRIPTION_STATUSES`;
  conditional reconnect mark ở tầng Prisma; mark EXPIRED; ensure port delegate
  TASK-081; cleanup port reuse `deleteGraphSubscription` + finite-timeout
  fetch; default deps reuse `createPrismaRenewalAccessTokenPort`; integration
  qua port thật (mint token → ensure nhận đúng token; rotated credential
  persist encrypted; invalid_grant → reconnect semantics); CLI contract
  (default dry-run, `--apply`, clamp, reject invalid/unknown/concurrency);
  token timeout forwarding (review-fix, mục 15).
- `tests/unit/queue/subscription-reconciliation-token-timeout.test.ts` (1):
  hanging token endpoint end-to-end — chi tiết ở mục 15.

Regression đã chạy lại nguyên trạng, PASS 92/92: TASK-081 provisioning +
compensation + OAuth callback route; TASK-052 disconnect; TASK-069C
classification; renewal service + runner.

## 11. Verification

`npm run verify` (sau review-fix mục 15): **PASS** (exit 0) — db:generate +
lint + typecheck sạch; test **101 files / 1185 tests passed** (baseline
TASK-081: 98 files / 1142 → +3 files, +43 tests); build
`Compiled successfully`.

## 12. Security confirmation

- Không đọc/in/sửa `.env*`; không env flag mới.
- Không log/persist access token, refresh credential (plaintext hay
  ciphertext), client secret, plaintext clientState, full code, full email
  body; summary chỉ counters + internal mailbox ID; test secret-hygiene khẳng
  định token value không xuất hiện trong result/logs.
- Rotated refresh credential tiếp tục encrypted-at-rest qua helper hiện hành.
- clientState hashing semantics giữ nguyên (không sửa webhook validation).

## 13. Files changed

Runtime (5):
- `services/microsoft/subscription-reconciliation.service.ts` (mới)
- `services/queue/workers/subscription-reconciliation-runner.ts` (mới; sau
  review-fix truyền finite token timeout vào default deps)
- `scripts/run-subscription-reconciliation.ts` (mới)
- `services/microsoft/mailbox-subscription-provisioning.service.ts` (chỉ thêm
  export cho hằng blocking statuses — không đổi behavior)
- `services/queue/workers/subscription-renewal-runner.ts` (review-fix mục 15:
  port nhận optional `timeoutMs`, forward vào `refreshMicrosoftAccessToken`;
  không truyền → behavior cũ giữ nguyên)

Config (1): `package.json` (thêm một npm script alias operator-invoked).

Tests (3): ba file test mới nêu trên.

Docs (2): task file (rewrite sang locked scope) + report này.

Không schema/migration, không sửa `.env*`, không GitHub Actions/CI, không
worker/scheduler mới, không distributed lock.

## 14. Deferred Risks / Findings

1. **TOCTOU TASK-081 vs TASK-082:** OAuth connect-time ensure và reconciliation
   apply có thể cùng thấy "no blocking row" trong cửa sổ hẹp → hai remote
   subscription. V1 không có distributed lock/schema constraint (đúng scope
   khóa); hệ quả bounded bởi exactly-once dedup (không double-relay) và
   disconnect cleanup. Redis mailbox lock (TASK-068A) là đường nâng cấp nếu
   sau này cần. Single-replica là assumption, không phải guarantee.
2. **`SUBSCRIPTION_EXPIRED` lifecycle:** mailbox ở status này không được delta
   poll và không có webhook (điểm mù relay) — là reliability issue riêng,
   KHÔNG fix trong TASK-082 và không nằm trong candidates. Follow-up candidate,
   chưa tạo/chốt task số.
3. **Live production reconciliation chưa thực hiện:** task chỉ mock/test local
   theo ràng buộc. Chạy thật là ops action riêng (dry-run trước, xem counters,
   rồi mới apply), ngoài scope implementation.
4. **Observation (ngoài scope, không sửa):** helper mark reconnect-required
   của renewal worker hiện update không điều kiện theo status; về lý thuyết một
   disconnect đồng thời trong renewal path có thể bị overwrite. Reconciliation
   không dùng helper đó (dùng conditional update riêng); ghi nhận cho follow-up
   review của renewal path.

## 15. Review-fix — Antigravity finding High (token-refresh finite timeout)

Antigravity CLI review lần 1 kết luận FAIL với đúng một finding High: default
deps của reconciliation reuse `createPrismaRenewalAccessTokenPort()`, nhưng
port này gọi `refreshMicrosoftAccessToken(...)` không truyền `timeoutMs` →
`fetchWithTimeout` pass-through → Microsoft token endpoint treo có thể làm
operator one-shot `--apply` pending vô hạn, vi phạm bounded-execution.

Root cause đã xác nhận đúng ở code-level và sửa tối thiểu:

- `createPrismaRenewalAccessTokenPort(client?, options?)` nhận optional
  `{ timeoutMs }`, forward nguyên vẹn vào `refreshMicrosoftAccessToken`
  (TASK-080 seam: AbortController thật; timeout nổi lên như `network` error →
  TASK-069C classify transient, không bao giờ reconnect). Toàn bộ
  decrypt/refresh/rotation/classification giữ nguyên — không token path mới.
- Reconciliation default deps truyền finite timeout — reuse hằng 20 giây
  `CONNECT_SUBSCRIPTION_HTTP_TIMEOUT_MS` của TASK-081 (cùng ceiling với mọi
  Microsoft HTTP call khác của reconciliation). Không env variable mới.
- Renewal caller không truyền options → `timeoutMs` undefined →
  `fetchWithTimeout` pass-through → behavior renewal hiện hành không đổi
  (regression tests renewal service + runner giữ nguyên PASS).

Tests review-fix (3 test mới):

- `tests/unit/queue/subscription-reconciliation-runner.test.ts` (+2): default
  deps yêu cầu finite `timeoutMs` (đúng hằng 20 giây, finite, dương); port
  forward `timeoutMs` vào refresh call; caller không options → `timeoutMs`
  undefined (pass-through, chứng minh renewal không đổi).
- `tests/unit/queue/subscription-reconciliation-token-timeout.test.ts` (mới,
  1 test end-to-end với fake timers, không chờ 20 giây thật): real port +
  real `refreshMicrosoftAccessToken` + real `fetchWithTimeout`, fetch treo
  signal-aware → AbortController abort thật (signal.aborted xác nhận), run
  settle hữu hạn, mailbox outcome `failed_transient` (không flip reconnect,
  không Graph ensure/create cho mailbox đó, đúng 1 fetch — không retry),
  mailbox độc lập kế tiếp vẫn được xử lý thành `created` và rotated refresh
  credential của nó vẫn persist encrypted.

`npm run verify` sau fix: PASS — 101 files / 1185 tests (mục 11).

Antigravity review lại CHƯA diễn ra sau fix này.
