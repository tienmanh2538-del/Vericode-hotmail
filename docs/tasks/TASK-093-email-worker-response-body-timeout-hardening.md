# TASK-093 — Email Worker Microsoft Response Body Read Timeout & End-to-End Deadline Hardening

> **Phase 1 — INVESTIGATION / ARCHITECTURE ONLY.** Chưa implementation, chưa
> viết/sửa test, chưa commit/push, không cập nhật ROADMAP, không Railway, không
> migration. Đây là follow-up của residual finding **DF-92-1** (TASK-092).
> Sanitized: không secret, không token/credential, không connection string,
> không full verification code, không full email body.
>
> Banner trên là lịch sử Phase 1 (giữ nguyên). Trạng thái hiện tại: Phase 2
> implementation (§15) và close-out end-to-end trên staging (§16) đã hoàn tất;
> chưa production rollout.

---

## §1. Mục tiêu và scope

**Câu hỏi trung tâm (DF-92-1):** sau TASK-092, `fetchWithTimeout` clear timer
ngay khi fetch trả response headers; các bước đọc body (`response.json()`)
diễn ra SAU đó. Body read trên hai Microsoft operations của worker-email có
thật sự nằm ngoài cửa sổ deadline không, có thể treo không, và treo thì bounded
hay unbounded theo runtime semantics thật?

**Không mặc định** body read thiếu timeout — Phase 1 này trace cả code repo lẫn
runtime semantics của Node/undici (Node đang cài tại môi trường dev/CI:
v24.16.0; global `fetch` là undici bundled).

**Ngoài scope** (§11): mailbox-lock TTL/renewal/Redis wiring (DF-92-4/6),
caller-signal composition (DF-92-2), web/OAuth/listInboxMessages hardening
(DF-92-3/5), timeout observability redesign, Telegram/delta implementation
(chỉ compatibility review), error taxonomy redesign, Railway, production
rollout.

---

## §2. Exact response lifecycle trace (code tại HEAD close-out TASK-092)

Ký hiệu: `helper` = `lib/http/fetch-with-timeout.ts`; `refresh` =
`services/microsoft/refresh-access-token.service.ts`; `graph` =
`services/microsoft/graph-mail.service.ts`; `runner` =
`services/queue/workers/email-worker-runner.ts`.

### §2.A. Access-token refresh

| # | Bước | File/function (dòng) | Await | Signal / timer | Body API | Trong timeout window? | Error wrap/classify | Resource đang giữ |
|---|------|----------------------|-------|----------------|----------|----------------------|--------------------|-------------------|
| 1 | BullMQ worker → access-token port | `runner createPrismaEmailAccessTokenPort` (DB read, decrypt) | await | — | — | — | `EmailWorkerTokenError` | job lock (auto-renew) + slot + mailbox lock (TTL 60s) |
| 2 | Gọi refresh có timeout | `runner` 268–270: `refreshMicrosoftAccessToken(plaintext, { timeoutMs: EMAIL_WORKER_HTTP_TIMEOUT_MS })` (hằng số 20_000, `runner` 58) | await | — | — | — | — | như trên |
| 3 | fetch qua helper | `refresh` 107–119 → `helper fetchWithTimeout` 52–83: tạo `AbortController` + `setTimeout(timeoutMs)` (64–69); `await fetchImpl(url, {...init, signal})` (72) | await | Signal của helper tới native fetch | — | **CÓ** (headers phase) | timeout ⇒ `HttpTimeoutError` (76–78) ⇒ `refresh` catch (120–126) ⇒ `RefreshAccessTokenError('network')` | như trên |
| 4 | **Headers về ⇒ timer CLEAR** | `helper` 80–82: `clearTimeout(timer)` trong `finally` — chạy ngay khi promise fetch settle (tức khi HEADERS về, xem §3.1) | — | Controller còn attach vào body stream nhưng **không còn gì abort nó** | — | — | — | như trên |
| 5 | **Body read** | `refresh` 128–133: `payload = await response.json()` — LUÔN đọc, kể cả response lỗi (để lấy OAuth error code); reject bị `catch {}` nuốt, payload giữ null | await | **KHÔNG có deadline code-level** | `response.json()` | **KHÔNG** | json reject ⇒ nuốt ⇒ đi tiếp: `!response.ok` ⇒ `token_endpoint` (135–147); ok nhưng payload null ⇒ `token_endpoint` "not JSON" (149–155) — cả hai không có revoke code ⇒ `classifyRefreshTokenError` = `transient` | như trên |
| 6 | Parse + validate fields | `refresh` 157–184 | sync | — | — | — | thiếu field ⇒ `token_endpoint` | như trên |
| 7 | TASK-085 persist | `runner` 279–284 → `persistRotatedRefreshToken` (CAS `updateMany`) | await (Prisma) | — | — | — | DB error ⇒ sanitized throw ⇒ transient | như trên |

### §2.B. Graph getMessageById

| # | Bước | File/function (dòng) | Await | Signal / timer | Body API | Trong timeout window? | Error wrap/classify | Resource đang giữ |
|---|------|----------------------|-------|----------------|----------|----------------------|--------------------|-------------------|
| 1 | Graph fetch port | `runner graphMessageFetchPort` 305–310: `getMessageById(..., { timeoutMs: EMAIL_WORKER_HTTP_TIMEOUT_MS })` | await | — | — | — | — | job lock + slot + mailbox lock |
| 2 | fetch qua helper | `graph performGraphRequest` 243–270: `fetchWithTimeout(fetchImpl, url, init, { timeoutMs })` (257–265) | await | Signal helper tới native fetch | — | **CÓ** (headers phase) | timeout/reject ⇒ catch 266–270 ⇒ `GraphMailError('network')` | như trên |
| 3 | Headers về ⇒ timer clear | `helper` 80–82 | — | như §2.A#4 | — | — | — | như trên |
| 4 | Status check (KHÔNG đọc body) | `graph` 272–279: `!response.ok` ⇒ `mapHttpStatusToError` (401→auth, 403→permission, 429, 5xx…) — chỉ dùng status + retry-after HEADER | sync | — | — | — (nhánh error settle từ headers, không đụng body) | như TASK-092 | như trên |
| 5 | **Body read (chỉ khi ok)** | `graph` 281–288: `payload = await response.json()`; reject ⇒ `GraphMailError('parse', 'GRAPH_RESPONSE_NOT_JSON')` | await | **KHÔNG có deadline code-level** | `response.json()` | **KHÔNG** | parse ⇒ `mapGraphErrorToResult` ⇒ `FAILED_GRAPH_FETCH` (retryable, không reconnect) | như trên |
| 6 | normalize/mapping → pipeline | `graph getMessageById` 330–361; pipeline các bước dedup → stale → detect → extract | sync/await | — | — | — | — | như trên |
| 7 | Claims | identity claim + delivery-ownership claim (TASK-090) — **SAU** toàn bộ body read | await | — | — | — | — | + delivery lease (sau claim) |

