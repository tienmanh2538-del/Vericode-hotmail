# TASK-089 — Microsoft Graph Delta 410 SyncStateNotFound Recovery & Cursor Resilience

> **TRẠNG THÁI: TASK-089 COMPLETED.**
>
> Chuỗi quality gates đầy đủ: Antigravity Final Architecture Re-review PASS → Antigravity Final
> Implementation Review PASS → ROADMAP close-out → controlled ff-promotion vào branch `staging`
> (TASK-088, CASE 1) → **Antigravity Staging Runtime Validation PASS** — evidence ở **§25**.
> Architecture B++ và implementation history (§1–§24) giữ nguyên, không viết lại.
>
> Correction số liệu sau Implementation Review: file test mới có **23** test case (đếm chính
> thức bằng vitest; draft trước ghi nhầm 21 — lỗi đếm tài liệu, không phải thay đổi test).
>
> Antigravity Final Architecture Re-review: **PASS — TASK-089 FINAL ARCHITECTURE APPROVED FOR
> PHASE 2 IMPLEMENTATION**. Architecture bắt buộc: **OPTION B++ — REPLACE-ON-SUCCESS WITH SHARED
> LEAF FRESHNESS POLICY**. Implementation thực tế ghi ở **§24**. `npm run verify` PASS
> (105 test files / 1304 tests). Sau đó đã close-out ROADMAP và promotion theo TASK-088 (§25).
>
> Lịch sử correction:
> * Antigravity Architecture Review lần đầu **PASS**; Human/ChatGPT ra **HD-1** (không khóa
>   Option A vì fresh-message-loss scenario) ⇒ điều tra **Option B+** (§22).
> * Trước re-review, Human/ChatGPT ra tiếp **HD-2** (kiểm tra "replace invalid cursor only after
>   successful recovery") và **HD-3** (review dependency direction của freshness constant) ⇒
>   điều tra **Option B++ (replace-on-success)** — kết quả ở **§23**.
> * **Recommendation hiện hành: OPTION B++** (§15, §23.8). OD-6 được RESOLVE (§20, §23).
>
> §1–§13 giữ nguyên làm evidence nền. §14 = so sánh ban đầu (trước HD-1). §22 = correction HD-1
> (B+ — nay bị B++ thay ở điểm sequencing reset; phần Q1–Q12 của §22 vẫn đúng và được §23 kế
> thừa, trừ chỗ nào §23 ghi đè rõ ràng).
>
> Tài liệu này KHÔNG chứa implementation. Không runtime code, không schema/migration, không test
> nào được sửa trong Phase 1. Không thao tác Railway (mô hình TASK-088: cả 4 service theo dedicated
> branch `staging`, promotion fast-forward do Human thực hiện — Phase 1 không deploy gì).
>
> **Nhãn bằng chứng dùng xuyên suốt:**
> * **REPO EVIDENCE** — đọc trực tiếp file trong repo, kèm đường dẫn/dòng.
> * **OFFICIAL MICROSOFT EVIDENCE** — trích từ Microsoft Learn (nguồn ghi rõ ở §13).
> * **INFERENCE** — suy luận từ hai loại trên; ghi rõ là suy luận.
>
> **Quy ước an toàn:** không ghi token/secret/URL kết nối; cursor được ký hiệu trừu tượng
> (C0 = cursor hợp lệ trước sự cố, C-invalid = cursor bị Graph từ chối); không ghi tên nhánh Git
> đầy đủ; không email address thật.

---

## 1. Context / source observation

TASK-088 Phase 2D smoke (Human-observed trên staging dashboard) ghi nhận một Graph runtime
observation: **HTTP 410 / SyncStateNotFound** trên đường delta polling. Lúc đó Delta polling tổng
thể vẫn PASS, và TASK-088 phân loại đây là *existing / independent operational observation* — cố ý
không sửa vì ngoài scope.

TASK-089 Phase 1 điều tra: khi Microsoft Graph trả 410 cho một delta request, code hiện tại làm gì,
hậu quả là gì, và kiến trúc recovery tối thiểu nào là đúng.

**Kết luận điều tra (chi tiết ở §4–§5):** 410 hiện rơi vào nhánh lỗi `unknown` — cursor **không**
bị reset, không backoff, không recovery. Mailbox bị ảnh hưởng sẽ **lặp lại vô hạn** cùng một
invalid cursor mỗi tick (~30s), mỗi tick tốn một token refresh + một Graph call, cho tới khi có
người can thiệp thủ công. Đường webhook không bị ảnh hưởng; các mailbox khác trong cùng cycle không
bị ảnh hưởng.

---

## 2. Exact current code path (REPO EVIDENCE)

Đường đi của một delta request và lỗi HTTP:

```text
scripts/run-delta-polling-worker.ts
  → startDeltaPollingScheduler()            services/queue/workers/delta-polling-runner.ts
      tick mỗi DELTA_POLLING_INTERVAL_SECONDS (default 30s, min do env guard),
      non-overlap bằng biến `inflight` (skip tick khi tick trước còn chạy)
  → runDeltaPollingOnce(deps)               services/microsoft/delta-polling.service.ts
      → repo.listActiveMicrosoftMailboxes()  — CHỈ mailbox provider MICROSOFT, status ACTIVE
      → per mailbox:
          cooldown check (TASK-075) → accessToken (runner port, TASK-069C/080/085)
          → pollMailboxDelta()
              → fetchDeltaPage(url, ...)     — fetchWithTimeout 20s (TASK-080)
                  !response.ok →
                    kind = classifyHttpStatus(status)     [dòng ~277]
                    diagnostics = readGraphErrorDiagnostics(response)
                        — chỉ đọc error.code, error.innerError.code, request-id header
                    throw DeltaPollingHttpError(kind, status, 'GRAPH_REQUEST_FAILED', diagnostics)
          → catch trong runDeltaPollingOnce:
              kind === 'auth'      (401) → markReconnectRequired + recordDeltaError
              kind === 'forbidden' (403) → handlePersistentForbidden (TASK-071 reset + TASK-075 backoff)
              else                       → recordDeltaError (metadata only)   ← 410 RƠI VÀO ĐÂY
```

`classifyHttpStatus` (REPO EVIDENCE, `services/microsoft/delta-polling.service.ts`):

```text
401 → 'auth' | 403 → 'forbidden' | 429, 5xx → 'transient' | mọi status khác → 'unknown'
```

**KHÔNG có nhánh 410.** HTTP status được parse duy nhất tại đây; Graph error code
(`SyncStateNotFound`) được parse duy nhất tại `readGraphErrorDiagnostics` và hiện **chỉ dùng để ghi
chuỗi chẩn đoán** (`safeErrorMessage` → `deltaLastErrorMessage`), không tham gia phân loại.

Trả lời 8 câu hỏi mục A của đề bài:

| # | Câu hỏi | Trả lời (REPO EVIDENCE) |
|---|---|---|
| 1 | HTTP status parse ở đâu | `fetchDeltaPage` → `classifyHttpStatus(response.status)` |
| 2 | Graph error code parse ở đâu | `readGraphErrorDiagnostics` (error.code / innerError.code / request-id) — chỉ chẩn đoán |
| 3 | 410 classify thành gì | `'unknown'` |
| 4 | Nhánh riêng hay chung | Chung nhánh else cuối (cùng chỗ với mọi lỗi không phải 401/403) |
| 5 | Scheduler làm gì sau đó | Không gì đặc biệt: mailbox bị đếm `failedMailboxCount`, cycle đi tiếp mailbox khác; tick sau chạy bình thường |
| 6 | Cursor có bị giữ không | **CÓ** — không code path nào reset cursor cho kind `unknown` |
| 7 | Tick sau có gửi lại chính invalid cursor không | **CÓ** — `pollMailboxDelta` dùng `mailbox.microsoftDeltaCursor` nguyên trạng |
| 8 | Repeated hay bounded | **Unbounded cross-tick retry**: lặp mỗi tick (~30s), không backoff, không giới hạn số lần — cho tới khi cursor bị đổi thủ công hoặc mailbox rời ACTIVE. KHÔNG phải tight-loop trong một cycle (page đầu throw ⇒ mỗi cycle chỉ 1 Graph call cho mailbox đó) |

---

## 3. Cursor lifecycle (REPO EVIDENCE)

### 3.1. Model / field

`prisma/schema.prisma` — model `Mailbox`:

```text
microsoftDeltaCursor  String?    — FULL @odata.deltaLink URL (opaque, không parse $deltatoken)
deltaLastPolledAt     DateTime?
deltaLastErrorAt      DateTime?
deltaLastErrorMessage String?
deltaForbiddenCount         Int @default(0)     (TASK-075)
deltaForbiddenCooldownUntil DateTime?           (TASK-075)
```

### 3.2. Toàn bộ reader/writer (đã grep `microsoftDeltaCursor` toàn repo ngoài tests)

| Thao tác | Nơi duy nhất | Ghi chú |
|---|---|---|
| Đọc | `createPrismaDeltaPollingRepo().listActiveMicrosoftMailboxes` (runner) | select trong findMany |
| Ghi giá trị | `saveDeltaCursor` (runner, dòng ~87) | set cursor + `deltaLastPolledAt` + **clear** error metadata, trong MỘT update |
| Reset về null | `resetDeltaCursor` (runner, dòng ~109) | chỉ set `microsoftDeltaCursor: null`; caller duy nhất: `handlePersistentForbidden` (403, TASK-071) |
| Không nơi nào khác | webhook route, subscription service, web UI, worker khác **không** đọc/ghi cursor | grep xác nhận |

### 3.3. Khi nào cursor được ghi

* **CHỈ khi nhận final `@odata.deltaLink`** (`pollMailboxDelta` trả `newCursor`; `runDeltaPollingOnce`
  gọi `saveDeltaCursor`). Intermediate `@odata.nextLink` **không bao giờ** được persist.
* Multi-page fail giữa chừng ⇒ cursor cũ giữ nguyên ⇒ tick sau đọc lại từ C0 ⇒ **replay các page đã
  enqueue** ⇒ at-least-once có chủ đích; dedup phía sau xử lý (xem §8).
* Ordering: **enqueue trước, persist cursor sau** (enqueue trong vòng lặp page; save sau khi có
  deltaLink). Save cursor fail ⇒ chỉ log warn ⇒ tick sau replay — cũng at-least-once.
* `saveDeltaCursor` fail không chặn `clearForbiddenBackoff`; hai write riêng biệt, không transaction.

### 3.4. Guard

* **Không có CAS/version/transaction** trên cursor. Mô hình an toàn hiện tại là **single-writer**:
  chỉ worker-delta ghi cursor; scheduler non-overlap (`inflight`) chặn chồng lấn trong process;
  1 replica (TASK-088 §21.1, Human-observed) chặn chồng lấn giữa process. Không guard ở tầng DB.
* Token refresh path có CAS riêng cho credential (TASK-085) — không liên quan cursor.

---

## 4. Current 410 behavior (REPO EVIDENCE)

Khi Graph trả 410 (ví dụ error code `SyncStateNotFound`) cho request dùng cursor C-invalid:

```text
1. fetchDeltaPage throw DeltaPollingHttpError('unknown', 410, 'GRAPH_REQUEST_FAILED',
   { graphErrorCode: 'SyncStateNotFound', graphRequestId: ... })
2. catch → nhánh else → safelyRecordError:
   deltaLastPolledAt = now, deltaLastErrorAt = now,
   deltaLastErrorMessage = "GRAPH_REQUEST_FAILED (http=410) code=SyncStateNotFound reqId=..."
3. failedMailboxCount += 1. Cycle đi tiếp mailbox khác.
4. Cursor C-invalid GIỮ NGUYÊN trong DB.
5. Tick sau (~30s): mailbox vẫn ACTIVE → token refresh MỚI (một request tới token endpoint)
   → fetchDeltaPage với ĐÚNG C-invalid → 410 → quay lại bước 1.
```

Những gì 410 hiện **không** làm (đúng — cần giữ):

* KHÔNG mark `RECONNECT_REQUIRED` (chỉ 401/`auth` và token-classification làm việc đó).
* KHÔNG tăng `deltaForbiddenCount` / không cooldown (chỉ 403/`forbidden`).
* KHÔNG bị tính nhầm thành 403.

Những gì 410 hiện **không** làm (sai — lỗ hổng):

* KHÔNG reset cursor → không bao giờ tự phục hồi.
* KHÔNG backoff → chi phí lặp vô hạn: mỗi tick 1 token-endpoint request + 1 Graph request cho
  mailbox hỏng, và error metadata bị ghi đè mỗi tick.

Tương tác health (REPO EVIDENCE, `services/health/health.service.ts`): `classifyDeltaPolling` chỉ
cần **một** mailbox được poll gần đây để báo PASS toàn cục ⇒ một mailbox kẹt 410 vẫn cho dashboard
"Delta polling PASS" (đúng với quan sát TASK-088: 410 hiển thị nhưng Delta polling PASS). Mailbox
level: `deltaLastErrorAt != null` ⇒ lý do "Recent delta polling error" trên chi tiết mailbox.

---

## 5. Retry-loop analysis

* **Loại loop:** unbounded **cross-tick** retry với cùng C-invalid, chu kỳ = polling interval
  (default 30s). Không phải tight-loop trong một cycle. Không tự thoát.
* **Chi phí:** mỗi tick, cho mỗi mailbox kẹt: 1 refresh-token exchange + 1 Graph call + 2 DB write
  (recordDeltaError). Với N mailbox cùng bị invalidate (ví dụ Graph maintenance), chi phí nhân N.
* **So sánh:** 403 có self-heal (reset cursor) + backoff (TASK-071/075); timeout/429/5xx là
  transient thật (thử lại chính cursor là ĐÚNG với transient); 401 có reconnect. **410 là loại lỗi
  duy nhất mà "thử lại chính cursor" chắc chắn vô ích theo semantics provider** (§13) nhưng lại là
  hành vi hiện tại.

Minimal recovery phải tránh (mục E đề bài — đối chiếu):

| Nguy cơ | Hiện trạng | Phase 2 phải bảo đảm |
|---|---|---|
| Immediate tight loop | Không xảy ra (tick pacing) | Giữ nguyên: recovery không thêm vòng lặp trong cycle |
| Unbounded retry cùng invalid cursor | **ĐANG XẢY RA** | Reset một lần → cursor null → không còn C-invalid để reuse |
| Reset liên tục mỗi tick | Không áp dụng (chưa reset) | Sau reset, cursor null ⇒ 410-code-path không còn gì để reset; bootstrap dùng URL mới mỗi lần |
| 410 tính nhầm thành 403 | Không (kind riêng `unknown`) | Nhánh 410 mới phải tách khỏi `forbidden`, không đụng forbidden counters |
| 410 kích hoạt RECONNECT_REQUIRED sai | Không | Giữ: nhánh 410 không đụng status |
| 410 làm tăng persistent-403 counter sai | Không | Giữ |

---

## 6. Bootstrap semantics hiện tại (REPO EVIDENCE — phần CRITICAL)

Khi `microsoftDeltaCursor === null` (`pollMailboxDelta`):

```text
1. URL đầu = /me/mailFolders('inbox')/messages/delta
             ?$select=id&$top=50
             &$filter=receivedDateTime ge (now − bootstrapLookbackHours, default 24h)
   (TASK-036 — bound initial scan; staging đặt 24h theo docs/STAGING_DEPLOYMENT.md)
2. isBootstrap = true ⇒ TRONG SUỐT bootstrap KHÔNG enqueue bất kỳ message nào
   ("During bootstrap we INTENTIONALLY do not enqueue any pre-existing messages" — comment gốc).
   Mọi item chỉ để đi tới deltaLink (establish baseline).
3. Pagination: theo @odata.nextLink, tối đa maxPagesPerMailbox (default 10) page.
4. Cursor CHỈ được lưu khi nhận @odata.deltaLink. Không đạt trong 10 page ⇒ cursor không lưu
   ⇒ tick sau bootstrap LẠI từ đầu (filter timestamp mới).
5. "Tránh relay historical email" = chính bước 2: baseline câm, không có gì vào pipeline.
```

**Bốn câu hỏi bắt buộc của mục C:**

1. **Reset về null + reuse bootstrap hiện tại có replay email cũ không?** **KHÔNG.** Bootstrap không
   enqueue gì cả ⇒ zero replay, zero Telegram risk từ bootstrap.
2. **Có nguy cơ MISS email mới nằm giữa C0 (last valid) và thời điểm bootstrap xong không?** **CÓ —
   trên đường delta.** Message tới sau lần advance cursor cuối và trước khi bootstrap mới lưu
   deltaLink sẽ bị baseline "nuốt" (nó là pre-existing đối với bootstrap) và không bao giờ được
   delta enqueue. Webhook (đường chính, độc lập cursor) vẫn có thể relay nó; nhưng nếu sự cố xảy ra
   đúng lúc webhook cũng miss — kịch bản delta backup tồn tại để đỡ — thì đó là **miss thật
   end-to-end**. Đây là **loss window của backup path**, không phải mất mát chắc chắn.
3. **Khác gì initial mailbox bootstrap?** Về code: không khác gì (cùng path). Về ngữ nghĩa: initial
   bootstrap chưa từng có baseline nên "không relay lịch sử" là đúng mong muốn; recovery bootstrap
   thì **đã từng có baseline** — những message trong khoảng hở lẽ ra PHẢI được relay. Cùng cơ chế,
   khác kỳ vọng.
4. **Có cần recovery-bootstrap mode riêng không?** Có một trade-off thật, trình bày ở §14 (Option
   A so với biến thể A+). **Tiền lệ repo:** TASK-071 đã chấp nhận chính semantics "reset → silent
   re-bootstrap" cho 403; 410 dùng lại semantics đó là nhất quán và tối thiểu; việc thu hẹp loss
   window là một quyết định mở cho Human/ChatGPT (§20, OD-2).

---

## 7. Replay / message-loss analysis

| Kịch bản | Replay? | Loss? | Cơ chế liên quan |
|---|---|---|---|
| Mid-traversal fail (cursor giữ C0) | Có — page đã enqueue bị enqueue lại tick sau | Không | jobId queue-dedup + pipeline dedup (§8) |
| Save cursor fail sau khi enqueue | Có (như trên) | Không | như trên |
| 410 hiện tại (không recovery) | Không | **Có — mọi message mới trên delta path kể từ 410, vô hạn** cho tới khi can thiệp tay; webhook còn sống thì che được | không có cơ chế |
| 410 → reset → bootstrap hiện tại (Option A) | Không (bootstrap câm) | Có — bounded: khoảng hở từ C0 tới khi bootstrap mới lưu deltaLink, chỉ trên delta path | stale guard không giúp gì cho miss |
| 410 → recovery-enumeration có enqueue (A+) | Có — bounded theo lookback recovery | Thu hẹp gần 0 cho message còn "fresh" | dedup chặn double-send; stale guard chặn mail cũ |
| Graph tự replay change (provider "Replays") | Có | Không | dedup (§8) — official evidence §13 |

**Kết luận phải phát biểu đúng mức:** hệ thống hiện có **duplicate-relay protection mạnh** (chứng
minh §8) nhưng **không có no-message-loss guarantee trên delta path** khi cursor bị invalidate —
hiện trạng còn tệ hơn: loss là vô hạn theo thời gian. Option A đổi "loss vô hạn" thành "loss
bounded, được document"; A+ thu hẹp thêm nhưng tăng độ phức tạp.

---

## 8. Duplicate-protection / delivery-semantics analysis (chứng minh bằng ordering — REPO EVIDENCE)

> **Wording chính xác (theo yêu cầu HD-1 correction):** hệ thống KHÔNG có "perfect exactly-once
> Telegram delivery". Bảo đảm thật sự là: **claim-before-send prevents duplicate replay for the
> same claimed message identity, with pre-existing at-most-once-after-claim failure semantics**
> (claim OK → send fail → retry bị early-dedup chặn ⇒ message đó không được gửi lại — DF-1, §19).
> TASK-089 không sửa failure window pre-existing này.

Chuỗi end-to-end:

```text
delta fetch → enqueueDeltaPollingMessageJob
    jobId = "delta-polling:{mailboxId}:{graphMessageId}"   (email-job-options.ts)
    → BullMQ dedup theo jobId (removeOnComplete: 24h/1000; removeOnFail: 7d/5000)
    (webhook dùng prefix jobId riêng ⇒ cùng message qua 2 nguồn = 2 job — cố ý, dedup ở pipeline)
→ worker-email → graph-message-pipeline.service.ts:
    Step 4  EARLY DEDUP (read-only):
            findByGraphMessageId(mailboxId, graphMessageId) → có row ⇒ SKIPPED_DUPLICATE
            findByInternetMessageId → có ⇒ SKIPPED_DUPLICATE
    (TASK-080 stale guard — §9)
    Step 5–7 detector → extractor
    Step 8  CLAIM = claimMessageForProcessing → store.create(ProcessedMessage)
            @@unique([mailboxId, graphMessageId]) — P2002 ⇒ ProcessedMessageDuplicateError
            ⇒ clean duplicate skip (TASK-068A), không retry, không relay
            + code/bucket dedup: codeHash + bucket 5 phút (DEFAULT_BUCKET_MINUTES)
    Step 9  mapping lookup
    Step 10 TELEGRAM SEND — CHỈ sau khi claim thành công
    → markMessageAsSent
```

Trả lời mục G:

* **Unique key:** `[mailboxId, graphMessageId]` trên `ProcessedMessage` (schema); phụ:
  internetMessageId lookup + codeHash/bucket-5-phút.
* **Claim khi nào:** Step 8 — TRƯỚC Telegram. Insert row là điểm serialization.
* **Webhook + delta cùng thấy một graphMessageId:** 2 job (jobId prefix khác) nhưng flow thứ hai
  chết ở early dedup hoặc P2002-claim ⇒ đúng một Telegram send. (TASK-068A backstop cho race
  check-then-insert.)
* **Recovery phát lại graphMessageId cũ:** giống hệt trường hợp trên — early dedup (row đã tồn
  tại) hoặc P2002 ⇒ không double send. **Chứng minh bằng ordering: không tồn tại code path nào gọi
  Telegram trước khi claim thành công.**
* **Failure windows quanh claim (pre-existing, ngoài scope TASK-089, chỉ ghi nhận):**
  (i) claim OK → Telegram fail → BullMQ retry → early dedup thấy row (status DETECTED, chưa SENT)
  ⇒ SKIPPED_DUPLICATE ⇒ message đó không được gửi lại — trade-off at-most-once-sau-claim có từ
  trước, TASK-089 không thay đổi và không sửa;
  (ii) enqueue fail giữa page — tick sau replay (đã phân tích §3.3).

---

## 9. TASK-080 stale-message protection (REPO EVIDENCE)

Implementation thật (`graph-message-pipeline.service.ts`):

* Freshness đo bằng **Microsoft `receivedDateTime`** (source timestamp), KHÔNG phải enqueue time.
* Threshold: `MAX_RELAY_MESSAGE_AGE_MINUTES = 30` (hằng số, cố ý không env-tunable).
* Vị trí: **SAU early dedup, TRƯỚC detector/extractor/claim/Telegram** (comment TASK-080 ghi rõ).
* Stale ⇒ `SKIPPED_STALE` — **terminal skip** (return ok:false, không throw ⇒ worker không retry);
  ghi CodeEvent `CODE_SKIPPED_STALE`.
* Stale skip **KHÔNG tạo ProcessedMessage row** (return trước Step 8).
* `receivedDateTime` thiếu/hỏng ⇒ fail-safe: xử lý tiếp bình thường + warn (không chặn nhầm).
* Webhook và delta **cùng đi qua guard** — guard nằm trong pipeline chung của worker-email, mọi
  nguồn job đều qua.

**Bốn câu trả lời bắt buộc của mục H:**

1. **Recovery/full enumeration trả email rất cũ → có chặn Telegram không?** **CÓ.** Mọi message
   >30 phút tuổi bị SKIPPED_STALE trước cả detector, chắc chắn không tới Telegram.
2. **Graph replay một message fresh ĐÃ xử lý → dedup có chặn không?** **CÓ.** Row ProcessedMessage
   đã tồn tại ⇒ early dedup (trước cả stale guard) hoặc P2002 tại claim.
3. **Stale không tạo row ⇒ recovery lặp có thể tạo repeated stale CodeEvent noise không?** **CÓ —
   nguy cơ thật** cho bất kỳ thiết kế recovery nào CÓ enqueue mail cũ: mỗi lần message cũ được
   enqueue lại, pipeline chạy lại tới stale guard và ghi thêm một `CODE_SKIPPED_STALE` CodeEvent
   (không có row để early-dedup chặn). Với bootstrap hiện tại (không enqueue) nguy cơ này = 0; với
   biến thể A+ phải bound lookback để giữ noise nhỏ (§14).
4. **Stale guard có bảo vệ khỏi MISS do bootstrap reset không?** **KHÔNG.** Stale guard chỉ chặn
   chiều "gửi thừa đồ cũ"; nó không tạo ra message bị baseline nuốt. Phải tách bạch:
   **duplicate-relay protection** (stale + dedup — mạnh, có chứng minh) ≠ **no-message-loss
   guarantee** (không tồn tại trên delta path khi reset).

---

## 10. Token / mailbox-status interaction (REPO EVIDENCE)

* Poll list chỉ lấy `status = ACTIVE` ⇒ mailbox `RECONNECT_REQUIRED` / `DISABLED` không được poll;
  `SUBSCRIPTION_EXPIRED` (nếu status đó đang dùng cho candidate khác) cũng không nằm trong delta
  list — delta chỉ quan tâm ACTIVE.
* `markReconnectRequired` chỉ được gọi từ: (i) token port lỗi với
  `shouldMarkReconnectRequired(error)` = true (invalid_grant / interaction_required / missing /
  undecryptable — TASK-069C), (ii) HTTP 401 kind `auth` trên data request.
* Token path: `createPrismaAccessTokenPort` — decrypt → `refreshMicrosoftAccessToken` (timeout 20s
  TASK-080) → `persistRotatedRefreshToken` dưới **credential-generation CAS** (TASK-085): rotation
  đua với writer khác thì không commit, access token của cycle vẫn dùng được.
* **410 độc lập hoàn toàn với credential:** access token dùng cho request 410 vừa được mint từ một
  refresh grant khỏe (nếu grant chết thì đã fail ở token port trước đó). 410 = synchronization-state
  failure. **Không được để nhánh 410 mới đụng vào status hoặc credential path** — repo evidence và
  provider evidence (§13) đều không có căn cứ nào biến 410 thành OAuth failure.
* Mailbox đổi status giữa recovery (ví dụ admin disable): tick sau list không còn mailbox đó ⇒
  recovery tự dừng — hành vi đúng, không cần code thêm.

---

## 11. Webhook / Graph subscription interaction (ANALYZE-ONLY)

* Delta cursor nằm trên `Mailbox`; subscription nằm ở model `GraphSubscription`. Grep xác nhận:
  webhook route / webhook-notification.service / graph-subscription.service **không đọc/ghi**
  `microsoftDeltaCursor`; delta service/runner không import bất kỳ subscription module nào.
* Webhook validate bằng clientState hash trên GraphSubscription — hoạt động bình thường khi delta
  cursor invalid. Thực tế TASK-088 §24.5: 410 hiển thị trong khi Email worker pipeline + Delta
  polling health vẫn PASS.
* Provider: delta query (pull) và change notifications (push) là hai feature độc lập, được thiết kế
  để **kết hợp** ("Combine delta query and change notifications" — OFFICIAL MICROSOFT EVIDENCE,
  §13). Không tài liệu nào yêu cầu recreate subscription khi delta state chết.
* Recovery delta không đụng provisioning/renewal path.

```text
KẾT LUẬN: GRAPH SUBSCRIPTION / WEBHOOK — NO CHANGE REQUIRED.
```

---

## 12. Observability

### 12.1. Hiện có (REPO EVIDENCE)

* Per mailbox: `deltaLastPolledAt`, `deltaLastErrorAt`, `deltaLastErrorMessage` (sanitized, max
  256 ký tự: `GRAPH_REQUEST_FAILED (http=410) code=... reqId=...`), forbidden count/cooldown.
* Log events: cycle started/finished (counts), per-mailbox completed (bootstrap/enqueued/
  cursorAdvanced), failed (errorName), skip cooldown, reset-cursor warn, save-cursor warn.
* Health: `classifyDeltaPolling` (PASS nếu ≥1 mailbox poll gần 15 phút), mailbox-level reason
  "Recent delta polling error".
* Alert: chỉ persistent-403 (TASK-075).

### 12.2. Đề xuất TỐI THIỂU cho Phase 2 (không field mới, không migration)

Dùng chính `deltaLastErrorMessage` + log với marker phân biệt được trạng thái:

| Trạng thái operator cần phân biệt | Tín hiệu đề xuất |
|---|---|
| Normal polling | không error metadata; `deltaLastPolledAt` tươi |
| 410 detected | `deltaLastErrorMessage` chứa marker sync-state riêng (ví dụ tiền tố `GRAPH_SYNC_STATE_LOST (http=410) code=...`) thay cho `GRAPH_REQUEST_FAILED` chung |
| Cursor recovery started | log info "delta sync state lost — cursor reset" + cursor đã null (marker còn trong metadata) |
| Bootstrap/re-enumeration completed | log per-mailbox hiện có (`bootstrap: true, cursorAdvanced: true`) + `saveDeltaCursor` tự **clear** error metadata (hành vi sẵn có — recovery xong là dashboard sạch) |
| Recovery failed / repeated 410 | error metadata tiếp tục được ghi với timestamp mới sau khi đã reset (cursor null mà vẫn 410) — bất thường, xem §14 guard |
| Auth/reconnect failure | như hiện tại: `TOKEN_REFRESH_FAILED:*` + status RECONNECT_REQUIRED — nhánh 410 không đụng vào |

Cấm log (giữ nguyên chuẩn hiện tại + bổ sung cho 410):

```text
- KHÔNG log giá trị cursor/deltaLink/nextLink URL (chứa opaque sync state).
- KHÔNG log nội dung Location header của response 410 (nó là một sync URL) —
  chỉ được log boolean "có/không có Location".
- KHÔNG log access/refresh token, client secret, bot token, verification code, email body.
```

(Đã rà: code hiện tại không log URL cursor ở bất kỳ log statement nào — chỉ mailboxId/counts.)

---

## 13. Provider semantics / external evidence boundary

**Nguồn:** Microsoft Learn — "Use delta query to track changes in Microsoft Graph data"
(`learn.microsoft.com/en-us/graph/delta-query-overview`, bản cập nhật 2025-01-15, đã fetch trực
tiếp trong Phase 1). Trích yếu (OFFICIAL MICROSOFT EVIDENCE):

1. **Synchronization reset:** "Delta query can return a response code of `410 Gone` and a
   **Location** header containing a request URL with an empty `$deltatoken` (same as the initial
   query)... an indication that the application must restart with a full synchronization."
2. **Token duration (Outlook):** với Outlook entities (message, mailFolder, ...) — "the upper limit
   isn't fixed; it's dependent on the size of the internal delta token cache... after the cache
   capacity is exceeded, the older delta tokens are deleted. In case the token expires, the service
   should respond with a 40X-series error with error codes such as `syncStateNotFound`."
   ⇒ **Outlook delta token KHÔNG có TTL cố định**; invalidation có thể xảy ra bất kỳ lúc nào
   (cache eviction, maintenance) — đây là lý do 410 xuất hiện "tự nhiên" trên staging.
3. **Replays:** "Your application must be prepared for replays... While delta query makes a best
   effort to reduce replays, they're still possible." ⇒ dedup pipeline là bắt buộc (repo đã có).
4. **State tokens opaque:** dùng nguyên URL `@odata.deltaLink`/`@odata.nextLink` — repo đã tuân thủ.

**INFERENCE (ghi rõ là suy luận, cần lưu ý khi review):**

* Doc viết error code dạng camelCase `syncStateNotFound`; quan sát staging (TASK-088) hiển thị
  `SyncStateNotFound`. ⇒ Phase 2 nếu match theo error code thì **phải case-insensitive**, và tốt
  hơn là **quyết định theo HTTP 410 trước, error code chỉ để chẩn đoán/log** — vì doc nói "40X-series
  error with error codes **such as**" (không cam kết đúng một code, thậm chí không cam kết đúng 410).
* Location header: doc chỉ mô tả trong ngữ cảnh "Synchronization reset" tổng quát; **không cam kết
  Outlook 410 luôn kèm Location**. ⇒ recovery không được phụ thuộc Location (§14 Option C).
* 410 trên **initial** request (không có delta token) không phải mode được mô tả — sync-state lỗi
  gắn với token. ⇒ 410-khi-cursor-đã-null là bất thường, xử lý như lỗi ghi nhận thường, không loop
  reset được (không còn gì để reset).

**Cần Human/ChatGPT external verification (nếu muốn chắc thêm, không blocking):** trang
`delta-query-messages` (message-specific) có ghi chú gì thêm về 410/Location cho Outlook không.
Phase 1 đã đủ căn cứ để thiết kế mà không phụ thuộc câu trả lời này (thiết kế không dựa Location).

---

## 14. Architecture options (bản phân tích BAN ĐẦU — trước HD-1)

> **Ghi chú sau HD-1:** mục này giữ nguyên làm phân tích gốc. Option "A+" dưới đây đã được HD-1
> yêu cầu điều tra sâu dưới dạng **Option B+ (same-cycle recovery enumeration)** — khác A+ ở chỗ
> recovery chạy TRONG CÙNG cycle nên **không cần trạng thái persist giữa hai tick** (đây chính là
> điểm đã khiến A+ bị đánh giá "có thể cần migration"). Phân tích đầy đủ và bản so sánh CẬP NHẬT:
> **§22**. Recommendation hiện hành: **Option B+** (§15).

### Option A — 410 → reset cursor → kết thúc mailbox này trong cycle → tick sau bootstrap (path sẵn có)

Nhánh mới trong catch: kind sync-state (HTTP 410) ⇒ `resetDeltaCursor` (một lần — sau đó cursor
null, không còn gì reset) + record error metadata với marker riêng. Tick sau: cursor null ⇒
bootstrap TASK-036 nguyên trạng (lookback 24h, **không enqueue**) ⇒ deltaLink mới ⇒
`saveDeltaCursor` clear error metadata. Tự phục hồi trong ~2 tick (~60s) khi Graph bình thường.

### Option A+ (biến thể của A, tùy chọn) — recovery-bootstrap CÓ enqueue với lookback ngắn

Như A, nhưng lần bootstrap NGAY SAU một 410-reset chạy ở "recovery mode": lookback thu ngắn
(≤ `MAX_RELAY_MESSAGE_AGE_MINUTES` = 30 phút) và **enqueue** item thay vì nuốt. Dedup chặn message
đã xử lý; stale guard chặn message >30m; ⇒ thu hẹp gần hết miss window cho message còn giá trị
relay. Chi phí: cần phân biệt trạng thái "recovery pending" giữa hai tick — **không có field sẵn**
⇒ hoặc thêm cột (migration — theo luật phải STOP và hỏi Human) hoặc encode vào
`deltaLastErrorMessage` (mong manh) hoặc chấp nhận làm trong cùng cycle (thành Option B).

### Option B — 410 → reset + bootstrap/re-enumerate NGAY trong cùng cycle

Ưu: đóng recovery trong một tick, không cần trạng thái giữa tick. Nhược: phá shape "một
pass/mailbox/cycle" hiện tại; nhân đôi budget Graph call + page cap trong một tick; kéo dài cycle
(đội thời gian settle mà TASK-080 muốn giữ ngắn); thêm đường code mới trong `pollMailboxDelta` vốn
đang tuyến tính dễ test. Lợi ích thật so với A: tiết kiệm ~30s. Không tương xứng.

### Option C — dùng Location header của response 410

Bị loại cho minimal, ba lý do: (1) OFFICIAL: Location = URL initial query **không có** filter
lookback của TASK-036 ⇒ trên mailbox lớn full enumeration có thể không hội tụ trong 10 page ⇒
cursor không bao giờ được lưu — chính là bug TASK-036 đã diệt; (2) nếu lưu Location làm cursor,
tick sau thấy cursor non-null ⇒ **không phải bootstrap** ⇒ enqueue toàn bộ enumeration ⇒ dội hàng
loạt mail lịch sử vào pipeline (stale guard chặn Telegram nhưng noise CodeEvent + tải Graph/queue
lớn); (3) INFERENCE: Location không được cam kết luôn có ⇒ vẫn phải có đường A làm fallback ⇒ C chỉ
thêm nhánh. Minimal: **chỉ log boolean có/không Location** để làm evidence vận hành.

### So sánh

| Tiêu chí | A | A+ | B | C |
|---|---|---|---|---|
| Correctness | Đúng semantics provider (restart full sync) | Đúng | Đúng | Đúng nửa vời (mất filter) |
| Risk message loss | Bounded, documented (như 403 TASK-071) | Thấp nhất | Như A | Như A |
| Risk replay | 0 (bootstrap câm) | Bounded ≤30m, dedup/stale chặn send | 0 | CAO (enqueue full enum) |
| Risk infinite retry | Hết (reset một lần) | Hết | Hết | Hết |
| Complexity | **Thấp nhất** (một nhánh classify + reuse reset/bootstrap) | Trung bình (cần trạng thái recovery hoặc migration) | Trung bình-cao | Trung bình + rủi ro |
| Tương thích 071/075/080 | Trọn vẹn — copy đúng pattern 403 self-heal, không đụng backoff/timeout | Tốt | Tốt | Xung đột TASK-036 |
| Exactly-once | Không đổi | Dựa dedup (đã chứng minh §8) | Không đổi | Dựa dedup, tải lớn |
| Stale guard | Không tương tác | Chặn send; noise CodeEvent bounded | Không tương tác | Noise lớn (§9.3) |
| Scheduler | Không đổi | Không đổi | Kéo dài cycle | Không đổi |
| Observability | Marker + log sẵn có | Cần thêm trạng thái | Như A | Phải giấu Location URL |
| Testability | Cao (unit như 403 tests hiện có) | Trung bình | Trung bình | Thấp hơn |
| Blast radius | 1 file service (+ tests) | +runner/schema? | 1 file nhưng sâu | 1 file + hành vi enqueue |

---

## 15. RECOMMENDED ARCHITECTURE (đề xuất sau HD-1 + HD-2/HD-3 — chưa code)

**OPTION B++ — SAME-CYCLE RECOVERY ENUMERATION, REPLACE-ON-SUCCESS** (điều tra đầy đủ: §23; nền
tảng B+ ở §22 vẫn đúng trừ điểm sequencing reset mà §23 ghi đè).

```text
1. classifyHttpStatus: thêm nhánh HTTP 410 → kind sync-state riêng (quyết theo HTTP STATUS;
   graphErrorCode như SyncStateNotFound chỉ dùng cho log/metadata, case-insensitive — §13).
2. Khi 410 xảy ra trên request DÙNG CURSOR (persisted cursor = C-invalid):
   a. KHÔNG reset persisted cursor về null. C-invalid GIỮ NGUYÊN trong DB làm
      DURABLE RECOVERY TRIGGER;
   b. record sanitized sync-state-lost/recovery marker (recordDeltaError, marker riêng);
   c. TRONG CÙNG CYCLE, cho CHÍNH mailbox đó, chạy đúng MỘT bounded recovery enumeration:
      - URL khởi tạo: buildInitialDeltaUrl(now − RECOVERY_LOOKBACK) — reuse builder TASK-036;
      - RECOVERY_LOOKBACK dẫn xuất từ relay-freshness policy 30 phút của TASK-080, đặt trong
        một LEAF POLICY MODULE dùng chung (HD-3 — §23.7): một nguồn sự thật, không hằng số
        trùng lặp, không dependency direction xấu;
      - mode recovery: enumerate VÀ ENQUEUE candidate qua flow enqueue hiện tại
        (khác initial-onboarding bootstrap: enumerate nhưng KHÔNG enqueue);
      - page cap dùng chính maxPagesPerMailbox hiện tại.
   d. RECOVERY THÀNH CÔNG (đạt @odata.deltaLink C-new):
      → saveDeltaCursor(C-new) — writer hiện có là UNCONDITIONAL UPDATE (§23 Q1) nên C-new
        THAY TRỰC TIẾP C-invalid, đồng thời tự clear delta error metadata (semantics sẵn có).
   e. RECOVERY THẤT BẠI (timeout / 429 / 5xx / repeated 410 / không hội tụ page cap):
      → KHÔNG persist null; KHÔNG persist intermediate URL; C-invalid VẪN NẰM trong DB;
      → record sanitized recovery-failure marker; cycle settle;
      → tick sau: request C-invalid → 410 → đúng MỘT recovery attempt mới (bounded, paced
        theo tick interval). Không recursive retry, không second recovery trong cùng cycle.
3. 410 khi cursor đã null từ đầu cycle (initial bootstrap bị 410 — bất thường theo §13):
   chỉ record error marker; không recovery enumeration (không có baseline cũ nào bị mất).
4. Pipeline hiện tại chịu trách nhiệm an toàn phía sau, KHÔNG sửa hành vi:
   early dedup → stale guard TASK-080 → ProcessedMessage claim → Telegram
   (delivery semantics: claim-before-send prevents duplicate replay for the same claimed
    message identity, with pre-existing at-most-once-after-claim — §8, DF-1).
5. Không schema/migration, không persistent recovery flag — durable trigger CHÍNH LÀ C-invalid
   (§23 Q2/Q4). Không đổi env/queue contract. Không đụng 401/403/TASK-071/075/080 semantics
   (resetDeltaCursor vẫn tồn tại nguyên trạng CHO đường 403 TASK-071 — đường 410 không dùng nó).
   Webhook/GraphSubscription: NO CHANGE (§11, §22 Q12).
```

Vì sao B++ thay B+: B+ khi recovery fail sẽ để lại cursor null ⇒ tick sau **mất recovery
semantics** (bootstrap câm — residual loss OD-6). B++ giữ C-invalid ⇒ recovery được **thử lại mỗi
tick cho tới khi thành công** ⇒ **OD-6 được loại bỏ mà không cần persistent flag/migration**:
fresh message trong khoảng hở vẫn được recover chừng nào nó còn trong cửa sổ freshness 30 phút.
Residual duy nhất còn lại là **freshness-policy cutoff** (recovery fail liên tục lâu hơn 30 phút ⇒
message trong khoảng hở già quá threshold và bị stale-skip đúng chính sách) — đây là hệ quả của
policy TASK-080, không phải lỗ hổng kiến trúc, và được document ở §23.8.

---

## 16. Invariants Phase 2 phải bảo vệ

```text
I1.  (Viết lại theo HD-2 — wording cũ "invalid cursor must never be sent again" KHÔNG còn đúng
     vì B++ cố ý giữ C-invalid làm durable recovery trigger.)
     **410 must never result in an unbounded cross-tick retry of the invalid cursor WITHOUT a
     recovery attempt.** Cụ thể: C-invalid không bao giờ được xử lý như NORMAL processing sau khi
     410 đã được nhận diện; mỗi tick tối đa MỘT probe C-invalid + MỘT bounded recovery attempt,
     paced theo tick interval; C-invalid biến mất khỏi DB đúng một cách duy nhất — bị C-new
     ghi đè khi recovery thành công.
I2.  410 không đổi mailbox status; RECONNECT_REQUIRED chỉ từ 401/token-classification như hiện tại.
I3.  Semantics 401/auth giữ nguyên từng dòng.
I4.  Semantics 403 (TASK-071 self-heal + TASK-075 backoff/alert) giữ nguyên; 410 không tăng
     deltaForbiddenCount, không set cooldown, không raise persistent-403 alert.
I5.  Timeout TASK-080 (20s, transient) giữ nguyên; 410 và timeout không lẫn nhau.
I6.  Scheduler non-overlap giữ nguyên; recovery không thêm vòng lặp trong cycle.
I7.  Không tight-loop: nhịp retry duy nhất là tick interval; sau reset không còn gì để reset lại.
I8.  Không double relay Telegram: claim-trước-send + unique [mailboxId, graphMessageId] giữ nguyên.
I9.  Không relay stale: guard 30 phút giữ nguyên vị trí (sau early dedup, trước detector).
I10. (Cập nhật theo HD-2/B++.) Đường recovery KHÔNG được nuốt fresh message trong
     RECOVERY_LOOKBACK. Residual duy nhất được phép là FRESHNESS-POLICY CUTOFF: khi recovery
     fail liên tục lâu hơn cửa sổ freshness, message trong khoảng hở già quá threshold và bị
     stale-skip đúng chính sách TASK-080 (§23.8) — phải được document trong code comment + task
     doc; không silent.
I11. Webhook path không đổi một dòng nào.
I12. GraphSubscription lifecycle: NO CHANGE (§11).
I13. Không log cursor/deltaLink/nextLink/Location URL value, token, secret, code, email body.
I14. Không schema/migration. Nếu Phase 2 phát hiện bắt buộc migration ⇒ STOP, báo Human/ChatGPT,
     không tự mở rộng. (B+ đã được chứng minh KHÔNG cần migration — §22 Q1/Q2.)
I15. Recovery enumeration là ONE-SHOT per mailbox per cycle: không recursive retry, không second
     immediate recovery trong cùng cycle; thất bại ⇒ record failure, cycle settle, tick sau
     scheduler tự thử lại (một probe + một recovery attempt mới).
I16. (Cập nhật theo B++.) Đường 410 KHÔNG phát bất kỳ lệnh reset/null-write nào và KHÔNG persist
     intermediate URL; cursor chỉ được ghi qua saveDeltaCursor khi recovery thành công
     (replace-on-success). `resetDeltaCursor` giữ nguyên vẹn và CHỈ thuộc đường 403 TASK-071.
I17. RECOVERY_LOOKBACK dẫn xuất từ relay-freshness policy 30 phút của TASK-080, đặt tại một
     LEAF POLICY MODULE dùng chung (HD-3, §23.7) — một nguồn sự thật; không hằng số thời gian
     trùng lặp; không import pipeline module chỉ để lấy hằng số.
```

---

## 17. Proposed test matrix (Phase 2)

Nền: mở rộng `tests/unit/microsoft/delta-polling.service.test.ts` (+ timeout test file) và
`tests/unit/queue/delta-polling-runner.test.ts`, `delta-polling-scheduler.test.ts` theo pattern
mock fetch hiện có.

### 17.1. HTTP / error classification

| Case | Kỳ vọng |
|---|---|
| 200 bình thường | enqueue + saveDeltaCursor như hiện tại (regression) |
| 401 | kind auth → RECONNECT_REQUIRED (giữ nguyên) |
| 403 | kind forbidden → TASK-071 reset + TASK-075 counter (giữ nguyên) |
| 410 + body code SyncStateNotFound | kind sync-state mới → reset cursor, marker mới, KHÔNG status change, KHÔNG forbidden counter |
| 410 + body code khác / không parse được body | vẫn kind sync-state (quyết theo HTTP status) |
| 410 có Location header | hành vi như trên + log boolean; KHÔNG dùng/lưu/log giá trị Location |
| 410 không có Location | như trên |
| 429 / 5xx | transient — cursor GIỮ NGUYÊN (không reset) |
| Timeout (TASK-080) | transient, không reset, không forbidden |

### 17.2. Cursor recovery

| Case | Kỳ vọng |
|---|---|
| Cursor hợp lệ C0 → 200 | không reset, advance bình thường |
| C-invalid → 410 lần đầu | đúng MỘT lệnh reset được gọi; error metadata ghi marker |
| resetDeltaCursor throw | safely-wrapper nuốt + warn; cycle không vỡ; tick sau vẫn thấy C-invalid → 410 → thử reset lại (bounded bởi tick) |
| Tick sau reset | mailbox đọc cursor null → bootstrap path, KHÔNG enqueue |
| Recovery bootstrap thành công | deltaLink mới lưu; error metadata cleared (qua saveDeltaCursor) |
| Recovery bootstrap fail (transient) | cursor vẫn null; tick sau bootstrap lại; không reset-loop |
| Repeated 410 (410 cả sau khi đã reset, cursor null) | chỉ recordDeltaError mỗi tick; không gọi reset; không tăng forbidden |
| 410 khi cursor đã null ngay từ đầu | như trên |
| 410 ở page đầu của traversal có cursor | reset (case chuẩn) |
| 410 ở page giữa (sau nextLink) | reset; các message đã enqueue trong các page trước vẫn hợp lệ (dedup lo phần lặp) |
| Không persist cursor trung gian | nextLink không bao giờ được saveDeltaCursor (regression TASK-036) |

### 17.3. Scheduler

| Case | Kỳ vọng |
|---|---|
| Tick chồng | vẫn skip (inflight guard, regression) |
| Cycle có 410 settle | runDeltaPollingOnce resolve, failedMailboxCount đúng |
| Tick sau cycle 410 vẫn chạy | có |
| Không retry tức thời trong cùng cycle | mailbox 410 chỉ 1 Graph call/cycle |

### 17.4. Replay / loss

| Case | Kỳ vọng |
|---|---|
| Historical messages (giả lập nếu recovery enqueue — chỉ áp dụng nếu chọn A+) | SKIPPED_STALE, không Telegram |
| Fresh chưa xử lý qua delta sau recovery | relay đúng một lần |
| Fresh ĐÃ xử lý bị thấy lại | SKIPPED_DUPLICATE (early hoặc P2002), không Telegram |
| Cùng graphMessageId qua webhook + delta | một send duy nhất (TASK-068A regression) |
| Cùng graphMessageId xuất hiện lại sau recovery | như trên |
| Multi-page replay sau mid-fail | dedup queue-level jobId + pipeline |
| Message đúng boundary 30 phút | ≤30m relay; >30m stale (test cả hai phía biên) |
| Stale > threshold | không Telegram call nào được thực hiện (assert mock) |

### 17.5. Auth / status

| Case | Kỳ vọng |
|---|---|
| Token refresh transient fail | mailbox ACTIVE, retry tick sau (069C regression) |
| invalid_grant / interaction_required | RECONNECT_REQUIRED (regression) |
| Mailbox DISABLED giữa chừng | tick sau không poll nữa (list ACTIVE-only) |
| Mailbox → RECONNECT_REQUIRED giữa recovery | như trên |
| 410 không làm tăng persistent-403 state | assert deltaForbiddenCount không đổi, không cooldown, không alert |

### 17.6. Observability / security

| Case | Kỳ vọng |
|---|---|
| Log recovery event | có marker, sanitized |
| Không log raw cursor/delta URL/Location value | assert log payload không chứa chuỗi URL/token giả lập |
| Không log secret/full code/email body | regression các assert sẵn có |
| Operator phân biệt recovered vs still-failing | recovered: error metadata cleared + cursorAdvanced log; failing: metadata timestamp tiếp tục tăng |

### 17.7. Same-cycle recovery enumeration (Option B+ — bổ sung sau HD-1)

> **Ghi chú sau HD-2:** các dòng trong bảng này nói "reset" hoặc "tick sau bootstrap câm" đã bị
> **§17.8 ghi đè** theo B++ (không reset; C-invalid giữ nguyên; tick sau retry recovery). Các
> dòng còn lại (dedup/stale/401/403/non-overlap) giữ nguyên giá trị.

| Case | Kỳ vọng |
|---|---|
| 410 trên cursor request → recovery cùng cycle thành công | đúng 1 reset; recovery enumerate từ now−RECOVERY_LOOKBACK; candidate được enqueue; deltaLink mới saveDeltaCursor; error metadata cleared |
| Fresh message M trong lookback, webhook đã miss (HD-1 scenario) | M được enqueue trong recovery ⇒ relay đúng một lần — test chống chỉ định quan trọng nhất |
| Message đã xử lý nằm trong lookback | enqueue lại nhưng SKIPPED_DUPLICATE ở pipeline (hoặc no-op ở queue jobId) — không double Telegram |
| Message >30m trong lookback boundary | không xuất hiện trong enumeration (Graph-side filter) hoặc nếu lọt (biên thời gian) ⇒ SKIPPED_STALE |
| Recovery enumeration lại trả 410 | record error; KHÔNG reset lần hai; KHÔNG recovery lần hai; cycle settle; tick sau bootstrap câm |
| Recovery enumeration timeout / 429 / 5xx | transient: record error, cycle settle, không RECONNECT_REQUIRED, không forbidden counter; tick sau bootstrap câm |
| Recovery enumeration 401 | semantics auth giữ nguyên (RECONNECT_REQUIRED) |
| Recovery enumeration 403 | semantics TASK-071/075 giữ nguyên; cursor đã null ⇒ nhánh reset của handlePersistentForbidden tự skip; forbidden counter tăng đúng |
| Recovery không hội tụ trong page cap | không saveDeltaCursor; không loop thêm trong cycle; tick sau bootstrap câm (degrade về A) |
| 410 giữa multi-page traversal (đã enqueue vài page) | messages đã enqueue giữ nguyên; recovery replay chúng ⇒ queue jobId no-op / pipeline dedup; chỉ deltaLink mới (nếu đạt) được persist |
| 410 khi cursor null từ đầu cycle | không reset, không recovery enumeration, chỉ record marker |
| Non-overlap scheduler với cycle chứa recovery | cycle dài hơn nhưng hữu hạn (≤ 2× page cap Graph call cho mailbox đó); tick chồng vẫn bị skip |
| Mailbox khác trong cùng cycle | không bị ảnh hưởng bởi recovery của mailbox hỏng |

### 17.8. Replace-on-success deltas (Option B++ — bổ sung sau HD-2, ghi đè các dòng reset/null của §17.7)

| Case | Kỳ vọng (B++) |
|---|---|
| 410 trên cursor request | **KHÔNG** có lệnh reset/null-write nào được phát; C-invalid vẫn trong DB; marker sync-state-lost được record |
| Recovery thành công (đạt C-new) | saveDeltaCursor(C-new) ghi đè **trực tiếp** C-invalid (một write); error metadata cleared cùng write đó |
| Recovery fail — timeout/429/5xx | C-invalid **VẪN persisted**; không null; không intermediate URL; recovery-failure marker; cycle settle |
| Recovery fail — repeated 410 trong recovery | như trên; không recursive retry; không second recovery trong cycle |
| Recovery fail — không hội tụ page cap | như trên; không persist gì |
| Tick sau một recovery fail | probe C-invalid → 410 → đúng MỘT recovery attempt MỚI (không phải bootstrap câm) — test chống chỉ định quan trọng nhất của B++ |
| Chuỗi N tick recovery fail liên tiếp | mỗi tick: 1 probe + 1 bounded attempt; không leo thang; cursor không đổi; marker cập nhật timestamp |
| Recovery fail rồi tick sau recovery success | C-new ghi đè C-invalid; metadata sạch; chu trình đóng |
| Replay page đã enqueue ở attempt trước | queue jobId no-op / pipeline dedup — wording: claim-before-send + pre-existing at-most-once-after-claim |
| saveDeltaCursor(C-new) throw | warn như hiện tại; C-invalid còn nguyên ⇒ tick sau lại 410 → recovery attempt mới — tự lành, không mất semantics |
| Mailbox DISABLED/RECONNECT_REQUIRED giữa recovery | tick sau không poll (list ACTIVE-only); job đã enqueue bị pipeline chặn `SKIPPED_MAILBOX_NOT_ACTIVE` (re-check status tại job time — pre-existing seam, §23 Q6) |
| Đường 403 không đổi | `resetDeltaCursor` vẫn được 403 path gọi đúng như TASK-071 (regression) |

---

## 18. Phase-2 deployment impact

Phân biệt **code-path impact** với **Railway redeploy reality**:

> Phân biệt tường minh (yêu cầu HD-3): **behavioral impact** (hành vi runtime đổi) ≠
> **source/build impact** (file có diff nhưng hành vi không đổi).

| Service | Behavioral impact | Source/build impact | Lý do |
|---|---|---|---|
| worker-delta | **YES** | YES | Toàn bộ thay đổi hành vi nằm trong `services/microsoft/delta-polling.service.ts` (classify + nhánh 410 replace-on-success + recovery mode trong `pollMailboxDelta`) + import policy module mới. Tests đi kèm |
| worker-email | **NO** | **YES — phải khai báo trung thực** | HD-3 chọn extract leaf policy module (§23.7): `graph-message-pipeline.service.ts` đổi nguồn hằng số 30 phút từ const nội bộ sang import policy module ⇒ file pipeline **có diff** (đổi import + xóa const local), nhưng **zero behavioral change** (cùng giá trị, cùng chỗ dùng). KHÔNG được nói worker-email "không có file change" |
| web | **NO** | NO | Không đổi health/API/UI; marker mới chỉ là *giá trị chuỗi* trong field sẵn có |
| worker-renewal | **NO** | NO | Không liên quan |
| (file mới) | — | leaf policy module mới (ví dụ `services/email/relay-freshness-policy.ts` — tên minh họa) chứa hằng 30 phút; module thuần hằng số, không I/O, không import gì |
| Prisma migration | **NO** | NO | B++ không cần persistent state — durable trigger là chính C-invalid (§23 Q2/Q4) |

**Railway reality (TASK-088):** cả 4 service cùng theo branch `staging`, không Watch Paths ⇒ một
promotion của TASK-089 **có thể trigger redeploy cả 4** dù chỉ worker-delta có code-path impact —
chấp nhận được (cùng commit, backward-compatible). Promotion theo runbook TASK-088 §23 2E:
CASE 1 — **không migration** ⇒ không preflight; Human ff-only promotion sau verify + Antigravity +
CI. Phase 1 không thao tác Railway.

---

## 19. Scope exclusions

KHÔNG mở rộng sang: orphan Graph subscription cleanup; production rollout; Railway
redesign/source change; subscription provisioning (+concurrency); credential rotation redesign;
mailbox reconnect hàng loạt; detector/extractor; Telegram routing; RBAC; health dashboard
redesign; worker timeout khác; migration chưa được duyệt; mọi feature ngoài delta 410/cursor
resilience.

**Deferred / Separate Findings (ghi nhận, KHÔNG sửa trong TASK-089):**

```text
DF-1. At-most-once-sau-claim: claim OK → Telegram fail → retry bị early-dedup chặn ⇒ message đó
      không bao giờ gửi (pre-existing từ trước TASK-089; xem §8). Nếu muốn xử lý cần task riêng.
DF-2. Health tổng của delta là "ít nhất một mailbox tươi" ⇒ một mailbox kẹt lỗi kéo dài không hạ
      health tổng. Có thể cân nhắc per-mailbox surfacing ở task observability riêng.
DF-3. Một số mailbox RECONNECT_REQUIRED / 1 disabled trên staging (TASK-088 §24.6) — vận hành
      độc lập, ngoài scope.
```

---

## 20. Remaining / open decisions

| # | Câu hỏi | Ai quyết | Ghi chú |
|---|---|---|---|
| OD-1 | ~~Duyệt Option A~~ — **SUPERSEDED bởi HD-1**: quyết định hiện hành là duyệt **Option B+** (§15, §22) | Human/ChatGPT + Antigravity re-review | HD-1: không chấp nhận fresh-message-loss window của A khi chưa chứng minh không có phương án hẹp hơn — B+ chính là phương án đó |
| OD-2 | ~~Nâng cấp A+?~~ — **RESOLVED bởi HD-1/B+**: recovery có enqueue chạy same-cycle (không cần trạng thái giữa tick, không migration) | — | Đóng |
| OD-3 | Có cần backoff riêng cho "repeated 410 sau reset" (cursor null vẫn 410 nhiều tick) không? | Human/ChatGPT | Đánh giá giữ nguyên: KHÔNG cần — pacing 30s + bất thường theo provider semantics; thêm backoff = thêm state |
| OD-4 | Có cần admin alert khi 410 xảy ra (như persistent-403 alert) không? | Human/ChatGPT | Minimal: không — B+ tự phục hồi trong cùng cycle; alert chỉ đáng nếu repeated 410 |
| OD-5 | Human/ChatGPT có muốn xác minh thêm trang delta-query-messages (message-specific) về 410/Location không? | Human/ChatGPT | Không blocking — thiết kế không phụ thuộc Location (§13) |
| OD-6 | ~~Residual loss trên failure path của B+~~ — **RESOLVED bởi HD-2/B++** (§23): giữ C-invalid làm durable recovery trigger ⇒ recovery retry mỗi tick tới khi thành công, KHÔNG cần persistent flag/migration. Kết luận trước đó của Phase 1 ("loại bỏ hoàn toàn cần migration") là SAI và được rút lại — replace-on-success đạt được điều đó bằng chính cursor hiện có | — | Residual còn lại duy nhất: freshness-policy cutoff (recovery fail liên tục >30 phút ⇒ message già quá threshold bị stale-skip đúng chính sách TASK-080) — không phải lỗ hổng kiến trúc, đã document §23.8 |
| OD-7 | Chốt tên/vị trí leaf policy module cho hằng freshness 30 phút (HD-3 — §23.7 đề xuất `services/email/relay-freshness-policy.ts`, tên minh họa)? | Human/ChatGPT (có thể ủy quyền cho Phase 2 review) | Quyết định đặt tên/đường dẫn, không phải quyết định kiến trúc — kiến trúc (leaf module, một nguồn sự thật) đã chốt |

---

## 21. Acceptance criteria for Phase 1

```text
[x] Trace đầy đủ current 410 path với evidence file/dòng (§2, §4).
[x] Chứng minh có/không invalid-cursor retry loop (CÓ — unbounded cross-tick, §5).
[x] Cursor lifecycle: model, mọi reader/writer, ordering enqueue-vs-persist, guard (§3).
[x] Bootstrap semantics + 4 câu trả lời replay/miss/khác-initial/recovery-mode (§6).
[x] Replay vs message-loss phân tích tách bạch (§7).
[x] Exactly-once chứng minh bằng ordering, không khẳng định suông (§8).
[x] TASK-080 stale guard: vị trí, threshold, 4 câu trả lời bắt buộc (§9).
[x] Token/status interaction — 410 không phải OAuth failure (§10).
[x] Webhook/subscription: NO CHANGE REQUIRED có căn cứ (§11).
[x] Observability hiện có + đề xuất tối thiểu không migration (§12).
[x] Provider semantics với nguồn chính thức + ranh giới INFERENCE (§13).
[x] ≥3 options so sánh đủ 12 tiêu chí + recommended minimal (§14, §15).
[x] 14 invariants (§16). Test matrix đủ 6 nhóm (§17). Service impact + Railway reality (§18).
[x] Scope exclusions + deferred findings (§19). Open decisions (§20).
[x] Chỉ 2 docs được tạo; không runtime/schema/test/CI/env change; npm run verify PASS.
[x] Antigravity CLI Architecture Review lần đầu: PASS.
[x] HD-1 correction: điều tra Option B+ với 12 câu hỏi bắt buộc + so sánh cập nhật + đổi
    recommendation (§22); wording delivery-semantics chỉnh chính xác (§8).
[x] HD-2 correction: điều tra Option B++ replace-on-success (8 câu hỏi, §23.1–§23.6, §23.8);
    OD-6 RESOLVED; invariants I1/I10/I16/I17 viết lại chính xác.
[x] HD-3 correction: review dependency direction của freshness constant; chốt leaf policy
    module thay vì export từ pipeline (§23.7); service impact khai báo trung thực
    behavioral-vs-source (§18).
[ ] Antigravity CLI Architecture RE-REVIEW PASS  ← điều kiện rời Phase 1, chưa đạt.
```

---

## 22. ARCHITECTURE CORRECTION (HD-1) — OPTION B+ SAME-CYCLE RECOVERY ENUMERATION

> **Bối cảnh:** Antigravity Architecture Review lần đầu PASS, nhưng Human/ChatGPT Technical
> Review ra **HD-1**: không khóa Option A. Scenario được Antigravity xác nhận độc lập:
>
> ```text
> C0 invalid → fresh verification email M đến → webhook miss M → delta nhận 410
> → (Option A) reset cursor → tick sau initial bootstrap → bootstrap NHÌN THẤY M nhưng
>   KHÔNG enqueue (baseline câm) → deltaLink mới lưu → M MẤT VĨNH VIỄN khỏi delta backup path.
> ```
>
> Delta polling tồn tại chính để đỡ webhook miss ⇒ trade-off này không được chấp nhận khi chưa
> chứng minh không có phương án hẹp hơn. Mục này là investigation đó — **chỉ phân tích, không
> code**.

### 22.1. Mô hình khái niệm Option B+

```text
cursor request → 410 → classify sync-state-lost riêng → reset persisted invalid cursor
→ KHÔNG kết thúc — trong CHÍNH cycle đó: một bounded recovery enumeration từ
  initial/lookback query → candidate được enqueue qua flow hiện tại
→ pipeline hiện tại chịu trách nhiệm: early dedup → stale guard TASK-080 →
  ProcessedMessage claim → Telegram safety
→ enumeration hoàn thành → persist deltaLink mới → cycle settle bình thường.
```

### 22.2. Mười hai câu hỏi bắt buộc — trả lời bằng code evidence

**Q1 — Phân biệt recovery enumeration với initial onboarding bootstrap bằng state local/in-memory
trong cùng `runDeltaPollingOnce` cycle được không?**

**CÓ — và không cần bất kỳ persistence nào.** REPO EVIDENCE: sự phân biệt "bootstrap hay không"
hiện đã là **biến local** — `const isBootstrap = mailbox.microsoftDeltaCursor === null`
(`pollMailboxDelta`, dòng ~437), derive từ snapshot mailbox mà cycle load lúc đầu. Trong cùng
cycle, code **biết chắc vì sao cursor null**: (i) null từ lúc load ⇒ initial onboarding bootstrap;
(ii) non-null lúc load nhưng vừa bị chính cycle này reset sau 410 ⇒ recovery. Tri thức đó nằm
trọn trong luồng gọi (nhánh catch 410 là nơi duy nhất biết điều (ii)) ⇒ một tham số mode truyền
xuống enumeration là đủ. Không cần đọc lại DB, không cần flag.

**Q2 — Nếu CÓ:**

```text
- Cần schema migration?                KHÔNG. Trạng thái sống và chết trong một cycle.
- Cần persistent recovery flag?        KHÔNG. Nếu recovery fail, tick sau CHỦ ĐÍCH degrade về
                                       bootstrap câm (Option A semantics) — không cần nhớ gì.
                                       (Muốn nhớ để retry recovery ở tick sau ⇒ cần flag persist
                                       ⇒ migration ⇒ I14 STOP — chính là lý do A+ bị loại và B+
                                       được chọn.)
- Cần encode state vào                 KHÔNG — và KHÔNG ĐƯỢC làm: field đó là chuỗi chẩn đoán
  deltaLastErrorMessage?               sanitized cho operator/dashboard, không phải cột trạng
                                       thái máy; encode state vào đó là mong manh và sai vai trò.
```

**Q3 — Bootstrap function hiện tại có nhận được mode không?**

**CÓ, ở mức thay đổi cục bộ.** REPO EVIDENCE: hành vi bootstrap-conditional DUY NHẤT trong vòng
lặp page của `pollMailboxDelta` là khối `if (!isBootstrap) { ...enqueue... }` (dòng ~451). Nghĩa
là "enumerate nhưng không enqueue" và "enumerate và enqueue" đã là CÙNG một code path chỉ khác
một điều kiện boolean. Kiến trúc: thay boolean derive-từ-cursor bằng một mode tường minh
(`initial-bootstrap` = enumerate, không enqueue / `recovery` = enumerate, enqueue / `cursor` =
trang thái thường), do caller quyết. Phần còn lại của hàm (pagination, page cap, deltaLink,
timeout) dùng chung nguyên trạng. Chỉ phân tích — không code ở Phase 1.

**Q4 — Reuse query/lookback logic TASK-036 được không?**

**CÓ nguyên vẹn.** `buildInitialDeltaUrl(bootstrapFromDate)` (dòng ~265) nhận một `Date` tùy ý và
build `$filter=receivedDateTime ge {ts}` + `$select=id` + `$top`. Recovery chỉ cần gọi đúng hàm đó
với from-date khác (now − RECOVERY_LOOKBACK). Không cần query builder mới.

**Q5 — Nếu recovery dùng lookback hiện tại (24h):**

* **Page cap risk:** `maxPagesPerMailbox` mặc định 10 × `$top` 50 ⇒ trần ~500 item/lần. Mailbox
  nhận nhiều mail trong 24h có thể **không hội tụ tới deltaLink** ⇒ `newCursor = null` ⇒ cursor
  không lưu ⇒ tick sau lại bootstrap từ đầu — đúng loại rủi ro TASK-036 sinh ra để chặn.
* **Mailbox lớn:** không bảo đảm hội tụ với 24h lookback.
* **⇒ CÓ, cần recovery-specific bounded lookback** — và Q6 chỉ ra window đúng.

**Q6 — Dùng stale threshold TASK-080 làm cửa sổ recovery:**

REPO EVIDENCE: pipeline terminal-skip mọi message có `receivedDateTime` cũ hơn
`MAX_RELAY_MESSAGE_AGE_MINUTES = 30` (module-private const, `graph-message-pipeline.service.ts`
dòng 66; đã grep — không tồn tại nơi thứ hai). Suy ra:

```text
Enumerate xa hơn 30 phút KHÔNG có giá trị relay nào: mọi message cũ hơn threshold chắc chắn bị
SKIPPED_STALE trước Telegram. Nó chỉ tạo chi phí Graph + noise CodeEvent (§9.3).
⇒ RECOVERY_LOOKBACK = dẫn xuất từ MAX_RELAY_MESSAGE_AGE_MINUTES — cửa sổ recovery TƯƠNG THÍCH
  freshness policy, không cần dài hơn.
⇒ KHÔNG tạo hằng số thời gian trùng lặp: Phase 2 export hằng số từ pipeline module (thay đổi
  non-behavioral — thêm `export` trước `const`) và delta import nó. Một nguồn sự thật (I17).
⇒ Với 30 phút lookback: trần thực tế của một mailbox verification-relay << 500 item ⇒ rủi ro
  page-cap không hội tụ thực tế không đáng kể; nếu vẫn xảy ra ⇒ degrade hữu hạn (Q9).
```

**Q7 — Recovery enqueue message cũ/fresh có gây double Telegram không?**

Trace chính xác từng lớp (REPO EVIDENCE, §8 giữ nguyên giá trị):

```text
(1) QUEUE: jobId = "delta-polling:{mailboxId}:{graphMessageId}" (email-job-options.ts).
    BullMQ add với jobId đã tồn tại (waiting/active/completed trong retention 24h) là no-op
    theo contract jobId-dedupe của thư viện — lớp chặn ĐẦU, không phải lớp bảo đảm.
(2) EARLY DEDUP (pipeline Step 4): findByGraphMessageId / findByInternetMessageId — message đã
    có ProcessedMessage row ⇒ SKIPPED_DUPLICATE, không đi tiếp.
(3) STALE GUARD (TASK-080): >30m ⇒ SKIPPED_STALE, không bao giờ tới claim/Telegram.
(4) CLAIM (Step 8): store.create dưới @@unique([mailboxId, graphMessageId]); P2002 ⇒ clean
    duplicate skip (TASK-068A). Claim đứng TRƯỚC Telegram send (Step 10).
⇒ KHÔNG double Telegram cho cùng message identity.
```

**Wording chính xác (bắt buộc):** đây KHÔNG phải "perfect exactly-once Telegram delivery". Bảo đảm
là **claim-before-send prevents duplicate replay for the same claimed message identity, with
pre-existing at-most-once-after-claim failure semantics** (claim OK → send fail → retry bị early
dedup chặn ⇒ message không được gửi lại — DF-1, pre-existing, TASK-089 không sửa).

**Q8 — 410 giữa multi-page traversal (không phải page đầu):**

REPO EVIDENCE (`pollMailboxDelta`): với cursor request (không bootstrap), enqueue chạy **theo từng
page** trước khi lấy nextLink; cursor **chỉ** được persist khi đạt deltaLink; nextLink trung gian
**không bao giờ** persist.

```text
- Messages đã enqueue ở các page trước 410: đã nằm trong queue hợp lệ — không mất, không cần đền bù.
- Reset → recovery enumeration replay chúng: lớp (1) queue-jobId (cùng prefix delta-polling +
  cùng graphMessageId, job vừa add trong chính cycle ⇒ chắc chắn còn trong retention) nuốt phần
  lớn; lọt qua thì lớp (2)/(4) pipeline dedup chặn — không double send.
- Cursor persist: KHÔNG persist gì từ traversal đứt gãy; thứ duy nhất được persist là deltaLink
  MỚI do recovery enumeration đạt được (nếu đạt). Không có corrupt/intermediate cursor.
```

**Q9 — Recovery enumeration lại trả 410:**

```text
Quy tắc kiến trúc (I15/I16): recovery là ONE-SHOT per mailbox per cycle.
410 trong recovery ⇒ DeltaPollingHttpError kind sync-state ⇒ nhánh xử lý thấy cursor ĐÃ null
(in-memory) ⇒ KHÔNG reset lần hai (không write-spam), KHÔNG recovery lần hai, KHÔNG đệ quy —
record error marker, mailbox này kết thúc trong cycle, cycle settle hữu hạn.
Tick sau: cursor null ⇒ initial-bootstrap path (câm) tự thử lại theo pacing scheduler.
```

**Q10 — Recovery enumeration timeout/429/5xx:**

```text
fetchDeltaPage đã map timeout → transient (TASK-080) và 429/5xx → transient (classifyHttpStatus).
Trong recovery, transient ⇒ record error, cycle settle, tick sau thử lại (bootstrap câm);
KHÔNG RECONNECT_REQUIRED (transient không bao giờ đụng status), KHÔNG forbidden counter.
Giữ nguyên semantics hiện có — recovery không thêm phân loại mới cho các lỗi này.
```

**Q11 — 401/403/TASK-071/TASK-075/TASK-080 giữ nguyên hoàn toàn:**

```text
- 401 trong recovery: kind 'auth' ⇒ markReconnectRequired — đúng semantics token-bị-từ-chối
  hiện tại, không đổi.
- 403 trong recovery: kind 'forbidden' ⇒ handlePersistentForbidden; guard sẵn có
  `if (mailbox.microsoftDeltaCursor !== null)` tự skip reset (cursor đã null) — TASK-071
  self-heal + TASK-075 counter/cooldown/alert hoạt động nguyên trạng, không double-reset.
- TASK-080: timeout 20s áp per-request qua fetchDeltaPage — recovery dùng chung, không đổi.
- Nhánh 410 mới đứng TÁCH BIỆT: không đụng deltaForbiddenCount/cooldown/alert/status.
```

**Q12 — Webhook/GraphSubscription:**

**NO CHANGE.** Code evidence không đổi so với §11: recovery chỉ dùng `buildInitialDeltaUrl` +
`fetchDeltaPage` + enqueue port + `saveDeltaCursor`/`resetDeltaCursor` — không import, không đọc,
không ghi bất kỳ subscription module/row nào; webhook route không đọc cursor. B+ không thêm
coupling mới.

### 22.3. So sánh cập nhật (sau HD-1)

| Tiêu chí | **A** (reset → tick sau bootstrap câm) | **B+** (reset → same-cycle recovery có enqueue) | **C** (Location header) |
|---|---|---|---|
| Fresh-message-loss risk | **CÓ — chắc chắn nuốt M trong window (HD-1 scenario)** | Loại bỏ trên đường chính; residual chỉ trên failure path (recovery fail ⇒ degrade về A một tick) | Như A về loss, cộng thêm rủi ro riêng |
| Replay risk | 0 (bootstrap câm) | Bounded ≤ RECOVERY_LOOKBACK (30m); 4 lớp chặn send (Q7) | CAO — full enumeration không filter |
| Stale protection | Không tương tác | Chặn mọi thứ >30m; lookback = threshold ⇒ noise stale ≈ 0 | Noise lớn |
| Dedup | Không dùng tới | Reuse nguyên trạng, đã chứng minh ordering | Chịu tải lớn |
| Page cap | Bootstrap 24h — như hiện tại | Lookback 30m ⇒ hội tụ thực tế; không hội tụ ⇒ degrade hữu hạn | Không filter ⇒ rủi ro TASK-036 quay lại |
| Scheduler | Không đổi | Không đổi shape; cycle dài hơn hữu hạn (≤2× page cap cho đúng mailbox hỏng); non-overlap giữ | Không đổi |
| Timeout/backoff | Giữ nguyên | Giữ nguyên (Q10, Q11) | Giữ nguyên |
| Complexity | Thấp nhất | Trung bình: một mode tường minh trên code path sẵn có + nhánh catch | Trung bình + rủi ro |
| Migration/schema | Không | **Không** (Q1/Q2 — in-memory trong cycle) | Không |
| Observability | Marker + log sẵn có | Như A + log recovery outcome (enqueued/converged) | Phải giấu Location URL |
| Service impact | worker-delta | worker-delta (+ export non-behavioral một hằng từ pipeline — §18) | worker-delta |
| Testability | Cao | Cao — unit theo pattern mock fetch hiện có; ma trận §17.7 | Thấp hơn |

### 22.4. Quyết định kiến trúc sau correction

Code trace chứng minh Option B+ đạt **đủ cả năm** tiêu chí HD-1 đặt ra:

```text
[x] Loại bỏ fresh-message-loss window trên đường recovery chính (M ≤30m được enqueue + relay);
    residual CHỈ còn trên failure path của chính recovery enumeration — nhỏ hơn hẳn, được
    document, và Human quyết ở OD-6.
[x] KHÔNG cần schema/migration (Q1/Q2).
[x] KHÔNG phá scheduler/non-overlap (Q9/Q10; cycle vẫn settle hữu hạn).
[x] Reuse nguyên trạng dedup + stale guard (Q7 — bốn lớp, có ordering proof).
[x] Blast radius vẫn chủ yếu worker-delta (+một export non-behavioral, khai báo ở §18).
```

```text
RECOMMENDED: OPTION B+ — thay thế recommendation Option A trước đó.

Residual trade-off Human cần biết (OD-6): nếu chính recovery enumeration fail
(410 lặp/timeout/429/5xx/page-cap), tick sau rơi về bootstrap câm ⇒ message trong khoảng hở đó
vẫn có thể mất khỏi delta path — loại bỏ nốt residual này đòi persistent recovery flag ⇒
migration ⇒ ngoài giới hạn I14. Đề xuất: chấp nhận residual (xác suất = xác suất recovery fail
ngay sau một 410, nhỏ hơn nhiều so với window chắc chắn của Option A).
```

> **GHI ĐÈ bởi HD-2 (§23):** đoạn residual/OD-6 ngay trên là kết luận của B+ và **không còn là
> recommendation hiện hành**. Khẳng định "loại bỏ nốt residual đòi persistent flag ⇒ migration"
> đã bị chứng minh là SAI: B++ (replace-on-success) loại bỏ residual đó bằng chính C-invalid
> làm durable trigger — không flag, không migration. Xem §23.

---

## 23. ARCHITECTURE CORRECTION 2 (HD-2 + HD-3) — OPTION B++ REPLACE-ON-SUCCESS & FRESHNESS POLICY DEPENDENCY

> **HD-2:** Human/ChatGPT chưa chấp nhận kết luận OD-6 của B+ ("loại bỏ residual cần persistent
> flag/migration") và yêu cầu đánh giá **B++: KHÔNG reset cursor khi 410 — chỉ thay C-invalid
> bằng C-new SAU KHI recovery thành công**. **HD-3:** review dependency direction của việc export
> hằng freshness từ pipeline. Mục này chỉ phân tích — **không code**.

### 23.1. Q1 — Khả thi với cursor writer hiện tại? **CÓ — không cần bất kỳ thay đổi repo-interface nào**

REPO EVIDENCE — bốn method của `createPrismaDeltaPollingRepo` (`delta-polling-runner.ts`):

```text
- read : listActiveMicrosoftMailboxes — findMany ACTIVE, select microsoftDeltaCursor (dòng ~64).
- save : saveDeltaCursor(mailboxId, cursorUrl, polledAt) — mailbox.update UNCONDITIONAL:
         { microsoftDeltaCursor: cursorUrl, deltaLastPolledAt, deltaLastErrorAt: null,
           deltaLastErrorMessage: null }                                       (dòng ~85–93).
         KHÔNG có precondition "cursor phải null trước", KHÔNG so sánh giá trị cũ.
- reset: resetDeltaCursor — set null (dòng ~109). Caller DUY NHẤT: nhánh 403 TASK-071.
- error: recordDeltaError — metadata only.
```

⇒ `saveDeltaCursor(C-new)` **ghi đè trực tiếp C-invalid** — đây chính là cách mọi cursor advance
bình thường vẫn hoạt động (C0 → C1 mỗi lần đạt deltaLink, chưa bao giờ đi qua null). B++ chỉ là
dùng đúng semantics sẵn có của writer cho đường recovery. Reset-to-null là **thao tác thừa** đối
với 410, không phải điều kiện kỹ thuật.

### 23.2. Q2 — Reset-to-null có phải correctness requirement không? **KHÔNG**

* **Provider (OFFICIAL, §13):** Microsoft yêu cầu "restart with a full synchronization" — tức là
  yêu cầu MỘT LẦN ENUMERATION MỚI, không nói gì về giá trị cột trong DB của client. "Null trong
  DB" là tín hiệu nội bộ của repo này (để route tick sau vào bootstrap path), không phải semantics
  provider.
* **TASK-071 (REPO EVIDENCE):** reset-to-null là **lựa chọn implementation** cho 403 tại thời
  điểm đó — vì bootstrap-khi-null là đường recovery duy nhất tồn tại, reset là cơ chế rẻ nhất để
  kích hoạt nó ở tick sau. Comment TASK-071 nói "a fresh bootstrap is strictly better than a
  cursor that can no longer mint pages" — đúng trong bối cảnh 403 không có recovery enumeration.
  Không có chỗ nào biến nó thành nghĩa vụ cho 410. **410 không phải reuse sequencing của 403.**

### 23.3. Q3 — So sánh recovery-failure behavior

| Tiêu chí | B+ (410 → null → fail → tick sau bootstrap câm) | B++ (410 → giữ C-invalid → fail → tick sau 410 → recovery attempt mới) |
|---|---|---|
| Message-loss risk | Recovery fail MỘT lần ⇒ mất recovery semantics vĩnh viễn cho khoảng hở (bootstrap câm nuốt) | Recovery được thử lại mỗi tick tới khi thành công ⇒ chỉ mất message già quá 30 phút trong lúc fail kéo dài (freshness cutoff — đúng chính sách) |
| Graph request overhead / tick khi đang hỏng | Tick sau: bootstrap 24h lookback (tới page-cap request, câm) | Tick sau: 1 probe C-invalid (410) + recovery ≤ page-cap trên lookback 30 phút — thêm đúng MỘT request probe, đổi lại giữ được semantics |
| Scheduler pacing | Không đổi | Không đổi — mỗi tick vẫn một pass hữu hạn/mailbox |
| Observability | Sau fail, trạng thái "đang recovery" biến mất (cursor null không phân biệt được với mailbox mới) | C-invalid + marker còn nguyên ⇒ operator thấy rõ "mailbox này đang trong chu trình 410-recovery" cho tới khi metadata được clear bởi save thành công — TỐT HƠN |
| Repeated-410 behavior | Degrade thành bootstrap câm (mất dấu) | Mỗi tick một chu trình probe+attempt có dấu vết; hữu hạn, paced |
| Write amplification | Mỗi 410: 1 reset-write + 1 recordDeltaError; fail thêm nữa | **ÍT write hơn**: không reset-write nào; chỉ recordDeltaError (fail) hoặc saveDeltaCursor (success) |

### 23.4. Q4 — Invariant "invalid cursor không reuse vô hạn"

Phân biệt bắt buộc:

```text
(A) Reuse C-invalid như NORMAL PROCESSING không nhận thức recovery
    = behavior lỗi HIỆN TẠI (§4–§5) — thứ invariant phải cấm.
(B) Giữ C-invalid như DURABLE RECOVERY TRIGGER: mỗi tick = một probe có chủ đích + một bounded
    recovery attempt = thiết kế CÓ Ý THỨC của B++ — không phải lỗi.
```

⇒ Wording cũ của I1 ("invalid cursor không bao giờ được reuse quá cycle phát hiện") **đã được
viết lại** (§16 I1) thành:

```text
410 must never result in an unbounded cross-tick retry of the invalid cursor
WITHOUT a recovery attempt.
```

kèm ràng buộc: mỗi tick tối đa một probe + một attempt; C-invalid chỉ rời DB bằng cách bị C-new
ghi đè khi recovery thành công.

### 23.5. Q5 — Repeated 410 + scheduler non-overlap

```text
C-invalid → 410 → recovery enumeration → lại 410:
  - KHÔNG recursive retry (recovery là one-shot/cycle — I15);
  - KHÔNG reset/null write (I16);
  - KHÔNG second recovery trong cycle;
  - record sanitized failure marker; mailbox này kết thúc trong cycle; cycle settle;
  - tick sau scheduler mới thử lại (probe + một attempt mới).
```

Scheduler non-overlap (REPO EVIDENCE): `tick()` guard bằng `inflight` — mọi việc B++ làm vẫn nằm
TRONG `runDeltaPollingOnce` được await bởi một tick duy nhất; recovery chỉ kéo dài pass của một
mailbox một lượng hữu hạn (≤ 2× page cap request) ⇒ tick chồng vẫn bị skip đúng như cũ. Non-overlap
**không đổi**.

### 23.6. Q6 — Mailbox state race (ANALYZE-ONLY; phân loại pre-existing)

Trace các seam (REPO EVIDENCE):

```text
- List đầu cycle: chỉ mailbox ACTIVE (findMany where status ACTIVE).
- saveDeltaCursor / recordDeltaError: update where {id} — KHÔNG re-check status. Nếu mailbox bị
  DISABLED/RECONNECT_REQUIRED giữa cycle, write vẫn commit — NHƯNG không đụng cột status, và
  tick sau mailbox không còn được list ⇒ write trở thành inert. ĐÂY LÀ PRE-EXISTING BEHAVIOR
  (đúng hệt cho một cursor advance thành công bình thường hôm nay) — NGOÀI scope TASK-089.
- Enqueue seam: pipeline RE-CHECK status tại job time — `if (mailbox.status !== 'ACTIVE')` ⇒
  SKIPPED_MAILBOX_NOT_ACTIVE (graph-message-pipeline.service.ts dòng ~562–569, REPO EVIDENCE)
  ⇒ candidate enqueue từ mailbox vừa bị disable KHÔNG được relay.
```

⇒ B++ **không resurrect** gì: nó không bao giờ ghi status, không ghi cursor cho mailbox ngoài
danh sách ACTIVE của cycle, và mọi write muộn đều inert theo đúng cơ chế pre-existing. Không có
semantics mailbox-state nào bị phá.

### 23.7. HD-3 — Freshness policy dependency direction

**Q1 — import pipeline chỉ để lấy hằng có tạo coupling xấu/circular risk không?**

REPO EVIDENCE: `graph-message-pipeline.service.ts` (1216 dòng) KHÔNG import delta-polling ⇒
**không có circular dependency trực tiếp hôm nay**. Nhưng coupling là thật và không cần thiết:
pipeline là module tầng cao (import telegram/detector/dedup/observability/lock/throttle...);
`delta-polling.service.ts` là module cố ý lean ("This service NEVER fetches message bodies / runs
the detector..." — header comment). Import pipeline chỉ để lấy một hằng số kéo cả import graph
tầng cao vào worker-delta module: sai hướng tầng (low-level phụ thuộc high-level), tăng blast
radius refactor tương lai và chi phí module-load trong test. ⇒ **Không nên export trực tiếp từ
pipeline.**

**Q2 — có leaf/shared module sẵn phù hợp không?** Đã rà các ứng viên: `lib/env*` (threshold cố ý
KHÔNG env-tunable — sai chỗ), `services/queue/email-job.types.ts` (contract queue — sai domain),
`services/email/deduplication.service.ts` (domain dedup, có `DEFAULT_BUCKET_MINUTES` riêng — nhét
freshness vào là mượn chỗ), `verification-keywords.ts` (lexicon). **Không có module sẵn nào là
nhà tự nhiên cho relay-freshness policy.**

**Q3 — quyết định:** **extract một leaf policy module mới** (ví dụ
`services/email/relay-freshness-policy.ts` — tên minh họa, chốt ở OD-7): chứa
`MAX_RELAY_MESSAGE_AGE_MINUTES` (+ hằng ms dẫn xuất), thuần hằng số, không I/O, không import gì.
Pipeline đổi sang import từ đó (**source diff, zero behavioral change** — cùng giá trị, cùng chỗ
dùng); delta import từ đó cho RECOVERY_LOOKBACK. Một nguồn sự thật, dependency direction sạch
(hai module tầng cao cùng phụ thuộc một leaf). Service impact khai báo trung thực ở §18:
worker-email có **source/build diff** (không được nói "không có file change") nhưng **không có
behavioral change**.

### 23.8. So sánh cuối B+ vs B++ và quyết định

| Tiêu chí | B+ (reset-first) | **B++ (replace-on-success)** |
|---|---|---|
| Fresh-message-loss khi recovery SUCCESS | Không | Không |
| Fresh-message-loss khi recovery FAIL | **Có** — tick sau bootstrap câm nuốt khoảng hở (OD-6) | **Không** — tick sau retry recovery; chỉ còn freshness cutoff (message già >30m trong lúc fail kéo dài bị stale-skip đúng chính sách) |
| Persistent state requirement | Không (nhưng vì thế mất recovery semantics khi fail) | **Không — và vẫn giữ recovery semantics**: durable trigger là chính C-invalid |
| Schema/migration | Không | Không |
| Graph request overhead khi hỏng kéo dài | Bootstrap 24h câm mỗi tick | 1 probe + recovery 30m mỗi tick — tương đương, thêm 1 request probe |
| DB write behavior | reset-write mỗi lần 410 | **Ít hơn**: không reset-write; chỉ save-on-success / record-error |
| Replay | Dedup 4 lớp (như nhau) | Như nhau; wording: claim-before-send + pre-existing at-most-once-after-claim |
| Scheduler | Không đổi | Không đổi (non-overlap giữ — §23.5) |
| Observability | Mất dấu recovery sau fail (cursor null) | **Tốt hơn**: C-invalid + marker tồn tại tới khi thành công |
| Complexity | 1 reset call + recovery mode | **Đơn giản hơn một bước**: bỏ hẳn reset khỏi đường 410 |
| Testability | Cao | Cao (ma trận §17.8) |

```text
QUYẾT ĐỊNH: RECOMMEND OPTION B++ thay B+.

B++ loại bỏ OD-6 mà: không migration, không persistent flag, không correctness regression mới
(401/403/071/075/080 nguyên trạng — resetDeltaCursor vẫn thuộc riêng đường 403; mailbox-state
seams pre-existing không đổi — §23.6), ít DB write hơn, observability tốt hơn.

Kết luận trước đó "loại bỏ residual cần persistent recovery flag ⇒ migration" là SAI và được
rút lại chính thức (§22.4 đã gắn ghi chú ghi đè).

Residual DUY NHẤT còn lại (phải nói thẳng): FRESHNESS-POLICY CUTOFF — nếu recovery fail liên tục
lâu hơn 30 phút, message trong khoảng hở già quá threshold và bị stale-skip đúng chính sách
TASK-080. Đây là hệ quả của policy "không relay code cũ hơn 30 phút" (một tính chất an toàn có
chủ đích), không phải lỗ hổng của kiến trúc recovery. Không có OD mới nào cần mở cho nó.
```

---

## 24. PHASE 2 — IMPLEMENTATION RECORD (Option B++ — đã code, chờ Antigravity Implementation Review)

> Architecture approved: **OPTION B++ — REPLACE-ON-SUCCESS WITH SHARED LEAF FRESHNESS POLICY**
> (Antigravity Final Architecture Re-review PASS). Mục này ghi implementation THỰC TẾ, đối chiếu
> từng điểm với §15/§23. Không commit/push; ROADMAP chưa cập nhật; không thao tác Railway.

### 24.1. Files changed (runtime + tests)

| File | Loại | Nội dung |
|---|---|---|
| `services/email/relay-freshness-policy.ts` | **MỚI** | Leaf policy module (HD-3): `MAX_RELAY_MESSAGE_AGE_MINUTES = 30` + `MAX_RELAY_MESSAGE_AGE_MS`. Thuần hằng số — không I/O, không side effect, không env, không import module tầng cao |
| `services/email/graph-message-pipeline.service.ts` | SỬA (source-only) | Xóa 2 const local, import từ leaf module. **Zero behavioral change** — cùng giá trị, cùng chỗ dùng (stale guard TASK-080 nguyên trạng) |
| `services/microsoft/delta-polling.service.ts` | SỬA (behavioral) | Toàn bộ behavior B++ — chi tiết §24.2 |
| `tests/unit/microsoft/delta-polling.sync-state-recovery.test.ts` | **MỚI** | **23** test case mới (2 policy + 21 recovery — đếm chính thức bằng vitest, khớp 1281 → 1304; số "21" trong bản draft trước là lỗi đếm tài liệu, được Antigravity Final Implementation Review phát hiện) — §24.4 |
| `docs/tasks+reports/TASK-089-*` | SỬA | Mục Phase 2 này |

`delta-polling-runner.ts` **không** cần sửa (repo/ports/alert giữ nguyên interface — đúng dự đoán
§23 Q1). Không sửa Prisma schema/migration/`.env*`/CI/package scripts/subscription/credential code.

### 24.2. Exact 410 code path sau implementation (`delta-polling.service.ts`)

```text
1. classifyHttpStatus: thêm `if (status === 410) return 'syncStateLost'` — HTTP status là
   trigger duy nhất; AuthKind mở rộng thành 'auth'|'forbidden'|'syncStateLost'|'transient'|'unknown'.
2. fetchDeltaPage: kind syncStateLost ⇒ message marker 'GRAPH_SYNC_STATE_LOST' (thay
   'GRAPH_REQUEST_FAILED'); graphErrorCode (vd SyncStateNotFound) chỉ là diagnostics đi kèm qua
   readGraphErrorDiagnostics sẵn có — không require string code nào, không đọc/log body thô,
   không đọc/không log Location header (minimal theo spec §6).
3. Vòng lặp page được extract thành `traverseDeltaPages(startUrl, shouldEnqueue, ...)` — dùng
   chung cho 3 mode: cursor polling (enqueue), initial bootstrap (KHÔNG enqueue — giữ nguyên
   TASK-031/036), recovery (enqueue). `pollMailboxDelta` thành wrapper mỏng, hành vi cũ giữ
   nguyên từng log statement.
4. `runDeltaPollingOnce`: hoisted `tokenForRecovery` (token vừa mint cho mailbox — 410 đến SAU
   một token exchange khỏe nên reuse là đúng); catch có nhánh MỚI đứng TRƯỚC nhánh cũ:
     kind === 'syncStateLost' && tokenForRecovery !== null && cursor-lúc-load !== null
       → handleSyncStateLost(...)  [never throws]
   410 khi cursor null (initial bootstrap) CỐ Ý rơi xuống nhánh generic recordDeltaError —
   không recovery, không reset (không có baseline nào bị mất).
5. handleSyncStateLost:
   a. safelyRecordError(marker 'GRAPH_SYNC_STATE_LOST (http=410) code=... reqId=...') TRƯỚC —
      operator + crash-restart thấy regime 410; KHÔNG reset cursor, KHÔNG persist null.
   b. ĐÚNG MỘT traverseDeltaPages từ buildInitialDeltaUrl(now − SYNC_STATE_RECOVERY_LOOKBACK_MS)
      với enqueue = true. SYNC_STATE_RECOVERY_LOOKBACK_MS = MAX_RELAY_MESSAGE_AGE_MS (import từ
      leaf module — không hằng số 30' thứ hai, không dùng bootstrap 24h).
   c. THÀNH CÔNG (deltaLink C-new): repo.saveDeltaCursor(C-new) — writer unconditional sẵn có
      ⇒ C-new đè trực tiếp C-invalid + clear error metadata (semantics sẵn có). Save throw ⇒
      warn, C-invalid còn nguyên ⇒ tick sau tự lành.
   d. PAGE-CAP GUARD (bắt buộc §9 đề bài): deltaLink null sau traversal (kể cả defensive stop)
      ⇒ KHÔNG save intermediate nextLink, KHÔNG fabricate cursor; record
      'SYNC_STATE_RECOVERY_INCOMPLETE:page_cap_before_deltaLink'; recovered = false.
   e. FAIL trong traversal: ONE-SHOT — không recursion, không second recovery:
      - kind 'auth' (401): safelyMarkReconnectRequired + record — semantics 401 nguyên trạng;
      - kind 'forbidden' (403): delegate NGUYÊN VĂN handlePersistentForbidden (TASK-071 reset
        cho stored cursor + TASK-075 counter/cooldown/alert);
      - second 410 / timeout / 429 / 5xx / unknown: record
        'SYNC_STATE_RECOVERY_FAILED:<safeErrorMessage>' — C-invalid giữ nguyên.
6. Nhánh 410 KHÔNG BAO GIỜ: gọi resetDeltaCursor, persist null, đổi Mailbox.status, tăng
   deltaForbiddenCount, set cooldown, raise persistent-403 alert.
7. Recovery success được đối xử như successful poll: clearForbiddenBackoff nếu có streak cũ
   (nhất quán TASK-075), log 'recovered lost sync state', KHÔNG tính failedMailboxCount.
8. Mọi Graph request của recovery đi qua CHÍNH fetchDeltaPage → fetchWithTimeout 20s
   (TASK-080) — không fetch path mới.
9. __internal export thêm SYNC_STATE_RECOVERY_LOOKBACK_MS cho tests.
```

### 24.3. Đối chiếu invariants I1–I17

```text
I1  ✅ probe C-invalid mỗi tick luôn kèm một recovery attempt; C-invalid chỉ rời DB khi bị
       C-new đè (test "next tick..." + "second 410").
I2  ✅ không đường nào của 410 đụng status (test sweep "never write mailbox status").
I3  ✅ 401 nguyên trạng, kể cả trong recovery (tests).      I4 ✅ 403 nguyên trạng (2 tests).
I5  ✅ timeout transient, không lẫn 410 (test fake-timer).  I6 ✅ scheduler test cũ PASS.
I7  ✅ one probe + one attempt/tick (assert đúng 2 fetch calls).
I8  ✅ delivery wording giữ nguyên §8 — không claim perfect exactly-once.
I9  ✅ stale guard không đổi (stale test suite PASS; boundary 30/31 phút giữ).
I10 ✅ residual freshness cutoff documented (§23.8 + comment trong handleSyncStateLost).
I11 ✅ webhook không đổi một dòng.                          I12 ✅ subscription NO CHANGE.
I13 ✅ không log cursor/Location/token/code/body (test sanitization + không đọc Location).
I14 ✅ không schema/migration.                              I15 ✅ one-shot (tests).
I16 ✅ đường 410 không phát reset/null-write nào (assert cursorResets rỗng ở mọi test 410).
I17 ✅ leaf policy module, một nguồn sự thật (test equality + import direction).
```

### 24.4. Tests (mới: 23 case trong `delta-polling.sync-state-recovery.test.ts`)

Phủ đúng ma trận bắt buộc mục 20 của Phase-2 spec:

```text
(1) normal path regression · (2) 410 → marker sync-state-lost · (3) recovery success ·
(4) C-new đè trực tiếp C-invalid · (5) không gọi resetDeltaCursor · (6) recovery timeout —
fake timers qua đúng seam TASK-080 · (7) 429 · (8) 5xx · (9) second 410 — đúng 2 fetch calls,
không recursion · (10) tick sau recovery lại (durable trigger) + thành công · (11) không
RECONNECT_REQUIRED · (12) không tăng forbidden counter · (13) 403 thường vẫn reset (regression)
+ 403-trong-recovery delegate TASK-071/075 · (14)(15) suite TASK-075/401 cũ giữ PASS (verify
toàn cục) · (16) timeout/cancellation giữ (test 6 + suite timeout cũ) · (17) initial bootstrap
không enqueue (regression riêng) + 410-khi-cursor-null chỉ record marker · (18) recovery enqueue
fresh candidate · (19)(20) stale >30' và boundary 30'/31' — suite TASK-080 hiện có giữ PASS
(hằng số move không đổi hành vi) · (21) multi-page success save final deltaLink · (22) partial
failure không save intermediate · (23) replay được các lớp dedup hạ nguồn xử lý (đã chứng minh
ordering §8; delta-layer test khẳng định at-least-once enqueue) · (24)(25) PAGE CAP: fail,
không fabricate, C-invalid giữ · (26)(27) không resurrect status (sweep 3 kịch bản; pipeline
job-time re-check giữ nguyên — không sửa) · (28) save thành công clear metadata (writer
semantics; thêm test saveDeltaCursor-throw ⇒ tự lành) · (29)(30) sanitization: markers/logs
không chứa cursor URL/token/'Location'.
+ 2 test policy module: threshold đúng 30' và recovery lookback dẫn xuất từ đúng nguồn.
```

Toàn bộ deterministic — fake fetch/DI/fake timers, không gọi Microsoft thật.

### 24.5. Service impact (chính xác theo yêu cầu)

```text
worker-delta   : behavioral impact YES  (delta-polling.service.ts).
worker-email   : behavioral impact NO; source diff YES (pipeline đổi nguồn import hằng số —
                 zero behavioral change; suite pipeline/stale/dedup giữ PASS).
web            : behavioral direct impact NO (marker mới chỉ là giá trị chuỗi trong field sẵn có).
worker-renewal : NO.
Prisma migration: NO.
Railway        : không thao tác ở Phase 2 coding. Khi promotion sau này, topology hiện tại
                 (4 service cùng branch staging, không Watch Paths) có thể redeploy nhiều
                 service — KHÔNG thay đổi direct behavior impact ở trên.
```

### 24.6. Remaining / deferred risks (không đổi so với Phase 1)

```text
- Freshness-policy cutoff (§23.8) — residual có chủ đích, không phải lỗ hổng.
- DF-1 at-most-once-after-claim — pre-existing, ngoài scope, không sửa.
- DF-2 health tổng "ít nhất một mailbox tươi" — ngoài scope.
- OD-3/OD-4 (backoff riêng cho repeated 410 / admin alert 410): giữ quyết định "không cần cho
  minimal" — mỗi tick chỉ 1 probe + 1 attempt, marker đủ cho operator.
```

### 24.7. Verification

```text
npm run verify   : PASS (exit 0) — 105 test files / 1304 tests (tăng từ 104/1281),
                   lint + typecheck + build sạch. Toàn bộ suite 401/403/timeout/scheduler/
                   stale/dedup hiện có giữ PASS.
git diff --check : sạch. Secret-scan pattern CI trên docs + diff: không match.
```

---

## 25. STAGING RUNTIME VALIDATION (Human-observed + Antigravity xác nhận) — PASS

> Verdict: **PASS — TASK-089 STAGING RUNTIME VALIDATION APPROVED** (Antigravity CLI).
> Evidence sanitized — không mailbox email thật, không cursor/URL/token/code/email body.

### 25.1. Promotion & deployment (theo đúng quy trình TASK-088)

```text
[x] Controlled fast-forward promotion vào dedicated branch staging thành công.
[x] Staging HEAD = đúng approved TASK-089 commit (reviewed == promoted == deployed).
[x] GitHub Actions trên branch staging PASS (Wait-for-CI đứng trước deploy).
[x] Railway source KHÔNG thay đổi khỏi branch staging.
[x] TASK-089 là CASE 1 — không migration ⇒ không preflight cần thiết.
```

### 25.2. Runtime validation kết quả

```text
[x] Email worker pipeline:      PASS
[x] Delta polling:              PASS
[x] Queue / Redis:              PASS
[x] Telegram reliability:       PASS
[x] Fresh verification email relay thành công sau deployment.
[x] KHÔNG historical-email replay bất thường.
[x] Queue backlog tồn đọng TỰ DRAIN: 2473 → 1157 → 766 → 366 → 0
    (cuối cùng waiting/active/delayed/oldest-waiting đều = 0);
    KHÔNG cần restart/redeploy thủ công nào để queue hồi phục.
[x] KHÔNG phát hiện TASK-089 regression.
```

### 25.3. HTTP 410 limitation (ghi trung thực)

```text
Trong staging observation window KHÔNG xuất hiện HTTP 410 / SyncStateNotFound tự nhiên từ
provider. KHÔNG chỉnh/xóa DB cursor để tạo synthetic 410 (đúng nguyên tắc không thao tác DB).

410 recovery was validated deterministically; no natural provider-side 410 occurred during
the staging observation window.

⇒ Live 410 recovery CHƯA được quan sát trên staging — bảo đảm hiện tại đến từ 23 focused
deterministic tests (§24.4) + architecture review chuỗi HD-1/HD-2. Khi một 410 tự nhiên xảy ra
trong vận hành, operator có thể xác nhận qua marker GRAPH_SYNC_STATE_LOST / recovery log (§24.2).
```

### 25.4. Independent observation — HTTP 403 ErrorQuotaExceeded

```text
Một mailbox gặp HTTP 403 code=ErrorQuotaExceeded lặp lại trong window. Investigation (read-only)
xác nhận: thuộc EXISTING TASK-071/TASK-075 forbidden path; persistent counter/cooldown/admin
alert hoạt động ĐÚNG thiết kế; KHÔNG RECONNECT_REQUIRED; KHÔNG block mailbox khác; KHÔNG gây
worker-delta stuck; KHÔNG phải TASK-089 regression (diff chứng minh đường 403 nguyên trạng).
Root cause chính xác phía provider cần Human kiểm tra mailbox/Exchange quota ngoài repo.

Phân loại: EXISTING / INDEPENDENT OPERATIONAL OBSERVATION — không mở scope TASK-089 để sửa;
không tự gán task number mới cho follow-up (Human/ChatGPT quyết định).
```
