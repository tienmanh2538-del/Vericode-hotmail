# TASK-017: Microsoft App Registration checklist & config

## 1. Mục tiêu

Tạo tài liệu và cấu hình nền tảng cho Microsoft OAuth setup.

Task này là bước đầu của Sprint 5 — Microsoft OAuth validation.

Mục tiêu chính:

1. Tạo hoặc cập nhật `docs/MICROSOFT_SETUP.md`.
2. Kiểm tra/cập nhật `.env.example` để có đủ biến môi trường Microsoft OAuth dạng placeholder.
3. Kiểm tra/cập nhật `lib/env.ts` hoặc `src/lib/env.ts` để hỗ trợ Microsoft OAuth config validation an toàn.
4. Đảm bảo project có tài liệu rõ ràng để admin/dev tạo Microsoft App Registration đúng cách.
5. Không dùng secret thật, không gọi Microsoft API thật, không tạo OAuth flow thật trong task này.

---

## 2. Bối cảnh dự án

Project: Verification Code Relay Tool.

Mục tiêu sản phẩm:

- Admin hoặc khách hàng cấp quyền đọc mailbox Hotmail/Outlook bằng Microsoft OAuth 2.0.
- Hệ thống dùng Microsoft Graph API để đọc email khi đã có quyền hợp lệ.
- Khi Facebook/Meta gửi email chứa mã xác minh, hệ thống nhận diện, extract code, chống trùng và gửi vào đúng Telegram group.
- Không lưu mật khẩu email.
- Không log token.
- Không log full verification code.

TASK-017 chỉ là bước chuẩn bị Microsoft App Registration checklist & config.

Các task sau mới làm OAuth thật:

- TASK-018: Tạo Microsoft OAuth connect URL.
- TASK-019: Tạo Microsoft OAuth callback.
- TASK-020: Tạo token encryption service.
- TASK-021: Lưu mailbox sau OAuth connect.
- TASK-022: Tạo Microsoft Graph mail service: read Inbox test.

---

## 3. Phạm vi bắt buộc của TASK-017

Claude chỉ được làm các việc sau:

### 3.1. Tạo hoặc cập nhật tài liệu Microsoft setup

File chính:

```text
docs/MICROSOFT_SETUP.md
````

File này phải có tối thiểu các phần:

1. Mục tiêu Microsoft setup.
2. Tài khoản/portal cần dùng.
3. Cách tạo Microsoft App Registration.
4. Cách chọn supported account types.
5. Cách cấu hình Redirect URI cho local development.
6. Cách cấu hình Redirect URI cho production/staging sau này.
7. Cách tạo client secret.
8. Cách thêm Microsoft Graph delegated permissions.
9. Scope tối thiểu cần dùng.
10. Cấu hình `.env.local`.
11. Checklist xác minh setup.
12. Lỗi thường gặp.
13. Security rules.

---

### 3.2. Cập nhật `.env.example`

Kiểm tra `.env.example`.

Nếu chưa có, thêm các placeholder sau:

```env
# Microsoft OAuth / Graph
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TENANT_ID=common
MICROSOFT_REDIRECT_URI=http://localhost:3000/api/microsoft/oauth/callback
```

Quy tắc:

* `.env.example` chỉ được chứa placeholder.
* Không được chứa client ID thật.
* Không được chứa client secret thật.
* Không được chứa tenant ID thật nếu tenant đó là private/production.
* Không được chứa refresh token/access token.
* Không được làm mất các env cũ của Telegram, database, app, logger.

---

### 3.3. Cập nhật env config validation an toàn

Kiểm tra project đang dùng:

```text
lib/env.ts
```

hoặc:

```text
src/lib/env.ts
```

Tùy cấu trúc thực tế, chỉ sửa đúng file đang được project dùng.

Yêu cầu:

1. Bổ sung đọc các biến Microsoft OAuth:

   * `MICROSOFT_CLIENT_ID`
   * `MICROSOFT_CLIENT_SECRET`
   * `MICROSOFT_TENANT_ID`
   * `MICROSOFT_REDIRECT_URI`

2. Không làm build fail chỉ vì các biến Microsoft đang rỗng khi app chưa chạy Microsoft OAuth thật.

3. Nếu project đã có pattern validate env theo module, làm theo pattern hiện có.

4. Nên có helper/config rõ ràng cho Microsoft, ví dụ:

   * `getMicrosoftOAuthConfig()`
   * hoặc `microsoftOAuthConfig`
   * hoặc format tương đương theo style hiện có.

5. Nếu có validation redirect URI, cần chấp nhận:

   * local dev: `http://localhost:3000/api/microsoft/oauth/callback`
   * production/staging: HTTPS URL.

