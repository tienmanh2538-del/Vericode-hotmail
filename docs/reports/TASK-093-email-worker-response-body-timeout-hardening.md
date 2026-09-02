# TASK-093 — Email Worker Microsoft Response Body Read Timeout & End-to-End Deadline Hardening (Phase 1 Report)

> **Phase 1 — INVESTIGATION / ARCHITECTURE ONLY.** Không implementation, không
> test change, không commit/push, không ROADMAP, không Railway, không migration.
> Sanitized: không secret/token/credential/connection string/full verification
> code/full email body. Tài liệu kiến trúc chi tiết:
> `docs/tasks/TASK-093-email-worker-response-body-timeout-hardening.md`.

---

## 1. Precheck evidence

- `git branch --show-current` → đúng nhánh làm việc của TASK-093 (không ghi
  nguyên tên nhánh theo quy tắc secret-scan của CLAUDE.md).
- `git status --short` → rỗng; `git diff --stat` → rỗng (working tree sạch).
- `git log -1 --oneline` → `0b3b2d3 docs: close out task 092` — HEAD là
  close-out commit TASK-092, đúng expected.
- Node tại môi trường dev/CI: v24.16.0 (global `fetch` = undici bundled).
- Không đọc/in/sửa `.env*`.

## 2. Files / code paths đã đọc

Tài liệu: AGENTS.md, CLAUDE.md, ANTIGRAVITY.md, TASK-080/090/092 task+report
(TASK-092 §3 ghi chú DF-92-1 gốc; §10.1 budget; §17 close-out), ROADMAP mới
nhất (entry TASK-092 + residual DF-92-1..6).

Code trace tại HEAD:

- `lib/http/fetch-with-timeout.ts` (52–83 — timer lifecycle)
- `services/microsoft/refresh-access-token.service.ts` (107–184)
- `services/microsoft/graph-mail.service.ts` (`performGraphRequest` 243–290,
  `getMessageById`)
- `services/queue/workers/email-worker-runner.ts` (58, 268–270, 305–310)
- `services/microsoft/delta-polling.service.ts` (324–402), `services/telegram/
  telegram-sender.service.ts` (205–249), `subscription-renewal-runner.ts`
  (331–382) — adjacent/compatibility
- Repo-wide search: `.json()`, `.text()`, `.arrayBuffer()`, `response.body`,
  `reader.read(`, `fetchWithTimeout`, fetch trần.

## 3. Findings chính

### F1 — DF-92-1 CONFIRMED ở mức code: body reads nằm ngoài cửa sổ deadline

`fetchWithTimeout` clear timer trong `finally` (helper 80–82) ngay khi promise
fetch settle — tức khi HEADERS về (fetch spec; code repo tự chứng minh: status
được check trước mọi body read). Body reads sau đó không có deadline
code-level: refresh 128–133 (`response.json()`, luôn đọc kể cả error payload),
graph 281–288 (`response.json()`, chỉ khi ok). Sau `clearTimeout`, KHÔNG còn
code path nào gọi `controller.abort()` ⇒ signal còn gắn với body stream nhưng
không bao giờ fire.

### F2 — Body hang: không vô hạn tuyệt đối trong runtime mặc định, nhưng không được code bảo đảm (trung thực hóa DF-92-1)

Node 24/undici có `bodyTimeout` mặc định ~300s dạng idle giữa các chunk:
stall hoàn toàn ⇒ `json()` reject sau ~300s ⇒ attempt settle rồi retry. Tuy
nhiên: (a) 300s ≫ 20s deadline chủ đích và ≫ mailbox-lock TTL 60s; (b)
slow-drip body kéo dài unbounded về nguyên tắc; (c) là library default không
được code repo pin/bảo đảm — đúng nhóm TASK-092 Phase 1 đã loại. Giá trị
chính xác trên runtime production: UNKNOWN (không invent).

### F3 — Cancellation thật cho body là khả thi với chính controller hiện có

Theo WHATWG fetch/undici semantics: abort signal SAU headers terminate body
stream và làm `json()`/`text()` reject. Gap duy nhất là timer bị clear sớm.
(Runtime semantics theo tài liệu — sẽ pin bằng mock-contract test Phase 2.)

