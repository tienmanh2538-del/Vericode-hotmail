# TASK-089 — Delta 410 SyncStateNotFound Recovery & Cursor Resilience (Phase 1 Report)

> **PHASE 2 HOÀN TẤT (OPTION B++) — ANTIGRAVITY FINAL IMPLEMENTATION REVIEW: PASS.**
> **ROADMAP CLOSE-OUT ĐANG CHỜ REVIEW — NO COMMIT / NO PUSH.**
>
> Correction số liệu sau review: **23** tests mới (không phải 21 như draft — lỗi đếm tài liệu,
> vitest xác nhận 23, khớp tổng 1281 → 1304).
>
> Antigravity Final Architecture Re-review: **PASS — TASK-089 FINAL ARCHITECTURE APPROVED FOR
> PHASE 2 IMPLEMENTATION** (architecture bắt buộc: Option B++ replace-on-success + shared leaf
> freshness policy). Implementation record: task file **§24**, tóm tắt ở mục **N** dưới đây.
> `npm run verify` PASS — **105 test files / 1304 tests**. ROADMAP chưa cập nhật; không Railway.
>
> Antigravity Architecture Review lần đầu: **PASS**. HD-1: không khóa Option A ⇒ điều tra
> **Option B+** (task file §22, mục L). HD-2: kiểm tra "replace invalid cursor only after
> successful recovery" ⇒ điều tra **Option B++** — kết quả: kết luận OD-6 trước đó bị rút lại,
> **recommendation hiện hành là OPTION B++ (replace-on-success)** (task file §23, mục M).
> HD-3: dependency direction của freshness constant ⇒ chốt **leaf policy module** thay vì export
> từ pipeline (task file §23.7).
>
> Chưa có implementation nào. Không runtime code, schema, migration, test, CI, env hay Railway
> nào bị thay đổi. Báo cáo này tóm tắt findings; chi tiết đầy đủ (evidence từng mục, options,
> invariants, test matrix) nằm ở
> `docs/tasks/TASK-089-delta-410-sync-state-recovery-cursor-resilience.md` — không chép lại dài.

---

## A. Precheck

```text
git branch --show-current  → nhánh làm việc của TASK-089
git status --short         → (sạch trước khi tạo docs)
git diff --stat            → (rỗng)
git log -1 --oneline       → 1ca6592 docs: close task 088 staging deployment safety
```

Đúng branch TASK-089; HEAD là commit close-out TASK-088; không unexpected change.

## B. Root technical finding

```text
classifyHttpStatus() trong services/microsoft/delta-polling.service.ts KHÔNG có nhánh HTTP 410.
410 → kind 'unknown' → nhánh else cuối của runDeltaPollingOnce → CHỈ recordDeltaError.
Cursor KHÔNG bị reset. Không backoff. Không recovery path nào tồn tại cho sync-state loss.
```

## C. Exact current 410 behavior

Mỗi tick (~30s), mailbox có cursor bị Graph invalidate sẽ: refresh token (1 request tới token
endpoint) → gửi lại **chính** cursor invalid → 410 → ghi đè error metadata → lặp lại tick sau.

* **Có invalid-cursor retry loop không? CÓ — unbounded cross-tick**, full-speed theo polling
  interval, không tự thoát cho tới khi can thiệp thủ công (không phải tight-loop trong một cycle:
  mỗi cycle chỉ 1 Graph call cho mailbox đó).
* Ba điều 410 hiện làm ĐÚNG (phải giữ ở Phase 2): không RECONNECT_REQUIRED, không tăng
  persistent-403 counter, không bị tính nhầm là 403.
* Health tổng vẫn PASS khi ≥1 mailbox khác poll tươi — khớp quan sát TASK-088 (410 hiển thị nhưng
  Delta polling PASS).

## D. Provider semantics (OFFICIAL MICROSOFT EVIDENCE — fetched từ Microsoft Learn,
`graph/delta-query-overview`, cập nhật 2025-01-15)

* 410 Gone = synchronization reset — "the application must restart with a full synchronization";
  response *có thể* kèm Location header chứa URL initial query.
* Outlook delta token **không có TTL cố định** (phụ thuộc internal token cache; cache đầy thì token
  cũ bị xóa) — token hết hạn trả "40X-series error with error codes **such as** `syncStateNotFound`".
* "Your application must be prepared for **replays**" — dedup là bắt buộc (repo đã có, chứng minh
  ở mục F).
