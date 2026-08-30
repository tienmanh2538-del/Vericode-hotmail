# TASK-090 — Post-Claim Telegram Delivery Failure Recovery & Delivery State Safety

> **TRẠNG THÁI: PHASE 2 — IMPLEMENTED, CHỜ ANTIGRAVITY IMPLEMENTATION REVIEW.**
>
> Antigravity Architecture Review: **PASS — TASK-090 ARCHITECTURE APPROVED FOR PHASE 2
> IMPLEMENTATION**. Kiến trúc khóa: **OPTION A — CLAIM-BEFORE-SEND WITH EXPLICIT
> DELIVERY STATE & STATUS-AWARE DEDUP**. Implementation record đầy đủ ở **§20** (state
> machine, schema, CAS/lease semantics, taxonomy, retry budget, tests). `npm run verify`
> PASS — 108 test files / 1339 tests. Chưa commit/push; chưa update ROADMAP; không
> migration nào được chạy trên staging/production; không thao tác Railway.
>
> §1–§19 dưới đây là Phase 1 investigation (giữ nguyên làm evidence nền — mô tả HEAD
> TRƯỚC khi implement). Chỗ nào §20 mô tả hành vi mới thì §20 là hiện hành.
>
> Phase 1 note gốc: tài liệu Phase 1 không chứa implementation. Không gọi Microsoft
> Graph thật, không gửi Telegram thật ở mọi phase.
>
> **Nhãn bằng chứng dùng xuyên suốt:**
> * **REPO EVIDENCE** — đọc trực tiếp file trong repo tại HEAD hiện tại, kèm đường dẫn/dòng.
> * **PROVIDER CONTRACT** — hành vi đã biết của Telegram Bot API / BullMQ theo tài liệu
>   public; ghi rõ khi dùng.
> * **INFERENCE** — suy luận từ hai loại trên; ghi rõ là suy luận.
>
> **Quy ước an toàn:** không ghi token/secret/connection URL; không ghi verification code
> đầy đủ hoặc email body; không ghi nguyên tên nhánh Git đầy đủ (theo CLAUDE.md — chỉ nói
> "nhánh làm việc của task hiện tại").

---

## §1. Bối cảnh & phạm vi

TASK-089 ghi nhận deferred finding **DF-1**: *"claim-before-send prevents duplicate replay
for the same claimed message identity, with pre-existing at-most-once-after-claim failure
semantics"*. Đây là deferred risk, chưa từng được chứng minh đầy đủ trên HEAD hiện tại.

TASK-090 Phase 1 phải:

1. Trace lại toàn bộ delivery ordering thật tại HEAD (không dựa vào report cũ).
2. Chứng minh (hoặc bác bỏ) hypothesis: claim thành công → Telegram send fail/crash →
   BullMQ retry → early dedup terminal-skip → verification code không bao giờ được gửi.
3. Xác định duplicate-send window có tồn tại không.
4. So sánh architecture options cho recovery và đưa ra guarantee matrix trung thực.

Out of scope: xem **§17**.

## §2. Precheck

* Branch: đúng nhánh làm việc của TASK-090.
* `git status --short`: sạch (không tracked/untracked change bất ngờ).
* `git diff --stat`: rỗng.
* HEAD: `c9592f0` — "docs: close task 089 staging validation" (trạng thái hoàn tất mới
  nhất của TASK-089). **PASS.**

## §3. Nguồn đã đọc

Docs: `CLAUDE.md`, `AGENTS.md`, `ANTIGRAVITY.md`, `docs/PRODUCT_SPEC.md`,
`docs/ARCHITECTURE.md`, `docs/SECURITY_RULES.md`, `docs/ROADMAP.md`; task/report liên
quan: TASK-033, TASK-055, TASK-068A, TASK-068B, TASK-073, TASK-080, TASK-089 (đặc biệt
DF-1 và §8/§19 của TASK-089).

Code (trace trực tiếp tại HEAD):

* `prisma/schema.prisma` (model `ProcessedMessage`, enum `ProcessedMessageStatus`)
* `services/email/graph-message-pipeline.service.ts` (pipeline chính)
* `services/email/deduplication.service.ts`, `services/email/prisma-processed-message-store.ts`
* `services/email/relay-freshness-policy.ts` (TASK-080/089)
* `services/queue/workers/email-worker.ts`, `services/queue/workers/email-worker-runner.ts`
* `services/queue/email-job-options.ts`, `services/queue/email-queue.ts`,
  `services/queue/email-job.types.ts`, `services/queue/delta-polling-queue.ts`
* `services/queue/mailbox-lock-factory.ts`, `services/queue/mailbox-processing-lock.ts`,
  `services/queue/destination-throttle.ts`, global send throttle (TASK-068B/070)
* `services/telegram/telegram-sender.service.ts`, `telegram-retry.service.ts`,
  `telegram-error.ts`
* `app/api/webhooks/microsoft/mail/route.ts` (TASK-073),
  `services/microsoft/delta-polling.service.ts` (enqueue phía delta)
* `services/health/health.service.ts` (reader của ProcessedMessage)
* `services/microsoft/mailbox-detail.service.ts` (reader UI)

## §4. Exact delivery ordering tại HEAD (REPO EVIDENCE)

Ordering dưới đây được đọc từ implementation thật, không suy đoán từ tên function.

### §4.1 Enqueue

| Bước | File / function | Ghi chú |
|---|---|---|
| Webhook nhận notification | `app/api/webhooks/microsoft/mail/route.ts` (`handleWebhookRequest`) | clientState validate trước, sau đó enqueue từng notification |
| Webhook enqueue | `services/queue/email-queue.ts` — `enqueueMicrosoftGraphMessageJob` (dòng ~88) | TASK-073: nếu bất kỳ notification nào enqueue fail → trả 503 để Microsoft redeliver cả batch (route.ts dòng ~137–157) |
| Webhook jobId | `services/queue/email-job-options.ts` — `buildEmailJobId` | `microsoft-webhook:{mailboxId}:{graphMessageId}` — deterministic |
| Delta enqueue | `services/microsoft/delta-polling.service.ts` — `traverseDeltaPages` (dòng ~540–556) qua `services/queue/delta-polling-queue.ts` | enqueue fail từng item chỉ log + bỏ qua; cursor chưa advance nên poll sau thấy lại |
| Delta jobId | `email-job-options.ts` — `buildDeltaPollingJobId` | `delta-polling:{mailboxId}:{graphMessageId}` — **prefix KHÁC webhook**, nên cùng một message có thể có 2 queue entry (comment trong code xác nhận là chủ ý; dedup nội dung nằm ở pipeline) |
| Job options | `email-job-options.ts` dòng 14–15, ~110 | `attempts: 3`, backoff exponential base 5s, removeOnComplete 24h/1000, removeOnFail 7d/5000 — giống nhau cho cả 2 nguồn |

### §4.2 Worker attempt

