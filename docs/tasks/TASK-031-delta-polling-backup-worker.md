\# TASK-031: Tạo delta polling backup worker



\## 1. Mục tiêu



Tạo cơ chế Microsoft Graph delta polling backup worker để hệ thống vẫn phát hiện email mới trong Inbox khi webhook bị miss, webhook URL lỗi, Microsoft notification chậm, hoặc subscription tạm thời không gửi event.



Delta polling là lớp dự phòng cho webhook, không thay thế webhook.



Mục tiêu vận hành:



```text

Webhook realtime là primary.

Delta polling chạy mỗi 30 giây là backup.

Nếu có email mới trong mailbox ACTIVE, worker đẩy message vào cùng pipeline xử lý Graph message đã có từ TASK-027.

````



\## 2. Bối cảnh



Các task trước đã có:



\* TASK-022: Microsoft Graph mail service đọc Inbox test.

\* TASK-023: Graph subscription service.

\* TASK-024/TASK-025: Microsoft webhook endpoint và notification receiver.

\* TASK-026: Queue \& worker foundation.

\* TASK-027: Worker xử lý Graph message → detector → extractor → Telegram.

\* TASK-028/TASK-029/TASK-030: Mailbox dashboard và connect mailbox UI.



TASK-031 chỉ thêm lớp backup polling, không làm lại pipeline xử lý email.



\## 3. Yêu cầu chức năng



\### 3.1. Poll mailbox ACTIVE



Worker phải lấy danh sách mailbox Microsoft đang ở trạng thái ACTIVE.



Không poll các mailbox có trạng thái:



```text

RECONNECT\_REQUIRED

SUBSCRIPTION\_EXPIRED

WEBHOOK\_FAILED

DISABLED

ERROR

```



Trường hợp project hiện tại dùng enum/status khác, Claude phải map theo cấu trúc thực tế, nhưng không được tự ý đổi toàn bộ enum nếu không cần.



\### 3.2. Chỉ poll Inbox



MVP chỉ đọc Inbox.



Endpoint định hướng:



```text

/me/mailFolders('Inbox')/messages/delta

```



hoặc endpoint tương đương đang được Graph mail service hiện tại dùng.



Không đọc Sent, Archive, Junk, Deleted Items hoặc toàn bộ mailbox history.



\### 3.3. Dùng delta cursor an toàn



Service phải lưu cursor per mailbox.



Cursor nên là full URL trả về từ Microsoft Graph:



```text

@odata.nextLink

@odata.deltaLink

```



Quy tắc:



\* Không tự parse `$skiptoken` hoặc `$deltatoken`.

\* Không tự sửa token.

\* Không build lại URL từ token.

\* Lưu full cursor URL và dùng lại cho lần poll sau.

\* Nếu có `@odata.nextLink`, tiếp tục gọi cho đến khi nhận được `@odata.deltaLink`, nhưng phải có giới hạn số page để tránh loop vô hạn.

\* Nếu có `@odata.deltaLink`, lưu lại để lần sau dùng.



Tên field DB gợi ý:



```text

mailboxes.microsoftDeltaCursor

mailboxes.deltaLastPolledAt

mailboxes.deltaLastErrorAt

mailboxes.deltaLastErrorMessage

```



Tuy nhiên Claude phải kiểm tra `prisma/schema.prisma` hiện tại trước. Nếu đã có field tương đương thì dùng lại, không tạo field trùng.



\### 3.4. Bootstrap lần đầu không gửi lại email cũ



Nếu mailbox chưa có delta cursor:



\* Chạy initial delta sync để lấy cursor ban đầu.

\* Không enqueue toàn bộ email cũ.

\* Sau khi nhận được deltaLink, lưu cursor.

\* Log an toàn rằng mailbox đã bootstrap delta cursor.



Lý do: tránh gửi lại hàng loạt code/email cũ vào Telegram.



Nếu cần giới hạn initial sync, có thể dùng filter receivedDateTime gần đây theo khả năng hiện tại của service, nhưng vẫn phải ưu tiên không enqueue lịch sử cũ.



\### 3.5. Chỉ enqueue message mới



Ở các lần poll sau khi đã có cursor:



\* Lấy các message thay đổi từ delta response.

\* Bỏ qua item có `@removed`.

\* Bỏ qua item không có `id`.

\* Bỏ qua update/delete/read-unread event nếu xuất hiện.

\* Với mỗi message mới hợp lệ, enqueue job vào queue/pipeline xử lý Graph message đã có từ TASK-027.



Payload job tối thiểu:



```ts

