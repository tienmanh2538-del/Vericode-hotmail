# TASK-018: Tạo Microsoft OAuth connect URL

## 1. Mục tiêu

Tạo backend service và API route để sinh Microsoft OAuth authorization URL cho luồng connect Hotmail/Outlook mailbox.

Sau task này, hệ thống phải có endpoint nội bộ cho phép admin lấy URL đăng nhập Microsoft OAuth với scope tối thiểu:

- Mail.Read
- offline_access
- User.Read

TASK này chỉ tạo URL bắt đầu OAuth flow. Không xử lý callback, không đổi code lấy token, không lưu mailbox, không gọi Microsoft Graph.

---

## 2. Bối cảnh

Dự án Verification Code Relay Tool cần cho admin/customer cấp quyền đọc mailbox Hotmail/Outlook thông qua Microsoft OAuth 2.0 và Microsoft Graph API.

Luồng OAuth tổng thể:

1. Admin chọn Connect Hotmail.
2. Backend tạo Microsoft OAuth authorization URL.
3. User đăng nhập Microsoft và consent scope.
4. Microsoft redirect về callback URL với authorization code.
5. TASK sau sẽ xử lý callback và token.

Trong TASK-018 chỉ làm bước 2.

---

## 3. Yêu cầu chức năng

### 3.1. OAuth service

Tạo service Microsoft OAuth có trách nhiệm build authorization URL.

File dự kiến:

```text
services/microsoft/oauth.service.ts
````

Nếu project dùng `src/`, dùng:

```text
src/services/microsoft/oauth.service.ts
```

Service cần có hàm chính, ví dụ:

```ts
buildMicrosoftOAuthConnectUrl(input?: BuildMicrosoftOAuthConnectUrlInput): MicrosoftOAuthConnectUrlResult
```

Hoặc tên tương đương nhưng phải rõ nghĩa.

Kết quả trả về nên có:

```ts
{
  url: string;
  state: string;
  expiresAt?: string;
}
```

Service phải build URL theo Microsoft OAuth v2 authorize endpoint:

```text
https://login.microsoftonline.com/{tenant}/oauth2/v2.0/authorize
```

Trong đó `{tenant}` lấy từ env:

```text
MICROSOFT_TENANT_ID
```

Nếu không cấu hình, fallback hợp lý là:

```text
common
```

URL phải có các query params tối thiểu:

```text
client_id
response_type=code
redirect_uri
response_mode=query
scope
state
prompt=select_account
```

Scope phải là:

```text
Mail.Read offline_access User.Read
```

Không thêm scope rộng nếu chưa được duyệt.

---

### 3.2. State chống CSRF

OAuth URL bắt buộc phải có `state`.

State cần:

* Random đủ mạnh.
* Không được hardcode.
* Không chứa secret.
* Không chứa token.
* Có thể chứa context tối thiểu nếu cần, nhưng không chứa dữ liệu nhạy cảm.
* Có thể dùng crypto random bytes.

Khuyến nghị:

```ts
crypto.randomBytes(32).toString("base64url")
```

Nếu project hiện tại chưa có helper riêng, có thể tạo helper nhỏ trong service.

Nếu route có thể set cookie, nên set HTTP-only cookie để TASK-019 dùng validate callback sau này.

Cookie gợi ý:

```text
microsoft_oauth_state
```

Cookie nên có:

```text
httpOnly: true
sameSite: "lax"
secure: true trong production
maxAge khoảng 10 phút
path: "/"
```

Không bắt buộc validate state trong TASK-018. Việc validate state sẽ thuộc TASK-019.

---

### 3.3. API route

Tạo API route:

```text
app/api/mailboxes/connect-url/route.ts
```

Hoặc nếu project dùng `src/`:

```text
src/app/api/mailboxes/connect-url/route.ts
```

Endpoint đề xuất:

```text
POST /api/mailboxes/connect-url
```

Có thể hỗ trợ thêm GET nếu project hiện tại đang dùng GET cho API đơn giản, nhưng POST là ưu tiên.

Route cần:

1. Chỉ chạy server-side.
2. Gọi OAuth service để build URL.
3. Set state cookie nếu thiết kế có cookie.
4. Trả JSON:

```json
{
  "url": "https://login.microsoftonline.com/...",
  "expiresAt": "..."
}
```

Không trả về:

```text
client secret
token
refresh token
access token
full env config
```

---

## 4. Yêu cầu env/config

Service phải đọc các biến môi trường đã được chuẩn bị từ TASK-017:

```text
MICROSOFT_CLIENT_ID
MICROSOFT_TENANT_ID
MICROSOFT_REDIRECT_URI
```

Trong TASK-018 không cần dùng:

```text
MICROSOFT_CLIENT_SECRET
```

vì client secret chỉ dùng ở callback/token exchange của TASK-019/TASK-020.

Nếu thiếu `MICROSOFT_CLIENT_ID` hoặc `MICROSOFT_REDIRECT_URI`, service/API phải fail an toàn bằng error rõ ràng, không leak secret.

Ví dụ message an toàn:

```text
Microsoft OAuth is not configured.
```

Không in toàn bộ process.env.

---

## 5. Bảo mật bắt buộc

* Không hardcode Microsoft client ID.
* Không hardcode client secret.
* Không log client secret.
* Không log token.
* Không tạo token ở task này.
* Không xin scope rộng.
* Không expose env raw ra frontend.
* Không dùng `.env` thật trong test.
* Không commit `.env`.
* OAuth state phải random, không cố định.
* API response chỉ trả URL và metadata an toàn.

---

## 6. Test bắt buộc

Cần có unit test cho OAuth service.

File test đặt theo cấu trúc hiện tại của project, ví dụ:

```text
tests/unit/microsoft/oauth.service.test.ts
```

Hoặc nếu project dùng `__tests__`, theo cấu trúc hiện tại.

Test tối thiểu:

1. Build được authorization URL hợp lệ.
2. URL dùng endpoint:

```text
https://login.microsoftonline.com/common/oauth2/v2.0/authorize
```

hoặc tenant từ env nếu được set.

3. URL có:

```text
response_type=code
response_mode=query
client_id
redirect_uri
scope
state
prompt=select_account
```

4. Scope chứa đúng:

```text
Mail.Read
offline_access
User.Read
```

5. Không chứa scope không được phép như:

```text
Mail.Send
Mail.ReadWrite
MailboxSettings.ReadWrite
```

6. State không rỗng và không cố định giữa 2 lần gọi.

7. Khi thiếu config bắt buộc, service fail an toàn bằng error rõ ràng.

---

## 7. Acceptance Criteria

Task được coi là hoàn thành khi:

* Có Microsoft OAuth service để build connect URL.
* Có API route `/api/mailboxes/connect-url`.
* URL sinh ra đúng Microsoft OAuth v2 authorize endpoint.
* URL có đủ params bắt buộc.
* Scope chỉ gồm quyền tối thiểu.
* Có state random chống CSRF.
* Không có token exchange.
* Không có callback handling.
* Không lưu database.
* Không gọi Microsoft Graph.
* Không hardcode secret.
* Unit test PASS.
* `npm run verify` PASS.

---

## 8. Không được làm

Claude không được:

* Làm TASK-019 callback.
* Tạo route `/api/microsoft/oauth/callback` nếu chưa có yêu cầu.
* Gọi Microsoft token endpoint.
* Thêm token encryption.
* Thêm Prisma model mới.
* Lưu mailbox.
* Gọi Graph API.
* Tạo subscription.
* Làm UI connect mailbox đầy đủ.
* Xin thêm scope ngoài `Mail.Read`, `offline_access`, `User.Read`.
* Đưa secret thật vào code/test/docs.

---

## 9. Lệnh kiểm tra

Sau khi code xong, chạy:

```powershell
npm run verify
```

Nếu project có test riêng, có thể chạy thêm:

```powershell
npm test
```

Hoặc:

```powershell
npm run test
```

Tùy package.json thực tế.

---

## 10. Báo cáo cuối task

Claude phải báo lại:

1. Đã làm gì.
2. File nào đã tạo/sửa.
3. OAuth URL đang dùng endpoint nào.
4. Scope nào được request.
5. Có tạo state hay không.
6. Có set cookie state hay không.
7. Test nào đã thêm.
8. Lệnh nào đã chạy.
9. Kết quả PASS/FAIL.
10. Có làm vượt scope không.

````

---

# 8. Những lỗi Claude rất dễ mắc ở TASK-018

## Lỗi 1 — Làm luôn callback

Sai:

```text
Tạo luôn /api/microsoft/oauth/callback
Đổi code lấy token
```

Đúng:

```text
TASK-018 chỉ tạo connect URL.
Callback thuộc TASK-019.
```

---

## Lỗi 2 — Xin quyền quá rộng

Sai:

```text
Mail.ReadWrite
Mail.Send
MailboxSettings.ReadWrite
```

Đúng:

```text
Mail.Read offline_access User.Read
```

---

## Lỗi 3 — Dùng client secret ở TASK-018

Sai:

```text
Dùng MICROSOFT_CLIENT_SECRET để tạo connect URL
```

Đúng:

```text
Connect URL không cần client secret.
Client secret dùng ở token exchange task sau.
```

---

## Lỗi 4 — Không có state

Sai:

```text
OAuth URL không có state
```

Đúng:

```text
Luôn có state random để chống CSRF.
```

---

## Lỗi 5 — Hardcode config

Sai:

```text
client_id=abc thật trong code
redirect_uri hardcode lung tung
```

Đúng:

```text
Đọc từ env/config đã chuẩn bị ở TASK-017.
```

---

## Lỗi 6 — Làm vượt sang UI

Sai:

```text
Tạo hẳn trang connect mailbox đẹp đầy đủ
```

Đúng:

```text
Chỉ API route. UI connect mailbox thuộc TASK-030.
```

---