| Bước | File / function / dòng | Hành vi |
|---|---|---|
| 1. Worker nhận job | `services/queue/workers/email-worker.ts` — `processEmailWebhookJob` (~148) | Chuẩn hóa payload (`toPipelineJob`), gọi pipeline |
| 2. Per-mailbox lock | `graph-message-pipeline.service.ts` dòng 481–511; wiring `email-worker-runner.ts` (~60) | **In-memory lock trong production hiện tại** (`createMailboxProcessingLock()` không có Redis client — `mailbox-lock-factory.ts` xác nhận policy). Busy → `DEFERRED_MAILBOX_BUSY` (retryable) sau bounded fairness retry (max 2 lần / 1s) |
| 3. Mailbox load + ACTIVE check | pipeline dòng 536–578 | Không ACTIVE → `SKIPPED_MAILBOX_NOT_ACTIVE` (terminal) |
| 4. Access token | pipeline dòng 581–632 | TASK-069C classification: transient → `FAILED_TOKEN_TRANSIENT` (retryable); dead grant → `FAILED_RECONNECT_REQUIRED` |
| 5. Graph message fetch | pipeline dòng 634–675 | 401 auth → reconnect; khác → `FAILED_GRAPH_FETCH` (retryable) |
| 6. **Early dedup theo message identity** | pipeline dòng 697–757 → `store.findByGraphMessageId` / `findByInternetMessageId` | **KHÔNG lọc theo `status`** (xem §5.4). Có row bất kỳ → `SKIPPED_DUPLICATE` (terminal) |
| 7. Stale guard TASK-080 | pipeline dòng 759–805; threshold `relay-freshness-policy.ts` = 30 phút | Đo theo `receivedDateTime` của Graph, mỗi attempt đo lại với `now()` → quá 30m → `SKIPPED_STALE` (terminal) |
| 8. Detector | pipeline dòng 807–884 | Fail → skip terminal |
| 9. Extractor | pipeline dòng 886–947 | Fail → skip terminal |
| 10. **ProcessedMessage claim (INSERT)** | pipeline dòng 952–1025 → `claimMessageForProcessing` (`deduplication.service.ts` 304–382) → `store.create` | INSERT row `status = DETECTED`. P2002 (unique) → duplicate skip sạch (TASK-068A) |
| 11. Telegram mapping lookup | pipeline dòng 1029–1067 | Không có mapping → `SKIPPED_NO_TELEGRAM_MAPPING` (terminal) — **row đã claim vẫn nằm ở DETECTED** |
| 12. Destination throttle + global pacer | pipeline dòng 1083–1123 (TASK-055/068B/070) | Delay in-line bounded, không ảnh hưởng claim |
| 13. **Telegram send (kèm internal retry TASK-033)** | pipeline dòng 1125–1162 → `createRetryingTelegramSendPort` (`telegram-retry.service.ts`) | Chi tiết §7. Exhausted/permanent → port throw `TelegramSendError` → pipeline ghi CodeEvent `TELEGRAM_SEND_FAILED` → trả `FAILED_TELEGRAM_SEND` |
| 14. markSent | pipeline dòng 1164–1172 → `store.markSent` → `status = SENT`, `sentToTelegramAt` | Fail được **nuốt** (log warn) — "Failures here MUST NOT undo Telegram delivery" |
| 15. CodeEvent `CODE_SENT` + AuditLog | pipeline dòng 1174–1204; port `createDbAuditPort` trong runner | **Fire-and-forget** (`void ...catch`) — không await, không chặn |
| 16. Worker classification | `email-worker.ts` dòng ~198–214 | `FAILED_GRAPH_FETCH` / `FAILED_RECONNECT_REQUIRED` / `FAILED_TOKEN_TRANSIENT` / `FAILED_TELEGRAM_SEND` / `FAILED_UNEXPECTED` / `DEFERRED_MAILBOX_BUSY` → **throw** → BullMQ retry theo `attempts: 3`. Mọi `SKIPPED_*` và `CODE_SENT` → return → job complete (terminal) |

## §5. ProcessedMessage — model thật tại HEAD (REPO EVIDENCE)

### §5.1 Trả lời các câu hỏi bắt buộc

1. **Row được INSERT lúc nào?** Duy nhất tại Step 10 (`claimMessageForProcessing` →
   `store.create`, pipeline dòng 952–964) — tức **sau** detector+extractor pass, **trước**
   mapping lookup, throttle, và Telegram send. (Mock flow `email-processing.service.ts`
   dùng cùng service, cùng ordering claim-trước-send.)
2. **INSERT trước hay sau Telegram side effect?** **TRƯỚC.** Claim-before-send.
3. **Unique constraint thực tế:** `@@unique([mailboxId, graphMessageId])`
   (`prisma/schema.prisma`, model ProcessedMessage). P2002 được store map thành
   `ProcessedMessageDuplicateError` (`prisma-processed-message-store.ts` dòng ~118–128).
   Không có unique trên internetMessageId hay codeHash.
4. **Field/state delivery hiện có:** `status` (enum `DETECTED | SENT | FAILED |
   SKIPPED_LOW_CONFIDENCE | DUPLICATE`), `sentToTelegramAt DateTime?`, `codeHash`,
   `subjectHash`, `receivedAt`, `senderEmail`, `internetMessageId`, `createdAt`.
5. **KHÔNG có:** `claimed/pending/delivering` state riêng, retry count, lease/owner,
   attempt timestamp, Telegram message id, lastError. Schema không có cột
   `receivedAtBucket` (store trả `null`, dedup bucket dùng range query trên `receivedAt`).

### §5.2 Writers (toàn repo)

* `store.create` — chỉ từ `claimMessageForProcessing` (pipeline Graph + mock flow).
  Luôn INSERT với `status` default `DETECTED`.
* `store.markSent` — chỉ từ `markMessageAsSent` (pipeline Step 14 + mock flow). Ghi
  `status = SENT`, `sentToTelegramAt`.
* **Không có writer nào ghi `FAILED`, `DUPLICATE`, `SKIPPED_LOW_CONFIDENCE`.** Ba giá
  trị enum này hiện là dead value ở đường ghi. Đặc biệt: health dashboard
  (`services/health/health.service.ts` dòng ~669–678) groupBy `status: 'FAILED'` để đếm
  "Telegram failure recent" — **metric này hiện không bao giờ khác 0** vì không ai ghi
  FAILED. (Phát hiện phụ, củng cố nhu cầu delivery state ở §11.)
* **Không có delete/cleanup path nào** cho ProcessedMessage trong repo.

### §5.3 Readers

* Early dedup + claim check: `checkProcessedMessageDuplicate`
  (`deduplication.service.ts` 246–302) qua 3 lookup: graphMessageId, internetMessageId,
  codeHash+bucket.
* Health dashboard: `health.service.ts` (~660–685) — groupBy SENT / FAILED / max createdAt.
* Mailbox detail UI: `mailbox-detail.service.ts` (~211–220) — list recent, đọc `status`.

### §5.4 Điểm mấu chốt: early dedup không phân biệt trạng thái delivery

`findByGraphMessageId` là `findUnique` trên `(mailboxId, graphMessageId)` **không có
điều kiện status** (`prisma-processed-message-store.ts` dòng ~82–90); tương tự
`findByInternetMessageId`, `findByCodeBucket`. Nghĩa là: một row `DETECTED` với
`sentToTelegramAt = null` (đã claim nhưng **chưa từng gửi thành công**) chặn mọi lần
xử lý lại y hệt như một row `SENT`. Đây là cơ chế trực tiếp tạo ra at-most-once-after-claim.

### §5.5 Cách P2002 claim race được xử lý

`claimMessageForProcessing` (deduplication.service.ts 349–373): check-then-insert; nếu
insert trúng P2002 (thua race với flow song song) → re-check → trả duplicate skip sạch,
**không bao giờ re-throw duplicate** → worker không retry. TASK-068A đúng như tài liệu:
đây là exactly-once **DB claim**, không phải exactly-once delivery.

## §6. Phân biệt các lớp retry / dedup (bắt buộc theo đề bài)

| Lớp | Phạm vi bảo vệ | Thời gian tồn tại | Lỗi kích hoạt | Cross-process safe? | Bảo vệ external Telegram side effect? | Có thể gây LOSS? | Có thể gây DUPLICATE? |
|---|---|---|---|---|---|---|---|
| **A. BullMQ jobId dedup** (deterministic jobId) | Chặn add trùng job **cùng prefix nguồn** (webhook vs delta là 2 jobId khác nhau) | Đến khi job bị remove (complete 24h/1000, fail 7d/5000) | Không phải lỗi — dedup khi add | Có (Redis) | Không | Không trực tiếp | Không |
| **B. Microsoft webhook retry** (TASK-073: 503 khi enqueue fail) | Chống mất notification ở biên enqueue | Theo policy redelivery của Microsoft | Enqueue failure | Có | Không | Giảm loss ở biên enqueue | Không (nhờ lớp A + E) |
| **C. Delta replay** (TASK-031/089) | Backup discovery; replay an toàn nhờ các lớp dưới | Mỗi chu kỳ poll / recovery 410 | Webhook miss, 410 recovery | Có | Không | Giảm loss ở discovery | Không (nhờ D/E) |
| **D. Early Graph-message identity dedup** (pipeline Step 6) | Chặn xử lý lại message identity đã có row | Vĩnh viễn (row không bao giờ xóa) | Không phải lỗi — check đầu attempt | Có (đọc DB) — nhưng **best-effort TOCTOU** (check-then-act, không atomic) | **Không phân biệt đã gửi hay chưa** | **CÓ — đây là nguồn loss chính (S1/S2)** | Không |
| **E. ProcessedMessage DB unique claim** (Step 10, TASK-068A) | Chính xác một flow thắng claim cho một identity | Vĩnh viễn | P2002 khi thua race | **Có — lớp authoritative duy nhất** | Gián tiếp (chặn flow thứ hai đi tới send) | Có (khi winner fail sau claim — cùng cơ chế với D) | Không |
| **F. Telegram internal retry (TASK-033)** | Retry HTTP send trong MỘT worker attempt | ≤ 4 lần gửi, backoff 5/15/30s (+retry_after cap 60s) | 429/5xx/network | N/A (in-process) | **Không** — network-ambiguous sẽ re-send (S4) | Không | **CÓ (S4: lost-ack + retry thành công = 2 message)** |
| **G. BullMQ worker attempts** (`attempts: 3`, exp 5s) | Retry toàn job khi worker throw | Tối đa 3 attempt/job; stalled-job requeue khi crash | Mọi `FAILED_*`, `DEFERRED_MAILBOX_BUSY` | Có | Không | **Retry bị lớp D vô hiệu sau claim** (xem S1) | Không trực tiếp |
| **H. Per-mailbox lock (TASK-055/068A)** | Serialize pipeline cùng mailbox | TTL lease trong 1 process | Busy → defer | **KHÔNG trong wiring hiện tại** — in-memory (Redis lock có sẵn nhưng chưa inject, `email-worker-runner.ts` ~60 + `mailbox-lock-factory.ts`) | Không | Không | Không (chỉ giảm burst; correctness thuộc lớp E) |
| **I. Destination throttle + global pacer (TASK-055/068B/070)** | Giãn nhịp gửi (per-chat, per-bot) | In-line delay bounded | Không phải lỗi | Global pacer: có khi Redis; destination throttle: in-memory | Không | Không | Không |