6. Không log client secret.

7. Không expose client secret ra frontend.

8. Không hardcode scope vào nhiều nơi nếu project đã có file constants phù hợp.

Scope tối thiểu dự kiến:

```text
Mail.Read
offline_access
User.Read
```

Có thể lưu thành constant nếu phù hợp, ví dụ:

```ts
export const MICROSOFT_OAUTH_SCOPES = [
  "Mail.Read",
  "offline_access",
  "User.Read",
] as const;
```

Nhưng không được tạo OAuth connect URL trong TASK-017. Việc build URL thuộc TASK-018.

---

## 4. Nội dung bắt buộc của `docs/MICROSOFT_SETUP.md`

Claude cần tạo nội dung rõ ràng, để người không chuyên code vẫn làm được.

File `docs/MICROSOFT_SETUP.md` phải có nội dung theo tinh thần dưới đây.

---

### 4.1. Mục tiêu

Giải thích rằng tài liệu này dùng để tạo Microsoft App Registration cho hệ thống Verification Code Relay Tool.

App Registration này dùng để:

* Cho phép user đăng nhập Microsoft.
* Xin quyền đọc mailbox qua Microsoft Graph.
* Nhận authorization code qua redirect URI.
* Sau này dùng refresh token để duy trì quyền đọc mailbox khi user đã consent hợp lệ.

Không dùng App Registration này để:

* Lưu mật khẩu Hotmail/Outlook.
* Gửi email.
* Đọc toàn bộ mailbox history nếu không cần.
* Bypass chính sách bảo mật của Microsoft/Facebook/Meta.

---

### 4.2. Portal cần dùng

Hướng dẫn user/dev vào:

```text
Microsoft Entra admin center
App registrations
New registration
```

Không cần viết raw URL nếu không chắc chắn. Có thể ghi tên portal và menu để tránh lỗi URL thay đổi.

---

### 4.3. Tạo app registration

Thông tin đề xuất:

```text
Name:
Verification Code Relay Tool - Local Dev
```

Supported account types:

Nếu MVP cần đọc cả Hotmail/Outlook cá nhân và tài khoản Microsoft work/school, chọn:

```text
Accounts in any organizational directory and personal Microsoft accounts
```

Nếu chỉ test với Hotmail/Outlook cá nhân, ghi chú rằng lựa chọn account type phải hỗ trợ personal Microsoft accounts.

Redirect URI platform:

```text
Web
```

Local redirect URI:

```text
http://localhost:3000/api/microsoft/oauth/callback
```

Production redirect URI sau này:

```text
https://YOUR_DOMAIN.com/api/microsoft/oauth/callback
```

Lưu ý:

* Redirect URI trong Microsoft App Registration phải khớp chính xác với `MICROSOFT_REDIRECT_URI`.
* Sai dấu `/`, sai protocol `http/https`, sai port hoặc sai path đều có thể gây lỗi OAuth callback.
* Local dev có thể dùng `http://localhost`.
* Production/staging nên dùng HTTPS.

---

### 4.4. Client ID, Tenant ID, Client Secret

Sau khi tạo App Registration, tài liệu phải hướng dẫn lấy:

```text
Application (client) ID
Directory (tenant) ID
```

Tạo client secret tại:

