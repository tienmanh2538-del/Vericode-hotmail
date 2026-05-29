
# TASK-035: Tạo alert service

## 1. Mục tiêu

Tạo một Alert Service trung tâm để các module reliability có thể gửi cảnh báo vận hành nghiêm trọng cho admin.

Alert Service dùng để báo các lỗi như:

- Microsoft token refresh failed / mailbox cần reconnect.
- Microsoft Graph subscription renew failed / subscription expired.
- Telegram send failed sau khi đã retry.
- Delta polling failed.
- Webhook failed hoặc webhook có dấu hiệu bất thường.
- Health check phát hiện mailbox/subscription/worker ở trạng thái lỗi nghiêm trọng.

Mục tiêu của task này là tạo service an toàn, dễ test, dễ gọi từ các module khác, không làm dashboard mới và không mở rộng sang hệ thống notification phức tạp.

---

## 2. Bối cảnh roadmap

TASK-035 thuộc Sprint 8 — Reliability.

Các task trước đó đã hoặc nên có:

- TASK-031: Delta polling backup worker.
- TASK-032: Subscription renewal worker.
- TASK-033: Telegram retry & failure handling.
- TASK-034: Health dashboard.

TASK-035 là lớp cảnh báo vận hành dùng chung cho các lỗi nghiêm trọng từ các phần trên.

---

## 3. Yêu cầu chức năng

### 3.1. Alert type

Tạo danh sách alert type rõ ràng, tối thiểu gồm:

```ts
type AlertType =
  | 'TOKEN_REFRESH_FAILED'
  | 'MAILBOX_RECONNECT_REQUIRED'
  | 'SUBSCRIPTION_RENEW_FAILED'
  | 'SUBSCRIPTION_EXPIRED'
  | 'TELEGRAM_SEND_FAILED'
  | 'WEBHOOK_FAILED'
  | 'DELTA_POLLING_FAILED'
  | 'HEALTH_CHECK_CRITICAL';
````

Có thể thêm type khác nếu đã tồn tại lỗi tương ứng trong codebase, nhưng không được mở rộng quá xa scope TASK-035.

### 3.2. Alert severity

Tạo severity rõ ràng:

```ts
type AlertSeverity = 'info' | 'warning' | 'critical';
```

Quy ước:

* `info`: cảnh báo nhẹ, không cần hành động ngay.
* `warning`: lỗi cần kiểm tra.
* `critical`: lỗi có thể làm khách hàng miss code hoặc mailbox mất kết nối.

### 3.3. Alert payload

Payload nên có shape an toàn, ví dụ:

```ts
type OperationalAlertInput = {
  type: AlertType;
  severity: AlertSeverity;
  title: string;
  message: string;
  mailboxId?: string;
  emailAddress?: string;
  customerId?: string;
  customerName?: string;
  source?: string;
  error?: unknown;
  metadata?: Record<string, unknown>;
};
```

Yêu cầu bảo mật:

* Không nhận hoặc không giữ raw access token.
* Không nhận hoặc không giữ raw refresh token.
* Không nhận hoặc không giữ Microsoft client secret.
* Không nhận hoặc không giữ Telegram bot token.
* Không nhận hoặc không giữ full verification code.
* Không nhận hoặc không giữ full email body.

Nếu metadata có key nhạy cảm như `token`, `secret`, `password`, `code`, `authorization`, `cookie`, `clientSecret`, service phải sanitize/mask trước khi log hoặc gửi Telegram.

### 3.4. Alert channel

MVP chỉ cần một channel chính:

```text
Admin Telegram group
```

Service sẽ gửi alert vào admin Telegram group nếu có cấu hình:

```env
TELEGRAM_ADMIN_ALERT_CHAT_ID=
```

Yêu cầu:

* Không hardcode chat ID.
* Không hardcode bot token.
* Không đọc/in nội dung `.env` hoặc `.env.local`.
* Nếu `TELEGRAM_ADMIN_ALERT_CHAT_ID` chưa cấu hình thì service không được làm crash app.
* Nếu thiếu config, service chỉ log warning an toàn kiểu:
  `Operational alert skipped because admin alert chat is not configured`.

### 3.5. Message format

Message gửi Telegram nên ngắn, rõ, không chứa secret.

Format đề xuất:

```text
🚨 Verification Tool Alert

Severity: CRITICAL
Type: TELEGRAM_SEND_FAILED
Title: Telegram send failed after retries

Mailbox: client-a@hotmail.com
Customer: Customer A
Source: telegram-retry-worker
Time: 2026-05-29 22:30:00

