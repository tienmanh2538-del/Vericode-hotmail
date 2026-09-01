# TASK-091 — Microsoft Graph 403 ErrorQuotaExceeded Investigation & Mailbox Recovery Semantics

> **TRẠNG THÁI: TASK-091 COMPLETED — INVESTIGATION-ONLY CLOSE-OUT.**
> **Antigravity Architecture Review: PASS — TASK-091 ARCHITECTURE APPROVED.**
> **Quyết định đã khóa: OPTION A — NO CODE CHANGE. Không có Phase 2 implementation.**
> Không migration/schema/runtime/test change. Chi tiết close-out: §19.
>
> Task này điều tra observation staging (tồn tại từ TASK-089, phân loại EXISTING / INDEPENDENT): một mailbox gặp
> `HTTP 403 code=ErrorQuotaExceeded` lặp lại trên đường delta polling. Mục tiêu Phase 1: trace exact error path tại HEAD,
> đối chiếu semantics 403 hiện tại (TASK-071/TASK-075) với official Microsoft semantics của `ErrorQuotaExceeded`,
> và trả lời câu hỏi trọng tâm: **error code này có nên dùng nguyên generic-403 semantics hiện tại hay cần treatment riêng**.
>
> Phase 1 KHÔNG sửa runtime code, KHÔNG schema/migration, KHÔNG tests, KHÔNG update ROADMAP, KHÔNG commit/push,
> KHÔNG thao tác Railway/production, KHÔNG gọi Microsoft Graph thật.
>
> **Nhãn bằng chứng dùng xuyên suốt:**
> - `REPO EVIDENCE` — đọc trực tiếp file tại HEAD, kèm đường dẫn:dòng.
> - `OFFICIAL MICROSOFT EVIDENCE` — tài liệu public của Microsoft (learn.microsoft.com).
> - `INFERENCE` — suy luận, ghi rõ là suy luận.
> - `UNKNOWN` — không đủ evidence để kết luận; không invent semantics.
>
> Mức khẳng định: **PROVEN** (chứng minh bằng code/official docs) / **SUPPORTED** (có evidence mạnh nhưng chưa toàn diện) /
> **INFERENCE** / **UNKNOWN**.
>
> **Quy ước an toàn:** không token/secret/connection URL; không verification code đầy đủ; không email body; không email
> address thật (mailbox chỉ nhắc trừu tượng là "mailbox bị ảnh hưởng"); không ghi tên nhánh Git đầy đủ (theo CLAUDE.md);
> không copy Graph request identifier thật.

---

## §1. Bối cảnh & phạm vi

- TASK-090 đã COMPLETED end-to-end (staging validation PASS, 109 test files / 1344 tests).
- TASK-089 §25.4 và TASK-090 §20.17 đều ghi nhận observation: một mailbox staging gặp `HTTP 403 code=ErrorQuotaExceeded`
  lặp lại; đã xác nhận đi đúng forbidden path TASK-071/075 (counter/cooldown/alert hoạt động đúng thiết kế, không
  RECONNECT_REQUIRED, không block mailbox khác), và được phân loại EXISTING / INDEPENDENT — không mở scope các task đó.
- TASK-091 (Human đã gán số) phải xác minh liệu `ErrorQuotaExceeded` có thực sự nên dùng nguyên semantics 403 hiện tại
  hay cần treatment riêng — **không giả định root cause hay fix trước khi trace code + provider semantics**.

Trong scope Phase 1: trace code tại HEAD, provider research, impact analysis, architecture options, test matrix design.
Ngoài scope Phase 1: mọi thay đổi code/schema/tests/ROADMAP; mọi thao tác staging/production.

## §2. Precheck (REPO EVIDENCE)

Đã chạy tại thời điểm bắt đầu task:

- `git branch --show-current` → nhánh làm việc của task hiện tại (TASK-091). ✅
- `git status --short` → sạch. ✅
- `git diff --stat` → rỗng. ✅
- `git log -1 --oneline` → `629bc95 docs: finalize task 090 staging validation` (HEAD chứa TASK-090 completed). ✅

PRECHECK PASS — tiếp tục Phase 1.

## §3. Nguồn đã đọc

- CLAUDE.md, AGENTS.md, ANTIGRAVITY.md, docs/PRODUCT_SPEC.md, docs/ARCHITECTURE.md, docs/SECURITY_RULES.md, docs/ROADMAP.md.
  (Ghi nhận: PRODUCT_SPEC/ARCHITECTURE là bản MVP cũ, không mô tả Graph/delta/webhook — semantics thực tế phải trace từ
  code + task docs. REPO EVIDENCE.)
- Task/report: TASK-071 (403 classification & reconnect-loop hardening), TASK-074 (email pipeline 403 classification),
  TASK-075 (delta persistent-403 backoff/alert), TASK-080 (delta timeout + stale guard), TASK-089 (410 sync-state
  recovery + §25.4 observation), TASK-090 (post-claim delivery + §20.17 observation).
- Code tại HEAD: `services/microsoft/delta-polling.service.ts`, `services/queue/workers/delta-polling-runner.ts`,
  `services/microsoft/graph-mail.service.ts`, `services/email/graph-message-pipeline.service.ts`,
  `services/microsoft/graph-subscription.service.ts`, `services/microsoft/subscription-renewal.service.ts`,
  `services/microsoft/webhook-notification.service.ts`, `services/health/health.service.ts`,
  `services/microsoft/refresh-access-token.service.ts`, `lib/http/fetch-with-timeout.ts`, `prisma/schema.prisma`, `lib/env.ts`.
