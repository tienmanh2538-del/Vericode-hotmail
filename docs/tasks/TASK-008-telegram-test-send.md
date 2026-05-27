# TASK-008: Setup Telegram bot config & test-send service

## 1. Mục tiêu

Tạo nền tảng Telegram sending tối thiểu cho project Verification Code Relay Tool.

Sau task này, backend phải có khả năng gửi một tin nhắn test vào Telegram chat/group thông qua Telegram Bot API `sendMessage`.

Task này chỉ kiểm tra năng lực gửi Telegram message từ backend. Chưa làm mapping mailbox/customer với Telegram group, chưa gửi verification code thật, chưa kết nối mock email flow, chưa làm Microsoft OAuth/Graph/webhook.

---

## 2. Bối cảnh dự án

Dự án cuối cùng cần tự động nhận diện email Facebook/Meta verification, extract code và gửi code vào đúng Telegram group của khách hàng.

Tuy nhiên, trước khi xây flow thật, cần xác thực riêng module Telegram:

```text
API nội bộ → Telegram sender service → Telegram Bot API → Telegram group nhận message
```

TASK-008 nằm trong Sprint 2 — Telegram validation.

TASK tiếp theo là TASK-009: Tạo Telegram mapping module.

---

## 3. Nguyên tắc bảo mật bắt buộc

### 3.1. Telegram bot token

Bắt buộc:

- Bot token chỉ được đọc từ biến môi trường.
- Không hardcode bot token trong source code.
- Không commit `.env`.
- Không log bot token ra console/log file.
- Không trả bot token về API response.
- Không đưa token vào test snapshot.
- Không in token trong error message.

Biến môi trường dự kiến:

```env
TELEGRAM_BOT_TOKEN=
```

Nếu project đã có `TELEGRAM_ADMIN_ALERT_CHAT_ID` từ task trước hoặc `.env.example`, không tự ý đổi tên nếu không cần.

---

### 3.2. Telegram chat ID

Trong TASK-008, `chatId` có thể truyền vào API body để test-send.

Không được hardcode chat ID trong code.

Chưa lưu chat ID vào database ở task này.

Việc quản lý mapping chính thức sẽ làm ở TASK-009.

---

### 3.3. Nội dung message test

Tin nhắn test không được chứa:

- Verification code thật.
- Email thật của khách hàng.
- Token.
- Password.
- Full email body.
- Dữ liệu nhạy cảm.

Nội dung mặc định nên là:

```text
✅ Verification Tool Telegram test message
```

Có thể cho phép truyền `text` từ request body nhưng cần giới hạn độ dài.

---

## 4. Phạm vi được làm

Claude chỉ được làm các phần sau:

1. Kiểm tra cấu trúc project thực tế trước khi tạo file.
2. Nếu project dùng `src/`, tạo file trong `src/services/...` và `src/app/...`.
3. Nếu project không dùng `src/`, tạo file trong `services/...` và `app/...`.
4. Cập nhật `.env.example` với `TELEGRAM_BOT_TOKEN=` nếu chưa có.
5. Tạo Telegram sender service.
6. Tạo API route test-send.
7. Validate input cơ bản.
8. Handle lỗi Telegram API an toàn.
9. Không làm lộ bot token trong error response.
10. Viết test cho service.
11. Chạy `npm run verify`.

---

## 5. Phạm vi không được làm

Không được làm trong TASK-008:

1. Không tạo Telegram mapping database module.
2. Không tạo model Prisma mới nếu không thật sự cần cho task này.
3. Không tạo bảng `TelegramMapping`.
4. Không tạo UI quản lý Telegram group.
5. Không tạo route `/api/telegram/mappings`.
6. Không làm customer → telegram mapping.
7. Không làm mailbox → telegram mapping.
8. Không làm mock email input.
9. Không làm Facebook/Meta detector.
10. Không làm code extractor.
11. Không làm processed message/deduplication.
12. Không làm Microsoft OAuth.
13. Không làm Microsoft Graph.
14. Không làm webhook.
15. Không làm queue/worker.
16. Không thêm package nặng nếu dùng native `fetch` được.
17. Không refactor lớn cấu trúc project.
18. Không đổi stack kỹ thuật.
19. Không sửa task khác ngoài những thay đổi tối thiểu cần thiết.

Nếu phát hiện cần làm thêm, phải dừng lại và báo user tách sang task sau.

---

## 6. File/thư mục dự kiến tạo hoặc sửa

Claude phải kiểm tra cấu trúc thực tế trước. Nếu project có `src/`, dùng `src/`. Nếu không có `src/`, dùng root folders.

### Trường hợp project không dùng `src/`

Dự kiến:

```text
.env.example
services/telegram/telegram-sender.service.ts
app/api/telegram/test-send/route.ts
tests/unit/telegram/telegram-sender.service.test.ts
```