{

&#x20; mailboxId: string;

&#x20; graphMessageId: string;

&#x20; source: "delta-polling";

}

```



Nếu queue hiện tại đã có format khác, dùng format hiện tại, nhưng phải có cách phân biệt source là delta polling nếu không làm vỡ code.



\### 3.6. Không xử lý nặng trong polling service



Delta polling service không được:



\* gọi detector trực tiếp,

\* gọi extractor trực tiếp,

\* gọi Telegram sender trực tiếp,

\* ghi full email body,

\* lưu full code,

\* bypass deduplication.



Nó chỉ phát hiện message id mới và enqueue vào pipeline đã có.



\### 3.7. Deduplication vẫn nằm ở pipeline xử lý email



Nếu cùng một message được webhook và delta polling enqueue cùng lúc, pipeline TASK-027/TASK-013 phải chống trùng.



TASK-031 không được tạo cơ chế dedupe song song làm lệch logic hiện tại, trừ khi chỉ check nhẹ trước enqueue bằng processed\_messages hiện có và không làm thay đổi hành vi chính.



\### 3.8. Scheduler 30 giây



Cần có scheduler/runner chạy mỗi 30 giây.



Yêu cầu:



\* Có hàm `runDeltaPollingOnce()` để test.

\* Có worker/scheduler chạy vòng lặp 30 giây.

\* Không chạy scheduler tự động khi import module trong unit test.

\* Có cách tắt/bật qua env nếu project hiện tại đã có env config.



Env gợi ý, nếu cần:



```env

DELTA\_POLLING\_ENABLED=true

DELTA\_POLLING\_INTERVAL\_SECONDS=30

DELTA\_POLLING\_MAX\_PAGES\_PER\_MAILBOX=10

```



Không bắt buộc thêm env nếu queue foundation đã có cấu hình scheduler chuẩn.



\### 3.9. Error handling



Nếu poll một mailbox lỗi:



\* Không làm toàn bộ worker crash.

\* Log lỗi an toàn.

\* Cập nhật `deltaLastErrorAt` / `deltaLastErrorMessage` nếu schema có field.

\* Tiếp tục xử lý mailbox khác.



Nếu lỗi token/authorization rõ ràng:



\* Mark mailbox `RECONNECT\_REQUIRED` nếu project hiện tại đã có helper/status cho việc này.

\* Không alert trong task này, vì alert service là TASK-035.



Nếu Microsoft Graph trả lỗi transient như 429/5xx:



\* Log an toàn.

\* Không xoá cursor cũ.

\* Lần sau retry bằng cursor cũ.



\### 3.10. Logging an toàn



Không log:



```text

accessToken

refreshToken

encryptedRefreshToken

clientSecret

TELEGRAM\_BOT\_TOKEN

full verification code

full email body

```



Log được phép chứa:



```text

mailboxId

emailAddress dạng nội bộ nếu project đã đang hiển thị

số message enqueue

poll duration

status success/fail

```



\## 4. File/thư mục dự kiến tạo hoặc sửa



Claude phải kiểm tra cấu trúc thực tế trước. Nếu project dùng `src/`, tạo dưới `src/`. Nếu không dùng `src/`, dùng cấu trúc root.



Dự kiến tạo/sửa:



```text

docs/tasks/TASK-031-delta-polling-backup-worker.md

services/microsoft/delta-polling.service.ts

services/queue/workers/delta-polling.worker.ts

scripts/run-delta-polling-worker.ts hoặc worker runner tương đương đang có

package.json

prisma/schema.prisma nếu cần lưu delta cursor

tests/unit/microsoft/delta-polling.service.test.ts

tests/unit/queue/delta-polling.worker.test.ts nếu phù hợp

.env.example nếu thêm env placeholder

```



Không tạo:



```text

app/admin/health/\*

services/microsoft/subscription-renewal.service.ts

services/telegram retry/backoff mới

services/alerts/\*

```



\## 5. Gợi ý thiết kế service



Interface gợi ý:



```ts