- Official Microsoft docs (chi tiết §7).

## §4. Exact ErrorQuotaExceeded source path (Kết quả A — PROVEN, REPO EVIDENCE)

Grep toàn repo: chuỗi `ErrorQuotaExceeded` **không xuất hiện trong bất kỳ file code nào** — chỉ trong docs
(TASK-089/090 task+report, ROADMAP). Không có classifier nào match riêng chuỗi này. (PROVEN)

Đường tạo ra observation staging:

- **A. HTTP request:** `GET https://graph.microsoft.com/v1.0/me/mailFolders('inbox')/messages/delta`
  (cursor mode dùng nguyên `@odata.deltaLink` đã lưu; bootstrap mode dùng `buildInitialDeltaUrl`) —
  `services/microsoft/delta-polling.service.ts:30-31`, `:280-290`, `:464-466`.
- **B. Service/function:** worker-delta → `runDeltaPollingOnce` → `traverseDeltaPages` (`:523-575`) →
  `fetchDeltaPage` (`:349-409`), HTTP qua `fetchWithTimeout` với `DELTA_POLLING_HTTP_TIMEOUT_MS = 20_000` (`:44-49`, `:356-367`).
- **C. Error classifier:** `fetchDeltaPage` đọc diagnostics bằng `readGraphErrorDiagnostics` (`:324-347` — chỉ lấy
  `error.code`, `error.innerError.code`, header `request-id`; **không bao giờ** đọc `error.message` để tránh lộ UPN),
  rồi phân loại bằng `classifyHttpStatus(status)` (`:292-304`). Mapping **thuần theo HTTP status**:
  401→`auth`, **403→`forbidden`** (`:295`), 410→`syncStateLost`, 429/5xx→`transient`, khác→`unknown`.
  `ErrorQuotaExceeded` chỉ là diagnostics đi kèm, được giữ trong message dạng
  `GRAPH_REQUEST_FAILED (http=403) code=ErrorQuotaExceeded ... reqId=...` (`safeErrorMessage` `:428-444`).
- **D. Caller xử lý:** catch trong `runDeltaPollingOnce` → nhánh `error.kind === 'forbidden'` →
  `handlePersistentForbidden` (`:930-937`, `:980-1033`).
- **E. Persisted state bị thay đổi:** trên bảng `Mailbox`: `microsoftDeltaCursor` (reset null nếu đang có cursor),
  `deltaForbiddenCount` (+1), `deltaForbiddenCooldownUntil` (set khi count ≥ 3), `deltaLastErrorAt`,
  `deltaLastErrorMessage` — persist qua `recordForbiddenBackoff`/`resetDeltaCursor`
  (`services/queue/workers/delta-polling-runner.ts:104-138`). **Không đụng `Mailbox.status`.**
- **F. Next attempt:** tick kế tiếp của scheduler (interval mặc định **30 giây**, `lib/env.ts:239-241`;
  overlap-tick bị skip `delta-polling-runner.ts:345-349`) khi count < 3; khi count ≥ 3 thì sau khi hết
  `deltaForbiddenCooldownUntil` (5→60 phút, §6).

Xác nhận nguồn observation: format message `GRAPH_REQUEST_FAILED (http=403) code=...` chỉ được sinh bởi delta path
(`safeErrorMessage`), và health banner hiển thị `deltaLastErrorMessage` (`services/health/health.service.ts:771`,
`app/admin/health/page.tsx:320, 472-474`) ⇒ observation staging đến từ **delta polling**, không phải worker-email.
(PROVEN)

Các đường 403 khác (không phải nguồn observation nhưng thuộc scope trace — REPO EVIDENCE):

- **worker-email fetch message:** `getMessageById` (`services/microsoft/graph-mail.service.ts:313-344`) map
  403→`permission` (`mapHttpStatusToError` `:151-178`; **không parse `error.code`**); pipeline map `permission` →
  `FAILED_GRAPH_FETCH` (TASK-074, `services/email/graph-message-pipeline.service.ts:429-433`), retryable qua BullMQ
  (3 attempts, exponential base 5s — `services/queue/email-job-options.ts:14-15, 113-120, 212-224`), không flip mailbox.
- **Token refresh:** không có nhánh 403 riêng; phân loại theo OAuth error code (`refresh-access-token.service.ts:135-147`);
  chỉ `invalid_grant`/`interaction_required` mới dẫn tới reconnect (`services/microsoft/refresh-token-failure.ts:34-59, 90-92`).
- **Subscription create/renew:** 403→`permission` (`graph-subscription.service.ts:324-382`), renewal classify
  `permission` → **transient** (TASK-071, `subscription-renewal.service.ts:309-315`) — không reconnect.

## §5. Current 403 semantics — TASK-071 + TASK-075 (Kết quả B, C — PROVEN, REPO EVIDENCE)

Chuỗi hành vi khi delta gặp 403 (mọi `error.code`, kể cả `ErrorQuotaExceeded`):

