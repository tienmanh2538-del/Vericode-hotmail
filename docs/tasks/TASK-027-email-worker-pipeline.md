
# TASK-027: Worker xử lý Graph message → detector → extractor → Telegram

## 1. Mục tiêu

TASK-027 nối queue/worker foundation từ TASK-026 với pipeline xử lý email thật.

Khi worker nhận job chứa `mailboxId` và `graphMessageId`, hệ thống phải:

1. Load mailbox từ database.
2. Kiểm tra mailbox còn ACTIVE.
3. Dùng Microsoft Graph mail service để fetch message detail.
4. Không tin toàn bộ payload webhook; luôn fetch lại message từ Graph.
5. Kiểm tra email có phải Facebook/Meta verification email bằng detector đã có.
6. Trích xuất verification code bằng code extractor đã có.
7. Chống gửi trùng bằng deduplication service/ProcessedMessage.
8. Tìm Telegram mapping đang active của mailbox.
9. Gửi code vào đúng Telegram group.
10. Ghi code event log/audit log an toàn.
11. Không log token, không log full email body, không lưu full code lâu dài.

Đây là task đầu tiên biến webhook/queue thành luồng xử lý thật end-to-end ở backend.

---

## 2. Bối cảnh

Các task liên quan trước đó:

- TASK-011: Facebook/Meta verification detector.
- TASK-012: Code extractor module.
- TASK-013: Processed message & deduplication service.
- TASK-014: Mock flow email → detect → extract → dedupe → Telegram.
- TASK-015: Code event log page/service.
- TASK-016: Audit log service/page.
- TASK-022: Microsoft Graph mail service đọc Inbox/message detail.
- TASK-025: Webhook receiver cho notification thật.
- TASK-026: Queue & worker foundation.

TASK-027 không làm lại các module trên. Chỉ tích hợp chúng vào pipeline thật cho Graph message.

---

## 3. Input chính của worker job

Worker job nên nhận tối thiểu:

```ts
type GraphMessageProcessingJob = {
  mailboxId: string;
  graphMessageId: string;
  source: "webhook" | "manual" | "test";
  subscriptionId?: string | null;
  internetMessageId?: string | null;
  receivedNotificationAt?: string | null;
};
````

Trong đó:

* `mailboxId`: ID mailbox trong database.
* `graphMessageId`: ID message từ Microsoft Graph notification.
* `source`: nguồn job, chủ yếu là `webhook`.
* `subscriptionId`: nếu webhook có gửi kèm.
* `internetMessageId`: optional, chỉ dùng nếu đã có.
* `receivedNotificationAt`: thời điểm hệ thống nhận webhook.

Không đưa token, refresh token, client secret, Telegram bot token vào job payload.

---

## 4. Output/kết quả xử lý

Pipeline nên trả về một result rõ ràng để test được:

```ts
type EmailProcessingStatus =
  | "CODE_SENT"
  | "SKIPPED_DUPLICATE"
  | "SKIPPED_MAILBOX_NOT_ACTIVE"
  | "SKIPPED_NOT_FACEBOOK_VERIFICATION"
  | "SKIPPED_LOW_CONFIDENCE"
  | "SKIPPED_NO_CODE"
  | "SKIPPED_NO_TELEGRAM_MAPPING"
  | "FAILED_GRAPH_FETCH"
  | "FAILED_TELEGRAM_SEND"
  | "FAILED_RECONNECT_REQUIRED"
  | "FAILED_UNEXPECTED";
