# TASK-092 — Email Worker Microsoft Graph HTTP Timeout & Cancellation Hardening (Phase 1 Report)

> **Phase 1 — INVESTIGATION / ARCHITECTURE ONLY.** Không có implementation, không sửa
> test/code/schema/config/ROADMAP, không commit/push, không thao tác Railway.
> Sanitized: không secret thật, không access/refresh-token, không client secret,
> không connection string, không verification code đầy đủ, không full email body.
> Tài liệu kiến trúc chi tiết: `docs/tasks/TASK-092-email-worker-http-timeout-hardening.md`.

---

## 1. Precheck evidence (đã sanitize)

Chạy đúng bốn lệnh yêu cầu tại đầu phiên:

- `git branch --show-current` → đúng nhánh làm việc của task hiện tại (TASK-092,
  không ghi nguyên tên nhánh theo quy tắc CLAUDE.md về secret-scan false positive).
- `git status --short` → rỗng (working tree sạch).
- `git diff --stat` → rỗng (không diff ngoài dự kiến).
- `git log -1 --oneline` → `b50fc02 docs: document graph quota investigation`
  (kết quả TASK-091 đã hoàn tất tại HEAD).

Tất cả điều kiện precheck ĐẠT. Không đọc/in/sửa file `.env*` nào.

---

## 2. Files / code paths đã đọc

Tài liệu quy trình: `AGENTS.md`, `CLAUDE.md`, `ANTIGRAVITY.md`, các rule
`.claude/rules/ecc/`. Task/report context: TASK-080 (report — root cause + seam +
deferred finding), TASK-085 (report — CAS + external Microsoft semantics), TASK-090
(task/report — delivery-ownership state machine, mốc so sánh Telegram timeout),
TASK-091 (task/report — ErrorQuotaExceeded verdict), TASK-055/TASK-068A (mailbox
lock semantics, exactly-once), `docs/ROADMAP.md` (chỉ đọc context).

Code trace (đọc trực tiếp, không suy luận từ docs):

- `services/queue/workers/email-worker.ts`, `email-worker-runner.ts`
- `services/email/graph-message-pipeline.service.ts`, `delivery-ownership-policy.ts`
- `services/microsoft/graph-mail.service.ts`, `refresh-access-token.service.ts`,
  `refresh-token-rotation.service.ts`, `refresh-token-failure.ts`
- `services/queue/email-job-options.ts`, `email-queue.ts` (điểm enqueue),
  `mailbox-processing-lock.ts`, `mailbox-lock-factory.ts`, `redis-mailbox-lock.ts`
- `services/queue/workers/delta-polling-runner.ts` (đối chiếu TASK-080 wiring)
- `lib/http/fetch-with-timeout.ts`, `lib/env.ts` (concurrency defaults)
- `services/microsoft/delta-polling.service.ts`, `services/telegram/*` (hằng số
  timeout tham chiếu), `subscription-renewal-runner.ts` (option timeout của renewal)
- `node_modules/bullmq/dist/cjs/classes/worker.js`, `lock-manager.js` (defaults +
  lock-extender — evidence cho hang analysis)
- Repo-wide search: `fetch(`, `fetchWithTimeout`, `AbortController`, `signal`,
  `Promise.race`, `timeoutMs`, lock/claim/ownership seams, danh sách test hiện có.

---

## 3. Findings chính (kèm evidence file/function)

### F1 — Graph getMessageById trên email path KHÔNG có timeout/cancellation (CONFIRMED)

`email-worker-runner.ts` `graphMessageFetchPort.fetchMessage` (287–291) →
`getMessageById` (`graph-mail.service.ts` 313–344) → `performGraphRequest` (236–273)
gọi thẳng `fetch` native với init chỉ gồm method + headers: không `timeoutMs`,
không AbortController, không `signal`, không helper. Request có thể pending vô hạn.

### F2 — Email-path token refresh KHÔNG truyền `timeoutMs` (CONFIRMED)

`createPrismaEmailAccessTokenPort` (`email-worker-runner.ts` 255) gọi
`refreshMicrosoftAccessToken(plaintext)` không option. Shared service hỗ trợ
`timeoutMs?` (TASK-080) nhưng default là pass-through không timeout
(`fetch-with-timeout.ts` 59–62); chính comment tại `refresh-access-token.service.ts`
43–47 ghi rõ email worker chưa opt-in. Delta path truyền 20s
(`delta-polling-runner.ts` 223–225) — bất đối xứng có chủ đích từ TASK-080, nay là
gap cần đóng.