1. **Classify `forbidden`** (`delta-polling.service.ts:295`) — không bao giờ `auth`.
2. **Cursor action:** nếu `microsoftDeltaCursor !== null` → reset về null (`:994-996`,
   `delta-polling-runner.ts:104-111`) — self-heal TASK-071 cho giả thuyết "cursor độc". 403 lúc bootstrap
   (cursor null) → không reset, chỉ retry.
3. **Forbidden counter:** `deltaForbiddenCount + 1` (`:998`), persist `recordForbiddenBackoff`
   (`delta-polling-runner.ts:118-138`).
4. **Cooldown:** chỉ khi `nextCount >= threshold` (`:1001-1006`); constants TASK-075:
   `DEFAULT_FORBIDDEN_BACKOFF_THRESHOLD = 3`, `FORBIDDEN_BACKOFF_BASE_MS = 5 phút`, `FORBIDDEN_BACKOFF_MAX_MS = 60 phút`
   (`:77-79`); công thức `min(5 phút × 2^(count − 3), 60 phút)` (`forbiddenBackoffMs` `:312-316`)
   ⇒ count 3→5m, 4→10m, 5→20m, 6→40m, ≥7→60m (cap). Persist cột `deltaForbiddenCooldownUntil` — **bền qua worker restart**.
5. **Cooldown skip:** đầu vòng lặp per-mailbox, trước cả bước lấy token: mailbox đang cooldown bị skip hoàn toàn,
   đếm `cooldownSkippedMailboxCount`, không tính failure (`:784-792`, `:196-199`).
6. **Alert:** khi cycle set cooldown (count ≥ 3) → `raisePersistentForbidden` → `sendAdminAlert` type
   `DELTA_POLLING_FAILED`, severity WARNING, Telegram OWNER/ADMIN; payload chỉ mailbox id + email masked +
   consecutive count + cooldownUntil + diagnostics enum-code; best-effort, nuốt lỗi (`:1018-1032`, `:1122-1142`,
   `delta-polling-runner.ts:269-286`); anti-spam in-memory cooldown ở `services/alerts/alert.service.ts:109-132`.
7. **Clear-on-success:** một poll thành công → clear `deltaForbiddenCount`, `deltaForbiddenCooldownUntil`,
   `deltaLastErrorAt`, `deltaLastErrorMessage` (`:857-859`, `:967-972`, `delta-polling-runner.ts:139-151`);
   cũng chạy sau recovery 410 thành công (`:905-907`).
8. **Không bao giờ RECONNECT_REQUIRED cho 403:** comment + code `:217-221`, `:294`, `:975-978`;
   `recordForbiddenBackoff` cố tình không đụng `status` (`delta-polling-runner.ts:126-127`).

**Trả lời câu hỏi bắt buộc:** `ErrorQuotaExceeded` **hiện CÓ bị reset delta cursor** (ở cycle forbidden đầu tiên còn
cursor). Lý do: đây là generic semantics TASK-071 áp cho **mọi** 403 — thiết kế nhắm giả thuyết "cursor độc gây 403"
(root cause thật của TASK-071). **Không có evidence nào** (repo hay provider) cho thấy cursor reset giúp ích cho
`ErrorQuotaExceeded` — đây thuần túy là semantics chung áp lên mọi 403, không phải quyết định riêng cho quota.
(PROVEN cho hành vi; xem verdict §11.)

## §6. Current backoff review (Kết quả D, J — REPO EVIDENCE)

- First cooldown: 5 phút tại count = 3 (hai cycle đầu full-speed ~30s/cycle để self-heal TASK-071 còn cơ hội).
- Maximum cooldown: 60 phút (cap).
- Reset condition: một poll thành công (clear toàn bộ); không có decay theo thời gian.
- Persistence: cột DB trên `Mailbox` — bền qua restart (PROVEN).
- Alert behavior: một alert mỗi lần vào cooldown; cooldown + anti-spam làm thưa re-alert.
- Steady state khi 403 kéo dài nhiều ngày: **~1 request delta/giờ/mailbox** + alert thưa. Không tight loop. (PROVEN)

**Verdict cho ErrorQuotaExceeded: ADEQUATE (SUPPORTED).** Evidence: (1) provider semantics nói điều kiện là persistent
cho tới khi admin xử lý (§7) ⇒ không cần retry nhanh, và cap 60 phút cho recovery latency chấp nhận được với vai trò
delta-là-backup; (2) TASK-089 staging observation xác nhận counter/cooldown/alert hoạt động đúng thiết kế trên chính
mailbox này; (3) bounded chứng minh bằng code. Ba cycle đầu full-speed là lãng phí nhỏ (3 requests) — không đáng
treatment riêng. (INFERENCE cho đánh giá "chấp nhận được"; số liệu là PROVEN.)

## §7. Official Microsoft semantics của ErrorQuotaExceeded (Kết quả E)

**OFFICIAL MICROSOFT EVIDENCE:**

1. **EWS `ResponseCodeType.ErrorQuotaExceeded`** (learn.microsoft.com — .NET API reference, ExchangeWebServices):
   *"Indicates that the user's quota has been exceeded."* — error code gốc từ Exchange, mang nghĩa **quota của mailbox
   bị vượt**, tách biệt hẳn các code throttling (`ErrorServerBusy`, `ErrorExceededConnectionCount`,
   `ErrorInsufficientResources`).
