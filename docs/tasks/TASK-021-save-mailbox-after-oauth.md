
# TASK-021: Lưu mailbox sau OAuth connect

## 1. Mục tiêu

Sau khi Microsoft OAuth callback đổi authorization code thành token thành công, hệ thống phải lưu mailbox đã connect vào database một cách an toàn.

Task này nối tiếp:

- TASK-017: Microsoft App Registration checklist & config
- TASK-018: Microsoft OAuth connect URL
- TASK-019: Microsoft OAuth callback
- TASK-020: Token encryption service

Kết quả mong muốn:

```text
OAuth callback thành công
→ lấy được token response từ Microsoft
→ lấy thông tin user/mailbox cơ bản
→ encrypt refresh token
→ upsert mailbox vào database
→ ghi audit log MAILBOX_CONNECTED
→ không expose token ra frontend/log
````

## 2. Phạm vi bắt buộc

Claude Code chỉ được làm đúng TASK-021.

Được phép làm:

1. Tạo service:

```text
services/microsoft/mailbox-connect.service.ts
```

Nếu project dùng `src/`, tạo ở:

```text
src/services/microsoft/mailbox-connect.service.ts
```

2. Tích hợp service này vào OAuth callback hiện có:

```text
app/api/microsoft/oauth/callback/route.ts
```

hoặc vị trí callback thực tế trong project.

3. Dùng encryption service từ TASK-020 để mã hóa refresh token trước khi lưu DB.

4. Dùng Prisma client hiện có để upsert mailbox.

5. Ghi audit log bằng audit log service đã có từ TASK-016 nếu tồn tại.

6. Thêm unit test/integration test phù hợp, dùng mock token và mock Microsoft profile, không dùng secret thật.

7. Cập nhật type/helper tối thiểu nếu cần.

## 3. Không được làm trong task này

Không được làm:

* Không đọc Inbox thật.
* Không gọi `/me/messages`.
* Không tạo Microsoft Graph subscription.
* Không tạo webhook endpoint.
* Không setup queue/worker.
* Không xử lý email verification thật.
* Không gửi Telegram.
* Không tạo mailbox dashboard/list/detail UI.
* Không hardcode Microsoft token/client secret.
* Không log access token.
* Không log refresh token.
* Không trả token ra response frontend.
* Không lưu refresh token plaintext.
* Không tạo field database lưu token plaintext.

## 4. Luồng xử lý kỹ thuật

Luồng chuẩn:

```text
OAuth callback nhận code
→ OAuth service đổi code lấy token response
→ mailbox connect service nhận token response
→ validate có refresh_token
→ gọi Microsoft Graph /me hoặc helper profile hiện có để lấy thông tin user cơ bản
→ xác định email mailbox:
   ưu tiên user.mail
   nếu user.mail rỗng thì dùng user.userPrincipalName