### F4 — Impact khi body pending

Giữ BullMQ slot; job lock được lock-extender renew (BullMQ v5 — evidence
TASK-092); stalled detector không cứu khi process sống; mailbox lock có thể
hết TTL 60s ⇒ job cùng mailbox chạy song song (claims TASK-068A/090 chặn
duplicate delivery, không chặn double Microsoft calls); 2 hangs = mất toàn bộ
capacity (concurrency 2) trong thời gian hang — theo đợt (~300s idle-bounded)
với stall hoàn toàn, unbounded với slow-drip.

### F5 — Vị trí an toàn so với claims và TASK-085

Cả hai body reads TRƯỚC identity/delivery claim; refresh body read TRƯỚC
parse/validate và TRƯỚC `persistRotatedRefreshToken` ⇒ body timeout không thể
partial write, không đổi CAS, không tạo row/lease/terminal write.

### F6 — Classification hiện có đã an toàn về OUTCOME cho body failure

Graph: json reject ⇒ `parse` ⇒ `FAILED_GRAPH_FETCH` (retryable, không
reconnect). Refresh: json reject bị nuốt ⇒ `token_endpoint` không revoke code
⇒ `transient`. Nhánh 401/403 Graph settle từ headers, không đọc body ⇒ body
deadline không thể giả 401/403 hay đụng ErrorQuotaExceeded. Gap còn lại là
type precision (timeout-vs-parse) — giải quyết bằng việc helper sở hữu body
read và ném `HttpTimeoutError` (task doc §6), không cần đổi taxonomy.

### F7 — Inventory đầy đủ (task doc §4)

Exact scope: graph 283 + refresh 130. Adjacent (KHÔNG sửa, deferred):
delta-polling 334/395 (DF-93-1), telegram-sender 240 (DF-93-2),
graph-subscription 431 + web/OAuth (DF-93-3/DF-92-3). `app/api/**` là incoming
request reads — không liên quan. Không có `.arrayBuffer()`/manual stream
reader trong repo.

## 4. Confirmed vs disproved hypotheses

| Hypothesis | Kết quả |
|---|---|
| "Body read đã nằm trong timeout window sau TASK-092" | **DISPROVED** — F1 |
| "Body hang chắc chắn vô hạn" | **DISPROVED một phần** — F2: idle-bounded ~300s (library default, không code-guaranteed); slow-drip unbounded |
| "Cần controller/cơ chế mới để cancel body" | **DISPROVED** — F3: cùng controller đủ, chỉ cần giữ deadline sống qua body phase |
| "Body timeout có thể giả 401/403/reconnect hoặc hỏng TASK-085/090/091" | **DISPROVED** — F5, F6 |
| "NO CHANGE chấp nhận được nhờ undici default" | **REJECTED** — không code-guaranteed, vượt mọi budget, slow-drip unbounded, DF-92-1 đã được các review chỉ định đóng bằng task riêng |

## 5. Option comparison (tóm tắt — bảng đầy đủ task doc §7)

| Option | Đánh giá | Verdict |
|---|---|---|
| **A1 — Narrow opt-in**: shared helper có consume-within-deadline capability; service chỉ bật khi nhận opt-in flag tường minh (default TẮT) từ email-worker caller | Cancellation thật; không cộng dồn 20+20; `HttpTimeoutError` từ helper giữ phân biệt timeout vs malformed JSON; behavioral scope đúng khóa (chỉ worker-email); caller khác bit-for-bit; không duplicate deadline logic | **CHỌN** |
| A2 — Shared automatic strengthening (mọi caller có `timeoutMs` tự nhận absolute deadline) | Behavioral scope expansion sang delta/reconciliation chưa được phê duyệt | **Loại** (chỉ ghi làm alternative; muốn adopt cần task riêng + user approval) |
| B — Caller sở hữu controller/deadline | Duplicate logic tinh vi ở nhiều call-site, mất single source of truth của TASK-080 | Loại |
| C — Body timeout riêng sau headers | Tổng 20+X vi phạm ràng buộc TASK-092; muốn giữ 20s tổng thì tự tái tạo absolute deadline phức tạp hơn | Loại |
| D — Graph-only | Refresh cùng gap (đọc cả error payload); bất đối xứng vô lý | Loại |
| E — NO CHANGE | Dựa trên library default không được bảo đảm | Loại (đã xem xét nghiêm túc) |