2. **Microsoft KB 4556585** (learn.microsoft.com/troubleshoot/power-platform/dataverse/…/errorquotaexceeded-exchange-server-returned-403-error,
   cập nhật 2025-04): với `ErrorQuotaExceeded. Exchange server returned 403 error`:
   *"This error indicates that Microsoft Exchange Server prevents the user from [performing the operation] due to a
   quota or limit being exceeded. For example, if the mailbox has exceeded its limit for storage…"* — trỏ tới trang
   **Exchange Online limits**; resolution là kiểm tra mailbox/quota và liên hệ Exchange admin — **không phải retry**.
3. **Microsoft Q&A** (learn.microsoft.com/answers/questions/2169662, trả lời bởi kỹ sư Microsoft): trên đường **sync/read**
   qua Graph, lỗi này cũng phát sinh khi mail folder chạm giới hạn item (~1 triệu items/folder theo Exchange Online
   limits — mailbox folder limits); khuyến nghị kiểm tra limits hoặc mở support case.
4. **Microsoft Graph throttling guidance** (learn.microsoft.com/graph/throttling): `Retry-After` được document cho
   **429/503 throttling**; `ErrorQuotaExceeded` **không** thuộc throttling guidance.

**Kết luận từng câu hỏi:**

| Câu hỏi | Kết luận | Mức |
|---|---|---|
| Quota nào? | Quota/limit của mailbox phía Exchange (storage quota; hoặc folder item limit trên đường read/sync). Loại quota chính xác của mailbox staging bị ảnh hưởng: **UNKNOWN** — cần Human kiểm tra Exchange/M365 admin, ngoài repo. | OFFICIAL + UNKNOWN (instance cụ thể) |
| Temporary hay persistent? | **Persistent** cho tới khi điều kiện quota được xử lý (bởi user/admin: dọn mailbox, tăng quota/license). Không tự hết theo thời gian như throttling. | SUPPORTED (KB + Q&A đều hướng resolution về phía admin, không nói "wait and retry") |
| Retry recommendation? | Không có tài liệu Microsoft nào khuyến nghị retry cho error code này; retry ngắn hạn không đổi kết quả khi quota chưa xử lý. | SUPPORTED |
| Retry-After có xuất hiện không? | Không có tài liệu nào gắn Retry-After với ErrorQuotaExceeded (Retry-After thuộc 429/503 throttling). Việc Graph có bao giờ đính kèm Retry-After với 403 quota hay không: **UNKNOWN** — không invent. | OFFICIAL (throttling scope) + UNKNOWN |
| Reconnect/OAuth có giúp không? | Không có bất kỳ evidence nào — lỗi thuộc trạng thái mailbox, không thuộc grant/token. | SUPPORTED (absence of evidence trong mọi doc đã đọc; không doc nào nhắc reauth) |
| Cursor reset có liên quan không? | Không có bất kỳ tài liệu nào liên hệ quota error với delta sync state. Sync-state error có code/status riêng (410 SyncStateNotFound — đã xử lý TASK-089). | SUPPORTED |

## §8. Impact analysis (Kết quả F, G)

Với mailbox đang gặp ErrorQuotaExceeded (REPO EVIDENCE trừ khi ghi khác):

| Câu hỏi | Phân tích | Mức |
|---|---|---|
| Webhook path còn hoạt động? | Đường webhook **không đọc** `Mailbox.status` hay `deltaForbiddenCooldownUntil` (`webhook-notification.service.ts:187-200` chỉ check subscription ACTIVE/RENEWING) → notification vẫn được enqueue, worker-email vẫn fetch. Việc fetch đó có bị chính quota chặn không (403 cả đường read) phụ thuộc loại quota — **UNKNOWN** cho instance staging (observation chỉ thấy delta path 403). Nếu fetch cũng 403: mỗi job fail sau 3 BullMQ attempts (`FAILED_GRAPH_FETCH`), bounded per notification. | PROVEN (cơ chế) + UNKNOWN (instance) |
| Delta backup còn hoạt động? | Không, cho mailbox đó: 403 mỗi lần chạm Graph; trong cooldown bị skip hoàn toàn. Mailbox khác không ảnh hưởng. | PROVEN |
| Email worker bị ảnh hưởng? | Chỉ với job của mailbox đó (nếu đường read cũng bị quota chặn). Worker/queue tổng thể không bị block — mỗi job bounded 3 attempts. | PROVEN (cơ chế) |
| Mailbox khác trong cycle? | Không bị ảnh hưởng: vòng per-mailbox có try/catch bao toàn thân, lỗi record vào đúng mailbox rồi đi tiếp (`delta-polling.service.ts:777, 799-952`). TASK-089 staging đã xác nhận live. | PROVEN |
| Health tổng vẫn PASS? | Có thể: check `DELTA_POLLING` chỉ WARNING khi **tất cả** mailbox overdue (`health.service.ts:281-312`); một mailbox 403 tạo mailbox-level WARNING (`Recent delta polling error`, `:173-183`) + sau 15 phút cooldown thêm reason `Delta polling stale` (vì bị skip nên `deltaLastPolledAt` không cập nhật; `DELTA_POLLING_STALE_MS = 15 phút`, `:61`). Health **không đọc** `deltaForbiddenCount`/`deltaForbiddenCooldownUntil` — operator chỉ thấy qua `lastErrorShort`. | PROVEN |
| Request lặp vô hạn? | Không tight loop: steady state ~1 delta request/giờ (cap 60m). Webhook side: bounded per notification. | PROVEN |
| Cooldown hiện tại bound đủ? | Đủ (§6 verdict ADEQUATE). | SUPPORTED |
| Relay silence / stale sau recovery? | **Relay silence:** nếu quota chặn cả đường read thì mailbox đó mất relay hoàn toàn cho tới khi Human xử lý quota — nhưng có tín hiệu (admin alert WARNING + health banner), không im lặng tuyệt đối. **Stale sau recovery:** khi quota được xử lý, poll thành công → clear state; vì cursor đã reset, cycle sau bootstrap với lookback 24h (`DEFAULT_BOOTSTRAP_LOOKBACK_HOURS = 24`, `:56`, `:742-746`, `:826`; `$select=id`, page cap `maxPagesPerMailbox` mặc định 10/cycle). Message cũ hơn 30 phút bị stale guard TASK-080 chặn (`SKIPPED_STALE`) → **không có nguy cơ relay stale message**; chỉ tốn một lượt enumeration + một số fetch-rồi-skip. | PROVEN (cơ chế) + INFERENCE (mức độ silence phụ thuộc loại quota) |