Có thể thêm nếu project đang có convention khác:

```text
services/telegram/index.ts
tests/api/telegram-test-send.test.ts
```

### Trường hợp project dùng `src/`

Dự kiến:

```text
.env.example
src/services/telegram/telegram-sender.service.ts
src/app/api/telegram/test-send/route.ts
src/tests/unit/telegram/telegram-sender.service.test.ts
```

Hoặc theo cấu trúc test hiện tại của project.

---

## 7. Thiết kế service

Tạo service:

```text
telegram-sender.service.ts
```

Service nên export:

```ts
type SendTelegramMessageInput = {
  chatId: string;
  text: string;
  parseMode?: "HTML" | "MarkdownV2";
  disableNotification?: boolean;
};

type SendTelegramMessageResult = {
  ok: true;
  messageId?: number;
  chatId: string;
};

async function sendTelegramMessage(input: SendTelegramMessageInput): Promise<SendTelegramMessageResult>;
```

Tên function có thể điều chỉnh theo convention project, nhưng phải rõ nghĩa.

---

## 8. Yêu cầu validate input

### 8.1. `chatId`

Bắt buộc:

- Là string.
- Không rỗng.
- Trim trước khi dùng.
- Chấp nhận group ID dạng số âm, ví dụ:

```text
-1001234567890
```

- Chấp nhận username channel/group dạng:

```text
@my_channel
```

Không cần validate quá phức tạp trong task này.

---

### 8.2. `text`

Bắt buộc:

- Là string.
- Không rỗng.
- Trim trước khi dùng.
- Tối đa 4096 ký tự vì Telegram `sendMessage` giới hạn text message 1–4096 ký tự sau khi parse entities.
- Nếu không truyền text ở API route, dùng default message:

```text
✅ Verification Tool Telegram test message
```

---

## 9. Yêu cầu gọi Telegram Bot API

Service gọi endpoint:

```text
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/sendMessage
```

Method:

```text
POST
```

Content-Type:

```text
application/json
```

Body tối thiểu:

```json
{
  "chat_id": "<chatId>",
  "text": "<text>"
}
```

Có thể thêm:

```json
{
  "disable_notification": true
}
```

Không bắt buộc dùng `parse_mode` ở TASK-008. Nếu dùng `parse_mode`, nên dùng cẩn thận để tránh lỗi escape MarkdownV2.

Khuyến nghị cho task này:

- Không dùng MarkdownV2 mặc định.
- Không dùng HTML mặc định.
- Gửi plain text để tránh lỗi format.

---

## 10. Xử lý lỗi

Service phải xử lý các trường hợp:

### 10.1. Thiếu TELEGRAM_BOT_TOKEN

Nếu env thiếu token:

- Throw lỗi nội bộ dạng safe error.
- Không in token.
- API route trả 500 với message an toàn:

```json
{
  "ok": false,
  "error": "Telegram bot token is not configured"
}
```

Không trả stack trace cho client.

---

### 10.2. Telegram API trả lỗi

Nếu Telegram API trả:

```json
{
  "ok": false,
  "description": "..."
}
```

Service nên throw lỗi an toàn, ví dụ:

```text
Telegram API request failed
```

Có thể giữ `description` nếu không chứa token, nhưng tuyệt đối không kèm URL có token.

API response có thể trả:

```json
{
  "ok": false,
  "error": "Telegram send failed"
}
```

Không trả full Telegram request URL vì URL có chứa bot token.

---

### 10.3. Network error

Nếu fetch lỗi:

- Catch lỗi.
- Không log token.
- Trả response an toàn.

---

## 11. API route test-send

Tạo route:

```text
POST /api/telegram/test-send
```

Request body:

```json
{
  "chatId": "-1001234567890",
  "text": "✅ Verification Tool Telegram test message"
}
```

`text` optional.

Response success:

```json
{
  "ok": true,
  "message": "Telegram test message sent",
  "chatId": "-1001234567890",
  "messageId": 123
}
```

Response validation error:

```json
{
  "ok": false,
  "error": "chatId is required"
}
```

HTTP status gợi ý:

```text
200 success
400 validation error
500 missing config / Telegram API failure
```

Không trả bot token ở bất kỳ response nào.

---

## 12. Test yêu cầu

Tối thiểu cần có unit test cho Telegram sender service.

### Test cases bắt buộc

1. Gửi message thành công:
   - Mock `fetch`.
   - Telegram trả `{ ok: true, result: { message_id: 123 } }`.
   - Service trả `ok: true`.

2. Thiếu `chatId`:
   - Service reject hoặc throw validation error.

3. Thiếu `text` hoặc text rỗng:
   - Service reject hoặc throw validation error.