**Kết luận lớp:** không lớp nào ở trên là "exactly-once delivery". Lớp E là exactly-once
**claim**; lớp D biến claim thành at-most-once **delivery**; lớp F là at-least-once
**HTTP send trong một attempt** (có thể duplicate khi ack mất).

## §7. TASK-033 — Telegram internal retry vs BullMQ retry (REPO EVIDENCE)

* Internal retry nằm **hoàn toàn bên trong một worker attempt**:
  `sendTelegramMessageWithRetry` (`telegram-retry.service.ts` ~90–160). 1 lần đầu + 3
  retry = **tối đa 4 HTTP send / worker attempt**; backoff 5s/15s/30s; 429 `retry_after`
  được honor nhưng cap 60s.
* Retryable: `network` (gồm cả timeout — fetch trong `telegram-sender.service.ts` không
  đặt timeout riêng, mọi lỗi fetch → `network`), HTTP 429 và mọi 5xx. Non-retryable:
  mọi 4xx khác, `validation`, `config` (`telegram-error.ts`).
* Sau khi exhausted hoặc gặp permanent error: adapter `createRetryingTelegramSendPort`
  phát **CRITICAL admin alert** `TELEGRAM_SEND_FAILED` (TASK-035, guarded) rồi **throw
  `TelegramSendError('telegram_api', ...)`**.
* Pipeline bắt lỗi đó → ghi CodeEvent `TELEGRAM_SEND_FAILED` → trả
  `FAILED_TELEGRAM_SEND`; worker throw `EmailWorkerProcessingError` → **BullMQ bắt đầu
  retry toàn job** (attempt kế tiếp sau exponential backoff).
* **Phân biệt rõ:** internal retry gửi lại *chỉ HTTP call*, trong cùng attempt, sau khi
  claim đã tồn tại; BullMQ retry chạy lại *toàn pipeline từ Step 1*, và vì vậy đập vào
  early dedup (Step 6) trước khi tới được send.

## §8. TASK-068A — guarantee thực tế (phân loại trung thực)

| Guarantee | Trạng thái tại HEAD | Bằng chứng |
|---|---|---|
| Exactly-once **DB claim** cho một `(mailboxId, graphMessageId)` | **PROVEN** | Unique constraint + P2002 → clean skip (§5.5) |
| Duplicate **processing** prevention (2 flow không cùng gửi 1 identity) | **PROVEN** (qua claim) — với ngoại lệ S4 | §6 lớp E |
| At-most-once-after-claim (sau claim, không bao giờ gửi lại identity đó) | **PROVEN — và chính nó là nguồn loss** | §9 S1/S2 |
| At-least-once queue delivery | **PROVEN theo PROVIDER CONTRACT** (BullMQ attempts + stalled-job requeue) | §6 lớp G |
| At-least-once external Telegram side effect | **KHÔNG CÓ** — fail sau claim là mất luôn | S1/S2 |
| Exactly-once external Telegram side effect | **IMPOSSIBLE TO PROVE với provider contract hiện tại** — Telegram Bot API `sendMessage` không có idempotency key / provider-side dedup; pipeline còn **vứt bỏ `message_id`** Telegram trả về (dòng 1126 không capture kết quả) nên không có reconciliation seam nội bộ | §9 S4; PROVIDER CONTRACT |

**Ambiguous commit window (bắt buộc nêu):** crash (hoặc mất ack) sau khi Telegram đã
nhận request nhưng trước khi local ghi nhận durable là một **ambiguous commit window**.
Với Telegram Bot API hiện tại (không idempotency key, không query-by-client-token),
không kiến trúc nào trong repo có thể *chứng minh* "zero duplicate + zero loss" đồng
thời. Mọi option ở §11 chỉ chọn phía nào của trade-off và bound cửa sổ còn lại.

## §9. Fault-injection scenarios (trace code-level)

### S1 — Claim OK → Telegram retryable failure → internal retry exhausted

1. Attempt #1: claim INSERT row `DETECTED` (Step 10) → send fail 429/5xx/network ×4
   (internal retry) → CRITICAL alert → `FAILED_TELEGRAM_SEND` → worker **throw** →
   BullMQ ghi attempt fail, schedule attempt #2 (backoff ~5s).
2. Attempt #2: pipeline chạy lại từ đầu → Step 6 `findByGraphMessageId` **tìm thấy row
   DETECTED của attempt #1** → trả `SKIPPED_DUPLICATE` → worker **return** (không
   throw) → **job COMPLETE terminal**. Attempt #3 không bao giờ chạy.
3. Kết quả: code **không bao giờ được gửi**; row ở `DETECTED` vĩnh viễn; CodeEvent chuỗi
   `TELEGRAM_SEND_FAILED` → `CODE_SKIPPED_DUPLICATE`; tín hiệu duy nhất cho người vận
   hành là CRITICAL alert (TASK-035).
4. **Verdict: PERMANENT LOSS — CONFIRMED (REPO EVIDENCE).** Budget `attempts: 3` thực
   tế chỉ cho **đúng 1 cửa sổ recovery sau claim, và cửa sổ đó luôn bị dedup nuốt**.

### S2 — Claim OK → process crash NGAY TRƯỚC lần send đầu tiên

* Job đang active khi crash → BullMQ stalled-job detection requeue (PROVIDER CONTRACT)
  → retry có chạy sau restart.
* Retry đập Step 6 → `SKIPPED_DUPLICATE` → terminal. **PERMANENT LOSS — CONFIRMED.**
* Tệ hơn S1: crash xảy ra trước cả internal retry/alert → **không có CRITICAL alert**,
  chỉ có row DETECTED im lặng. Loss window = từ khi `store.create` commit đến khi
  `sendMessage` thành công.

### S3 — Telegram send THÀNH CÔNG → crash trước markSent / CodeEvent / Audit

* Khách hàng **đã nhận code** (side effect ngoài đã xong).
* Local: row vẫn `DETECTED`, `sentToTelegramAt = null`; CodeEvent `CODE_SENT` có thể
  chưa kịp ghi (fire-and-forget §4.2 Step 15).
* Retry sau restart → Step 6 → `SKIPPED_DUPLICATE` → **không double-send** (early dedup
  ở đây lại là lớp bảo vệ đúng).
* Trạng thái hệ thống: **"sent remotely but unknown locally"** — local không thể phân
  biệt S3 với S2 (cả hai đều là row DETECTED chưa có sentToTelegramAt). Đây là điểm
  then chốt cho §11: mọi cơ chế auto-retry theo "DETECTED chưa sent" **sẽ re-send S3**
  (duplicate) để cứu S2 (loss). Không có Telegram message id được lưu nên không
  reconcile được.

### S4 — HTTP request đã rời process nhưng response timeout / network disconnect

* `fetch` throw → `TelegramSendError('network')` → **retryable** → internal retry gửi
  lại **ngay trong cùng attempt, dưới cùng một claim**.
* Hai nhánh không phân biệt được: (a) request chưa tới Telegram → retry đúng; (b)
  Telegram đã nhận nhưng ack mất → retry tạo **message thứ hai trong cùng group**.
* **Verdict: duplicate-send window TỒN TẠI NGAY HÔM NAY** (không cần crash), là
  ambiguous external-side-effect window cố hữu của provider contract. Mitigation duy
  nhất là bound số retry (đã bound = 4) — không thể loại bỏ.

### S5 — Webhook job + delta job cùng graphMessageId chạy concurrent

* Lớp A không giúp (2 jobId khác prefix — chủ ý, comment trong `email-job-options.ts`).
* Lớp H (per-mailbox lock) chỉ serialize **trong một process** (in-memory); với nhiều
  worker replica thì không (Redis lock có code nhưng chưa wire — §6 H).
* Lớp D (early dedup) là TOCTOU best-effort: cả hai có thể cùng pass Step 6.
* **Lớp E (unique claim) là lớp quyết định:** đúng một job thắng INSERT; job thua nhận
  P2002 → duplicate skip sạch → không gửi. **Concurrency-safe cho duplicate: PROVEN.**