**Severity: MEDIUM.** Mailbox bị ảnh hưởng có thể mất relay (cả 2 đường, tùy loại quota) cho tới khi có can thiệp
ngoài repo (Exchange admin), nhưng: hệ thống bounded, có alert + health visibility, không data corruption, không ảnh
hưởng mailbox khác. Không CRITICAL vì root cause nằm ngoài hệ thống và hệ thống degrade đúng thiết kế. (INFERENCE
dựa trên các fact PROVEN ở trên.)

**Blast radius: per-mailbox.** (PROVEN — per-mailbox isolation + webhook/queue bounded.)

## §9. So sánh các error class (Kết quả — REPO EVIDENCE + OFFICIAL)

| Class | Provider semantics | Hành vi repo hiện tại | Có nên gom với ErrorQuotaExceeded? |
|---|---|---|---|
| A. Generic forbidden 403 (vd `ErrorAccessDenied`, `MailboxNotEnabledForRESTAPI`) | Thiếu quyền/cấu hình — persistent, cần can thiệp | `forbidden`: cursor reset (nếu có) + counter + cooldown 5→60m + alert; không reconnect | Hiện đang gom. Về retry-shape thì tương thích (đều persistent, cần Human); khác biệt duy nhất: cursor reset vô nghĩa với quota (§11) |
| B. ErrorQuotaExceeded (403) | Mailbox vượt quota/limit — persistent tới khi admin xử lý; không phải throttling; không Retry-After documented | Như class A (không có special-casing — PROVEN §4) | — |
| C. Authorization 403 thật | Grant/permission bị thu hồi ở tenant | Như class A | Tương thích về retry-shape; reconnect không giúp (đã chứng minh ở TASK-071) |
| D. Throttling/rate-limit (429, `ErrorServerBusy`) | Temporary, tự hết; Retry-After documented | Delta: `transient`, retry tick sau ~30s, **không đọc Retry-After** (`:301, :938-946`); worker-email: parse `retryAfterSeconds` nhưng chỉ log, BullMQ backoff riêng | **KHÔNG gom** — semantics provider khác hẳn (temporary vs persistent). Repo hiện đã tách đúng (429 ≠ 403) |
| E. 401 auth | Token/grant chết — cần reauth | `auth` → RECONNECT_REQUIRED (`:919-929`) | **KHÔNG gom** — reconnect giúp 401, không giúp quota |
| F. 410 SyncStateNotFound | Sync state bị provider hủy — retry cursor cũ vô ích | `syncStateLost` → same-cycle bounded recovery, replace-on-success (TASK-089) | **KHÔNG gom** — quota không phải sync-state error; đây chính là lý do cursor reset không có căn cứ cho quota |
| G. 429 | (= D) | (= D) | KHÔNG gom |

Kết luận: taxonomy hiện tại của repo **đã tách đúng** những class có provider semantics khác nhau (401/403/410/429/timeout).
Câu hỏi còn lại duy nhất là **trong nội bộ class 403**, quota có đáng một sub-treatment không → §11, §13.

## §10. Reconnect semantics review (Kết quả H)

- `ErrorQuotaExceeded` (đi theo 403) **không bao giờ**: mark `RECONNECT_REQUIRED`, thay đổi refresh-token flow, hay đổi
  `Mailbox.status` — PROVEN (§5 mục 8; `recordForbiddenBackoff` không đụng status; renewal 403→transient; email
  pipeline 403→`FAILED_GRAPH_FETCH` không flip).
- Provider evidence: không tài liệu nào nói reauth/reconnect giải quyết quota (§7) — quota là trạng thái mailbox,
  không phải trạng thái grant.

**Verdict: hành vi hiện tại ĐÚNG — không thêm reconnect behavior.** Thêm reconnect sẽ tái tạo chính reconnect-loop mà
TASK-071 đã diệt, không có provider evidence. (PROVEN cho hành vi hiện tại; SUPPORTED cho verdict.)

## §11. Cursor reset review — câu hỏi trọng tâm (Kết quả I)