## 6. Recommendation / verdict

**OPTION A1 — narrow opt-in** (caller inventory + thiết kế + contract đầy đủ:
task doc §7/§7.1):

- Helper `fetch-with-timeout.ts` thêm optional consume-within-deadline
  capability; toàn bộ timer/abort/timeout-marker logic một chỗ; hàm/hành vi
  hiện tại giữ nguyên cho mọi caller cũ.
- Refresh + graph service thêm **opt-in flag tường minh, default TẮT**: omit ⇒
  bit-for-bit semantics hiện tại (headers-only nếu có `timeoutMs`,
  pass-through nếu không); BẬT ⇒ MỘT absolute deadline phủ fetch + body read.
- **Chỉ email-worker runner truyền flag BẬT** cho cả hai seam, giữ nguyên
  `EMAIL_WORKER_HTTP_TIMEOUT_MS = 20_000` — không constant mới, không env,
  không migration.
- Việc chỉ truyền `timeoutMs` như hiện tại (delta 20s, reconciliation 20s)
  KHÔNG tự đổi body-consumption semantics của bất kỳ caller nào.
- A1 khả thi, không tạo API contract không an toàn ⇒ không blocker, không cần
  user scope decision.

Absolute deadline contract 10 điểm (một timer duy nhất từ trước fetch; clear
chỉ sau khi consumer xong/fail; abort thật khi fire; normalize
`HttpTimeoutError` qua timeout-fired marker; malformed JSON trước deadline giữ
classification hiện hành; consumer không nhận/log raw body ngoài behavior hiện
hữu; pass-through và non-opt-in caller giữ nguyên) — khóa tại task doc §7.1.

## 7. Deadline budget (task doc §8)

20_000 ms hiện là headers-only deadline; Phase 2 biến nó thành absolute
deadline fetch + body trên email path, giữ nguyên giá trị. **Phát biểu budget
chính xác:** hai Microsoft network operations được code-bound tổng tối đa 40s
nếu cả hai đều chạy; các pre-claim operations còn lại (DB/decrypt/detector)
không có code-level deadline riêng ⇒ "pre-claim < mailbox TTL 60s" chỉ là
**operational expectation, không phải invariant toán học**; TASK-093 cải
thiện boundedness của hai HTTP operations nhưng **không giải quyết DF-92-6**
(mailbox-lock TTL/renewal vẫn ngoài scope). Payload hai seam là JSON nhỏ/vừa
⇒ 20s tổng rộng rãi (delta tải cả trang delta trong cùng 20s từ TASK-080).

## 8. Migration / service impact (task doc §9)

Không Prisma/Redis/env/BullMQ change. Behavioral: worker-email **YES**;
worker-delta **NO** (không opt-in — bit-for-bit TASK-080 semantics);
worker-renewal/reconciliation **NO**; web **NO**; disconnect-remote-cleanup
**NO**. Các service ngoài worker-email chỉ có compile/regression verification
impact. Nếu Phase 2 không giữ được matrix này ⇒ DỪNG, cần user scope decision.

## 9. Deterministic Phase 2 test matrix

24 cases (task doc §10), nay gồm đầy đủ compatibility cho narrow opt-in:
headers+body success; body hang settle đúng absolute deadline; timer tính từ
lúc fetch bắt đầu, KHÔNG reset khi headers về (headers t=10s + hang ⇒ abort
t=20s); signal thật abort stream; timer cleanup; deadline-fired body
AbortError ⇒ `HttpTimeoutError`; malformed JSON trước deadline ≠ timeout;
real 401/403 giữ nguyên; token body timeout không persist credential + OAuth
error-body timeout không reconnect; Graph body timeout trước claim; processor
rethrow; lock release; BullMQ policy; no infinite pending; two hangs giải
phóng ≤ deadline; **no-timeout caller pass-through bit-for-bit**;
**headers-only caller (delta refresh, có timeoutMs nhưng KHÔNG flag) giữ EXACT
pre-TASK-093 behavior — body read không bị abort**; **reconciliation/other
timeout caller giữ nguyên**; **email opt-in wiring: cả hai seam truyền
constant + flag**; real readable revoke code vẫn reconnect; TASK-080/090/091/
092 regressions. Fake timers + controllable streams; không real network;
không wall-clock 20s.