```text
Certificates & secrets
Client secrets
New client secret
```

Quy tắc bảo mật:

* Copy `Value` của client secret ngay khi tạo.
* Không dùng `Secret ID` thay cho `Value`.
* Không commit client secret.
* Không paste client secret vào ChatGPT/Claude/Gemini/Cursor.
* Không lưu client secret trong `docs/`.
* Chỉ lưu ở `.env.local` hoặc secret manager.
* Nếu lộ secret, phải rotate secret.

---

### 4.5. API permissions

Vào:

```text
API permissions
Add a permission
Microsoft Graph
Delegated permissions
```

Thêm các quyền tối thiểu:

```text
Mail.Read
offline_access
User.Read
```

Giải thích:

* `Mail.Read`: đọc email sau khi user cấp quyền.
* `offline_access`: cho phép duy trì quyền truy cập lâu hơn, phục vụ refresh token khi phù hợp.
* `User.Read`: đọc thông tin cơ bản user để xác định mailbox/account.

Không thêm nếu chưa cần:

```text
Mail.Send
Mail.ReadWrite
MailboxSettings.ReadWrite
Files.Read
Calendars.Read
Contacts.Read
```

Lý do:

* TASK-017 chỉ chuẩn bị đọc mailbox.
* Không gửi email.
* Không sửa email.
* Không đọc calendar/contact/file.

---

### 4.6. Cấu hình `.env.local`

Tài liệu cần hướng dẫn user tạo/cập nhật `.env.local` ở local machine:

```env
MICROSOFT_CLIENT_ID=replace_with_application_client_id
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TENANT_ID=common
MICROSOFT_REDIRECT_URI=http://localhost:3000/api/microsoft/oauth/callback
```

Giải thích:

* `MICROSOFT_CLIENT_ID`: Application/client ID.
* `MICROSOFT_CLIENT_SECRET`: client secret value, không phải secret ID.
* `MICROSOFT_TENANT_ID`: dùng `common` trong giai đoạn đầu nếu cần hỗ trợ nhiều loại account; có thể đổi sang tenant cụ thể nếu sau này chỉ dùng tenant nội bộ.
* `MICROSOFT_REDIRECT_URI`: phải khớp App Registration.

Không được đưa giá trị thật vào `.env.example`.

---

### 4.7. Checklist kiểm tra setup

Tài liệu phải có checklist:

```text
[ ] Đã tạo Microsoft App Registration.
[ ] Supported account type hỗ trợ đúng loại tài khoản cần test.
[ ] Redirect URI local đã là http://localhost:3000/api/microsoft/oauth/callback.
[ ] Đã copy Application/client ID.
[ ] Đã tạo client secret và copy secret Value.
[ ] Đã thêm delegated permissions: Mail.Read, offline_access, User.Read.
[ ] Không thêm Mail.Send hoặc Mail.ReadWrite.
[ ] Đã cập nhật .env.local.
[ ] .env.local nằm trong .gitignore.
[ ] .env.example chỉ có placeholder.
[ ] Không paste secret vào chat/log/docs.
```

---

### 4.8. Lỗi thường gặp

Tài liệu phải có bảng lỗi thường gặp:

1. `AADSTS50011`

   * Nguyên nhân: Redirect URI trong request không khớp App Registration.
   * Cách xử lý: kiểm tra chính xác protocol, domain, port, path.

2. `invalid_client`

   * Nguyên nhân: sai client ID hoặc client secret.
   * Cách xử lý: kiểm tra lại `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`.

3. Không nhận refresh token

   * Nguyên nhân: thiếu `offline_access` hoặc consent chưa đúng.
   * Cách xử lý: kiểm tra scope và consent.

4. Consent bị chặn

   * Nguyên nhân: tenant yêu cầu admin consent.
   * Cách xử lý: dùng tài khoản admin tenant hoặc cấu hình consent phù hợp.

