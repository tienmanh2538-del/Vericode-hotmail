# TASK-079 — Report: Relay Silence Incident Diagnosis (investigation-only)

> **Sanitized report.** Không chứa secret thật, connection URL, token, auth header,
> verification code đầy đủ, full email body, hay raw customer data. Mọi tham chiếu
> env chỉ là **tên biến** (không có giá trị). Đây là điều tra — **không sửa runtime**.

## 0A. ROOT CAUSE CONFIRMED (cập nhật sau runtime evidence — supersedes mục 0/4/5)

> Human operator đã cung cấp runtime evidence và thực hiện recovery. Chẩn đoán chuyển
> từ *hypothesis* sang **ROOT CAUSE CONFIRMED**. Các mục 0/4/5 bên dưới là quá trình
> suy luận ban đầu (từ đọc code, trước khi có runtime evidence) — **giữ lại làm hồ sơ**,
> nhưng kết luận chính thức là mục 0A này.

**Root cause vận hành trực tiếp: delta polling runner bị STUCK trong một cycle.**

Runtime evidence (do human operator xác nhận):

1. Trước recovery, `worker-delta` vẫn ở trạng thái **process active** nhưng log **lặp
   liên tục**: `Delta polling skipping tick - previous tick still running` — kéo dài,
   mọi polling tick mới đều bị skip.
2. `worker-email` trước đó **vẫn từng nhận và xử lý job delta bình thường** (consumer
   không chết).
3. Cấu hình queue giữa `web` và `worker-email` được human **xác nhận đồng nhất** ở mức
   tên/reference cần thiết (không ghi giá trị thật) ⇒ **loại giả thuyết Redis mismatch**.
4. `worker-renewal` vẫn chạy scheduler nhưng **không có Graph subscription candidate**
   để renew (khớp finding kiến trúc F1 bên dưới).
5. Health dashboard trước recovery: nhiều mailbox **không được poll từ ~cuối tháng 7**.
6. Human **restart RIÊNG `worker-delta`** (không đổi variables).
7. Ngay sau restart: delta polling hoạt động lại → Graph message jobs enqueue lại →
   email worker xử lý lại → **Telegram bắt đầu nhận verification messages**.
8. Sau recovery: **queue backlog lớn** và Telegram nhận cả **một số message cũ** từ
   thời gian downtime → finding follow-up (rủi ro stale message), **không sửa ở đây**.

**Kết luận chính thức:**

- Stuck delta polling cycle là **root cause vận hành trực tiếp** của incident.
- Runner **tiếp tục sống** nhưng các tick sau bị skip vì previous cycle vẫn được coi là
  đang running (`inflight !== null` không bao giờ được clear).
- **Restart riêng `worker-delta`** giải phóng state stuck và phục hồi polling.
- Incident **KHÔNG** phải regression TASK-078; **KHÔNG** phải detector/extractor;
  **KHÔNG** phải Telegram routing.
- **`worker-email` KHÔNG phải root cause chính** (nó tiêu thụ được job khi có job).
- **Redis queue mismatch KHÔNG được runtime evidence hỗ trợ** sau khi kiểm tra.
- Recovery đã chứng minh producer path **delta → queue → worker-email → Telegram** hoạt
  động trở lại end-to-end.

**Cơ chế code (đã đọc, KHÔNG sửa):** trong `startDeltaPollingScheduler`
(`services/queue/workers/delta-polling-runner.ts`), `tick()` set `inflight =
runDeltaPollingOnce(deps)` và **chỉ clear `inflight` trong `finally`** sau khi await
xong. `runDeltaPollingOnce` await các HTTP request tới token endpoint + Graph delta qua
`fetchImpl` (native `fetch`) **không có timeout / AbortController**. Nếu **một** request
treo (không phản hồi), promise không bao giờ resolve → `inflight` giữ non-null vĩnh viễn
→ mọi tick sau rơi vào nhánh `if (inflight !== null) { log('skipping tick …'); return; }`.
Scheduler **tự khoá**, poll ngừng fleet-wide, và vì process vẫn "active" nên một health
check kiểu "service Running?" **không** phát hiện được. Đây là **finding cần fix ở
TASK-080** (timeout + self-recovery), KHÔNG sửa trong TASK-079.

> **Bài học chẩn đoán:** giả thuyết ban đầu (mục 0) đặt Primary = "email worker
> stopped". Runtime evidence cho thấy đúng **họ nguyên nhân** là **worker-delta** (giả
> thuyết #3), nhưng ở dạng **stuck cycle** chứ không phải "process stopped/crashed" —
> tiến trình vẫn Running. Đây chính xác là lý do checklist "service Running?" là **chưa
> đủ**: cần kiểm tra **log lặp "skipping tick"** và **mốc `deltaLastPolledAt`**, không
> chỉ trạng thái process.

**Remaining findings / handoff (KHÔNG sửa trong TASK-079 — xem mục 7 & TASK-080):**