* Nuance: nếu job thắng sau đó fail như S1 thì job thua đã skip trước rồi → không ai
  còn cơ hội gửi (vẫn quy về S1).

### S6 — Telegram non-retryable failure (400/401/403/404...)

* Internal retry không retry (đúng); port throw ngay; pipeline trả
  `FAILED_TELEGRAM_SEND` — **worker không phân biệt retryable/permanent** (chỉ có một
  status) → vẫn throw → BullMQ vẫn tốn 1 attempt retry vô ích → attempt #2 dedup-skip
  terminal (như S1).
* CodeEvent `TELEGRAM_SEND_FAILED` + CRITICAL alert có; ProcessedMessage **không** ghi
  FAILED (không ai ghi — §5.2), health metric FAILED vẫn 0.
* Architecture mới: permanent 4xx (chat không tồn tại, bot bị kick, mapping hỏng) nên
  đi tới **terminal failure state rõ ràng** chứ không auto-recovery — vì retry không
  sửa được config, và tới khi người vận hành sửa xong thì code gần như chắc chắn quá
  stale threshold 30m (không được gửi muộn — §14).

### S7 — Message quá stale threshold trong lúc delivery/retry recovery

* Stale guard hiện tại (Step 7) chạy **trước claim**, đo lại mỗi attempt bằng `now()`
  so với Graph `receivedDateTime` → mọi retry pre-claim tự động bị chặn khi quá 30m.
  **Chính sách TASK-080 đang giữ đúng cho mọi đường retry hiện có.**
* **Invariant cho kiến trúc mới:** mọi recovery path **sau claim** (Option A/C/D §11)
  nằm *hạ nguồn* của stale guard hiện tại, nên **bắt buộc phải tự re-check freshness
  ngay trước mỗi lần re-send**; hết hạn → chuyển terminal (không gửi muộn), dùng chung
  leaf policy `relay-freshness-policy.ts`. 30m cũng chính là natural upper bound cho
  mọi retry budget sau claim.

## §10. Root cause & severity

**A. Permanent message-loss window có tồn tại không?** **CÓ — CONFIRMED (S1, S2).**

**B. Điều kiện chính xác:**

* Boundary: từ thời điểm `store.create` (claim) commit đến thời điểm `sendMessage`
  được Telegram ack thành công.
* Trigger: (i) Telegram retryable failure kéo dài hơn ~50s nội bộ (4 lần gửi) — ví dụ
  outage/flood-limit dài; (ii) permanent 4xx (mapping/bot hỏng); (iii) crash/restart
  đúng cửa sổ; (iv) deploy/scale-down đúng cửa sổ.
* Retry path bị vô hiệu: BullMQ retry chạy lại pipeline từ đầu → early dedup Step 6
  (không lọc status) terminal-skip → không attempt nào chạm lại được bước send.
* Vì sao không có recovery: không có state phân biệt "claimed-chưa-gửi" với "đã gửi";
  không sweeper/reaper; row không bao giờ xóa; jobId dedup không liên quan.
* Severity: **HIGH** — sản phẩm tồn tại để relay verification code (thời hạn sống tính
  bằng phút); mất im lặng một code là mất chức năng chính với khách hàng đó.
* Blast radius: per-message (không lan mailbox khác); nhưng một Telegram outage vài
  phút có thể nuốt **mọi** code phát sinh trong outage đó trên mọi mailbox (mỗi cái
  đúng 1 lần thử ~50s rồi terminal). Có CRITICAL alert cho nhánh S1/S6, **không** cho S2.

**C. Duplicate-send crash window có tồn tại không?** **CÓ nhưng hẹp — S4 (lost ack +
internal retry), tồn tại sẵn hôm nay, bounded ≤ 4 message/attempt trong lý thuyết
(thực tế 2).** Crash-path (S3) hiện KHÔNG gây duplicate nhờ chính early dedup.

**D. Trade-off hiện tại (mô tả chính xác):** claim-before-send + status-blind early
dedup đổi **khả năng recovery sau claim** lấy **chống duplicate replay**. Cụ thể: nó
chặn duplicate ở S3/S5 (đúng), và bằng đúng cơ chế đó chặn luôn recovery ở S1/S2 (loss).
Không phải "dedup có thể gây lỗi" chung chung — mà là: *một lần INSERT DETECTED duy nhất
tiêu thụ vĩnh viễn quyền gửi của message identity đó, bất kể send có xảy ra hay không.*

## §11. Architecture options

### OPTION A — Giữ claim-before-send, thêm explicit delivery state + bounded redelivery

Ý tưởng: ProcessedMessage (hoặc bảng phụ) phân biệt tối thiểu *"claimed, delivery chưa
kết thúc"* vs *"SENT"* vs *"failed terminal"*. Early dedup trở thành **status-aware**:

* Row ở trạng thái delivery-chưa-kết-thúc + cùng job identity → **không terminal-skip**
  mà đi tiếp tới bước send (re-claim delivery ownership), dưới stale re-check (§9 S7).
* Row SENT / terminal-failed / các skip khác → dedup như hiện tại.
* Retry driver: tái dùng **BullMQ attempts hiện có** (không hệ retry mới); attempt cuối
  (`job.attemptsMade` đã sẵn có trong worker) hoặc permanent 4xx → ghi terminal state
  (FAILED-terminal) để dashboard thấy (§5.2 — làm sống lại metric FAILED đang chết).
* Ownership giữa replicas: cần lease/attempt-token (hoặc chấp nhận per-mailbox lock
  Redis đã có code sẵn) — điều tra Phase 2; các dạng state CLAIMED/DELIVERING/SENT/
  FAILED_RETRYABLE/FAILED_TERMINAL là **ứng viên**, không mặc định phải đủ bộ.

Trade-off cốt lõi (bắt buộc nói thẳng): Option A chuyển semantics sau claim từ
at-most-once sang **at-least-once** → S3 (sent-nhưng-crash-trước-bookkeeping) và một
phần S4 trở thành **duplicate có thể xảy ra khi crash đúng cửa sổ**. Duplicate ở đây là
*cùng code, cùng chat đúng của khách* (mapping resolve lại theo DB, isolation giữ
nguyên) — phiền nhiễu thấp; so với mất code (loss) là lỗi chức năng chính. Cửa sổ
duplicate bound được (chỉ crash-window, không phải mỗi retry) nếu ghi mốc
"delivery-started" trước send và chỉ tự-retry khi outcome chứng minh là fail (throw
đã bắt được) — còn crash-ambiguous thì theo policy chọn resend-once (khuyến nghị) hoặc
terminal.

### OPTION B — Move claim AFTER Telegram send

* Send trước, claim sau → crash giữa hai bước = **replay gửi lại không giới hạn lớp
  DB** (chỉ còn jobId dedup tạm thời + best-effort early check TOCTOU).
* Phá luôn chỗ dựa của TASK-073 (webhook 503 redeliver an toàn nhờ claim) và TASK-068A
  (webhook vs delta concurrent: cả hai có thể cùng send trước khi ai đó claim — lớp E
  mất vai trò gate-before-side-effect).
* **Loại.** Đổi loss lấy duplicate không-bound và làm yếu các bảo đảm đã có.

### OPTION C — Outbox / delivery-attempt state machine (bảng riêng)

* Tách: (1) durable detection/claim (ProcessedMessage như nay); (2) delivery item
  (outbox row: trạng thái, attempt count, lease, next-retry-at, terminal reason);
  (3) delivery worker/driver riêng quét outbox.
* Mạnh nhất về observability + multi-replica ownership + retry budget độc lập với
  BullMQ; đúng "textbook".
* Chi phí: bảng mới + migration + một worker/scheduler mới + hai nguồn truth phải giữ
  nhất quán (ProcessedMessage.status vs outbox state) — blast radius lớn nhất; các
  guarantee **không tốt hơn Option A về mặt lý thuyết** (vẫn at-least-once, vẫn S4
  ambiguous) vì giới hạn nằm ở provider contract, không nằm ở số bảng.

### OPTION D — Minimal seam: tái dùng field sẵn có, không đổi schema

* HEAD đã có đủ tín hiệu thô: `status = DETECTED` + `sentToTelegramAt = null` = "claim
  rồi nhưng chưa từng ghi nhận gửi". Early dedup có thể coi tổ hợp này (khi cùng
  identity với job đang xử lý) là re-processable → không cần cột mới.
* Nhược điểm nghiêm trọng: `DETECTED + null` hiện **nhập nhằng** — nó cũng là trạng
  thái terminal hợp lệ của `SKIPPED_NO_TELEGRAM_MAPPING` (claim xảy ra trước mapping
  lookup, §4.2 Step 11). Re-process nhóm này: vô hại khi mapping vẫn thiếu (skip lại),
  nhưng nếu mapping vừa được thêm trong <30m thì một code cũ bỗng được gửi — thay đổi
  hành vi ngầm. Không có chỗ ghi retry count/terminal → "no infinite retry" chỉ còn dựa
  vào BullMQ attempts + stale 30m. Không làm sống được metric FAILED.
