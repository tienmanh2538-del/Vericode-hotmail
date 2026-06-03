# TASK-056 — Operational health dashboard for staff workload (report)

## Tóm tắt

Nâng cấp `/admin/health` thành operational health dashboard tối thiểu cho staff
workload, với customer scope được enforce ở service layer. Không gọi Microsoft
Graph hoặc Telegram để render; toàn bộ số liệu là computed status từ dữ liệu nội
bộ hiện có (read-only Prisma, whitelisted select).

## Đã thay đổi gì

- **Scope enforcement ở service layer (lỗ hổng chính đã đóng):**
  `loadHealthDashboard(scope, now)` giờ nhận `CustomerScope` bắt buộc.
  OWNER/ADMIN (`kind: 'all'`) thấy toàn bộ; STAFF_READ_ONLY
  (`kind: 'assigned'`) bị giới hạn ở mailbox của customer được phân công bằng
  `where: { customerId: { in: customerIds } }`. Scope rỗng → `in: []` → fail
  closed (0 row). Mọi aggregate per-message/per-subscription được giới hạn theo
  mailbox đã scope, nên staff không bao giờ nhận số liệu ngoài phạm vi.
- **Không lộ số liệu global cho staff:** các operational check toàn hệ thống
  (email worker pipeline, queue/Redis, delta polling, subscription renewal,
  Telegram reliability, webhook) chỉ được build cho scope `all`; staff nhận
  danh sách rỗng. UI cũng ẩn section này cho staff (defence in depth).
- **Workload by customer:** thêm `buildCustomerWorkload` (pure) gom mailbox theo
  customer và đếm total / ready / needs-mapping / error-disconnected /
  recent-issue. Mailbox không có customer gom vào bucket "Unassigned" (chỉ
  OWNER/ADMIN mới thấy).
- **Readiness dùng chung định nghĩa:** mỗi mailbox row có `readiness` lấy từ
  `deriveMailboxReadiness` (dùng chung với mailbox list). Mailbox ACTIVE nhưng
  thiếu active mapping → "Needs mapping"; mailbox disconnected
  (RECONNECT_REQUIRED/ERROR/…) không bao giờ là "Ready". Nhiều mailbox dùng
  chung reusable destination vẫn hợp lệ vì readiness chỉ xét mapping ACTIVE của
  từng mailbox, không xét tính duy nhất của destination.
- **Empty state an toàn cho staff chưa có assignment:** trang hiển thị thông báo
  riêng, không gọi service và không lộ dữ liệu global.
- **Overview cards:** thêm Ready / Needs mapping / Needs customer.

## File đã thay đổi

- `services/health/health.types.ts` — thêm `CustomerWorkloadRow`; thêm
  `customerId`, `readiness`, `recentTelegramFailureCount` vào `MailboxHealthRow`;
  thêm `readyMailboxes`/`needsMapping`/`needsCustomer` vào overview; thêm
  `workload`/`isUnrestricted` vào `HealthDashboardData`.
- `services/health/health.service.ts` — signature mới có scope; where-filter +
  scoped aggregates; readiness per row; `buildCustomerWorkload`; gate
  operational checks theo scope.
- `app/admin/health/page.tsx` — resolve viewer + scope, truyền scope, empty
  state cho staff, section Workload by customer, gate operational checks.
- `tests/unit/health/health.service.test.ts` — cập nhật theo signature mới +
  thêm test scope filter, fail-closed, ẩn operational check cho staff, và
  `buildCustomerWorkload`.

## Bảo mật

- Không log/hiển thị token, refresh token, credential, verification code đầy đủ
  hay full email body. Whitelisted select giữ nguyên (không chọn
  encryptedRefreshToken, microsoftUserId, clientStateHash, subscriptionId).
- Error message ra UI được redact + truncate (`sanitizeErrorMessage`).
- Không đọc/in nội dung `.env*`; không gọi external service để render.
- Routing rules giữ nguyên: dashboard chỉ hiển thị, không tự sửa mapping/gửi lại
  code; baseline throttling/queue safety của TASK-055 không bị đụng tới.

## Kiểm tra

- `npx vitest run tests/unit/health` — 48 test PASS.
- `npm run verify` (db:generate → lint → typecheck → test → build) — PASS.

## Cần Gemini review kỹ

- Scope enforcement trong `loadHealthDashboard`: xác nhận không còn đường nào trả
  số liệu ngoài assignment cho STAFF_READ_ONLY (đặc biệt các aggregate).
- Quyết định ẩn toàn bộ operational/infra checks cho staff (đúng yêu cầu "không
  lộ số liệu global") — xác nhận không che mất tín hiệu cần thiết cho staff.
- Định nghĩa "recent issue count" (đang dùng tổng Telegram failure 24h) có khớp
  kỳ vọng vận hành không.