```

Kết quả nên có:

```ts
type EmailProcessingResult = {
  ok: boolean;
  status: EmailProcessingStatus;
  mailboxId: string;
  graphMessageId: string;
  internetMessageId?: string | null;
  maskedCode?: string | null;
  detectorConfidence?: number | null;
  sentToTelegram?: boolean;
  reason?: string;
};
```

Không trả full code trong result nếu result được log ra console/test report.

---

## 5. Luồng xử lý chi tiết

### Step 1 — Validate job payload

Worker phải kiểm tra:

* Có `mailboxId`.
* Có `graphMessageId`.
* `source` hợp lệ.

Nếu thiếu dữ liệu bắt buộc, return `FAILED_UNEXPECTED` hoặc một status validation fail nội bộ.

Không throw lỗi không kiểm soát cho input xấu.

---

### Step 2 — Load mailbox

Tìm mailbox theo `mailboxId`.

Nếu không tồn tại:

* Không gọi Graph.
* Không gửi Telegram.
* Ghi log an toàn.
* Return `FAILED_UNEXPECTED` hoặc status tương ứng.

Nếu mailbox không ở trạng thái `ACTIVE`:

* Không gọi Graph.
* Không gửi Telegram.
* Return `SKIPPED_MAILBOX_NOT_ACTIVE`.

Không expose encrypted refresh token trong log/result.

---

### Step 3 — Fetch message detail từ Microsoft Graph

Dùng service đã có từ TASK-022.

Chỉ fetch các field cần thiết:

* `id`
* `internetMessageId`
* `from`
* `sender`
* `subject`
* `receivedDateTime`
* `bodyPreview`
* `body`
* `toRecipients`

Không tải attachment.

Không đọc folder khác ngoài Inbox trong MVP.

Nếu Graph fetch lỗi do token/reconnect required:

* Mark mailbox status phù hợp nếu service hiện tại đã hỗ trợ.
* Return `FAILED_RECONNECT_REQUIRED`.
* Không gửi Telegram.

Nếu Graph fetch lỗi khác:

* Return `FAILED_GRAPH_FETCH`.
* Ghi log an toàn, không log token.

---

### Step 4 — Deduplicate sớm theo message

Trước khi parse/sending, kiểm tra message đã xử lý chưa.

Dedup key ưu tiên:

1. `mailboxId + graphMessageId`
2. `mailboxId + internetMessageId`

Nếu đã xử lý thành công hoặc đã skip có chủ đích:

* Không gửi lại Telegram.
* Return `SKIPPED_DUPLICATE`.

Nếu project hiện tại chỉ có dedupe sau khi extract code, Claude được phép thêm check sớm nếu không phá schema hiện tại.

---

### Step 5 — Build detector input

Tạo input cho detector từ message detail:

```ts
{
  fromAddress,
  fromName,
  senderAddress,
  subject,
  bodyPreview,
  bodyContent,
  bodyContentType,
  receivedDateTime,
  toRecipients
}
```

Không truyền toàn bộ raw Graph response sang detector nếu không cần.

---

### Step 6 — Detect Facebook/Meta verification email

Dùng `facebook-detector.service.ts` đã có.

Chỉ tiếp tục nếu detector xác định email hợp lệ và confidence đủ ngưỡng.

Ngưỡng đề xuất:

```text
confidence >= 70
```

Nếu không phải Facebook/Meta verification email:

* Ghi code event log dạng skipped.
* Không gửi Telegram.
* Return `SKIPPED_NOT_FACEBOOK_VERIFICATION`.

Nếu confidence thấp:

* Ghi log `CODE_SKIPPED_LOW_CONFIDENCE` hoặc action tương đương.
* Không gửi Telegram.
* Return `SKIPPED_LOW_CONFIDENCE`.

Không được lấy số đầu tiên trong email làm code.

---

### Step 7 — Extract verification code

Dùng `code-extractor.service.ts` đã có.

Điều kiện tiếp tục:

* Extractor success.
* Có code hợp lệ 5–8 chữ số.
* Confidence đủ ngưỡng theo module extractor hiện tại.

Nếu không có code:

* Không gửi Telegram.
* Ghi log an toàn.
* Return `SKIPPED_NO_CODE`.

Không log full code.

---

### Step 8 — Deduplicate theo code/message

Sau khi có code, kiểm tra chống trùng lần nữa bằng:

* `mailboxId + graphMessageId`
* `internetMessageId`
* `mailboxId + codeHash + receivedAt rounded`

Chỉ lưu `codeHash`, không lưu full code.

Nếu trùng:

* Không gửi Telegram.
* Return `SKIPPED_DUPLICATE`.

---

### Step 9 — Load Telegram mapping

Tìm Telegram mapping active theo `mailboxId`.

Nếu không có mapping:

* Không gửi Telegram.
* Ghi log `SKIPPED_NO_TELEGRAM_MAPPING`.
* Return `SKIPPED_NO_TELEGRAM_MAPPING`.

Không hardcode Telegram chat ID trong code.

---

### Step 10 — Send Telegram

Gửi message vào đúng `telegramChatId` từ database mapping.

Message format nên tối giản:

```text
🔐 Facebook verification code