Hành vi hiện tại: forbidden cycle đầu tiên còn cursor → reset cursor về null (§5 mục 2). Đánh giá cho ErrorQuotaExceeded:

- **A. Reset có ích?** Không có evidence nào — repo lẫn provider — cho thấy cursor gây ra hay duy trì quota error, hay
  reset giúp thoát nó. Giả thuyết "cursor độc" của TASK-071 nhắm root cause khác. (SUPPORTED cho "không có evidence";
  benefit thực tế: UNKNOWN, nhiều khả năng bằng không — INFERENCE.)
- **B. Không có tác dụng?** Nhiều khả năng đúng: sau reset, bootstrap request kế tiếp vẫn chạm Graph và vẫn 403 khi
  quota còn. (INFERENCE, consistent với observation staging: lỗi lặp lại qua nhiều window từ TASK-089 tới TASK-090.)
- **C. Gây bootstrap/recovery work không cần thiết?** Có, nhưng bounded: khi quota được xử lý, mailbox phải bootstrap
  lại từ lookback 24h ($select=id, page cap 10/cycle) thay vì tiếp tục cursor cũ; message >30 phút bị stale guard chặn
  nên chi phí là một lượt enumeration + một số fetch-rồi-skip. (PROVEN cơ chế + INFERENCE mức độ.)
- **D. Tăng load đúng lúc provider đang quota?** Không đáng kể trong lúc quota còn: bootstrap attempt đầu tiên đã 403
  ngay page đầu, không enumerate được gì; load chỉ tăng một lần tại thời điểm hồi phục (khi provider đã hết quota).
  (INFERENCE dựa trên cơ chế PROVEN.)
- **E. Provider documentation đủ để kết luận?** Đủ để nói "không có căn cứ reset" (quota ≠ sync-state; sync-state có
  410 riêng); không đủ để chứng minh reset **có hại nghiêm trọng**. (SUPPORTED)

**Verdict: cursor reset đối với ErrorQuotaExceeded là generic-403 side effect không có căn cứ riêng, nhưng tác hại
bounded và được che bởi webhook-primary + stale guard 30 phút + lookback 24h.** Nó không phải correctness bug; nó là
một lượng waste nhỏ, chỉ phát sinh một lần mỗi episode quota. Có đáng sửa hay không → §13 (so sánh option), vì mọi
cách "sửa" đều phải match error-code string — đi ngược nguyên tắc TASK-089 đã chốt: *classification theo HTTP status,
error code chỉ là diagnostics, casing không contractual* (comment tại `delta-polling.service.ts:296-300`).

## §12. Schema / migration verdict (Kết quả M — PROVEN, REPO EVIDENCE)

Existing fields trên `Mailbox` (`prisma/schema.prisma:123-126, 135-136`): `microsoftDeltaCursor`, `deltaLastPolledAt`,
`deltaLastErrorAt`, `deltaLastErrorMessage`, `deltaForbiddenCount`, `deltaForbiddenCooldownUntil`
(migrations `20260529000000_add_delta_polling_fields`, `20260608000000_task075_delta_forbidden_backoff`).

**Verdict: ĐỦ — không cần migration cho mọi option §13.** `deltaLastErrorMessage` đã mang `code=ErrorQuotaExceeded`
(observability); counter/cooldown đã persistent. Option B/C nếu được chọn cũng chỉ cần đọc diagnostics đã có in-memory
trong cycle, không cần cột mới. Không có persistent state mới nào được đề xuất.

## §13. Architecture options (Kết quả K, L)

| Tiêu chí | OPTION A — giữ generic 403 | OPTION B — code-aware: `ErrorQuotaExceeded` có dedicated bounded backoff, không reset cursor | OPTION C — honor Retry-After/provider hint, fallback bounded cooldown | OPTION D — minimal seam: giữ classification, chỉ gate cursor reset sau N cycle |
|---|---|---|---|---|
| Correctness | Đúng về retry-shape (persistent error → bounded backoff + alert = đã có). Chỉ mang side effect cursor reset không căn cứ | Đúng hơn về mặt lý thuyết, NHƯNG phải match string `error.code` — vi phạm nguyên tắc TASK-089 (code là diagnostics-only, casing không contractual); match sai/miss biến thể code → quay lại behavior A một cách im lặng | Không có evidence Retry-After xuất hiện với 403 quota (§7 UNKNOWN) → nhánh chính không bao giờ kích hoạt; chỉ còn fallback = A | Không cần match code string, nhưng thay đổi semantics self-heal TASK-071 cho **mọi** 403 → đụng invariant đã staging-validated |
| Request amplification | Bounded: ~1 req/giờ steady; một lượt bootstrap 24h mỗi episode | Giảm được một lượt bootstrap mỗi episode (tiết kiệm nhỏ) | Như A | Như B nhưng cho mọi 403 |
| Relay continuity | Không đổi (webhook primary không bị cooldown chặn) | Không đổi | Không đổi | Không đổi |
| Complexity | 0 | Thêm code-string matching + nhánh riêng + tests; taxonomy mới trong classifier vốn status-based | Thêm header parsing trên delta path + scheduling honor | Sửa điều kiện reset trong `handlePersistentForbidden` + re-verify TASK-071 self-heal không chết |
| Migration | Không | Không | Không | Không |
| Observability | Đã đủ (diagnostics mang code; alert mang diagnostics) | Thêm được nhãn riêng trong alert (giá trị thấp — diagnostics đã hiển thị code) | Không đổi | Không đổi |
| Regression risk 071/075/089 | **0** — không đổi gì | MEDIUM: nhánh mới trong đường 403 đã staging-validated; nguy cơ phá self-heal TASK-071 nếu quota code xuất hiện trong scenario cursor-độc | LOW-MEDIUM: touch fetch path chung | HIGH hơn B về mặt semantics: đổi hành vi mọi 403, kể cả class mà self-heal TASK-071 được thiết kế cho |

