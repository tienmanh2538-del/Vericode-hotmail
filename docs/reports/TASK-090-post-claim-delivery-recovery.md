# TASK-090 — Post-Claim Telegram Delivery Failure Recovery & Delivery State Safety (Report)

> **PHASE 2 — IMPLEMENTED, CHỜ ANTIGRAVITY IMPLEMENTATION REVIEW.**
>
> Antigravity Architecture Review: **PASS — TASK-090 ARCHITECTURE APPROVED FOR PHASE 2
> IMPLEMENTATION** (kiến trúc khóa: **OPTION A — claim-before-send + explicit delivery
> state + status-aware dedup**). Phase 2 đã implement xong: implementation record đầy
> đủ ở task file **§20**; tóm tắt ở mục **P** dưới đây. `npm run verify` **PASS** —
> 108 test files / 1339 tests. Chưa commit/push; chưa update ROADMAP; **không migration
> nào được chạy trên staging/production**; không thao tác Railway.
>
> Mục A–O bên dưới là Phase 1 findings (mô tả HEAD TRƯỚC khi implement — giữ nguyên
> làm evidence). Hành vi hiện hành sau Phase 2: mục **P** + task file §20.
>
> Quy ước an toàn: không token/secret/connection URL; không full verification code /
> email body; không ghi nguyên tên nhánh Git đầy đủ (theo CLAUDE.md).

---

## A. Precheck

Đúng nhánh làm việc của TASK-090; working tree sạch; HEAD `c9592f0` chứa trạng thái
hoàn tất TASK-089. **PASS.**

## B. Exact delivery ordering hiện tại (tóm tắt — chi tiết task file §4)

Webhook (`app/api/webhooks/microsoft/mail/route.ts`, TASK-073: enqueue fail → 503
redeliver) và delta (`delta-polling.service.ts` → `delta-polling-queue.ts`) enqueue vào
cùng queue với **jobId deterministic nhưng khác prefix** (cùng message có thể có 2 job).
Job options: `attempts: 3`, exponential backoff 5s (`email-job-options.ts`).

Worker attempt (`email-worker.ts` → `graph-message-pipeline.service.ts`):

per-mailbox lock (in-memory trong production hiện tại) → mailbox ACTIVE check → access
token → Graph fetch → **early dedup theo graphMessageId/internetMessageId — KHÔNG lọc
status** (dòng 697–757) → stale guard 30m TASK-080 (759–805) → detector → extractor →
**ProcessedMessage claim INSERT `status=DETECTED`** (952–1025, unique
`(mailboxId, graphMessageId)`, P2002 → skip sạch) → mapping lookup → destination
throttle + global pacer → **Telegram send qua retry port TASK-033** (tối đa 4 HTTP
send, backoff 5/15/30s; exhausted/permanent → CRITICAL alert + throw) → `markSent`
(`status=SENT`, fail được nuốt) → CodeEvent/Audit (fire-and-forget) → worker: mọi
`FAILED_*`/`DEFERRED_*` throw → BullMQ retry; mọi `SKIPPED_*`/`CODE_SENT` return →
job complete terminal.

## C. Root technical findings

1. **Early dedup mù trạng thái delivery:** một row `DETECTED` chưa từng gửi chặn mọi
   lần xử lý lại y hệt row `SENT` (`prisma-processed-message-store.ts` — findUnique
   không điều kiện status).
2. **Claim-before-send + dedup mù trạng thái ⇒ một message identity chỉ có đúng MỘT cơ
   hội đi tới bước send trong toàn bộ vòng đời hệ thống.** BullMQ `attempts: 3` bị vô
   hiệu sau claim: attempt kế tiếp luôn kết thúc `SKIPPED_DUPLICATE` (terminal).
