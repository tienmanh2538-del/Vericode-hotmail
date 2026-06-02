# TASK-052 Report — Safe Mailbox Disconnect Flow

Báo cáo ngày: 2026-06-03
Tác giả: Claude Code

## Trạng thái TASK-052: **DONE (conditional acceptance)**

OWNER/ADMIN có thể ngắt kết nối một mailbox an toàn ngay trên mailbox detail. Sau
disconnect, mailbox không còn được poll, không còn renew subscription, và không còn
relay verification code — trong khi toàn bộ lịch sử (audit log, code event log,
processed message) vẫn được giữ lại.

## 1. Mục tiêu TASK-052

Tạo flow disconnect mailbox theo hướng **local disable trước, remote cleanup sau**:

- Chỉ OWNER/ADMIN được disconnect; STAFF_READ_ONLY bị chặn ở server side.
- Không hard delete mailbox, không xóa logs/history/processed messages.
- Mailbox disconnected hiển thị trạng thái rõ ràng và không được coi là Ready.
- Active Telegram mapping bị chuyển khỏi trạng thái active.
- Graph subscription local bị mark inactive; remote cleanup là best-effort.
- Nếu remote cleanup lỗi, hệ thống vẫn fail-safe: local state đã chặn relay.

## 2. Kết quả đã làm

- Service `disconnectMailbox` thực thi local-first (atomic) + best-effort remote cleanup.
- Server action enforce quyền `MANAGE_MAILBOXES` ở server, yêu cầu xác nhận trước khi chạy.
- UI disconnect trên mailbox detail liệt kê rõ hậu quả; mailbox đã disconnect hiển thị banner.
- Ghi audit `MAILBOX_DISCONNECTED` với metadata an toàn (chỉ id và số liệu tổng hợp).
- Không cần migration: tái dùng các trạng thái enum sẵn có (xem mục 4–7).
- Thêm test bao phủ disconnect, phân quyền, và các đường worker/pipeline.

## 3. File chính đã thay đổi

Mới:

- `services/microsoft/mailbox-disconnect.service.ts` — core service (local-first + audit).
- `services/microsoft/mailbox-disconnect-remote-cleanup.ts` — adapter remote cleanup best-effort.
- `services/microsoft/mailbox-disconnect-actions.ts` — server action enforce quyền.
- `services/microsoft/mailbox-disconnect-form-state.ts` — form state.
- `components/admin/MailboxDisconnectForm.tsx` — UI xác nhận disconnect.
- `tests/unit/microsoft/mailbox-disconnect.service.test.ts`
- `tests/unit/microsoft/mailbox-disconnect-action.test.ts`
- `tests/unit/microsoft/mailbox-disconnect-gating.test.ts`

Sửa:

- `app/admin/mailboxes/[id]/page.tsx` — thêm section disconnect cho OWNER/ADMIN.
- `app/admin/mailboxes/[id]/mailbox-detail.css` — style cho section disconnect.

## 4. Cách disconnect hoạt động

Thứ tự: **local disable trước, remote cleanup sau**.

1. Local (atomic, trong một transaction):
   - `Mailbox.status` chuyển sang `DISABLED`.
   - Active Telegram mapping của mailbox chuyển sang `DISABLED`.
   - Graph subscription local còn sống chuyển sang `EXPIRED`.
   - Ghi audit `MAILBOX_DISCONNECTED` (best-effort, không làm hỏng disconnect nếu lỗi).
2. Remote (best-effort): thử xóa subscription phía Microsoft.

Đặc tính:

- Idempotent: gọi lại trên mailbox đã disconnected là no-op an toàn.
- Fail-closed: mailbox không tồn tại trả lỗi not_found, không leak dữ liệu.
- Không hard delete: chỉ đổi trạng thái; mailbox row và mọi lịch sử vẫn còn.

## 5. Cách xử lý Telegram mapping liên quan