Details:
Telegram send failed after 3 retries. Please check bot membership, chat id, or Telegram API status.
```

Không gửi:

```text
- Full email body
- Full verification code
- Access token
- Refresh token
- Client secret
- Telegram bot token
- Authorization header
- Cookie
- Raw .env content
```

### 3.6. Logger fallback

Alert Service phải dùng logger an toàn hiện có trong project, ví dụ `createLogger()` nếu có.

Không dùng `console.log` trong production code path.

Nếu gửi Telegram alert thất bại, service phải log lỗi đã sanitize, nhưng không được throw làm chết worker chính trừ khi codebase hiện tại có convention khác.

### 3.7. Integration tối thiểu

Claude cần kiểm tra codebase hiện tại trước khi sửa.

Nếu các service sau đã tồn tại, có thể thêm call alert ở điểm lỗi nghiêm trọng:

* `services/telegram/*` hoặc Telegram retry/failure handling của TASK-033:

  * Gọi alert khi gửi Telegram thất bại sau tất cả retry.
* `services/microsoft/subscription-renewal.service.ts`:

  * Gọi alert khi renew subscription fail nghiêm trọng hoặc mark subscription expired.
* `services/microsoft/delta-polling.service.ts`:

  * Gọi alert khi polling một mailbox fail nhiều lần hoặc lỗi không recover.
* `services/health/*`:

  * Có thể dùng alert service nếu health check phát hiện trạng thái critical.

Nếu việc tích hợp trực tiếp gây sửa quá nhiều file hoặc dễ vượt scope, ưu tiên tạo service + unit tests trước, sau đó chỉ tích hợp 1-2 điểm rõ ràng nhất.

### 3.8. Deduplication / chống spam alert

MVP nên có cơ chế đơn giản để tránh spam cùng một alert liên tục.

Chấp nhận một trong hai cách:

1. In-memory cooldown trong service, ví dụ cùng `type + mailboxId + source` chỉ gửi lại sau 5 phút.
2. Nếu codebase đã có bảng log/audit phù hợp, có thể ghi nhận alert event an toàn.

Không bắt buộc tạo bảng database mới trong TASK-035 nếu roadmap chưa yêu cầu.

### 3.9. Unit tests

Cần có test tối thiểu cho:

* Format alert message đúng.
* Không leak token/secret/password/code trong message.
* Thiếu `TELEGRAM_ADMIN_ALERT_CHAT_ID` không làm app crash.
* Telegram send fail không làm throw raw secret.
* Cooldown hoạt động nếu có implement.
* Alert service gọi đúng Telegram sender mock khi config đầy đủ.

---

## 4. File/thư mục dự kiến tạo/sửa

Claude phải kiểm tra cấu trúc thực tế trước. Nếu project dùng `src/`, tạo dưới `src/`.

Dự kiến tạo mới:

```text
services/alerts/alert-types.ts
services/alerts/alert-sanitizer.ts
services/alerts/alert-message.ts
services/alerts/alert.service.ts
```

Dự kiến test mới:

```text
tests/unit/alerts/alert-sanitizer.test.ts
tests/unit/alerts/alert-message.test.ts
tests/unit/alerts/alert.service.test.ts
```

Có thể sửa nếu cần:

```text
.env.example
lib/env.ts
lib/env.schema.ts
services/telegram/*
services/microsoft/subscription-renewal.service.ts
services/microsoft/delta-polling.service.ts
services/health/*
```

Chỉ sửa các file trên nếu thật sự cần để hoàn thành alert service.

---

## 5. Không được làm

Không được:

* Không tạo Slack/email/PagerDuty provider.
* Không tạo notification UI hoặc alert dashboard mới.
* Không tạo migration/table mới nếu chưa thật sự cần.
* Không đổi cấu trúc folder lớn.
* Không refactor toàn bộ Telegram sender.
* Không refactor toàn bộ health dashboard.
* Không thay đổi OAuth scope.
* Không đọc `.env` hoặc `.env.local`.
* Không in secret/token/code ra terminal.
* Không hardcode `TELEGRAM_ADMIN_ALERT_CHAT_ID`.
* Không hardcode `TELEGRAM_BOT_TOKEN`.
* Không gửi full email body vào alert.
* Không gửi full verification code vào alert.
* Không làm TASK-036 security hardening review.

---

## 6. Tiêu chí nghiệm thu

TASK-035 chỉ đạt khi:

* Có `services/alerts/*` hoặc đường dẫn tương ứng theo cấu trúc thực tế.
* Có type alert và severity rõ ràng.
* Có alert service callable từ các module khác.
* Có Telegram admin alert channel dùng env/config, không hardcode.
* Nếu thiếu admin chat id, app không crash.
* Nếu Telegram alert fail, lỗi được log an toàn và không làm lộ secret.
* Alert message không chứa token/secret/password/full code/full email body.
* Có unit test cho sanitizer/message/service.
* `npm run verify` PASS.
* Gemini review PASS, không còn lỗi Critical/High/Medium.

---

## 7. Lệnh kiểm tra

Chạy các lệnh sau:

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
npm run verify
```

Nếu project chỉ có `npm run verify`, vẫn phải chạy:

```powershell
npm run verify
```

---

## 8. Kết quả Claude phải báo lại

Sau khi làm xong, Claude phải báo:

1. Đã tạo/sửa file nào.
2. Alert types/severity gồm những gì.
3. Alert service gửi qua channel nào.
4. Có fallback gì khi thiếu env.
5. Có chống leak secret/code không.
6. Có chống spam alert không.
7. Đã tích hợp alert vào service nào.
8. Đã chạy lệnh nào.
9. Kết quả PASS/FAIL.
10. Rủi ro còn lại.