3. ProcessedMessage không có delivery state nào ngoài `status` + `sentToTelegramAt`:
   không retry count, không lease/owner, không Telegram message id (pipeline vứt bỏ
   `message_id` Telegram trả về), không writer nào ghi `FAILED` — health metric
   "Telegram FAILED recent" (`health.service.ts` ~669) hiện chết (luôn 0).
4. Per-mailbox lock production hiện là in-memory (Redis lock TASK-068A có code nhưng
   chưa wire) — không cross-process; concurrency safety thực tế dựa hoàn toàn vào DB
   unique claim (điều này ĐÚNG và đủ cho chống duplicate claim).

## D. Permanent-loss verdict

**CÓ — CONFIRMED bằng REPO EVIDENCE (task file §9 S1, S2).**

* S1: claim OK → Telegram retryable fail → internal retry (4 lần, ~50s) cạn → worker
  throw → BullMQ attempt #2 → early dedup thấy row DETECTED → `SKIPPED_DUPLICATE`
  terminal → **code không bao giờ được gửi**, row DETECTED vĩnh viễn, không cơ chế
  recovery nào trong repo. Tín hiệu duy nhất: CRITICAL alert TASK-035.
* S2: claim OK → crash trước send → BullMQ requeue (stalled) → attempt sau bị dedup
  nuốt như trên — **và không có cả alert** (process chết trước khi kịp alert).
* Severity HIGH: mất im lặng verification code là mất chức năng chính. Blast radius
  per-message, nhưng một Telegram outage vài phút nuốt mọi code phát sinh trong outage.

## E. Duplicate-window verdict

**CÓ, nhưng hẹp và tồn tại sẵn hôm nay (không cần crash):** S4 — HTTP request đã rời
process, response timeout/mất → lỗi phân loại `network` (retryable) → internal retry
gửi lại trong cùng attempt → nếu request đầu thực ra đã tới Telegram thì group nhận 2
message. Telegram Bot API không có idempotency key nên không phân biệt được. Crash-path
S3 (send OK → crash trước markSent) hiện KHÔNG duplicate — chính early dedup chặn — đổi
lại local rơi vào trạng thái "sent remotely but unknown locally" (row DETECTED, không
phân biệt được với S2).

## F. Telegram internal retry vs BullMQ retry verdict

Hai lớp độc lập, giao nhau đúng một chỗ: internal retry (TASK-033) chỉ retry HTTP call
**bên trong một worker attempt, dưới một claim đã tồn tại** (≤4 sends, retryable =
429/5xx/network; permanent 4xx không retry); khi cạn nó throw → pipeline
`FAILED_TELEGRAM_SEND` → worker throw → **BullMQ retry chạy lại toàn pipeline từ đầu**
— và bị early dedup chặn trước khi tới được send. Kết quả: BullMQ retry hiện **không
bao giờ** giúp được Telegram failure sau claim. Phụ: worker không phân biệt
retryable/permanent Telegram failure nên permanent 4xx vẫn tốn 1 BullMQ retry vô ích
(DF-90-4).

## G. Architecture options (chi tiết + guarantee matrix: task file §11)

* **OPTION A — giữ claim-before-send + explicit delivery state + status-aware early
  dedup + redelivery tái dùng BullMQ attempts.** Chữa S1/S2; trade-off có chủ đích:
  sau claim trở thành at-least-once → crash-window duplicate (S3 mới) có thể xảy ra.
  Ba invariant bắt buộc: stale re-check trước mỗi re-send; terminal state rõ ràng
  (permanent 4xx / budget cạn / stale-out); trade-off ghi thành văn.
* **OPTION B — claim sau send: LOẠI.** Đổi loss lấy duplicate không-bound, phá chỗ dựa
  của TASK-073/068A.
* **OPTION C — outbox/delivery-attempt state machine:** guarantee trần bằng A (giới
  hạn nằm ở provider contract), chi phí bảng mới + worker mới + nguồn truth kép —
  không tương xứng.
