# TASK-091 — Microsoft Graph 403 ErrorQuotaExceeded Investigation & Mailbox Recovery Semantics (Final Report)

> **TRẠNG THÁI: TASK-091 COMPLETED — INVESTIGATION-ONLY CLOSE-OUT.**
> **Antigravity Architecture Review: PASS — TASK-091 ARCHITECTURE APPROVED. Quyết định khóa: OPTION A — NO CODE CHANGE.**
> Không có Phase 2 implementation. Không sửa runtime code, không schema/migration, không tests, không commit/push,
> không thao tác Railway/production, không gọi Microsoft Graph thật. Close-out sync task/report/ROADMAP (mục 10).
> Chi tiết đầy đủ (trace file:line, provider evidence, bảng so sánh option, test matrix) nằm ở
> `docs/tasks/TASK-091-graph-errorquotaexceeded-recovery.md` — không chép lại dài.
>
> Sanitized. Không chứa secret/URL kết nối/token/full verification code/full email body/email address thật/tên nhánh
> Git đầy đủ.

---

## 1. Mục tiêu & precheck

Điều tra observation staging (tồn tại từ TASK-089, phân loại EXISTING/INDEPENDENT): một mailbox gặp
`HTTP 403 code=ErrorQuotaExceeded` lặp lại. Xác minh liệu error code này nên dùng nguyên semantics 403 hiện tại
(TASK-071/075) hay cần treatment riêng.

Precheck PASS: đúng nhánh làm việc của task hiện tại, working tree sạch, HEAD `629bc95` chứa TASK-090 completed.

## 2. Kết quả điều tra chính (A–J theo đề bài)

- **A. Exact source path (PROVEN):** worker-delta → `fetchDeltaPage` gọi
  `GET /v1.0/me/mailFolders('inbox')/messages/delta` → `classifyHttpStatus(403)` → kind `forbidden` →
  `handlePersistentForbidden` (`services/microsoft/delta-polling.service.ts`). `ErrorQuotaExceeded` chỉ là diagnostics
  (`error.code`) đi kèm; **không có code nào trong repo match chuỗi này** (grep toàn repo: chỉ xuất hiện trong docs).
  Format message trên health banner (`GRAPH_REQUEST_FAILED (http=403) code=...`) chỉ được sinh bởi delta path ⇒
  observation đến từ delta polling, không phải worker-email.
- **B. Current 403 behavior (PROVEN):** classify `forbidden` (không bao giờ `auth`); counter `deltaForbiddenCount`++;
  từ count 3 set cooldown; alert Telegram `DELTA_POLLING_FAILED` WARNING; clear toàn bộ khi có một poll thành công;
  tuyệt đối không `RECONNECT_REQUIRED`; per-mailbox isolation (mailbox khác không bị block).
- **C. Current cursor behavior (PROVEN):** forbidden cycle đầu tiên còn cursor → reset `microsoftDeltaCursor` về null
  (self-heal TASK-071); 403 lúc bootstrap không reset. `ErrorQuotaExceeded` **có** bị reset cursor — thuần túy vì
  generic-403 semantics, không phải quyết định riêng cho quota; không có evidence nào cho thấy reset giúp quota error.
- **D. Cooldown/backoff (PROVEN):** threshold 3, base 5 phút, nhân đôi mỗi cycle forbidden liên tiếp, cap 60 phút;
  persist DB (`deltaForbiddenCount`, `deltaForbiddenCooldownUntil`) — bền qua restart; mailbox trong cooldown bị skip
  hoàn toàn trước cả bước token. Steady state khi lỗi kéo dài: ~1 request/giờ/mailbox — không tight loop.
- **E. Official Microsoft semantics (OFFICIAL + SUPPORTED):** `ErrorQuotaExceeded` = quota/limit của mailbox bị vượt
  (EWS ResponseCodeType: "Indicates that the user's quota has been exceeded"; KB 4556585: Exchange chặn thao tác vì
  quota, ví dụ storage; Microsoft Q&A: đường sync/read còn dính folder item limit ~1M items). **Persistent** cho tới
  khi user/admin xử lý — không phải throttling, không thuộc Retry-After guidance (Retry-After là chuyện 429/503).
  Không tài liệu nào nói reauth/reconnect hay reset sync-state giúp ích. Loại quota chính xác của mailbox staging:
  UNKNOWN — cần Human kiểm tra phía M365/Exchange admin.