* INFERENCE đã đánh dấu rõ trong task doc: casing error code không ổn định
  (`syncStateNotFound` vs `SyncStateNotFound` quan sát trên staging) ⇒ quyết định recovery theo
  **HTTP 410**, error code chỉ để chẩn đoán; Location không được cam kết luôn có ⇒ không thiết kế
  phụ thuộc Location.

## E. Recommended architecture (SAU HD-2: **OPTION B++ — REPLACE-ON-SUCCESS** — chi tiết §15 + §23 task doc)

```text
410 trên cursor request (persisted cursor = C-invalid)
  → kind sync-state riêng (quyết theo HTTP status; error code chỉ chẩn đoán, case-insensitive)
  → KHÔNG reset về null — C-invalid GIỮ NGUYÊN trong DB làm DURABLE RECOVERY TRIGGER
  → record sanitized sync-state-lost marker
  → TRONG CÙNG CYCLE: đúng MỘT bounded recovery enumeration:
      buildInitialDeltaUrl(now − RECOVERY_LOOKBACK)  [reuse builder TASK-036]
      RECOVERY_LOOKBACK dẫn xuất từ relay-freshness policy 30 phút TASK-080, đặt ở LEAF POLICY
        MODULE dùng chung (HD-3) — một nguồn sự thật, dependency direction sạch
      mode recovery: enumerate VÀ ENQUEUE candidate (khác initial bootstrap: enumerate câm)
  → SUCCESS (đạt deltaLink C-new): saveDeltaCursor(C-new) — writer hiện có là UNCONDITIONAL
    update nên C-new THAY TRỰC TIẾP C-invalid + tự clear error metadata (semantics sẵn có).
  → FAIL (timeout/429/5xx/repeated 410/page-cap): KHÔNG persist null, KHÔNG intermediate URL;
    C-invalid vẫn persisted; record failure marker; cycle settle; TICK SAU: probe C-invalid →
    410 → đúng MỘT recovery attempt mới. Không recursive retry, không second recovery/cycle.
410 khi cursor null từ đầu: chỉ record marker — không recovery.
Pipeline lo an toàn phía sau (không sửa hành vi): early dedup → stale guard → claim → Telegram.
Không schema/migration, không persistent flag. Không đụng 401/403/071/075/080
(resetDeltaCursor giữ nguyên, CHỈ thuộc đường 403 TASK-071). Webhook + GraphSubscription: NO CHANGE.
```

Vì sao B++ thay B+ (HD-2): B+ khi recovery fail để lại cursor null ⇒ tick sau bootstrap câm ⇒ mất
recovery semantics (residual OD-6). B++ giữ C-invalid ⇒ recovery **retry mỗi tick tới khi thành
công** ⇒ **OD-6 RESOLVED không cần persistent flag/migration** — kết luận trước đó ("loại bỏ cần
migration") là sai và đã rút lại. Khả thi vì `saveDeltaCursor` là unconditional update (C-new đè
thẳng C-invalid — đúng cách mọi cursor advance C0→C1 vẫn chạy), và reset-to-null của TASK-071 là
lựa chọn implementation cho 403, không phải requirement của provider (Microsoft chỉ yêu cầu "một
lần full synchronization mới"). Residual duy nhất còn lại: freshness-policy cutoff (fail liên tục
>30 phút ⇒ message già quá threshold bị stale-skip đúng chính sách — không phải lỗ hổng kiến trúc).
Option A và C giữ nguyên lý do bị loại như trước.

## F. Replay vs message-loss / dedup / stale conclusions

* **Duplicate-relay protection — chứng minh bằng ordering** (wording chính xác theo HD-1, không
  phải "perfect exactly-once Telegram delivery"): **claim-before-send prevents duplicate replay
  for the same claimed message identity, with pre-existing at-most-once-after-claim failure
  semantics** (DF-1 — claim OK → send fail → retry bị early-dedup chặn; pre-existing, TASK-089
  không sửa). Cơ chế: claim (INSERT `ProcessedMessage`, unique `[mailboxId, graphMessageId]`,
  P2002 → clean skip TASK-068A) đứng TRƯỚC Telegram send; replay chết ở early dedup hoặc P2002.
  Thêm hai lớp: jobId queue-dedup (`delta-polling:{mailboxId}:{graphMessageId}`) và code/bucket
  5 phút.