**Kết luận trace:** DF-92-1 **CONFIRMED ở mức code**: cả hai body reads nằm
ngoài cửa sổ timer của helper. Controller/signal vẫn còn gắn với body stream
(xem §3.3) nhưng sau `clearTimeout` không còn code path nào gọi `abort()`.

---

## §3. Body-hang analysis (code + runtime semantics)

1. **Fetch promise settle ở HEADERS, không phải full body.** Theo WHATWG fetch
   spec và undici (Node 24), promise của `fetch()` resolve khi status +
   headers sẵn sàng; body được stream sau đó. Code repo tự chứng minh điều
   này: cả `graph` (272) lẫn `refresh` (135) đọc `response.ok`/status TRƯỚC
   khi (hoặc mà không) đọc body, và Telegram/delta cũng cùng cấu trúc.
2. **`response.json()` là promise độc lập** đọc body stream; stream stall ⇒
   promise này pending trong khi fetch promise đã settle từ lâu.
3. **Signal đã truyền vào fetch VẪN gắn với body stream.** Theo WHATWG
   spec/undici: abort signal sau khi headers về sẽ terminate body stream và
   làm `response.json()`/`.text()` reject (AbortError). Tức là cancellation
   thật cho body là KHẢ THI với chính controller hiện có — vấn đề duy nhất là
   helper clear timer nên **không bao giờ abort** trong body phase. (Đây là
   runtime semantics theo tài liệu Node/undici, không thể chứng minh từ code
   repo; Phase 2 test #5 sẽ pin behavior này ở mức mock-contract.)
4. **Body hang có vô hạn không? Trung thực: KHÔNG vô hạn tuyệt đối trong
   runtime mặc định, nhưng không được code bảo đảm.** Node 24 fetch (undici)
   có `bodyTimeout` mặc định ~300s dạng **idle timeout giữa các chunk**: một
   stream stall hoàn toàn sẽ bị undici error sau ~300s idle ⇒ `json()` reject
   (fetch failed / terminated) ⇒ attempt settle. NHƯNG: (a) 300s ≫ 20s
   deadline chủ đích của TASK-092, ≫ mailbox-lock TTL 60s và ngang delivery
   lease 300s; (b) idle-based ⇒ **slow-drip body** (nhỏ giọt từng byte dưới
   ngưỡng idle) kéo dài không giới hạn về nguyên tắc; (c) là **library
   default, không phải guarantee của code repo** — đúng nhóm mà TASK-092
   Phase 1 §3 đã phân loại là không chấp nhận làm bảo đảm; có thể thay đổi
   theo phiên bản Node/dispatcher. Giá trị 300s là theo tài liệu undici cho
   Node 24 — mức chính xác trên runtime production là UNKNOWN (không invent).
5. **Trong khi body pending:** BullMQ concurrency slot bị giữ; job lock được
   lock-extender **tiếp tục renew** (BullMQ v5 — evidence TASK-092 §4);
   stalled detector **không giúp** khi process/event loop còn sống; mailbox
   lock **có thể hết TTL 60s** trong khi body vẫn pending ⇒ job khác cùng
   mailbox chạy song song (các claim TASK-068A/090 chặn duplicate delivery,
   không chặn double Microsoft calls).
6. **Capacity:** 2 body hangs đồng thời = mất toàn bộ capacity worker-email
   (concurrency mặc định 2) trong thời gian hang. Với stall hoàn toàn, mỗi
   đợt hang tự giải phóng sau ~300s (idle default) rồi retry; với slow-drip,
   thời gian mất capacity không bounded bởi code. Khác TASK-092 (hang vô hạn
   chắc chắn), đây là degradation nghiêm trọng nhưng thường theo đợt.
7. **Vị trí so với claims:** cả hai body reads xảy ra **TRƯỚC** ProcessedMessage
   identity claim và delivery-ownership claim (§2.B#7) — như TASK-092, timeout
   ở đây không tạo row/lease/terminal write.

---

## §4. Inventory response-body consumption (repo-wide) và scope boundary

Search toàn repo (`.json()`, `.text()`, `.arrayBuffer()`, `response.body`,
`reader.read(`, `fetchWithTimeout`, fetch trần):

| Vị trí | Body API | Phân loại |
|---|---|---|
| `graph-mail.service.ts` 283 (`performGraphRequest`) | `response.json()` (chỉ khi ok) | **Exact worker-email scope** (getMessageById); cũng phục vụ `listInboxMessages` web — caller không timeout thì hành vi giữ nguyên |
| `refresh-access-token.service.ts` 130 | `response.json()` (luôn, kể cả error payload) | **Exact worker-email scope** qua shared service; delta truyền 20s, renewal/web không truyền — xem compatibility matrix §9 |
| `delta-polling.service.ts` 395 (`fetchDeltaPage` success) và 334 (`readGraphErrorDiagnostics`) | `response.json()` | **Adjacent worker-delta seam** — cùng gap (body read ngoài window của `DELTA_POLLING_HTTP_TIMEOUT_MS`); KHÔNG sửa trong TASK-093 (deferred DF-93-1) |
| `telegram-sender.service.ts` 240 | `response.json()` | **Adjacent Telegram seam (TASK-090)** — cùng gap; KHÔNG sửa (deferred DF-93-2) |
| `graph-subscription.service.ts` 431 | `response.text()` | Adjacent renewal/subscription seam — deferred |
| `microsoft-profile.service.ts` 88; `oauth-token-exchange.service.ts` 136 | `response.json()` | Web/OAuth path — DF-92-3, out of scope |
| `app/api/**` (`request.json()`/`request.text()`) | đọc **incoming request** của Next.js, không phải outbound Microsoft response | Không liên quan |
| `.arrayBuffer()`, `reader.read(`, `response.body` stream thủ công | — | **Không tồn tại trong repo** |

Không mở rộng implementation sang mọi caller: TASK-093 chỉ đề xuất sửa tại
helper + hai seam worker-email; các seam adjacent ghi deferred findings.

---

## §5. Interaction với TASK-085/090/091/092

**TASK-085:**
- Body read (5 §2.A) xảy ra TRƯỚC parse/validate và TRƯỚC
  `persistRotatedRefreshToken` (7) ⇒ body timeout/hang **không thể partial
  write**: persist chỉ chạy sau khi payload parse đủ field.
- Không đổi CAS predicate/winner/loser: timeout ném trước khi tới CAS.
- Reconnect priority: revoke code (`invalid_grant`/`interaction_required`) chỉ
  đọc được TỪ body của error response. Nếu Phase 2 abort trong lúc đọc error
  body của một real 400 revoke: attempt này classify transient (không đọc
  được code) và mailbox retry; attempt sau đọc được body sẽ mark reconnect
  đúng. Conservative — không bao giờ mark reconnect NHẦM do timeout; chỉ có
  thể mark MUỘN một attempt. Ghi nhận là hệ quả chấp nhận được (không đổi
  priority semantics).

**TASK-090:**
- Cả hai body timeouts nằm TRƯỚC identity claim + delivery-ownership claim ⇒
  BullMQ retry nhìn state sạch (không row/lease mới); không FAILED sai;
  không Telegram send trên nhánh này.

**TASK-091:**
- Nhánh 401/403 của Graph settle từ HEADERS (graph 272–279, không đọc body)
  ⇒ body deadline không thể chạm/giả 401/403, không đổi
  ErrorQuotaExceeded/persistent-403 semantics (chỉ tồn tại trên delta path).

**TASK-092:**
- Không được làm mất cancellation thật của headers phase.
- **Không biến 20s thành 20s(fetch) + 20s(body) một cách vô ý** — Phase 1 chốt
  semantics: `timeoutMs` phải trở thành **một absolute end-to-end deadline**
  cho fetch + body consumption (xem §8), giữ nguyên giá trị 20_000.
- No-timeout caller: pass-through phải giữ bit-for-bit (helper không đổi hành
  vi khi thiếu `timeoutMs`).

---

## §6. Error classification cho body deadline (nếu Phase 2 làm)

Yêu cầu và cách đạt được với classifier HIỆN CÓ:

| Trường hợp | Kết quả yêu cầu | Cơ chế |
|---|---|---|
| Timeout khi chờ headers | transient (như TASK-092) | `HttpTimeoutError` từ helper ⇒ network ⇒ `FAILED_TOKEN_TRANSIENT`/`FAILED_GRAPH_FETCH` |
| Timeout khi đọc body | transient/retryable, KHÔNG 401/403, KHÔNG reconnect, KHÔNG FAILED permanent | Helper phải là nơi ném `HttpTimeoutError` (phân biệt bằng cờ `timedOut` như hiện tại) TRƯỚC khi catch parse của caller nuốt lỗi — vì vậy body read phải được deadline-hóa BÊN TRONG helper (Option A/§7), không phải để caller catch một AbortError mơ hồ |
| Malformed JSON (không timeout) | KHÔNG bị hiểu thành timeout | Consume callback ném lỗi khi `timedOut === false` ⇒ helper rethrow nguyên trạng ⇒ Graph: `parse` ⇒ `FAILED_GRAPH_FETCH`; refresh: nuốt như hiện tại ⇒ `token_endpoint` không revoke code ⇒ transient — outcome hiện hành giữ nguyên |
| Provider HTTP error response | giữ nguyên | Graph: status check trước body (không đổi); refresh: đọc error body trong deadline, mất code ⇒ transient (conservative, §5) |
| Caller cancellation | Không tồn tại caller-signal trên các path này (DF-92-2 deferred) | — |
| Logging | không log raw body/secret | Các catch hiện tại đều log message cố định — giữ nguyên |
| Rethrow tới BullMQ | như TASK-092 | Hai status transient đã nằm trong danh sách processor throw |

Không redesign error taxonomy; không thêm kind mới.

**Contract tường minh cho token-refresh end-to-end deadline (Antigravity kiểm
chứng được từ tài liệu này):**

- Deadline fire trong **success body** ⇒ `HttpTimeoutError` ⇒
  `RefreshAccessTokenError('network')` ⇒ transient.
- Deadline fire trong **OAuth error body**, TRƯỚC khi đọc được
  `invalid_grant`/`interaction_required` ⇒ transient cho attempt hiện tại;
  **không mark RECONNECT_REQUIRED khi chưa đọc được provider error code**.
- Attempt sau, nếu provider tiếp tục trả error body đọc được trong deadline ⇒
  reconnect classification hiện hành áp dụng bình thường (mark đúng, chỉ muộn
  tối đa một attempt).
- Không partial credential persistence (persist chỉ chạy sau parse đủ field);
  body timeout không bao giờ thành CAS conflict (ném trước khi tới CAS).

**Contract cho Graph:**

- Success-body deadline ⇒ network/transient (`FAILED_GRAPH_FETCH`).
- Non-2xx status path hiện KHÔNG đọc body (code evidence: graph 272–279 chỉ
  dùng status + retry-after header) ⇒ real 401/403 vẫn quyết định thuần bằng
  `response.status`, body deadline không chạm nhánh này; ErrorQuotaExceeded
  semantics không đổi.

---

## §7. Architecture options

### Caller inventory của hai shared services (evidence cho opt-in design)

`refreshMicrosoftAccessToken` có đúng 5 caller (repo-wide grep):

| Caller | Truyền `timeoutMs`? | Semantics hiện tại |
|---|---|---|
| email-worker runner (268–270) | 20s (TASK-092) | headers-only — **behavioral target TASK-093** |
| delta-polling runner (223–225) | 20s (TASK-080) | headers-only — PHẢI giữ nguyên |
| subscription-renewal port (380–382) — reconciliation runner truyền 20s qua option; renewal caller thường omit | tùy caller | headers-only khi có; pass-through khi omit — PHẢI giữ nguyên |
| web inbox-test route (172) | không (`{ env }`) | pass-through — giữ nguyên |
| mailbox-disconnect-remote-cleanup (65) | không | pass-through — giữ nguyên |

`getMessageById` có đúng **một** caller: email-worker runner (307–310, truyền
20s). Web dùng `listInboxMessages` (không timeout). Dù vậy, để KHÔNG bao giờ
có silent semantic shift qua tham số `timeoutMs`, cả hai service đều dùng cùng
cơ chế opt-in tường minh dưới đây.

### OPTION A1 — NARROW OPT-IN (shared capability, kích hoạt tường minh từ email-worker) — RECOMMENDED

Thiết kế (semantics khóa tại Phase 1; tên TypeScript cuối chốt ở Phase 2):

1. **Helper** (`fetch-with-timeout.ts`) thêm optional capability
   consume-within-deadline (một API mới hoặc option mới nhận callback
   `(response: Response) => Promise<T>`); toàn bộ timer/AbortController/
   timeout-marker logic sống DUY NHẤT ở helper — không duplicate ở caller.
   Hàm/hành vi `fetchWithTimeout` hiện tại giữ nguyên chữ ký + semantics
   (headers-only) cho mọi caller hiện hữu.
2. **Shared Microsoft services** (refresh + graph) thêm một **opt-in flag
   tường minh, mặc định TẮT** (tên dự kiến Phase 2 dạng
   `deadlineCoversBodyRead`): khi TẮT/omit ⇒ semantics hiện tại bit-for-bit
   (headers-only nếu có `timeoutMs`; pass-through nếu không); khi BẬT (và
   `timeoutMs` positive) ⇒ service chạy fetch + body read qua capability của
   helper dưới MỘT absolute deadline.
3. **Chỉ email-worker runner** truyền flag BẬT cho cả hai seam (token refresh
   + `getMessageById`), cùng hằng số `EMAIL_WORKER_HTTP_TIMEOUT_MS` hiện có.
4. Delta / reconciliation / renewal / web / disconnect-cleanup KHÔNG truyền
   flag ⇒ không nhận behavior mới; việc chỉ truyền `timeoutMs` như hiện tại
   KHÔNG BAO GIỜ tự đổi body-consumption semantics.

| Tiêu chí | Đánh giá |
|---|---|
| Cancellation thật | CÓ — cùng controller abort body stream (§3.3) |
| Total deadline | MỘT absolute deadline; không cộng dồn 20+20 |
| Stream chạy nền sau timeout? | KHÔNG — abort terminate stream |
| Error classification | `HttpTimeoutError` từ helper ⇒ phân biệt sạch timeout vs malformed JSON (§6) |
| Behavioral scope | ĐÚNG scope khóa: chỉ worker-email; caller khác bit-for-bit |
| API churn | 1 capability mới ở helper + 1 optional flag ở mỗi service + 2 điểm wiring ở email runner |
| Duplication | Không — logic deadline một chỗ (helper) |
| Backward compatibility | No-timeout caller và headers-only caller giữ nguyên (flag default TẮT) |
| TASK-085/090/091/092 | An toàn (§5) |
| Testability | Cao — controllable stream + fake timers; thêm compatibility tests cho caller không opt-in (§10) |
| Service impact / migration | §9 — không migration |
| Residual | Slow-drip trên EMAIL path còn tối đa 20s; các caller chưa opt-in giữ gap cũ (DF-93-1/2/3 — adopt là task sau, cần user phê duyệt scope) |

**Tính khả thi của A1: KHẲNG ĐỊNH KHẢ THI** — flag default-off là additive,
không phá contract nào; không blocker.

### OPTION A2 — SHARED AUTOMATIC STRENGTHENING (mọi caller có `timeoutMs` tự nhận absolute deadline)

Ít churn hơn A1 một chút (không cần flag) nhưng là **behavioral scope
expansion**: delta (TASK-080) và reconciliation đang truyền 20s sẽ bị đổi
body-consumption semantics mà không có phê duyệt — trái với scope TASK-093 đã
khóa (worker-email là behavioral target duy nhất; các service khác chỉ
compatibility review). **KHÔNG ĐƯỢC CHỌN nếu chưa có phê duyệt scope tường
minh của người dùng.** Ghi lại như alternative để reviewer thấy trade-off;
nếu sau này muốn adopt cho delta/Telegram, mở task riêng.

### §7.1. Absolute deadline contract (khóa cho Phase 2 — Option A1)

1. **Một timer duy nhất**, bắt đầu TRƯỚC khi gọi fetch.
2. Cùng absolute deadline bao phủ: chờ response headers + đọc toàn bộ
   response body + parse body ở mức async response consumer (callback).
3. Timer chỉ clear sau khi consumer hoàn tất hoặc operation thất bại —
   KHÔNG clear khi headers về.
4. KHÔNG tạo: 20s fetch + 20s body; body-specific budget cộng dồn;
   Promise.race để body stream tiếp tục chạy nền.
5. Khi deadline fire: `controller.abort()` được gọi; fetch hoặc body stream
   bị hủy thật; error cuối normalize thành `HttpTimeoutError`.
6. Có **timeout-fired marker** (cơ chế cờ `timedOut` hiện hữu của helper) để
   phân biệt: AbortError do deadline ⇒ `HttpTimeoutError`; malformed JSON /
   provider-HTTP error / consumer parse error khi marker chưa fire ⇒ rethrow
   nguyên trạng cho caller classify như hiện hành.
7. Malformed JSON khi deadline chưa fire giữ classification hiện hành
   (Graph `parse`; refresh `token_endpoint`) — không bao giờ thành timeout.
8. Consumer callback không nhận/log raw body ngoài behavior hiện hữu (callback
   chính là code status/parse hiện tại của service, di chuyển vào trong).
9. Pass-through behavior hiện tại của helper giữ nguyên khi capability mới
   không được bật.
10. Caller không opt-in không nhận body-deadline behavior mới — kể cả khi họ
    đang truyền `timeoutMs`.

### OPTION B — Caller sở hữu AbortController và deadline xuyên fetch + body

Chuyển timer/abort/`timedOut` logic ra 2+ call-site (refresh, graph) ⇒
duplicate đúng phần logic tinh vi nhất (phân biệt timeout vs abort khác, timer
cleanup), dễ lệch giữa các caller, churn cao hơn A, mất single-source-of-truth
mà TASK-080 đã cố ý tạo ra ở helper. Không có ưu điểm bù lại. **Loại.**

### OPTION C — Body-read timeout RIÊNG sau khi nhận headers

Hai timer nối tiếp ⇒ total worst-case = 20s + X — chính là điều §5/TASK-092
cấm làm "một cách vô ý"; nếu X=20s thì tổng 40s/request ⇒ pre-claim worst-case
80s > mailbox TTL 60s (phá lập luận §10.1 TASK-092). Muốn giữ tổng 20s thì
timer thứ hai phải trừ thời gian đã dùng — tức tự tay làm lại absolute
deadline của Option A nhưng phức tạp hơn. **Loại.**

### OPTION D — Chỉ harden Graph body, bỏ token-refresh body

Refresh body read còn "rộng" hơn Graph (đọc cả error payload); cùng blast
radius; chi phí thêm ≈ một call-site. Bất đối xứng vô lý — cùng lý do loại
Option C của TASK-092. **Loại.**

### OPTION E — NO CHANGE

Lập luận khả dĩ: undici bodyTimeout mặc định ~300s idle đã bound stall hoàn
toàn. Bị bác vì: (a) không phải guarantee của code — TASK-092 Phase 1 đã loại
chính nhóm "timeout do thư viện mặc định" này; (b) 300s vượt mọi budget liên
quan (20s deadline, 60s mailbox TTL) và slow-drip unbounded; (c) DF-92-1 đã
được ba vòng review ghi nhận là residual cần đóng bằng task riêng — chính là
task này. **Loại — có xem xét nghiêm túc.**

### Recommendation (duy nhất)

**OPTION A1 — narrow opt-in.** Không blocker; không cần user scope decision
(A1 khả thi và giữ nguyên behavior mọi caller ngoài worker-email). A2 bị loại
vì là behavioral scope expansion chưa được phê duyệt.

---

## §8. Deadline value

- **20_000 ms của TASK-092 hiện là HEADERS deadline** (evidence §2: timer clear
  tại `helper` 80–82 khi fetch settle). Ý định thiết kế TASK-092 ("một
  round-trip JSON nhỏ", "worst-case HTTP 2×20s=40s pre-claim") ngầm coi nó là
  trần cho cả request — Phase 2 chỉ làm cho semantics khớp ý định.
- **Đề xuất: giữ MỘT absolute deadline 20_000 ms cho fetch + body**, dùng
  nguyên hằng số `EMAIL_WORKER_HTTP_TIMEOUT_MS` — không tách budget, không
  cộng thêm, không constant mới, không env variable.
- Evidence kích thước payload: token refresh là JSON nhỏ (vài trăm byte —
  fixture test hiện có); `getMessageById` dùng `$select` giới hạn field, body
  email vài KB tới vài trăm KB — 20s tổng vẫn rộng rãi cho mạng bình thường
  (delta path tải cả TRANG delta nhiều message trong cùng 20s từ TASK-080).
- **Mailbox-lock budget — phát biểu chính xác (không phải invariant):** sau
  Phase 2, HAI Microsoft network operations của một attempt được code-bound
  bằng tổng tối đa 2 × 20s = 40s (nếu cả hai đều chạy). Các pre-claim
  operations còn lại (DB lookup/dedup reads/claims, decrypt, detector) KHÔNG
  có code-level deadline riêng, nên "pre-claim phase < mailbox-lock TTL 60s"
  chỉ là **operational expectation** (DB ops bình thường ở mức ms), KHÔNG
  phải invariant toán học. TASK-093 cải thiện boundedness của hai HTTP
  operations (một hang giải phóng sau ≤20s thay vì ~300s idle/unbounded
  slow-drip) nhưng **không giải quyết DF-92-6** — mailbox-lock TTL/renewal
  vẫn ngoài scope. Không tuyên bố TASK-093 làm lập luận budget của TASK-092
  "đúng trọn vẹn".

---

## §9. Migration và service impact

Xác minh: **không** Prisma migration, **không** Redis structure, **không** env,
**không** BullMQ configuration change (không có state/schema nào liên quan).

| Service / caller | Behavioral change (Phase 2, Option A1) | Verification impact | Lý do |
|---|---|---|---|
| worker-email | **YES** — body read của refresh + getMessageById vào trong absolute deadline 20s (opt-in flag BẬT tại đúng hai điểm wiring của email runner) | Unit tests mới + regression | Mục tiêu task |
| worker-delta | **NO** — delta runner KHÔNG truyền opt-in flag ⇒ giữ bit-for-bit semantics TASK-080 (headers-only 20s; body read như hiện tại). Seam riêng của delta (395/334) cũng không sửa — DF-93-1 | Compile + full regression (shared service/type đổi additive) | Compatibility only |
| worker-renewal (gồm reconciliation reuse renewal port — reconciliation đang truyền 20s) | **NO** — không truyền flag ⇒ headers-only/pass-through giữ nguyên | Compile + regression | Compatibility only |
| web (inbox-test, OAuth/profile, `listInboxMessages`) | **NO** — không truyền timeout/flag ⇒ pass-through giữ nguyên | Compile + regression | Compatibility only |
| mailbox-disconnect-remote-cleanup | **NO** — không truyền options ⇒ pass-through | Compile | Compatibility only |

Nếu implementation Phase 2 phát hiện matrix này không thể giữ (một caller
ngoài worker-email buộc phải đổi behavior), đó là **user scope decision** —
DỪNG và báo, không tự quyết.

---

## §10. Deterministic test matrix cho Phase 2 (design-only)

Quy ước: fake timers + controllable ReadableStream/controllable promise; mock
fetch trả Response có body stream điều khiển được; không real network; không
wall-clock 20s; mỗi case có negative assertion.

| # | Case | Layer/file dự kiến | Cơ chế | Expected |
|---|------|--------------------|--------|----------|
| 1 | Headers + body success trong deadline | helper test (`fetch-with-timeout` mở rộng) + `graph-mail.timeout.test.ts` | Response body resolve nhanh | payload trả về; timer cleared; signal KHÔNG aborted sau khi advance quá deadline |
| 2 | Headers resolve, body hang | như #1 | Response với stream không bao giờ đóng nhưng reject theo signal | settle đúng tại deadline; `HttpTimeoutError`/`GraphMailError('network')`; không pending vô hạn |
| 3 | Absolute deadline chưa hết | như #1 | headers về ở t=1s, body xong ở t=19s (advance timers) | thành công; không abort |
| 4 | Deadline hết TRONG body read | như #1 | headers t=1s, body hang; advance tới 20s | abort đúng lúc 20s tính TỪ LÚC FETCH BẮT ĐẦU (absolute, không phải 20s sau headers) — assert chưa settle ở 19.999s |
| 5 | Signal thật abort body stream | helper test | mock consume lắng nghe `signal` abort event và reject | `signal.aborted === true`; consume reject nhận được từ abort, helper ném `HttpTimeoutError` |
| 6 | Timer cleanup | như #1 | success rồi advance xa | không late-abort; không timer treo |
| 7 | Malformed JSON KHÔNG thành timeout | graph + refresh service tests | body trả text không phải JSON, không hết deadline | Graph: `parse`/`GRAPH_RESPONSE_NOT_JSON`; refresh: `token_endpoint` ⇒ transient; KHÔNG `HttpTimeoutError` |
| 8 | Real 401/403 giữ classification | graph service test | status 401/403 (không cần body) | `auth`/`permission` như cũ; body deadline không đụng |
| 9 | Token body timeout KHÔNG persist rotated credential | `email-worker-runner.test.ts` mở rộng | refresh reject network (mô phỏng hậu body-timeout) | classification transient; `persistRotatedRefreshToken` không được gọi |
| 10 | Graph body timeout trước ProcessedMessage claim | pipeline test hiện có mở rộng | graphMail reject network | `FAILED_GRAPH_FETCH`; store không có row/lease mới |
| 11 | Processor settle/rethrow | `email-worker.test.ts` sẵn có | status transient | throw `EmailWorkerProcessingError` |
| 12 | Mailbox lock release | throttling tests sẵn có + case body-fail | job fail rồi job 2 cùng mailbox | job 2 acquire ngay |
| 13 | BullMQ retry policy không đổi | options-level test sẵn có | — | attempts 3 / backoff 5s |
| 14 | No infinite pending | #2/#4 | — | mọi promise settle tại deadline |
| 15 | Two hangs không mất capacity vĩnh viễn | worker-level test với fake pipeline pending có deadline mô phỏng | 2 slot hang rồi timeout | cả hai settle ≤ deadline; slot trả lại |
| 16 | No-timeout compatibility | helper + graph/refresh tests | không truyền timeoutMs | pass-through bit-for-bit: không signal, body read không deadline |
| 17 | **Headers-only caller compatibility (A1)** — delta refresh caller | refresh service test + `delta-polling-runner` wiring assertion | `timeoutMs` CÓ nhưng opt-in flag KHÔNG | giữ EXACT pre-TASK-093 behavior: deadline chỉ phủ headers, body read ngoài window (assert: sau headers, advance quá deadline ⇒ body read KHÔNG bị abort); delta runner không truyền flag |
| 18 | **Reconciliation/other timeout caller compatibility** | renewal-port/reconciliation tests hiện có chạy nguyên trạng + wiring assertion không có flag | như #17 | behavior hiện tại giữ nguyên |
| 19 | **Email opt-in wiring** | `email-worker-runner.test.ts` mở rộng | spy options | CẢ HAI seam truyền `timeoutMs === EMAIL_WORKER_HTTP_TIMEOUT_MS` VÀ opt-in flag BẬT |
| 20 | TASK-080/090/091/092 regressions | full suite (`delta-polling.timeout.test.ts`, `telegram-sender.timeout.test.ts`, renewal tests… không sửa) | — | các test hiện có pass không sửa semantics |
| 21 | Refresh đọc error body trong deadline | refresh service test | status 400 + body revoke code, resolve nhanh | vẫn đọc được code ⇒ reconnect classification giữ nguyên (real readable `invalid_grant`/`interaction_required` ⇒ reconnect như hiện tại) |
| 22 | Deadline-fired body AbortError ⇒ `HttpTimeoutError` (không phải AbortError trần hay parse) | helper test | marker `timedOut` fire trong consume | error là `HttpTimeoutError`; negative: không phải khi marker chưa fire |
| 23 | OAuth error-body timeout không reconnect + không persist | runner/refresh tests | error body hang, deadline fire | classification transient; `markReconnectRequired` không gọi; `persistRotatedRefreshToken` không gọi |
| 24 | Timer tính từ lúc fetch bắt đầu, không reset khi headers về | helper test | headers về ở t=10s, body hang | abort tại t=20s (không phải t=30s) |

---

## §11. Out of scope

Như đề bài: mailbox-lock TTL/renewal/Redis wiring; DF-92-2 signal composition;
web/OAuth/listInboxMessages hardening; timeout observability redesign;
Telegram/delta implementation (ngoài compatibility review §9); error taxonomy
redesign; Railway; production rollout.

---

## §12. Deferred findings

| # | Finding | Evidence | Xử lý |
|---|---|---|---|
| DF-93-1 | Delta path body reads ngoài window: `fetchDeltaPage` json (delta-polling.service 395), `readGraphErrorDiagnostics` json (334), VÀ body read của refresh trên delta path (delta không opt-in A1) | §4, §7 | Deferred — adopt capability A1 cho delta là task riêng, cần user phê duyệt scope |
| DF-93-2 | Telegram sender body read ngoài window (telegram-sender.service 240) | §4 | Deferred — TASK-090 seam; cùng pattern adopt sau |
| DF-93-3 | `graph-subscription.service.ts` 431 `.text()` và các web/OAuth body reads | §4 | Deferred — trùng DF-92-3/5 |
| DF-93-4 | Undici `bodyTimeout` default là runtime-level safety net không được code pin/verify | §3.4 | Ghi nhận; không đề xuất pin (không tự thêm dispatcher config trong task này) |

---

## §13. Acceptance gates cho Phase 2 (nếu Option A1 được duyệt)

1. Absolute end-to-end deadline (fetch + body, contract §7.1) được bật QUA
   OPT-IN FLAG tại đúng hai seam worker-email; giá trị giữ 20_000; không
   constant/env mới.
2. Cancellation thật: abort terminate body stream; không Promise.race; không
   stream chạy nền sau timeout; một timer duy nhất tính từ lúc fetch bắt đầu.
3. Body timeout ⇒ `HttpTimeoutError` ⇒ transient statuses hiện có; malformed
   JSON giữ nguyên classification; 401/403/reconnect/ErrorQuotaExceeded không
   đổi; TASK-085 persist không chạy khi timeout; OAuth error-body timeout
   không mark reconnect.
4. Backward compatibility bit-for-bit: no-timeout caller; headers-only caller
   đang truyền `timeoutMs` mà không truyền flag (delta, reconciliation);
   caller cũ của `fetchWithTimeout`.
5. Service matrix §9 giữ đúng: behavioral change CHỈ ở worker-email; nếu
   không giữ được ⇒ DỪNG, cần user scope decision.
6. `npm run verify` PASS; test matrix §10 hiện thực hóa (gồm compatibility
   cases #17–18).

**Implementation scope dự kiến Phase 2 (nhỏ):** `lib/http/fetch-with-timeout.ts`
(thêm consume-capability, giữ API cũ), `refresh-access-token.service.ts` +
`graph-mail.service.ts` (chuyển body read vào consume), tests mới/mở rộng.
Không file nào khác.

---

## §14. Verdict Phase 1

- DF-92-1 **CONFIRMED ở mức code** (body reads ngoài cửa sổ timer; không code
  path nào abort sau headers).
- Mức nghiêm trọng được định lượng trung thực: không vô hạn tuyệt đối trong
  runtime mặc định (undici idle ~300s cho stall hoàn toàn) nhưng không được
  code bảo đảm, slow-drip unbounded, và vượt xa mọi budget 20s/60s liên quan.
- Option E (NO CHANGE) xem xét nghiêm túc — **bị loại**; Option A2 (automatic
  strengthening cho mọi caller có `timeoutMs`) — **bị loại vì là behavioral
  scope expansion chưa được phê duyệt**.
- **Recommendation: OPTION A1 — narrow opt-in**: absolute end-to-end deadline
  20_000 ms xuyên fetch + body (contract §7.1) qua consume-capability của
  shared helper, kích hoạt bằng opt-in flag tường minh CHỈ từ email-worker
  caller; mọi caller khác giữ bit-for-bit semantics; cancellation thật; không
  migration; không env; không đổi classifier.

> Antigravity Architecture Review kết luận:
> **PASS — TASK-093 PHASE 1 ARCHITECTURE APPROVED FOR PHASE 2 IMPLEMENTATION.**

---

## §15. Phase 2 — Implementation thực tế (đúng Option A1 đã khóa)

### §15.1. Final helper API (`lib/http/fetch-with-timeout.ts`)

- Internal core mới `runWithDeadline(timeoutMs, run)` — MỘT timer + MỘT
  AbortController + cờ `timedOut`, dùng chung cho cả hai exported functions
  (không duplicate logic): timer arm TRƯỚC `run`, clear duy nhất trong
  `finally` sau khi `run` settle; fire ⇒ `controller.abort()`; reject khi
  `timedOut` ⇒ normalize `HttpTimeoutError`; reject khác ⇒ rethrow nguyên bản.
- `fetchWithTimeout` — chữ ký + behavior GIỮ NGUYÊN (headers-only deadline;
  pass-through khi không có timeout) — nay implement trên core chung.
- **MỚI** `fetchAndConsumeWithTimeout<T>(fetchImpl, url, init, consume,
  options)` với `consume: (response, signal?) => Promise<T>`: cùng
  `timeoutMs` là MỘT absolute deadline phủ fetch + toàn bộ consume (body read
  + parse); không timer thứ hai, không cộng budget, không Promise.race;
  consume nhận `signal` của deadline để caller có thể rethrow ĐÚNG rejection
  do abort (giữ swallow/parse semantics riêng cho lỗi không-timeout);
  pass-through hoàn toàn (fetch trực tiếp + consume không signal) khi không
  có positive `timeoutMs`.

### §15.2. Opt-in flags (default OFF) và exact wiring

- `RefreshAccessTokenOptions.deadlineCoversBodyRead?: boolean` — OFF ⇒ path
  legacy nguyên trạng (fetchWithTimeout + body read ngoài window, swallow
  parse như cũ); ON ⇒ `fetchAndConsumeWithTimeout`, body đọc cho CẢ success
  lẫn OAuth error payload như trước, non-abort parse failure giữ swallow ⇒
  các nhánh `token_endpoint` hiện hành, deadline-abort ⇒ `network`.
- `GetMessageOptions.deadlineCoversBodyRead?: boolean` — OFF ⇒ path legacy;
  ON ⇒ consume = shared `throwForGraphErrorStatus` (non-2xx classify thuần
  bằng status + retry-after header, KHÔNG đọc error body) rồi shared
  `parseGraphJsonBody` (non-abort ⇒ `parse` như cũ; deadline-abort ⇒
  `network`). Hai hàm shared này được CẢ legacy path dùng nên không drift.
  `listInboxMessages` không đổi.
- **Email wiring** (`email-worker-runner.ts`): cả hai call-site giữ
  `timeoutMs: EMAIL_WORKER_HTTP_TIMEOUT_MS` (20_000, không đổi) và thêm
  `deadlineCoversBodyRead: true`. Thứ tự calls không đổi — vẫn trước
  identity/delivery claims; mailbox lock/BullMQ/TASK-090 state machine không
  đụng.

### §15.3. Caller compatibility matrix (xác minh sau implementation)

| Caller | Opt-in? | Behavior |
|---|---|---|
| email-worker (2 seams) | **ON** | absolute 20s fetch+body |
| delta runner | OFF (test pin: options không chứa flag) | headers-only 20s, bit-for-bit TASK-080 |
| reconciliation/renewal port | OFF | như cũ |
| web inbox-test / disconnect-cleanup / `listInboxMessages` | OFF/không timeout | pass-through như cũ |
| Telegram / delta implementation | không sửa | — |

### §15.4. Tests thực tế (mapping matrix §10)

- `tests/unit/lib/fetch-with-timeout.test.ts` (mở rộng): TASK-080 suite cũ
  pass nguyên trạng; describe mới cho `fetchAndConsumeWithTimeout` — 6 cases:
  no-timeout pass-through (fetch + consume không signal); fast headers+body
  success + timer cleanup không late-abort; **absolute deadline: headers ở
  t=10s + body hang ⇒ chưa settle 19.999s, abort đúng t=20s tổng (không phải
  30s), `signal.aborted === true`, `HttpTimeoutError`**; deadline trong fetch
  phase ⇒ `HttpTimeoutError`; consumer error trước deadline rethrow nguyên
  bản; fetch/network error rethrow nguyên bản (#§10: 1–6, 14, 22, 24).
- `tests/unit/microsoft/graph-mail.timeout.test.ts` (mở rộng, +4): opt-in
  body hang ⇒ `network` đúng 20s + abort thật; opt-in malformed JSON ⇒
  `parse` (không timeout); opt-in real 401 ⇒ `auth` và **json không bao giờ
  được gọi** (không chờ hanging error body); compatibility — `timeoutMs`
  KHÔNG flag ⇒ body KHÔNG bị abort sau deadline (manual resolve để không leak
  handle) (#2, 7, 8, và compatibility Graph).
- `tests/unit/microsoft/refresh-access-token.timeout.test.ts` (mở rộng, +5):
  opt-in success-body hang ⇒ `network`/transient; opt-in OAuth error-body
  hang ⇒ `network`/transient, không mã lỗi, không reconnect; readable
  `invalid_grant` với opt-in ⇒ `token_endpoint`+code ⇒ reconnect_required;
  malformed JSON ⇒ `token_endpoint`/transient; compatibility headers-only
  (timeoutMs không flag) ⇒ body không abort, manual resolve (#9, 19, 21, 23,
  và #17-refresh).
- `tests/unit/queue/email-worker-runner.test.ts`: wiring assertions cập nhật
  — cả hai seam nhận `{ timeoutMs: 20_000, deadlineCoversBodyRead: true }`
  (#19-wiring); test TASK-092 "timeout ⇒ transient + không persist" giữ
  nguyên (#9).
- `tests/unit/queue/delta-polling-runner.test.ts` (+1): pin compatibility —
  delta truyền đúng `timeoutMs 20_000` và **options KHÔNG chứa**
  `deadlineCoversBodyRead` (#17-wiring).
- Coverage sẵn có tái dùng: pipeline/worker rethrow, lock release, claims,
  TASK-085 CAS, TASK-090 delivery, TASK-091 403, TASK-092 header-timeout,
  TASK-080 delta (#10–13, 15, 18, 20).

### §15.5. Trạng thái & Antigravity Implementation Review

- Phase 2 implementation + deterministic tests hoàn tất; `npm run verify`
  PASS.
- **Antigravity Implementation Review: PASS — TASK-093 PHASE 2 IMPLEMENTATION
  APPROVED.** Không có finding Critical, High hoặc Medium.
- Low notes được ghi nhận, KHÔNG chặn nghiệm thu và KHÔNG sửa trong TASK-093:
  (1) timeout observability tiếp tục gộp vào network classification;
  (2) "pre-claim dưới 60 giây" chỉ là operational expectation (không phải
  invariant); (3) các adjacent body-read seams (delta/Telegram/subscription/
  web) vẫn deferred.
- Review xác nhận implementation đúng Option A1 Narrow Opt-in như phê duyệt:
  shared `fetchAndConsumeWithTimeout<T>` (core `runWithDeadline` dùng chung);
  MỘT absolute deadline 20.000 ms bao phủ fetch + body; timer bắt đầu trước
  fetch và không reset ở headers; cancellation thật bằng AbortController;
  deadline abort normalize thành `HttpTimeoutError`; malformed/provider/
  consumer errors trước deadline giữ behavior hiện hành; `fetchWithTimeout`
  hiện hữu giữ legacy behavior; capability default OFF; chỉ HAI worker-email
  seams bật opt-in.
- Shared-caller compatibility xác nhận: worker-delta, reconciliation/renewal,
  web/cleanup không opt-in; `listInboxMessages` và Telegram không đổi;
  behavioral change chỉ ở worker-email.
- Error/invariant evidence xác nhận: Graph body timeout → network →
  `FAILED_GRAPH_FETCH` → BullMQ retry; token body timeout → network/transient
  → `FAILED_TOKEN_TRANSIENT` → retry; readable
  `invalid_grant`/`interaction_required` vẫn reconnect; unreadable/hanging
  OAuth error body không mark reconnect; real 401/403 giữ nguyên; không
  credential persistence/CAS conflict; không ProcessedMessage/delivery claim;
  không Telegram trên nhánh timeout; TASK-080/085/090/091/092 regression
  PASS.
- Test evidence: targeted 7 files / 81 tests PASS; full 110 files /
  1366 tests PASS (16 deterministic tests mới); lint/typecheck/build PASS;
  `git diff --check` PASS.
- Không migration; không env/Redis/BullMQ/Railway change. Residual giữ
  deferred: DF-93-1 (delta body reads), DF-93-2 (Telegram body read), DF-93-3
  (subscription/web/OAuth body reads), DF-93-4 (undici default không được
  code pin), DF-92-2 (caller-signal composition), DF-92-4/DF-92-6
  (mailbox-lock wiring/TTL), timeout observability — không tự biến thành
  TASK-094.
- Các bước sau Implementation Review (Final Pre-Commit Review, commit/push,
  feature CI, staging promotion, runtime validation) và trạng thái close-out:
  xem §16.

---

## §16. Close-out — quality gates, staging runtime validation, completion status

> Documentation-only close-out. Không implementation, không sửa code/tests,
> không migration, không thao tác Railway, không production rollout.

### §16.1. Quality gates (tất cả PASS)

1. Phase 1 Investigation / Architecture — hoàn tất (§1–§14).
2. Antigravity Architecture Review — PASS.
3. Phase 2 implementation + deterministic tests — hoàn tất (§15).
4. Antigravity Implementation Review — PASS.
5. Antigravity Final Pre-Commit Review — PASS.
6. Feature commit/push — PASS.
7. Feature CI — PASS.
8. Controlled fast-forward promotion sang staging — PASS.
9. Staging CI — PASS.
10. Railway staging runtime validation — PASS.
11. Antigravity Staging Runtime Validation — **PASS — TASK-093 STAGING RUNTIME
    VALIDATION APPROVED**.
12. Không có finding Critical, High hoặc Medium.

### §16.2. Implementation đã chốt (recap)

- Kiến trúc **Option A1 — Narrow Opt-in** (§7, §15).
- MỘT absolute deadline 20.000 ms phủ: fetch/request phase, response headers,
  response body consumption và asynchronous consumer parsing.
- Timer bắt đầu trước fetch; KHÔNG reset khi headers trả về; chỉ clear sau
  khi consumer settle.
- Cancellation thật bằng AbortController; deadline normalize thành
  `HttpTimeoutError`; không dùng Promise.race để bỏ HTTP/body operation chạy
  nền.
- Capability mặc định OFF; chỉ đúng hai Microsoft seams trên worker-email bật
  opt-in: access-token refresh và Graph `getMessageById`.
- `fetchWithTimeout` legacy headers-only behavior giữ nguyên.
- worker-delta, worker-renewal/reconciliation, web, cleanup,
  `listInboxMessages` và Telegram KHÔNG nhận behavioral change từ TASK-093.
  Behavioral change thực tế chỉ ở worker-email.
- Không schema/migration/env/Redis/BullMQ/Railway architecture change.

Error semantics đã chốt:

- Graph body deadline: network/transient → `FAILED_GRAPH_FETCH` → BullMQ retry.
- Token response-body deadline: network/transient → `FAILED_TOKEN_TRANSIENT`
  → BullMQ retry.
- Không giả thành 401 hoặc 403; không mark RECONNECT_REQUIRED khi provider
  error code chưa đọc được.
- Readable `invalid_grant`/`interaction_required` giữ reconnect semantics
  hiện hành; real Graph 401/403 vẫn classify bằng HTTP status như hiện hành;
  ErrorQuotaExceeded semantics của TASK-091 không đổi.
- Timeout xảy ra trước credential persistence và trước ProcessedMessage/
  delivery ownership claims — không CAS conflict, không permanent
  ProcessedMessage failure, không Telegram side effect.

### §16.3. Verification evidence

- Targeted: 7 test files / 81 tests PASS.
- Full suite: 110 test files / 1366 tests PASS (16 deterministic tests mới).
- ESLint PASS; TypeScript typecheck PASS; Next.js production build PASS;
  Prisma generate PASS; `git diff --check` PASS.

### §16.4. Runtime staging evidence (phân loại nguồn)

Nguồn evidence: (a) Git/SHA/code/verify do Antigravity kiểm tra trực tiếp từ
repository; (b) GitHub Actions, Railway, admin health và queue/runtime
evidence do operator cung cấp — Antigravity KHÔNG tuyên bố đã trực tiếp truy
cập Railway.

Ghi nhận:

- Reviewed feature SHA = promoted staging SHA:
  `05a29085402b061150bfdc168dc13046936663ac`.
- Promotion là fast-forward thuần; không merge commit hoặc commit lạ.
- Staging GitHub Actions PASS.
- Bốn Railway services (web, worker-email, worker-delta, worker-renewal) vẫn
  dùng branch staging; Auto Deploy = ON; Wait for CI = ON.
- Chỉ web có Pre-Deploy (`npx prisma migrate deploy`); TASK-093 không có
  migration nên Pre-Deploy hoàn tất dạng no-op.
- Bốn services Active/Healthy; `/admin/health` không regression.
- worker-email không crash loop hoặc unhandled rejection mới.
- Không spike bất thường của `FAILED_TOKEN_TRANSIENT`, `FAILED_GRAPH_FETCH`,
  Graph parse errors, token endpoint errors, timeout/network failures.
- worker-delta và worker-renewal không regression quan sát được.
- Queue không có backlog tăng liên tục hoặc mất concurrency capacity.

### §16.5. Evidence limitations (trung thực)

- Natural Microsoft response-body hang/slow-drip: **NOT OBSERVED — EXPECTED**.
- KHÔNG tuyên bố staging đã tự nhiên kích hoạt timeout 20 giây.
- Không tạo synthetic outage hoặc synthetic body hang trên staging.
- Absolute deadline và abort behavior được chứng minh chủ yếu bằng
  deterministic tests với fake timers và controllable response body (§15.4).
- High-throughput load test không được thực hiện.
- Không có natural hang hoặc load test không phải blocker: startup, health,
  queues và các worker đều ổn định.

### §16.6. Residual findings (giữ deferred, KHÔNG thuộc scope TASK-093)

- DF-93-1: delta response-body reads, gồm delta refresh path, chưa opt-in.
- DF-93-2: Telegram response-body read chưa có deadline riêng.
- DF-93-3: subscription/web/OAuth response-body seams ngoài scope.
- DF-93-4: undici/default body timeout không được pin bằng code.
- DF-92-2: caller AbortSignal composition.
- DF-92-4: Redis-backed mailbox-lock production wiring.
- DF-92-6: mailbox-lock TTL 60 giây ngắn hơn worst-case valid attempt.
- Timeout observability vẫn được gộp vào network classification.

Không finding nào được biến thành implementation của TASK-093; không tự tạo
TASK-094.

### §16.7. Completion status

- Investigation/Architecture: COMPLETE.
- Implementation: COMPLETE.
- Review (Architecture / Implementation / Pre-Commit / Runtime): COMPLETE.
- Feature commit/push + feature CI: COMPLETE.
- Staging promotion + staging CI: COMPLETE.
- Runtime validation: COMPLETE.
- **TASK-093 hoàn tất end-to-end trên staging.**
- **Chưa production rollout.**
- ROADMAP được cập nhật trong close-out này (entry TASK-093 completed
  end-to-end).
- **Task tiếp theo: CHƯA được quyết định.**