→ encrypt refresh_token bằng encryption service
→ upsert Mailbox theo microsoftUserId hoặc emailAddress + provider
→ set status ACTIVE
→ lưu tokenLastRefreshedAt = now
→ ghi audit log MAILBOX_CONNECTED
→ callback trả success/redirect
```

Lưu ý:

* Nếu Microsoft profile không có `mail`, dùng `userPrincipalName`.
* Không lưu access token lâu dài.
* Nếu cần lưu expiry để task sau dùng, chỉ lưu metadata không nhạy cảm như `accessTokenExpiresAt`, nhưng không bắt buộc nếu schema chưa có.
* Nếu refresh token không tồn tại, phải fail an toàn và không tạo mailbox ACTIVE giả.

## 5. Data contract đề xuất

Tạo input type cho service:

```ts
export type SaveConnectedMailboxInput = {
  microsoftUserId: string;
  emailAddress: string;
  displayName?: string | null;
  refreshToken: string;
  accessTokenExpiresAt?: Date | null;
  scope?: string | null;
  connectedByUserId?: string | null;
};
```

Tạo result type:

```ts
export type SaveConnectedMailboxResult = {
  mailboxId: string;
  emailAddress: string;
  status: "ACTIVE" | "RECONNECT_REQUIRED" | "ERROR" | string;
  created: boolean;
};
```

Tên type có thể điều chỉnh theo style code hiện tại, nhưng ý nghĩa phải giữ nguyên.

## 6. Database behavior

Service phải dùng upsert để tránh connect trùng tạo nhiều mailbox.

Khóa ưu tiên:

```text
provider + microsoftUserId
```

Nếu schema chưa có unique theo `provider + microsoftUserId`, dùng unique có sẵn phù hợp nhất.

Nếu schema hiện tại chỉ unique theo `emailAddress`, dùng `emailAddress + provider` nếu có.

Không tự ý refactor toàn bộ Prisma schema. Nếu schema thiếu field bắt buộc, chỉ thêm field tối thiểu phục vụ task này và tạo migration rõ ràng.

Field mailbox nên có hoặc tận dụng:

```text
id
emailAddress
provider = microsoft
status = ACTIVE
microsoftUserId
encryptedRefreshToken
tokenLastRefreshedAt
createdBy
createdAt
updatedAt
```

Tuyệt đối không thêm field:

```text
refreshToken
plainRefreshToken
accessToken
plainAccessToken
```

## 7. Security requirements

Bắt buộc:

* Refresh token phải encrypt trước khi lưu database.
* Access token không được lưu lâu dài.
* Không log token.
* Không trả token về frontend.
* Không print token trong test snapshot.
* Error message không chứa token.
* `.env` không bị commit.
* Test chỉ dùng token giả.

Nếu có logger, mọi metadata log phải được sanitize.

## 8. Audit log

Nếu project đã có audit log service từ TASK-016, sau khi lưu mailbox thành công phải ghi action:

```text
MAILBOX_CONNECTED
```

Metadata audit log chỉ chứa dữ liệu an toàn:

```json
{
  "mailboxId": "...",
  "emailAddress": "client@example.com",
  "provider": "microsoft",
  "status": "ACTIVE"
}
```

Không bao giờ đưa token vào audit log.

Nếu audit service chưa tồn tại hoặc tên hàm khác, Claude phải dùng service hiện có. Không tạo hệ thống audit log lớn mới ngoài scope.

## 9. OAuth callback integration

Trong callback route hiện có, sau khi token exchange thành công:

1. Không return raw token response.
2. Gọi mailbox connect service.
3. Nếu thành công, redirect về trang admin hoặc trả JSON success tùy pattern hiện tại.
4. Nếu lỗi, trả lỗi an toàn.

Response thành công dạng JSON nếu project đang test API:

```json
{
  "ok": true,
  "mailbox": {
    "id": "...",
    "emailAddress": "client@example.com",
    "status": "ACTIVE"
  }
}
```

Không được có:

```json
{
  "accessToken": "...",
  "refreshToken": "..."
}
```

## 10. Microsoft profile

Để biết mailbox nào vừa connect, có thể gọi Microsoft Graph:

```text
GET https://graph.microsoft.com/v1.0/me?$select=id,mail,userPrincipalName,displayName
```

Yêu cầu scope:

```text
User.Read
```

Không đọc Inbox trong task này.

Nếu project đã có helper Graph user/profile từ task trước, dùng lại. Nếu chưa có, tạo helper nhỏ chỉ phục vụ lấy `/me`, nhưng không tạo full `graph-mail.service.ts` vì đó là TASK-022.

## 11. Test cases bắt buộc

Tạo test phù hợp với cấu trúc hiện tại, ví dụ:

```text
tests/unit/microsoft/mailbox-connect.service.test.ts
```

hoặc nếu project dùng `__tests__`, đặt đúng cấu trúc hiện có.

Test cần có:

### Case 1 — Save new mailbox

Input:

```text
microsoftUserId = ms-user-001
emailAddress = client@example.com
refreshToken = fake-refresh-token
```

Expect:

```text
Mailbox được tạo
status = ACTIVE
encryptedRefreshToken khác refresh token gốc
không lưu plaintext token
```

### Case 2 — Reconnect existing mailbox

Input cùng `microsoftUserId`, refresh token mới.

Expect:

```text
Không tạo duplicate mailbox
encryptedRefreshToken được update
status = ACTIVE
tokenLastRefreshedAt được update
```

### Case 3 — Missing refresh token

Input thiếu refresh token.

Expect:

```text
Throw hoặc return fail an toàn
Không tạo mailbox ACTIVE
Không ghi token undefined/null vào DB
```

### Case 4 — Profile mail empty

Microsoft profile:

```json
{
  "id": "ms-user-001",
  "mail": null,
  "userPrincipalName": "client@hotmail.com"
}
```

Expect:

```text
emailAddress = client@hotmail.com
```

### Case 5 — No token leakage

Kiểm tra response/log/mock result không chứa:

```text
fake-refresh-token
fake-access-token
```

## 12. Lệnh kiểm tra

Sau khi code xong, Claude phải chạy:

```powershell
npm run verify
```

Nếu project có Prisma migration/schema thay đổi, chạy thêm lệnh phù hợp theo package script hiện có, ví dụ:

```powershell
npx prisma format
npx prisma generate
```

Không tự chạy command phá dữ liệu như reset database nếu chưa được user duyệt.

## 13. Tiêu chí nghiệm thu

Task được coi là PASS khi:

* OAuth callback sau khi token exchange có gọi service lưu mailbox.
* Refresh token được encrypt trước khi lưu DB.
* Mailbox được upsert, không tạo trùng khi reconnect.
* Mailbox có trạng thái `ACTIVE` sau connect thành công.
* Không lưu access token lâu dài.
* Không log access token/refresh token.
* Không trả token trong API response.
* Có audit log `MAILBOX_CONNECTED` nếu audit service đã có.
* Có test cho save mới, reconnect, thiếu refresh token, fallback email.
* `npm run verify` PASS.
* Gemini review PASS.

## 14. Báo cáo cuối task Claude phải trả

Claude phải báo rõ:

```text
1. Đã làm gì
2. File nào đã tạo/sửa
3. Có thay đổi Prisma schema không
4. Có migration không
5. Lệnh đã chạy
6. Kết quả npm run verify
7. Có đảm bảo không log/lưu plaintext token không
8. Rủi ro còn lại
9. Có làm vượt scope không
```

````
# 8. Gợi ý kỹ thuật cho Claude để tránh sai

## 8.1. Nên lấy email mailbox bằng cách nào?

Trong callback, sau khi có `access_token`, cần biết mailbox nào vừa connect. Cách an toàn là gọi Microsoft Graph:

```text
GET /me?$select=id,mail,userPrincipalName,displayName
```

Microsoft Graph `/me` dùng để lấy thông tin user hiện tại, và nếu cần property không trả mặc định thì dùng `$select`. ([Microsoft Learn][1])

Logic nên là:

```ts
const emailAddress = profile.mail ?? profile.userPrincipalName;
```

Không dùng Inbox trong task này.

---

## 8.2. Vì sao vẫn cần `offline_access`?

Với OAuth authorization code flow, app có thể lấy authorized access qua browser redirect. ([Microsoft Learn][2]) Refresh token chỉ được cấp khi request có scope `offline_access`, theo tài liệu Microsoft. ([Microsoft Learn][3])

Vì vậy nếu callback không có `refresh_token`, hệ thống không nên tạo mailbox `ACTIVE` giả.

---

## 8.3. Scope tối thiểu

Task này vẫn bám scope tối thiểu của dự án:

```text
Mail.Read
offline_access
User.Read
```

Microsoft Graph yêu cầu app được cấp permission phù hợp để truy cập dữ liệu Graph. ([Microsoft Learn][4]) Dự án cũng đã quy định không xin quyền rộng như `Mail.Send`, `Mail.ReadWrite`, `MailboxSettings.ReadWrite` nếu chưa cần. 

---



