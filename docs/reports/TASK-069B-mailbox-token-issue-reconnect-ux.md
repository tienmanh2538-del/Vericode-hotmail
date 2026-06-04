# TASK-069B — Report: Mailbox Token Issue Diagnosis & Reconnect UX

## 1. Nguyên nhân code-level khiến mailbox rơi vào token issue / cần reconnect

- `MailboxStatus` (`prisma/schema.prisma`) gồm `ACTIVE`, `RECONNECT_REQUIRED`,
  `SUBSCRIPTION_EXPIRED`, `WEBHOOK_FAILED`, `DISABLED`, `ERROR`.
- Trạng thái `RECONNECT_REQUIRED` (UI badge "Cần reconnect", readiness
  `TOKEN_ISSUE`) chỉ được đặt bởi **ba** worker qua `markReconnectRequired`:
  - `services/queue/workers/subscription-renewal-runner.ts`
  - `services/queue/workers/delta-polling-runner.ts`
  - `services/queue/workers/email-worker-runner.ts`
  Cả ba gọi `refreshMicrosoftAccessToken`
  (`services/microsoft/refresh-access-token.service.ts`); khi Microsoft trả lỗi
  token endpoint với mã `invalid_grant` / `interaction_required` (refresh grant
  bị thu hồi / hết hiệu lực / cần đăng nhập lại), worker chuyển mailbox sang
  `RECONNECT_REQUIRED`. **Đây là điều kiện code duy nhất** tạo ra token issue.
  Không suy luận nguyên nhân thật từ secret/env.
- `deriveMailboxReadiness` đã map `RECONNECT_REQUIRED → TOKEN_ISSUE` đúng. Bug
  thuần UI: `app/admin/mailboxes/[id]/page.tsx` chỉ tính
  `isDisconnected = status === 'DISABLED'` rồi dùng nó cho cả checklist lẫn nút
  reconnect. Với `RECONNECT_REQUIRED`, checklist hiện "✓ Mailbox đã connect"
  (tick xanh sai) và không có nút reconnect (nút cũ chỉ dành cho DISABLED).
- Không có log/error nào đẩy token/secret ra UI — message ra UI đã sanitize.

## 2. UI đã sửa gì

- **Checklist readiness** tách thành các tín hiệu phân biệt rõ:
  1. Mailbox record & provider (luôn ✓ — record tồn tại),
  2. Microsoft auth/token (✗ khi `DISABLED`/`RECONNECT_REQUIRED`, kèm nhãn "đã
     ngắt kết nối — cần reconnect" / "token hết hiệu lực — cần reconnect"),
  3. Gắn customer, 4. Active Telegram destination.
  Không còn tick xanh "đã connect" khi mailbox thực tế cần reconnect.
- **Warning banner** có nhánh riêng cho token issue, nêu rõ cần reconnect và
  rằng customer + Telegram mapping hiện tại sẽ được giữ nguyên.
- **CTA "Reconnect Hotmail / Outlook"** hiển thị cho cả `DISABLED` và
  `RECONNECT_REQUIRED`, đặt ở mục Onboarding readiness, gate bằng
  `MANAGE_MAILBOXES`. STAFF_READ_ONLY không thấy nút — thấy hướng dẫn báo
  OWNER/ADMIN. Mục disconnect chỉ giữ form disconnect + chỉ dẫn tới CTA phía
  trên (gộp, tránh hai nút reconnect).
- **Reconnect an toàn**: nút pin `mailboxId` của mailbox đang reconnect. Callback
  OAuth so khớp tài khoản Microsoft vừa đăng nhập với mailbox đó; nếu đăng nhập
  nhầm tài khoản khác → fail an toàn (`reason=mailbox_mismatch`), không
  overwrite/duplicate mailbox. Reconnect chỉ cập nhật token + status, **giữ
  nguyên** customer và Telegram mapping/destination.
- Trang `/admin` có message thân thiện cho `mailbox_mismatch`.

## 3. File đã thay đổi

Runtime:
- `lib/mailboxes/mailbox-list-filter.ts` — thêm `mailboxNeedsReconnect`.
- `app/admin/mailboxes/[id]/page.tsx` — checklist + warning + CTA reconnect.
- `app/admin/page.tsx` — message reason `mailbox_mismatch`.
- `components/admin/ConnectMailboxButton.tsx` — prop `reconnectMailboxId`.
- `services/microsoft/oauth-connect-url.service.ts` — hằng cookie reconnect.
- `app/api/mailboxes/connect-url/route.ts` — đọc `mailboxId`, set/clear cookie.
- `app/api/microsoft/oauth/callback/route.ts` — `expectedMailboxId`, reason
  `mailbox_mismatch`, clear cookie reconnect.
- `services/microsoft/mailbox-connect.service.ts` — `expectedMailboxId` + guard
  `mismatch` (fail trước mọi ghi DB).

Docs:
- `docs/tasks/TASK-069B-mailbox-token-issue-reconnect-ux.md`
- `docs/reports/TASK-069B-mailbox-token-issue-reconnect-ux.md`
- `docs/ROADMAP.md`

## 4. Test đã thêm/cập nhật

- `tests/unit/mailboxes/mailbox-list-filter.test.ts` — `mailboxNeedsReconnect`;
  `RECONNECT_REQUIRED` không bao giờ Ready dù đủ customer + active mapping.
- `tests/unit/microsoft/mailbox-connect.service.test.ts` — reconnect match giữ
  customer; mismatch (không match / khác mailbox) throw `mismatch`, không ghi.
- `tests/api/mailboxes-connect-url.route.test.ts` — cookie reconnect set khi có
  `mailboxId`, clear khi fresh connect, bỏ qua blank.
- `tests/api/microsoft-oauth-callback.route.test.ts` — reconnect match giữ
  customer; mismatch → `reason=mailbox_mismatch`, mailbox giữ nguyên.
- STAFF_READ_ONLY thiếu `MANAGE_MAILBOXES` đã phủ ở
  `tests/unit/auth/roles.test.ts` (gate CTA reconnect dùng đúng permission này).

## 5. Kết quả `npm run verify`

PASS — lint sạch, typecheck sạch, **1024 tests passed** (trước: 1013, +11),
build production thành công.

## 6. Bảo mật

- Không đọc/in `.env*`. Không log token/refresh token/client secret/bot
  token/full code/full email body.
- Cookie reconnect chỉ chứa mailbox row id, httpOnly, TTL ngắn, luôn clear sau
  callback (cả success lẫn error).
- Reconnect mismatch fail trước mọi ghi DB → không overwrite nhầm mailbox, không
  tạo mailbox lạc.

## 7. Rủi ro còn lại / cần lưu ý

- Đây là synthetic/unit + route test; chưa chạy live với mailbox Microsoft thật
  → xác minh end-to-end reconnect khi vào internal beta.
- Trang server component không có render test trực tiếp; điều kiện CTA reconnect
  được phủ qua `mailboxNeedsReconnect` (logic thuần) + permission gate.

## 8. Cần Gemini review phần nào

- Guard `expectedMailboxId` trong `mailbox-connect.service.ts` (đúng fail trước
  ghi, không lộ thông tin nhạy cảm).
- Vòng đời cookie reconnect ở connect-url + callback (set/clear, httpOnly, TTL).
- Logic gate CTA reconnect theo `MANAGE_MAILBOXES` cho STAFF_READ_ONLY.
- Wording checklist/warning mới có còn gây hiểu nhầm trạng thái không.