* **Stale guard (TASK-080):** threshold 30 phút theo `receivedDateTime` nguồn; nằm SAU early dedup,
  TRƯỚC detector/claim/Telegram; terminal skip; webhook + delta cùng đi qua. Email cũ do recovery
  enumeration (nếu có enqueue) chắc chắn không tới Telegram. Lưu ý: stale skip KHÔNG tạo
  ProcessedMessage row ⇒ recovery kiểu có-enqueue lặp lại có thể tạo repeated stale CodeEvent noise
  — một lý do giữ bootstrap câm ở minimal.
* **Message loss:** phải tách bạch — duplicate-relay protection MẠNH ≠ no-message-loss guarantee.
  Hiện trạng: loss **vô hạn theo thời gian** trên delta path khi 410 (webhook còn sống thì che).
  Option A: **chắc chắn nuốt** fresh message trong window (HD-1) ⇒ bị từ chối. Option B+:
  residual khi recovery fail (OD-6) ⇒ bị HD-2 thách thức. **Option B++ (recommendation hiện
  hành): loại bỏ residual OD-6** — C-invalid giữ nguyên làm durable trigger, recovery retry mỗi
  tick tới khi thành công, không persistent flag, không migration. Residual duy nhất còn lại:
  **freshness-policy cutoff** — recovery fail liên tục >30 phút thì message trong khoảng hở già
  quá threshold và bị stale-skip đúng chính sách TASK-080 (tính chất an toàn có chủ đích, không
  phải lỗ hổng kiến trúc).
* **Cursor lifecycle:** chỉ 2 writer trong toàn repo (saveDeltaCursor khi có deltaLink; resetDeltaCursor
  từ nhánh 403) — grep xác nhận; enqueue-trước-persist-cursor ⇒ at-least-once có chủ đích;
  intermediate nextLink không bao giờ persist; không CAS (single-writer + non-overlap + 1 replica).

## G. Service impact dự kiến Phase 2

| Service | Code-path impact | Ghi chú |
|---|---|---|
| worker-delta | **YES (behavioral)** | Mọi thay đổi hành vi trong `delta-polling.service.ts` (classify + nhánh 410 replace-on-success + recovery mode) + import policy module + tests |
| worker-email | **NO behavioral — CÓ source/build diff** | HD-3: hằng freshness 30 phút được extract sang leaf policy module ⇒ `graph-message-pipeline.service.ts` đổi import (xóa const local) — **file có diff nhưng zero behavioral change** (cùng giá trị, cùng chỗ dùng). Khai báo trung thực theo yêu cầu HD-3 — không nói "không có file change" |
| web | NO | Chỉ giá trị chuỗi mới trong field lỗi sẵn có |
| worker-renewal | NO | Không liên quan |
| (file mới) | — | Leaf policy module (ví dụ `services/email/relay-freshness-policy.ts`, tên minh họa — OD-7): thuần hằng số, không I/O, không import gì |
| Prisma migration | **NO** | B++ không cần persistent state — durable recovery trigger là chính C-invalid (task file §23 Q2/Q4) |

Railway reality (TASK-088): cả 4 cùng branch `staging`, không Watch Paths ⇒ một promotion có thể
redeploy cả 4 dù chỉ worker-delta đổi code — chấp nhận được. Task này là CASE 1 (không migration)
theo phân loại TASK-088 ⇒ không cần preflight; promotion ff-only do Human theo runbook §23 2E.
Phase 1 không thao tác Railway.

## H. Files inspected (chính)

```text
services/microsoft/delta-polling.service.ts        (toàn bộ — 883 dòng)
services/queue/workers/delta-polling-runner.ts     (toàn bộ — repo adapters, token port, scheduler)
services/email/graph-message-pipeline.service.ts   (ordering: early dedup → stale → claim → send)
services/email/deduplication.service.ts            (claim, P2002, code/bucket)
services/email/prisma-processed-message-store.ts   (P2002 mapping)
services/queue/email-job-options.ts, email-job.types.ts, delta-polling-queue.ts (jobId dedup)
prisma/schema.prisma                               (Mailbox delta fields, ProcessedMessage unique)
lib/env.ts (loadDeltaPollingEnv), services/health/health.service.ts (delta classify)
docs/tasks+reports: TASK-071, TASK-075, TASK-080, TASK-088; docs nền (SPEC/ARCHITECTURE/SECURITY/
ROADMAP/STAGING_DEPLOYMENT/MICROSOFT_SETUP); CLAUDE.md/AGENTS.md/ANTIGRAVITY.md
External: Microsoft Learn delta-query-overview (nguồn duy nhất, official)
```

## I. Files changed

```text
A  docs/tasks/TASK-089-delta-410-sync-state-recovery-cursor-resilience.md
A  docs/reports/TASK-089-delta-410-sync-state-recovery-cursor-resilience.md
```