* Kết luận: chấp nhận được như **fallback không-migration**, nhưng kém rõ ràng và kém
  audit hơn Option A; nếu Antigravity từ chối schema change thì đây là đường lui.

### Guarantee matrix

Ký hiệu: ✅ prevents / ⚠ bounded-may-happen / ❌ không bảo vệ / ❓ ambiguous (provider).

| Tiêu chí | HIỆN TẠI | A (delivery state) | B (claim-after-send) | C (outbox) | D (minimal seam) |
|---|---|---|---|---|---|
| Concurrent webhook+delta duplicate | ✅ (claim) | ✅ | ❌ | ✅ | ✅ |
| Claim OK → pre-send crash (S2) | ❌ **loss** | ✅ recover | ✅ (chưa claim) | ✅ recover | ✅ recover |
| Retryable Telegram failure (S1) | ❌ **loss** | ✅ bounded retry | ✅ | ✅ | ✅ (bounded bởi attempts) |
| Telegram OK → pre-DB-update crash (S3) | ✅ no-dup (nhưng bookkeeping sai) | ⚠ may duplicate (crash window) | ❌ duplicate | ⚠ may duplicate | ⚠ may duplicate |
| Lost HTTP ack (S4) | ⚠ duplicate (đã tồn tại) | ⚠ như hiện tại | ⚠ tệ hơn | ⚠ như hiện tại | ⚠ như hiện tại |
| Process restart / BullMQ retry | ❌ dedup nuốt | ✅ | ⚠ | ✅ | ✅ |
| Multiple worker replicas | ✅ cho claim (lock chưa cross-process) | ⚠ cần lease/Redis lock | ❌ | ✅ (lease built-in) | ⚠ yếu nhất |
| Stale code không gửi muộn | ✅ (pre-claim guard) | ✅ nếu re-check trước re-send (bắt buộc) | ✅ | ✅ nếu re-check | ✅ nếu re-check |
| Permanent Telegram 4xx | ⚠ 1 retry vô ích rồi im lặng | ✅ terminal state rõ | ⚠ | ✅ terminal rõ | ⚠ không có terminal state |
| Bounded retry / no infinite | ✅ (nhưng vô dụng) | ✅ (attempts + stale 30m) | ⚠ | ✅ (budget riêng) | ✅ (attempts + stale) |
| Observability delivery state | ❌ (FAILED metric chết) | ✅ | ❌ | ✅✅ | ❌ |
| Schema/migration | — | **Likely required (Phase 2)** | Không | **Required (bảng mới)** | Không |
| Complexity / blast radius | — | Vừa (store + dedup + worker classification) | Thấp code/cao rủi ro | Cao | Thấp nhất |
| Exactly-once external side effect provable? | ❌ | ❌ (**IMPOSSIBLE với provider contract**) | ❌ | ❌ | ❌ |
| Manual recovery cần thiết? | Có (và không có tool) | Chỉ cho terminal-failed | Có | Chỉ cho terminal-failed | Một phần |

## §12. Recommendation (Phase 1)

**Đề xuất: OPTION A** — giữ claim-before-send, thêm explicit delivery state +
status-aware early dedup + redelivery driver tái dùng BullMQ attempts, với ba invariant
bắt buộc:

1. **Stale re-check trước mỗi re-send sau claim** (dùng chung
   `relay-freshness-policy.ts`); quá 30m → terminal, không gửi muộn (§9 S7, §14).
2. **Terminal state rõ ràng** khi: permanent 4xx, retry budget cạn, hoặc stale-out —
   ghi vào ProcessedMessage để health dashboard (seam FAILED có sẵn) hiển thị thay vì
   im lặng.
3. **Chấp nhận và ghi thành văn** trade-off at-least-once: crash-window duplicate
   (S3-dưới-Option-A, S4) là **có thể xảy ra và không thể loại bỏ** với Telegram Bot
   API hiện tại; đổi lại loại bỏ permanent-loss window S1/S2 đã chứng minh.

Lý do chọn A trên C: cùng trần guarantee (provider-bound), C thêm bảng + worker +
nguồn-truth kép cho một hệ đang một-message-một-lần-gửi; A đủ chữa đúng root cause với
blast radius nhỏ hơn hẳn. B bị loại (§11). D là fallback nếu schema change bị từ chối.

Evidence được đánh giá là **đủ mạnh** cho verdict loss/duplicate (§9, §10 — thuần REPO
EVIDENCE). Các **open question** còn lại cho Phase 2 / Antigravity: (i) hình thức state
tối thiểu (tái dùng enum sẵn `FAILED` + mốc thời gian, hay thêm giá trị/cột mới); (ii)
ownership giữa replicas (lease cột mới vs wire Redis mailbox lock có sẵn); (iii) policy
cho crash-ambiguous rows (resend-once trong 30m vs terminal-with-alert).

## §13. Schema / migration verdict

**Schema/migration likely required in Phase 2, subject to Antigravity Architecture
Review PASS.** (Option A nhiều khả năng cần bổ sung trạng thái/mốc delivery trên
ProcessedMessage; Option D là đường không-migration nếu review yêu cầu.) Phase 1 không
viết schema, không tạo migration SQL, không chạy migrate. Nếu Phase 2 có migration:
rollout phải theo quy trình migration safety/preflight của TASK-088 trước promotion.

## §14. Stale guard & security invariants (kiến trúc đề xuất phải giữ)

* TASK-080: không relay message quá 30 phút tuổi theo Graph timestamp — recovery path
  sau claim phải tự re-check (§9 S7). **Không resend stale code chỉ vì delivery recovery.**
* Webhook + delta duplicate safety: giữ nguyên lớp E làm authoritative gate.
* One-mailbox-one-destination, customer isolation, routing hiện tại, no broadcast:
  recovery re-send phải resolve mapping lại từ DB tại thời điểm gửi (như TASK-033 đã
  làm trong một attempt: không đổi chatId giữa các retry) — không cache chat id vào
  state mới.
* Logging/persist: không token, không bot token, không connection URL, không full code
  (chỉ maskCode/hash như hiện tại), không full email body. Không sửa GitHub Actions /
  secret scan; tài liệu tránh wording dễ false-positive.

## §15. Service impact (sau trace, không mặc định)

| Service | Impact dự kiến |
|---|---|
| worker-email | **Direct behavioral impact** — dedup/claim/send/classification đều nằm ở đây |
| worker-delta | **Producer-only** — enqueue không đổi; pipeline dùng chung nhưng thay đổi nằm phía consumer |
| web | **Gián tiếp, nhỏ** — health dashboard đọc `status` SENT/FAILED (`health.service.ts` ~660–685) và mailbox detail list status; nếu thêm giá trị status mới thì hai reader này cần map (nếu chỉ dùng lại FAILED thì gần như zero-change, thậm chí sửa được metric đang chết §5.2); webhook route không đổi |
| worker-renewal | Không impact |
| Prisma/database | **Có khả năng cần migration** (§13) |
| Shared queue contract | **Không đổi** — job payload/jobId/attempts giữ nguyên ở Phase 1 proposal; Option A chỉ đổi hành vi trong worker |
| Railway | Phase 1 không thao tác; không đổi source khỏi dedicated branch staging |

## §16. Test matrix cho Phase 2 (thiết kế — KHÔNG implement ở Phase 1)

Tất cả dùng fake/injected ports (store in-memory, telegram sender fake, sleep fake,
clock fake) — không gọi dịch vụ thật. Crash được mô phỏng bằng **deterministic fault
seam**: fake store/sender throw-at-step hoặc "kill switch" cắt pipeline sau một bước
xác định (pipeline đã inject được mọi port nên seam này không cần sửa production code
ngoài phần Phase 2 vốn có).

1. Normal successful delivery: claim → send → SENT + sentToTelegramAt (regression).
2. Duplicate concurrent job (webhook + delta cùng identity, 2 store-race): đúng 1 send;
   job thua skip sạch.
3. Claim OK → retryable send failure: row chuyển trạng thái delivery-pending (không
   terminal), worker throw để BullMQ retry.
4. Internal Telegram retries exhausted: đúng 4 HTTP attempts, backoff đúng lịch, alert
   đúng 1 lần.
5. BullMQ retry sau send failure: attempt sau **đi tới bước send lại** (không bị early
   dedup nuốt) — đây là test đảo ngược trực tiếp của S1.
6. Crash sau claim trước send (seam: kill sau `store.create`): attempt sau recover và gửi.
7. Telegram success → crash trước markSent (seam: sender ghi nhận success rồi kill):
   hành vi theo policy đã chốt (resend-once hoặc terminal) — assert đúng policy, và
   assert không gửi sang chat khác.
