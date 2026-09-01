# TASK-092 — Email Worker Microsoft Graph HTTP Timeout & Cancellation Hardening

> **Phase 1 — INVESTIGATION / ARCHITECTURE ONLY.** Chưa có implementation, chưa sửa test,
> chưa commit/push, chưa cập nhật ROADMAP, không thao tác Railway.
> Tài liệu này là kết quả trace code thật tại HEAD hiện tại (kết quả TASK-091 đã hoàn tất).
> Sanitized: không chứa secret thật, không access/refresh-token, không client secret,
> không connection string, không verification code đầy đủ, không full email body.

---

## §1. Mục tiêu và scope

**Câu hỏi trung tâm:** các Microsoft HTTP operations trên runtime path của worker-email
đã có finite timeout và cancellation thật (AbortController, signal tới native request)
hay chưa? Nếu chưa, một request treo gây hậu quả gì cho BullMQ job, mailbox lock,
concurrency capacity, và các invariant của TASK-085/090/091?

**Bối cảnh:** TASK-080 đã harden hai HTTP seam trên **delta-polling path** bằng
`fetchWithTimeout` (AbortController thật, 20s) sau sự cố scheduler wedge (TASK-079).
Báo cáo TASK-080 §2 ghi rõ (nguyên văn, đã xác minh lại bằng code):

- `refreshMicrosoftAccessToken` là shared service; option `timeoutMs` mặc định
  **không timeout** — email worker/OAuth/renewal chưa opt-in.
- Graph fetch của email worker (`graph-mail.service.ts`) **không có timeout** —
  được ghi nhận là deferred finding, ngoài phạm vi TASK-080.

TASK-092 chính là follow-up của deferred finding đó, giới hạn đúng worker-email path.

**Ngoài scope** (xem §13): OAuth connect/callback exchange, worker-delta (đã xử lý
TASK-080), Telegram sender (đã xử lý TASK-090), ErrorQuotaExceeded (đã điều tra
TASK-091 — verdict NO CHANGE), subscription provisioning, routing, detector/extractor,
RBAC, Railway, mailbox-lock redesign.

---

## §2. Exact worker-email execution path (code hiện tại tại HEAD)

Trace theo code thật, không theo tài liệu cũ. Ký hiệu: `pipeline` =
`services/email/graph-message-pipeline.service.ts`; `runner` =
`services/queue/workers/email-worker-runner.ts`; `worker` =
`services/queue/workers/email-worker.ts`.

