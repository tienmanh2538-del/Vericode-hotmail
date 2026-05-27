# TASK-016: Tạo audit log service & page

## 1. Mục tiêu

Tạo audit log service và trang admin audit log để theo dõi các hành động quan trọng trong hệ thống Verification Code Relay Tool.

Audit log dùng để truy vết:
- Ai đã thực hiện hành động.
- Hành động đó là gì.
- Tác động lên entity nào.
- Metadata liên quan là gì.
- IP nào nếu có.
- Thời điểm xảy ra.

Task này thuộc Sprint 4 — Logs & audit.

## 2. Phạm vi phải làm

### 2.1. Audit log service

Tạo hoặc hoàn thiện service:

```text
services/logs/audit-log.service.ts
````

Service cần hỗ trợ tối thiểu:

```ts
createAuditLog(input)
listAuditLogs(filters)
sanitizeAuditMetadata(metadata)
```

Nếu project đã có convention đặt tên khác, hãy tuân theo convention hiện có nhưng vẫn giữ đúng mục tiêu task.

### 2.2. Audit log types

Cần có type rõ ràng cho:

```ts
AuditLogAction
AuditLogEntityType
AuditLogSeverity
CreateAuditLogInput
AuditLogListFilters
AuditLogListItem
AuditLogListResult
```

Các action gợi ý:

```text
CUSTOMER_CREATED
CUSTOMER_UPDATED
CUSTOMER_DELETED

TELEGRAM_MAPPING_CREATED
TELEGRAM_MAPPING_UPDATED
TELEGRAM_MAPPING_DELETED
TELEGRAM_TEST_SEND_REQUESTED
TELEGRAM_TEST_SEND_SUCCEEDED
TELEGRAM_TEST_SEND_FAILED

CODE_DETECTED
CODE_SENT
CODE_SKIPPED_LOW_CONFIDENCE
CODE_DUPLICATE_SKIPPED

MAILBOX_CONNECTED
MAILBOX_DISCONNECTED
MAILBOX_RECONNECT_REQUIRED

SUBSCRIPTION_RENEWED
TOKEN_REFRESH_FAILED

ADMIN_LOGIN
ADMIN_LOGOUT