Active Telegram mapping của mailbox được chuyển khỏi trạng thái active (sang `DISABLED`)
trong cùng transaction local. Mapping row vẫn được giữ để audit/debug — không hard delete.
Mục đích: giảm rủi ro reconnect nhầm rồi relay vào destination cũ mà admin chưa kiểm tra lại.
Reusable Telegram destinations nằm ngoài scope và để cho TASK-053.

## 6. Cách xử lý Graph subscription liên quan

- Local subscription record được mark inactive (`EXPIRED`) trước, để renewal worker bỏ qua.
- Sau đó hệ thống thử xóa subscription phía Microsoft như một bước best-effort.
- Nếu remote delete thành công, ghi nhận số lượng đã xóa.
- Nếu remote delete lỗi, ghi nhận số lượng thất bại nhưng **không rollback** local disconnect.
- Hệ thống không bao giờ relay tiếp chỉ vì remote delete lỗi.

Credential decrypt/refresh dùng cho remote cleanup không bao giờ rời khỏi adapter và không
được ghi log; mọi lỗi được đếm là thất bại và nuốt lại an toàn.

## 7. Worker/pipeline đã được bảo vệ thế nào

Disconnect tái dùng các trạng thái enum sẵn có nên mọi đường relay đều bỏ qua mailbox
disconnected mà không cần thêm cột/migration:

- Delta polling chỉ liệt kê mailbox `ACTIVE`, nên mailbox `DISABLED` không được poll.
- Subscription renewal loại mailbox `DISABLED` ngay ở câu truy vấn và ở bước phân loại.
- Email worker/pipeline **re-check trạng thái mailbox tại thời điểm xử lý job**: nếu mailbox
  không còn `ACTIVE`, job bị skip, không cấp token, không gửi Telegram — kể cả khi job đã
  được enqueue trước lúc disconnect.
- Logic readiness coi mailbox `DISABLED` là không Ready trên UI.

## 8. Test/verify đã chạy

- Test mới bao phủ: OWNER/ADMIN disconnect được; STAFF_READ_ONLY bị chặn ở server side;
  không hard delete mailbox/history; disable active Telegram mapping; mark subscription
  local inactive; remote cleanup lỗi vẫn fail-safe; delta polling / subscription renewal /
  email pipeline bỏ qua mailbox disconnected (kể cả job đã enqueue trước đó); mailbox
  disconnected không được coi là Ready; audit metadata không chứa secret.
- Lệnh kiểm tra: `npm run verify` (db:generate + lint + typecheck + test + build).
- Kết quả: PASS. Lint/typecheck/build sạch; toàn bộ test suite pass (gồm các test mới của TASK-052).

## 9. Rủi ro còn lại

- Đường remote cleanup đã được code fail-safe nhưng mới chỉ kiểm bằng unit test với port giả;
  chưa chạy với mailbox Microsoft thật (live path vẫn deferred từ TASK-051).
- Với email thật đã enqueue ngay trước khi disconnect, an toàn dựa vào re-check trạng thái
  mailbox tại thời điểm xử lý job; cần xác minh thêm trong internal beta / live email test.
- Credential mã hóa của mailbox không bị xóa khi disconnect (cố ý, tránh hành vi destructive
  ngoài scope). Credential này không được dùng khi mailbox `DISABLED`; nếu muốn xóa hẳn nên
  tách thành task riêng.
- Phân quyền STAFF được xác minh ở mức contract (action gọi guard quyền + redirect), chưa qua
  E2E thật.

## 10. Kết luận nghiệm thu tạm thời

TASK-052 đạt **done có điều kiện**: disconnect flow hoạt động đúng cho OWNER/ADMIN, chặn
STAFF ở server side, không hard delete và giữ nguyên lịch sử, và mọi đường relay đều bỏ qua
mailbox disconnected (gồm re-check tại thời điểm xử lý job). Điều kiện còn lại là xác minh
đường remote cleanup và case job-enqueued-trước-disconnect bằng email Microsoft thật trong
giai đoạn internal beta / live email test.
