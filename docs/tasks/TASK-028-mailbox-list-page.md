\# TASK-028: Tạo mailbox list page



\## 1. Mục tiêu



Tạo trang danh sách mailbox trong admin dashboard tại:



```text

/admin/mailboxes

````



Trang này dùng để admin xem nhanh các mailbox Hotmail/Outlook đã được kết nối vào hệ thống, trạng thái hiện tại của từng mailbox, trạng thái Telegram mapping và trạng thái Microsoft Graph subscription nếu dữ liệu đã có.



TASK này thuộc Sprint 7 — Mailbox dashboard.



TASK này chỉ làm list page. Không làm detail page, không làm connect mailbox UI mới, không sửa OAuth, không sửa webhook/worker.



\---



\## 2. Bối cảnh



Các task trước đã triển khai các phần nền tảng như:



\* Customer/admin skeleton.

\* Telegram config/mapping.

\* Microsoft OAuth connect URL/callback.

\* Token encryption.

\* Lưu mailbox sau OAuth connect.

\* Microsoft Graph mail service.

\* Graph subscription service.

\* Webhook receiver.

\* Queue/worker foundation.

\* Worker xử lý Graph message → detector → extractor → Telegram.



TASK-028 bắt đầu phần dashboard mailbox, giúp admin nhìn thấy dữ liệu mailbox hiện có.



\---



\## 3. Yêu cầu chức năng



\### 3.1. Route chính



Tạo hoặc hoàn thiện route:



```text

/admin/mailboxes

```



Nếu project dùng App Router không có `src/`:



```text

app/admin/mailboxes/page.tsx

```



Nếu project dùng `src/`:



```text

src/app/admin/mailboxes/page.tsx

```



Claude phải kiểm tra cấu trúc thực tế trước khi tạo file, không được tự ý tạo song song cả `app/` và `src/app/`.



\---



\### 3.2. Dữ liệu hiển thị



Trang list mailbox cần hiển thị tối thiểu các cột/thông tin sau nếu schema hiện tại có dữ liệu:



```text

1\. Email address

2\. Provider

3\. Customer / owner customer name nếu có

4\. Mailbox status

5\. Telegram mapping status

6\. Telegram group name nếu có

7\. Graph subscription status nếu có

8\. Subscription expiration nếu có

9\. Last successful sync / last processed time nếu có

10\. Created at

11\. Updated at

```



Nếu một số field chưa có trong schema hiện tại thì không được tự ý sửa schema lớn. Hãy hiển thị những field đang có và ghi chú rõ field nào chưa có.



\---



\### 3.3. Trạng thái mailbox



Nếu project đã có enum/status, dùng đúng enum/status hiện tại.



Các status dự kiến có thể gồm:



```text

ACTIVE

RECONNECT\_REQUIRED

SUBSCRIPTION\_EXPIRED

WEBHOOK\_FAILED

DISABLED

ERROR

```



UI nên hiển thị badge dễ hiểu:



```text

ACTIVE                → Active / Đang hoạt động

RECONNECT\_REQUIRED    → Cần reconnect

SUBSCRIPTION\_EXPIRED  → Subscription hết hạn

WEBHOOK\_FAILED        → Webhook lỗi

DISABLED              → Đã tắt

ERROR                 → Lỗi

```



Không được đổi tên enum trong database nếu không cần.



\---



\### 3.4. Empty state



Nếu chưa có mailbox nào, trang phải hiển thị empty state thân thiện:



```text

Chưa có mailbox nào được kết nối.

Mailbox sau khi OAuth thành công sẽ xuất hiện tại đây.

```



Không bắt buộc tạo nút connect mới trong task này vì TASK-030 mới là connect mailbox UI.



Nếu project đã có sẵn ConnectMailboxButton từ task trước, có thể link/đặt lại nhẹ nhàng nếu không làm vượt scope. Không tạo flow connect mới.



\---



\### 3.5. Search/filter đơn giản



Nếu không làm phức tạp, có thể thêm search/filter bằng query params:



```text

/admin/mailboxes?q=hotmail

/admin/mailboxes?status=ACTIVE

```



Nhưng đây là phần phụ. Không được vì search/filter mà refactor lớn hoặc làm hỏng route hiện có.



Ưu tiên hoàn thành list page an toàn trước.



\---



\### 3.6. Data access an toàn



Khi lấy dữ liệu từ database, phải dùng whitelist field.



Không được return/spread toàn bộ Prisma model ra UI nếu model có field nhạy cảm.



Tuyệt đối không đưa các field sau lên frontend:



```text

encryptedRefreshToken

refreshToken

accessToken

token

clientSecret

clientState

clientStateHash

telegramBotToken

password

secret

code

verificationCode

fullEmailBody

```



Nên tạo kiểu dữ liệu an toàn, ví dụ:



```ts

type MailboxListItem = {

&#x20; id: string;

&#x20; emailAddress: string;

&#x20; provider: string;

&#x20; status: string;

&#x20; ownerCustomerName?: string | null;

&#x20; telegramGroupName?: string | null;

&#x20; telegramMappingStatus?: string | null;

&#x20; subscriptionStatus?: string | null;

&#x20; subscriptionExpiresAt?: Date | string | null;

&#x20; lastSuccessfulSyncAt?: Date | string | null;

&#x20; createdAt?: Date | string | null;

&#x20; updatedAt?: Date | string | null;

};

```



\---



\## 4. File/thư mục dự kiến tạo hoặc sửa



Claude phải kiểm tra cấu trúc thực tế trước. Dự kiến có thể liên quan:



```text