### F3 — Hang giữ trọn attempt: BullMQ không tự cứu khi process còn sống (CONFIRMED)

`createEmailWorker` không override lock options ⇒ BullMQ v5 defaults
`lockDuration 30s, stalledInterval 30s, maxStalledCount 1, lockRenewTime 15s`
(`bullmq/dist/cjs/classes/worker.js` dòng 34, 63–64) và lock-extender tự renew lock
cho mọi job active (`lock-manager.js` 28, 60–82). Hệ quả: processor promise pending
⇒ lock được renew vô hạn ⇒ không bao giờ stalled ⇒ attempt không settle, không
retry. Stalled/restart chỉ cứu khi process chết.

### F4 — Blast radius: 2 hang đồng thời = mất toàn bộ capacity (CONFIRMED)

`EMAIL_WORKER_CONCURRENCY` mặc định 2 (`lib/env.ts` 184, cap 20). Mỗi hang giữ 1
slot vĩnh viễn ⇒ 2 hang là worker-email ngừng xử lý mọi mailbox, process vẫn "sống".

### F5 — Mailbox lock có TTL 60s không renewal; job treo không wedge mailbox vĩnh viễn nhưng tạo cửa sổ double-run muộn (CONFIRMED)

In-memory lock (`mailbox-processing-lock.ts` 22, 89–113): TTL 60s, release trong
`finally` chỉ chạy khi pipeline settle; release-guard không xoá lease người kế nhiệm.
Nếu request treo resolve muộn, pipeline cũ chạy tiếp song song — được chặn duplicate
bởi stale guard 30 phút + identity claim (TASK-068A) + delivery-ownership CAS
(TASK-090): double-work có thể, duplicate delivery không.

### F6 — Cả hai HTTP seam nằm TRƯỚC identity claim và delivery-ownership claim (CONFIRMED)

Thứ tự trong `processGraphMessageJob`: lock (504) → mailbox (553) → token (597) →
Graph fetch (650) → dedup (723) → stale (827) → detect/extract (888/967) → identity
claim (1047) → ownership (1153) → Telegram (1399). Timeout ở token/Graph không tạo
row, không tạo lease, không terminal write ⇒ BullMQ retry nhìn thấy state sạch.
Không cần state machine mới cho Phase 2.

### F7 — Classifier hiện tại đã xử lý timeout đúng về OUTCOME, chỉ thiếu type precision (CONFIRMED)

Timeout (nếu bật qua `fetchWithTimeout`) ⇒ `HttpTimeoutError` ⇒ rơi vào catch network
sẵn có: Graph ⇒ `GraphMailError('network')` ⇒ `FAILED_GRAPH_FETCH` (retryable,
không reconnect — pipeline 420–464); refresh ⇒ `RefreshAccessTokenError('network')`
⇒ `classifyRefreshTokenError` = `transient` ⇒ `FAILED_TOKEN_TRANSIENT`
(`refresh-token-failure.ts` 44–64; pipeline 602–614). Không giả 401/403, không đụng
persistent-403 counter (chỉ tồn tại trên delta path), không đổi TASK-091 semantics.
Gap duy nhất: timeout bị gộp kind `network` (observability, không phải sai behavior).

### F8 — TASK-085 an toàn với timeout (CONFIRMED)

Timeout throw TRƯỚC `persistRotatedRefreshToken` (`email-worker-runner.ts` 253–277)
⇒ không ghi credential, không đụng expected-generation, không thể thành CAS
conflict; CAS-loser path (count 0 ⇒ `casLost`, không throw —
`refresh-token-rotation.service.ts` 160–169) là nhánh độc lập.

### F9 — Retry hữu hạn sau timeout (CONFIRMED)

`attempts: 3`, backoff exponential base 5s (`email-job-options.ts` 14–15, dùng tại
`email-queue.ts` 93 và `delta-polling-queue.ts` 71). Sau attempt cuối job vào failed
set (giữ 7 ngày/5000), không cơ chế re-enqueue tự động trong repo; đường quay lại
qua job prefix thứ hai bị chặn bởi stale guard 30 phút + status-aware dedup.

---

## 4. Confirmed vs disproved hypotheses