- **F. Relay-loss / request-amplification (PROVEN cơ chế):** webhook path không đọc cooldown/status → vẫn hoạt động
  (trừ khi quota chặn cả đường read — UNKNOWN cho instance); delta backup mất cho mailbox đó; amplification bounded
  (cooldown cap 60m; một lượt bootstrap lookback 24h mỗi episode khi hồi phục); không stale relay sau recovery
  (stale guard 30 phút chặn).
- **G. Severity/blast radius:** **MEDIUM / per-mailbox** (INFERENCE trên fact PROVEN — mailbox có thể mất relay tới khi
  Human xử lý quota, nhưng hệ thống bounded, có alert + health visibility, không ảnh hưởng mailbox khác).
- **H. Reconnect verdict:** hiện tại 403 không bao giờ reconnect — **ĐÚNG, giữ nguyên**; không có provider evidence
  reconnect giúp quota; thêm reconnect sẽ tái tạo loop TASK-071 đã diệt. (PROVEN hành vi / SUPPORTED verdict)
- **I. Cursor-reset verdict:** reset cursor với ErrorQuotaExceeded là side effect generic không có căn cứ riêng, nhưng
  tác hại bounded (một lượt bootstrap 24h mỗi episode, che bởi webhook-primary + stale guard). Không phải correctness
  bug. Mọi cách sửa đều phải match error-code string — đi ngược nguyên tắc TASK-089 (classification theo HTTP status,
  error code là diagnostics-only). (SUPPORTED)
- **J. Backoff verdict:** **ADEQUATE** cho ErrorQuotaExceeded (SUPPORTED) — bounded, phù hợp bản chất persistent của
  lỗi, đã được staging observation TASK-089 xác nhận hoạt động đúng thiết kế.

## 3. Architecture options & recommendation (K, L)

So sánh 4 option (bảng đầy đủ ở task doc §13): A giữ nguyên; B code-aware cho `ErrorQuotaExceeded` (không reset cursor,
dedicated backoff); C honor Retry-After với fallback; D gate cursor reset cho mọi 403.

**RECOMMENDED: OPTION A — NO CODE CHANGE.** Lý do: mọi thuộc tính quan trọng đã đúng và PROVEN (bounded backoff, không
tight loop, không reconnect, isolation, alert, clear-on-success, không stale relay); khiếm khuyết duy nhất (cursor
reset không căn cứ) có tác hại nhỏ và bounded, trong khi mọi option sửa đều mang regression risk thật lên đường 403 đã
staging-validated hoặc vi phạm nguyên tắc status-based classification; và root cause nằm ngoài repo — resolution theo
Microsoft là hành động Human/Exchange admin trên mailbox (kiểm tra storage quota / folder item limit / license).

Điều kiện tái xem xét (trigger cho tương lai, không phải Phase 2 mặc định): Graph thực tế đính kèm Retry-After với 403
quota; hoặc bootstrap-sau-recovery gây chi phí đo được; hoặc alert nhiễu vì quota episodes lặp.

## 4. Schema / service impact / test matrix (M, N, O)

- **Schema:** existing fields (`deltaForbiddenCount`, `deltaForbiddenCooldownUntil`, `deltaLastError*`,
  `microsoftDeltaCursor`) **ĐỦ — không migration** cho mọi option. (PROVEN)
- **Service impact:** Option A → không service nào đổi. Nếu Human chọn B/C → chỉ worker-delta
  (`delta-polling.service.ts` ± runner); web/worker-email/worker-renewal không đổi.
- **Test matrix Phase 2:** 16 case đã design-only ở task doc §15 (generic 403, quota 403, Retry-After, cooldown
  progression, no tight loop, no cursor reset, regression 401/410/timeout/stale/isolation/health, clear-on-success,
  alert semantics). Không viết test nào ở Phase 1.