1. Delta polling cần **timeout/self-recovery** để một cycle không block scheduler vô hạn.
2. Sau downtime dài, backlog có thể chứa message cũ → rủi ro **stale verification
   message** vẫn được relay (cần drop/skip theo tuổi).
3. Production path chưa có **Graph subscription wiring** thực tế cho mailbox mới;
   renewal không có candidate (finding kiến trúc F1) → **task riêng** sau TASK-080.

---

## 0. TL;DR (suy luận ban đầu — giữ làm hồ sơ; đã được mục 0A cập nhật/hiệu chỉnh)

> ⚠️ Mục này viết **trước** khi có runtime evidence. Kết luận chính thức ở **mục 0A**.
> Đặc biệt: "Primary = email worker stopped" đã được hiệu chỉnh thành **worker-delta
> stuck cycle**; "Redis mismatch" đã bị **loại** bởi runtime evidence.

- **Không có bằng chứng regression code** gây ra sự cố: commit runtime cuối cùng là
  **2026-06-08** (`fix: add delta 403 backoff and alert`); mọi commit sau đó tới nay
  chỉ là `docs:`. Sự cố bắt đầu **~3 tuần trước (~cuối tháng 7/2026)** — **không trùng
  với bất kỳ thay đổi code nào**. ⇒ Đây gần như chắc chắn là sự cố **runtime/vận hành**
  (một tiến trình/dịch vụ ngừng), không phải bug mới merge. ✅ *(confirmed)*
- **Triệu chứng quyết định:** *hoàn toàn không có Code Event nào* (kể cả loại
  `DETECTOR_REJECTED` / `SKIPPED_*`) **và** mailbox mới connect cũng im lặng.
  `CodeEvent` **chỉ được ghi bên trong pipeline của email worker**. Nếu email đã tới
  worker mà detector từ chối, hệ thống **vẫn ghi** `DETECTOR_REJECTED`. "Zero code
  event" nghĩa là **không có job nào tới email worker** — khớp với **producer (delta)
  bị khoá**, không phải consumer chết. *(hiệu chỉnh ở 0A)*
- **~~Primary hypothesis: Email worker (consumer) không chạy / crash~~** → **hiệu chỉnh:
  worker-delta stuck cycle** (producer bị khoá; email worker vẫn khỏe). Xem 0A.
- **~~Secondary hypothesis: Redis/BullMQ mismatch~~** → **LOẠI** bởi runtime evidence
  (cấu hình đồng nhất; recovery không đổi variable).
- Xác minh nhanh nhất (đã dùng): **log lặp "skipping tick"** + **`deltaLastPolledAt`
  đứng im từ cuối tháng 7** ⇒ xác nhận stuck delta cycle.

## 1. Kiến trúc thực tế (đã trace trong code)

```
Microsoft Graph
   │  (đường chính) webhook POST /api/webhooks/microsoft/mail   ← chạy trong service "web"
   │        → validate clientState (hash) → enqueue BullMQ  (email-queue.ts)
   │  (đường phụ) delta polling worker  ← service "worker-delta"
   │        → Graph delta → enqueue BullMQ  (delta-polling-queue.ts)
   ▼
Redis / BullMQ queue  (mặc định tên "email-processing", REDIS_URL)
   ▼
Email worker (consumer)  ← service "worker-email"  (scripts/run-email-worker.ts)
   → load mailbox (phải ACTIVE) → refresh token → Graph fetch message
   → Facebook/Meta detector → code extractor → dedup → Telegram mapping → Telegram send
   → GHI CodeEvent + ProcessedMessage + Audit  (chỉ ở bước này)

Subscription renewal worker  ← service "worker-renewal"
   → PATCH /subscriptions/{id} gia hạn (mặc định +6 ngày, renew khi còn <24h)
```

Điểm mấu chốt kiến trúc:

- **Producer (web + worker-delta) và consumer (worker-email) là các tiến trình/dịch
  vụ TÁCH BIỆT**, chỉ nối với nhau qua Redis. Nếu consumer chết, producer vẫn có thể
  enqueue nhưng **không ai xử lý** → 0 Code Event.
- **`CodeEvent` chỉ được tạo trong `graph-message-pipeline.service.ts`** (đường
  worker). Web ghi vào DB `CodeEvent` chỉ qua worker; trang Logs đọc từ cùng bảng DB
  (`listCodeEventsFromDb`). Web và worker là 2 process, nhưng chia sẻ **một** bảng DB.

## 2. Phát hiện cấu trúc quan trọng (không phải nguyên nhân, nhưng định hình chẩn đoán)

### F1 — Không có production code path nào TẠO Graph subscription

