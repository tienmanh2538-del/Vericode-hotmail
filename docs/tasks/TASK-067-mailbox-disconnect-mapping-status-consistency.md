# TASK-067 — Mailbox disconnect / Telegram mapping effective status consistency

## Mục tiêu

Làm cho trạng thái hiển thị và validation giữa **mailbox** và **Telegram mapping** nhất quán, để operator không hiểu nhầm "mapping Active = mailbox Ready".

## Bối cảnh (root cause đã xác định ở lượt trước)

- Khi disconnect mailbox (TASK-052): `Mailbox.status = DISABLED`, active mapping bị disable, subscription bị mark EXPIRED. Mailbox không poll, không renew, không relay.
- Nhưng lớp tạo mapping theo reusable destination (`resolveDestinationMapping` trong `services/telegram/telegram-mapping.service.ts`) **không kiểm tra `Mailbox.status`**. Vì mapping cũ đã bị disable lúc disconnect, rule "1 active mapping/mailbox" không chặn → operator có thể tạo một mapping **ACTIVE mới** cho mailbox đang DISABLED.
- Hệ quả: trang Telegram hiển thị mapping ACTIVE (đúng theo dữ liệu mapping), nhưng trang Mailboxes/detail vẫn hiển thị Disabled/chưa Ready (cũng đúng theo trạng thái mailbox). Hai trang nói trái ngược nhau.
- UI mailbox detail còn hard-code checklist "✓ Mailbox đã connect" bất kể status, và warning chung chung không nêu lý do "đã ngắt kết nối".
- Không có bằng chứng relay sai: DISABLED mailbox vẫn không poll/không renew/không relay. Đây là lỗi vận hành/UI: operator có thể tưởng mailbox đã hoạt động.

Đây KHÔNG phải lỗi báo Active sai (mapping thật sự ACTIVE), mà là thiếu ràng buộc nhất quán + UI gây hiểu nhầm.

## Scope được làm

1. Chặn tạo/update Telegram mapping sang **ACTIVE** khi mailbox đang **DISABLED**.
2. Vẫn cho phép tạo mapping **DISABLED** (pre-stage) cho mailbox DISABLED — phù hợp pattern an toàn đã có (mapping DISABLED không relay).
3. Mailbox detail UI hiển thị rõ mailbox đã ngắt kết nối / cần reconnect.
4. Checklist không hard-code "✓ Mailbox đã connect" khi mailbox thực tế DISABLED — đổi sang dấu ✗ và nhãn "đã ngắt kết nối — cần reconnect".
5. Thêm CTA "Reconnect Hotmail / Outlook" khi mailbox DISABLED.
6. Tuyệt đối không tự động re-enable mailbox chỉ vì gán Telegram mapping.

## Scope KHÔNG làm

- Không sửa disconnect service (TASK-052) — giữ nguyên: disconnected mailbox không poll/không renew/không relay.
- Không sửa worker/pipeline/gating.
- Không sửa reusable destination logic (TASK-053) — nhiều mailbox vẫn dùng chung một destination.
- Không đổi rule "mỗi mailbox tối đa một active mapping".
- Không đổi customer isolation (TASK-065).
- Không tạo migration / không đổi schema (dùng `Mailbox.status` sẵn có).
- Không đụng `.env*`, không nới lỏng secret scan.

## Quyết định kỹ thuật

- Guard đặt trong `resolveDestinationMapping`, dùng chung cho cả create và update theo destination (đây là path duy nhất UI hiện dùng — xác nhận trong `services/telegram/mapping-actions.ts`).
- Chỉ chặn khi `input.status === 'ACTIVE'` **và** `mailbox.status === 'DISABLED'`. DISABLED là trạng thái disconnect chủ động (operator), tương ứng "không relay được". Các trạng thái lỗi tạm thời khác (RECONNECT_REQUIRED / SUBSCRIPTION_EXPIRED / WEBHOOK_FAILED / ERROR) không phải disconnect chủ động và đã được readiness phản ánh; cố tình không chặn để tránh mở rộng scope ngoài root cause.
- Lỗi trả về dạng `TelegramDestinationMappingConflictError('mailboxId', ...)` để message gắn đúng control trên form, đồng bộ với guard "destination disabled" sẵn có.

## Yêu cầu chức năng

### Service (`services/telegram/telegram-mapping.service.ts`)
- `resolveDestinationMapping` select thêm `status` của mailbox.
- Nếu tạo/đổi mapping sang ACTIVE mà mailbox DISABLED → throw conflict, không ghi DB, không đổi trạng thái mailbox.
- Mapping DISABLED vẫn cho phép với mọi trạng thái mailbox.

### UI (`app/admin/mailboxes/[id]/page.tsx`)
- Warning readiness có nhánh riêng cho mailbox DISABLED, nêu rõ "đã ngắt kết nối, gán Telegram mapping KHÔNG bật lại mailbox".
- Checklist item kết nối phản ánh đúng status.
- CTA reconnect (dùng `ConnectMailboxButton`) hiển thị khi mailbox DISABLED và người dùng có quyền MANAGE_MAILBOXES.

## Tests cần có

1. Tạo ACTIVE mapping từ destination cho mailbox DISABLED → bị từ chối.
2. Update mapping sang ACTIVE cho mailbox DISABLED → bị từ chối.
3. Mapping DISABLED cho mailbox DISABLED → được phép, không làm relay, không đụng trạng thái mailbox.
4. Mapping ACTIVE cho mailbox ACTIVE → vẫn được phép.
5. Readiness: DISABLED thắng dù có active mapping + customer + subscription khỏe.

## Bảo mật

- Không đọc/in nội dung file môi trường.
- Không log token, refresh token, client secret, Telegram bot credential, verification code đầy đủ, hoặc full email body.
- Không hardcode secret trong code/docs/tests.
- Tránh wording metadata dạng keyword/value nhạy cảm trong docs/report.

## Lệnh kiểm tra bắt buộc

```bash
npm run verify
```

## Tiêu chí nghiệm thu

- Không thể tạo/kích hoạt ACTIVE mapping cho mailbox DISABLED.
- Mapping DISABLED pre-stage vẫn được phép.
- Mailbox detail nói rõ trạng thái ngắt kết nối + có CTA reconnect.
- Checklist không còn báo "đã connect" kiểu success khi mailbox DISABLED.
- Gán mapping không tự re-enable mailbox.
- TASK-052/053, rule one-active-mapping, customer isolation giữ nguyên.
- `npm run verify` PASS.