Email: client-a@hotmail.com
Code: 123456
Received: 2026-05-21 14:30:20
```

Không gửi:

* Full email body.
* Full email header.
* Access link.
* Token.
* Refresh token.
* Client secret.
* Thông tin nhạy cảm không cần thiết.

Lưu ý: TASK-033 sẽ làm retry/backoff hoàn chỉnh cho Telegram. Trong TASK-027, chỉ dùng khả năng gửi hiện có. Nếu gửi lỗi, return `FAILED_TELEGRAM_SEND` và ghi log an toàn.

---

### Step 11 — Ghi processed message/code event/audit log

Khi gửi thành công:

* Lưu processed message với `graphMessageId`, `internetMessageId`, `codeHash`, status sent.
* Ghi code event log với masked code.
* Ghi audit log/action nếu project hiện tại có audit service phù hợp.
* Cập nhật `sentToTelegramAt`.

Không lưu full code trong DB/log.

Ví dụ masked code:

```text
123456 -> 12****
12345  -> 12***
12345678 -> 12******
```

---

## 6. Yêu cầu bảo mật bắt buộc

Claude phải đảm bảo:

* Không log access token.
* Không log refresh token.
* Không log Microsoft client secret.
* Không log Telegram bot token.
* Không log full verification code.
* Không log full email body nếu không cần.
* Không lưu full code vào database.
* Không hardcode Telegram chat ID.
* Không hardcode Telegram bot token.
* Không gửi code vào mailbox chưa có mapping.
* Không gửi Telegram nếu detector/extractor confidence thấp.

---

## 7. Không được làm trong TASK-027

Không làm các việc sau:

* Không tạo delta polling backup worker. Việc đó thuộc TASK-031.
* Không tạo subscription renewal worker. Việc đó thuộc TASK-032.
* Không làm Telegram retry/backoff đầy đủ. Việc đó thuộc TASK-033.
* Không tạo health dashboard. Việc đó thuộc TASK-034.
* Không tạo alert service đầy đủ. Việc đó thuộc TASK-035.
* Không làm mailbox list/detail UI. Việc đó thuộc TASK-028/TASK-029.
* Không đọc attachment.
* Không đọc toàn bộ mailbox history.
* Không hỗ trợ platform ngoài Facebook/Meta.
* Không refactor lớn toàn bộ project.
* Không thay đổi schema database nếu không thật sự cần. Nếu cần thay đổi schema, Claude phải giải thích rõ lý do trước.

---

## 8. File/thư mục dự kiến tạo/sửa

Claude phải kiểm tra cấu trúc thực tế trước. Nếu project dùng `src/`, dùng `src/...`.

Dự kiến có thể sửa/tạo:

```text
services/email/email-processing.service.ts
services/queue/workers/*
services/queue/email-queue.ts
services/microsoft/graph-mail.service.ts
services/email/facebook-detector.service.ts
services/email/code-extractor.service.ts
services/email/deduplication.service.ts
services/telegram/telegram-sender.service.ts
services/telegram/telegram-mapping.service.ts
services/logs/code-event-log.service.ts
services/logs/audit-log.service.ts
tests/unit/email/email-processing.service.test.ts
tests/unit/queue/*
```

Không tạo song song cả `services/` và `src/services/`.

---

## 9. Test bắt buộc

Phải có unit/integration test tối thiểu cho các case:

### Case 1 — Gửi thành công

Input:

* Mailbox ACTIVE.
* Graph fetch trả về email Facebook/Meta hợp lệ.
* Detector confidence >= 70.
* Extractor lấy được code.
* Message chưa bị dedupe.
* Có Telegram mapping active.
* Telegram sender success.

Expected:

* Return `CODE_SENT`.
* Gọi Telegram sender đúng chat ID.
* Lưu processed message.
* Log masked code, không log full code.

---

### Case 2 — Duplicate message

Input:

* Message đã xử lý trước đó.

Expected:

* Return `SKIPPED_DUPLICATE`.
* Không gọi Telegram sender.

---

### Case 3 — Not Facebook/Meta verification

Input:

* Email không phải Facebook/Meta verification.

Expected:

* Return `SKIPPED_NOT_FACEBOOK_VERIFICATION`.
* Không gọi extractor nếu detector đã fail rõ ràng.
* Không gọi Telegram sender.

---

### Case 4 — Low confidence

Input:

* Detector hoặc extractor confidence thấp.

Expected:

* Return `SKIPPED_LOW_CONFIDENCE`.
* Không gửi Telegram.

---

### Case 5 — No Telegram mapping

Input:

* Email hợp lệ, code hợp lệ, nhưng mailbox chưa map Telegram.

Expected:

* Return `SKIPPED_NO_TELEGRAM_MAPPING`.
* Không gửi Telegram.
* Có log an toàn.

---

### Case 6 — Graph fetch failed

Input:

* Graph mail service lỗi.

Expected:

* Return `FAILED_GRAPH_FETCH` hoặc `FAILED_RECONNECT_REQUIRED`.
* Không gọi detector/extractor/Telegram.
* Không log token.

---

### Case 7 — Telegram send failed

Input:

* Tất cả bước trước pass nhưng Telegram sender lỗi.

Expected:

* Return `FAILED_TELEGRAM_SEND`.
* Ghi log fail an toàn.
* Không crash worker.

---

## 10. Lệnh kiểm tra

Claude phải chạy:

```powershell
npm run verify
```

Nếu project có test riêng phù hợp, chạy thêm:

```powershell
npm test
```

Hoặc:

```powershell
npm run test
```

Nếu có Prisma/schema thay đổi, chạy thêm lệnh phù hợp với project hiện tại, ví dụ:

```powershell
npx prisma validate
npx prisma generate
```

Không chạy lệnh destructive như reset database nếu chưa được user duyệt.

---

## 11. Tiêu chí nghiệm thu

TASK-027 chỉ pass khi:

* Worker nhận job Graph message và gọi pipeline xử lý thật.
* Có service/function xử lý rõ ràng, test được độc lập.
* Email được fetch lại từ Graph, không tin payload webhook.
* Detector và extractor được dùng đúng.
* Không gửi nếu confidence thấp.
* Không gửi nếu duplicate.
* Không gửi nếu không có Telegram mapping.
* Gửi đúng Telegram chat ID từ database mapping.
* Không hardcode Telegram chat ID.
* Không log token/secret/full code.
* Code event/processed message/audit log được ghi an toàn theo khả năng hiện có của project.
* `npm run verify` PASS.
* Gemini review PASS.

---

## 12. Báo cáo sau khi Claude làm xong

Claude phải báo theo format:

```text
1. Đã làm gì
2. File nào đã tạo/sửa
3. Luồng xử lý worker hiện tại
4. Test đã thêm
5. Lệnh đã chạy
6. Kết quả PASS/FAIL
7. Rủi ro còn lại
8. Những việc KHÔNG làm vì thuộc task sau
```

Không báo chung chung.



# 10. Những lỗi Claude rất dễ mắc ở TASK-027

## Lỗi 1 — Làm quá sang TASK-031/TASK-033

TASK-027 không phải delta polling và cũng chưa phải retry/backoff Telegram đầy đủ.

Nếu Claude bắt đầu tạo:

```text
delta-polling.service.ts
subscription-renewal.service.ts
telegram-retry-worker.ts
health dashboard
alert service
```

thì phải yêu cầu dừng hoặc tách sang task sau.

---

## Lỗi 2 — Gửi Telegram ngay trong webhook

Sai.

Webhook chỉ nên:

```text
validate notification
→ push job
→ return 2xx
```

Worker mới gửi Telegram.

---

## Lỗi 3 — Tin payload webhook thay vì fetch Graph

Sai.

Notification từ webhook chỉ nên cung cấp ID/signal. Worker phải fetch lại message detail từ Graph trước khi parse.

---

## Lỗi 4 — Gửi code khi không có Telegram mapping

Sai nghiêm trọng.

Nếu mailbox chưa map group, phải skip và log. Không được dùng chat ID mặc định/hardcode.

---

## Lỗi 5 — Log full code

Sai bảo mật.

Full code chỉ dùng để gửi Telegram. Log/DB chỉ nên lưu masked/hash. Project context yêu cầu không lưu/log full verification code và nếu cần chống trùng thì chỉ lưu `codeHash`. 

---