`createInboxSubscription(...)` (trong `graph-subscription.service.ts`) **không được gọi
ở bất kỳ route/worker/script production nào** (chỉ xuất hiện trong service, test, docs).
OAuth callback (`app/api/microsoft/oauth/callback/route.ts`) → `saveConnectedMailbox(...)`
**chỉ lưu mailbox row (status ACTIVE + refresh token)**, KHÔNG tạo subscription.

Hệ quả:
- **Mailbox mới connect KHÔNG có Graph subscription** ⇒ đường webhook không tồn tại cho
  chúng ⇒ chúng phụ thuộc **hoàn toàn vào delta polling**.
- Subscription renewal worker chỉ **gia hạn row `GraphSubscription` đã có**; không có
  subscription nào được tạo tự động thì renewal cũng không có gì để làm.
- ⇒ Trên thực tế, **delta polling là đường sống chính** để phát hiện mail mới ở cấu
  hình hiện tại (trừ khi subscription đã được tạo thủ công bằng script trước đây).

> Đây là điểm giải thích rất tốt việc *mailbox mới cũng im lặng*: chúng chưa từng có
> webhook, nên chỉ delta polling + email worker mới đưa được code của chúng đi. Nếu một
> trong hai ngừng, mailbox mới câm hoàn toàn.

### F2 — Health dashboard đã tiên đoán chính xác chế độ hỏng này

`services/health/health.service.ts` có check `EMAIL_WORKER_PIPELINE`
(`classifyEmailWorkerWiring`) và `DELTA_POLLING` (`classifyDeltaPolling`). Nhưng
`classifyEmailWorkerWiring` chỉ kiểm tra **repo wiring tĩnh** (có npm script + runner
file), **không** kiểm tra worker có đang chạy thật. `classifyDeltaPolling` suy ra từ
`deltaLastPolledAt` — nếu quá `DELTA_POLLING_STALE_MS` (15 phút) ⇒ WARNING "backup
poller may not be running". **`/admin/health` là công cụ chẩn đoán mạnh nhất hiện có
trong app** (xem mục 6.7).

## 3. Trace theo checklist yêu cầu (A–G)

### A. Worker wiring
- `package.json`: có script `worker:email` / `worker:delta` / `worker:renewal`
  (+ biến thể `--once`). Runner: `scripts/run-*-worker.ts` — **zero side-effect on
  import**, chỉ chạy trong `main()`. ✅ wiring repo đúng.
- `worker:email` consume **đúng queue**: `createEmailWorker()` dùng
  `loadQueueEnv().emailQueueName` (mặc định `email-processing`) + `getRedisConnectionOptions()`.
  Producer (`getEmailQueue()`) dùng **cùng** `resolveQueueName()` + cùng Redis options.
  ⇒ **cùng tên queue/Redis KHI env giống nhau**. Rủi ro: nếu service web và worker-email
  được set `EMAIL_QUEUE_NAME` hoặc `REDIS_URL` **khác nhau** trên Railway → tách rời
  producer/consumer (xem H4). Cần đối chiếu Variables (mục 6).
- `worker:delta` thực sự poll: scheduler `setInterval`, tick không chồng lấn; **nếu
  `DELTA_POLLING_ENABLED=false`** và không có `--once` thì worker **log warn rồi return
  ngay** (không poll) — điểm cần kiểm tra env (H6).
- `worker:renewal` thực sự renew: tương tự; **nếu `SUBSCRIPTION_RENEWAL_ENABLED=false`**
  → return ngay.
- Worker exit/crash/silent: entrypoint bắt `main().catch` → `process.exit(1)`. Nếu build
  lỗi / import lỗi / thiếu env bắt buộc lúc khởi động ⇒ tiến trình **exit ngay** và (tùy
  Railway) crash-loop hoặc dừng hẳn. ⇒ **Cần xem trạng thái + log khởi động của service.**
- Web vs worker dùng config khác nhau: **có thể** (H4) — phải đối chiếu trên Railway.

### B. Webhook
- `route.ts`: validationToken echo đúng; body hợp lệ → `handleMicrosoftGraphNotifications`
  → enqueue từng notification accepted. **TASK-073 confirmed:** nếu **bất kỳ** enqueue nào
  fail → trả **503** (không báo success) để Graph redeliver; jobId deterministic + dedup
  ⇒ redeliver an toàn. ✅
- Notification hợp lệ có enqueue: có, qua `enqueueMicrosoftGraphMessageJob`.
- Nhánh silently skip: `validateSingleNotification` skip khi `subscription_not_found` /
  `subscription_inactive` / `invalid_clientState`… **Nếu tất cả subscription đã EXPIRED
  (hoặc chưa từng tạo — F1)** thì **mọi** notification (nếu Graph còn gửi) bị skip
  `subscription_inactive/not_found` ⇒ đường webhook chết fleet-wide. Nhưng đây là *hệ quả*
  của subscription hết hạn, không phải regression clientState.
- clientState reject toàn fleet do regression: **không có bằng chứng** — không có thay đổi
  code webhook/subscription sau 2026-06-07 (`7489b93`). So sánh hash timing-safe, ổn.