SYSTEM_ERROR
```

Lưu ý: các action liên quan mailbox/Microsoft có thể chỉ định nghĩa enum/type ở task này, không implement Microsoft OAuth thật.

### 2.3. Metadata sanitize

Audit log metadata bắt buộc phải sanitize trước khi lưu hoặc hiển thị.

Không được lưu/hiển thị các field nhạy cảm như:

```text
password
token
accessToken
refreshToken
clientSecret
secret
telegramBotToken
code
verificationCode
otp
authorization
cookie
```

Nếu metadata có field nhạy cảm, thay bằng:

```text
[REDACTED]
```

Không log full verification code.
Không log access token.
Không log refresh token.
Không log Telegram bot token.
Không log full email body.

### 2.4. Audit log list page

Tạo trang:

```text
app/admin/logs/audit/page.tsx
```

Hoặc vị trí tương ứng nếu project đang dùng `src/`.

Trang cần hiển thị bảng audit log gồm các cột:

```text
Time
Actor
Action
Entity
Entity ID
IP Address
Summary
```

Nếu có metadata thì chỉ hiển thị bản tóm tắt an toàn hoặc JSON đã sanitize.

### 2.5. Filter/search cơ bản

Trang audit log nên có filter tối thiểu:

```text
- Search text
- Action
- Entity type
- Date range nếu dễ làm
```

Nếu task trước đã có pattern filter ở code event log page, hãy tái sử dụng pattern đó.

### 2.6. API hoặc server function

Nếu project đang dùng API route, tạo route:

```text
app/api/logs/audit/route.ts
```

Route chỉ phục vụ đọc danh sách audit logs.

Nếu project đang dùng server component gọi service trực tiếp, có thể không cần API route riêng.

Ưu tiên tuân theo pattern đã có từ TASK-015.

### 2.7. Tests

Cần có unit test cho service, tối thiểu kiểm tra:

```text
- createAuditLog sanitize metadata trước khi lưu.
- listAuditLogs trả về dữ liệu theo thứ tự mới nhất trước.
- filter theo action hoạt động.
- filter theo entityType hoạt động.
- sensitive fields bị redact.
- không có full code/token/secret trong output.
```

Nếu project có mock Prisma/service pattern từ task trước, dùng lại pattern đó.

## 3. File/thư mục dự kiến tạo hoặc sửa

Có thể tạo/sửa:

```text
docs/tasks/TASK-016-audit-log-service-page.md
services/logs/audit-log.service.ts
app/admin/logs/audit/page.tsx
app/api/logs/audit/route.ts
tests/unit/logs/audit-log.service.test.ts
components/tables/AuditLogTable.tsx
components/status/AuditSeverityBadge.tsx
```

Chỉ tạo component mới nếu thật sự cần và phù hợp cấu trúc hiện tại.

Nếu project dùng `src/`, tạo trong:

```text
src/services/logs/
src/app/admin/logs/audit/
src/app/api/logs/audit/
src/tests/
```

Không tạo song song cả `src/` và non-`src/`.

## 4. Không được làm

Không được làm trong task này:

```text
- Không implement Microsoft OAuth.
- Không tạo Microsoft connect URL.
- Không tạo Microsoft callback.
- Không tạo Graph subscription thật.
- Không tạo webhook receiver.
- Không tạo worker/queue.
- Không đọc Inbox thật.
- Không gửi Telegram thật.
- Không thêm field lưu full verification code.
- Không log token/secret/password.
- Không sửa lớn database schema nếu không cần.
- Không refactor toàn bộ logs/admin layout nếu không cần.
```

Nếu thiếu model AuditLog trong Prisma, Claude phải báo rõ trước khi sửa schema. Chỉ sửa schema nếu đây là thay đổi nhỏ, đúng scope, và không làm ảnh hưởng task khác.

## 5. Tiêu chí nghiệm thu

Task chỉ PASS khi:

```text
- Có audit log service rõ ràng.
- Có sanitize/redact metadata nhạy cảm.
- Có trang /admin/logs/audit.
- Trang hiển thị audit logs dạng bảng.
- Có filter/search cơ bản nếu phù hợp.
- Không hiển thị token/secret/full code.
- Không cho sửa/xóa audit logs từ UI.
- Có test cho audit log service.
- npm run verify PASS.
- Gemini review PASS.
```

---
##6. Lệnh kiểm tra

Chạy:

npm run verify

Nếu project có lệnh test riêng:

npm test
npm run test
npm run typecheck
npm run lint
npm run build

Nhưng lệnh bắt buộc cuối cùng vẫn là:

npm run verify

##7. Báo cáo cuối task
Claude phải báo lại:

1. Đã làm gì
2. File nào đã tạo/sửa
3. Có sửa schema không
4. Có route/page mới nào
5. Test nào đã thêm
6. Lệnh nào đã chạy
7. npm run verify PASS/FAIL
8. Rủi ro còn lại
9. Có vượt scope không

Lưu ý Các lỗi Claude hay mắc ở TASK-016

## Lỗi 1 — Làm lấn sang TASK-017

Nếu Claude bắt đầu tạo:

```text
services/microsoft/oauth.service.ts
app/api/mailboxes/connect-url
docs/MICROSOFT_SETUP.md
```

thì dừng lại. Đó là TASK-017/TASK-018, không phải TASK-016.

## Lỗi 2 — Metadata không được sanitize

Ví dụ sai:

```json
{
  "refreshToken": "abc...",
  "verificationCode": "123456"
}
```

Ví dụ đúng:

```json
{
  "refreshToken": "[REDACTED]",
  "verificationCode": "[REDACTED]"
}
```

## Lỗi 3 — UI hiển thị full JSON metadata nhạy cảm

Nếu trang audit log in nguyên metadata ra UI mà không lọc, rủi ro rất cao.

## Lỗi 4 — Cho sửa/xóa audit log trên UI

Audit log nên là log truy vết. Task này chỉ nên tạo trang xem. Không tạo nút edit/delete.

## Lỗi 5 — Tạo cấu trúc sai

Nếu project dùng `src/`, không được tạo thêm `app/` ở root. Nếu project không dùng `src/`, không được tự tạo `src/app`.

---

