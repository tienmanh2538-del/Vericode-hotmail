# TASK-071 — Report: Delta polling 403 classification and reconnect loop hardening

## 1. Vấn đề (từ điều tra log staging, đã sanitize)

Mailbox `lila8rhjean@hotmail.com` (mailboxId `cmq1x2y2l00chn3j5r0lyicng`) rơi vào
vòng lặp: reconnect xong vài phút lại `RECONNECT_REQUIRED` / readiness
`TOKEN_ISSUE`, last error `GRAPH_REQUEST_FAILED (http=403)`.

Bằng chứng log lặp lại mỗi lần reconnect:
`Persisted rotated Microsoft refresh token` (refresh **thành công + rotate**) →
~2–4 giây sau `Delta polling failed for mailbox … DeltaPollingHttpError` (delta
**403**). Toàn fleet 24h chỉ ~14 lỗi delta, **gần như đều của một mailbox này**;
các mailbox khác `cursorAdvanced: true` bình thường → **lỗi riêng mailbox**, không
app-wide; và **không** phải lỗi token (refresh khỏe).

## 2. Root cause code-level

1. `delta-polling.service.ts`: `classifyHttpStatus` gộp `401 || 403 → 'auth'`,
   catch ngoài mark `RECONNECT_REQUIRED` cho mọi `kind === 'auth'` → một 403 trên
   **data request** (không phải token) cũng bị kết án grant chết.
2. `mailbox-connect.service.ts` (reconnect) không reset `microsoftDeltaCursor`, và
   không code path nào reset cursor khi lỗi → nếu cursor lưu bị "độc" gây 403,
   reconnect → ACTIVE → cycle sau tái dùng đúng cursor độc → 403 → reconnect lại
   (cơ chế vòng lặp).
3. `subscription-renewal.service.ts` (`classifyRenewError`) cũng map `permission`
   (403) → `reconnect_required` (cùng lỗi, còn tiềm ẩn). Email worker đã đúng
   (403 không mark) → dùng làm chuẩn.

## 3. Đã thay đổi gì

**Runtime**
- `services/microsoft/delta-polling.service.ts`:
  - `classifyHttpStatus`: `401 → 'auth'`, **`403 → 'forbidden'`** (kind mới),
    429/5xx → transient, còn lại unknown.
  - Catch ngoài `runDeltaPollingOnce`: `auth` (401) vẫn mark reconnect như cũ;
    **`forbidden` (403) KHÔNG mark reconnect**. Nếu 403 mà mailbox **đang có
    cursor** → `resetDeltaCursor` (self-heal, cycle sau bootstrap lại); 403 lúc
    bootstrap (cursor null) → không reset, chỉ retry.
  - Thêm `readGraphErrorDiagnostics`: trích `error.code`, `error.innerError.code`
    và header `request-id` (sanitized) — **không** đọc `error.message`/token.
    `safeErrorMessage` nối thêm `code=… inner=… reqId=…` (giữ prefix
    `GRAPH_REQUEST_FAILED (http=…)`).
  - `DeltaPollingMailboxRepo` thêm `resetDeltaCursor(mailboxId)` + helper
    `safelyResetDeltaCursor`.
- `services/queue/workers/delta-polling-runner.ts`: triển khai `resetDeltaCursor`
  trong Prisma repo (`update { microsoftDeltaCursor: null }`, chỉ cột cursor).
- `services/microsoft/subscription-renewal.service.ts`: `classifyRenewError` tách
  `auth` (401) → `reconnect_required` và **`permission` (403) → `transient`**.

**Tests**
- `tests/unit/microsoft/delta-polling.service.test.ts`: thêm 4 test (403 không
  reconnect; 403 có cursor → reset; 403 bootstrap → không reset/không reconnect;
  ghi `code`/`inner`/`reqId` sanitized, không lộ `error.message`); cập nhật fake
  repo + inline repo + e2e repo thêm `resetDeltaCursor`. Giữ test 401 → reconnect.
- `tests/unit/microsoft/subscription-renewal.service.test.ts`: tách 401→reconnect,
  403→transient.
- `tests/e2e/microsoft-test-mailbox.spec.ts`: repo stub thêm `resetDeltaCursor`.

**Docs**
- `docs/tasks/TASK-071-...md`, `docs/reports/TASK-071-...md`, `docs/ROADMAP.md`.

## 4. File đã thay đổi

- `services/microsoft/delta-polling.service.ts`
- `services/queue/workers/delta-polling-runner.ts`
- `services/microsoft/subscription-renewal.service.ts`
- `tests/unit/microsoft/delta-polling.service.test.ts`
- `tests/unit/microsoft/subscription-renewal.service.test.ts`
- `tests/e2e/microsoft-test-mailbox.spec.ts`
- `docs/tasks/TASK-071-delta-polling-403-reconnect-loop-hardening.md`
- `docs/reports/TASK-071-delta-polling-403-reconnect-loop-hardening.md`
- `docs/ROADMAP.md`

## 5. Lệnh đã chạy & kết quả

`npm run verify` → **PASS**: db:generate ✓, lint sạch, typecheck sạch,
**1065 tests passed**, build production thành công.

## 6. Bảo mật

- Không probe Graph thật, không redeem token, không đọc/sửa production DB, không
  reset cursor thủ công production, không sửa `.env*`.
- Diagnostics chỉ gồm enum code + request-id (GUID mờ); **không** log/ghi token,
  refresh token, client secret, bot token, DB/Redis URL, full email body,
  verification code, hay `error.message` của Graph. Có test khẳng định message
  không chứa `error.message`/UPN.

## 7. Rủi ro / đánh đổi còn lại

- Reset cursor khi 403-có-cursor tạo khoảng trống nhỏ (bootstrap mới không
  enqueue mail cũ). Chấp nhận được: webhook là đường **primary**, delta chỉ là
  backup; cursor đang 403 vốn không relay được gì nên bootstrap lại là cải thiện.
- 403 ở account/endpoint-level thật (không phải cursor) sẽ tự reset → bootstrap →
  vẫn 403 và được ghi lại với diagnostics; lúc đó cần ops xử lý (ngoài scope code).
- Chưa xác minh live (theo yêu cầu: không chạm production). `error.code`/
  `innerError.code` thật sẽ xuất hiện trong `deltaLastErrorMessage` ở lần fail kế
  tiếp nhờ logging mới, không cần probe thủ công.

## 8. Cần Gemini review phần nào

- Logic catch mới trong `runDeltaPollingOnce`: đúng phân nhánh `auth` vs
  `forbidden`, điều kiện reset cursor (`microsoftDeltaCursor !== null`).
- `readGraphErrorDiagnostics`: đảm bảo không rò rỉ `error.message`/token, an toàn
  với body non-JSON.
- Đồng bộ `classifyRenewError` (403 → transient) có gây hồi quy renewal không.
- Đánh đổi reset-cursor vs khả năng bỏ sót message (so với webhook primary).
