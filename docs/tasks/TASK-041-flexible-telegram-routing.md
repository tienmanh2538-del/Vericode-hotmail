# TASK-041: Flexible Telegram routing — many mailboxes to one Telegram group/topic

## 1. Mục tiêu

Mở rộng Telegram mapping theo hướng an toàn:

- Cho phép nhiều mailbox Hotmail/Outlook cùng gửi code về cùng một Telegram group.
- Cho phép nhiều mailbox cùng gửi code về cùng một topic trong Telegram group.
- Vẫn giữ nguyên nguyên tắc an toàn: mỗi mailbox chỉ có một Telegram destination chính trong task này.
- Chưa triển khai hướng 1 mailbox gửi tới nhiều Telegram groups/topics.

Ví dụ mong muốn:

```text
hotmail-a@outlook.com ┐
hotmail-b@outlook.com ├──> Telegram Group A
hotmail-c@outlook.com ┘
````

Hoặc:

```text
hotmail-a@outlook.com ┐
hotmail-b@outlook.com ├──> Telegram Group A / Topic Client A
hotmail-c@outlook.com ┘
```

## 2. Bối cảnh

Dự án Verification Code Relay Tool hiện đã có:

* Microsoft OAuth mailbox connection.
* Worker xử lý email verification.
* Facebook/Meta detector.
* Code extractor.
* Deduplication.
* Telegram sender.
* Telegram mapping.
* Code event log.
* Audit log.
* Health/alert.

Hiện tại routing mặc định đang theo hướng an toàn: mailbox gửi code vào Telegram group đã map.

TASK-041 chỉ mở rộng tính linh hoạt theo hướng nhiều mailbox dùng chung một Telegram destination.

## 3. Scope được phép làm

Claude được phép kiểm tra và sửa các phần liên quan trực tiếp đến Telegram mapping/routing:

* Prisma schema và migration nếu cần.
* Telegram mapping service.
* Telegram sender service.
* Email processing / worker nơi resolve destination để gửi Telegram.
* API route liên quan Telegram mapping nếu có.
* Admin UI liên quan Telegram mapping hoặc mailbox detail nếu có.
* Tests unit/integration liên quan mapping/sender/worker.
* Task docs hoặc report liên quan.

## 4. Scope KHÔNG được làm

Không được làm trong TASK-041:

* Không triển khai 1 mailbox gửi tới nhiều Telegram destinations.
* Không thêm multi-platform ngoài Facebook/Meta.
* Không thay đổi Microsoft OAuth scopes.
* Không sửa detector/extractor nếu không cần.
* Không đổi kiến trúc queue/worker lớn.
* Không refactor toàn bộ dashboard.
* Không đọc/in `.env` hoặc `.env.local`.
* Không hardcode Telegram chat ID hoặc bot token.
* Không log full verification code.
* Không log access token / refresh token / client secret / Telegram bot token.
* Không gửi full email body vào Telegram.

## 5. Yêu cầu chức năng

### 5.1. Many mailboxes → same Telegram group

Hệ thống phải cho phép nhiều mailbox có mapping active trỏ tới cùng một `telegramChatId`.

Ví dụ:

```text
mailbox-a -> telegramChatId = -100111
mailbox-b -> telegramChatId = -100111
mailbox-c -> telegramChatId = -100111
```

Không được có unique constraint chặn `telegramChatId` bị dùng lại bởi nhiều mailbox.

### 5.2. Many mailboxes → same Telegram topic

Nếu hệ thống hỗ trợ topic, mapping phải có optional field:

```text
telegramThreadId
telegramTopicName
```

Ví dụ:

```text
mailbox-a -> telegramChatId = -100111, telegramThreadId = 123
mailbox-b -> telegramChatId = -100111, telegramThreadId = 123
mailbox-c -> telegramChatId = -100111, telegramThreadId = 123
```

Không được có unique constraint chặn cùng `telegramChatId + telegramThreadId` bị dùng lại bởi nhiều mailbox.

### 5.3. Một mailbox vẫn chỉ có một destination chính

Trong task này, mỗi mailbox chỉ nên có một active Telegram mapping chính.

Nếu code hiện tại dùng một row mapping cho mỗi mailbox thì giữ nguyên.

Nếu code hiện tại cho phép nhiều mapping mỗi mailbox, Claude phải đảm bảo chỉ một mapping active được dùng khi gửi code trong TASK-041, hoặc báo rõ rủi ro trước khi sửa.

### 5.4. Telegram sender hỗ trợ topic

Khi mapping có `telegramThreadId`, Telegram sender phải truyền thêm `message_thread_id`.

Khi mapping không có `telegramThreadId`, sender gửi vào group chính như hiện tại.

### 5.5. UI hiển thị rõ destination

Admin UI phải hiển thị được:

* Telegram group name.
* Telegram chat ID dạng masked/truncated nếu cần.
* Topic name nếu có.
* Topic/thread ID nếu có.
* Status.
* Mailbox nào đang map tới destination nào.

Nếu dễ làm trong scope, UI nên hiển thị số lượng mailbox đang dùng cùng destination.

### 5.6. Test-send

Test-send phải hỗ trợ cả:

* Gửi test vào group.
* Gửi test vào topic nếu có `telegramThreadId`.

Không được gửi test nếu destination thiếu `telegramChatId`.

## 6. Yêu cầu bảo mật

* Không hardcode Telegram bot token.
* Không hardcode Telegram chat ID.
* Không log full verification code.
* Không log token/secret/password.
* Không đọc/in `.env` hoặc `.env.local`.
* Không gửi code vào group/topic chưa active.
* Thay đổi mapping phải ghi audit log nếu project hiện đã có audit log cho mapping.
* Error message trên UI không được chứa secret hoặc full code.

## 7. Yêu cầu database / Prisma

Claude phải kiểm tra model hiện tại trước khi sửa.

Kết quả mong muốn:

* `telegramChatId` được phép lặp lại giữa nhiều mailbox.
* `telegramThreadId` optional.
* `telegramTopicName` optional.
* Không có unique constraint trên `telegramChatId`.
* Không có unique constraint trên `[telegramChatId, telegramThreadId]`.
* Nếu cần migration, tạo migration đúng chuẩn Prisma.

Tên field khuyến nghị:

```text
telegramChatId String
telegramGroupName String?
telegramThreadId String?
telegramTopicName String?
status TelegramMappingStatus
```

Nếu codebase đang dùng tên field khác, ưu tiên giữ style hiện tại và không rename lớn nếu không cần.

## 8. Yêu cầu service

Service cần có hàm hoặc logic tương đương:

```text
getActiveTelegramDestinationForMailbox(mailboxId)
```

Hàm này trả về destination active của mailbox.

Nếu không có mapping active:

* Không gửi Telegram.
* Ghi log an toàn.
* Trả lỗi nghiệp vụ rõ ràng, không throw lỗi gây crash worker nếu pipeline hiện tại không yêu cầu.

## 9. Yêu cầu tests

Bổ sung hoặc cập nhật test cho các case:

1. Hai mailbox khác nhau có thể dùng cùng `telegramChatId`.
2. Hai mailbox khác nhau có thể dùng cùng `telegramChatId + telegramThreadId`.
3. Sender truyền `message_thread_id` khi mapping có `telegramThreadId`.
4. Sender không truyền `message_thread_id` khi mapping không có topic.
5. Worker/email processing gửi đúng destination theo mailbox.
6. Mailbox không có mapping active thì không gửi Telegram.
7. Không log full code/token/secret trong test/report.

## 10. Lệnh kiểm tra

Sau khi sửa xong, bắt buộc chạy:

```powershell
npm run verify
```

Nếu có Prisma migration, chạy thêm lệnh phù hợp với project hiện tại, ví dụ:

```powershell
npx prisma generate
```

Nếu project dùng test riêng cho Telegram, chạy thêm test liên quan nếu có.

## 11. Tiêu chí nghiệm thu

TASK-041 chỉ PASS khi:

* Nhiều mailbox có thể map tới cùng một Telegram group.
* Nhiều mailbox có thể map tới cùng một Telegram topic.
* Một mailbox vẫn chỉ có một destination chính trong task này.
* Telegram sender gửi đúng `message_thread_id` khi có topic.
* Test-send hoạt động cho group/topic.
* UI/admin hoặc mailbox detail hiển thị rõ destination.
* Không hardcode token/chat ID.
* Không log full verification code/token/secret.
* `npm run verify` PASS.
* Gemini review PASS, không còn Critical/High/Medium issue.

## 12. Báo cáo sau khi làm

Claude phải trả lời theo format:

1. Tôi đã hiểu TASK-041 là gì.
2. File dự kiến tạo/sửa.
3. Những thay đổi đã làm.
4. Prisma migration có hay không.
5. Tests đã thêm/cập nhật.
6. Lệnh đã chạy.
7. Kết quả PASS/FAIL.
8. Rủi ro còn lại.
9. Có làm vượt scope không.

````