* **OPTION D — minimal seam không migration** (coi `DETECTED + sentToTelegramAt null`
  là re-processable): khả thi làm fallback, nhưng nhập nhằng với trạng thái
  `SKIPPED_NO_TELEGRAM_MAPPING` (cũng DETECTED+null), không có terminal state, không
  audit — kém Option A.

## H. Recommended architecture

**OPTION A** — evidence đủ mạnh cho verdict và cho hướng đi; các open question còn lại
(hình thức state tối thiểu; lease mới vs wire Redis mailbox lock sẵn có; policy cho
crash-ambiguous rows: resend-once-trong-30m vs terminal-with-alert) ghi rõ ở task file
§12 để Antigravity chốt. Không hứa "zero duplicate + zero loss": exactly-once external
side effect là **IMPOSSIBLE TO PROVE** với Telegram Bot API hiện tại (không idempotency
key, không reconciliation seam) — mọi option chỉ chọn phía trade-off và bound cửa sổ.

## I. Schema/migration verdict

**Schema/migration likely required in Phase 2, subject to Antigravity Architecture
Review PASS.** Phase 1 không viết schema/migration. Nếu Phase 2 có migration: rollout
theo quy trình migration safety/preflight TASK-088 trước promotion.

## J. Service impact

worker-email: direct. worker-delta: producer-only, không đổi. web: gián tiếp nhỏ (2
reader của ProcessedMessage.status — health dashboard + mailbox detail; nếu tái dùng
`FAILED` thì gần zero-change và sửa được metric đang chết). worker-renewal: không.
Prisma/DB: khả năng cần migration. Queue contract: không đổi. Railway: không thao tác,
không đổi source khỏi dedicated branch staging.

## K. Phase-2 test matrix

18 nhóm test được thiết kế ở task file §16 (không implement ở Phase 1): normal
delivery, concurrent duplicate, retryable-fail → recovery, internal retries exhausted,
BullMQ retry đi tới send lại (đảo ngược S1), crash-sau-claim recovery, send-OK-crash
-trước-markSent theo policy, lost-ack bounded duplicate, permanent 4xx terminal,
multi-replica ownership race, lease reclaim, stale-trước-recovery không gửi, webhook+
delta hai thời điểm, no-infinite-retry (fake clock), budget cạn → terminal + alert,
sanitized logging, regression TASK-080/089/068A/033 green, migration tests (nếu được
approve). Crash cases dùng deterministic fault seam qua injected ports — không gọi
dịch vụ thật.

## L. Files changed (Phase 1)

* `docs/tasks/TASK-090-post-claim-delivery-recovery.md` (mới)
* `docs/reports/TASK-090-post-claim-delivery-recovery.md` (mới — file này)

Không file code/schema/test/CI/ROADMAP nào thay đổi.

## M. Verification

* `npm run verify`: kết quả ghi ở báo cáo cuối gửi Human (chạy sau khi chốt docs).
* `git diff --check`: kết quả ghi ở báo cáo cuối.
* Diff đã được soát: không secret, không token, không full code, không tên nhánh đầy
  đủ, không wording dễ gây secret-scan false positive.

## N. Remaining / deferred risks

* DF-90-1: health metric FAILED chết (không writer) — Option A sửa như hệ quả.
* DF-90-2: Telegram `message_id` không được persist — không có reconciliation seam.
* DF-90-3: Redis per-mailbox lock chưa wire vào production runner (multi-replica
  ownership phụ thuộc Phase 2).
* DF-90-4: worker không phân biệt retryable vs permanent Telegram failure.
* S4 ambiguous-ack duplicate window: tồn tại hôm nay, bounded, không thể loại bỏ với
  provider contract hiện tại — chỉ ghi nhận, không sửa ở Phase 1.
* ErrorQuotaExceeded (403): independent provider-side observation, không tìm thấy
  evidence liên quan trực tiếp — ngoài scope.

## O. Điểm Antigravity cần review đặc biệt (Phase 1 — đã được Architecture Review xử lý)