8. Lost/timeout ack (sender throw network sau khi "đã gửi" trong fake): ghi nhận
   duplicate bounded đúng thiết kế; không unbounded retry.
9. Permanent/non-retryable 4xx: không internal retry, không BullMQ retry lãng phí (nếu
   Phase 2 thêm phân loại), row terminal-failed, alert.
10. Multiple worker replicas / ownership race: 2 pipeline song song trên cùng row
    pending → đúng 1 bên re-send (lease/lock), bên kia skip.
11. Retry ownership stale/reclaim (nếu architecture có lease): lease hết hạn → replica
    khác reclaim được; lease còn sống → không.
12. Stale threshold đạt trước recovery: row pending quá 30m → terminal stale, KHÔNG
    send (dùng fake clock).
13. Webhook + delta cùng identity ở hai thời điểm (một bên đến sau khi row đã SENT):
    skip duplicate như cũ.
14. No infinite retry: tổng số send attempt bị chặn bởi (BullMQ attempts × internal 4)
    và bởi stale 30m — fake clock chứng minh hội tụ.
15. Retry budget cạn → explicit terminal state + alert (không im lặng).
16. Sanitized logging: log/CodeEvent/state mới không chứa code đầy đủ, token, chat
    text; masked/hashed only.
17. Regression giữ nguyên: bộ test TASK-080 (stale), TASK-089 (delta recovery), dedup
    exactly-once TASK-068A, TASK-033 retry — tất cả vẫn green.
18. Migration-specific tests (CHỈ nếu Phase 2 được approve schema change): default
    value/backfill cho row cũ, index/constraint mới, downgrade-safety theo TASK-088.

## §17. Out of scope / deferred

Không mở rộng sang: TASK-089 Graph 410 recovery; HTTP 403 ErrorQuotaExceeded (independent
provider-side observation — trace này không tìm thấy evidence liên quan trực tiếp tới
delivery failure sau claim); subscription provisioning/cleanup; credential rotation;
Railway; detector/extractor; routing; RBAC; health dashboard ngoài hai reader ở §15;
production rollout.

Deferred findings mới ghi nhận trong Phase 1 (không sửa ở TASK-090 trừ khi Antigravity
yêu cầu):

* **DF-90-1:** health metric "Telegram FAILED recent" chết vì không writer nào ghi
  `FAILED` (§5.2) — Option A sửa được như hệ quả tự nhiên.
* **DF-90-2:** pipeline vứt bỏ `message_id` Telegram trả về (không persist) — nếu tương
  lai cần audit/reconciliation thì phải bắt đầu lưu (không bắt buộc cho Option A).
* **DF-90-3:** per-mailbox Redis lock đã có code (TASK-068A) nhưng chưa wire vào
  production runner — liên quan mục 10/11 của test matrix khi chạy nhiều replica.
* **DF-90-4:** `FAILED_TELEGRAM_SEND` không phân biệt retryable vs permanent ở worker
  classification → 1 BullMQ retry vô ích cho permanent 4xx (§9 S6).

## §18. Phân loại guarantee (PROVEN / BOUNDED / BEST-EFFORT / IMPOSSIBLE)

| Phát biểu | Phân loại |
|---|---|
| Exactly-once DB claim per (mailboxId, graphMessageId) | **PROVEN** (unique constraint, §5.5) |
| Không duplicate-send khi webhook+delta concurrent | **PROVEN** (qua claim; §9 S5) |
| Queue delivery ít nhất một lần tới worker | **PROVEN theo PROVIDER CONTRACT** (BullMQ) |
| Hiện tại: message đã claim sẽ được gửi Telegram | **KHÔNG ĐÚNG — loss window CONFIRMED** (S1/S2) |
| Hiện tại: không duplicate Telegram message | **BEST-EFFORT** — S4 lost-ack + internal retry có thể duplicate |
| Early dedup ngăn double-send sau crash-post-send | **PROVEN** (S3) — nhưng cùng cơ chế gây loss |
| Stale >30m không bao giờ được relay (mọi đường hiện có) | **PROVEN** (guard trước claim, đo lại mỗi attempt) |
| Option A: loại bỏ loss S1/S2 | **BOUNDED** (bởi BullMQ attempts + stale 30m; cần lease đúng cho multi-replica) |
| Option A: zero duplicate | **KHÔNG HỨA** — crash-window duplicate là trade-off có chủ đích |
| Exactly-once external Telegram side effect (mọi option) | **IMPOSSIBLE TO PROVE** với Telegram Bot API hiện tại (không idempotency key, không reconciliation seam; §8) |

## §19. Điểm cần Antigravity Architecture Review đặc biệt chú ý

1. Verdict S1/S2 (permanent loss) — soát lại trace §4/§9 độc lập.
2. Trade-off at-most-once → at-least-once của Option A (§11/§12 invariant 3): xác nhận
   product-level là duplicate-code-cùng-chat chấp nhận được, loss thì không.
3. Stale re-check bắt buộc trong recovery path (§9 S7) — đây là điều kiện để không phá
   TASK-080.
4. Lựa chọn giữa Option A và Option D (migration vs không) + hình thức state tối thiểu.
5. Ownership multi-replica: lease mới vs wire Redis mailbox lock sẵn có (DF-90-3).
6. DF-90-4 (phân loại permanent Telegram 4xx ở worker) có nên gộp vào Phase 2 không.

---

## §20. PHASE 2 — IMPLEMENTATION RECORD (hiện hành)

Toàn bộ mục này mô tả code THẬT sau implementation. Không secret, không full code,
không email body, không connection URL, không tên nhánh Git đầy đủ.

### §20.1 Root bug fix — tóm tắt

Root bug (§9 S1/S2): early dedup không phân biệt trạng thái delivery nên một row
`DETECTED` (claim rồi nhưng chưa gửi) bị coi là duplicate terminal, BullMQ retry bị
vô hiệu, permanent loss. Fix theo Option A:

1. Early dedup trở thành **status-aware**: chỉ row TERMINAL (`SENT`, `FAILED`) mới
   duplicate-skip; row `DETECTED` trở thành **recovery candidate** đi tiếp qua stale
   guard → detector/extractor → atomic delivery-ownership CAS → send.
2. Row có **explicit delivery state**: lease + owner token + attempt counter +
   terminal `FAILED` (có sanitized reason).
3. Retryable failure **release lease** trước khi worker throw ⇒ BullMQ attempt kế
   tiếp re-claim ngay và THỰC SỰ gửi lại (S1 fixed).
4. Crash sau claim ⇒ lease của owner chết hết hạn sau 5 phút; claimant bị chặn
   **đợi bounded trong chỗ** (poll, tổng chờ nhỏ hơn hoặc bằng lease) rồi re-claim
   và gửi (S2 fixed).
5. Permanent Telegram failure ⇒ row `FAILED` terminal, worker **không throw** ⇒
   không đốt BullMQ attempt vô ích (DF-90-4 fixed).

### §20.2 Exact final delivery state machine

Trạng thái durable trên `ProcessedMessage`:

```text
 (không có row)
    |  identity claim = INSERT duy nhất (unique mailboxId+graphMessageId, TASK-068A)
    |  đồng thời set owner + lease(5m) + attempts=1  <- atomic trong cùng INSERT
    v
 DETECTED, owned (lease active, owner=token)
    |
    +- send OK -----------> markSent CAS (owner match) --> SENT  [terminal]
    |                        (count=0 = mất ownership: không ghi đè, không
    |                         re-send; remote đã nhận — ambiguous window §20.9)
    +- send fail RETRYABLE -> releaseDelivery CAS --> DETECTED, unowned
    |                        (lease=null, owner=null, attempts giữ nguyên)
    |                        worker throw FAILED_TELEGRAM_SEND -> BullMQ retry
    +- send fail PERMANENT -> markFailedByOwner CAS --> FAILED [terminal]
    |                        worker RETURN FAILED_TELEGRAM_PERMANENT (no throw)
    +- stale sau ownership -> markFailedByOwner('stale_before_delivery') -> FAILED
    +- no mapping ----------> releaseDelivery --> DETECTED, unowned (attempts giữ)
    +- crash/hang ----------> DETECTED, owned, owner chết -> lease tự hết hạn (5m)

 DETECTED, unowned (lease null/expired)
    |  job duplicate bất kỳ (BullMQ retry, stalled re-run, delta job...) đến:
    +- attempts < 3  -> claimDelivery CAS thắng -> DETECTED, owned (attempts+1) -> send
    +- attempts >= 3 -> markFailedIfUnclaimed('delivery_attempts_exhausted') -> FAILED
    +- message stale -> markFailedIfUnclaimed('stale_before_delivery') -> FAILED
       (chạy TRƯỚC detector; historical rows đi đường này — không mass-redeliver)

 SENT   [terminal] -> mọi job sau: SKIPPED_DUPLICATE (reason duplicate_*)
 FAILED [terminal] -> mọi job sau: SKIPPED_DUPLICATE (reason duplicate_terminal_failed)
```