| # | Bước | File / function | Await? | Resource đang giữ | Error đi đâu | Cleanup |
|---|------|-----------------|--------|-------------------|--------------|---------|
| 1 | BullMQ Worker nhận job | `worker createEmailWorker` (dòng 253–298); processor = `processEmailWebhookJob` | — | BullMQ job lock (auto-renew, xem §4) + 1 concurrency slot | `worker.on('failed')` log tên error | BullMQ settle |
| 2 | Job-name guard + build pipeline lazy | `worker processEmailWebhookJob` (158–166); `resolveDefaultPipeline` → `runner buildDefaultEmailPipeline` (373) | await (import động) | như trên | unknown name ⇒ return `{acknowledged:true}` | — |
| 3 | Validate payload | `pipeline normalizeJob` (302) qua `processGraphMessageJob` (466) | sync | như trên | invalid ⇒ return `FAILED_UNEXPECTED` (không throw) | — |
| 4 | **Mailbox lock acquire** | `pipeline` 504–525, `acquireMailboxLockWithFairness` (265); backend qua `runner` 62–63 → `createMailboxProcessingLock()` **không có redisClient ⇒ in-memory** (`mailbox-lock-factory.ts` 43–55) | await | + mailbox lock (TTL 60s, `mailbox-processing-lock.ts` 22, **không renewal**) | busy ⇒ return `DEFERRED_MAILBOX_BUSY` (worker throw ⇒ BullMQ retry) | release trong `finally` (pipeline 527–534) |
| 5 | Mailbox lookup + ACTIVE guard | `pipeline` 550–592; `runner createPrismaMailboxLookupPort` (154) | await (Prisma) | job lock + slot + mailbox lock | lookup lỗi ⇒ `FAILED_UNEXPECTED`; not-ACTIVE ⇒ skip | finally release lock |
| 6 | **Access-token acquisition (HTTP #1)** | `pipeline` 595–646 → `runner createPrismaEmailAccessTokenPort.getAccessTokenForMailbox` (221–281): DB read → `decryptSecret` → `refreshMicrosoftAccessToken(plaintext)` (**dòng 255, KHÔNG truyền `timeoutMs`**) | await | như bước 5 | classify qua `EmailWorkerTokenError.classification` (§7): transient ⇒ `FAILED_TOKEN_TRANSIENT`; reconnect ⇒ mark + `FAILED_RECONNECT_REQUIRED` | finally release lock |
| 7 | Rotated credential persistence (TASK-085 CAS) | `runner` 272–277 → `persistRotatedRefreshToken` (`refresh-token-rotation.service.ts` 101–174, conditional `updateMany`) | await (Prisma) | như trên | DB infra error ⇒ sanitized throw ⇒ classify transient; CAS thua (count 0) ⇒ discard, KHÔNG lỗi | — |
| 8 | **Graph message fetch (HTTP #2)** | `pipeline` 648–689 → `runner graphMessageFetchPort.fetchMessage` (287–291) → `getMessageById` (`graph-mail.service.ts` 313–344) → `performGraphRequest` (236–273): **`fetchImpl = fetch` native, KHÔNG timeout, KHÔNG signal** | await | như trên | `GraphMailError` map qua `mapGraphErrorToResult` (420): 401/auth ⇒ mark reconnect + `FAILED_RECONNECT_REQUIRED`; còn lại (kể cả network) ⇒ `FAILED_GRAPH_FETCH` | finally release lock |
| 9 | Early dedup (status-aware, TASK-090) | `pipeline` 711–818 (`findByGraphMessageId` / `findByInternetMessageId`, `isDeliveryRecoverableRow`) | await (Prisma) | như trên | terminal row ⇒ `SKIPPED_DUPLICATE`; unfinished ⇒ recovery candidate | — |
| 10 | Stale guard TASK-080 (30 phút) | `pipeline` 820–885 | sync + await (terminalize) | như trên | stale ⇒ `SKIPPED_STALE` | — |
| 11 | Detector / extractor | `pipeline` 887–1027 | sync | như trên | skip statuses | — |
| 12 | **ProcessedMessage identity claim** | `pipeline` 1046–1143 → `claimMessageForProcessing` (deduplication.service) | await (Prisma) | như trên | duplicate ⇒ skip / recovery | — |
| 13 | **Delivery-ownership claim (TASK-090)** | `pipeline` 1145–1236 → `acquireDeliveryOwnership` (lease 5 phút, `delivery-ownership-policy.ts` 46) | await | như trên | not claimable ⇒ `SKIPPED_DUPLICATE` | — |
| 14 | Post-claim freshness re-check | `pipeline` 1238–1288 | await | + delivery lease | stale ⇒ `markFailedByOwner` + `SKIPPED_STALE` | — |
| 15 | Telegram mapping lookup | `pipeline` 1290–1340 | await (Prisma) | như trên | no mapping ⇒ `releaseDelivery` + skip | — |
| 16 | Throttles + **Telegram send (đã có timeout 15s — TASK-090)** | `pipeline` 1342–1488 → `telegram-retry.service` → `telegram-sender.service` (`TELEGRAM_HTTP_TIMEOUT_MS = 15_000`, dòng 33) | await | như trên | permanent ⇒ `markFailedByOwner` + return; retryable ⇒ `releaseDelivery` + `FAILED_TELEGRAM_SEND` (throw ⇒ retry) | — |
| 17 | `markMessageAsSent` (CAS theo owner) | `pipeline` 1490–1517 | await | như trên | lỗi ⇒ log, KHÔNG undo delivery | — |
| 18 | Audit/code-event | `runner createDbAuditPort` (312–329) | **fire-and-forget** (`void …catch`) | — | swallow + warn | — |
| 19 | Kết thúc | `worker` 215–227: transient statuses ⇒ throw `EmailWorkerProcessingError` ⇒ BullMQ retry; còn lại return | — | — | — | finally release mailbox lock (đã chạy ở 4) |

**Kết luận thứ tự (quan trọng cho §6):** cả hai Microsoft HTTP operations (bước 6 và 8)
xảy ra **trước** ProcessedMessage identity claim (bước 12) và **trước** delivery-ownership
claim (bước 13), **trong khi giữ** mailbox lock + BullMQ job lock + 1 concurrency slot,
và **trước** mọi terminal status write của message hiện tại.

---

## §3. Inventory external HTTP operations trên worker-email path

Chỉ có **hai** external HTTP operations được await trước Telegram trên runtime path
(xác minh bằng repo-wide search cho `fetch(`, `fetchWithTimeout`, `AbortController`,
`signal`, `Promise.race` trong `services/` — không còn seam HTTP nào khác được
worker-email attempt await; DB/Redis là Prisma/ioredis, ngoài scope Microsoft HTTP).
OAuth connect/callback exchange (`oauth-token-exchange.service.ts`) không được
worker-email runtime gọi ⇒ ngoài scope.

### HTTP #1 — Microsoft token-endpoint refresh (login.microsoftonline.com)

| Thuộc tính | Evidence |
|---|---|
| Caller | `runner createPrismaEmailAccessTokenPort` dòng 255 |
| Implementation | `refreshMicrosoftAccessToken` (`refresh-access-token.service.ts` 71–185) |
| HTTP helper | `fetchWithTimeout` (dòng 107–119) |
| Timeout value trên email path | **KHÔNG CÓ** — caller không truyền `timeoutMs`; helper pass-through khi option không positive-finite (`fetch-with-timeout.ts` 59–62) ⇒ native fetch không AbortController |
| Timeout đặt ở đâu | Shared helper hỗ trợ, **caller quyết định**; delta runner truyền 20s (`delta-polling-runner.ts` 223–225), email runner không truyền |
| Cancellation thật? | Có sẵn trong helper (AbortController + `controller.abort()`, signal tới native fetch — `fetch-with-timeout.ts` 64–72) nhưng **không kích hoạt** vì không có timeoutMs |
| Behavior khi caller cung cấp signal | `init` không nhận signal từ caller nào trên path này; helper ghi đè `signal` khi có timeout (limitation đã biết của helper, không ảnh hưởng path này) |
| Timer cleanup | `clearTimeout` trong `finally` (helper dòng 80–82) — chỉ áp dụng khi có timeout |
| Pending vô hạn? | **CÓ THỂ** — native fetch không có timeout mặc định; TCP treo ⇒ promise pending vĩnh viễn (đúng cơ chế TASK-079/080 đã chứng minh trên delta path) |
| Error khi timeout/abort (nếu bật) | `HttpTimeoutError` ⇒ catch tại service (120–126) ⇒ `RefreshAccessTokenError('network')` |
| Classification downstream | `classifyRefreshTokenError` (`refresh-token-failure.ts` 44–64): network ⇒ `transient` ⇒ pipeline `FAILED_TOKEN_TRANSIENT` (retryable, KHÔNG reconnect) |
| Side effect | Rotation persist (TASK-085 CAS) chỉ chạy **sau** khi response parse thành công (runner 253–277) — timeout/hang ⇒ không ghi credential |
| Resource giữ khi await | BullMQ job lock (auto-renew) + concurrency slot + mailbox lock (TTL 60s, không renewal) |
| Ghi chú thêm | `response.json()` (service dòng 130) nằm **ngoài** cửa sổ abort của helper (timer đã clear sau khi headers về) — body-read không bị chặn trần, giống hệt delta path (precedent TASK-080 đã chấp nhận) |

### HTTP #2 — Graph getMessageById (graph.microsoft.com)

| Thuộc tính | Evidence |
|---|---|
| Caller | `runner graphMessageFetchPort.fetchMessage` (287–291) ← `pipeline` 650 |
| Implementation | `getMessageById` (`graph-mail.service.ts` 313–344) → `performGraphRequest` (236–273) |
| HTTP helper | **Không có** — `fetchImpl` mặc định là `fetch` native (dòng 322) gọi trực tiếp (dòng 245), `GetMessageOptions` không có trường timeout |
| Timeout value | **KHÔNG CÓ** ở mọi tầng (caller/callee/helper) |
| AbortController / signal | **KHÔNG CÓ** — `init` chỉ gồm method + headers |
| Pending vô hạn? | **CÓ THỂ** — như trên |
| Error khi network reject | catch-all (249–253) ⇒ `GraphMailError('network', 'GRAPH_NETWORK_ERROR')` |
| Classification downstream | `mapGraphErrorToResult` (pipeline 420–464): mọi kind ≠ `auth` ⇒ `FAILED_GRAPH_FETCH` (retryable, không reconnect, không tăng counter nào) |
| Retry side effect | worker throw ⇒ BullMQ retry theo attempts/backoff (§8) |
| Resource giữ khi await | như HTTP #1 |
| Ghi chú thêm | `response.json()` (dòng 266) cũng không có trần — cùng gap với body-read ở trên |

### Mốc so sánh (không sửa trong task này)

| Seam | Timeout | Cancellation | Nguồn |
|---|---|---|---|
| Graph delta + token refresh (delta path) | 20s (`DELTA_POLLING_HTTP_TIMEOUT_MS`, `delta-polling.service.ts` 49) | AbortController thật | TASK-080 |
| Telegram send | 15s (`TELEGRAM_HTTP_TIMEOUT_MS`, `telegram-sender.service.ts` 33) | AbortController thật | TASK-090 |
| Subscription provisioning/reconciliation | 20s (`CONNECT_SUBSCRIPTION_HTTP_TIMEOUT_MS`) | AbortController thật | TASK-081 vùng lân cận |

**Phân loại theo yêu cầu đề bài:** cả hai seam email thuộc nhóm
"**helper hỗ trợ timeout nhưng caller email không truyền**" (HTTP #1) và
"**không có bất kỳ cơ chế timeout/cancellation nào**" (HTTP #2). Không có chỗ nào
dùng Promise.race-không-cancel; không có timeout "chỉ trên type"; không có timeout
mặc định từ thư viện (native fetch/undici không tự áp trần hữu hạn cho một kết nối
đã established bị treo).

---

## §4. Graph message fetch hang analysis

Kịch bản: `getMessageById` pending vô hạn (TCP treo). Evidence-based:

1. **BullMQ job promise không settle.** Processor `processEmailWebhookJob` await
   pipeline (worker 180) ⇒ promise pending.
2. **Concurrency slot bị giữ.** BullMQ Worker giữ slot cho job đang active.
3. **BullMQ job lock ĐƯỢC tự renew khi processor còn pending.** Evidence từ
   `node_modules/bullmq` (v5.77.x): Worker defaults
   `lockDuration: 30000, stalledInterval: 30000, maxStalledCount: 1`,
   `lockRenewTime = lockDuration / 2` (`classes/worker.js` dòng 34, 63–64), và
   `classes/lock-manager.js` chạy `startLockExtenderTimer` lặp `extendLocks` cho mọi
   job đang active (dòng 28, 60–82). `createEmailWorker` không override các option này
   (worker 272–280: chỉ connection/concurrency/limiter).
4. **Stalled detector KHÔNG cứu được.** Stalled chỉ đánh dấu khi job lock hết hạn —
   tức process chết hoặc event loop bị block. Một HTTP promise pending không block
   event loop ⇒ lock extender vẫn chạy ⇒ job không bao giờ stalled, không bao giờ
   settle, không retry. Đây là xác nhận bằng code semantics, không phải giả định.
5. **Mailbox lock bị giữ nhưng có TTL 60s, không renewal.** In-memory lock
   (`mailbox-processing-lock.ts` 89–98): sau 60s, lease coi như expired ⇒ job khác
   của **cùng mailbox** acquire được. Release trong `finally` của job treo chỉ chạy
   nếu pipeline settle (không bao giờ, khi hang); guard `heldUntil.get(key) === myExpiry`
   (dòng 108) bảo đảm job treo không xoá lease của người kế nhiệm.
6. **Late side effect sau TTL:** nếu request treo cuối cùng resolve (ví dụ sau 10
   phút), pipeline của job cũ **tiếp tục chạy** song song với job mới của cùng
   mailbox. An toàn nhờ các tầng sau: stale guard 30 phút (pipeline 827–885),
   identity claim unique constraint (TASK-068A), delivery-ownership CAS + post-claim
   freshness re-check (TASK-090). Kết quả xấu nhất là double-work, không phải
   duplicate delivery — nhưng chỉ khi request "resolve muộn"; một request treo mãi
   thì giữ slot mãi. Lưu ý: cửa sổ hai-attempt-cùng-mailbox sau TTL không phải chỉ
   do hang — nó tồn tại cả với attempt hợp lệ dài (Telegram retry phase), xem §10.1
   và DF-92-6.
7. **Blast radius:** một hang chiếm 1 slot. `EMAIL_WORKER_CONCURRENCY` mặc định **2**
   (`lib/env.ts` 184), cap 20 (dòng 189). **2 simultaneous hangs ⇒ mất toàn bộ
   capacity của worker-email**: mọi mailbox khác ngừng được xử lý (job xếp hàng chờ
   slot), dù process vẫn "sống" và health check kiểu liveness không phát hiện —
   đúng failure mode TASK-079 nhưng ở consumer thay vì scheduler.
8. **Restart/process death:** job lock hết hạn sau ≤30s ⇒ stalled detector của worker
   mới đánh dấu stalled ⇒ retry (tối đa `maxStalledCount: 1` lần stalled) ⇒ hệ tự hồi
   phục **chỉ bằng restart**, không tự hồi phục khi process còn sống.

**Phân biệt 4 khái niệm (theo yêu cầu):** BullMQ job lock (Redis, auto-renew bởi lock
extender) ≠ distributed mailbox lock (ở đây là in-memory TTL 60s; Redis-backed tồn tại
sau seam `mailbox-lock-factory` nhưng CHƯA được wire trong production — runner 62–63)
≠ in-process concurrency slot (BullMQ Worker) ≠ job attempt lifecycle (attempts/backoff
trong `email-job-options.ts`).

---

## §5. Token refresh hang analysis

- Email access-token port (`runner` 221–281) → `refreshMicrosoftAccessToken` **không
  truyền `timeoutMs`** (dòng 255) — trong khi delta path truyền 20s
  (`delta-polling-runner.ts` 223–225). Default của shared service: **không timeout**
  (pass-through, `fetch-with-timeout.ts` 59–62; comment tại
  `refresh-access-token.service.ts` 43–47 ghi rõ email worker chưa opt-in).
- Khi bật timeout: signal **tới native fetch thật** (helper spread `signal` vào init,
  dòng 72); timeout ⇒ `HttpTimeoutError` ⇒ `RefreshAccessTokenError('network')`
  (service 120–126) ⇒ `classifyRefreshTokenError` ⇒ `transient` ⇒
  `EmailWorkerTokenError(classification='transient')` ⇒ pipeline
  `FAILED_TOKEN_TRANSIENT` (602–614) ⇒ worker throw ⇒ BullMQ retry. **KHÔNG** mark
  RECONNECT_REQUIRED (`shouldMarkReconnectRequired` chỉ true cho classification
  `reconnect_required`).
- Hang xảy ra khi đang giữ: mailbox lock + job lock + slot — **giống hệt** Graph fetch
  hang (§4); impact không khác vì cùng vị trí tương đối trong pipeline (trước mọi claim).

**Interaction với TASK-085 (credential-generation CAS):**

| Yêu cầu | Kết luận (code evidence) |
|---|---|
| Timeout không đổi expected-generation CAS | ĐÚNG — `expectedGeneration` đọc trước refresh (runner 240); timeout ném trước khi tới `persistRotatedRefreshToken` (272) ⇒ không có write nào |
| Timeout không thành CAS conflict | ĐÚNG — CAS conflict chỉ tồn tại khi `updateMany` chạy và `count === 0` (`refresh-token-rotation.service.ts` 160–169); timeout không chạy tới đó |
| Không persist partial/unknown credential | ĐÚNG — persist chỉ chạy sau khi `exchanged` parse thành công đầy đủ (service 149–184 validate required fields trước khi return) |
| Không mất reconnect priority | ĐÚNG — timeout là `transient`, không đụng status; luồng OAuth reconnect (W1) và revoked-grant classification giữ nguyên |
| CAS-loser không thành auth failure | ĐÚNG — CAS thua return `{casLost:true}` không throw; timeout là nhánh khác hẳn (throw trước persist) |
| Credential state khi timeout trước khi Microsoft response hoàn tất | DB giữ nguyên G0 (không ghi). Về phía Microsoft: theo external verification TASK-085 §3, Microsoft không auto-revoke refresh-token cũ khi mint token mới ⇒ kể cả khi Microsoft ĐÃ rotate ở phía server mà response bị abort, G0 trong DB vẫn dùng được cho attempt sau. Không có cửa sổ brick |
| Abort race với response muộn | Với `fetchWithTimeout`, abort tear down socket ⇒ promise reject; không có code path nào tiếp tục đọc response sau abort (helper reject trước khi caller đọc body) ⇒ không có late-persist |

---

## §6. Interaction với TASK-090

Vị trí của hai HTTP seam so với các mốc TASK-090 (từ execution trace §2):

| Sự kiện timeout | Trước/sau ProcessedMessage identity | Trước/sau delivery-ownership claim | Trước/sau detector/extractor | Trước/sau terminal status write |
|---|---|---|---|---|
| Token refresh timeout (bước 6) | **TRƯỚC** (claim ở bước 12) | **TRƯỚC** (bước 13) | TRƯỚC | TRƯỚC — không row nào được tạo/sửa cho message này |
| Graph fetch timeout (bước 8) | **TRƯỚC** | **TRƯỚC** | TRƯỚC | TRƯỚC |
| (Mốc so sánh) Telegram timeout — TASK-090, không sửa | SAU (row tồn tại, DETECTED) | SAU (lease đang giữ) | SAU | Retryable ⇒ `releaseDelivery` rồi throw; permanent ⇒ `markFailedByOwner` |

Hệ quả cho từng trường hợp Graph/token timeout:

- ProcessedMessage: **chưa tồn tại** (job đầu tiên) hoặc tồn tại từ attempt/flow trước
  với status cũ — timeout hiện tại không tạo/sửa row.
- Delivery lease: **chưa tồn tại** cho attempt này; không lease nào bị giữ bởi attempt
  bị timeout.
- BullMQ retry nhìn thấy: state y như trước attempt (không row mới, không lease mới)
  ⇒ retry đi lại từ đầu pipeline, claim đúng như thiết kế TASK-090.
- Nguy cơ mark FAILED sai: **KHÔNG** — không code path nào ghi FAILED từ nhánh
  `FAILED_GRAPH_FETCH`/`FAILED_TOKEN_TRANSIENT` (chỉ log + return status).
- Nguy cơ duplicate delivery: **KHÔNG** — chưa tới send path; exactly-once vẫn do
  identity claim + ownership CAS đảm nhiệm.

**Kết luận:** vì cả hai HTTP ops nằm hoàn toàn trước identity/delivery claim, Phase 2
KHÔNG cần thêm state machine mới, không đụng DETECTED→SENT/FAILED CAS, không đụng
lease/reclaim semantics. Yêu cầu duy nhất: timeout phải map vào đúng hai status
retryable sẵn có (`FAILED_GRAPH_FETCH`, `FAILED_TOKEN_TRANSIENT`) — chính là behavior
mặc định của classifier hiện tại (§7).

---

## §7. Error classification

Trace classifier hiện tại (code evidence):

| Failure | Error type | Map thành | Retry? | Reconnect? | Đúng cho timeout? |
|---|---|---|---|---|---|
| Graph network failure | `GraphMailError('network')` (graph-mail 249–253) | `FAILED_GRAPH_FETCH` (pipeline 445–453) | throw ⇒ BullMQ retry | Không | — |
| Graph timeout/abort (Phase 2, qua `fetchWithTimeout`) | `HttpTimeoutError` reject fetch ⇒ rơi vào **cùng catch-all** ⇒ `GraphMailError('network')` | `FAILED_GRAPH_FETCH` | Có | Không | **Đúng về outcome**; mất type precision (không phân biệt timeout vs DNS fail) — chỉ là observability gap, không phải sai behavior |
| Refresh network failure | `RefreshAccessTokenError('network')` | `transient` ⇒ `FAILED_TOKEN_TRANSIENT` | Có | Không | — |
| Refresh timeout/abort | `HttpTimeoutError` ⇒ catch (service 120–126) ⇒ `network` | `transient` ⇒ `FAILED_TOKEN_TRANSIENT` | Có | Không | Đúng — đã có precedent chạy thật trên delta path (TASK-080) |
| Real 401 | `GraphMailError('auth')` (401 ⇒ `mapHttpStatusToError` 155–157) | `FAILED_RECONNECT_REQUIRED` + mark | Có (throw) | CÓ | Timeout không thể rơi nhánh này (cần response.status thật) |
| Real 403 | `GraphMailError('permission')` (158–162) | `FAILED_GRAPH_FETCH` (TASK-074: 403 không reconnect) | Có | Không | Timeout không thể giả 403 |
| ErrorQuotaExceeded (TASK-091) | Chuỗi này không xuất hiện trong code (TASK-091 §4 PROVEN); trên email path một 403 quota chỉ là `permission` như trên; persistent-403 counters chỉ tồn tại trên delta path (`handlePersistentForbidden`) | như 403 | Có | Không | Timeout không chạm counter delta, không đổi semantics TASK-091 |
| invalid_grant / interaction_required | `token_endpoint` + code ∈ `REVOKED_GRANT_ERROR_CODES` ⇒ `reconnect_required` | `FAILED_RECONNECT_REQUIRED` | — | CÓ | Timeout không có microsoftErrorCode ⇒ không thể rơi nhánh này |

**Kết luận:** classifier hiện tại đã bảo đảm mọi yêu cầu §7 của đề bài **mà không cần
sửa classifier**: timeout ⇒ transient/retryable, không giả 401/403, không tăng
persistent-403 counter, không RECONNECT_REQUIRED, không FAILED sai, không đổi
TASK-091 semantics, không log raw response (các catch đều log message cố định),
BullMQ retry theo policy thật. Gap duy nhất là **type/observability precision**
(timeout bị gộp vào network) — ghi nhận, không mở scope redesign error taxonomy;
nếu Phase 2 muốn, có thể thêm log field an toàn ở mức debug mà không đổi kind.

---

## §8. BullMQ retry và settlement

Code evidence (`email-job-options.ts`, `email-queue.ts` 93, `delta-polling-queue.ts` 71,
`email-worker.ts` 272–280):

- `attempts: 3` (`DEFAULT_ATTEMPTS`, dòng 14), backoff exponential base 5s
  (`DEFAULT_BACKOFF_DELAY_MS`, dòng 15) ⇒ chờ ~5s rồi ~10s giữa các attempt.
- `removeOnComplete`: 24h/1000; `removeOnFail`: 7 ngày/5000.
- JobId deterministic: `microsoft-webhook:{mailboxId}:{messageId}` và
  `delta-polling:{mailboxId}:{messageId}` — hai prefix khác nhau ⇒ tối đa 2 queue
  entries cho một message; dedup nội dung nằm ở pipeline (comment 197–203).
- Worker construction: không override `lockDuration`/`stalledInterval`/
  `maxStalledCount` ⇒ defaults 30s/30s/1 (§4).
- Processor: throw chỉ cho các transient statuses (worker 215–225); skip/terminal
  return ⇒ complete.

**Hai invariant tách bạch:**

1. **"Không có HTTP promise pending vô hạn" — HIỆN CHƯA ĐẠT** trên hai seam §3.
   Đây là gap của TASK-092.
2. **"Sau timeout, retry hữu hạn" — ĐÃ ĐẠT sẵn:** sau attempt thứ 3 thất bại, BullMQ
   chuyển job sang failed set (giữ 7 ngày để inspect), **không** có cơ chế nào trong
   repo re-enqueue tự động job failed (đã search: không có `retryJobs`/`moveToWaiting`
   caller). Một message vẫn có thể quay lại qua job thứ hai (webhook vs delta prefix)
   hoặc khi failed job bị prune rồi delta re-discover — nhưng mọi đường đều bị chặn
   bởi stale guard 30 phút + status-aware dedup ⇒ không infinite retry. Trạng thái dữ
   liệu sau attempt cuối của Graph/token failure: không row/lease mới (§6), mailbox
   giữ ACTIVE (transient), message có thể được recover trong cửa sổ 30 phút bởi job
   còn lại.
   Lưu ý phụ (không phải infinite retry): một job **treo** không tiêu attempt nào —
   nó không settle, nên attempts/backoff không có cơ hội chạy. Timeout hữu hạn chính
   là điều kiện tiên quyết để invariant 2 có ý nghĩa.

---

## §9. Architecture options

### OPTION A — Reuse `fetchWithTimeout` tại đúng hai HTTP seam của worker-email

Thay đổi dự kiến (Phase 2):
1. `graph-mail.service.ts`: thêm `timeoutMs?` vào `GetMessageOptions` (và thread qua
   `performGraphRequest` → `fetchWithTimeout`); default **không timeout** (pass-through)
   để caller khác (web/API dùng `listInboxMessages`/`getMessageById`) giữ nguyên
   behavior — đúng pattern TASK-080 đã làm với refresh service.
2. `email-worker-runner.ts`: `graphMessageFetchPort` truyền hằng số timeout;
   access-token port truyền `timeoutMs` cho `refreshMicrosoftAccessToken`
   (one-line, giống hệt delta runner 223–225).

| Tiêu chí | Đánh giá |
|---|---|
| Cancellation thật | CÓ — AbortController, signal tới native fetch, socket teardown (helper đã chứng minh + có test `fetch-with-timeout.test.ts`) |
| Breadth | Đúng 2 seam trên email path; không đụng seam khác |
| Enforcement | Tại HTTP boundary — nơi duy nhất bảo đảm "promise settle" đồng nghĩa "không còn I/O nền" |
| Operation nền tiếp tục? | KHÔNG — request bị abort thật |
| Error classification | Tự nhiên rơi vào network/transient hiện có (§7), zero classifier change |
| Mailbox lock / BullMQ | Attempt settle hữu hạn ⇒ finally release lock chạy, slot trả lại, attempts/backoff hoạt động đúng |
| TASK-085 | Tương thích (§5 — timeout throw trước persist) |
| TASK-090 | Tương thích (§6 — trước mọi claim) |
| TASK-091 | Không đổi (không đụng delta 403 semantics) |
| Testability | Cao — pattern test sẵn có (`refresh-access-token.timeout.test.ts`, `delta-polling.timeout.test.ts`, `telegram-sender.timeout.test.ts`): fake fetch pending + fake timers |
| Service impact | Behavior chỉ đổi ở worker-email; shared type mở rộng optional ⇒ compile-compatible (§11) |
| Migration | Không |
| Nhược điểm / residual | Body-read (`response.json()`) vẫn ngoài cửa sổ abort (giống delta/Telegram — precedent chấp nhận, ghi residual risk); timeout bị gộp kind network (observability) |

### OPTION B — Worker-level watchdog / Promise.race quanh pipeline

- Promise.race thuần: attempt "settle" nhưng HTTP promise **vẫn chạy nền**, socket
  vẫn giữ, và pipeline nền có thể tiếp tục side effect (claim, Telegram!) sau khi
  BullMQ đã retry ⇒ tạo đúng loại double-run mà TASK-090 phải phòng — vi phạm điều
  kiện đề bài ("không được khuyến nghị nếu chỉ Promise.race"). Watchdog có
  cancellation thật thì phải luồn AbortSignal xuyên pipeline (Prisma không nhận
  signal) — scope lớn, rủi ro cao, không cần thiết khi chỉ có 2 seam HTTP.
- **Loại.**

### OPTION C — Chỉ harden Graph fetch, bỏ qua token refresh

- Token refresh đi trước Graph fetch trên cùng attempt, cùng endpoint đã từng treo
  thật ngoài production (TASK-079 root cause bao gồm cả token endpoint trên delta
  path — report TASK-080 §2 liệt kê cả hai seam). Bỏ seam này ⇒ blast radius y hệt
  (§5 = §4). Chi phí thêm của việc harden token refresh ≈ 1 dòng (option đã tồn tại).
- **Loại** — không có lý do kỹ thuật để bất đối xứng.

### OPTION D — NO CHANGE

- Chỉ hợp lệ nếu mọi Microsoft seam trên email path đã có finite timeout +
  cancellation thật. §3 chứng minh **cả hai seam đều chưa có** (một seam không truyền
  option, một seam không có cơ chế nào). Precedent TASK-079 chứng minh hang là failure
  mode thật của chính các endpoint này, và §4 chứng minh stalled detector không cứu
  được khi process còn sống, với capacity mặc định chỉ 2 slot.
- **Loại** — được xem xét nghiêm túc nhưng bị bác bằng code evidence.

### Recommendation (duy nhất)

**OPTION A.** Không có blocker; mọi evidence cần thiết đã thu thập.

---

## §10. Timeout budget

Evidence để chọn giá trị (không chọn số tùy ý):

| Nguồn | Giá trị |
|---|---|
| `DELTA_POLLING_HTTP_TIMEOUT_MS` (TASK-080, Graph delta + token refresh cùng endpoint Microsoft) | 20s |
| `CONNECT_SUBSCRIPTION_HTTP_TIMEOUT_MS` (Graph subscription API) | 20s |
| `TELEGRAM_HTTP_TIMEOUT_MS` (TASK-090 — chỉ tham khảo, endpoint khác) | 15s |
| BullMQ lockDuration/renewal | 30s / renew mỗi 15s (auto — không ràng buộc trần HTTP vì lock tự renew) |
| Mailbox lock TTL (in-memory + Redis constant) | 60s |
| Delivery lease (TASK-090) | 300s |
| Backoff budget | 3 attempts, base 5s |

**Đề xuất:**

- Graph message fetch: **20_000 ms**, hằng số mới `EMAIL_WORKER_HTTP_TIMEOUT_MS`
  (đặt tại module hằng số phù hợp trên email path — đề xuất khai báo trong
  `email-worker-runner.ts` hoặc leaf-policy module, quyết định vị trí cuối ở Phase 2
  implementation review; KHÔNG import hằng số delta để tránh coupling ngược module).
- Email-path token refresh: **cùng hằng số 20_000 ms** — cùng đặc tính request
  Microsoft (một round-trip JSON nhỏ), khớp giá trị delta path đã vận hành thật.
- Dùng chung **một constant caller-side** cho cả hai seam (đối xứng với cách delta
  dùng một constant cho cả hai seam của nó).
- **Không cần env config** — theo đúng locked-decision style của TASK-080
  (`Intentionally NOT env-tunable`) và TASK-090; không sửa `.env*`.

### §10.1. End-to-end critical-section budget (mailbox lock) — tính đủ, không chỉ 2×20s

Mailbox lock được acquire tại `pipeline` 504 và release trong `finally` 527–534,
tức critical section bao phủ **toàn bộ** `processActiveMailboxJob` — bao gồm cả
identity/ownership claims, throttle sleeps và Telegram delivery, không chỉ hai
Microsoft HTTP calls. Worst-case từng thành phần theo code thật (với timeout Phase 2):

| Thành phần trong critical section | Trần code-level | Evidence |
|---|---|---|
| Token refresh (Phase 2) | 20s | đề xuất §10 |
| Graph fetch (Phase 2) | 20s | đề xuất §10 |
| DB operations (lookup, dedup reads, claims, marks) | ms-scale, KHÔNG có trần code-level (Prisma) | pipeline các bước 5–17 |
| Ownership wait — chỉ recovery path khi lease của owner khác còn sống | ≈ lease 300s + poll 5s = **305s** | `deduplication.service.ts` 584–590 (`deadlineMs = start + leaseMs + pollMs`) |
| Destination throttle sleep | 15s | `DEFAULT_DESTINATION_MAX_WAIT_MS` (`destination-throttle.ts` 25) |
| Global pacer sleep | 2s | `DEFAULT_GLOBAL_SEND_MAX_WAIT_MS` (`global-send-throttle.ts` 36) |
| Telegram send nội bộ (TASK-033/090) | 4 × 15s HTTP + 3 × 60s backoff = **240s** | `delivery-ownership-policy.ts` 15–24; `telegram-retry.service.ts` |

Worst-case end-to-end: ≈ 40s + 305s + 17s + 240s + overhead ≈ **~600s**; đường
thường (không ownership wait): ≈ **~300s**. Cả hai **vượt xa TTL 60s** của mailbox
lock. Đây KHÔNG phải hệ quả của TASK-092: chính comment thiết kế
`delivery-ownership-policy.ts` (dòng 15–24) đã tính "maximum normal ownership
duration ≈ 257s" cho riêng phase sở hữu delivery — tức từ TASK-090, hệ thống đã
chấp nhận rằng mailbox-lock TTL (anti-wedge) nhỏ hơn worst-case attempt hợp lệ, và
serialization per-mailbox là **best-effort**; exactly-once KHÔNG dựa trên mailbox
lock mà dựa trên identity claim (TASK-068A) + delivery-ownership CAS với mọi
terminal write fenced theo owner token (TASK-090).

Do đó lập luận đúng cho giá trị 20s KHÔNG phải "toàn attempt < TTL" (điều đó vốn
không đúng cả trước TASK-092), mà là:

1. **Phase dễ tổn thương nhất được thu hẹp từ ∞ xuống hữu hạn.** Trước
   identity/ownership claim, tầng bảo vệ duy nhất chống double-run là mailbox lock.
   Hiện tại phase này unbounded (hang vô hạn ⇒ chắc chắn vượt TTL). Với 2 × 20s +
   DB overhead ms-scale, phase pre-claim < 60s TTL trong mọi trường hợp không có
   DB stall ⇒ cửa sổ chồng lấn pre-claim do HTTP hang bị đóng gần hết.
2. **Phase sau claim đã được fence sẵn** — TTL hết giữa Telegram phase là behavior
   hiện hữu, mọi side effect (send-once, SENT/FAILED) đã được ownership CAS bảo vệ.
3. **20s khớp precedent vận hành thật** (delta 20s, subscription 20s) và ≪ delivery
   lease 300s (không làm lease-budget của TASK-090 sai đi).

Khi TTL hết trước `finally`: attempt cũ **tiếp tục chạy** (không bị hủy giữa chừng);
attempt mới cùng mailbox có thể bắt đầu song song. TASK-090/068A claims bảo vệ:
duplicate Telegram delivery, SENT/FAILED overwrite, reclaim sau crash. KHÔNG bảo vệ:
double Microsoft calls (token refresh + Graph fetch — double external load; rotation
kép vẫn an toàn nhờ TASK-085 CAS), double detector/extractor/DB reads, và cửa sổ
bounded-duplicate ambiguity đã document của TASK-090 (takeover khi send in-flight —
thuộc delivery lease 300s, không thuộc mailbox TTL). Ghi nhận thành DF-92-6 (§13).
Option A không làm bất kỳ risk nào trong nhóm này xấu hơn — chỉ thu hẹp.

---

## §11. Migration và service impact

Xác minh bằng code (không giả định):

- **Prisma schema:** KHÔNG đổi — không trường mới nào cần cho timeout (mọi state đã
  có; §6 chứng minh không cần state machine mới).
- **Migration:** KHÔNG.
- **Redis structure:** KHÔNG đổi — không key/lock mới.
- **Environment variable:** KHÔNG thêm (hằng số code-level, §10).

Service impact matrix (Phase 2, Option A):

| Service | Behavioral change | Compile/test impact | Deployment cần? | Lý do |
|---|---|---|---|---|
| worker-email | **YES** — hai HTTP seam có trần 20s + abort; timeout ⇒ transient retry | Unit tests mới + regression | YES (khi rollout Phase 2, ngoài scope Phase 1) | Đây là mục tiêu task |
| worker-delta | NO | Verification-only: `graph-mail.service.ts` mở rộng optional type (delta không gọi `getMessageById`; token-refresh signature không đổi) ⇒ compile + test suite chạy lại | Theo pipeline release chung | Shared module đổi ⇒ cần regression build/test, không đổi behavior |
| web | NO — caller `getMessageById`/`listInboxMessages` ngoài worker không truyền timeout ⇒ pass-through giữ nguyên | Compile + existing tests | Theo pipeline release chung | Optional param, default cũ |
| worker-renewal | NO — renewal dùng `timeoutMs?` option sẵn có theo cách riêng (`subscription-renewal-runner.ts` 334–381), không đổi | Compile + existing tests | Theo pipeline release chung | Không đụng |

Phân biệt rõ: **behavioral impact chỉ ở worker-email**; các service khác chỉ có
**verification impact** (compile/regression do shared module). Không thao tác Railway
trong Phase 1.

---

## §12. Deterministic test matrix cho Phase 2 (design-only, chưa viết test)

Quy ước chung: không real network; không chờ wall-clock (dùng `vi.useFakeTimers()` /
controllable promise như các test timeout hiện có); mỗi case có negative assertion.

| # | Case | Layer / file dự kiến | Seam mock | Cơ chế deterministic | Action | Expected settlement | Expected side effect | Negative assertion |
|---|------|---------------------|-----------|---------------------|--------|--------------------|--------------------|--------------------|
| 1 | Normal Graph fetch (có timeout, response nhanh) | unit — `tests/unit/microsoft/graph-mail.timeout.test.ts` (mới) | `fetchImpl` inject | resolve ngay | `getMessageById(..., {timeoutMs})` | resolve message | signal được truyền vào init | không `HttpTimeoutError`; timer đã clear (không pending timer) |
| 2 | Hanging Graph fetch | như #1 | `fetchImpl` trả promise never-resolve nhưng reject theo signal (mô phỏng native abort) | fake timers advance 20s | như #1 | reject | error kind `network` (qua service) | không pending vô hạn; không unhandled rejection |
| 3 | AbortController abort thật + signal tới exact fetch | như #1 | fetchImpl capture `init.signal` | advance timer | như #1 | reject | `init.signal.aborted === true` sau timeout | fetch không được gọi lại |
| 4 | Timer cleanup khi thành công nhanh | unit — đã có sẵn cho helper (`fetch-with-timeout.test.ts`), thêm case ở tầng graph-mail | fetchImpl resolve | fake timers | resolve rồi advance quá 20s | không có abort muộn | — | không abort sau success |
| 5 | Normal token refresh trên email path (timeoutMs được truyền) | unit — `tests/unit/queue/email-worker-runner.test.ts` (mở rộng) | `fetchImpl` / refresh service spy | resolve | `getAccessTokenForMailbox` | resolve access token | rotation persist với `expectedGeneration` đúng | timeout option === hằng số mới (assert wiring) |
| 6 | Hanging token refresh | như #5 | fetch pending + abort theo signal | advance 20s | như #5 | throw `EmailWorkerTokenError` | classification `transient` | KHÔNG gọi `persistRotatedRefreshToken`; KHÔNG mark reconnect |
| 7 | Worker attempt settle hữu hạn khi Graph hang | unit — `tests/unit/email/graph-message-pipeline.timeout.test.ts` (mới) | `graphMail.fetchMessage` reject `GraphMailError('network')` (mô phỏng hậu-timeout) | trực tiếp | `processGraphMessageJob` | return `FAILED_GRAPH_FETCH` | — | không throw khác; không Telegram call |
| 8 | Mailbox lock release sau timeout | như #7 | lock inject (in-memory thật) | — | chạy job timeout rồi job thứ hai cùng mailbox | job 2 acquire được ngay | — | không `DEFERRED_MAILBOX_BUSY` ở job 2 |
| 9 | BullMQ rethrow cho status timeout | unit — `tests/unit/queue/email-worker.test.ts` (mở rộng) | pipeline fake trả `FAILED_GRAPH_FETCH` / `FAILED_TOKEN_TRANSIENT` | — | `processEmailWebhookJob` | throw `EmailWorkerProcessingError` | metrics ghi `failed` | envelope không chứa code/token material |
| 10 | Exhausted attempts | phân loại **integration-lite/unit trên options**: assert `attempts===3`, backoff exponential 5s từ `getDefaultEmailJobOptions`; full BullMQ end-to-end xếp integration (cần Redis) — đề xuất seam nhỏ nhất: giữ như hiện tại, không cần seam mới | options thuần | — | gọi hàm options | object đúng | — | không infinite (`attempts` hữu hạn) |
| 11 | Timeout không thành 401/auth | #7 mở rộng | reject `GraphMailError('network')` | — | pipeline | `FAILED_GRAPH_FETCH` | — | KHÔNG `FAILED_RECONNECT_REQUIRED`; `markReconnectRequired` không được gọi |
| 12 | Timeout không thành 403/permission-path | #7 mở rộng | như #11 | — | — | reason `network` | — | không counter/status nào của 403 bị đụng |
| 13 | Timeout không mark RECONNECT_REQUIRED (token) | #6/#7 | classification transient | — | — | `FAILED_TOKEN_TRANSIENT` | — | `markReconnectRequired` không gọi; audit `MAILBOX_RECONNECT_REQUIRED` không ghi |
| 14 | TASK-085 CAS-win regression | reuse/extend `refresh-token-rotation.service.test.ts` + runner test | prisma fake `updateMany` count 1 | — | refresh thành công có rotation | persisted true | ciphertext mới ghi kèm `tokenLastRefreshedAt` | không ghi khi timeout |
| 15 | TASK-085 CAS-loser regression | như #14, count 0 | — | — | — | `casLost: true`, không throw | access token vẫn dùng | không retry ghi, không reconnect |
| 16 | Reconnect priority regression | runner test: refresh trả `token_endpoint` + `invalid_grant` | fetch fake 400 + payload code | — | — | `EmailWorkerTokenError` classification `reconnect_required` | pipeline mark reconnect | timeout case (#6) KHÔNG rơi nhánh này |
| 17 | TASK-090 delivery-state regression: timeout trước claim | `graph-message-pipeline.delivery-recovery.test.ts` (mở rộng) | graphMail reject network | — | chạy job fail rồi job retry với graphMail resolve | retry claim + send thành công | đúng 1 row, đúng 1 send | không row/lease tạo ra ở attempt fail; không duplicate send |
| 18 | TASK-091 real-403 regression | #7 mở rộng: reject `GraphMailError('permission', 403)` | — | — | — | `FAILED_GRAPH_FETCH` reason `permission` | — | không reconnect; không đổi semantics |
| 19 | No infinite pending (end-to-end seam) | unit trên `performGraphRequest`/service với fetch pending + fake timers | fetch pending | advance | — | promise settle (reject) tại đúng 20s | — | vẫn pending tại 19.999s (assert đúng trần) |
| 20 | No unintended infinite retry | #9 + #10 kết hợp: job fail 3 lần ⇒ BullMQ (mock/options-level) không schedule attempt 4 | — | — | — | failed terminal | removeOnFail giữ policy | không re-enqueue path nào trong repo |
| 21 | Multi-mailbox isolation | pipeline test: 2 mailbox, 1 hang (graphMail pending có signal-mô-phỏng), 1 bình thường | lock thật in-memory | controllable promise | chạy song song | mailbox B hoàn tất bình thường | — | hang của A không chặn B (lock theo mailboxId) |
| 22 | Full concurrency capacity exhaustion (deterministic) | unit-level mô phỏng: N=concurrency promise pending giữ slot — kiểm ở seam `processEmailWebhookJob` bằng fake pipeline pending + đo settle sau khi timeout mô phỏng; full BullMQ concurrency thuộc integration, phân loại rõ và không bắt buộc unit | fake pipeline | controllable | — | mọi attempt settle sau trần | slot trả lại | không attempt nào pending vô hạn |
| 23 | Wiring constants | runner test | spy trên options | — | build port/fetch port | timeoutMs === `EMAIL_WORKER_HTTP_TIMEOUT_MS` cho CẢ HAI seam | — | không seam nào bỏ sót |

(Case "NO CHANGE verification" của Option D: không áp dụng — Option A được chọn.)

---

## §13. Deferred findings và out-of-scope

| # | Finding | Evidence ngắn | Xử lý |
|---|---|---|---|
| DF-92-1 | `response.json()` body-read không nằm trong cửa sổ abort của `fetchWithTimeout` (timer clear sau headers) — áp dụng cho delta, Telegram, refresh và cả email path sau Phase 2 | `fetch-with-timeout.ts` 71–82 (finally clear); `graph-mail.service.ts` 266; `refresh-access-token.service.ts` 130 | Deferred — cùng precedent TASK-080/090 đã chấp nhận; nếu muốn đóng cần helper đọc body có trần riêng (task riêng) |
| DF-92-2 | `fetchWithTimeout` ghi đè `init.signal` khi có timeout ⇒ caller-signal không compose được | helper dòng 72 (`{...init, signal: controller.signal}`) | Deferred — không caller nào hiện truyền signal; ghi nhận để tránh bất ngờ tương lai |
| DF-92-3 | OAuth connect/callback exchange (`oauth-token-exchange.service.ts`) và `microsoft-profile.service.ts` dùng fetch không timeout trên web path (request-scoped, có Next.js/request lifecycle bao ngoài) | grep `fetch(` services/microsoft | Out-of-scope TASK-092 (không trên worker-email runtime path) |
| DF-92-4 | Redis-backed mailbox lock tồn tại sau seam nhưng production chưa wire (in-memory, single-replica baseline) | `email-worker-runner.ts` 56–63 | Không đổi trong TASK-092 (mailbox-lock redesign ngoài scope) |
| DF-92-5 | `listInboxMessages` (web/manual path) cũng không timeout | `graph-mail.service.ts` 275–311 | Out-of-scope; Phase 2 chỉ thêm optional param dùng bởi worker caller — web caller giữ nguyên, có thể opt-in ở task sau |
| DF-92-6 | Mailbox-lock TTL 60s nhỏ hơn worst-case attempt hợp lệ (~300–600s khi tính Telegram retry + ownership wait) ⇒ hai attempt cùng mailbox có thể chạy chồng giữa attempt dài; per-mailbox serialization là best-effort, exactly-once dựa trên claims chứ không trên lock này | §10.1; `delivery-ownership-policy.ts` 15–24 (thiết kế TASK-090 đã tính ~257s); `mailbox-processing-lock.ts` 22 | **Pre-existing** từ TASK-090, không do TASK-092 tạo ra và Option A không làm xấu hơn (thu hẹp phase pre-claim từ ∞ → ~40s). Không redesign lock trong TASK-092; nếu muốn renewal/TTL khác là task riêng |

---

## §14. Acceptance gates cho Phase 2

1. Cả hai seam (Graph getMessageById trên email path; email-path token refresh)
   có finite timeout 20s + AbortController thật, signal tới native fetch.
2. Timeout classify transient: `FAILED_GRAPH_FETCH` / `FAILED_TOKEN_TRANSIENT`;
   không 401/403/RECONNECT_REQUIRED/FAILED-permanent; không đổi TASK-085/090/091
   semantics (regression tests §12 #14–18).
3. Worker attempt settle hữu hạn; mailbox lock release qua finally; BullMQ
   attempts/backoff giữ nguyên cấu hình.
4. Behavior các service ngoài worker-email không đổi (pass-through defaults).
5. Không migration, không env mới, không sửa `.env*`.
6. `npm run verify` PASS; test matrix §12 hiện thực hóa ở các case unit.

**Implementation scope dự kiến Phase 2 (nhỏ):** `lib`/helper không đổi;
`graph-mail.service.ts` (+optional `timeoutMs` threading), `email-worker-runner.ts`
(hằng số + 2 điểm truyền option), test files mới/mở rộng theo §12. Không file nào khác.

---

## §15. Verdict Phase 1

- Hypothesis "email path đã đủ an toàn" — **DISPROVED** bằng code evidence (§3).
- Option D (NO CHANGE) — xem xét nghiêm túc, **bị loại** (§9).
- **Recommendation: OPTION A** với timeout 20s dùng chung một constant mới cho cả
  hai seam; không migration; không env; không đổi classifier/state machine.

> Antigravity Architecture Review kết luận:
> **PASS — TASK-092 PHASE 1 ARCHITECTURE APPROVED FOR PHASE 2 IMPLEMENTATION.**
> Các finding Low (DF-92-1..6, timeout taxonomy/observability) được ghi nhận
> nhưng KHÔNG yêu cầu sửa trong TASK-092.

---

## §16. Phase 2 — Implementation thực tế (đúng Option A đã khóa)

### §16.1. Code changes

| File | Function/vị trí | Thay đổi |
|---|---|---|
| `services/microsoft/graph-mail.service.ts` | `GetMessageOptions` | Thêm optional `timeoutMs?: number` (comment TASK-092); KHÔNG thêm cho `ListInboxMessagesOptions` (DF-92-5 giữ deferred) |
| `services/microsoft/graph-mail.service.ts` | `performGraphRequest` | Thêm tham số optional `timeoutMs`; thay fetch trần bằng `fetchWithTimeout(fetchImpl, url, init, { timeoutMs })` — khi không truyền, helper pass-through y nguyên behavior cũ; khi truyền, AbortController signal tới đúng native fetch |
| `services/microsoft/graph-mail.service.ts` | `getMessageById` | Thread `options.timeoutMs` xuống `performGraphRequest`; `listInboxMessages` không truyền (pass-through) |
| `services/queue/workers/email-worker-runner.ts` | module-level | Hằng số mới `export const EMAIL_WORKER_HTTP_TIMEOUT_MS = 20_000` (caller-side, không env) |
| `services/queue/workers/email-worker-runner.ts` | `createPrismaEmailAccessTokenPort` | `refreshMicrosoftAccessToken(plaintext, { timeoutMs: EMAIL_WORKER_HTTP_TIMEOUT_MS })` — chỉ wire option sẵn có từ TASK-080, không sửa shared service |
| `services/queue/workers/email-worker-runner.ts` | `graphMessageFetchPort` | `getMessageById(accessToken, graphMessageId, { timeoutMs: EMAIL_WORKER_HTTP_TIMEOUT_MS })` |

Không sửa: `fetch-with-timeout.ts`, refresh service, pipeline, classifier nào,
Telegram, lock, BullMQ options, schema/migration/env/ROADMAP/workflows.

### §16.2. Cancellation & error behavior (như phê duyệt)

- Timeout ⇒ `controller.abort()` tear down request thật (không Promise.race, không
  operation nền) ⇒ `HttpTimeoutError` ⇒ Graph: catch sẵn có ⇒
  `GraphMailError('network')` ⇒ `FAILED_GRAPH_FETCH`; refresh: catch sẵn có ⇒
  `RefreshAccessTokenError('network')` ⇒ `transient` ⇒ `FAILED_TOKEN_TRANSIENT`.
- Cả hai status đều nằm trong danh sách processor throw ⇒ BullMQ retry.
- Không 401/403 giả, không RECONNECT_REQUIRED, không ProcessedMessage FAILED,
  không đổi ErrorQuotaExceeded/persistent-403, không taxonomy mới.
- TASK-085: refresh timeout throw trước `persistRotatedRefreshToken` — không
  partial write, CAS predicate/semantics/reconnect priority nguyên vẹn.
- TASK-090: hai HTTP calls giữ nguyên vị trí trước identity/delivery claim; không
  đổi lease/ownership/CAS; không sửa Telegram sender.

### §16.3. Tests thực tế (mapping về matrix §12)

Mới: `tests/unit/microsoft/graph-mail.timeout.test.ts` (3 cases — phủ §12 #1–4,
#19: signal tới exact fetch, hang settle đúng trần 20s bằng fake timers, abort
thật (`signal.aborted === true`), timer cleanup không late-abort, pass-through
khi không truyền `timeoutMs`, error kind `network` không phải auth/permission).

Mở rộng: `tests/unit/queue/email-worker-runner.test.ts` — mock refresh/graph
forward options; assert cả hai seam nhận đúng `EMAIL_WORKER_HTTP_TIMEOUT_MS`
(#5, #23); constant pin = 20_000; refresh timeout ⇒ classification `transient` +
`persistRotatedRefreshToken` KHÔNG được gọi (#6, #13, #14-negative).

Coverage sẵn có được tận dụng (không viết lại): `fetch-with-timeout.test.ts`
(#4 helper), `refresh-access-token.timeout.test.ts` (hang refresh + abort thật +
pass-through), `graph-message-pipeline.service.test.ts` (network ⇒
`FAILED_GRAPH_FETCH` không reconnect — Case 6b/6d; token transient ⇒
`FAILED_TOKEN_TRANSIENT` không reconnect — #7, #11–13), `email-worker.test.ts` +
`email-worker.metrics.test.ts` (processor rethrow `EmailWorkerProcessingError` —
#9), `graph-message-pipeline.throttling.test.ts` (lock release khi fail — #8;
multi-mailbox isolation — #21), `refresh-token-rotation.service.test.ts`
(TASK-085 CAS win/lose — #14/#15), `email-worker-runner.test.ts` classification
(reconnect priority — #16), `graph-message-pipeline.delivery-recovery.test.ts`
(TASK-090 — #17), `graph-mail.service.test.ts` (403 permission mapping — #18),
`delta-polling.timeout.test.ts` (TASK-080 không đổi), `email-job-options` qua
worker tests (#10/#20 options-level).

### §16.4. Trạng thái & Antigravity Implementation Review

- Phase 2 implementation + deterministic tests: HOÀN TẤT, `npm run verify` PASS.
- **Antigravity Implementation Review: PASS — TASK-092 PHASE 2 IMPLEMENTATION
  APPROVED.** Không có finding Critical, High hoặc Medium.
- Ba nhóm Low note được ghi nhận, KHÔNG chặn nghiệm thu và KHÔNG sửa trong
  TASK-092: (1) response body read nằm ngoài cửa sổ timeout (DF-92-1);
  (2) timeout observability gộp vào network classification; (3) "pre-claim dưới
  60 giây" chỉ là operational expectation, không phải invariant được enforce.
  Các Low/residual DF-92-1, DF-92-2, DF-92-3/DF-92-5, DF-92-4, DF-92-6 tiếp tục
  giữ nguyên deferred.
- Review xác nhận implementation đúng Option A đã khóa: timeout 20.000 ms cho
  token refresh và cho Graph `getMessageById`; cancellation thật bằng
  AbortController (không Promise.race); caller không truyền timeout giữ nguyên
  pass-through behavior.
- Regression: TASK-085 credential CAS PASS; TASK-090 delivery-state PASS;
  TASK-091/real-403 PASS.
- Verification độc lập của reviewer: targeted 5 test files / 51 tests PASS;
  full run 110 test files / 1350 tests PASS; lint/typecheck/build PASS.
- Không migration; không env/Redis/BullMQ/Railway change; behavioral change chỉ
  ở worker-email.
- Chưa commit/push; chưa promotion staging (Railway staging vẫn dùng branch
  `staging`); ROADMAP chưa cập nhật vì staging validation chưa hoàn tất.
- **Trạng thái: Antigravity Implementation Review PASS; sẵn sàng Final
  Pre-Commit Review.**
