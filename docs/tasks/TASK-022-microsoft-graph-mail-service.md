\# TASK-022: Microsoft Graph Mail Service — Read Inbox Test



\## 1. Mục tiêu



Tạo Microsoft Graph mail service để kiểm chứng rằng sau khi mailbox đã được connect qua Microsoft OAuth và refresh token đã được lưu/encrypt ở TASK-020/TASK-021, hệ thống có thể gọi Microsoft Graph API để đọc các email gần nhất trong Inbox.



Task này thuộc Sprint 5 — Microsoft OAuth validation.



Mục tiêu kỹ thuật:



1\. Tạo service `services/microsoft/graph-mail.service.ts`.

2\. Service có thể gọi Microsoft Graph để list recent Inbox messages.

3\. Service có thể lấy message detail theo Graph message ID nếu cần.

4\. Trả về dữ liệu email đã normalize/sanitize.

5\. Không log token.

6\. Không expose access token/refresh token qua API/browser/log.

7\. Không tải attachment.

8\. Có unit test mock Graph API.

9\. Có cách test thủ công đọc Inbox từ mailbox đã connect ở TASK-021.



\---



\## 2. Bối cảnh trước task



Các task trước đó đã xử lý:



\- TASK-017: Microsoft App Registration checklist \& config.

\- TASK-018: Tạo Microsoft OAuth connect URL.

\- TASK-019: Tạo Microsoft OAuth callback.

\- TASK-020: Tạo token encryption service.

\- TASK-021: Lưu mailbox sau OAuth connect.



TASK-022 không làm lại OAuth flow. TASK-022 chỉ dùng lại token/mailbox đã có để gọi Microsoft Graph đọc Inbox.



\---



\## 3. File/thư mục dự kiến tạo hoặc sửa



Claude phải kiểm tra cấu trúc thực tế của project trước khi tạo file.



Nếu project KHÔNG dùng `src/`, dùng:



```text

services/microsoft/graph-mail.service.ts

tests/unit/microsoft/graph-mail.service.test.ts

````



Nếu project CÓ dùng `src/`, dùng tương ứng:



```text

src/services/microsoft/graph-mail.service.ts

src/tests/unit/microsoft/graph-mail.service.test.ts

```



Nếu cần endpoint test nội bộ, tạo đúng theo cấu trúc app router hiện có. Gợi ý mặc định:



```text

app/api/mailboxes/\[id]/inbox-test/route.ts

```



Hoặc nếu project dùng `src/`:



```text

src/app/api/mailboxes/\[id]/inbox-test/route.ts

```



Không tạo route nếu project đã có script/test harness phù hợp hơn. Nhưng task phải có một cách test thủ công rõ ràng để xác nhận đọc Inbox thật.



\---



\## 4. Yêu cầu service



Tạo file:



```text

services/microsoft/graph-mail.service.ts

```



Service nên có các type/interface sau hoặc tương đương:



```ts

export type GraphMailRecipient = {

&#x20; emailAddress?: {

&#x20;   name?: string | null;

&#x20;   address?: string | null;

&#x20; } | null;

};



export type GraphMailBody = {

&#x20; contentType?: "text" | "html" | string;

&#x20; content?: string | null;

};



export type GraphMailMessage = {

&#x20; id: string;

&#x20; internetMessageId?: string | null;

&#x20; from?: GraphMailRecipient | null;

&#x20; sender?: GraphMailRecipient | null;

&#x20; subject?: string | null;

&#x20; receivedDateTime?: string | null;

&#x20; bodyPreview?: string | null;

&#x20; body?: GraphMailBody | null;

&#x20; toRecipients?: GraphMailRecipient\[];

};



export type ListInboxMessagesOptions = {

&#x20; top?: number;

&#x20; includeBody?: boolean;

&#x20; preferTextBody?: boolean;

};



export type GetMessageOptions = {

&#x20; preferTextBody?: boolean;

};

```



Tên type có thể thay đổi nếu project đã có convention khác, nhưng ý nghĩa phải tương đương.



\---



\## 5. Các hàm bắt buộc



Service cần có các hàm public tương đương:



```ts

listInboxMessages(

&#x20; accessToken: string,

&#x20; options?: ListInboxMessagesOptions

): Promise<GraphMailMessage\[]>