Không có background sweeper (không outbox worker — đúng scope): row `DETECTED`
unowned mà không job nào chạm tới nữa là inert; mọi lần chạm sau đó đều bị stale
policy terminal hóa, không thể gây send muộn.

### §20.3 Identity claim vs delivery ownership claim

Hai claim TÁCH BIỆT, cùng sống trên một row:

* **MESSAGE IDENTITY CLAIM** — INSERT duy nhất theo unique
  `(mailboxId, graphMessageId)` (không đổi). P2002 vẫn nghĩa là "row identity đã
  tồn tại" — nhưng KHÔNG còn đồng nghĩa "đã gửi". Race loser (P2002) giờ re-read
  row: terminal thì duplicate-skip như cũ; recoverable thì đi qua delivery-ownership
  seam (thường thua CAS trước live winner và skip — nhưng nếu winner crash, chính
  đường này recover). Code: `claimMessageForProcessing` + P2002 backstop (logic
  TASK-068A không đổi) trong `services/email/deduplication.service.ts`.
* **DELIVERY OWNERSHIP CLAIM** — lease CAS trên row hiện có:
  `acquireDeliveryOwnership` (`deduplication.service.ts`) +
  `store.claimDelivery` (một `updateMany` điều kiện duy nhất).

INSERT mới set ownership ngay trong cùng INSERT (atomic — không tồn tại khoảnh khắc
"có row mà chưa ai own" giữa claim và send).

### §20.4 Schema / migration

`prisma/schema.prisma` — 4 cột mới trên `ProcessedMessage` (additive, nullable /
default; KHÔNG đổi unique identity; không enum mới — tái dùng `FAILED` sẵn có):

| Cột | Kiểu | Ý nghĩa |
|---|---|---|
| `deliveryAttempts` | `Int @default(0)` | Số ownership claim đã tiêu (bounded budget cross-process) |
| `deliveryLeaseUntil` | `DateTime?` | Hạn lease; NULL = unowned; hết hạn = stale-reclaimable |
| `deliveryOwner` | `String?` | Claim-generation token (UUID ngẫu nhiên mỗi claim); mọi completion write fence trên nó |
| `deliveryFailureReason` | `String?` | Category sanitized khi FAILED (vd `telegram_api_400`, `delivery_attempts_exhausted`, `stale_before_delivery`) — không bao giờ chứa code/token/chat id/nội dung |

Migration: `prisma/migrations/20260901000000_task090_processed_message_delivery_state/`
— một `ALTER TABLE ... ADD COLUMN` cho 4 cột, additive, không xóa/ghi lại dữ liệu,
không backfill secret. **CHƯA chạy trên staging/production** (rollout phase sau theo
quy trình TASK-088). Historical rows: `SENT` giữ terminal; `DETECTED` cũ về lý thuyết
claimable nhưng mọi đường chạm đều qua stale guard 30m nên chỉ có thể bị terminal
hóa, không thể redeliver (test "historical-row safety" chứng minh ở mức pipeline).

### §20.5 Atomic CAS / lease / reclaim semantics

Mọi write có điều kiện là MỘT `updateMany` duy nhất (Postgres row-level atomic —
điểm serialisation duy nhất; store in-memory mirror y hệt cho tests):

| Operation | WHERE (điều kiện) | SET |
|---|---|---|
| `claimDelivery` | id + status=DETECTED + (lease NULL hoặc lease <= now) + attempts < 3 | owner=token, lease=now+5m, attempts+1 |
| `markSent` (worker) | id + status=DETECTED + owner=token | SENT, sentToTelegramAt, lease=null |
| `releaseDelivery` | id + status=DETECTED + owner=token | owner=null, lease=null (attempts giữ) |
| `markFailedByOwner` | id + status=DETECTED + owner=token | FAILED, reason, lease=null |
| `markFailedIfUnclaimed` | id + status=DETECTED + (lease NULL hoặc <= now) [+ attempts >= min] | FAILED, reason, lease=null |

* Không bao giờ có kiểu "read DETECTED rồi send" — mọi đường tới send đều qua CAS.
* Owner cũ (crash/hang rồi bị thay) không thể hoàn tất state: count=0, log warn, và
  KHÔNG retry side effect trong stale owner.
* Blocked claimant (lease active): poll re-read mỗi 5s, tổng chờ bounded bởi lease
  cộng một tick, CAS tối đa 2 lần, iteration hard-cap chống clock không tiến (có
  test riêng). Thấy `SENT`/`FAILED` giữa chừng thì dừng ngay, 0 Telegram call.
* Constants ở leaf `services/email/delivery-ownership-policy.ts`:
  `DELIVERY_LEASE_MS = 5 phút` (lớn hơn worst-case một attempt bình thường: 3 lần
  retry_after cap 60s cộng overhead xấp xỉ 4 phút trở xuống; nhỏ hơn nhiều so với
  30m freshness; KHÔNG tái dùng window 30m TASK-080 hay claim window Graph
  subscription — semantics khác), `MAX_DELIVERY_ATTEMPTS = 3` (align BullMQ
  attempts=3), `DELIVERY_OWNERSHIP_POLL_MS = 5s`. Không dùng biến môi trường.

### §20.6 Multi-replica safety

Correctness KHÔNG dựa vào per-mailbox lock (vẫn in-memory, best-effort như trước —
DF-90-3 giữ deferred). Nguồn đảm bảo duy nhất là DB state: identity unique + delivery
CAS + fenced completion. Hai replica cùng recovery một row thì đúng một CAS thắng; kẻ
thua hoặc đợi-bounded rồi thấy terminal, hoặc skip an toàn (`delivery_owned_elsewhere`)
vì kẻ thắng còn sống và job của nó (kể cả stalled re-run sau crash) là recovery driver.

### §20.7 Status-aware dedup — mapping kết quả

| Row state khi job đến | Kết quả pipeline | Worker |
|---|---|---|
| `SENT` | `SKIPPED_DUPLICATE` / `duplicate_graph_message_id` (giữ reason cũ) | terminal |
| `FAILED` | `SKIPPED_DUPLICATE` / `duplicate_terminal_failed` | terminal |
| `DETECTED` + claim được | đi tiếp tới send | theo outcome send |
| `DETECTED` + owner sống | `SKIPPED_DUPLICATE` / `delivery_owned_elsewhere` | terminal (owner drive) |
| `DETECTED` + budget cạn | row thành `FAILED`; `SKIPPED_DUPLICATE` / `delivery_attempts_exhausted` (CodeEvent `TELEGRAM_SEND_FAILED`) | terminal |
| imid trùng row terminal KHÁC id | `SKIPPED_DUPLICATE` / `duplicate_internet_message_id`; row DETECTED của mình bị terminal hóa best-effort (`duplicate_identity_terminal`) | terminal |
| bucket duplicate (identity KHÁC, cùng code + 5 phút) | `SKIPPED_DUPLICATE` (status-blind như cũ — conservative, giữ nguyên) | terminal |

Queue jobId dedup và P2002 giữ nguyên vai trò riêng, không thay đổi.

### §20.8 Telegram error taxonomy (DF-90-4) và retry budget

* Classification KHÔNG đổi (telegram-error.ts TASK-033): retryable = 429, mọi 5xx,
  network; non-retryable = 4xx khác, validation, config. **429 không bao giờ bị coi
  permanent dù là 4xx** (test riêng).
* Seam nhỏ nhất: `TelegramSendError` thêm field optional `retryable`; retry port
  (TASK-033/035, không đổi hành vi retry/alert) gắn verdict `outcome.retryable` khi
  re-throw. Pipeline: chỉ `retryable === false` tường minh mới là permanent;
  unclassified (undefined) giữ đường conservative retryable như trước.
* Permanent: không internal retry (sẵn có), row `FAILED` terminal, worker return
  `FAILED_TELEGRAM_PERMANENT` (status mới, KHÔNG nằm trong throw-list) nên **0
  BullMQ retry**, không bao giờ auto-resend. Retryable exhausted: release + throw
  `FAILED_TELEGRAM_SEND` nên BullMQ retry như cũ — nhưng giờ retry có tác dụng.
* **Retry budget tối đa (final):** per message identity = `MAX_DELIVERY_ATTEMPTS(3)`
  ownership claims nhân tối đa 4 internal HTTP sends (TASK-033) = **tối đa 12
  Telegram HTTP calls** cho retryable failure; permanent = **1 call**; mọi đường bị
  chặn thêm bởi stale 30m. BullMQ attempts (3) và internal retry count (4) KHÔNG bị
  tăng; không retry loop thứ ba (DB counter chỉ là budget cap, không phải driver).