**RECOMMENDED: OPTION A — NO CHANGE (code).** Căn cứ:

1. Mọi thuộc tính quan trọng đã đúng và PROVEN: bounded backoff, không tight loop, không reconnect, per-mailbox isolation,
   alert + health visibility, clear-on-success, không stale relay sau recovery.
2. Khiếm khuyết duy nhất tìm thấy (cursor reset không căn cứ cho quota) có tác hại bounded, một lần mỗi episode, được
   che bởi ba lớp sẵn có (webhook primary, stale guard 30m, bootstrap lookback 24h) — trong khi mọi option sửa nó đều
   mang regression risk thật lên đường 403 đã staging-validated, hoặc vi phạm nguyên tắc status-based classification.
3. Root cause nằm ngoài repo: resolution theo Microsoft là hành động của Human/Exchange admin trên mailbox
   (kiểm tra storage quota / folder item limit / license). Không code change nào trong repo giải quyết được quota.
4. TASK-075 đã ghi rõ constants "có thể tinh chỉnh sau khi quan sát live" — observation hiện tại chưa cho thấy constants sai.

Hành động đề xuất kèm Option A (không phải code): Human kiểm tra quota của mailbox bị ảnh hưởng phía M365/Exchange admin
(storage, folder item count, Recoverable Items, license) — đây là bước duy nhất thực sự giải quyết episode hiện tại.

Điều kiện tái xem xét (ghi lại làm trigger cho task tương lai, không phải Phase 2 mặc định): nếu live evidence sau này
cho thấy (a) Graph đính kèm Retry-After với 403 quota (khi đó Option C có căn cứ), hoặc (b) bootstrap-sau-recovery gây
chi phí đáng kể đo được, hoặc (c) alert bị nhiễu vì quota episodes lặp — thì cân nhắc Option B với guard chặt.

## §14. Service impact (Kết quả N — PROVEN)

| Service | Impact nếu Phase 2 = Option A (recommended) | Impact nếu Option B/C được chọn thay |
|---|---|---|
| worker-delta | Không đổi | Chỉ service này đổi (`delta-polling.service.ts` ± runner) |
| worker-email | Không đổi | Không đổi |
| web | Không đổi | Không đổi (trừ khi Human yêu cầu surface cooldown fields trong health UI — deferred, §17) |
| worker-renewal | Không đổi | Không đổi |

Railway source vẫn dedicated staging; Phase 1 không thao tác Railway.

## §15. Phase 2 test matrix — DESIGN ONLY (Kết quả O)

Chỉ áp dụng **nếu** Antigravity review quyết định làm code change (Option B/C/D). Nếu Option A được chấp thuận,
Phase 2 không có code change và matrix này lưu làm reference. Không viết test nào ở Phase 1.

| # | Case | Expected |
|---|---|---|
| 1 | Generic 403 (code khác quota), có cursor | Behavior TASK-071/075 nguyên trạng: reset cursor, counter++, cooldown từ count 3, alert |
| 2 | 403 `code=ErrorQuotaExceeded`, có cursor | Theo option được chọn (B: không reset cursor, dedicated backoff; A: như case 1) |
| 3 | 403 quota lúc bootstrap (cursor null) | Không reset, counter++, không crash |
| 4 | Retry-After xuất hiện trên 403 (nếu Option C) | Honor có trần (cap ≤ FORBIDDEN_BACKOFF_MAX_MS); thiếu header → fallback cooldown hiện tại |
| 5 | Cooldown progression | count 3→5m, 4→10m, 5→20m, 6→40m, ≥7→60m cap; persist đúng cột |
| 6 | No tight loop | Mailbox trong cooldown bị skip trước bước token; `cooldownSkippedMailboxCount` đúng; không Graph call |
| 7 | No cursor reset (nếu option yêu cầu) | Sau N cycle quota, `microsoftDeltaCursor` giữ nguyên giá trị cũ |
| 8 | Real authorization 403 regression | `ErrorAccessDenied` vẫn đi full path TASK-071/075 (reset + cooldown + alert), không bị nhánh quota nuốt |
| 9 | 401 regression | Vẫn RECONNECT_REQUIRED; không lẫn vào forbidden path |
| 10 | 410 TASK-089 regression | `syncStateLost` recovery nguyên trạng; forbidden counter không tăng vì 410 |
| 11 | Timeout TASK-080 regression | `GRAPH_TIMEOUT` → transient, không tăng forbidden counter, không cooldown |
| 12 | Stale relay regression | Sau recovery (quota hết, bootstrap/cursor tiếp tục), message >30m bị `SKIPPED_STALE`, không gửi Telegram |
| 13 | Mailbox isolation | Mailbox A quota-403 liên tục; mailbox B cùng cycle vẫn poll/relay bình thường |
| 14 | Health visibility | `deltaLastErrorMessage` mang `code=ErrorQuotaExceeded`; mailbox WARNING; check DELTA_POLLING tổng không FAIL vì một mailbox |
| 15 | Successful recovery clears state | Poll thành công → `deltaForbiddenCount=0`, cooldown null, error metadata null; alert không bắn lại |
| 16 | Alert semantics | Vào cooldown → đúng 1 alert WARNING với diagnostics enum-code, email masked; alert failure không throw vào cycle |