| Hypothesis | Kết quả |
|---|---|
| "Email path có thể đã có finite timeout đầy đủ (Option D khả thi)" | **DISPROVED** — F1, F2 |
| "Stalled detector sẽ cứu một processor promise pending" | **DISPROVED** — F3 (lock-extender renew vô hạn) |
| "Một hang chỉ ảnh hưởng một mailbox" | **DISPROVED một phần** — mailbox khác vẫn chạy tới khi hết slot; 2 hang (concurrency mặc định) = mất toàn bộ capacity (F4) |
| "Graph/token timeout cần state machine TASK-090 mới" | **DISPROVED** — cả hai seam trước mọi claim (F6) |
| "Timeout có nguy cơ giả 401/403 hoặc mark reconnect" | **DISPROVED** — F7 |
| "Timeout có nguy cơ hỏng TASK-085 CAS" | **DISPROVED** — F8 |
| "Retry sau timeout có thể vô hạn" | **DISPROVED** — F9 |
| "Cần migration/env mới" | **DISPROVED** — hằng số code-level, không schema/Redis/env change (task doc §11) |

---

## 5. Option comparison (tóm tắt — bảng đầy đủ ở task doc §9)

| Option | Cancellation thật | Phù hợp | Verdict |
|---|---|---|---|
| A — `fetchWithTimeout` tại đúng 2 seam email | CÓ (AbortController, signal tới native fetch) | Đúng pattern TASK-080/090, zero classifier change, testable bằng pattern test sẵn có | **CHỌN** |
| B — Watchdog / Promise.race tầng worker | KHÔNG (race để HTTP chạy nền; pipeline nền có thể side effect sau khi BullMQ retry) | Vi phạm điều kiện đề bài; muốn cancel thật phải luồn signal xuyên Prisma — scope lớn | Loại |
| C — Chỉ harden Graph fetch | Một nửa | Token refresh cùng blast radius, chi phí đóng ≈ 1 dòng — bất đối xứng vô lý | Loại |
| D — NO CHANGE | — | Bị bác bằng F1/F2/F3/F4 + precedent hang thật TASK-079 trên chính các endpoint Microsoft này | Loại |

## 6. Recommendation / verdict

**OPTION A** cho Phase 2, cụ thể:

- Thêm optional `timeoutMs` vào `GetMessageOptions`/`performGraphRequest`
  (`graph-mail.service.ts`), default pass-through (caller ngoài worker không đổi).
- `email-worker-runner.ts`: hằng số mới `EMAIL_WORKER_HTTP_TIMEOUT_MS = 20_000`
  dùng cho CẢ HAI seam — `graphMessageFetchPort` và option của
  `refreshMicrosoftAccessToken` (một dòng, giống delta runner).
- Giá trị 20s theo evidence: khớp `DELTA_POLLING_HTTP_TIMEOUT_MS` (cùng endpoints
  Microsoft, đã vận hành thật) và `CONNECT_SUBSCRIPTION_HTTP_TIMEOUT_MS`, và ≪
  delivery lease 300s; không env-tunable (locked-decision style TASK-080/090).
  **Lưu ý budget (đã correction — task doc §10.1):** mailbox-lock critical section
  bao phủ TOÀN BỘ attempt (acquire `pipeline` 504 → release `finally` 527–534, gồm
  cả ownership wait ≤305s, throttle sleeps ≤17s và Telegram phase ≤240s), nên
  worst-case attempt hợp lệ ≈ 300–600s vốn đã vượt TTL 60s từ TASK-090
  (`delivery-ownership-policy.ts` 15–24 tự tính ~257s). Lập luận cho 20s vì vậy
  KHÔNG phải "toàn attempt < TTL", mà là: (1) phase pre-claim — nơi duy nhất chỉ có
  mailbox lock bảo vệ chống double-run — được thu hẹp từ unbounded xuống ~40s + DB
  overhead < TTL 60s; (2) phase sau claim đã được ownership CAS fence sẵn; (3) khớp
  precedent 20s đang vận hành. Mailbox-lock expiry giữa attempt dài là pre-existing
  residual risk, ghi DF-92-6.
- Không migration, không Redis change, không env mới, không đổi classifier/state
  machine. Behavioral change chỉ ở worker-email; các service khác chỉ có
  compile/regression verification impact (shared module mở rộng optional type).

Test matrix deterministic cho Phase 2: task doc §12 (23 cases, fake timers /
controllable promises, không real network, không wall-clock wait).

---

## 7. Residual risks

1. Body-read (`response.json()`) vẫn ngoài cửa sổ abort sau Phase 2 — cùng
   precedent đã chấp nhận ở delta/Telegram (DF-92-1); trần headers 20s đã loại bỏ
   failure mode "TCP treo" thực chứng của TASK-079.