Không file thứ ba. Không runtime/schema/migration/test/CI/env/package change. Không ROADMAP.

## J. Verification

```text
npm run verify   : (kết quả ghi ở báo cáo cuối phiên — docs-only, kỳ vọng PASS như baseline)
git diff --check : sạch
git status --short / --stat : chỉ 2 docs TASK-089 (untracked)
Secret scan      : đã chạy pattern CI hiện hành trên 2 docs — không match; không ghi cursor/URL
                   thật, không token, không email address; cursor ký hiệu C0/C-invalid.
```

## K. Open questions cho Antigravity (cập nhật sau HD-2/HD-3)

```text
1. Duyệt OPTION B++ (replace-on-success) làm kiến trúc Phase 2 (OD-1 — superseded hai lần:
   A → B+ theo HD-1, B+ → B++ theo HD-2)?
2. Đồng ý invariant I1 viết lại: "410 must never result in an unbounded cross-tick retry of the
   invalid cursor WITHOUT a recovery attempt" (C-invalid được CỐ Ý giữ làm durable recovery
   trigger — mỗi tick một probe + một bounded attempt; task file §16 I1, §23 Q4)?
3. Đồng ý residual duy nhất còn lại là freshness-policy cutoff (recovery fail liên tục >30 phút
   ⇒ message già quá threshold bị stale-skip đúng chính sách TASK-080 — không phải lỗ hổng kiến
   trúc, không mở OD mới; task file §23.8)?
4. Đồng ý HD-3: extract leaf policy module cho hằng freshness 30 phút (thay vì export từ
   pipeline) + service impact khai báo behavioral-vs-source như §18 (worker-email có source diff,
   zero behavioral change)?
5. Đồng ý phân loại theo HTTP 410 (error code chỉ chẩn đoán, case-insensitive), KHÔNG phụ thuộc
   Location header (INFERENCE §13)?
6. Đồng ý "NO CHANGE" cho webhook/subscription (§11, §22 Q12), mailbox-state seams là
   pre-existing (§23 Q6), và Deferred Findings DF-1..DF-3 (DF-1 at-most-once-after-claim là
   pre-existing, không sửa trong TASK-089)?
7. Repeated-410: mỗi tick một probe + một recovery attempt, paced theo interval — giữ đánh giá
   "không cần backoff riêng" (OD-3)? Alert 410 (OD-4)?
```

## L. Tóm tắt correction HD-1 (chi tiết đầy đủ: task file §22)

```text
HD-1: không khóa Option A — Antigravity xác nhận độc lập scenario: webhook miss M + 410 +
bootstrap câm ⇒ M mất vĩnh viễn khỏi delta backup path.

Điều tra Option B+ trả lời đủ 12 câu hỏi bắt buộc bằng code evidence — điểm chốt:
  Q1/Q2: phân biệt recovery vs initial bootstrap là IN-MEMORY trong cycle (`isBootstrap` vốn đã
         là biến local derive từ cursor null) ⇒ KHÔNG migration, KHÔNG persistent flag,
         KHÔNG encode state vào deltaLastErrorMessage (sai vai trò field).
  Q3   : hành vi bootstrap-conditional duy nhất là một khối `if (!isBootstrap)` quanh enqueue
         ⇒ mode hóa là thay đổi cục bộ trên code path sẵn có.
  Q4–Q6: reuse buildInitialDeltaUrl; lookback 24h có page-cap risk ⇒ RECOVERY_LOOKBACK = dẫn
         xuất từ stale threshold 30m TASK-080 (một nguồn sự thật; enumerate xa hơn 30m có giá
         trị relay = 0 vì stale guard terminal-skip).
  Q7   : không double Telegram — 4 lớp (queue jobId, early dedup, stale, claim P2002); wording
         chính xác: claim-before-send + pre-existing at-most-once-after-claim (không claim
         "perfect exactly-once").
  Q8   : 410 giữa multi-page: message đã enqueue không mất; replay bị queue/pipeline dedup nuốt;
         không persist cursor trung gian/corrupt.
  Q9/Q10: recovery ONE-SHOT/cycle; 410-trong-recovery không reset lần hai, không đệ quy; transient
         giữ semantics; cycle luôn settle; tick sau tự thử.
  Q11  : 401/403/071/075/080 nguyên trạng (guard reset sẵn có tự skip khi cursor null).
  Q12  : webhook/GraphSubscription NO CHANGE.

Sửa wording: §8 đổi tên + tuyên bố delivery-semantics chính xác; bỏ mọi hàm ý "exactly-once
Telegram delivery" tuyệt đối.

Invariants bổ sung: I15 (one-shot recovery), I16 (không write-spam reset), I17 (một nguồn sự
thật cho lookback); I10/I14 cập nhật. Test matrix bổ sung nhóm §17.7 (13 case B+).
```

