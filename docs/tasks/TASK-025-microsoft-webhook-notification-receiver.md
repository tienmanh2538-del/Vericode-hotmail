# TASK-025: Tạo Microsoft webhook receiver cho notification thật

## 1. Mục tiêu

Tạo receiver cho Microsoft Graph change notifications thật tại webhook endpoint đã có từ TASK-024.

Sau TASK-025, hệ thống phải có khả năng:

1. Nhận POST notification payload thật từ Microsoft Graph.
2. Giữ nguyên logic trả validationToken đã làm ở TASK-024.
3. Parse payload dạng `{ value: [...] }`.
4. Hỗ trợ một request chứa nhiều notifications.
5. Validate `subscriptionId`.
6. Validate `clientState` với subscription đã lưu trong database.
7. Chỉ accept notification hợp lệ.
8. Chuẩn hóa notification hợp lệ thành object nhẹ để TASK-026/TASK-027 xử lý tiếp.
9. Trả response nhanh, không xử lý email nặng trong webhook.
10. Không log token, secret, full email body, full verification code.

## 2. Bối cảnh

TASK-023 đã tạo Graph subscription service.

TASK-024 đã tạo webhook verification endpoint để Microsoft xác thực notification URL bằng `validationToken`.

TASK-025 nối tiếp TASK-024 bằng cách xử lý POST notification thật.

Microsoft Graph notification payload có dạng tổng quát:

```json
{
  "value": [
    {
      "subscriptionId": "subscription-guid",
      "clientState": "secret-client-state",
      "changeType": "created",
      "resource": "users/{id}/mailFolders('Inbox')/messages/{message-id}",
      "resourceData": {
        "id": "message-id"
      },
      "subscriptionExpirationDateTime": "2026-05-29T10:00:00.000Z",
      "tenantId": "tenant-guid"
    }
  ]
}
````

Lưu ý: Microsoft có thể gửi nhiều notification trong cùng một request, nên không được assume chỉ có 1 item.

## 3. Scope được phép làm

Claude Code chỉ được làm các phần sau:

* Cập nhật webhook route hiện có từ TASK-024.
* Thêm type/schema/helper để parse Microsoft Graph notification payload.
* Thêm service/helper validate notification.
* Tìm `GraphSubscription` trong DB bằng `subscriptionId`.
* Validate `clientState` bằng cơ chế hash/compare hiện có trong project.
* Trả response JSON an toàn cho notification thật.
* Thêm unit test/integration test cho route/service.
* Giữ nguyên behavior validationToken của TASK-024.
* Ghi log an toàn ở mức count/status, không log secret/payload nhạy cảm.

## 4. Scope không được làm

Không được làm các phần sau trong TASK-025:

* Không fetch message detail từ Microsoft Graph.
* Không gọi `graph-mail.service.ts` để đọc nội dung email.
* Không detector Facebook/Meta.
* Không extract verification code.
* Không gửi Telegram.
* Không setup BullMQ/Redis queue thật.
* Không tạo worker thật.
* Không tạo delta polling.
* Không tạo subscription renewal worker.
* Không làm mailbox dashboard.
* Không thay đổi Microsoft OAuth flow.
* Không thay đổi token encryption logic nếu không bắt buộc.
* Không lưu plaintext `clientState`.
* Không log `clientState`, token, email body hoặc verification code.

## 5. File/thư mục dự kiến tạo hoặc sửa

Claude phải kiểm tra cấu trúc thực tế trước khi sửa.

Nếu project không dùng `src/`, dự kiến:

```text
app/api/webhooks/microsoft/mail/route.ts
services/microsoft/webhook-notification.service.ts
tests/unit/microsoft/webhook-notification.service.test.ts
tests/api/microsoft-webhook-notification.test.ts
docs/tasks/TASK-025-microsoft-webhook-notification-receiver.md
```

Nếu project dùng `src/`, dùng đường dẫn tương ứng:

```text
src/app/api/webhooks/microsoft/mail/route.ts
src/services/microsoft/webhook-notification.service.ts
src/tests/unit/microsoft/webhook-notification.service.test.ts
src/tests/api/microsoft-webhook-notification.test.ts
```

Nếu TASK-024 đang dùng route khác, ví dụ:

```text
app/webhooks/microsoft/mail/route.ts
```

thì phải tiếp tục dùng đúng route hiện có, không tạo route song song.

## 6. Yêu cầu kỹ thuật chi tiết

### 6.1. Giữ nguyên validationToken

Trong POST handler, xử lý theo thứ tự:

1. Nếu URL có `validationToken`, trả lại token dạng `text/plain`.
2. Nếu không có `validationToken`, xử lý notification body.

Ví dụ logic mong muốn:

```ts
const validationToken = request.nextUrl.searchParams.get("validationToken");