1. Soát độc lập trace S1/S2 (task file §4, §9) — verdict permanent loss.
2. Chấp nhận product-level trade-off at-least-once của Option A (duplicate cùng code
   cùng chat khi crash-window vs mất code).
3. Invariant stale re-check trong recovery path (bảo toàn TASK-080).
4. Option A vs Option D (migration hay không) + hình thức state tối thiểu.
5. Multi-replica ownership: lease mới vs Redis lock sẵn có (DF-90-3).
6. Có gộp DF-90-4 vào Phase 2 scope không. (Kết luận review: CÓ — đã implement.)

---

## P. PHASE 2 — IMPLEMENTATION SUMMARY (hiện hành; chi tiết: task file §20)

### P.1 Root bug fix

S1/S2 bị loại bỏ bằng Option A: early dedup **status-aware** (chỉ `SENT`/`FAILED`
terminal-skip; `DETECTED` là recovery candidate), delivery state tường minh trên
`ProcessedMessage` (lease + owner token + attempts + terminal FAILED), atomic
**delivery-ownership CAS** trước mọi send, release-lease khi fail retryable (BullMQ
retry gửi lại được thật), bounded lease-wait để stalled re-run của chính job crash
reclaim được row (S2). Permanent Telegram failure (DF-90-4) đi thẳng tới `FAILED`
terminal + worker return (không throw) — 0 BullMQ retry vô ích.

### P.2 State machine / claims / CAS

* Identity claim (INSERT unique — TASK-068A giữ nguyên) TÁCH khỏi delivery ownership
  claim (lease CAS); INSERT mới set ownership atomically (owner + lease 5 phút +
  attempts=1). Mọi completion write (SENT/FAILED/release) fence trên owner token —
  stale owner count=0, không ghi đè, không re-send.
* Store contract mới (`deduplication.service.ts` + `prisma-processed-message-store.ts`):
  `claimDelivery` / `releaseDelivery` / `markFailedByOwner` / `markFailedIfUnclaimed`
  / `markSent(ownerToken)` / `findById` — mỗi cái một `updateMany` điều kiện duy nhất.
* Constants leaf `services/email/delivery-ownership-policy.ts`:
  lease 5 phút (lớn hơn worst-case internal retry window, nhỏ hơn nhiều 30m; không
  tái dùng window TASK-080/Graph), max 3 delivery attempts (align BullMQ attempts),
  poll 5s. Không env.
* Multi-replica: correctness dựa hoàn toàn vào DB CAS (per-mailbox lock vẫn
  best-effort in-memory — DF-90-3 deferred).

### P.3 Retry budget tối đa (final)

3 delivery-ownership claims/row nhân tối đa 4 internal Telegram sends (TASK-033) =
**tối đa 12 Telegram HTTP calls** cho retryable failure; permanent = **1 call**;
mọi đường bị chặn thêm bởi stale 30m. Không tăng BullMQ attempts, không tăng internal
retry, không retry loop thứ ba.

### P.4 Stale guard & routing

Freshness re-check **ngay sau ownership acquisition** (sau lease wait, trước
mapping/send) bên cạnh guard cũ; stale ⇒ owner terminal hóa row, 0 Telegram call;
boundary 30m giữ nguyên. Mapping resolve lại từ DB tại attempt gửi; mapping mất ⇒
skip + release lease, không fallback chat id; customer isolation không đổi.
Historical `DETECTED` rows (pre-migration) không thể bị mass-redeliver — mọi lần
chạm đều qua stale guard (có test).

### P.5 Schema / migration

4 cột additive trên `ProcessedMessage` (`deliveryAttempts`, `deliveryLeaseUntil`,
`deliveryOwner`, `deliveryFailureReason`); migration
`20260901000000_task090_processed_message_delivery_state` (ALTER TABLE ADD COLUMN,
không destructive, không backfill secret, unique identity không đổi). **KHÔNG chạy
migration ở staging/production** — rollout sau này theo preflight TASK-088.

