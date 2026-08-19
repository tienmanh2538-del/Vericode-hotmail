# TASK-080 — Report: Delta Polling Stuck Recovery & Stale Message Relay Protection

> **Sanitized.** Không chứa secret/URL/token/full verification code/full email body.
> Reviewer độc lập: **Antigravity CLI**. **Không commit / không push.** ROADMAP chưa
> đổi sang completed (chỉ sau khi qua Antigravity review).

## 1. Root cause code-level (đã xác minh, khớp TASK-079)

Delta scheduler tự khoá vì một Microsoft HTTP request trên delta path **không bao giờ
settle**. `startDeltaPollingScheduler` giữ cờ `inflight` và chỉ clear trong `finally`
sau khi `runDeltaPollingOnce` await xong; `runDeltaPollingOnce` gọi Microsoft qua native
`fetch` **không có timeout/AbortController**. Một request treo ⇒ promise pending vĩnh
viễn ⇒ `inflight` không bao giờ null ⇒ mọi tick sau rơi vào nhánh
`if (inflight !== null) { log('skipping tick …'); return; }`. Process vẫn "active" nên
health check kiểu "Running?" không phát hiện.

## 2. Exact hanging seam (files/functions)

Hai seam HTTP trên delta path, cả hai dùng native `fetch` không timeout:

1. **Graph delta request** — `fetchDeltaPage()` trong
   `services/microsoft/delta-polling.service.ts` (gọi `deps.fetchImpl`).
2. **Token-refresh request** — `refreshMicrosoftAccessToken()` trong
   `services/microsoft/refresh-access-token.service.ts`, được gọi trên delta path qua
   `createPrismaAccessTokenPort()` trong
   `services/queue/workers/delta-polling-runner.ts`.

`refreshMicrosoftAccessToken` là **shared** (email worker, delta, renewal). Email
worker's Graph fetch (`graph-mail.service.ts`) cũng không timeout nhưng **ngoài phạm vi**
TASK-080 (không phải scheduler-bound; TASK-079 xác nhận consumer không phải root cause) —
ghi lại ở mục 13 (deferred).

## 3. Minimal fix đã chọn & lý do

Thêm helper `lib/http/fetch-with-timeout.ts` (`fetchWithTimeout` + `HttpTimeoutError`)
bọc một fetch với **AbortController + finite timeout**. Áp tại **đúng hai seam trên delta
path**:

- `fetchDeltaPage` truyền `{ timeoutMs: DELTA_POLLING_HTTP_TIMEOUT_MS }` (hằng số mới,
  20s, không qua `.env`).
- `refreshMicrosoftAccessToken` nhận thêm option `timeoutMs?` (mặc định **không timeout →
  behavior cũ y nguyên** cho email worker/OAuth/renewal); delta runner truyền cùng hằng
  số 20s.

Lý do chọn seam HTTP thay vì watchdog ở scheduler: khi **mọi** request trên delta path
có ceiling hữu hạn, `runDeltaPollingOnce` **luôn settle**, nên non-overlap guard sẵn có
(`inflight` clear trong `finally`) tự động release và tick sau chạy lại — không cần đổi
logic scheduler, không cần watchdog reset `inflight` (tránh rủi ro reset khi op cũ còn
chạy). Blast radius tối thiểu: shared token service giữ default cũ trừ khi caller opt-in.

## 4. Cancellation bảo đảm old operation settle trước khi release runner

`fetchWithTimeout` khi hết giờ gọi `controller.abort()` → **hủy thật** request đang chạy
(native `fetch` reject `AbortError`; socket bị tear down) → helper ném `HttpTimeoutError`.
Đây **không** phải `Promise.race` để "thoát" khỏi một promise vẫn chạy nền: request cũ
thực sự bị cancel. Vì vậy khi `runDeltaPollingOnce` reject/return, không còn I/O treo,
và scheduler release `inflight` an toàn. `HttpTimeoutError` chỉ được ném khi CHÍNH timer
này abort (biến `timedOut`), nên một `AbortError` do nguyên nhân khác không bị nhầm; timer
luôn `clearTimeout` trong `finally` (không late-abort sau success).

## 5. Tránh concurrent polling

Non-overlap guard hiện có được giữ nguyên: mỗi tick kiểm tra `inflight !== null` và skip
nếu cycle trước còn chạy. Không thêm retry loop tức thời, không tăng concurrency. Timeout
chỉ khiến cycle **kết thúc hữu hạn**; tick kế tiếp theo đúng nhịp `setInterval` như cũ.
Test scheduler (mục 11) chứng minh: tick thứ hai bị skip khi cycle #1 còn active, và cycle
#2 chỉ chạy **sau khi** cycle #1 settle.

