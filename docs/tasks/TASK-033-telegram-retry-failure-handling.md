
# TASK-033: Telegram retry & failure handling

## 1. Mục tiêu

Tăng độ ổn định của bước gửi Telegram trong pipeline xử lý verification code.

Sau task này, khi Telegram Bot API lỗi tạm thời, hệ thống phải retry có kiểm soát theo backoff. Nếu retry hết mà vẫn thất bại, hệ thống phải ghi nhận failure rõ ràng để task sau có thể hiển thị trên health dashboard hoặc gửi alert.

Task này thuộc Sprint 8 — Reliability.

## 2. Bối cảnh

Pipeline hiện tại đã có các phần trước:

```text
Webhook / delta polling
→ queue / worker
→ Graph message fetch
→ Facebook/Meta detector
→ code extractor
→ deduplication
→ Telegram sender
→ logs
````

TASK-033 chỉ tập trung vào đoạn Telegram sender và failure handling.

## 3. Giải thích thuật ngữ

### Retry

Retry nghĩa là thử gửi lại khi lần gửi đầu bị lỗi.

Ví dụ:

```text
Lần 1 gửi Telegram bị lỗi 500
→ đợi 5 giây
→ gửi lại lần 2
```

### Backoff

Backoff nghĩa là mỗi lần retry sau sẽ đợi lâu hơn lần trước.

Backoff mặc định trong task này:

```text
5 giây
15 giây
30 giây
```

### Retryable error

Lỗi có thể retry, ví dụ:

```text
- Telegram API 429 Too Many Requests
- Telegram API 500 / 502 / 503 / 504
- Network timeout
- Fetch/network error tạm thời
```

### Non-retryable error

Lỗi không nên retry, ví dụ:

```text
- 400 Bad Request do payload sai
- 401 Unauthorized do bot token sai
- 403 Forbidden do bot bị kick khỏi group hoặc không có quyền
- 404 Chat not found
```

## 4. Yêu cầu bắt buộc

### 4.1. Retry/backoff

Implement retry cho Telegram sendMessage.

Mặc định:

```text
Initial attempt: gửi ngay
Retry 1: sau 5 giây
Retry 2: sau 15 giây
Retry 3: sau 30 giây
```

Tổng tối đa:

```text
1 lần gửi đầu + 3 lần retry = 4 attempts
```

Không retry vô hạn.

### 4.2. Phân loại lỗi

Phải có logic phân loại lỗi Telegram.

Retry khi:

```text
HTTP 429
HTTP 500
HTTP 502
HTTP 503
HTTP 504
Network error
Timeout
```

Không retry khi:

```text
HTTP 400
HTTP 401
HTTP 403
HTTP 404
Telegram response ok=false với lỗi cấu hình rõ ràng
```

Nếu Telegram trả `retry_after` trong response parameters, có thể dùng `retry_after`, nhưng phải cap hợp lý để test không bị treo.

### 4.3. Kết quả gửi Telegram

Telegram sender phải trả kết quả rõ ràng, ví dụ:

```ts
type TelegramSendResult =
  | {
      ok: true;
      attempts: number;
      telegramMessageId?: number;
    }
  | {
      ok: false;
      attempts: number;
      failureReason: string;
      retryable: boolean;
      statusCode?: number;
    };