## 10. Deferred findings

DF-93-1 (delta body reads 334/395 + body read của refresh trên delta path —
delta không opt-in A1; adopt là task riêng cần user phê duyệt scope), DF-93-2
(telegram body read 240), DF-93-3 (subscription `.text()` + web/OAuth — trùng
DF-92-3/5), DF-93-4 (undici bodyTimeout default là safety net runtime-level
không được code pin). Không finding nào được đưa vào implementation scope
TASK-093.

## 11. Correction pass trước Antigravity review

Hai điểm được sửa sau bản draft đầu:

1. **Scope-expansion bị loại bỏ.** Draft đầu khuyến nghị để mọi caller đang
   truyền `timeoutMs` (gồm worker-delta) tự động nhận absolute body deadline
   ("strengthening") — đây là behavioral scope expansion trái với scope
   TASK-093 đã khóa. Đã trace lại đủ 5 caller của `refreshMicrosoftAccessToken`
   (email, delta, renewal-port/reconciliation, web inbox-test,
   disconnect-remote-cleanup) và caller duy nhất của `getMessageById` (email),
   rồi chia Option A thành **A1 (narrow opt-in — CHỌN)** và **A2 (automatic
   strengthening — LOẠI, chỉ ghi làm alternative)**. Matrix mới: behavioral
   change CHỈ ở worker-email; delta/renewal/reconciliation/web/cleanup NO.
2. **Budget wording sửa lại.** Bỏ tuyên bố TASK-093 làm lập luận budget
   TASK-092 "đúng trọn vẹn". Phát biểu chính xác: 40s chỉ code-bound HAI
   network operations; pre-claim < 60s là operational expectation, không phải
   invariant; DF-92-6 không được giải quyết bởi TASK-093.

Đồng thời bổ sung: absolute deadline contract 10 điểm (task doc §7.1);
error-classification contract tường minh cho OAuth error-body deadline (task
doc §6); test matrix mở rộng 20 → 24 cases với compatibility tests cho
headers-only/no-timeout/reconciliation callers và opt-in wiring.

## 12. Exact two-file diff summary

Chỉ hai file mới (intent-to-add trước final verification):

- `docs/tasks/TASK-093-email-worker-response-body-timeout-hardening.md`
- `docs/reports/TASK-093-email-worker-response-body-timeout-hardening.md`

Không code/test/ROADMAP/schema/migration/env/config thay đổi. Chưa
commit/push.

## 13. Verification results

- `npm run verify`: PASS (110 test files / 1350 tests; lint/typecheck/build
  PASS — docs không tham gia pipeline).
- `git diff --check` (sau intent-to-add cả hai file): PASS — nội dung thật đã
  vào diff và được đọc toàn bộ, kể cả sau correction pass.
- Không secret/nhạy cảm; wording tránh secret-scan false positive.

## 14. Readiness

Investigation hoàn tất; DF-92-1 được xác nhận và định lượng trung thực;
recommendation duy nhất **Option A1 — narrow opt-in** (absolute 20s deadline
xuyên fetch + body, kích hoạt tường minh chỉ từ email-worker, contract §7.1,
không behavioral change cho caller khác) — không blocker, không cần user
scope decision. Sẵn sàng Antigravity Architecture Review trước Phase 2.

> Kết quả sau đó: Antigravity Architecture Review —
> **PASS — TASK-093 PHASE 1 ARCHITECTURE APPROVED FOR PHASE 2 IMPLEMENTATION.**

---

# PHASE 2 — IMPLEMENTATION REPORT

## 15. Implementation summary (đúng Option A1 + contract §7.1)