app/admin/mailboxes/page.tsx

components/status/MailboxStatusBadge.tsx

components/status/SubscriptionStatusBadge.tsx

components/tables/MailboxListTable.tsx

services/microsoft/mailbox-list.service.ts

```



Hoặc nếu project đang dùng `src/`:



```text

src/app/admin/mailboxes/page.tsx

src/components/status/MailboxStatusBadge.tsx

src/components/tables/MailboxListTable.tsx

src/services/microsoft/mailbox-list.service.ts

```



Không bắt buộc tạo tất cả file trên. Nếu project đã có component/table/status badge tương tự, hãy reuse.



\---



\## 5. Gợi ý implementation



\### 5.1. Server Component



Ưu tiên để `page.tsx` là Server Component, đọc dữ liệu server-side qua service.



Ví dụ định hướng:



```ts

export default async function MailboxesPage() {

&#x20; const mailboxes = await listMailboxesForAdmin();



&#x20; return (

&#x20;   <main>

&#x20;     {/\* header \*/}

&#x20;     {/\* summary cards nếu đơn giản \*/}

&#x20;     {/\* table \*/}

&#x20;     {/\* empty state \*/}

&#x20;   </main>

&#x20; );

}

```



Không cần tạo API route mới nếu server component/service đọc trực tiếp từ DB là đủ.



\---



\### 5.2. Service list mailbox



Nếu chưa có service phù hợp, có thể tạo service riêng để query danh sách mailbox.



Service phải:



```text

1\. Chỉ select field an toàn.

2\. Không return encryptedRefreshToken.

3\. Không return token/clientState/client secret.

4\. Không log dữ liệu nhạy cảm.

5\. Không throw lỗi làm vỡ toàn bộ page nếu DB chưa có data.

```



\---



\### 5.3. Table UI



Bảng nên có các cột:



```text

Email

Customer

Status

Telegram

Subscription

Last sync

Created

Actions

```



Cột Actions trong TASK-028 chỉ nên hiển thị placeholder an toàn:



```text

Chi tiết — sẽ làm ở TASK-029

```



Không tạo link đến route chưa tồn tại nếu route đó sẽ gây 404, trừ khi project đã có sẵn route detail.



\---



\## 6. Tiêu chí nghiệm thu



TASK-028 được coi là hoàn thành khi:



```text

\[ ] Có route /admin/mailboxes.

\[ ] Trang nằm trong admin dashboard/admin layout hiện có.

\[ ] Trang hiển thị danh sách mailbox nếu database có mailbox.

\[ ] Trang hiển thị empty state nếu database chưa có mailbox.

\[ ] Có badge/trạng thái dễ đọc cho mailbox status.

\[ ] Có hiển thị Telegram mapping status nếu dữ liệu hiện có.

\[ ] Có hiển thị Graph subscription status/expiration nếu dữ liệu hiện có.

\[ ] UI không hiển thị token, secret, refresh token, access token, clientState/clientStateHash.

\[ ] UI không hiển thị full verification code hoặc full email body.

\[ ] Không tạo detail page TASK-029.

\[ ] Không tạo connect mailbox UI TASK-030.

\[ ] Không sửa OAuth/webhook/worker/parser/Telegram sending flow.

\[ ] npm run verify PASS.

\[ ] Gemini review PASS.

```



\---



\## 7. Lệnh kiểm tra



Chạy các lệnh sau:



```powershell

npm run verify

```



Nếu muốn kiểm tra UI thủ công:



```powershell

npm run dev

```



Sau đó mở:



```text

http://localhost:3000/admin/mailboxes

```



Nếu route admin đang được bảo vệ bởi login, việc bị redirect sang login là bình thường. Sau khi đăng nhập bằng cơ chế dev/admin hiện có, quay lại `/admin/mailboxes` để kiểm tra.



\---



\## 8. Checklist bảo mật



```text

\[ ] Không hardcode secret/token/password.

\[ ] Không đọc/in nội dung .env hoặc .env.local.

\[ ] Không hiển thị encryptedRefreshToken.

\[ ] Không hiển thị access token/refresh token.

\[ ] Không hiển thị clientState hoặc clientStateHash.

\[ ] Không hiển thị Telegram bot token.

\[ ] Không hiển thị full code.

\[ ] Không hiển thị full email body.

\[ ] Không ghi log dữ liệu nhạy cảm.

```



\---



\## 9. Không được làm trong task này



```text

\[ ] Không tạo /admin/mailboxes/\[id].

\[ ] Không tạo connect mailbox UI mới.

\[ ] Không gọi Microsoft OAuth.

\[ ] Không gọi Microsoft Graph để fetch email.

\[ ] Không tạo hoặc renew subscription.

\[ ] Không chạy worker xử lý email.

\[ ] Không gửi Telegram.

\[ ] Không sửa parser/extractor/detector.

\[ ] Không tạo delta polling.

\[ ] Không thêm package mới nếu không thật sự cần.

\[ ] Không refactor layout lớn.

```



\---



\## 10. Báo cáo cuối task Claude phải trả về



Claude phải báo cáo theo format:



```text

1\. Đã làm gì

2\. File nào đã tạo/sửa

3\. Có làm đúng scope TASK-028 không

4\. Có làm vượt scope TASK-029/TASK-030 không

5\. Lệnh đã chạy

6\. Kết quả npm run verify

7\. Rủi ro còn lại

8\. Gợi ý bước kiểm tra thủ công cho user

```



````