2. `fetchWithTimeout` ghi đè caller-signal (DF-92-2) — không caller nào hiện truyền
   signal; ghi nhận cho tương lai.
3. Timeout gộp vào kind `network` — mất phân biệt timeout/DNS trong logs; đúng về
   behavior, có thể thêm log field an toàn ở Phase 2 nếu reviewer yêu cầu.
4. Web-path Graph/OAuth calls không timeout (DF-92-3/5) — ngoài scope, đã ghi
   deferred.
5. **Mailbox-lock TTL 60s < worst-case attempt hợp lệ (pre-existing, DF-92-6).**
   Critical section của mailbox lock bao phủ toàn bộ attempt, và một attempt hợp lệ
   có thể kéo dài ~300–600s (Telegram retry ≤240s, ownership wait ≤305s, throttles
   ≤17s — task doc §10.1) ⇒ hai attempt cùng mailbox có thể chạy chồng sau TTL,
   NGAY CẢ không có HTTP hang. Đây là thiết kế đã chấp nhận từ TASK-090
   (`delivery-ownership-policy.ts` tự tính ~257s): serialization per-mailbox là
   best-effort; exactly-once dựa trên identity claim + ownership CAS. Claims bảo vệ
   duplicate delivery và terminal-write overwrite; KHÔNG bảo vệ double Microsoft
   calls / double detector-DB work (rotation kép vẫn an toàn nhờ TASK-085 CAS).
   Option A không làm risk này xấu hơn — nó thu hẹp phase pre-claim (chỉ được
   mailbox lock bảo vệ) từ unbounded xuống ~40s < TTL.

---

## 8. Correction pass trước Antigravity review

Hai điểm được sửa sau lần verification đầu:

1. **Verification gap của file untracked.** Lần kiểm tra đầu chạy `git diff --check`
   / `git diff --stat` / `git diff -- <file>` khi hai tài liệu còn untracked ⇒ mọi
   kết quả rỗng và KHÔNG kiểm tra được nội dung thật. Đã đóng gap bằng
   `git add -N` (intent-to-add, không stage nội dung, không commit) cho đúng hai
   file, sau đó đọc lại TOÀN BỘ diff thực tế của cả hai tài liệu: chỉ hai file
   TASK-092 xuất hiện; nội dung đầy đủ hiển thị trong diff; không whitespace error
   (`git diff --check` sạch — chỉ có warning CRLF autocrlf của Git trên Windows,
   informational, không phải lỗi); không secret/dữ liệu nhạy cảm; không wording dễ
   gây secret-scan false positive; không nội dung nào trình bày implementation giả
   định như đã xảy ra; task và report thống nhất.
2. **Timeout-budget correction.** Lập luận cũ "2 × 20s = 40s < 60s mailbox-lock
   TTL" chưa tính phần còn lại của critical section (ownership wait, throttles,
   Telegram phase). Đã trace lại và thay bằng end-to-end budget đầy đủ (task doc
   §10.1) + residual risk DF-92-6; recommendation giữ nguyên 20s với lập luận đã
   sửa (kết luận dạng A: giữ giá trị, ghi rõ lock-expiry là pre-existing risk và
   Option A chỉ cải thiện, không làm xấu hơn).

---

## 9. Exact two-file diff summary

`git status --short` sau correction (hai file ở trạng thái intent-to-add ` A`,
không file nào khác thay đổi):

- `docs/tasks/TASK-092-email-worker-http-timeout-hardening.md` — MỚI (Phase 1
  architecture: execution path, HTTP inventory, hang analysis, critical-section
  budget §10.1, options, test matrix, DF-92-6).
- `docs/reports/TASK-092-email-worker-http-timeout-hardening.md` — MỚI (report này).

Không code/test/schema/migration/config/workflow/ROADMAP thay đổi. Chưa commit,
chưa push.

---

## 10. Verification results

- `npm run verify` (db:generate + lint + typecheck + test + build): **PASS** —
  ESLint sạch, `tsc --noEmit` sạch, vitest 109 test files / 1344 tests passed,
  `next build` thành công. Hai file docs không tham gia pipeline nên kết quả phản
  ánh trạng thái pre-existing của repo, không bị ảnh hưởng bởi thay đổi tài liệu.
- `git diff --check` trên nội dung thật (sau intent-to-add): **PASS** — không
  whitespace error.
- `git diff --stat`: đúng hai file TASK-092; full diff của cả hai đã được đọc và
  review toàn bộ (mục 8).

---

## 11. Readiness cho Antigravity Architecture Review