### C. Delta polling (TASK-071/075)
- Chỉ chọn mailbox **ACTIVE** (`listActiveMicrosoftMailboxes` where status ACTIVE). Mailbox
  ở `RECONNECT_REQUIRED`/`SUBSCRIPTION_EXPIRED`/`DISABLED` **không** được poll.
- `DELTA_POLLING_ENABLED` gate: nếu tắt → worker không poll (H6).
- **Cooldown 403 (TASK-075):** mailbox trong cooldown bị **skip nguyên cycle**. Về lý
  thuyết nếu *mọi* mailbox đồng loạt dính 403 (ví dụ app-level `MailboxNotEnabledForRESTAPI`
  / thu hồi tenant) → cả fleet bị skip. Nhưng: (a) cooldown chỉ kích hoạt sau ngưỡng 403
  liên tiếp; (b) sẽ để lại `deltaLastErrorMessage` (code=…, http=403) trên health dashboard;
  (c) **không** giải thích được vì sao *webhook path* cũng câm, trừ khi subscription đã hết
  hạn. ⇒ Có thể góp phần, nhưng khó là nguyên nhân độc lập.
- **Bootstrap không enqueue:** lần poll đầu của một mailbox (cursor null) **cố ý không
  enqueue** message cũ, chỉ lưu cursor. Từ cycle sau mới enqueue mail mới. ⇒ Với mailbox
  mới, cần ≥2 cycle mới bắt đầu relay — bình thường; **không** giải thích im lặng kéo dài.
- Cursor reset/self-heal (TASK-071): 403 trên cursor → reset cursor để bootstrap lại. Không
  gây "không bao giờ enqueue" trừ khi kẹt 403 vĩnh viễn (đã có cooldown chặn hammer).
- Success clear forbidden state: có (`clearForbiddenBackoff`). ✅
- Regression sau TASK-075: commit `14e1bce` (2026-06-08). Không có thay đổi delta sau đó.

### D. Microsoft auth / Graph — phân biệt 3 việc KHÁC NHAU
1. **OAuth connect thành công** → chỉ tạo mailbox row ACTIVE (F1). "Connected" trên UI =
   **cờ DB**, KHÔNG phải kiểm tra Graph live. ⇒ "mailbox vẫn connected" **không** chứng minh
   token/Graph còn hoạt động.
2. **Refresh token thành công** → cần cho cả 3 worker; lỗi được phân loại (TASK-069C):
   chỉ `invalid_grant`/`interaction_required` → RECONNECT_REQUIRED; network/429/5xx →
   transient (giữ ACTIVE, retry). ⇒ Một blip diện rộng **không** làm hỏng vĩnh viễn.
3. **Graph Mail.Read request thành công** → 401 (`auth`) → reconnect; **403 (`forbidden`)
   KHÔNG reconnect** (TASK-071/074), rơi vào `FAILED_GRAPH_FETCH` (retryable) ở pipeline,
   hoặc backoff/cooldown ở delta.
- Trường hợp "**connected nhưng worker không đọc được Inbox**" **hoàn toàn có thể xảy ra**:
  ví dụ 403 app-level, hoặc token refresh transient kéo dài. Nhưng nếu email worker CÓ chạy,
  các case này **vẫn ghi CodeEvent/Audit** (FAILED_*/RECONNECT) hoặc để lại `deltaLastError…`.
  "Zero code event tuyệt đối" nghiêng về **worker không chạy** hơn là "Graph từ chối".

### E. Detector / extractor — **loại trừ mạnh**
- `CodeEvent` được tạo ở **nhiều** giai đoạn của pipeline, không chỉ khi gửi thành công:
  `DETECTOR_REJECTED`, `CODE_SKIPPED_LOW_CONFIDENCE`, `EXTRACTOR_FAILED`,
  `CODE_SKIPPED_DUPLICATE`, `CODE_DETECTED` (no mapping), `TELEGRAM_SEND_FAILED`, `CODE_SENT`.
- **Trả lời trực tiếp câu hỏi mục E:** nếu email tới email worker nhưng detector trả
  negative/low-confidence, trang Code Event Logs **VẪN ghi** một dòng `DETECTOR_REJECTED`
  (hoặc `CODE_SKIPPED_LOW_CONFIDENCE`).
- ⇒ Vì thực tế **không có dòng nào**, một **regression detector/extractor không thể là
  nguyên nhân** (nó sẽ tạo ra hàng loạt dòng `DETECTOR_REJECTED`, log không thể trống).
  Ngoài ra không có thay đổi detector sau `07e976a` (2026-06-04). **Không đổi threshold.**