## M. Tóm tắt correction HD-2 + HD-3 (chi tiết đầy đủ: task file §23)

```text
HD-2 — OPTION B++ REPLACE-ON-SUCCESS (8 câu hỏi, trả lời bằng code evidence):
  Q1: KHẢ THI với writer hiện tại — saveDeltaCursor là mailbox.update UNCONDITIONAL (không
      precondition null, không so sánh giá trị cũ) ⇒ C-new đè thẳng C-invalid, đúng cách mọi
      cursor advance C0→C1 vẫn chạy. Không đổi repo interface.
  Q2: Reset-to-null KHÔNG phải correctness requirement — provider chỉ yêu cầu "restart full
      synchronization" (một enumeration mới), không nói gì về giá trị cột DB; reset của TASK-071
      là lựa chọn implementation cho 403 khi bootstrap là recovery path duy nhất. 410 không phải
      reuse sequencing của 403.
  Q3: Recovery fail — B+ mất recovery semantics (null ⇒ bootstrap câm); B++ giữ C-invalid ⇒
      retry mỗi tick tới khi thành công; overhead thêm đúng 1 probe request/tick; ÍT DB write
      hơn (không reset-write); observability TỐT HƠN (marker + C-invalid tồn tại tới khi lành).
  Q4: Invariant I1 viết lại — phân biệt (A) reuse như normal processing không nhận thức recovery
      (= bug hiện tại, bị cấm) vs (B) durable recovery trigger có chủ đích (= B++):
      "410 must never result in an unbounded cross-tick retry of the invalid cursor WITHOUT a
      recovery attempt."
  Q5: Repeated 410 — one-shot/cycle, không recursive, không null-write, settle, tick sau thử;
      scheduler non-overlap không đổi (mọi việc vẫn trong runDeltaPollingOnce được await).
  Q6: Mailbox state race — save/record không re-check status (PRE-EXISTING, write inert vì list
      ACTIVE-only); enqueue seam ĐƯỢC pipeline re-check (`SKIPPED_MAILBOX_NOT_ACTIVE`, dòng
      ~562–569). B++ không ghi status, không resurrect gì. Ngoài scope TASK-089.
  Q7: Multi-page recovery replay — C-invalid vẫn persisted, không intermediate persist; replay
      bị queue-jobId + pipeline dedup nuốt; wording: claim-before-send prevents duplicate replay
      for the same claimed message identity, with pre-existing at-most-once-after-claim.
  Q8: B++ thắng B+ trên: loss-khi-fail (loại bỏ), DB write (ít hơn), observability (tốt hơn),
      complexity (bỏ hẳn reset khỏi đường 410); hòa phần còn lại.
  ⇒ RECOMMEND B++; OD-6 RESOLVED; kết luận cũ "loại bỏ residual cần migration" bị RÚT LẠI
    chính thức (§22.4 gắn ghi chú ghi đè).

HD-3 — FRESHNESS POLICY DEPENDENCY:
  - Import pipeline chỉ để lấy hằng: không circular hôm nay (pipeline không import delta) nhưng
    sai hướng tầng (module lean phụ thuộc module 1216 dòng tầng cao) ⇒ bị loại.
  - Không có leaf module sẵn phù hợp (env: threshold cố ý không env-tunable; queue types/dedup/
    keywords: sai domain).
  - Quyết định: EXTRACT leaf policy module mới (thuần hằng số, không I/O); pipeline + delta cùng
    import — một nguồn sự thật, dependency direction sạch. Impact trung thực: worker-email có
    SOURCE diff (pipeline đổi import), ZERO behavioral change; tên/vị trí module chốt ở OD-7.

Docs cập nhật: §15 (recommendation B++), §16 (I1/I10/I16/I17), §17.8 (12 test case B++,
ghi đè các dòng reset/null của §17.7), §18 (bảng behavioral vs source/build), §20 (OD-6 resolved,
OD-7 mới), §21, §22.4 (ghi chú ghi đè), §23 (toàn bộ điều tra).
```

## N. PHASE 2 — Implementation summary (chi tiết đầy đủ: task file §24)