export type DeltaPollingRunResult = {

&#x20; checkedMailboxCount: number;

&#x20; bootstrappedMailboxCount: number;

&#x20; enqueuedMessageCount: number;

&#x20; failedMailboxCount: number;

};



export async function runDeltaPollingOnce(): Promise<DeltaPollingRunResult>;

```



Service nên chia nhỏ:



```ts

listActiveMicrosoftMailboxes()

pollMailboxDelta(mailbox)

bootstrapMailboxDeltaCursor(mailbox)

enqueueCreatedMessages(mailbox, messages)

saveDeltaCursor(mailboxId, cursorUrl)

```



Graph response type gợi ý:



```ts

type GraphDeltaResponse = {

&#x20; value?: Array<{

&#x20;   id?: string;

&#x20;   receivedDateTime?: string;

&#x20;   subject?: string;

&#x20;   sender?: unknown;

&#x20;   "@removed"?: unknown;

&#x20; }>;

&#x20; "@odata.nextLink"?: string;

&#x20; "@odata.deltaLink"?: string;

};

```



\## 6. Tiêu chí nghiệm thu



Task chỉ đạt khi:



\* Có delta polling service.

\* Có scheduler/worker chạy mỗi 30 giây hoặc theo env 30 giây.

\* Có run-once function để test.

\* Mailbox chưa có cursor sẽ bootstrap và không enqueue email cũ.

\* Mailbox đã có cursor sẽ lấy thay đổi mới và enqueue message mới.

\* Có xử lý `@odata.nextLink` và `@odata.deltaLink`.

\* Có giới hạn max page để tránh loop vô hạn.

\* Có bỏ qua `@removed`/message không có id.

\* Có test cho bootstrap không enqueue lịch sử cũ.

\* Có test cho subsequent poll enqueue message mới.

\* Có test cho Graph error không làm crash toàn bộ run.

\* Có test cho one mailbox fail nhưng mailbox khác vẫn chạy.

\* `npm run verify` PASS.

\* Không log token/secret/full code/full email body.

\* Không làm vượt scope TASK-032 đến TASK-035.



\## 7. Lệnh kiểm tra



Chạy các lệnh sau:



```powershell

npm run verify

git diff --name-only

git diff --stat

```



Nếu có migration Prisma:



```powershell

npx prisma validate

npx prisma migrate dev

```



Nếu có worker runner:



```powershell

npm run worker:delta:once

```



hoặc lệnh tương đương mà Claude đã thêm vào `package.json`.



\## 8. Kiểm tra thủ công đề xuất



Sau khi verify PASS:



1\. Đảm bảo có ít nhất một mailbox ACTIVE đã connect OAuth.

2\. Đảm bảo Telegram mapping đang hoạt động từ các task trước.

3\. Chạy Next dev server nếu cần:



```powershell

npm run dev

```



4\. Mở terminal khác và chạy delta worker:



```powershell

npm run worker:delta

```



5\. Quan sát log:



```text

delta polling started

checked mailbox count

bootstrapped mailbox nếu lần đầu

enqueued message count

```



6\. Gửi email verification test mới vào mailbox.

7\. Chờ tối đa 60 giây.

8\. Kiểm tra Telegram group nhận code đúng.

9\. Kiểm tra không gửi trùng nếu webhook cũng chạy.



\## 9. Không được làm



\* Không gửi Telegram trực tiếp từ delta polling service.

\* Không parse code trong delta polling service.

\* Không fetch attachment.

\* Không đọc folder ngoài Inbox.

\* Không hardcode secret/token/chatId.

\* Không commit `.env` hoặc `.env.local`.

\* Không tạo health dashboard.

\* Không tạo alert service.

\* Không làm subscription renewal.

\* Không làm retry Telegram nâng cao.

\* Không xóa hoặc reset processed\_messages.

\* Không gửi lại email cũ khi bootstrap.



\## 10. Báo cáo cuối task



Claude phải báo cáo theo format:



```text

1\. Đã làm gì

2\. File nào thay đổi

3\. Có sửa Prisma schema/migration không

4\. Có thêm env placeholder không

5\. Lệnh đã chạy

6\. Kết quả npm run verify

7\. Rủi ro còn lại

8\. Cách test thủ công

9\. Có vượt scope không

```