5. Dùng nhầm Secret ID thay vì Secret Value

   * Nguyên nhân: Microsoft chỉ hiển thị secret value lúc tạo.
   * Cách xử lý: tạo client secret mới, copy đúng value.

---

## 5. File/thư mục dự kiến tạo hoặc sửa

Claude được phép tạo/sửa:

```text
docs/tasks/TASK-017-microsoft-app-registration-checklist-config.md
docs/MICROSOFT_SETUP.md
.env.example
lib/env.ts
src/lib/env.ts
tests/**/*
```

Lưu ý:

* User có thể tự tạo file task bằng tay trước, Claude không nhất thiết phải tạo file task.
* Claude chỉ được sửa `lib/env.ts` hoặc `src/lib/env.ts` theo cấu trúc thực tế.
* Nếu project không có test env hiện tại, Claude có thể thêm test nhỏ nếu phù hợp với pattern hiện có.
* Không tạo cả `lib/env.ts` và `src/lib/env.ts` song song nếu project chỉ dùng một cấu trúc.

---

## 6. Không được làm

Claude không được:

```text
Không tạo OAuth connect URL route.
Không tạo OAuth callback route.
Không gọi endpoint Microsoft token.
Không tạo token encryption service.
Không lưu mailbox vào database.
Không đọc Microsoft Inbox.
Không tạo Microsoft Graph subscription.
Không tạo webhook receiver.
Không tạo queue/worker.
Không tạo dashboard connect mailbox.
Không thêm Mail.Send.
Không thêm Mail.ReadWrite.
Không hardcode client secret.
Không commit .env hoặc .env.local.
Không log secret/token/code.
Không sửa schema Prisma nếu không cần cho task này.
Không refactor lớn cấu trúc project.
```

---

## 7. Tiêu chí nghiệm thu

TASK-017 chỉ được coi là đạt khi:

```text
[ ] Có docs/MICROSOFT_SETUP.md rõ ràng, đủ bước tạo Microsoft App Registration.
[ ] docs/MICROSOFT_SETUP.md có redirect URI local chuẩn.
[ ] docs/MICROSOFT_SETUP.md có scope tối thiểu: Mail.Read, offline_access, User.Read.
[ ] docs/MICROSOFT_SETUP.md có checklist bảo mật.
[ ] docs/MICROSOFT_SETUP.md có lỗi thường gặp và cách xử lý.
[ ] .env.example có đủ Microsoft OAuth placeholder nếu trước đó chưa có.
[ ] .env.example không chứa secret thật.
[ ] Env config đọc/validate Microsoft config an toàn.
[ ] Build không fail khi Microsoft env chưa có secret thật.
[ ] Không có OAuth route/callback/token exchange trong task này.
[ ] Không có Graph API call trong task này.
[ ] Không có secret/token bị log.
[ ] npm run verify PASS.
[ ] Gemini review PASS.
```

---

## 8. Lệnh kiểm tra

Claude cần chạy tối thiểu:

```powershell
npm run verify
```

Nếu project có test riêng và Claude sửa env config/test, có thể chạy thêm:

```powershell
npm test
```

Hoặc theo script thực tế trong `package.json`.

---

## 9. Báo cáo cuối task bắt buộc

Khi xong, Claude phải báo cáo theo format:

```text
1. Đã làm gì
2. File nào thay đổi
3. Lệnh nào đã chạy
4. Kết quả PASS/FAIL
5. Có tạo/sửa docs/MICROSOFT_SETUP.md không
6. Có sửa .env.example không
7. Có sửa env config không
8. Có làm vượt scope không
9. Rủi ro còn lại
10. Đề xuất task tiếp theo
```

---

## 10. Ghi chú bảo mật

* Không paste Microsoft client secret vào chat.
* Không paste `.env.local` vào chat.
* Nếu cần debug env, chỉ in tên biến có tồn tại hay không, không in giá trị.
* Nếu secret đã lộ, phải rotate.
* `.env.example` chỉ là file mẫu.
* `.env.local` là file local chứa secret thật và không được commit.

````

---