### P.6 Ambiguous remote side effect — guarantee trung thực

Durable local claim/ownership; recovery cho proven S1/S2; at-least-once-oriented
delivery recovery; **bounded duplicate risk** trong ambiguous window (send OK rồi
crash trước SENT; lost ack; hung send bị takeover). KHÔNG tuyên bố exactly-once
Telegram. DF-90-2 (message-id reconciliation) vẫn deferred.

### P.7 Observability

Pipeline là writer `FAILED` đầu tiên (permanent / budget cạn / stale recovery) với
`deliveryFailureReason` sanitized. Đã verify reader thật: health dashboard
(groupBy `FAILED`) và mailbox detail hoạt động không cần sửa ⇒ **không sửa
health.service.ts / web** (DF-90-1 tự sống lại). CodeEvent/AuditLog tái dùng status
sẵn có.

### P.8 Files changed & tests

Runtime: schema + migration mới; `delivery-ownership-policy.ts` (mới);
`deduplication.service.ts`; `prisma-processed-message-store.ts`;
`graph-message-pipeline.service.ts`; `email-processing.service.ts` (mock truyền
token); `telegram-sender.service.ts` + `telegram-retry.service.ts` (seam
`retryable`); `email-worker.ts` (comment). Tests mới: delivery-recovery pipeline
(16), delivery store + CAS shapes + bounded loop (10), retry classification DF-90-4
(6); cập nhật 2 test cũ giữ nguyên intent (contract fakes 068A; duplicate-precedence
seed SENT). Regression TASK-033/068A/080/089 toàn bộ green.

### P.9 Verification

`npm run verify` **PASS** — 108 test files / 1339 tests (trước: 105/1304).
`npx prisma validate` PASS. `git diff --check` sạch. Diff không chứa secret/full
code/tên nhánh/wording dễ false-positive secret scan. Không commit, không push,
không ROADMAP, không Railway.

### P.10 Điểm Antigravity Implementation Review cần soát đặc biệt

1. Tính đúng của CAS predicates (task file §20.5) — nhất là `claimDelivery` và hai
   biến thể markFailed; và việc mọi đường tới send đều đi qua CAS.
2. Bounded-ness của lease-wait loop (`acquireDeliveryOwnership`) và lập luận
   "recovery driver chain" khi trả `delivery_owned_elsewhere` (task file §20.2/§20.6).
3. Ordering stale re-check sau ownership (không còn cửa sổ gửi sau 30m).
4. Semantics `markSent` không token (legacy mock seam) có chấp nhận được không.
5. Trade-off bounded duplicate (§20.9) — wording không hứa quá evidence.
6. Migration additive + historical-row safety (§20.4).

### P.11 Timeout correction (sau Final Implementation Review)

Telegram HTTP send giờ có **explicit finite timeout + real cancellation**: reuse
helper TASK-080 `fetchWithTimeout` (AbortController — request thật sự bị hủy, promise
settle) với `TELEGRAM_HTTP_TIMEOUT_MS = 15s`; timeout classify `network` = RETRYABLE.
Upper-bound một delivery ownership (code-level): 4×15s HTTP + 3×60s retry_after cap +
17s pacing caps + overhead ms ≈ **257s < lease 300s, margin ≈43s (~14%)** — lease giữ
nguyên; inequality pin bằng test đọc constants thật
(`telegram-sender.timeout.test.ts`). 429/permanent-4xx/5xx semantics và retry budget
không đổi. Ambiguous remote-success window vẫn tồn tại (request có thể đã tới
Telegram trước abort) — vẫn không claim exactly-once Telegram. Chi tiết: task file
§20.16.

---

READY FOR ANTIGRAVITY TIMEOUT CORRECTION RE-REVIEW — NO COMMIT / NO PUSH