Investigation hoàn tất, mọi câu hỏi bắt buộc của đề bài đã trả lời bằng code
evidence; recommendation duy nhất (Option A) đã chốt kèm timeout budget, migration
decision (KHÔNG), service impact matrix và deterministic test matrix. Không blocker.
Sẵn sàng cho Antigravity Architecture Review trước khi Phase 2 implementation.

> Kết quả sau đó: Antigravity Architecture Review —
> **PASS — TASK-092 PHASE 1 ARCHITECTURE APPROVED FOR PHASE 2 IMPLEMENTATION**
> (các finding Low được ghi nhận, không yêu cầu sửa trong TASK-092).

---

# PHASE 2 — IMPLEMENTATION REPORT

## 12. Implementation summary (đúng Option A đã khóa)

- **Graph seam:** `GetMessageOptions` nhận optional `timeoutMs`;
  `performGraphRequest` chuyển từ fetch trần sang `fetchWithTimeout` với
  `{ timeoutMs }` — không truyền ⇒ pass-through y nguyên (caller web/manual không
  đổi behavior); truyền ⇒ AbortController signal tới đúng native fetch, abort
  thật khi hết trần. `listInboxMessages` không truyền timeout (DF-92-5 deferred).
- **Email caller wiring:** hằng số `EMAIL_WORKER_HTTP_TIMEOUT_MS = 20_000` trong
  `email-worker-runner.ts`, dùng cho CẢ HAI seam: token refresh
  (`refreshMicrosoftAccessToken(..., { timeoutMs })` — chỉ wire option sẵn có từ
  TASK-080) và Graph fetch (`getMessageById(..., { timeoutMs })`).
- Không default global mới cho web/worker-delta/worker-renewal; không Promise.race;
  không operation nền sau timeout; không env config; không error taxonomy mới.

## 13. Files changed (Phase 2)

| File | Loại |
|---|---|
| `services/microsoft/graph-mail.service.ts` | Sửa — optional `timeoutMs` threading qua `performGraphRequest`/`getMessageById` |
| `services/queue/workers/email-worker-runner.ts` | Sửa — constant + wiring hai seam |
| `tests/unit/microsoft/graph-mail.timeout.test.ts` | MỚI — 3 deterministic cases |
| `tests/unit/queue/email-worker-runner.test.ts` | Sửa — mocks forward options; 3 tests mới + 1 assertion cập nhật |
| Hai tài liệu TASK-092 | Cập nhật Phase 2 |

## 14. Error behavior & regression evidence

- Timeout Graph ⇒ `HttpTimeoutError` ⇒ catch sẵn có ⇒ `GraphMailError('network')`
  ⇒ `FAILED_GRAPH_FETCH` (throw ⇒ BullMQ retry). Timeout refresh ⇒
  `RefreshAccessTokenError('network')` ⇒ `transient` ⇒ `FAILED_TOKEN_TRANSIENT`
  (throw ⇒ retry). Test mới assert kind `network`, `httpStatus` undefined —
  không 401/403 giả; pipeline tests sẵn có assert không `markReconnectRequired`,
  không FAILED permanent, không Telegram call trên nhánh này.
- **TASK-085:** test mới chứng minh refresh timeout ⇒ classification `transient`
  và `persistRotatedRefreshToken` KHÔNG được gọi (throw trước persist, không
  partial write); CAS win/lose semantics giữ nguyên qua
  `refresh-token-rotation.service.test.ts` (không sửa); reconnect priority giữ
  nguyên qua các classification tests hiện có (invalid_grant/interaction_required
  vẫn `reconnect_required`).
- **TASK-090:** không di chuyển HTTP call nào — diff chỉ thêm options tại đúng
  hai call-site hiện hữu (trước identity/delivery claim); lease/ownership/CAS và
  Telegram sender không đổi; `graph-message-pipeline.delivery-recovery.test.ts`
  pass nguyên vẹn ⇒ retry sau timeout nhìn delivery state sạch.
- **TASK-091/403:** `graph-mail.service.test.ts` (403 ⇒ `permission`) và toàn bộ
  delta tests (kể cả `delta-polling.timeout.test.ts` TASK-080) pass không sửa ⇒
  real-403/ErrorQuotaExceeded/persistent-403 semantics không đổi.
- Caller không truyền timeout: test pass-through mới (không signal injected) +
  toàn bộ `graph-mail.service.test.ts` (26 tests, không sửa) pass.

## 15. Deterministic tests đã thêm/sửa (Phase 2)