## §16. Security

- Docs này không chứa: token/secret, connection URL, verification code, email body, email address thật, Graph request
  id thật, tên nhánh Git đầy đủ.
- Diagnostics được trích dẫn ở dạng format mẫu (`code=ErrorQuotaExceeded reqId=...`), không copy giá trị thật.
- Phase 1 không gọi Microsoft Graph thật, không đọc `.env*`, không thao tác production.

## §17. Open decisions & deferred findings (Kết quả P)

**Open decisions cho Antigravity/Human:**

- **OD-1:** Chấp thuận Option A (NO CHANGE) hay yêu cầu Option B với guard? (Khuyến nghị: A — §13.)
- **OD-2:** Human kiểm tra quota mailbox bị ảnh hưởng phía M365/Exchange admin (ngoài repo) — bước duy nhất giải quyết
  episode hiện tại.

**Deferred findings (existing, ngoài scope TASK-091 — không tự gán task number, Human/ChatGPT quyết định):**

- **DF-91-1 (LOW):** Delta path không đọc `Retry-After` cho 429 (429→transient, retry tick ~30s). Đúng chuẩn Graph
  throttling guidance thì nên honor — nhưng là behavior có từ TASK-071, không liên quan quota. (REPO EVIDENCE
  `delta-polling.service.ts:301, 938-946`.)
- **DF-91-2 (LOW):** `getMessageById` của worker-email không có HTTP timeout (TASK-080 chỉ scope delta path; network
  error đã được classify). (REPO EVIDENCE `graph-mail.service.ts:245-253`, `email-worker-runner.ts:287-291`.)
- **DF-91-3 (LOW, observability):** Health service không đọc/hiển thị `deltaForbiddenCount`/`deltaForbiddenCooldownUntil`;
  operator chỉ suy ra từ `lastErrorShort` + reason stale. (REPO EVIDENCE `health.service.ts:531-533`.)

## §18. Acceptance criteria Phase 1

- [x] Precheck PASS (đúng nhánh task, tree sạch, HEAD chứa TASK-090).
- [x] Exact source path của observation được PROVEN bằng REPO EVIDENCE (delta polling, không phải worker-email).
- [x] Current 403/cursor/cooldown/alert semantics trace đủ với file:line.
- [x] Official Microsoft semantics phân biệt rõ OFFICIAL / SUPPORTED / INFERENCE / UNKNOWN; không invent.
- [x] Impact + severity + blast radius có evidence.
- [x] So sánh đủ 7 error class; verdict reconnect/cursor-reset/backoff đều có căn cứ.
- [x] ≥4 architecture options so sánh; recommendation kèm điều kiện tái xem xét.
- [x] Schema verdict: không migration.
- [x] Test matrix Phase 2 design-only.
- [x] Chỉ tạo đúng 2 docs ở Phase 1; close-out chỉ sync task/report/ROADMAP; không commit/push.
- [x] Antigravity Architecture Review PASS.
- [x] OD-1 đã quyết định: Option A — NO CODE CHANGE (approved). OD-2 chuyển thành operational follow-up ngoài repo (§19).

## §19. Close-out (FINAL)

- **Investigation hoàn tất.** Antigravity Architecture Review kết luận **PASS — TASK-091 ARCHITECTURE APPROVED**.
- **Quyết định khóa: OPTION A — NO CODE CHANGE.** Không có Phase 2 implementation; không migration/schema/runtime/test
  change; không service runtime nào cần sửa.
- **Semantics giữ nguyên:** HTTP 403 tiếp tục được phân loại generic `forbidden` theo status (TASK-071/TASK-075);
  không bị nhầm 401/auth; không mark `RECONNECT_REQUIRED`.
- **Bản chất lỗi:** `ErrorQuotaExceeded` là external mailbox quota/resource condition phía Exchange —
  **không phải reconnect condition**; nguồn observation là worker-delta.
- **Cursor reset:** có thể gây một lượt bootstrap enumeration sau recovery — bounded inefficiency, **không phải
  correctness bug**, không gây duplicate relay (TASK-080 stale guard tiếp tục bảo vệ old messages sau recovery).
- **Backoff hiện tại: ADEQUATE** — threshold 3, exponential cooldown, cap 60 phút; blast radius **per-mailbox**;
  không unbounded request amplification.
- **Human operational follow-up (ngoài repo):** kiểm tra quota/storage/item-limit/licensing phù hợp trong
  Microsoft 365 / Exchange Admin Center cho mailbox bị ảnh hưởng.
- **Điều kiện mở task mới:** chỉ khi provider behavior hoặc operational evidence sau này thay đổi (§13);
  không special-case hiện tại.

---

```text
TASK-091 CLOSED — INVESTIGATION-ONLY. OPTION A (NO CODE CHANGE) APPROVED. NO PHASE 2 IMPLEMENTATION.
```