## 5. Deferred findings (P)

Existing, ngoài scope, không tự gán task number (Human/ChatGPT quyết định):
- DF-91-1 (LOW): delta path không honor `Retry-After` cho 429 (behavior từ TASK-071).
- DF-91-2 (LOW): `getMessageById` worker-email không có HTTP timeout (TASK-080 chỉ scope delta).
- DF-91-3 (LOW): health không surface `deltaForbiddenCount`/`deltaForbiddenCooldownUntil` — operator chỉ thấy
  `lastErrorShort`.

## 6. File đã thay đổi

| File | Thay đổi |
|---|---|
| `docs/tasks/TASK-091-graph-errorquotaexceeded-recovery.md` | Tạo mới (Phase 1 §1–§18) + close-out §19 sau Architecture Review PASS |
| `docs/reports/TASK-091-graph-errorquotaexceeded-recovery.md` | Tạo mới — report này; cập nhật final close-out (mục 10) |
| `docs/ROADMAP.md` | Thêm dòng TASK-091 completed (investigation-only) |

Không file nào khác thay đổi. Không commit, không push.

## 7. Lệnh đã chạy & kết quả

- Precheck: `git branch --show-current`, `git status --short`, `git diff --stat`, `git log -1 --oneline` — PASS (§1).
- Close-out: precheck lặp lại — PASS (working tree chỉ có 2 docs TASK-091 untracked, không runtime/schema/test change).
- `npm run verify` — **PASS** (exit 0, **109 test files / 1344 passed / 1344 tests**, lint + typecheck + build sạch;
  docs-only change, baseline không đổi so với TASK-090).
- `git diff --check` — sạch (không whitespace error).
- `git status --short` / `git diff --stat` — xác nhận chỉ đúng 3 docs thay đổi (task/report TASK-091 + ROADMAP).

## 8. Bảo mật

Docs không chứa secret/token/connection URL/verification code/email body/email address thật/Graph request id thật/tên
nhánh Git đầy đủ. Không đọc `.env*`. Không gọi Graph thật. Không thao tác production/Railway.

## 9. Kết quả Antigravity review

**Antigravity Architecture Review: PASS — TASK-091 ARCHITECTURE APPROVED.**

- **OD-1 đã quyết định: OPTION A — NO CODE CHANGE (approved).** Không có Phase 2 implementation.
- Review xác nhận: 403 phân loại generic forbidden theo status là đúng (không nhầm 401/auth, không
  `RECONNECT_REQUIRED`); generic TASK-071/TASK-075 403 handling giữ nguyên; cursor reset là bounded inefficiency,
  không phải correctness bug, không duplicate relay; backoff hiện tại ADEQUATE (threshold 3, exponential cooldown,
  cap 60 phút); blast radius per-mailbox, không unbounded amplification; TASK-080 stale guard bảo vệ old messages
  sau recovery; không cần schema/migration; không service runtime nào cần code change.
- **OD-2 → operational follow-up (Human, ngoài repo):** kiểm tra quota/storage/item-limit/licensing trong
  Microsoft 365 / Exchange Admin Center cho mailbox bị ảnh hưởng — Microsoft quota/resource problem cần
  Human/M365 Admin xử lý bên ngoài repo.

## 10. Close-out (FINAL)

- TASK-091 đóng ở dạng **investigation-only completed**: Phase 1 investigation là toàn bộ deliverable; không có
  Phase 2 implementation; không migration/schema/runtime/test change; current 403 semantics giữ nguyên.
- `ErrorQuotaExceeded` được kết luận là **external per-mailbox Exchange quota/resource condition** — không phải
  reconnect condition; resolution nằm ngoài repo (operator/M365 admin).
- ROADMAP đã thêm dòng TASK-091 completed (investigation-only) kèm remaining note: nếu provider behavior hoặc
  operational evidence sau này thay đổi thì mở task mới; không special-case hiện tại.
- Không commit/push; không thao tác Railway/staging/production.

---

```text
READY FOR ANTIGRAVITY TASK-091 CLOSE-OUT REVIEW — NO COMMIT / NO PUSH
```
