# TASK-071 — Delta polling 403 classification and reconnect loop hardening

## Mục tiêu

Chấm dứt vòng lặp reconnect cho mailbox mà **refresh token vẫn khỏe** nhưng
Graph **delta data request trả HTTP 403**. Hiện delta polling phân loại 403 quá
nặng thành `RECONNECT_REQUIRED`, khiến mailbox bị "token issue" sai bản chất:
reconnect xong vài phút lại rơi lại đúng trạng thái cũ.

## Bối cảnh / root cause (từ điều tra log staging, đã sanitize)

Mailbox ví dụ: `lila8rhjean@hotmail.com` (mailboxId `cmq1x2y2l00chn3j5r0lyicng`).

- Mẫu lặp lại mỗi lần reconnect: `Persisted rotated Microsoft refresh token`
  (refresh **thành công**, có rotate) → ~2–4 giây sau `Delta polling failed for
  mailbox … DeltaPollingHttpError` (delta **403**).
- Toàn fleet 24h chỉ ~14 lỗi delta, gần như **đều của một mailbox này**; các
  mailbox khác `cursorAdvanced: true` bình thường → **lỗi riêng mailbox**, không
  app-wide.
- `Last error` hiển thị: `GRAPH_REQUEST_FAILED (http=403)` — đúng format của
  `delta-polling.service.ts` (`safeErrorMessage`).

Nguyên nhân code:

1. `services/microsoft/delta-polling.service.ts` — `classifyHttpStatus` gộp
   `401 || 403 → 'auth'`, và catch ngoài `runDeltaPollingOnce` mark
   `RECONNECT_REQUIRED` cho mọi `kind === 'auth'`. ⇒ một 403 trên **data
   request** (không phải lỗi token) cũng bị kết án là grant chết.
2. `services/microsoft/mailbox-connect.service.ts` (reconnect) **không** reset
   `microsoftDeltaCursor`, và **không có** code path nào reset cursor khi lỗi.
   Nếu cursor đang lưu bị "độc" (gây 403), reconnect → ACTIVE → cycle sau **tái
   dùng đúng cursor độc** → 403 → reconnect lại. Đây là cơ chế của vòng lặp.
3. Bất nhất giữa worker: `subscription-renewal.service.ts` (`classifyRenewError`)
   cũng map `permission` (403) → `reconnect_required`. Email worker
   (`graph-message-pipeline.service.ts`) thì **không** mark trên 403 (chỉ 401)
   → đã đúng, dùng làm chuẩn để đồng bộ.

> Lưu ý: đường **refresh token thật** (`refresh-token-failure.ts`,
> `invalid_grant` / `interaction_required` từ token endpoint) vẫn đúng và
> **không đổi** — vẫn mark reconnect ngay khi grant thật sự chết.

## Scope được làm

1. **Phân loại 403 đúng trong delta polling**
   - Tách `401 → 'auth'` và `403 → 'forbidden'` trong `classifyHttpStatus`.
   - 403 trên data request **không** mark `RECONNECT_REQUIRED`; chỉ ghi lỗi +
     đếm `failedMailboxCount`, retry cycle sau.
   - 401 giữ nguyên hành vi cũ (token bị từ chối → reconnect).
2. **Self-heal cursor an toàn (rule trong code, có test)**
   - Khi 403 xảy ra mà mailbox **đang có cursor** (`microsoftDeltaCursor != null`)
     → `resetDeltaCursor` (đặt cursor = null) để cycle sau **bootstrap lại**.
   - 403 lúc bootstrap (cursor null) → không có gì để reset, để retry.
   - **Không** reset cursor thủ công trên production DB trong task này.
3. **Sanitized Graph error metadata**
   - Đọc `error.code`, `error.innerError.code` và header `request-id` từ response
     lỗi, gắn vào message ghi DB/log dạng `code=… inner=… reqId=…`.
   - **Không** log/đọc token, refresh token, client secret, bot token, DB URL,
     Redis URL, full email body, verification code, hay `error.message` (có thể
     lộ địa chỉ/UPN).
4. **Đồng bộ 401/403 giữa worker (tối thiểu)**
   - `subscription-renewal.service.ts`: `permission` (403) → `transient` (không
     còn reconnect), khớp delta + email.
   - Email worker đã đúng (403 không mark) → **không sửa**.

## Scope KHÔNG làm

- Không đổi refresh/token lifecycle (`refresh-access-token.service.ts`,
  `refresh-token-failure.ts`) — đang khỏe.
- Không tạo migration / đổi schema (`microsoftDeltaCursor` đã tồn tại).
- Không đổi routing, Telegram mapping, dedup, queue throughput/throttle.
- Không đụng OAuth/reconnect UX (TASK-069B), secret scan, `.env*`.
- Không probe Graph thật, không redeem token, không đọc/sửa production DB,
  không reset cursor thủ công trên production.
- Không refactor lớn; chỉ sửa tối thiểu để chặn vòng lặp.

## Đánh đổi đã cân nhắc

- Reset cursor khi 403-có-cursor có thể tạo khoảng trống nhỏ (bootstrap mới
  không enqueue mail cũ). Chấp nhận được vì: (a) webhook là đường **primary**,
  delta chỉ là backup; (b) một cursor đang 403 vốn **không** relay được gì, nên
  bootstrap lại là cải thiện rõ ràng so với kẹt mãi.

## Tests

- `tests/unit/microsoft/delta-polling.service.test.ts`
  - 403 trên data request **không** mark reconnect; vẫn ghi lỗi + đếm failed.
  - 403 khi **có cursor** → gọi `resetDeltaCursor`.
  - 403 khi **bootstrap** (cursor null) → **không** reset, **không** reconnect.
  - Ghi lại `code` / `inner` / `reqId` đã sanitize từ body lỗi Graph.
  - Giữ test 401 → reconnect.
- `tests/unit/microsoft/subscription-renewal.service.test.ts`
  - `permission` (403) → `transient`; `auth` (401) → `reconnect_required`.

## Lệnh kiểm tra

```bash
npm run verify
```

## Tiêu chí nghiệm thu

- 403 trên Graph data/management request **không** còn tự đẩy mailbox sang
  `RECONNECT_REQUIRED` ở delta polling và subscription renewal.
- Cursor độc tự được reset để bootstrap lại (delta), không cần can thiệp thủ công.
- `deltaLastErrorMessage` chứa `error.code` / `innerError.code` / `request-id`
  đã sanitize để chẩn đoán; không lộ dữ liệu nhạy cảm.
- `npm run verify` PASS.
