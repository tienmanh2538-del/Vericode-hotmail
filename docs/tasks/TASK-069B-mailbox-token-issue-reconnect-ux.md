# TASK-069B — Mailbox Token Issue Diagnosis & Reconnect UX

## Mục tiêu

Khi một mailbox rơi vào trạng thái cần reconnect (`RECONNECT_REQUIRED`, readiness
`TOKEN_ISSUE`), trang mailbox detail phải nói đúng sự thật và cho phép operator
reconnect an toàn — thay vì hiển thị tick xanh "Mailbox đã connect" gây hiểu nhầm
và không có nút reconnect.

## Bối cảnh / root cause (code-level)

- `MailboxStatus` có các giá trị: `ACTIVE`, `RECONNECT_REQUIRED`,
  `SUBSCRIPTION_EXPIRED`, `WEBHOOK_FAILED`, `DISABLED`, `ERROR`
  (`prisma/schema.prisma`).
- Status `RECONNECT_REQUIRED` được đặt bởi ba worker — subscription renewal,
  delta polling, email worker — qua hàm `markReconnectRequired`, khi
  `refreshMicrosoftAccessToken` trả lỗi token endpoint với mã
  `invalid_grant` / `interaction_required` (refresh grant bị thu hồi hoặc cần
  đăng nhập lại). Đây là **điều kiện code duy nhất** tạo ra "token issue /
  cần reconnect". Không suy luận nguyên nhân từ secret/env.
- `deriveMailboxReadiness` (shared, `lib/mailboxes/mailbox-list-filter.ts`) đã
  map `RECONNECT_REQUIRED → TOKEN_ISSUE` đúng. Vấn đề nằm ở UI.
- Trang `app/admin/mailboxes/[id]/page.tsx` chỉ tính một cờ
  `isDisconnected = status === 'DISABLED'` và dùng nó cho cả checklist lẫn nút
  reconnect. Hệ quả: với `RECONNECT_REQUIRED`, checklist hiện "✓ Mailbox đã
  connect" (tick xanh sai) và **không** có nút reconnect (nút cũ chỉ render cho
  DISABLED, nằm trong mục disconnect).

## Scope được làm

1. Phân biệt rõ trong checklist readiness: (a) mailbox record/provider tồn tại,
   (b) Microsoft auth/token còn khỏe, (c) active Telegram destination — không
   gộp record-exists thành "đã connect".
2. Thêm CTA "Reconnect Hotmail / Outlook" cho cả `DISABLED` và
   `RECONNECT_REQUIRED`, đặt ở mục Onboarding readiness, gate bằng
   `MANAGE_MAILBOXES`. STAFF_READ_ONLY không thấy action — thay vào đó thấy
   hướng dẫn báo OWNER/ADMIN.
3. Reconnect dùng lại OAuth connect flow hiện có. Thêm tham số target mailbox id
   để callback **fail an toàn** nếu operator đăng nhập nhầm tài khoản Microsoft
   khác — không overwrite/duplicate nhầm mailbox.
4. Reconnect giữ nguyên customer hiện tại và Telegram mapping/destination hiện
   tại (chỉ cập nhật token + status).

## Scope KHÔNG làm

- Không sửa worker/pipeline/dedup/throttle/queue/routing.
- Không đụng multilingual detection (TASK-069A), live beta, scale test.
- Không đổi rule reusable destination / mỗi mailbox tối đa một active
  destination; không multi-destination/broadcast.
- Không tạo migration / không đổi schema (dùng `MailboxStatus` sẵn có).
- Không sửa disconnect safety (TASK-052) / mapping guard (TASK-067).
- Không đụng `.env*`, không nới lỏng secret scan, không thao tác production DB.

## Thay đổi chính

### Logic chung (testable)
- `lib/mailboxes/mailbox-list-filter.ts`: thêm helper thuần
  `mailboxNeedsReconnect(status)` → true cho `DISABLED` và `RECONNECT_REQUIRED`.

### UI
- `app/admin/mailboxes/[id]/page.tsx`: checklist tách record/provider vs
  auth/token; nhánh warning riêng cho token issue; CTA reconnect cho
  `needsReconnect` (pin target mailbox id); hướng dẫn cho read-only.
- `app/admin/page.tsx`: thêm message reason `mailbox_mismatch`.
- `components/admin/ConnectMailboxButton.tsx`: thêm prop optional
  `reconnectMailboxId` → gọi connect-url kèm `?mailboxId=`.

### OAuth reconnect an toàn
- `services/microsoft/oauth-connect-url.service.ts`: thêm hằng tên cookie
  reconnect.
- `app/api/mailboxes/connect-url/route.ts`: đọc `mailboxId`, set cookie reconnect
  ngắn hạn (httpOnly), clear khi fresh connect.
- `app/api/microsoft/oauth/callback/route.ts`: đọc cookie → `expectedMailboxId`,
  truyền vào save; reason `mailbox_mismatch`; luôn clear cookie reconnect.
- `services/microsoft/mailbox-connect.service.ts`: thêm `expectedMailboxId` +
  guard `mismatch` — nếu account đăng nhập không resolve đúng mailbox đang
  reconnect thì throw trước mọi ghi DB.

## Tests

- `tests/unit/mailboxes/mailbox-list-filter.test.ts`: `mailboxNeedsReconnect`;
  `RECONNECT_REQUIRED` không bao giờ Ready dù có customer + active mapping.
- `tests/unit/microsoft/mailbox-connect.service.test.ts`: reconnect match giữ
  customer; mismatch (no match / khác mailbox) throw, không ghi.
- `tests/api/mailboxes-connect-url.route.test.ts`: cookie reconnect set/clear.
- `tests/api/microsoft-oauth-callback.route.test.ts`: reconnect match giữ
  customer; mismatch → reason `mailbox_mismatch`, mailbox giữ nguyên.
- STAFF_READ_ONLY thiếu `MANAGE_MAILBOXES` đã được phủ trong
  `tests/unit/auth/roles.test.ts`.

## Bảo mật

- Không đọc/in `.env*`. Không log token, refresh token, client secret, bot
  token, full verification code, full email body.
- Cookie reconnect chỉ chứa mailbox row id (không phải secret), httpOnly, TTL
  ngắn, luôn được clear sau callback.
- Error message ra UI đã sanitize, không lộ giá trị nhạy cảm.

## Lệnh kiểm tra

```bash
npm run verify
```

## Tiêu chí nghiệm thu

- Mailbox `RECONNECT_REQUIRED` không còn hiện tick xanh "đã connect"; checklist
  phân biệt record/provider vs auth/token.
- Có CTA reconnect rõ ràng cho DISABLED và RECONNECT_REQUIRED (OWNER/ADMIN);
  read-only thấy hướng dẫn báo OWNER/ADMIN.
- Reconnect giữ customer + Telegram mapping; đăng nhập nhầm account → fail an
  toàn, không overwrite mailbox.
- `npm run verify` PASS.