- **Helper**: internal core `runWithDeadline` (một timer + một controller + cờ
  `timedOut`, arm trước fetch, clear duy nhất trong `finally` sau khi công
  việc settle) dùng chung cho `fetchWithTimeout` (chữ ký/behavior GIỮ NGUYÊN)
  và hàm mới `fetchAndConsumeWithTimeout(fetchImpl, url, init, consume,
  options)` — cùng `timeoutMs` là MỘT absolute deadline phủ fetch + toàn bộ
  async consume; fire ⇒ abort thật (body stream hủy thật, không Promise.race);
  normalize `HttpTimeoutError`; consumer/fetch error trước deadline rethrow
  nguyên bản; pass-through khi không có timeout. `consume` nhận `signal` của
  deadline để service giữ đúng swallow/parse semantics cho lỗi không-timeout.
- **Refresh service**: option mới `deadlineCoversBodyRead` (default OFF).
  OFF ⇒ path legacy bit-for-bit; ON ⇒ fetch + json read (cả success lẫn OAuth
  error payload, như trước) dưới một deadline; deadline-abort ⇒ `network` ⇒
  transient; non-abort parse giữ swallow ⇒ `token_endpoint` như cũ. Không sửa
  rotation service/CAS.
- **Graph service**: option mới `deadlineCoversBodyRead` trên
  `GetMessageOptions` (default OFF). Non-2xx handling và success-json parse
  được tách thành hai hàm shared (`throwForGraphErrorStatus`,
  `parseGraphJsonBody`) dùng cho CẢ legacy lẫn opt-in path — không drift;
  non-2xx classify thuần bằng `response.status` + retry-after header, KHÔNG
  đọc error body; `listInboxMessages` không đổi.
- **Email wiring**: cả hai call-site trong `email-worker-runner.ts` thêm
  `deadlineCoversBodyRead: true`, giữ nguyên
  `EMAIL_WORKER_HTTP_TIMEOUT_MS = 20_000`; thứ tự calls không đổi (vẫn trước
  identity/delivery claims); mailbox lock/BullMQ/TASK-090 không đụng.
- Option A2 KHÔNG được triển khai; không caller nào ngoài email-worker bật
  capability.

## 16. Files changed (Phase 2)

| File | Loại |
|---|---|
| `lib/http/fetch-with-timeout.ts` | Sửa — core chung + `fetchAndConsumeWithTimeout` |
| `services/microsoft/refresh-access-token.service.ts` | Sửa — opt-in flag + consume path |
| `services/microsoft/graph-mail.service.ts` | Sửa — opt-in flag + shared status/parse helpers |
| `services/queue/workers/email-worker-runner.ts` | Sửa — bật opt-in tại 2 seam |
| `tests/unit/lib/fetch-with-timeout.test.ts` | Mở rộng — +6 cases capability |
| `tests/unit/microsoft/graph-mail.timeout.test.ts` | Mở rộng — +4 cases opt-in/compat |
| `tests/unit/microsoft/refresh-access-token.timeout.test.ts` | Mở rộng — +5 cases opt-in/compat |
| `tests/unit/queue/email-worker-runner.test.ts` | Sửa — wiring assertions kèm flag |
| `tests/unit/queue/delta-polling-runner.test.ts` | Mở rộng — +1 compatibility pin (không flag) |
| Hai tài liệu TASK-093 | Cập nhật Phase 2 |

## 17. Error behavior & regression evidence (Phase 2)

- Graph body deadline: `HttpTimeoutError` ⇒ `GraphMailError('network')` ⇒
  `FAILED_GRAPH_FETCH` ⇒ processor throw ⇒ BullMQ retry. Token body deadline:
  ⇒ `RefreshAccessTokenError('network')` ⇒ transient ⇒
  `FAILED_TOKEN_TRANSIENT` ⇒ throw ⇒ retry.
- Negative invariants có test: không giả 401/403 (401 test: classify bằng
  status, json không được gọi); không reconnect khi chưa đọc được provider
  code (OAuth error-body hang ⇒ network, không mã lỗi); readable
  `invalid_grant` vẫn reconnect_required; malformed JSON trước deadline giữ
  `parse`/`token_endpoint`; không persist credential khi timeout (test
  TASK-092 giữ nguyên + timeout ném trước persist); không CAS conflict;
  claims/Telegram không chạm (timeout trước claims — pipeline tests giữ
  nguyên).