- **MỚI `tests/unit/microsoft/graph-mail.timeout.test.ts`:**
  1. Fast success với `timeoutMs`: signal (AbortSignal) tới exact fetch; advance
     60s sau success ⇒ `signal.aborted === false` (timer cleanup, không
     late-abort).
  2. Hanging fetch: fake timers; chưa settle tại 19.999s, settle đúng 20.000s;
     error là `GraphMailError` kind `network` (không auth/permission);
     `init.signal.aborted === true` (abort thật); fetch gọi đúng 1 lần.
  3. Không truyền `timeoutMs`: pass-through, `init.signal === undefined`.
- **Mở rộng `tests/unit/queue/email-worker-runner.test.ts`:**
  - Constant pin `EMAIL_WORKER_HTTP_TIMEOUT_MS === 20_000`.
  - Refresh wiring: gọi với `{ timeoutMs: EMAIL_WORKER_HTTP_TIMEOUT_MS }`.
  - Graph port wiring: `getMessageById` nhận cùng constant.
  - Refresh timeout ⇒ `transient` + KHÔNG gọi persist (TASK-085 negative).
- Không real network, không real secrets, không sleep wall-clock, không flaky
  timing (fake timers + controllable promises + `signal.aborted` assertions).
- Coverage sẵn có được tận dụng cho worker rethrow, lock release, isolation,
  CAS, delivery recovery, delta/TASK-080 — chi tiết mapping ở task doc §16.3.

## 16. Verification results (Phase 2)

- Targeted: 5 test files liên quan seam (graph-mail.timeout, graph-mail.service,
  email-worker-runner, refresh-access-token.timeout, delta-polling.timeout) —
  **51/51 PASS**.
- `npm run verify` (db:generate + lint + typecheck + test + build): **PASS** —
  toàn bộ suite (110 test files) pass, build thành công (kết quả đầy đủ ghi ở
  báo cáo phiên).
- `git diff --check`: PASS; `git status --short`/`git diff --stat`: chỉ các file
  trong scope Phase 2 (2 code, 2 test, 2 docs); full diff đã được đọc lại.

## 17. Migration / service impact (xác nhận sau implementation)

Không Prisma schema, không migration, không Redis structure, không BullMQ job
options, không env, không GitHub Actions, không Railway (staging giữ branch
`staging`). Behavioral change chỉ ở worker-email; worker-delta/web/worker-renewal
chỉ chịu compile/regression verification (đã pass trong `npm run verify`).

## 18. Residual / deferred (không đổi so với Phase 1)

DF-92-1 (body-read ngoài cửa sổ abort), DF-92-2 (caller-signal composition),
DF-92-3/5 (web/OAuth/listInboxMessages), DF-92-4 (Redis mailbox lock wiring),
DF-92-6 (mailbox-lock TTL < worst-case attempt — pre-existing), timeout
observability metadata. Tất cả giữ nguyên deferred theo đúng Architecture Review.

## 19. Antigravity Implementation Review — kết quả chính thức

Kết luận: **PASS — TASK-092 PHASE 2 IMPLEMENTATION APPROVED.**

- Không có finding Critical, High hoặc Medium.
- Ba nhóm Low note không chặn nghiệm thu (không sửa trong TASK-092):
  1. response body read nằm ngoài cửa sổ timeout (DF-92-1);
  2. timeout observability gộp vào network classification;
  3. "pre-claim dưới 60 giây" chỉ là operational expectation.
- Low/residual findings giữ nguyên deferred: DF-92-1; DF-92-2; DF-92-3/DF-92-5;
  DF-92-4; DF-92-6.
- Implementation Option A được xác nhận đúng: timeout 20.000 ms cho token
  refresh; timeout 20.000 ms cho Graph `getMessageById`; cancellation thật bằng
  AbortController; không Promise.race; caller không truyền timeout giữ
  pass-through behavior.
- Regression: TASK-085 credential CAS PASS; TASK-090 delivery-state PASS;
  TASK-091/real-403 PASS.
- Verification độc lập: targeted 5 test files / 51 tests PASS; full run
  110 test files / 1350 tests PASS; lint/typecheck/build PASS.
- Không migration; không env/Redis/BullMQ/Railway change; behavioral change chỉ
  ở worker-email.

## 20. Trạng thái

Chưa commit/push; chưa promotion staging; ROADMAP chưa cập nhật vì staging
validation chưa hoàn tất.
**Antigravity Implementation Review PASS; sẵn sàng Final Pre-Commit Review.**