```



Mục tiêu:



\* Gọi Microsoft Graph endpoint để đọc Inbox.

\* Mặc định lấy 10 email gần nhất.

\* Có giới hạn an toàn cho `top`, ví dụ clamp từ 1 đến 25.

\* Sắp xếp theo `receivedDateTime desc`.

\* Dùng `$select` để chỉ lấy field cần thiết.

\* Không lấy attachment.

\* Không log access token.



Endpoint gợi ý:



```text

GET https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages

```



Query gợi ý:



```text

$top=10

$orderby=receivedDateTime desc

$select=id,internetMessageId,from,sender,subject,receivedDateTime,bodyPreview,toRecipients

```



Nếu `includeBody = true`, có thể thêm `body` vào `$select`.



\---



```ts

getMessageById(

&#x20; accessToken: string,

&#x20; messageId: string,

&#x20; options?: GetMessageOptions

): Promise<GraphMailMessage>

```



Mục tiêu:



\* Lấy chi tiết một message theo ID.

\* Chỉ dùng khi cần body chi tiết.

\* Phải URL-encode message ID.

\* Không log message body đầy đủ nếu có lỗi.

\* Không log access token.



Endpoint gợi ý:



```text

GET https://graph.microsoft.com/v1.0/me/messages/{messageId}

```



Query gợi ý:



```text

$select=id,internetMessageId,from,sender,subject,receivedDateTime,bodyPreview,body,toRecipients

```



\---



\## 6. Header bắt buộc



Mỗi request tới Graph phải có:



```text

Authorization: Bearer <access token>

```



Nếu lấy body và muốn text thay vì HTML, thêm:



```text

Prefer: outlook.body-content-type="text"

```



Không được in header Authorization ra log.



\---



\## 7. Xử lý lỗi bắt buộc



Service phải xử lý lỗi Graph theo cách an toàn.



Các lỗi cần có test hoặc xử lý rõ:



```text

401 Unauthorized

→ token hết hạn hoặc không hợp lệ

→ trả lỗi nội bộ dạng GRAPH\_AUTH\_FAILED hoặc tương đương

→ không log token



403 Forbidden

→ thiếu quyền Mail.Read hoặc user chưa consent đúng

→ trả lỗi GRAPH\_PERMISSION\_DENIED hoặc tương đương



404 Not Found

→ message/mailbox không tồn tại

→ trả lỗi GRAPH\_NOT\_FOUND hoặc tương đương



429 Too Many Requests

→ Graph rate limit

→ trả lỗi GRAPH\_RATE\_LIMITED hoặc tương đương

→ nếu có Retry-After thì preserve trong error metadata an toàn



5xx

→ lỗi Graph tạm thời

→ trả lỗi GRAPH\_TEMPORARY\_ERROR hoặc tương đương

```



Error object/message không được chứa:



```text

access token

refresh token

client secret

full email body

full Authorization header

```



\---



\## 8. Endpoint hoặc script test nội bộ



Để user kiểm tra thủ công, Claude cần cung cấp một cách gọi service sau khi mailbox đã connect.



Ưu tiên nếu phù hợp với code hiện tại:



```text

GET /api/mailboxes/\[id]/inbox-test?limit=5

```



Yêu cầu endpoint này:



1\. Chỉ dùng nội bộ/development hoặc admin-protected nếu project đã có auth skeleton.

2\. Nhận mailbox ID từ path.

3\. Không nhận access token từ query/body.

4\. Tự lấy mailbox/token đã lưu từ DB bằng logic có sẵn từ TASK-021.

5\. Dùng refresh token đã decrypt/refresh theo logic đã có từ TASK-020/TASK-021.

6\. Gọi `graph-mail.service.ts`.

7\. Trả JSON đã sanitize.



Response gợi ý:



```json

{

&#x20; "ok": true,

&#x20; "mailboxId": "xxx",

&#x20; "count": 5,

&#x20; "messages": \[

&#x20;   {

&#x20;     "id": "graph-message-id",

&#x20;     "internetMessageId": "<message-id@example>",

&#x20;     "fromAddress": "sender@example.com",

&#x20;     "fromName": "Sender Name",

&#x20;     "subject": "Example subject",

&#x20;     "receivedDateTime": "2026-05-28T08:00:00Z",

&#x20;     "bodyPreview": "Preview only..."

&#x20;   }

&#x20; ]

}

```



Không trả về:



```text

accessToken

refreshToken

encryptedRefreshToken

clientSecret

full body nếu không cần

raw Graph response chứa dữ liệu dư thừa

```



Nếu project không phù hợp để tạo API route ở task này, Claude có thể tạo script test nội bộ thay thế, ví dụ:



```text