```

Tên type có thể khác, nhưng ý nghĩa phải tương đương.

### 4.4. Failure handling

Nếu gửi thành công:

```text
- Giữ hành vi hiện tại.
- Không retry thêm.
- Ghi log success như cũ, nhưng không log full code/token.
```

Nếu gửi thất bại sau retry:

```text
- Không crash worker toàn cục nếu có thể xử lý mềm.
- Mark trạng thái xử lý là TELEGRAM_SEND_FAILED nếu hệ thống đã có status phù hợp.
- Nếu có CodeEventLog service, ghi event failure an toàn.
- Nếu có AuditLog service phù hợp, ghi audit/log vận hành an toàn.
- Không tạo alert service đầy đủ trong task này vì alert service thuộc TASK-035.
```

### 4.5. Không gửi nhầm group

Khi retry, phải dùng cùng `telegramChatId` đã được xác định ban đầu.

Không được:

```text
- Refetch mapping giữa các lần retry rồi vô tình đổi chat ID.
- Hardcode chat ID trong code.
- Gửi vào admin group thay cho group khách.
```

### 4.6. Logging an toàn

Không được log:

```text
- TELEGRAM_BOT_TOKEN
- access token
- refresh token
- client secret
- full verification code
- full email body
```

Log nên dùng:

```text
- mailboxId
- customerId nếu có
- processedMessageId nếu có
- graphMessageId nếu có
- attempt number
- status code
- failure category
- masked/fingerprint code nếu đã có helper
```

Không dùng `console.log` ở production path nếu project đã có logger.

### 4.7. Testability

Retry service phải test được mà không phải chờ thật 5/15/30 giây.

Cách làm đề xuất:

```text
- Inject sleep function.
- Inject retryDelaysMs.
- Trong test dùng delays [1, 1, 1] hoặc sleep fake.
```

## 5. File/thư mục dự kiến liên quan

Claude phải kiểm tra cấu trúc thực tế trước khi sửa. Có thể liên quan:

```text
services/telegram/telegram-sender.service.ts
services/telegram/telegram-mapping.service.ts
services/email/email-processing.service.ts
services/queue/workers/*
services/logs/code-event-log.service.ts
services/logs/audit-log.service.ts
lib/logger.ts
lib/mask.ts
tests/unit/telegram/*
tests/unit/email/*
```

Có thể tạo mới nếu phù hợp:

```text
services/telegram/telegram-retry.service.ts
services/telegram/telegram-error.ts
tests/unit/telegram/telegram-retry.service.test.ts
```

Không được tạo route dashboard/health/alert mới trong task này.

## 6. Yêu cầu test

Cần có test cho các case chính:

### 6.1. Gửi thành công ngay lần đầu

```text
Input: Telegram API trả ok=true lần đầu
Expected:
- attempts = 1
- không gọi sleep
- không retry
```

### 6.2. Lỗi 500 rồi thành công

```text
Input:
- attempt 1: HTTP 500
- attempt 2: ok=true

Expected:
- attempts = 2
- có retry
- kết quả cuối ok=true
```

### 6.3. Lỗi 429 có retry_after

```text
Input:
- attempt 1: HTTP 429, parameters.retry_after
- attempt 2: ok=true

Expected:
- retry được thực hiện
- kết quả cuối ok=true
```

### 6.4. Lỗi 400 không retry

```text
Input: HTTP 400
Expected:
- attempts = 1
- không retry
- ok=false
- retryable=false
```

### 6.5. Lỗi 401/403 không retry

```text
Input: HTTP 401 hoặc 403
Expected:
- attempts = 1
- không retry
- ok=false
- retryable=false
```

### 6.6. Lỗi 503 hết retry vẫn fail

```text
Input:
- attempt 1: 503
- attempt 2: 503
- attempt 3: 503
- attempt 4: 503

Expected:
- attempts = 4
- ok=false
- failureReason rõ ràng
- status/failure log được gọi nếu pipeline có service log
```

### 6.7. Không đổi chat ID giữa các lần retry

```text
Input: cùng một send request bị retry nhiều lần
Expected:
- tất cả attempts dùng cùng telegramChatId ban đầu
```

### 6.8. Không log secret/code plaintext

Test hoặc review thủ công phải đảm bảo:

```text
- Không có TELEGRAM_BOT_TOKEN trong log.
- Không có full verification code trong log.
- Không có full email body trong log.
```

## 7. Không được làm

```text
- Không làm TASK-034 health dashboard.
- Không làm TASK-035 alert service đầy đủ.
- Không thay đổi Microsoft OAuth.
- Không thay đổi Microsoft Graph subscription renewal.
- Không thay đổi delta polling logic trừ khi chỉ để tương thích type.
- Không đổi parser Facebook/Meta.
- Không thêm permission Microsoft.
- Không tạo env secret mới nếu không cần.
- Không đọc/in .env hoặc .env.local.
- Không hardcode Telegram token/chat ID.
- Không log full code.
- Không log token.
- Không gửi full email body vào Telegram.
```

## 8. Lệnh kiểm tra bắt buộc

Chạy tối thiểu:

```powershell
npm run verify
```

Nếu project có test riêng cho Telegram, chạy thêm:

```powershell
npm test -- telegram
```

Nếu project dùng Vitest trực tiếp, có thể chạy:

```powershell
npx vitest run tests/unit/telegram
```

Claude phải báo rõ lệnh nào đã chạy và kết quả PASS/FAIL.

## 9. Tiêu chí nghiệm thu

Task chỉ đạt khi:

```text
[ ] Telegram sender có retry/backoff có kiểm soát.
[ ] Retry mặc định tương đương 5s / 15s / 30s hoặc được config rõ ràng.
[ ] Không retry với lỗi permanent như 400/401/403/404.
[ ] Có xử lý 429/5xx/network error.
[ ] Có max attempts, không retry vô hạn.
[ ] Sau khi retry hết vẫn fail, hệ thống trả/ghi trạng thái failure rõ ràng.
[ ] Không log bot token.
[ ] Không log full verification code.
[ ] Không log full email body.
[ ] Không hardcode Telegram chat ID.
[ ] Retry dùng cùng chat ID ban đầu.
[ ] Có unit test cho success, retry success, non-retryable fail, exhausted retry fail.
[ ] npm run verify PASS.
[ ] Gemini review PASS.
```

## 10. Báo cáo cuối task Claude phải trả về

Claude phải kết luận theo format:

```text
1. Đã làm gì
2. File nào thay đổi
3. Lệnh nào đã chạy
4. Kết quả PASS/FAIL
5. Rủi ro còn lại
6. Có làm vượt scope không
7. Đề xuất task tiếp theo
```

````

---

# 11. Những lỗi Claude dễ mắc ở TASK-033

## Lỗi 1: Retry tất cả lỗi

Sai:

```text
400 / 401 / 403 / 404 cũng retry
```

Đúng:

```text
400/401/403/404 thường là lỗi cấu hình/quyền/chat không tồn tại, retry nhiều lần không giúp gì.
```

---

## Lỗi 2: Retry vô hạn

Sai:

```text
while true retry
```

Đúng:

```text
Tối đa 4 attempts.
```

---

## Lỗi 3: Chờ thật trong unit test

Sai:

```text
Test phải đợi 5s + 15s + 30s thật.
```

Đúng:

```text
Inject fake sleep hoặc retryDelaysMs nhỏ trong test.
```

---

## Lỗi 4: Log full code khi gửi lỗi

Sai:

```text
logger.error("Failed to send code 123456")
```

Đúng:

```text
logger.error("Telegram send failed", {
  mailboxId,
  processedMessageId,
  attempt,
  statusCode,
  failureReason,
  codeRef: maskedCodeOrHash
})
```

Security rules yêu cầu không hardcode secret, không đọc/in `.env`, không log plaintext verification code, token, bot token; logger phải mask các key nhạy cảm và không dùng `console.log` trong production path. 

---

## Lỗi 5: Refetch mapping giữa retry

Sai:

```text
Attempt 1 gửi chat A fail
Attempt 2 refetch mapping và gửi chat B
```

Đúng:

```text
Pipeline resolve mapping một lần → retry dùng cùng chatId đó.
```

Quy tắc bảo mật của dự án nhấn mạnh mỗi mailbox/customer phải map đúng Telegram group, không hardcode bot token/chat ID, không gửi code vào group chưa map. 

---