### N.1. Files changed

```text
MỚI : services/email/relay-freshness-policy.ts        (leaf policy — 30' single source of truth)
SỬA : services/email/graph-message-pipeline.service.ts (chỉ đổi nguồn import hằng — zero behavior)
SỬA : services/microsoft/delta-polling.service.ts      (toàn bộ behavior B++)
MỚI : tests/unit/microsoft/delta-polling.sync-state-recovery.test.ts (23 tests — đếm chính
       thức bằng vitest, khớp 1281 → 1304; "21" trong draft trước là lỗi đếm tài liệu)
SỬA : 2 docs TASK-089
KHÔNG sửa: delta-polling-runner.ts (interface đủ, đúng dự đoán §23 Q1), Prisma schema/migration,
.env*, CI, package scripts, subscription/webhook/credential code, ROADMAP, Railway.
```

### N.2. Implementation đúng architecture đã approve

```text
- 410 classify theo HTTP status (kind 'syncStateLost' riêng); error code chỉ diagnostics;
  không đọc/log body thô, không đọc/không log/không dùng Location header (minimal).
- KHÔNG resetDeltaCursor / KHÔNG persist null / KHÔNG đổi status / KHÔNG forbidden counter/
  cooldown/alert / KHÔNG reconnect trên đường 410.
- Đúng MỘT recovery enumeration cùng cycle, từ initial-query builder TASK-036 với lookback
  = MAX_RELAY_MESSAGE_AGE_MS import từ leaf module (không hằng 30' thứ hai, không dùng 24h).
- SUCCESS: saveDeltaCursor(C-new) đè trực tiếp C-invalid + clear error metadata (writer sẵn có).
- FAIL (second 410/timeout/429/5xx/PAGE CAP): C-invalid giữ nguyên, marker sanitized
  ('SYNC_STATE_RECOVERY_FAILED:...' / 'SYNC_STATE_RECOVERY_INCOMPLETE:page_cap_before_deltaLink'),
  cycle settle, tick sau một probe + một attempt mới. Không recursion/second attempt.
- PAGE-CAP guard bắt buộc: partial enumeration ≠ success; không fabricate/persist intermediate.
- 401/403 trong recovery delegate nguyên văn semantics cũ (reconnect / TASK-071 reset +
  TASK-075 backoff). Initial bootstrap giữ nguyên: enumerate KHÔNG enqueue (regression test riêng).
- Recovery đi qua đúng fetch seam timeout 20s TASK-080 (không fetch path mới).
- Không persist recovery flag; không encode state vào deltaLastErrorMessage; mode là in-memory.
```

### N.3. Tests & verification

```text
23 tests mới (delta-polling.sync-state-recovery.test.ts) phủ đủ 30 mục ma trận bắt buộc
(một số mục dựa suite hiện có: TASK-075/401 regression, stale boundary 30'/31', dedup pipeline —
tất cả giữ PASS). Deterministic: fake fetch/DI/fake timers; không gọi Microsoft thật.

npm run verify : PASS (exit 0) — 105 test files / 1304 tests, lint + typecheck + build sạch.
git diff --check: sạch. Secret scan (pattern CI) trên docs + diff runtime: không match.
```

### N.4. Service impact

```text
worker-delta: behavioral YES · worker-email: behavioral NO, source diff YES (import swap) ·
web: NO · worker-renewal: NO · Prisma migration: NO.
Railway: không thao tác ở Phase 2; promotion sau này có thể redeploy nhiều service do topology
(cùng branch staging, không Watch Paths) — không đổi direct behavior impact.
```

### N.5. Antigravity cần review trọng tâm

```text
1. Nhánh catch mới trong runDeltaPollingOnce (thứ tự nhánh: syncStateLost → auth → forbidden →
   else) + điều kiện guard (tokenForRecovery, cursor-lúc-load != null).
2. handleSyncStateLost: one-shot, never-throws, delegation 401/403, page-cap guard, ordering
   record-marker-trước-recovery.
3. Refactor traverseDeltaPages có thật sự zero-behavior-change cho cursor/bootstrap path.
4. Import direction leaf policy module (HD-3) + zero behavioral change ở pipeline.
5. Sanitization: không cursor/Location/token/code/body trong log/metadata.
```

---

```text
KẾT LUẬN PHASE 2:
READY FOR ANTIGRAVITY IMPLEMENTATION REVIEW — NO COMMIT / NO PUSH.
TASK-089 chưa completed; ROADMAP chưa cập nhật; không thao tác Railway.
```