- TASK-080/085/090/091/092: toàn bộ test suites liên quan pass không sửa
  semantics; delta compatibility được pin thêm bằng test mới (options không
  chứa flag).

## 18. Verification results (Phase 2)

- Targeted: 7 test files liên quan seam — **81/81 PASS**.
- `npm run verify`: **PASS** — toàn bộ suite (110 files / 1350+16 tests mới =
  1366 tests) + lint/typecheck/build (số liệu chính xác ghi ở báo cáo phiên).
- `git diff --check` PASS; full diff đã đọc.

## 19. Migration / service impact / residual

Không Prisma/Redis/env/BullMQ/GitHub Actions/Railway change. Behavioral
change chỉ ở worker-email; caller khác bit-for-bit (matrix §15.3 task doc).
Residual giữ deferred: DF-93-1 (delta body reads + delta refresh không
opt-in), DF-93-2 (Telegram), DF-93-3 (subscription/web/OAuth), DF-93-4
(undici default không pin), và DF-92-2..6 từ TASK-092.

## 20. Antigravity Implementation Review — kết quả chính thức

Kết luận: **PASS — TASK-093 PHASE 2 IMPLEMENTATION APPROVED.**

- Không có finding Critical, High hoặc Medium.
- Low notes (không chặn nghiệm thu, không sửa trong TASK-093): timeout
  observability tiếp tục gộp vào network; "pre-claim dưới 60 giây" chỉ là
  operational expectation; các adjacent body-read seams vẫn deferred.
- Implementation được phê duyệt đúng như khóa: **Option A1 Narrow Opt-in** —
  shared `fetchAndConsumeWithTimeout<T>` (internal core `runWithDeadline`
  dùng chung với `fetchWithTimeout`); một absolute deadline 20.000 ms bao phủ
  fetch + body; timer bắt đầu trước fetch, không reset ở headers; cancellation
  thật bằng AbortController; deadline abort normalize thành
  `HttpTimeoutError`; malformed/provider/consumer errors trước deadline giữ
  behavior hiện hành; `fetchWithTimeout` giữ legacy behavior; capability
  default OFF; chỉ hai worker-email seams bật opt-in.
- Shared-caller compatibility: worker-delta không opt-in; reconciliation/
  renewal không opt-in; web/cleanup không opt-in; `listInboxMessages` không
  đổi; Telegram không đổi; behavioral change chỉ worker-email.
- Error/invariant evidence: Graph body timeout → network →
  `FAILED_GRAPH_FETCH` → BullMQ retry; token body timeout → network/transient
  → `FAILED_TOKEN_TRANSIENT` → retry; readable
  `invalid_grant`/`interaction_required` vẫn reconnect; unreadable/hanging
  OAuth error body không mark reconnect; real 401/403 giữ nguyên; không
  credential persistence/CAS conflict; không ProcessedMessage/delivery claim;
  không Telegram; TASK-080/085/090/091/092 regression PASS.
- Test evidence: targeted 7 files / 81 tests PASS; full 110 files / 1366
  tests PASS; 16 deterministic tests mới; lint/typecheck/build PASS;
  `git diff --check` PASS.
- Service/migration impact: behavioral change chỉ worker-email; không
  migration; không env/Redis/BullMQ/Railway change.
- Residual giữ deferred (không tự sửa, không tự biến thành TASK-094):
  DF-93-1; DF-93-2; DF-93-3; DF-93-4; DF-92-2 (caller-signal composition);
  DF-92-4/DF-92-6 (mailbox-lock wiring/TTL); timeout observability.

## 21. Trạng thái

Chưa commit/push; feature CI chưa chạy; chưa staging promotion; chưa Railway
runtime validation; ROADMAP chưa cập nhật; TASK-093 chưa close-out.
**Antigravity Implementation Review PASS; sẵn sàng Final Pre-Commit Review.**