scripts/test-graph-inbox.ts

```



Nhưng chỉ chọn 1 cách test, không tạo quá nhiều entrypoint.



\---



\## 9. Unit test bắt buộc



Tạo test cho Graph mail service bằng mocked `fetch`.



Test tối thiểu:



1\. `listInboxMessages` gọi đúng endpoint `/me/mailFolders/inbox/messages`.

2\. Request có `Authorization: Bearer ...`.

3\. Request dùng `$top`, `$orderby`, `$select` đúng.

4\. Mặc định không include `body` nếu `includeBody` không bật.

5\. Có thể include `body` khi `includeBody: true`.

6\. Clamp `top` để không request quá nhiều email.

7\. Parse response `value` thành danh sách message.

8\. Nếu response có `@odata.nextLink`, service không tự fetch toàn bộ trong MVP, nhưng không crash.

9\. 401 trả lỗi an toàn, không chứa token.

10\. 403 trả lỗi an toàn.

11\. 429 preserve Retry-After nếu có.

12\. Network error không làm lộ token.

13\. `getMessageById` URL-encode message ID.

14\. Error/log không chứa full email body hoặc Authorization header.



\---



\## 10. Manual test sau khi code xong



Điều kiện trước khi test thật:



1\. `.env.local` đã có Microsoft config thật.

2\. `ENCRYPTION\_KEY` đã đúng với token đã lưu ở TASK-021.

3\. Database local đang chạy.

4\. Đã connect ít nhất 1 mailbox thành công ở TASK-021.

5\. Mailbox đó có ít nhất 1 email trong Inbox.

6\. App chạy local bằng:



```powershell

npm run dev

```



Nếu dùng endpoint:



```powershell

$MailboxId = "PASTE\_MAILBOX\_ID\_HERE"

Invoke-RestMethod -Uri "http://localhost:3000/api/mailboxes/$MailboxId/inbox-test?limit=5" -Method GET

```



Kết quả đạt:



```text

\- Response ok: true.

\- Có danh sách messages.

\- Có subject/from/receivedDateTime/bodyPreview.

\- Không có accessToken.

\- Không có refreshToken.

\- Không có encryptedRefreshToken.

\- Không có clientSecret.

```



\---



\## 11. Lệnh kiểm tra bắt buộc



Claude phải chạy:



```powershell

npm run verify

```



Nếu project có script test riêng, chạy thêm:



```powershell

npm test

```



Hoặc:



```powershell

npm run test

```



Tùy package.json thực tế.



\---



\## 12. Tiêu chí nghiệm thu



Task chỉ PASS khi đạt đủ:



1\. Có `graph-mail.service.ts`.

2\. Có unit test cho Graph mail service.

3\. `npm run verify` PASS.

4\. Có cách test thủ công đọc Inbox thật.

5\. Đọc được recent Inbox messages từ mailbox đã connect.

6\. Response test không expose token/secret.

7\. Không tải attachment.

8\. Không tạo subscription.

9\. Không tạo webhook.

10\. Không setup queue/worker.

11\. Không gửi Telegram.

12\. Không gọi detector/extractor ở task này.

13\. Không log access token/refresh token.

14\. Không log full email body.

15\. Gemini review PASS.



\---



\## 13. Không được làm



Không được mở rộng scope sang các task sau:



```text

TASK-023: Graph subscription service

TASK-024: Microsoft webhook verification endpoint

TASK-025: Webhook receiver notification thật

TASK-026: Queue \& worker foundation

TASK-027: Worker xử lý Graph message → detector → extractor → Telegram

TASK-028/TASK-029/TASK-030: Mailbox dashboard UI

TASK-031: Delta polling backup

```



Không được thêm dependency Microsoft Graph SDK nếu không thật sự cần. Ưu tiên dùng native `fetch` để giảm complexity, trừ khi project đã có SDK/convention sẵn.



Không được đọc/in `.env.local`.



Không được yêu cầu user paste token/secret vào chat.



\---



\## 14. Báo cáo cuối task Claude phải trả về



Claude phải kết luận theo format:



```text

1\. Đã làm gì

2\. File nào thay đổi

3\. Lệnh nào đã chạy

4\. Kết quả PASS/FAIL

5\. Cách test thủ công read Inbox

6\. Rủi ro còn lại

7\. Có làm vượt scope không

8\. Task tiếp theo được khuyến nghị

```



````





