# TASK-029: Tạo mailbox detail page

## 1. Mục tiêu

Tạo trang chi tiết mailbox tại:

```text
/admin/mailboxes/[id]
````

Trang này cho phép admin xem thông tin chi tiết của một mailbox Hotmail/Outlook đã kết nối, bao gồm trạng thái mailbox, Telegram mapping, Graph subscription và một số metadata vận hành an toàn.

Task này thuộc Sprint 7 — Mailbox dashboard, sau TASK-028 mailbox list page và trước TASK-030 connect mailbox UI.

## 2. Bối cảnh

TASK-028 đã tạo trang danh sách mailbox tại:

```text
/admin/mailboxes
```

TASK-029 cần biến mỗi mailbox trong danh sách thành một trang detail có thể mở được bằng id.

Trang detail giúp admin kiểm tra:

* Mailbox này thuộc customer nào.
* Trạng thái hiện tại là gì.
* Mailbox đã có Telegram mapping chưa.
* Mapping đang active hay chưa.
* Graph subscription đang active hay hết hạn.
* Lần sync thành công gần nhất là khi nào.
* Mailbox có dấu hiệu cần reconnect hoặc lỗi vận hành không.

## 3. Phạm vi phải làm

### 3.1. Route/page

Tạo trang:

```text
app/admin/mailboxes/[id]/page.tsx
```

Nếu project thực tế dùng `src/`, tạo tương ứng:

```text
src/app/admin/mailboxes/[id]/page.tsx
```

Trang phải là Server Component nếu phù hợp với cấu trúc hiện tại.

Trang nhận `params.id`, gọi service layer để lấy dữ liệu mailbox theo id.

Nếu không tìm thấy mailbox, dùng `notFound()` của Next.js hoặc render trạng thái not found phù hợp với convention hiện tại của project.

### 3.2. Service đọc dữ liệu an toàn

Tạo hoặc mở rộng service:

```text
services/microsoft/mailbox-detail.service.ts
```

Hoặc nếu TASK-028 đã có service chung như:

```text
services/microsoft/mailbox-list.service.ts
```

thì có thể thêm function mới vào đó nếu hợp lý, ví dụ:

```ts
getMailboxDetailById(id: string)
```

Service phải dùng Prisma `select` hoặc mapping rõ ràng để chỉ trả field an toàn.

Không được trả về toàn bộ Prisma model nếu model có field nhạy cảm.

### 3.3. Field được phép hiển thị

Mailbox section:

* id
* emailAddress / email_address
* provider
* status
* ownerCustomerName hoặc customer.name nếu có relation
* microsoftUserId nếu hiện tại project đã xem là non-secret
* tokenLastRefreshedAt nếu có
* lastSuccessfulSyncAt nếu có
* createdAt
* updatedAt

Telegram mapping section:

* mapping status
* telegramGroupName
* createdAt
* updatedAt

Không hiển thị `telegramChatId` mặc định. Nếu cần hiển thị để debug, chỉ hiển thị dạng masked, ví dụ:

```text
-1001234...7890
```

Graph subscription section:

* subscriptionId nếu cần thì có thể hiển thị dạng masked/truncated
* resource
* status
* expirationDateTime
* lastRenewedAt
* createdAt
* updatedAt

Không hiển thị:

* clientState
* clientStateHash

Recent processing section nếu schema/service hiện tại đã có:

* graphMessageId dạng truncated nếu cần
* internetMessageId dạng truncated nếu cần
* receivedAt
* senderEmail
* status
* sentToTelegramAt
* createdAt

Không hiển thị:

* codeHash
* full code
* subjectHash nếu không có ý nghĩa với admin
* full subject nếu project hiện tại chỉ lưu hash

Audit/recent logs section nếu đã có service sẵn:

* action
* entityType
* entityId
* createdAt
* metadata đã sanitize nếu có

Nếu code event log/audit log service hiện tại chưa thuận tiện, không bắt buộc làm phần logs sâu trong task này. Có thể để placeholder/link sang trang logs hiện có.

### 3.4. UI layout

Trang detail nên có:

1. Back link về `/admin/mailboxes`
2. Header:

   * email address
   * provider
   * status badge
3. Summary cards:

   * Owner/customer
   * Last successful sync
   * Subscription expiration
   * Telegram mapping status
4. Detail sections:

   * Mailbox information
   * Telegram mapping
   * Graph subscription
   * Recent processing / recent events nếu có dữ liệu an toàn
5. Empty state riêng cho từng section:

   * Chưa có Telegram mapping
   * Chưa có Graph subscription
   * Chưa có processed message/code event

### 3.5. Link từ list page

Nếu TASK-028 table chưa có link sang detail, cập nhật nhẹ list page/table để email hoặc nút “View details” trỏ đến:

```text
/admin/mailboxes/{id}
```

Không làm thay đổi lớn UI list page ngoài việc thêm link điều hướng.

### 3.6. Styling

Có thể tạo style riêng nếu project đang dùng CSS file:

```text
app/admin/mailboxes/[id]/mailbox-detail.css
```

Hoặc reuse CSS của TASK-028 nếu đã có:

```text
app/admin/mailboxes/mailboxes.css
```

Không cần làm UI quá đẹp. Ưu tiên rõ ràng, dễ đọc, an toàn.

## 4. Không được làm

Không làm trong TASK-029:

* Không tạo connect mailbox UI mới. Đó là TASK-030.
* Không tạo reconnect flow thật.
* Không tạo disable/delete mailbox action.
* Không sửa Telegram mapping.
* Không tạo Graph subscription mới.
* Không renew subscription.
* Không gọi Microsoft Graph trực tiếp từ page detail.
* Không fetch email mới từ Graph.
* Không gửi Telegram test message.
* Không xử lý queue/worker.
* Không tạo delta polling.
* Không hiển thị token/secret/hash nhạy cảm.
* Không hiển thị full verification code.
* Không hiển thị full email body.
* Không đọc/in `.env` hoặc `.env.local`.

## 5. Yêu cầu bảo mật bắt buộc

Service phải whitelist field an toàn.

Không dùng kiểu:

```ts
prisma.mailbox.findUnique({ where: { id } })
```

rồi trả toàn bộ object ra UI nếu model chứa field nhạy cảm.

Phải dùng kiểu:

```ts
prisma.mailbox.findUnique({
  where: { id },
  select: {
    id: true,
    emailAddress: true,
    provider: true,
    status: true,
    lastSuccessfulSyncAt: true,
    createdAt: true,
    updatedAt: true,
    // chỉ thêm field an toàn
  },
})
```

Tên field thực tế phải theo `prisma/schema.prisma` của project.

## 6. File/thư mục dự kiến tạo/sửa

Dự kiến tạo mới:

```text
app/admin/mailboxes/[id]/page.tsx
services/microsoft/mailbox-detail.service.ts
```

Có thể tạo nếu cần:

```text
app/admin/mailboxes/[id]/mailbox-detail.css
components/status/MailboxStatusBadge.tsx
components/status/SubscriptionStatusBadge.tsx
```

Dự kiến sửa:

```text
app/admin/mailboxes/page.tsx
components/tables/MailboxListTable.tsx
```

Chỉ sửa list/table nếu cần thêm link sang detail.

## 7. Tiêu chí nghiệm thu

Task được coi là PASS khi:

* Truy cập `/admin/mailboxes/[id]` với id có tồn tại sẽ thấy trang detail.
* Truy cập id không tồn tại có not found/empty state rõ ràng.
* Trang detail hiển thị mailbox status badge đúng.
* Trang detail hiển thị Telegram mapping nếu có.
* Trang detail hiển thị empty state nếu chưa có Telegram mapping.
* Trang detail hiển thị Graph subscription nếu có.
* Trang detail hiển thị empty state nếu chưa có Graph subscription.
* Không có token/secret/clientStateHash/encryptedRefreshToken/codeHash/full code/full email body xuất hiện trên UI.
* List page có link mở detail cho từng mailbox.
* `npm run verify` PASS.
* Gemini review PASS.

## 8. Lệnh kiểm tra

Chạy:

```powershell
npm run verify
```

Kiểm tra thủ công:

```powershell
npm run dev
```

Mở browser:

```text
http://localhost:3000/admin/mailboxes
```

Bấm vào một mailbox trong list.

Hoặc mở trực tiếp:

```text
http://localhost:3000/admin/mailboxes/<MAILBOX_ID_THẬT_TRONG_DB>
```

Nếu chưa có mailbox trong database, detail page không thể test bằng id thật. Khi đó kiểm tra list page empty state và dùng database hiện có ở PC đã connect mailbox để test UI thực tế.

## 9. Báo cáo cuối task Claude phải trả về

Claude phải báo cáo:

1. Đã làm gì
2. File đã tạo/sửa
3. Field nào được whitelist
4. Field nhạy cảm nào đã cố tình loại bỏ
5. Lệnh đã chạy
6. Kết quả `npm run verify`
7. Cách test thủ công trong browser
8. Có vượt scope không

````