if (validationToken) {
  return new Response(validationToken, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}
```

Không được làm hỏng TASK-024.

### 6.2. Validate body shape

Body hợp lệ phải có:

```ts
{
  value: MicrosoftGraphChangeNotification[]
}
```

Nếu body không có `value`, hoặc `value` không phải array:

* Trả `400 Bad Request`.
* Không throw raw error ra response.
* Không log full body.

### 6.3. Type đề xuất

Tạo type gần giống như sau, điều chỉnh theo style project:

```ts
export type MicrosoftGraphChangeType = "created" | "updated" | "deleted";

export type MicrosoftGraphResourceData = {
  id?: string;
  "@odata.type"?: string;
  "@odata.id"?: string;
  "@odata.etag"?: string;
};

export type MicrosoftGraphChangeNotification = {
  id?: string;
  subscriptionId?: string;
  subscriptionExpirationDateTime?: string;
  clientState?: string;
  changeType?: MicrosoftGraphChangeType | string;
  resource?: string;
  tenantId?: string;
  resourceData?: MicrosoftGraphResourceData;
};

export type MicrosoftGraphChangeNotificationCollection = {
  value: MicrosoftGraphChangeNotification[];
};

export type AcceptedMicrosoftMailNotification = {
  subscriptionId: string;
  graphMessageId: string;
  changeType: MicrosoftGraphChangeType;
  resource: string;
  receivedAt: string;
};
```

### 6.4. Validate từng notification

Mỗi notification chỉ được accept nếu:

* Có `subscriptionId`.
* Có `clientState`.
* Có `changeType`.
* `changeType` là `created` cho scope hiện tại.
* Có `resource` hoặc `resourceData.id`.
* Tìm được GraphSubscription tương ứng trong DB.
* `clientState` match với clientStateHash đã lưu.
* Subscription status còn active, nếu project đã có status.

Nếu không hợp lệ:

* Không xử lý tiếp.
* Không fetch Graph.
* Không gửi Telegram.
* Ghi log an toàn, ví dụ chỉ log reason + subscriptionId masked/truncated nếu cần.
* Response tổng vẫn có thể là `202` nếu request parse được và các item invalid đã được skip.

### 6.5. Validate clientState

Không được lưu hoặc so sánh plaintext clientState nếu project đang dùng hash.

Nếu đã có helper hash/verify trong `lib/security/hash.ts`, dùng lại.

Nếu chưa có helper verify phù hợp, tạo helper nhỏ nhưng không phá API hiện có.

Ví dụ mong muốn:

```ts
verifySecretHash(notification.clientState, subscription.clientStateHash)
```

hoặc dùng helper tương ứng đã có.

Không được log `clientState`.

### 6.6. Tìm subscription trong DB

Dựa vào model Prisma hiện có.

Dự kiến logic:

```ts
const subscription = await prisma.graphSubscription.findUnique({
  where: { subscriptionId: notification.subscriptionId },
});
```

Nếu schema hiện tại dùng tên field khác, Claude phải đọc schema thật và dùng đúng field.

Không tự ý đổi schema nếu không cần.

### 6.7. Output response

Với notification request hợp lệ về mặt shape:

```json
{
  "ok": true,
  "received": 2,
  "accepted": 1,
  "skipped": 1
}
```

Status nên là:

```text
202 Accepted
```

Với invalid JSON/body shape:

```json
{
  "ok": false,
  "error": "Invalid Microsoft Graph notification payload"
}
```

Status:

```text
400 Bad Request
```

Với server error bất ngờ:

```json
{
  "ok": false,
  "error": "Webhook notification handling failed"
}
```

Status:

```text
500 Internal Server Error
```

Không trả raw stack trace.

### 6.8. Không xử lý nặng

Trong TASK-025, handler không được làm:

```ts
await graphMailService.getMessage(...)
await detectFacebookVerificationEmail(...)
await extractVerificationCode(...)
await sendTelegramMessage(...)
```

Các bước này thuộc TASK-027.

### 6.9. Test bắt buộc

Cần có test cho các case:

1. `validationToken` vẫn hoạt động.
2. Body thiếu `value` trả 400.
3. Body `value` không phải array trả 400.
4. Notification thiếu `subscriptionId` bị skip.
5. Notification thiếu `clientState` bị skip.
6. Notification `clientState` sai bị skip.
7. Notification đúng `clientState` được accept.
8. Một POST có nhiều notification xử lý đúng count accepted/skipped.
9. Không log full `clientState`.
10. Không gọi Graph fetch/message processing/Telegram trong TASK-025.

## 7. Acceptance criteria

TASK-025 chỉ PASS khi:

* Webhook route nhận được POST notification thật dạng `{ value: [...] }`.
* Validation token behavior từ TASK-024 vẫn pass.
* Route không crash khi body sai.
* Route support nhiều notifications trong cùng request.
* `clientState` được validate.
* Notification invalid bị skip an toàn.
* Notification valid được chuẩn hóa thành accepted object.
* Không fetch email.
* Không extract code.
* Không gửi Telegram.
* Không setup queue thật.
* Không log secret/token/clientState/full email body/full verification code.
* `npm run verify` PASS.
* Gemini review PASS.

## 8. Lệnh kiểm tra

Chạy:

```powershell
npm run verify
```

Nếu project có test riêng:

```powershell
npm test
```

Nếu cần test thủ công webhook local:

```powershell
$body = @{
  value = @(
    @{
      subscriptionId = "test-subscription-id"
      clientState = "test-client-state"
      changeType = "created"
      resource = "users/test/messages/test-message-id"
      resourceData = @{
        id = "test-message-id"
      }
      subscriptionExpirationDateTime = "2026-05-29T10:00:00.000Z"
      tenantId = "test-tenant-id"
    }
  )
} | ConvertTo-Json -Depth 10

Invoke-RestMethod `
  -Method Post `
  -Uri "http://localhost:3000/api/webhooks/microsoft/mail" `
  -ContentType "application/json" `
  -Body $body
```

Lưu ý: test thủ công trên chỉ pass nếu database có subscription test tương ứng hoặc route/service được test bằng mock trong unit test. Không được thêm secret thật vào file test.

## 9. Báo cáo cuối task Claude phải trả

Claude phải báo cáo theo format:

```text
1. Đã làm gì
2. File nào đã tạo/sửa
3. Logic validationToken có còn hoạt động không
4. Logic notification receiver đã xử lý case nào
5. Test nào đã thêm
6. Lệnh nào đã chạy
7. Kết quả npm run verify: PASS/FAIL
8. Những gì cố ý chưa làm vì thuộc TASK-026/TASK-027
9. Rủi ro còn lại
```

````

---