### F. Telegram / routing — **loại trừ TASK-078 là regression**
- Worker resolve mapping qua `findActiveMappingForMailbox(mailboxId)` (trong
  `telegram-mapping.service.ts`) — hàm này **KHÔNG có tham số scope** và **không bị TASK-078
  đụng tới**. TASK-078 chỉ thêm `scope?` cho **disable/delete/create/update** (đường
  UI/API/action), tất cả guard bằng `if (scope) …`; worker gọi **không truyền scope** ⇒
  unscoped như cũ.
- Lỗi mapping làm **Code Event hoàn toàn không xuất hiện** hay chỉ "delivery failed"?
  → Nếu thiếu mapping, pipeline vẫn ghi `CODE_DETECTED` ("No active Telegram mapping");
  nếu Telegram gửi lỗi, ghi `TELEGRAM_SEND_FAILED`. **Cả hai vẫn tạo CodeEvent.** ⇒ Lỗi
  routing/mapping **không** giải thích "zero code event".
- **Kết luận F:** dựa trên diff/code (không suy đoán), **TASK-078 không thể là regression
  của relay**: (a) không chạm runtime resolution của worker; (b) chưa được deploy — nhánh
  làm việc hiện tại working tree sạch, chỉ có commit `docs:` sau 2026-06-08, và report
  TASK-078 ghi rõ "không commit".

### G. Git history quanh thời điểm im lặng
- `git log` (theo ngày): commit **runtime** cuối cùng là `14e1bce` **2026-06-08**
  (delta 403 backoff). Sau đó: `a94ac0f`/`0dca471`/`a71c449`/`c6a231a` đều **`docs:`**
  (2026-06-29..30). **Không có** thay đổi workers/queue/Redis/Graph/webhook/delta/renewal/
  detector/routing/CodeEvent/deployment sau 2026-06-08.
- Sự cố bắt đầu ~3 tuần trước (~cuối tháng 7) ⇒ **khoảng trống ~7 tuần giữa deploy cuối
  và thời điểm im lặng**. ⇒ Nguyên nhân **không phải code mới**; nghi vấn dồn vào **runtime**
  (service dừng, Redis reset, hết hạn nền tảng) quanh cuối tháng 7. **Không revert gì.**

## 4. Bảng candidate root cause