4. Text dài hơn 4096 ký tự:
   - Service reject hoặc throw validation error.

5. Thiếu `TELEGRAM_BOT_TOKEN`:
   - Service throw safe error.
   - Error không chứa token.

6. Telegram API trả `ok: false`:
   - Service throw safe error.
   - Không expose bot token.

7. Đảm bảo request URL không bị log trong test output.

### Không dùng secret thật trong test

Trong test chỉ dùng token giả:

```text
123456:TEST_FAKE_TOKEN
```

Không dùng token thật lấy từ BotFather.

---

## 13. Cách test thủ công sau khi code xong

### 13.1. Tạo bot Telegram

Người dùng tự làm trong Telegram:

1. Mở Telegram.
2. Tìm `@BotFather`.
3. Gửi `/newbot`.
4. Đặt tên bot.
5. Lưu bot token vào file `.env` local.

Không commit `.env`.

---

### 13.2. Add bot vào group test

1. Tạo group test.
2. Add bot vào group.
3. Gửi một tin nhắn bất kỳ trong group.
4. Lấy `chat_id`.

Cách lấy chat ID có thể làm sau bằng cách gọi Bot API `getUpdates`, nhưng không đưa token vào chat/log public.

---

### 13.3. Thêm env local

Trong `.env` local:

```env
TELEGRAM_BOT_TOKEN=your_real_bot_token_here
```

Không đưa token thật vào `.env.example`.

---

### 13.4. Chạy app

```powershell
npm run dev
```

---

### 13.5. Gửi test request bằng PowerShell

```powershell
$body = @{
  chatId = "-1001234567890"
  text = "✅ Verification Tool Telegram test message"
} | ConvertTo-Json

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/api/telegram/test-send" `
  -ContentType "application/json" `
  -Body $body
```

Kết quả mong muốn:

```json
{
  "ok": true,
  "message": "Telegram test message sent",
  "chatId": "-1001234567890",
  "messageId": 123
}
```

Và trong Telegram group phải nhận được message.

---

## 14. Lệnh kiểm tra bắt buộc

Claude phải chạy:

```powershell
npm run verify
```

Nếu project có test riêng:

```powershell
npm test
```

Hoặc:

```powershell
npm run test
```

Nhưng `npm run verify` là bắt buộc nếu đã tồn tại từ TASK-002.

---

## 15. Tiêu chí nghiệm thu

Task chỉ được coi là hoàn thành khi đạt đủ:

1. Có `TELEGRAM_BOT_TOKEN=` trong `.env.example`.
2. Không có token thật trong source code.
3. Không có token thật trong test.
4. Có Telegram sender service.
5. Có API route `POST /api/telegram/test-send`.
6. API route validate `chatId`.
7. API route có default test message nếu không truyền `text`.
8. Service gọi Telegram Bot API `sendMessage`.
9. Không log bot token.
10. Không trả bot token trong response.
11. Unit test pass.
12. `npm run verify` pass.
13. Không làm Telegram mapping module.
14. Không làm UI Telegram mapping.
15. Không làm parser/mock email/Microsoft/webhook.
16. `git diff` chỉ nằm trong scope TASK-008.

---

## 16. Rủi ro cần chú ý

### Rủi ro 1: Bot token bị lộ

Nguyên nhân:

- Hardcode token.
- Log URL Telegram đầy đủ.
- Trả error chứa URL có token.

Cách tránh:

- Chỉ dùng env.
- Khi báo lỗi, không include request URL.
- Không print process.env.TELEGRAM_BOT_TOKEN.

---

### Rủi ro 2: Gửi nhầm group

Trong TASK-008 chưa có mapping, nên chỉ test với chatId do user truyền vào.

Cách tránh:

- Dùng group test riêng.
- Không dùng group khách hàng thật.
- Message phải ghi rõ đây là test.

---

### Rủi ro 3: Làm vượt scope

Claude dễ làm luôn mapping module hoặc admin UI.

Cách tránh:

- Chỉ tạo sender service + test-send route.
- Nếu muốn làm mapping, dừng lại, để TASK-009.

---

### Rủi ro 4: Build fail khi thiếu token

Không nên làm toàn bộ app build fail chỉ vì local chưa có TELEGRAM_BOT_TOKEN.

Cách đúng:

- Chỉ validate token khi thực sự gọi send message.
- `npm run build` vẫn nên pass nếu không gọi API test-send.

---

## 17. Kết luận task mong muốn từ Claude

Khi xong, Claude phải báo theo format:

```text
1. Đã làm gì
2. File nào đã thay đổi
3. Lệnh nào đã chạy
4. Kết quả npm run verify: PASS/FAIL
5. Cách test thủ công API /api/telegram/test-send
6. Rủi ro còn lại
7. Có làm vượt scope không: Có/Không
```