# TASK-014: Kết nối mock flow: mock email → detect → extract → dedupe → Telegram

## 1. Mục tiêu

Tạo service xử lý mock email end-to-end để nối các module đã hoàn thành ở Sprint 3:

```text
mock email → Facebook/Meta detector → code extractor → deduplication → Telegram sender
````

Task này là bước tích hợp mock flow trước khi chuyển sang Microsoft OAuth / Graph API ở Sprint sau.

---

## 2. Bối cảnh

Các task trước đã tạo các phần riêng lẻ:

* TASK-010: mock email input
* TASK-011: Facebook/Meta verification detector
* TASK-012: code extractor module
* TASK-013: processed message & deduplication service
* TASK-008/TASK-009: Telegram sender / mapping foundation

TASK-014 không viết lại các module trên. TASK-014 chỉ tạo service điều phối, gọi đúng các module đã có, xử lý kết quả và đảm bảo không gửi trùng.

---

## 3. Yêu cầu chức năng

### 3.1. Tạo email processing service

Tạo file:

```text
services/email/email-processing.service.ts
```

Hoặc nếu project dùng `src/`:

```text
src/services/email/email-processing.service.ts
```

Service phải export hàm chính, ví dụ:

```ts
processMockEmail(input)
```

Tên hàm có thể điều chỉnh theo convention hiện có, nhưng phải rõ nghĩa.

---

### 3.2. Input

Input cần chứa tối thiểu:

```ts
{
  messageId: string;
  mailboxId?: string;
  mailboxEmail: string;
  from: string;
  subject: string;
  textBody?: string;
  htmlBody?: string;
  receivedAt: string | Date;
  telegramChatId?: string;
}
```

Nếu project đã có type mock email từ TASK-010 thì ưu tiên reuse type đó.

---

### 3.3. Output

Output phải rõ ràng, không chỉ return boolean.

Gợi ý:

```ts
type EmailProcessingStatus =
  | "SENT"
  | "SKIPPED_NOT_FACEBOOK_VERIFICATION"
  | "SKIPPED_LOW_CONFIDENCE"
  | "SKIPPED_NO_CODE"
  | "SKIPPED_DUPLICATE"
  | "SKIPPED_NO_TELEGRAM_MAPPING"
  | "FAILED_TELEGRAM_SEND"
  | "FAILED_UNEXPECTED";

type EmailProcessingResult = {
  status: EmailProcessingStatus;
  success: boolean;
  messageId: string;
  mailboxEmail: string;
  platform?: "facebook" | "meta";
  maskedCode?: string;
  confidence?: number;
  reason?: string;
};
```

Không return full code trong result nếu result có thể bị log hoặc hiển thị ở UI/test report. Nếu cần gửi Telegram thì full code chỉ được truyền nội bộ vào Telegram sender, không đưa vào log.

---

### 3.4. Luồng xử lý bắt buộc

Service phải xử lý theo thứ tự:

```text
1. Validate input cơ bản.
2. Gọi Facebook/Meta verification detector.
3. Nếu detector fail hoặc confidence thấp → skip, không extract/gửi.
4. Gọi code extractor.
5. Nếu extract fail hoặc confidence thấp → skip, không gửi.
6. Gọi deduplication service để kiểm tra message/code đã xử lý chưa.
7. Nếu duplicate → skip, không gửi.
8. Xác định Telegram chat id từ input hoặc mapping service hiện có.
9. Nếu không có Telegram chat id → skip.
10. Gửi Telegram bằng Telegram sender service đã có.
11. Nếu gửi thành công → mark processed.
12. Return result SENT.
13. Nếu Telegram lỗi → return FAILED_TELEGRAM_SEND, không crash app.
```

---

## 4. Yêu cầu bảo mật

* Không log full verification code.
* Không log full email body.
* Không log Telegram bot token.
* Không hardcode Telegram chat ID.
* Không hardcode secret trong code.
* Nếu cần lưu/so sánh code thì dùng hash/masked code theo service TASK-013/TASK-012.
* Test chỉ dùng email/code giả.

---

## 5. Không được làm trong task này

* Không tạo Microsoft OAuth.
* Không gọi Microsoft Graph API thật.
* Không tạo webhook.
* Không tạo queue/worker.
* Không tạo delta polling.
* Không tạo log page TASK-015.
* Không tạo audit log page TASK-016.
* Không refactor lớn các module đã có nếu không cần.
* Không thay đổi schema database ngoài phạm vi cần thiết.
* Không đổi stack kỹ thuật.

---

## 6. Test case bắt buộc

### Case 1: Email hợp lệ, chưa duplicate

Input là Facebook/Meta verification email hợp lệ, có code 5–8 chữ số, có Telegram chat id.

Kỳ vọng:

```text
status = SENT
success = true
Telegram sender được gọi đúng 1 lần
dedupe mark processed được gọi
result không chứa full code nếu không cần
```

---

### Case 2: Không phải email Facebook/Meta

Input là email bình thường hoặc newsletter.

Kỳ vọng:

```text
status = SKIPPED_NOT_FACEBOOK_VERIFICATION
Telegram sender không được gọi
dedupe không mark processed
```

---

### Case 3: Email hợp lệ nhưng không extract được code

Kỳ vọng:

```text
status = SKIPPED_NO_CODE hoặc SKIPPED_LOW_CONFIDENCE
Telegram sender không được gọi
```

---

### Case 4: Email duplicate

Deduplication service báo đã xử lý.

Kỳ vọng:

```text
status = SKIPPED_DUPLICATE
Telegram sender không được gọi
```

---

### Case 5: Không có Telegram mapping/chat id

Kỳ vọng:

```text
status = SKIPPED_NO_TELEGRAM_MAPPING
Không crash
Không mark processed là sent
```

---

### Case 6: Telegram send fail

Telegram sender throw hoặc return fail.

Kỳ vọng:

```text
status = FAILED_TELEGRAM_SEND
success = false
Không throw ra ngoài nếu service design đang dùng safe result
Không log token/code
```

---

## 7. Lệnh kiểm tra

Sau khi sửa code phải chạy:

```powershell
npm run verify
```

Nếu có test riêng:

```powershell
npm test
```

Hoặc lệnh test hiện có trong package.json.

---

## 8. Acceptance Criteria

Task chỉ được coi là hoàn thành khi:

* Có email processing service điều phối được toàn bộ mock flow.
* Detector, extractor, dedupe, Telegram sender được gọi đúng thứ tự.
* Không gửi Telegram nếu detector/extractor confidence thấp.
* Không gửi Telegram nếu duplicate.
* Không hardcode secret/chat id/token.
* Không log full code/full email body.
* Có test cho happy path và các skip/failure path quan trọng.
* `npm run verify` PASS.
* Gemini review PASS.

````

---