| # | Candidate root cause | Evidence FOR | Evidence AGAINST | Confidence | Cách xác minh tiếp |
|---|----------------------|--------------|------------------|-----------|--------------------|
| 1 | **Email worker (consumer) stopped/crashed** | Điểm chung DUY NHẤT giải thích cả 4 triệu chứng (0 code event; cũ + mới đều câm); CodeEvent chỉ ghi trong pipeline worker; không deploy nào quanh thời điểm sự cố ⇒ hợp với "process chết"; health check tự cảnh báo chế độ này | Chưa xem trực tiếp trạng thái service/log | **CAO** | Railway → service **worker-email**: Running/Stopped/Crashed? deployment timestamp? restart/crash-loop? log khởi động ("Email worker started …" có không?); **queue backlog** waiting lớn? |
| 2 | **Redis/BullMQ connectivity/config mismatch** | Producer & consumer chỉ nối qua Redis; nếu web và worker khác `REDIS_URL`/`EMAIL_QUEUE_NAME`, hoặc Redis bị reset/đổi pass → job không được tiêu thụ; cùng gây 0 code event | Nếu mismatch có từ đầu thì đã không bao giờ chạy — nên nghiêng về "Redis thay đổi/khởi động lại gần đây" | **CAO** | Railway → **Redis**: Running? bị đổi/tái tạo gần đây? Đối chiếu `REDIS_URL` + `EMAIL_QUEUE_NAME` giữa **web** và **worker-email** (giống nhau?); worker-email log lỗi kết nối Redis? |
| 3 | **Delta polling worker stopped** | Ở cấu hình hiện tại delta polling là đường phát hiện mail chính (F1); nếu dừng, mailbox mới (không webhook) câm hoàn toàn | Một mình nó không giải thích 0 code event nếu webhook + email worker còn sống (nhưng webhook phụ thuộc subscription — xem #5) | **TRUNG BÌNH-CAO** | Railway → **worker-delta**: Running? `deltaLastPolledAt` trên `/admin/health` có mới < 15 phút? `DELTA_POLLING_ENABLED` = true? |
| 4 | **Subscriptions hết hạn / chưa từng tạo (webhook path chết)** | F1: không code nào tạo subscription; renewal chỉ gia hạn cái đã có; nếu subscription tạo thủ công trước đây đã hết hạn ⇒ webhook chết fleet-wide | Không giải thích một mình được (delta vẫn có thể chạy); là điều kiện nền chứ không phải "sự kiện cuối tháng 7" | **TRUNG BÌNH** | `/admin/health` check **Subscription renewal**: EXPIRED? có row `GraphSubscription` nào không? worker-renewal Running? |
| 5 | **Renewal worker stopped** | Nếu subscription từng sống nhờ renewal, renewal dừng → hết hạn trong ≤6 ngày → webhook chết | Chỉ tác động webhook path; delta vẫn độc lập | **TRUNG BÌNH** | Railway → **worker-renewal** Running? `lastRenewalRunAt`/`lastRenewedAt` trên health? |
| 6 | **Persistent 403 cooldown skip toàn fleet (TASK-075)** | Nếu mọi mailbox dính 403 app-level → delta skip cả fleet | Cần 403 đồng loạt; để lại `deltaLastError…` rõ; không làm câm webhook | **THẤP-TRUNG BÌNH** | `/admin/health` xem `deltaLastErrorMessage` (code=…, http=403) trên nhiều mailbox? |
| 7 | **Graph OAuth/refresh token failure (diện rộng)** | Có thể chặn cả 3 worker | TASK-069C phân loại transient để tránh false reconnect; nếu worker chạy vẫn ghi Audit/CodeEvent; không giải thích 0 event tuyệt đối | **THẤP** | worker log có `RefreshAccessTokenError`? mailbox chuyển RECONNECT_REQUIRED hàng loạt? |
| 8 | **Graph 403/permission (tenant/app)** | Có thể chặn cả webhook lẫn delta | Để lại dấu vết lỗi; nếu worker chạy vẫn có event FAILED | **THẤP** | health `deltaLastError…`; kiểm tra app registration/permission (thủ công, ngoài repo) |
| 9 | **Webhook notification/enqueue issue** | Nếu enqueue fail hàng loạt | TASK-073: enqueue fail → 503 → redeliver; không nuốt lặng; và webhook không phải đường chính (F1) | **THẤP** | web log: tỉ lệ 503 webhook? `enqueueFailed` > 0? |
| 10 | **Detector/extractor regression** | — | **Loại trừ:** sẽ tạo `DETECTOR_REJECTED` (log không thể trống); không đổi code detector sau 2026-06-04 | **RẤT THẤP (loại)** | (không cần) |
| 11 | **TASK-078 RBAC regression** | — | **Loại trừ:** không chạm `findActiveMappingForMailbox` của worker; chưa deploy; chỉ docs commit | **RẤT THẤP (loại)** | Đối chiếu diff TASK-078 (mục F) |
| 12 | **DB/log persistence issue** | Nếu DB write CodeEvent hỏng → log trống dù relay chạy | Nhưng Telegram vẫn phải nhận code (không); worker ghi fire-and-forget nhưng ProcessedMessage/dedup dùng cùng DB — nếu DB chết, relay cũng chết ⇒ vẫn quy về "không xử lý"; DB "connected" theo báo cáo | **THẤP** | Railway → **PostgreSQL** Running? worker log lỗi Prisma/connection? |

## 5. Kết luận phân loại

> **CẬP NHẬT SAU RUNTIME EVIDENCE (xem mục 0A):** kết quả xác nhận là **#3 — worker-delta**,
> nhưng ở dạng **STUCK CYCLE** (process vẫn active, scheduler tự khoá), **không** phải
> "#1 email worker stopped". **#2 Redis mismatch đã bị LOẠI** bởi runtime evidence. Nội
> dung xếp hạng dưới đây là suy luận ban đầu (trước evidence), giữ làm hồ sơ.

- ✅ **ROOT CAUSE (confirmed): #3 (biến thể) — worker-delta stuck trong một poll cycle**
  → producer bị khoá → 0 job enqueue → 0 Code Event; mailbox mới (không webhook, phụ
  thuộc delta — F1) câm hoàn toàn. Restart riêng worker-delta phục hồi.
- ❌ **#1 Email worker stopped** — *KHÔNG đúng*: worker-email vẫn khỏe, xử lý ngay khi có
  job trở lại. (Giả thuyết ban đầu đặt sai Primary; đúng "họ nguyên nhân" nhưng sai cơ chế.)
- ❌ **#2 Redis mismatch/mất kết nối** — *LOẠI*: cấu hình đồng nhất; recovery không đổi
  variable.
- **~~Secondary (ban đầu)~~:** ~~#3 worker-delta dừng; #4/#5 subscription hết hạn + renewal
  dừng.~~ #4/#5 là **điều kiện nền có thật** (F1: renewal không có candidate) nhưng
  **không** phải sự kiện gây incident; đường sống thực tế là delta polling, và chính nó
  bị stuck.
- **Giả thuyết đã loại trừ (dựa trên code/diff, không suy đoán — vẫn đúng sau evidence):**
  - **#10 Detector/extractor regression** — sẽ luôn ghi `DETECTOR_REJECTED`; log không thể
    trống; không có thay đổi code.
  - **#11 TASK-078 RBAC** — không đụng runtime resolution của worker; chưa deploy.
  - **#9 Webhook nuốt lỗi** — TASK-073 đã đảm bảo 503 + redeliver.
  - **Mailbox/token là nguyên nhân gốc** — bị loại theo yêu cầu **và** theo bằng chứng:
    token lỗi vẫn để lại Audit/CodeEvent nếu worker chạy; "connected" chỉ là cờ DB.

## 6. Checklist Railway cho người vận hành (tự kiểm tra — KHÔNG paste secret)

> Mục tiêu: xác định service nào chết và queue có backlog không. **Không** cần dán bất kỳ
> secret/URL/token nào cho AI. Chỉ đọc trạng thái + vài dòng log an toàn.

### 6.1. worker-email (ƯU TIÊN CAO NHẤT)
```
[ ] Trạng thái service: Running / Stopped / Crashed?  (kỳ vọng: Running)
[ ] Deployment gần nhất: timestamp? có redeploy/restart quanh CUỐI THÁNG 7 không?
[ ] Có crash-loop / restart liên tục không? (Deployments → Activity)
[ ] Log khởi động có dòng "Email worker started — consuming Microsoft Graph message jobs"?
[ ] Log có "Email worker entry failed" / lỗi kết nối Redis / MissingEnvError / lỗi Prisma?
[ ] (An toàn) Có dòng "Email worker received Microsoft Graph notification" gần đây không?
    → KHÔNG có = worker không nhận job.
```

### 6.2. worker-delta
```
[ ] Running / Stopped / Crashed?
[ ] Log có "Delta polling scheduler started"? và "Delta polling cycle finished" định kỳ?
[ ] Log warn "Delta polling is disabled via DELTA_POLLING_ENABLED"? (⇒ bị tắt)
[ ] deployment timestamp / crash-loop?
```

### 6.3. worker-renewal
```
[ ] Running / Stopped / Crashed?
[ ] Log "Subscription renewal scheduler started"? "single cycle completed" định kỳ?
[ ] Log warn "Subscription renewal is disabled via SUBSCRIPTION_RENEWAL_ENABLED"?
```

### 6.4. web
```
[ ] Running?
[ ] Log webhook: có "Microsoft webhook notification batch handled" gần đây? (received/accepted/enqueued)
[ ] Có "enqueueFailed" > 0 hoặc trả 503 hàng loạt? (⇒ nghi Redis từ phía producer)
```

### 6.5. Redis
```
[ ] Running? bị tái tạo / đổi credential / restart gần đây (quanh cuối tháng 7)?
[ ] So sánh biến REDIS_URL giữa service web và worker-email: TRỎ CÙNG MỘT Redis?
[ ] So sánh biến EMAIL_QUEUE_NAME giữa web và worker-email: GIỐNG nhau? (mặc định email-processing)
[ ] (Nếu dashboard/health có) queue backlog: số job "waiting"/"delayed" lớn bất thường?
    → backlog lớn + worker-email không tiêu thụ = xác nhận Primary #1.
```

### 6.6. PostgreSQL
```
[ ] Running? bị restart/đổi credential gần đây?
[ ] worker log có lỗi kết nối Prisma/DB không?
[ ] So sánh DATABASE_URL giữa web và các worker: cùng một DB? (log trống có thể do worker
    ghi vào DB khác với DB mà trang Logs đọc — ít khả năng nhưng nên loại trừ)
```

### 6.7. Trang /admin/health (đọc trong app, nhanh nhất)
```
[ ] Operational check "Email worker pipeline": trạng thái? (lưu ý: chỉ kiểm tra wiring
    tĩnh, KHÔNG chứng minh worker đang chạy — vẫn phải xem Railway service ở 6.1)
[ ] "Delta polling": PASS hay WARNING "backup poller may not be running"?
[ ] "Subscription renewal": có subscription nào? EXPIRED?
[ ] "Queue / Redis": REDIS_URL configured?
[ ] Overview: lastProcessedEmailAt / lastPollingRunAt / lastRenewalRunAt / lastCodeSentAt
    → mốc thời gian CUỐI CÙNG rơi vào ~cuối tháng 7 = trùng thời điểm im lặng.
[ ] Nhiều mailbox có deltaLastErrorMessage (http=403 …)? (⇒ cân nhắc #6)
```

## 7. Minimal fix cho TASK KẾ TIẾP (KHÔNG làm trong TASK-079)

> **Đã xác nhận nguyên nhân (mục 0A) ⇒ hướng chính là TASK-080 bên dưới.** Các nhánh
> điều kiện #x giữ lại làm tham chiếu chẩn đoán tổng quát.

**→ TASK-080 (đề xuất, ưu tiên) — Delta stuck-cycle recovery + stale message protection:**
- **Chống stuck vô hạn:** thêm **timeout / AbortController** cho mọi Graph/token HTTP
  request trong `runDeltaPollingOnce`, và/hoặc **watchdog** cho scheduler (nếu một tick
  chạy quá ngưỡng thời gian → coi là stuck, log CRITICAL, reset `inflight` hoặc để tick
  bị bỏ qua chuyển thành cảnh báo có thể phát hiện). Mục tiêu: một cycle **không bao giờ**
  khoá scheduler vô thời hạn; nếu bị khoá, hệ thống tự phát hiện + tự phục hồi + alert.
- **Stale message protection:** sau downtime dài, drop/skip message quá tuổi (theo
  `receivedDateTime`) để không relay verification code đã hết hạn; ghi Code Event dạng
  skip (`SKIPPED_*`/stale) thay vì gửi.
- **Observability:** health check delta polling nên dựa trên **`deltaLastPolledAt` +
  phát hiện log "skipping tick" lặp**, không chỉ "process Running" (bài học mục 0A).

**→ Task riêng sau TASK-080 — Graph subscription wiring (finding F1):** wire
`createInboxSubscription` vào luồng connect (hoặc reconcile job cho mailbox ACTIVE thiếu
subscription) để đường webhook thực sự tồn tại và renewal có candidate.

Nhánh điều kiện tổng quát (tham chiếu, thứ tự tùy triệu chứng nếu tái diễn):

- **Nếu #1/#2 (worker-email / Redis):** khởi động lại / sửa cấu hình service worker-email;
  đảm bảo `REDIS_URL` + `EMAIL_QUEUE_NAME` + `DATABASE_URL` **đồng nhất** giữa web và mọi
  worker. Thêm **healthcheck/liveness thật cho worker** (heartbeat vào Redis/DB) để lần sau
  phát hiện worker chết mà không cần đợi 3 tuần — hiện `classifyEmailWorkerWiring` chỉ soát
  wiring tĩnh (đề xuất: task "worker heartbeat + alert khi im lặng").
- **Nếu #3 (worker-delta):** khởi động lại; kiểm tra `DELTA_POLLING_ENABLED`.
- **Nếu #4/#5 (subscription):** **gap kiến trúc F1** — không có đường tạo subscription tự
  động. Đề xuất task riêng: **wire `createInboxSubscription` vào luồng connect mailbox**
  (hoặc một reconcile job tạo/tái tạo subscription cho mailbox ACTIVE thiếu subscription),
  và bật renewal. Trước mắt hệ thống vẫn có thể sống nhờ delta polling nếu worker-delta chạy.
- **Nếu #6 (403 cooldown):** điều tra mã lỗi Graph cụ thể (đã có `deltaLastErrorMessage`
  sanitized), xử lý ở tầng app registration/permission — ngoài phạm vi sửa code.