## 6. Timeout interaction với TASK-071 / TASK-075

Timeout được phân loại **controlled transient**, tách bạch khỏi 403:

- `fetchDeltaPage`: `HttpTimeoutError` → `DeltaPollingHttpError('transient', 0,
  'GRAPH_TIMEOUT')` — **không** đi qua `classifyHttpStatus` nên **không** thành
  `'forbidden'`. Ở `runDeltaPollingOnce`, `'transient'` rơi vào nhánh `else` →
  `safelyRecordError` (ghi metadata), **không** `markReconnectRequired`, **không**
  `recordForbiddenBackoff` ⇒ **không** tăng persistent-403 counter, **không** kích hoạt
  cooldown TASK-075.
- Token timeout → `RefreshAccessTokenError('network')` → `classifyRefreshTokenError` →
  `'transient'` ⇒ **không** flip `RECONNECT_REQUIRED`.
- **Real 403** vẫn `classifyHttpStatus(403) → 'forbidden'` → self-heal cursor + backoff/
  cooldown/alert (TASK-071/075) **nguyên vẹn**. **Real 401** vẫn `'auth'` → reconnect.
  Toàn bộ test 403/401 cũ vẫn pass (mục 12).

## 7. Freshness source & threshold (Implementation B)

- Nguồn thời gian: **Microsoft Graph `receivedDateTime`** (parse qua helper mới
  `parseGraphReceivedAt`, **không** fallback). Tuyệt đối không dùng enqueue/job/processing
  time.
- Ngưỡng: **`MAX_RELAY_MESSAGE_AGE_MINUTES = 30`** (single source-of-truth trong
  `graph-message-pipeline.service.ts`, **không** qua `.env`). Không có hằng số relay-
  freshness sẵn có nào phù hợp trong repo (các hằng ở `health.service` là cho subscription/
  polling staleness/telegram-failure window, khác mục đích) → tạo mới, đã ghi rõ ở đây.
- Boundary: `age <= 30m` fresh; `age > 30m` stale (đúng 30m vẫn fresh — có test).

## 8. Vị trí freshness guard trong pipeline

Đặt trong `processActiveMailboxJob` **sau** khối early message-identity dedup
(`findByGraphMessageId` + `findByInternetMessageId`) và **trước** detector/extractor/claim/
mapping/Telegram. Lý do:

- Bảo toàn tuyệt đối semantics dedup hiện có (duplicate vẫn báo `SKIPPED_DUPLICATE`).
- Đảm bảo Telegram sender **không bao giờ** được gọi cho stale (mọi bước gửi ở sau).
- **Không** extract/log code để quyết định stale (guard chạy trước extractor).
- Áp cho **cả** webhook-origin lẫn delta-origin vì cả hai đi qua cùng
  `processGraphMessageJob`.

## 9. Stale result / status semantics

- Status pipeline mới `SKIPPED_STALE` (internal union; `classifyWorkerJobResult` →
  `'skipped'`; **không** nằm trong danh sách throw của `processEmailWebhookJob` ⇒ worker
  **hoàn thành job, không retry**).
- CodeEvent operator-visible: reuse hạ tầng hiện có với status **`CODE_SKIPPED_STALE`**.
  Cột DB `CodeEvent.status` là **`String`** (không phải Prisma enum) ⇒ **không cần
  migration**. Thêm label + badge variant (`Record<CodeEventStatus,_>` bắt buộc phủ đủ).
- Ghi CodeEvent **không** kèm `maskedCode` (skip trước extraction) — không full code, không
  email body. `message: 'stale_gt_30m'` (an toàn).

## 10. Dedup / exactly-once preservation

Guard đặt **trước** `claimMessageForProcessing` nên stale message **không** tạo
`ProcessedMessage` row — không ảnh hưởng exactly-once của message hợp lệ. Stale skip là
idempotent (cùng `receivedDateTime` → luôn stale → luôn skip). Early dedup vẫn chạy trước
guard nên duplicate thật vẫn báo duplicate (có test). Không reorder dedup. Test exactly-
once/duplicate cũ vẫn pass.

## 11. Tests đã thêm (17 test, 5 file mới)

- `tests/unit/lib/fetch-with-timeout.test.ts` (5): pass-through khi không timeout; resolve
  bình thường; **timeout → abort thật → HttpTimeoutError**; re-throw lỗi non-timeout;
  không late-abort sau success (timer cleared).
