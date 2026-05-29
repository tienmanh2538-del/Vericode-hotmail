# TASK-023: Tạo Microsoft Graph subscription service

## 1. Mục tiêu

Tạo service phụ trách tạo và quản lý Microsoft Graph subscription cho Inbox messages của mailbox đã kết nối OAuth.

Service này là bước đầu của Sprint 6 — Microsoft webhook & worker.

Sau TASK-023, codebase phải có khả năng:

1. Tạo payload Microsoft Graph subscription đúng chuẩn.
2. Gọi Microsoft Graph API để tạo subscription cho Inbox messages.
3. Generate `clientState` random an toàn cho từng subscription.
4. Lưu `clientStateHash`, không lưu plaintext `clientState`.
5. Lưu subscription id, resource, expiration datetime, status vào database.
6. Có hàm renew/delete subscription để task sau có thể dùng lại.
7. Có unit test bằng mock, không cần gọi Microsoft thật.

TASK-023 chỉ tạo service. Không tạo webhook endpoint thật, không xử lý notification thật, không queue/worker.

---

## 2. Bối cảnh dự án

Dự án Verification Code Relay Tool dùng Microsoft OAuth 2.0 + Microsoft Graph API để đọc mailbox Hotmail/Outlook đã được cấp quyền.

Luồng tổng thể sau này:

```text
Connect mailbox
→ tạo Graph subscription cho Inbox
→ Microsoft gọi webhook khi có email mới
→ webhook validate clientState
→ queue worker fetch message detail
→ detector/extractor lấy Facebook verification code
→ gửi Telegram đúng group
````

TASK-023 chỉ xử lý phần:

```text
Connect mailbox hoặc admin action
→ GraphSubscriptionService.createInboxSubscription(...)
→ Microsoft Graph POST /subscriptions
→ lưu graph subscription vào DB
```

---

## 3. Scope chính xác của TASK-023

### 3.1. Được làm

* Tạo `services/microsoft/graph-subscription.service.ts`.
* Nếu project dùng `src/`, tạo ở `src/services/microsoft/graph-subscription.service.ts`.
* Tạo hoặc cập nhật unit test tương ứng:

  * `tests/unit/microsoft/graph-subscription.service.test.ts`
  * hoặc theo cấu trúc test thực tế của project.
* Thêm env placeholder nếu cần:

  * `MICROSOFT_GRAPH_NOTIFICATION_URL`
  * optional: `MICROSOFT_GRAPH_LIFECYCLE_NOTIFICATION_URL`
* Đọc/validate env theo pattern hiện tại của project.
* Tận dụng service/helper đã có từ TASK-018 đến TASK-022:

  * OAuth token service.
  * token encryption/decryption service.
  * Graph mail service/fetch helper nếu có.
  * Prisma client.
  * hash helper.
  * logger/redact helper.
* Tạo type/interface rõ ràng cho input/output.

### 3.2. Không được làm

* Không tạo route webhook ở TASK-023.
* Không tạo `app/api/webhooks/microsoft/mail`.
* Không xử lý `validationToken`; đó là TASK-024.
* Không xử lý notification payload thật; đó là TASK-025.
* Không setup BullMQ/Redis/queue; đó là TASK-026.
* Không gọi detector/extractor/Telegram sender; đó là TASK-027.
* Không làm UI mailbox dashboard; đó là TASK-028 đến TASK-030.
* Không làm renewal worker định kỳ; đó là TASK-032.
* Không xin scope Microsoft mới ngoài `Mail.Read`, `offline_access`, `User.Read`.
* Không hardcode token, client secret, webhook URL, mailbox email thật.
* Không log access token, refresh token, client secret, `clientState` plaintext.

---

## 4. Yêu cầu kỹ thuật

## 4.1. Microsoft Graph endpoint

Service cần gọi:

```text
POST https://graph.microsoft.com/v1.0/subscriptions
```

Payload cơ bản:

```json
{
  "changeType": "created",
  "notificationUrl": "https://example.com/api/webhooks/microsoft/mail",
  "resource": "/me/mailFolders('Inbox')/messages",
  "expirationDateTime": "2026-06-04T00:00:00.000Z",
  "clientState": "random-secret"
}
```

Lưu ý:

* `resource` dùng đúng Inbox messages.
* `changeType` chỉ dùng `created` trong MVP.
* Không dùng rich notification ở TASK-023.
* Không set `includeResourceData: true`.
* Không cần encryption certificate.
* `notificationUrl` phải lấy từ env/config, không hardcode.
* Nếu có lifecycle URL trong env thì có thể đưa vào payload, nhưng không bắt buộc ở TASK-023.

---

## 4.2. Expiration time

Outlook message subscription có thời hạn dưới 7 ngày.

Service nên set expiration mặc định khoảng 6 ngày hoặc 6 ngày 12 giờ để có buffer an toàn.

Ví dụ:

```text
now + 6 days
```

Không set sát giới hạn tối đa nếu không cần.

Tạo helper:

```ts
calculateDefaultSubscriptionExpiration(now?: Date): Date
```

Yêu cầu test:

* Expiration phải lớn hơn hiện tại.
* Expiration không vượt quá giới hạn an toàn do service quy định.
* Format gửi lên Graph phải là ISO string UTC.

---

## 4.3. clientState

Mỗi subscription phải có `clientState` random riêng.

Yêu cầu:

* Dùng crypto secure random.
* Độ dài không vượt 128 characters.
* Không lưu plaintext `clientState` vào DB nếu schema có `clientStateHash`.
* Lưu hash để TASK-025 webhook receiver có thể validate notification.
* Không log plaintext `clientState`.

Gợi ý:

```ts
generateClientState(): string
hashClientState(clientState: string): string
verifyClientState(clientState: string, storedHash: string): boolean
```

Nếu project đã có helper hash ở `lib/security/hash.ts`, dùng lại helper đó thay vì tạo hàm mới trùng lặp.

---

## 4.4. Database

Service cần lưu record vào model `GraphSubscription` hoặc model tương đương đang có trong Prisma schema.

Các field kỳ vọng:

```text
id
mailboxId
subscriptionId
resource
clientStateHash
expirationDateTime
status
lastRenewedAt
createdAt
updatedAt
```

Nếu tên field thực tế khác, Claude phải đọc `prisma/schema.prisma` và dùng đúng field hiện có.

Không được tạo field lưu plaintext:

```text
clientState
accessToken
refreshToken
code
verificationCode
```

Status đề xuất:

```text
ACTIVE
EXPIRED
RENEW_FAILED
DELETED
ERROR
```

Nếu schema đã có enum/status khác, dùng theo schema hiện tại, không tự ý đổi lớn.

---

## 4.5. Hàm/service cần có

Tạo service export rõ ràng, ví dụ:

```ts
export type CreateInboxSubscriptionInput = {
  mailboxId: string;
  accessToken: string;
  notificationUrl?: string;
  lifecycleNotificationUrl?: string;
  now?: Date;
};