**Không** thực hiện bất kỳ mục nào ở trên trong TASK-079.

## 8. Việc cần Antigravity CLI review

- **Xác nhận cơ chế root cause đã confirm (mục 0A):** trong `startDeltaPollingScheduler`
  (`delta-polling-runner.ts`), `inflight` chỉ clear trong `finally` sau khi `await`
  `runDeltaPollingOnce`; và `runDeltaPollingOnce` dùng native `fetch` **không timeout**
  cho token/Graph request. Nhờ review chéo để xác nhận đây đúng là con đường khiến một
  request treo → `inflight` không bao giờ clear → mọi tick sau bị skip (khớp log
  `skipping tick - previous tick still running`). Xác nhận đây là phạm vi **TASK-080**,
  không thuộc TASK-079.
- Xác nhận **runtime evidence loại được** giả thuyết Redis mismatch và giả thuyết
  "email worker stopped" (worker-email vẫn xử lý sau recovery).
- Xác nhận **kết luận loại trừ**: (a) detector/extractor không thể gây "zero code event";
  (b) TASK-078 không chạm runtime resolution của worker (`findActiveMappingForMailbox` không
  có scope) và chưa deploy; (c) TASK-073 đảm bảo webhook không nuốt lỗi.
- Xác nhận **phát hiện F1** (không có production caller nào gọi `createInboxSubscription`) —
  đây là nhận định quan trọng nhất về mặt kiến trúc; nhờ review chéo để chắc chắn không bỏ
  sót một caller (route/script/server action) nào.
- Xác nhận **ranh giới producer↔consumer chỉ qua Redis** và rủi ro mismatch env giữa web và
  worker là giả thuyết #2 hợp lệ.
- Xác nhận báo cáo **sạch secret** và không kích hoạt CI secret-scan.
- Kết luận **PASS/FAIL** theo `ANTIGRAVITY.md` cho tính đúng đắn của chẩn đoán (đây là task
  điều tra, không có thay đổi runtime để review).

## 9. Ràng buộc đã tuân thủ

- KHÔNG sửa runtime code / deployment config. KHÔNG restart service. KHÔNG chạy worker local
  trỏ production/staging. KHÔNG thao tác production DB. KHÔNG đọc/in `.env*`. KHÔNG in
  secret/token/refresh token/client secret/Telegram bot token/verification code đầy đủ/full
  email body. KHÔNG commit, KHÔNG push. Chỉ thêm 2 file docs (task + report).