### §20.9 Ambiguous remote side effect — giới hạn trung thực (không đổi so với §8)

Guarantee cuối: **durable local claim/ownership + recovery cho proven S1/S2 +
at-least-once-oriented delivery recovery + bounded duplicate risk trong ambiguous
window**. KHÔNG phải "exactly-once Telegram". Các cửa sổ còn lại:
(a) send thành công rồi crash trước markSent: retry sau lease có thể gửi lại (đổi
loss lấy bounded duplicate — trade-off Option A đã approve); (b) lost ack: internal
retry có thể double-send (tồn tại từ TASK-033); (c) hung send vượt lease bị takeover:
có thể 2 message, nhưng fencing bảo đảm state local không bị stale owner ghi đè.
Không Telegram reconciliation/message-id (DF-90-2 giữ deferred).

### §20.10 Stale recovery semantics (TASK-080 giữ nguyên)

* Guard cũ (trước detector) giữ nguyên vị trí và boundary (chỉ lớn hơn 30m mới
  stale; đúng 30m vẫn fresh — có test boundary); nguồn thời gian duy nhất vẫn là
  Graph `receivedDateTime` (không created/claim/retry/enqueue time).
* MỚI: **re-check ngay sau khi acquire ownership** (sau bounded lease wait, trước
  mapping/throttle/send) — message vượt 30m trong lúc đợi lease bị owner terminal
  hóa (`stale_before_delivery`) và **0 Telegram call** (test riêng: message 26 phút
  tuổi + đợi lease 5 phút thì stale, không gửi).
* Recovery row stale ở guard đầu: `markFailedIfUnclaimed('stale_before_delivery')`
  (không steal live owner) — đây cũng là cơ chế an toàn cho historical rows.

### §20.11 Routing / mapping safety

Không đổi routing. Mapping được resolve lại từ DB TẠI attempt gửi (như cũ — không
persist/pin destination vào delivery state); mapping disabled/removed thì
`SKIPPED_NO_TELEGRAM_MAPPING` + release lease, 0 send, không fallback chat id;
mapping đổi giữa attempts thì recovery gửi theo mapping hiện hành (one-mailbox-one-
destination + customer isolation giữ nguyên; TASK-033 vẫn giữ chat id bất biến
TRONG một attempt). Tests: recovery-with-disabled-mapping + remapped-destination.

### §20.12 SENT/FAILED writer và observability

* Writer `FAILED` đầu tiên của hệ thống: pipeline (permanent / budget cạn / stale
  recovery). Đã VERIFY reader thật: `services/health/health.service.ts` groupBy
  `status: 'FAILED'` (cửa sổ theo `createdAt`) và `mailbox-detail.service.ts` đọc
  `status` dạng string — cả hai hoạt động với writer mới mà KHÔNG cần sửa, đúng
  yêu cầu: **không sửa health.service.ts / web reader**; metric "Telegram FAILED
  recent" (DF-90-1) tự sống lại.
* `deliveryFailureReason` chỉ chứa category (`kind_status` hoặc reason cố định).
  CodeEvent/AuditLog statuses tái dùng giá trị sẵn có (`TELEGRAM_SEND_FAILED`,
  `CODE_SKIPPED_DUPLICATE`, `CODE_SKIPPED_STALE`) — không đổi log service.
* Mock flow (`email-processing.service.ts`): truyền owner token từ claim vào
  markSent để đi cùng đường fenced; hành vi mock không đổi (mock không có recovery
  — ngoài scope). `markSent` không token (legacy seam duy nhất, chỉ mock dùng) vẫn
  unconditional theo id — mock không có concurrent claimant.

### §20.13 Files changed (Phase 2)

Runtime/schema:
`prisma/schema.prisma`;
`prisma/migrations/20260901000000_task090_processed_message_delivery_state/migration.sql` (mới);
`services/email/delivery-ownership-policy.ts` (mới, leaf constants);
`services/email/deduplication.service.ts` (store contract + ownership + in-memory store);
`services/email/prisma-processed-message-store.ts` (CAS updateMany);
`services/email/graph-message-pipeline.service.ts` (status-aware dedup, ownership seam,
stale re-check, permanent/retryable split, fenced completion);
`services/email/email-processing.service.ts` (mock flow truyền token);
`services/telegram/telegram-sender.service.ts` (field `retryable`);
`services/telegram/telegram-retry.service.ts` (gắn verdict khi throw);
`services/queue/workers/email-worker.ts` (chỉ comment — throw-list không đổi).

Tests:
`tests/unit/email/graph-message-pipeline.delivery-recovery.test.ts` (mới — 16 tests:
S1, S2, budget, CAS race, live-owner poll-skip, lost-ownership fencing, ambiguous
takeover, stale recovery + boundary + stale-sau-wait, permanent/retryable/unclassified,
worker no-throw, routing safety, fresh success, SENT/FAILED dup);
`tests/unit/email/processed-message-delivery-store.test.ts` (mới — 10 tests store
semantics + Prisma CAS shapes + bounded loop);
`tests/unit/telegram/telegram-retry.classification.test.ts` (mới — 6 tests DF-90-4);
`tests/unit/email/deduplication.exactly-once.test.ts` (cập nhật contract fakes —
assertions TASK-068A giữ nguyên);
`tests/unit/email/graph-message-pipeline.stale.test.ts` (1 test duplicate-precedence
seed row SENT thay vì DETECTED — intent giữ nguyên: TERMINAL duplicate thắng stale).

KHÔNG sửa: ROADMAP, CI/GitHub Actions, secret scan, env files, health/web readers,
worker-delta, worker-renewal, queue contract (jobId/attempts/payload), Railway.

### §20.14 Verification

* `npm run verify` (db:generate + lint + typecheck + test + build): **PASS** —
  108 test files / 1339 tests (trước: 105/1304).
* `npx prisma validate`: PASS. Migration KHÔNG được apply ở bất kỳ môi trường nào.
* `git diff --check`: sạch. Diff đã soát: không secret, không full code, không tên
  nhánh đầy đủ, không wording dễ gây secret-scan false positive.

### §20.15 Remaining / deferred risks sau Phase 2

* Ambiguous-window bounded duplicates (§20.9 a/b/c) — không thể loại bỏ với provider
  contract hiện tại; đã document, không hứa quá evidence.
* DF-90-2 (persist Telegram message_id / reconciliation) — deferred theo chỉ đạo.
* DF-90-3 (Redis per-mailbox lock chưa wire) — lock vẫn best-effort; correctness đã
  chuyển hẳn sang DB CAS nên không còn là điều kiện an toàn, chỉ còn là tối ưu burst.
* Bucket dedup (cùng code + 5 phút, identity khác) vẫn status-blind conservative —
  giữ nguyên hành vi trước TASK-090.
* Row `DETECTED` unowned không bao giờ được job nào chạm lại là inert (không sweeper
  by design); chỉ terminal hóa khi có lần chạm sau — không gây send muộn nhờ stale
  guard.
* Migration rollout staging/production chưa thực hiện — cần preflight TASK-088 ở
  phase promotion.

### §20.16 Timeout correction (sau Final Implementation Review — Human/ChatGPT seam)

Finding xác nhận: Telegram HTTP send trước đó gọi `fetch` không có finite
timeout/cancellation tường minh (chỉ dựa vào hành vi runtime ngầm) trong khi lease
= 5 phút. Fix tối thiểu:

* `telegram-sender.service.ts` giờ gửi qua `fetchWithTimeout` (helper TASK-080,
  `lib/http/fetch-with-timeout.ts` — AbortController thật: request bị hủy và
  promise settle, không phải Promise.race bỏ promise cũ chạy nền) với
  `TELEGRAM_HTTP_TIMEOUT_MS = 15s` (constant trong code, không env). Timeout map
  sang kind `network` ⇒ **RETRYABLE**; 429 / permanent 4xx / 5xx / network
  semantics và số retry (internal + BullMQ) không đổi.
* **Upper-bound ownership (code-level, mọi term đều bounded):** HTTP 4×15s = 60s
  + backoff 3×60s (retry_after cap) = 180s + pacing caps 15s+2s = 17s + DB
  overhead ms-scale ⇒ **≈257s < lease 300s, safety margin ≈43s (~14%)** — lease 5
  phút giữ nguyên. Inequality được pin bằng test deterministic đọc constants thật
  (`tests/unit/telegram/telegram-sender.timeout.test.ts`): đổi bất kỳ term nào mà
  không chứng minh lại budget sẽ fail suite.
* Ambiguous remote-success window (§20.9) vẫn tồn tại: request có thể đã tới
  Telegram trước khi bị abort/mất ack — timeout không tạo và không xóa cửa sổ này;
  vẫn KHÔNG claim exactly-once Telegram.
