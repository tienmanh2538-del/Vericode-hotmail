# TASK-019: Tạo Microsoft OAuth callback

## 1. Mục tiêu

Tạo endpoint callback cho Microsoft OAuth:

```text
GET /api/microsoft/oauth/callback
````

Endpoint này nhận redirect từ Microsoft sau khi user/admin cấp quyền OAuth, xử lý các query params `code`, `state`, `error`, `error_description`, sau đó đổi authorization code lấy token bằng Microsoft OAuth token endpoint.

Task này chỉ nhằm xác thực rằng OAuth callback và token exchange hoạt động đúng.

## 2. Bối cảnh

Dự án Verification Code Relay Tool dùng Microsoft OAuth 2.0 + Microsoft Graph API để đọc mailbox Hotmail/Outlook với quyền hợp lệ.

Luồng tổng thể:

```text
Admin chọn Connect Hotmail
→ App tạo Microsoft OAuth connect URL
→ User đăng nhập Microsoft và cấp quyền
→ Microsoft redirect về callback URL
→ Backend nhận authorization code
→ Backend đổi authorization code lấy access token + refresh token
```

TASK-018 đã tạo Microsoft OAuth connect URL.

TASK-019 tiếp tục tạo callback để nhận `code` và thực hiện token exchange.

## 3. Scope được phép làm

Trong task này được phép:

1. Tạo route:

```text
app/api/microsoft/oauth/callback/route.ts
```

Nếu project dùng `src/`, dùng:

```text
src/app/api/microsoft/oauth/callback/route.ts
```

2. Mở rộng service Microsoft OAuth hiện có nếu cần, ví dụ:

```text
services/microsoft/oauth.service.ts
```

hoặc nếu project dùng `src/`:

```text
src/services/microsoft/oauth.service.ts
```

3. Thêm type/helper cần thiết cho token exchange.

4. Validate callback params:

```text
code
state
error
error_description
```

5. Validate `state` theo đúng cơ chế đã tạo ở TASK-018.

6. Gọi token endpoint:

```text
https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token
```

7. Gửi request dạng:

```text
Content-Type: application/x-www-form-urlencoded
```

8. Xử lý success/fail an toàn.

9. Redirect về trang admin hoặc route fallback nội bộ với trạng thái success/error, nhưng không đưa token vào URL.

10. Viết test cho success/error cases.

11. Chạy `npm run verify`.

## 4. Scope không được làm

Không được làm các việc sau trong TASK-019:

1. Không tạo token encryption service.
2. Không encrypt refresh token.
3. Không lưu access token hoặc refresh token vào database.
4. Không tạo mailbox record.
5. Không gọi Microsoft Graph để đọc Inbox.
6. Không tạo Graph subscription.
7. Không tạo webhook.
8. Không tạo queue/worker.
9. Không gửi Telegram.
10. Không tạo UI mailbox dashboard mới nếu task trước chưa có.
11. Không thêm scope Microsoft mới ngoài scope đã thống nhất.
12. Không đưa access token/refresh token/client secret vào console log, response body, URL, test snapshot hoặc report.

## 5. Yêu cầu kỹ thuật chi tiết

### 5.1. Callback route

Route cần xử lý method GET:

```ts
export async function GET(request: Request) {
  // parse URL
  // handle error
  // validate code/state
  // exchange code for tokens
  // redirect success/error
}
```

Route phải đọc query params từ:

```ts
const url = new URL(request.url);
const code = url.searchParams.get("code");
const state = url.searchParams.get("state");
const error = url.searchParams.get("error");
const errorDescription = url.searchParams.get("error_description");
```

### 5.2. Khi Microsoft trả lỗi

Nếu URL có `error`, ví dụ:

```text
?error=access_denied&error_description=...
```

Route phải:

1. Không gọi token endpoint.
2. Không crash.
3. Trả redirect/error response an toàn.
4. Không expose raw `error_description` nếu có thể chứa nội dung dài/khó kiểm soát.
5. Có thể map lỗi về reason ngắn:

```text
access_denied
oauth_error
invalid_request
```

Ví dụ redirect an toàn:

```text
/admin/mailboxes?oauth=error&reason=access_denied
```

Nếu chưa có `/admin/mailboxes`, fallback:

```text
/admin?oauth=error&reason=access_denied
```

### 5.3. Khi thiếu code

Nếu không có `code`:

1. Không gọi token endpoint.
2. Trả error response hoặc redirect error.
3. Có test case cho trường hợp này.

### 5.4. Khi state không hợp lệ

Nếu thiếu `state` hoặc state không hợp lệ:

1. Không gọi token endpoint.
2. Trả lỗi an toàn.
3. Không tiếp tục exchange token.

State là cơ chế chống CSRF trong OAuth callback. Claude phải đọc lại cách TASK-018 tạo state để validate tương ứng.

Không được tự tạo một cơ chế state hoàn toàn mới làm lệch TASK-018 nếu TASK-018 đã có cơ chế state.

### 5.5. Token exchange

Service nên có hàm rõ ràng, ví dụ:

```ts
exchangeAuthorizationCodeForTokens(input)
```

Input đề xuất:

```ts
type ExchangeAuthorizationCodeInput = {
  code: string;
  redirectUri: string;
  codeVerifier?: string;
};
```

Output nội bộ đề xuất:

```ts
type MicrosoftOAuthTokenResult = {
  tokenType: string;
  expiresIn: number;
  scope?: string;
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
};
```

Lưu ý: type có accessToken/refreshToken vì service cần nhận từ Microsoft, nhưng route không được return/log các token này.

### 5.6. Token request body

Request body gửi đến Microsoft token endpoint nên có:

```text
client_id
client_secret
code
redirect_uri
grant_type=authorization_code
```

Nếu TASK-018 đã dùng PKCE thì thêm:

```text
code_verifier
```

Nếu TASK-018 không dùng PKCE và đây là confidential web app server-side, dùng `client_secret` trên server.

Không bao giờ đưa `client_secret` ra frontend.

### 5.7. Tenant

Dùng env đã có từ TASK-017/TASK-018:

```text
MICROSOFT_TENANT_ID=common
```

Token endpoint:

```text
https://login.microsoftonline.com/${MICROSOFT_TENANT_ID}/oauth2/v2.0/token
```

Nếu env chưa có, không hardcode secret. Dùng config/env service hiện có.

### 5.8. Redirect URI

Redirect URI dùng khi token exchange phải giống redirect URI đã dùng khi tạo connect URL:

```text
MICROSOFT_REDIRECT_URI=http://localhost:3000/api/microsoft/oauth/callback
```

Không tự ý đổi thành route khác.

### 5.9. Không trả token ra browser

Sai:

```json
{
  "access_token": "...",
  "refresh_token": "..."
}
```

Đúng:

```text
Redirect /admin/mailboxes?oauth=success
```

hoặc nếu chưa có mailbox UI:

```text
Redirect /admin?oauth=success
```

### 5.10. Không lưu token trong TASK-019

Trong task này sau khi token exchange thành công, có thể chỉ xác nhận success và discard token.

Việc encrypt/lưu token sẽ làm ở TASK-020/TASK-021.

Nếu cần chuẩn bị cho task sau, chỉ tạo type/interface an toàn, không lưu DB.

## 6. File/thư mục dự kiến tạo hoặc sửa

Claude phải kiểm tra cấu trúc thực tế trước. Nếu project dùng `src/`, tạo trong `src/`.

Dự kiến:

```text
app/api/microsoft/oauth/callback/route.ts
services/microsoft/oauth.service.ts
tests/unit/microsoft/oauth-callback.test.ts
tests/unit/microsoft/oauth.service.test.ts
```

Hoặc tương ứng dưới `src/`.

Có thể sửa:

```text
lib/env.ts
```

chỉ khi env hiện tại thiếu biến cần thiết hoặc type validation chưa hỗ trợ callback.

Không được sửa `.env.local` bằng code.

Không được in nội dung `.env.local`.

## 7. Test bắt buộc

Cần có test tối thiểu cho các case:

### Case 1: Callback có error

Input:

```text
/api/microsoft/oauth/callback?error=access_denied&error_description=User%20denied
```

Expected:

```text
- Không gọi token endpoint.
- Redirect/error response an toàn.
- Không expose token.
```

### Case 2: Callback thiếu code

Input:

```text
/api/microsoft/oauth/callback?state=valid
```

Expected:

```text
- Không gọi token endpoint.
- Trả lỗi an toàn.
```

### Case 3: State invalid

Input:

```text
/api/microsoft/oauth/callback?code=abc&state=invalid
```

Expected:

```text
- Không gọi token endpoint.
- Trả lỗi an toàn.
```

### Case 4: Token endpoint success

Mock Microsoft token endpoint trả:

```json
{
  "token_type": "Bearer",
  "expires_in": 3599,
  "scope": "Mail.Read User.Read",
  "access_token": "fake-access-token",
  "refresh_token": "fake-refresh-token"
}
```

Expected:

```text
- Route xử lý success.
- Không return token trong response.
- Không log token.
```

### Case 5: Token endpoint fail

Mock Microsoft token endpoint trả lỗi:

```json
{
  "error": "invalid_grant",
  "error_description": "Authorization code expired"
}
```

Expected:

```text
- Route xử lý fail an toàn.
- Không crash.
- Không expose raw secret/token.
```

## 8. Bảo mật bắt buộc

1. Không log:

```text
access_token
refresh_token
id_token
client_secret
authorization code
full callback URL nếu chứa code
```

2. Không đưa token vào:

```text
URL
response JSON
HTML
test snapshot
report
console.log
```

3. Không commit `.env.local`.

4. Không hardcode client secret.

5. Không đổi scope OAuth sang quyền rộng hơn.

6. Không dùng `Mail.ReadWrite`, `Mail.Send`, `MailboxSettings.ReadWrite`.

## 9. Lệnh kiểm tra

Sau khi sửa code, Claude phải chạy:

```powershell
npm run verify
```

Nếu project có test riêng, có thể chạy thêm:

```powershell
npm test
```

hoặc:

```powershell
npx vitest run
```

Nhưng cuối cùng bắt buộc:

```powershell
npm run verify
```

## 10. Tiêu chí nghiệm thu

TASK-019 chỉ PASS khi:

1. Có route callback Microsoft OAuth.
2. Route nhận được `code`, `state`, `error`.
3. Route validate state.
4. Route đổi authorization code sang token qua Microsoft token endpoint.
5. Không return token ra browser.
6. Không log token/client secret/code.
7. Có test success/failure.
8. `npm run verify` PASS.
9. Gemini review PASS.
10. Không làm vượt scope sang TASK-020/021/022.

## 11. Báo cáo cuối task Claude phải trả về

Claude phải báo:

```text
1. Đã làm gì
2. File nào đã tạo/sửa
3. Có làm đúng scope TASK-019 không
4. Token có bị log/return không
5. Test nào đã thêm
6. Lệnh nào đã chạy
7. npm run verify PASS/FAIL
8. Rủi ro còn lại
9. Đề xuất task tiếp theo: TASK-020 token encryption service
```

````

---

# 13. Lỗi dễ gặp ở TASK-019

## Lỗi 1: Redirect URI mismatch

Dấu hiệu:

```text
AADSTS50011
redirect_uri mismatch
```

Nguyên nhân thường là:

```text
MICROSOFT_REDIRECT_URI trong .env.local khác redirect URI đã đăng ký trong Microsoft App Registration.
```

Cần khớp chính xác:

```text
http://localhost:3000/api/microsoft/oauth/callback
```

Microsoft yêu cầu `redirect_uri` phải khớp với URI đã đăng ký trong app registration. ([Microsoft Learn][1])

---

## Lỗi 2: Dùng lại code cũ

Dấu hiệu:

```text
invalid_grant
authorization code is invalid or expired
```

Nguyên nhân:

```text
Bạn refresh lại callback URL cũ hoặc dùng lại code đã exchange.
```

Authorization code chỉ dùng một lần. Muốn test lại, phải bắt đầu lại từ connect URL mới. ([Microsoft Learn][2])

---

## Lỗi 3: State invalid

Nguyên nhân:

```text
Callback không đọc đúng state đã tạo ở TASK-018.
Hoặc state bị mất do cookie/session không khớp.
```

Không nên bỏ qua state. Nếu state invalid thì phải fail an toàn.

---

## Lỗi 4: Token bị lộ ra response

Sai nghiêm trọng nếu thấy:

```text
access_token=...
refresh_token=...
```

trong:

```text
browser URL
response JSON
console
test snapshot
Gemini report
```

Project context yêu cầu không log token và không expose token qua frontend. 

---