- `tests/unit/microsoft/delta-polling.timeout.test.ts` (2): hanging delta request →
  timeout hữu hạn, cycle **settle**, ghi transient `GRAPH_TIMEOUT`, **không** reconnect,
  **không** forbidden-backoff, không enqueue; normal fetch vẫn advance cursor.
- `tests/unit/queue/delta-polling-scheduler.test.ts` (1): tick thứ hai **skip** khi cycle
  #1 in-flight; sau khi cycle #1 **settle**, tick kế chạy cycle #2 (không permanent stuck).
- `tests/unit/microsoft/refresh-access-token.timeout.test.ts` (2): hanging token request →
  `network` error → `classifyRefreshTokenError` = `transient` (không reconnect); bỏ
  `timeoutMs` → behavior cũ, không inject signal.
- `tests/unit/email/graph-message-pipeline.stale.test.ts` (7): fresh 10m gửi; đúng 30m
  fresh; 31m **stale, Telegram NOT called**, CodeEvent `CODE_SKIPPED_STALE` không maskedCode;
  old-receivedDateTime + job vừa enqueue vẫn stale (source timestamp); missing timestamp →
  **fail-safe proceed** (không fallback enqueue); duplicate precedence giữ nguyên; stale là
  terminal skip (`classifyWorkerJobResult`='skipped' + `processEmailWebhookJob` resolve,
  không throw).

Tests deterministic: fake timers (`vi.advanceTimersByTimeAsync`) + signal-aware fake fetch
+ dependency injection. Không chờ timeout thật.

## 12. `npm run verify`

**PASS (exit 0).** Lint + typecheck sạch. Test: **96 test files / 1115 tests passed**
(baseline 1098 → +17). Build: `Compiled successfully`. Test real-403/401 và exactly-once
cũ (TASK-071/074/075/068A) vẫn xanh.

## 13. Remaining risks

- Hằng số timeout 20s và stale threshold 30m là code-level (không env-tunable trong task
  này) — nếu vận hành cần chỉnh, mở task đưa vào config (ngoài scope TASK-080).
- `graph-mail.service.ts` (Graph fetch của **email worker**) và OAuth token-exchange vẫn
  không timeout — không phải root cause TASK-079 (consumer đã chứng minh khỏe) nhưng là
  cùng lớp rủi ro; **deferred** (mục 14).
- Stale guard là best-effort theo `receivedDateTime` server-side; đồng hồ Graph vs worker
  lệch nhỏ có thể ảnh hưởng biên 30m ở mức giây — chấp nhận được cho mục tiêu chặn backlog cũ.
- Chưa xác minh live với Microsoft thật (theo ràng buộc task: không gọi Graph/Telegram thật).

## 14. Deferred có chủ đích (KHÔNG làm trong TASK-080)

- **Graph subscription wiring** (finding kiến trúc TASK-079): production chưa tạo
  subscription cho mailbox mới; renewal không có candidate. → **task riêng sau TASK-080**.
- Timeout cho email-worker Graph fetch + OAuth token-exchange (cùng lớp defensive timeout).
- Đưa timeout/stale-threshold thành config; observability "stuck cycle" trên health
  dashboard (dựa `deltaLastPolledAt` + phát hiện log lặp).

## 15. Files thay đổi

**Runtime (7):**
- `lib/http/fetch-with-timeout.ts` (mới) — helper AbortController + timeout.
- `services/microsoft/delta-polling.service.ts` — timeout cho `fetchDeltaPage`; hằng
  `DELTA_POLLING_HTTP_TIMEOUT_MS`; timeout → `GRAPH_TIMEOUT` transient.
- `services/microsoft/refresh-access-token.service.ts` — option `timeoutMs?` (default cũ).
- `services/queue/workers/delta-polling-runner.ts` — truyền `timeoutMs` cho token refresh.
- `services/email/graph-message-pipeline.service.ts` — stale guard + `SKIPPED_STALE` +
  `parseGraphReceivedAt` + hằng `MAX_RELAY_MESSAGE_AGE_*`.
- `services/logs/code-event-log.service.ts` — status `CODE_SKIPPED_STALE` + label.
- `components/status/CodeEventStatusBadge.tsx` — variant cho `CODE_SKIPPED_STALE`.

**Tests (5 mới):** như mục 11.

**Docs (2):** `docs/tasks/TASK-080-…md`, `docs/reports/TASK-080-…md` (file này).

Không sửa `.env*`, schema/migration, GitHub Actions/CI. Không commit/push.