export type GraphSubscriptionResult = {
  id: string;
  mailboxId: string;
  subscriptionId: string;
  resource: string;
  expirationDateTime: Date;
  status: string;
};

export async function createInboxSubscription(
  input: CreateInboxSubscriptionInput
): Promise<GraphSubscriptionResult>;
```

Ngoài ra nên có:

```ts
renewGraphSubscription(...)
deleteGraphSubscription(...)
buildCreateSubscriptionPayload(...)
calculateDefaultSubscriptionExpiration(...)
generateClientState(...)
verifyGraphClientState(...)
```

Không nhất thiết phải đúng tên 100%, nhưng service phải tách logic rõ:

1. Build payload.
2. Call Graph API.
3. Persist DB.
4. Handle error an toàn.
5. Không log secret.

---

## 4.6. Error handling

Service cần xử lý lỗi an toàn:

* Nếu thiếu access token: throw error rõ ràng, không in token.
* Nếu thiếu notification URL: throw config error rõ ràng.
* Nếu Graph trả lỗi 401/403: báo lỗi token/permission.
* Nếu Graph trả lỗi validation URL: báo lỗi webhook endpoint chưa hợp lệ/public HTTPS.
* Nếu Graph trả lỗi khác: báo lỗi generic có status code, không in full response body nếu có secret.
* Nếu DB save fail: không nuốt lỗi.

Không được log:

```text
accessToken
refreshToken
clientSecret
clientState plaintext
full Graph response body nếu có dữ liệu nhạy cảm
```

---

## 5. File/thư mục dự kiến tạo hoặc sửa

Claude phải kiểm tra cấu trúc thực tế trước. Nếu project dùng `src/`, tạo trong `src/`.

Dự kiến:

```text
services/microsoft/graph-subscription.service.ts
tests/unit/microsoft/graph-subscription.service.test.ts
.env.example
lib/env.ts hoặc src/lib/env.ts nếu cần thêm env validation
```

Có thể sửa thêm nếu cần, nhưng phải báo trước và giải thích:

```text
lib/security/hash.ts
lib/logger.ts
prisma/schema.prisma
```

Chỉ sửa `prisma/schema.prisma` nếu model/field cần thiết chưa tồn tại và việc này không phá task trước. Nếu cần migration, phải giải thích rõ cho user trước khi tạo.

---

## 6. Yêu cầu test

Unit test phải mock `fetch` hoặc Graph HTTP client.

Test tối thiểu:

1. Build payload đúng:

   * `changeType = created`
   * `resource = /me/mailFolders('Inbox')/messages`
   * có `notificationUrl`
   * có `expirationDateTime`
   * có `clientState`
2. `clientState` là random và không rỗng.
3. `clientState` không vượt 128 characters.
4. Service không lưu plaintext `clientState`, chỉ lưu hash.
5. Khi Graph trả `201`, service lưu subscription vào DB đúng.
6. Khi thiếu notification URL, service fail an toàn.
7. Khi Graph trả 401/403, service trả error dễ hiểu.
8. Không log access token/clientState plaintext trong test snapshot hoặc mock logger.

Không gọi Microsoft Graph thật trong test.

---

## 7. Acceptance Criteria

TASK-023 được coi là đạt khi:

* Có `graph-subscription.service.ts` đúng vị trí.
* Service tạo payload Microsoft Graph subscription đúng.
* Service dùng resource Inbox messages:

  * `/me/mailFolders('Inbox')/messages`
* Service dùng change type:

  * `created`
* Service generate `clientState` random.
* Service lưu `clientStateHash`, không lưu plaintext.
* Service lưu `subscriptionId`, `resource`, `expirationDateTime`, `status` vào database.
* Có hàm renew/delete hoặc ít nhất helper nền tảng để task sau dùng.
* Có unit test mock Graph API.
* `npm run verify` PASS.
* Gemini review PASS.
* Không tạo webhook endpoint của TASK-024.
* Không tạo queue/worker của TASK-026.
* Không xử lý detector/extractor/Telegram của TASK-027.
* Không hardcode secret/token/webhook URL.
* Không log token hoặc `clientState` plaintext.

---

## 8. Lệnh kiểm tra

Chạy từ root project:

```powershell
npm run verify
```

Nếu có test riêng và package.json hỗ trợ:

```powershell
npm run test
```

Nếu có Prisma generate cần chạy sau schema change:

```powershell
npx prisma generate
npm run verify
```

Không commit nếu verify fail.

---

## 9. Ghi chú cho Claude

Trước khi sửa code, Claude phải báo:

1. Đã đọc `PROJECT_CONTEXT.md`, `ROADMAP.md`, file task này.
2. Cấu trúc project thực tế dùng `src/` hay không.
3. Các file dự kiến tạo/sửa.
4. Có cần sửa Prisma schema không.
5. Có cần thêm env placeholder không.

Claude chỉ được làm TASK-023.

Không được mở rộng sang TASK-024/TASK-025/TASK-026/TASK-027.

---

## 10. Ghi chú cho Gemini

Gemini review phải kiểm tra:

1. Scope có đúng TASK-023 không.
2. Có tạo nhầm webhook endpoint không.
3. Có tạo nhầm queue/worker không.
4. Có hardcode secret/token/webhook URL không.
5. Có lưu plaintext `clientState` không.
6. Có log token/clientState không.
7. Payload Microsoft Graph subscription có đúng không.
8. Unit test có mock Graph API không.
9. `npm run verify` có PASS không.
10. Có file nào chứa `.env` thật hoặc secret thật bị đưa vào git không.



