# Báo cáo TASK-067 — Mailbox disconnect / Telegram mapping effective status consistency

## 1. Đã thay đổi gì

### Service — chặn ACTIVE mapping cho mailbox đã ngắt kết nối
- `resolveDestinationMapping` (dùng chung cho create & update theo reusable destination) giờ select thêm `Mailbox.status`.
- Thêm guard: nếu `input.status === 'ACTIVE'` và `mailbox.status === 'DISABLED'` → throw `TelegramDestinationMappingConflictError('mailboxId', 'This mailbox is disconnected. Reconnect the mailbox before activating a Telegram mapping.')`, không ghi DB.
- Mapping **DISABLED** vẫn được phép với mọi trạng thái mailbox (pre-stage an toàn).
- Service **không** đổi trạng thái mailbox — gán mapping không bao giờ tự re-enable mailbox.

### UI mailbox detail
- Warning "chưa sẵn sàng relay code" có nhánh riêng cho mailbox DISABLED: nêu rõ mailbox đã ngắt kết nối, không poll/không renew/không relay, và gán Telegram mapping KHÔNG bật lại mailbox.
- Checklist không còn hard-code "✓ Mailbox đã connect": khi DISABLED hiển thị "✗ Mailbox đã ngắt kết nối — cần reconnect".
- Thêm CTA "Reconnect Hotmail / Outlook" (tái dùng `ConnectMailboxButton`) trong section danger khi mailbox DISABLED và người dùng có quyền MANAGE_MAILBOXES. Reconnect đi qua Microsoft OAuth; flow connect sẵn có set lại `status = ACTIVE`.
- Thêm style nhỏ `.mailbox-detail__reconnect`.

### Tests
- `tests/unit/telegram/telegram-mapping.service.test.ts`: thêm nhóm TASK-067 — từ chối create ACTIVE cho mailbox DISABLED; từ chối update sang ACTIVE cho mailbox DISABLED; cho phép mapping DISABLED cho mailbox DISABLED (không đụng trạng thái mailbox); vẫn cho phép ACTIVE cho mailbox ACTIVE.
- `tests/unit/mailboxes/mailbox-list-filter.test.ts`: thêm test DISABLED thắng tuyệt đối dù có active mapping + customer + subscription khỏe.

## 2. File đã thay đổi

| File | Loại |
|---|---|
| `services/telegram/telegram-mapping.service.ts` | Sửa (guard) |
| `app/admin/mailboxes/[id]/page.tsx` | Sửa (UI) |
| `app/admin/mailboxes/[id]/mailbox-detail.css` | Sửa (style nhỏ) |
| `tests/unit/telegram/telegram-mapping.service.test.ts` | Test mới |
| `tests/unit/mailboxes/mailbox-list-filter.test.ts` | Test mới |
| `docs/tasks/TASK-067-...md` | Tạo mới |
| `docs/reports/TASK-067-...md` | Tạo mới |

Không migration: dùng `Mailbox.status` (DISABLED) sẵn có; không đổi schema.

## 3. Quyết định & phạm vi

- Chỉ chặn khi mailbox `DISABLED` (trạng thái disconnect chủ động theo TASK-052), đúng root cause và đúng 2 test bắt buộc. Các trạng thái lỗi tạm thời (RECONNECT_REQUIRED / SUBSCRIPTION_EXPIRED / WEBHOOK_FAILED / ERROR) không phải disconnect chủ động và đã được readiness phản ánh; cố ý không chặn để giữ minimal, tránh chặn nhầm thao tác hợp lệ.
- Guard đặt ở path destination vì đây là path duy nhất UI dùng (xác nhận `services/telegram/mapping-actions.ts`). Path direct-input legacy không còn nối UI nên không đụng.
- Giữ nguyên: TASK-052 (disconnected không poll/renew/relay), TASK-053 (reusable destination, nhiều mailbox dùng chung), rule một active mapping/mailbox, customer isolation (TASK-065).

## 4. Lệnh đã chạy để kiểm tra

- `npm run verify` (db:generate → lint → typecheck → test → build)
- `npx vitest run tests/unit/telegram/telegram-mapping.service.test.ts tests/unit/mailboxes/mailbox-list-filter.test.ts`

## 5. Kết quả

- `npm run verify`: **PASS** (lint 0 lỗi, typecheck PASS, test PASS, build PASS — 15/15 trang generate).
- Targeted: **PASS** — 61 test (38 telegram-mapping, 23 mailbox-list-filter).

## 6. Cần Gemini review phần nào

- Vị trí guard trong `resolveDestinationMapping` và message lỗi.
- Quyết định chỉ chặn DISABLED thay vì mọi trạng thái non-ACTIVE.
- UX của CTA reconnect trong section danger.

## 7. Rủi ro còn lại

- Mapping ACTIVE "cũ" được tạo TRƯỚC khi có guard (mailbox bị disconnect sau đó) vẫn tồn tại ở trạng thái ACTIVE trên một mailbox DISABLED. An toàn về relay (mailbox DISABLED không relay) và readiness vẫn báo DISABLED đúng; guard mới chỉ chặn thao tác tạo/đổi-sang-ACTIVE từ giờ. Nếu muốn dọn dữ liệu cũ có thể xử lý ở task vận hành riêng (ngoài scope).
- Không có rủi ro cross-customer/routing mới: customer isolation và gating worker giữ nguyên.

## 8. Bảo mật

- Không đọc/in file môi trường; không log token/refresh token/client secret/bot credential/verification code đầy đủ/email body.
- Không hardcode secret trong code/docs/tests.
- Không sửa GitHub Actions / không nới lỏng secret scan.
