
# TASK-015: Tạo code event log page

## 1. Mục tiêu

Tạo trang admin để xem các log sự kiện xử lý verification code trong mock flow hiện tại.

Trang này giúp admin kiểm tra:
- Email verification nào đã được detect.
- Code nào đã được extract ở dạng masked.
- Event nào đã gửi Telegram thành công.
- Event nào bị skip do duplicate.
- Event nào bị skip do confidence thấp.
- Event nào lỗi khi gửi Telegram.

TASK này chỉ làm code event log page, không làm audit log.

---

## 2. Bối cảnh

Các task trước đã có pipeline mock:

mock email → Facebook/Meta detector → code extractor → deduplication → Telegram sender

TASK-015 cần tạo màn hình quan sát kết quả pipeline đó ở admin dashboard.

---

## 3. Yêu cầu chức năng

### 3.1. Route admin

Tạo route:

/admin/logs/code-events

Trang phải có:
- Tiêu đề rõ ràng.
- Mô tả ngắn gọn.
- Summary cards hoặc summary section.
- Bảng danh sách code events.
- Empty state nếu chưa có event.
- Hiển thị status bằng badge hoặc text dễ hiểu.

### 3.2. Code event log service

Tạo service:

services/logs/code-event-log.service.ts

Nếu project đang dùng src/, dùng:

src/services/logs/code-event-log.service.ts

Service này chịu trách nhiệm trả về dữ liệu an toàn cho UI.

Service không được trả full code.

### 3.3. Data shape đề xuất

Tạo type tương tự:

```ts
export type CodeEventStatus =
  | "CODE_DETECTED"
  | "CODE_SENT"
  | "CODE_SKIPPED_DUPLICATE"
  | "CODE_SKIPPED_LOW_CONFIDENCE"
  | "DETECTOR_REJECTED"
  | "EXTRACTOR_FAILED"
  | "TELEGRAM_SEND_FAILED";

export type CodeEventLogItem = {
  id: string;
  createdAt: string;
  receivedAt?: string;
  mailboxEmail: string;
  customerName?: string;
  platform: "Facebook/Meta";
  status: CodeEventStatus;
  maskedCode?: string;
  confidence?: number;
  telegramGroupName?: string;
  source: "mock" | "webhook" | "polling";
  message?: string;
};
````

### 3.4. UI table columns

Bảng nên có các cột:

* Time
* Mailbox
* Customer
* Platform
* Status
* Masked code
* Confidence
* Telegram group
* Source
* Message

### 3.5. Summary

Tạo summary từ danh sách events:

* Total events
* Sent
* Skipped duplicate
* Low confidence
* Failed

### 3.6. Sorting

Mặc định sort newest first.

---

## 4. Yêu cầu bảo mật

Bắt buộc:

* Không hiển thị full verification code.
* Không lưu full code trong log mới.
* Không hiển thị full email body.
* Không hiển thị token/secret/password.
* Không hardcode Telegram bot token.
* Không hardcode Telegram chat ID.
* Không đọc/in file .env.
* Nếu cần code, chỉ dùng maskedCode.
* Nếu cần chống trùng, chỉ dùng codeHash từ task trước nếu đã có.

---

## 5. File/thư mục dự kiến tạo/sửa

Claude phải kiểm tra cấu trúc thực tế trước.

Dự kiến:

```text
docs/tasks/TASK-015-code-event-log-page.md
app/admin/logs/code-events/page.tsx
services/logs/code-event-log.service.ts
```

Có thể thêm nếu phù hợp với cấu trúc hiện có:

```text
components/tables/CodeEventLogTable.tsx
components/status/CodeEventStatusBadge.tsx
tests/unit/logs/code-event-log.service.test.ts
```

Nếu project dùng src/ thì tạo trong src/.

---

## 6. Không được làm trong TASK-015

Không làm:

* Không làm audit log page.
* Không tạo audit log service.
* Không làm TASK-016.
* Không làm Microsoft OAuth.
* Không gọi Microsoft Graph thật.
* Không tạo webhook.
* Không tạo queue worker.
* Không tạo delta polling.
* Không tạo subscription renewal.
* Không sửa Telegram sender ngoài phần cần thiết để đọc log hiện có.
* Không thay đổi database schema lớn nếu không thật sự cần.
* Không expose full code/token/email body.
* Không refactor lớn admin layout.

---

## 7. Test yêu cầu

Tối thiểu nên có test cho service:

* Service trả data có maskedCode, không có full code.
* Summary count đúng.
* Sort newest first.
* Status mapping đúng.
* Empty state không crash.

Nếu project đã có test UI ổn định, thêm test render page/table.

---

## 8. Lệnh kiểm tra

Chạy:

```powershell
npm run verify
```

Nếu cần chạy riêng:

```powershell
npm run lint
npm run typecheck
npm run test
npm run build
```

---

## 9. Tiêu chí nghiệm thu

TASK-015 chỉ PASS khi:

* Truy cập được /admin/logs/code-events.
* Trang hiển thị danh sách code event log.
* Có summary cơ bản.
* Có empty state.
* Không có full verification code trong UI.
* Không có full email body trong UI.
* Không có token/secret/password trong UI/log.
* Không làm audit log.
* Không làm Microsoft OAuth/Graph/webhook.
* npm run verify PASS.
* Gemini review PASS.

---

## 10. Báo cáo sau khi xong

Claude phải báo:

1. Đã làm gì.
2. File nào thay đổi.
3. Lệnh nào đã chạy.
4. Kết quả PASS/FAIL.
5. Có làm vượt scope không.
6. Có rủi ro bảo mật còn lại không.

````

---

# PHẦN RỦI RO CẦN CANH CHỪNG

## 16. Những lỗi Claude dễ mắc ở TASK-015

Lỗi nguy hiểm nhất:

```text
Hiển thị full code trong UI
```

Ví dụ không được có:

```text
Code: 123456
```

Chỉ được:

```text
Code: 12****
```

Các lỗi khác:

```text
Làm luôn audit log của TASK-016
Tạo bảng database mới quá sớm
Tạo Microsoft OAuth sớm
Gọi Graph API thật
Tạo webhook route
Expose full email body
Hardcode Telegram chat ID
Dùng dữ liệu khách hàng thật trong test
```

---

## 17. Kết luận ngắn cho TASK-015

TASK-015 nên được hiểu là:

```text
Tạo màn hình admin để xem log xử lý verification code một cách an toàn.
```

Không phải:

```text
Tạo audit log toàn hệ thống
Tạo Microsoft OAuth
Tạo webhook
Tạo worker
Tạo health dashboard
```

