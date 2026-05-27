# Microsoft App Registration Setup

> Hướng dẫn cấu hình Microsoft App Registration cho **Verification Code Relay Tool**.
>
> Tài liệu này là bước chuẩn bị cho Sprint 5 (Microsoft OAuth). Khi làm theo đúng các bước dưới đây, dev/admin sẽ có đủ thông tin để điền vào `.env.local` trước khi TASK-018 (build OAuth connect URL) và TASK-019 (OAuth callback) bắt đầu chạy.

---

## 1. Mục tiêu

App Registration này được dùng để:

- Cho phép user đăng nhập Microsoft (Hotmail/Outlook cá nhân hoặc tài khoản work/school).
- Xin **delegated permission** đọc mailbox qua Microsoft Graph.
- Nhận `authorization code` qua **Redirect URI** sau khi user đồng ý.
- Dùng **refresh token** để duy trì quyền đọc mailbox khi user đã consent hợp lệ.

App Registration này **không** được dùng để:

- Lưu mật khẩu Hotmail/Outlook.
- Gửi email.
- Đọc toàn bộ mailbox history nếu không thực sự cần.
- Bypass chính sách bảo mật của Microsoft / Facebook / Meta.

---

## 2. Portal / tài khoản cần dùng

Truy cập:

```text
Microsoft Entra admin center
  -> Applications
  -> App registrations
  -> New registration
```

> Microsoft đôi khi đổi tên menu (Azure AD -> Entra ID). Nếu UI khác, tìm mục **"App registrations"** trong **Microsoft Entra ID** / **Azure Active Directory**.

Tài khoản đăng nhập cần có quyền tạo App Registration trên tenant đang dùng. Với tenant cá nhân (Outlook/Hotmail), tài khoản đăng nhập là chính tài khoản đó.

---

## 3. Tạo App Registration

### 3.1. Tên app

```text
Verification Code Relay Tool - Local Dev
```

Production sau này có thể tạo app registration riêng, ví dụ:

```text
Verification Code Relay Tool - Production
```

Không tái dùng cùng một App Registration cho local dev và production.

### 3.2. Supported account types

Vì MVP cần hỗ trợ Hotmail/Outlook cá nhân, chọn:

```text
Accounts in any organizational directory (Any Microsoft Entra ID tenant - Multitenant)
and personal Microsoft accounts (e.g. Skype, Xbox)
```

Tương ứng giá trị `MICROSOFT_TENANT_ID=common`.

Nếu sau này chỉ phục vụ duy nhất một tenant nội bộ, có thể đổi sang **"Accounts in this organizational directory only"** và set `MICROSOFT_TENANT_ID` thành tenant ID cụ thể.

> Lưu ý: lựa chọn account type phải đảm bảo **personal Microsoft accounts** được phép, nếu không user Hotmail/Outlook cá nhân sẽ không đăng nhập được.

### 3.3. Redirect URI (Web platform)

Khi đăng ký app, chọn platform:

```text
Web
```

Local development:

```text
http://localhost:3000/api/microsoft/oauth/callback
```

Production / staging (cấu hình sau khi có domain thật):

```text
https://YOUR_DOMAIN.com/api/microsoft/oauth/callback
```

Quy tắc bắt buộc:

- Redirect URI trong App Registration **phải khớp tuyệt đối** với biến `MICROSOFT_REDIRECT_URI` trong `.env.local`.
- Sai dấu `/`, sai protocol (`http`/`https`), sai port, sai path đều gây lỗi `AADSTS50011`.
- Local dev có thể dùng `http://localhost`.
- Production / staging **phải** dùng HTTPS.
- Mỗi môi trường (local, staging, production) có một redirect URI riêng — có thể thêm nhiều entry vào cùng App Registration, hoặc tách riêng theo môi trường.

---

## 4. Client ID, Tenant ID, Client Secret

Sau khi App Registration được tạo, vào trang **Overview** và copy:

```text
Application (client) ID    -> MICROSOFT_CLIENT_ID
Directory (tenant) ID      -> MICROSOFT_TENANT_ID (nếu không dùng "common")
```

### 4.1. Tạo client secret

Vào:

```text
Certificates & secrets
  -> Client secrets
  -> + New client secret
```

Đặt:

- **Description:** ví dụ `local-dev-2025`.
- **Expires:** chọn thời hạn ngắn (3, 6, 12 tháng) — Microsoft hiện không cho phép `Never`.

Sau khi nhấn **Add**, Microsoft hiển thị **một lần duy nhất**:

```text
Value      <- ĐÂY là client secret thật, copy ngay
Secret ID  <- KHÔNG dùng cho OAuth
```

Quy tắc bảo mật (CRITICAL):

- Copy `Value` ngay khi vừa tạo — sau khi rời trang, Microsoft sẽ ẩn vĩnh viễn.
- **Không** dùng `Secret ID` thay cho `Value`.
- **Không** commit client secret vào git (kể cả tạm).
- **Không** paste client secret vào ChatGPT / Claude / Gemini / Cursor / bất kỳ chat AI nào.
- **Không** lưu client secret trong `docs/`, comment code, hay bất kỳ file nào không phải `.env.local` hoặc secret manager.
- Nếu nghi ngờ secret đã lộ ra ngoài (commit nhầm, paste nhầm, log nhầm) — **rotate ngay**: tạo secret mới và xóa secret cũ trên Entra portal.

---

## 5. API permissions

Vào:

```text
API permissions
  -> + Add a permission
  -> Microsoft Graph
  -> Delegated permissions
```

Thêm đúng các quyền tối thiểu sau:

```text
Mail.Read
offline_access
User.Read
```

Giải thích:

| Permission       | Mục đích                                                                     |
|------------------|------------------------------------------------------------------------------|
| `Mail.Read`      | Đọc email của user sau khi user cấp quyền.                                  |
| `offline_access` | Cho phép duy trì quyền truy cập (cấp `refresh_token`) khi user offline.     |
| `User.Read`      | Đọc thông tin cơ bản (display name, email) để gắn mailbox vào account.      |

Sau khi add, nhấn **Grant admin consent** nếu tài khoản đăng nhập là admin tenant — không bắt buộc với personal account, nhưng giúp user thường tránh lỗi consent.

### 5.1. KHÔNG được thêm các permission ngoài scope

```text
Mail.Send
Mail.ReadWrite
MailboxSettings.ReadWrite
Files.Read
Calendars.Read
Contacts.Read
```

Lý do:

- TASK-017 (và toàn bộ Sprint 5) chỉ chuẩn bị **đọc** mailbox.
- Hệ thống **không** gửi email.
- Hệ thống **không** sửa email.
- Hệ thống **không** đọc calendar / contact / file của user.

Nếu sau này business yêu cầu thêm scope, phải tạo task riêng, review security, và update lại tài liệu này.

---

## 6. Cấu hình `.env.local`

Tạo (hoặc cập nhật) file `.env.local` ở root của repo. **Không** commit file này.

```env
# Microsoft OAuth / Graph
MICROSOFT_CLIENT_ID=replace_with_application_client_id
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TENANT_ID=common
MICROSOFT_REDIRECT_URI=http://localhost:3000/api/microsoft/oauth/callback

# Điền client secret thật trong .env.local trên máy local.
# Không commit client secret thật lên GitHub.
```

Diễn giải:

| Biến                       | Giá trị                                                                                          |
|----------------------------|--------------------------------------------------------------------------------------------------|
| `MICROSOFT_CLIENT_ID`      | **Application (client) ID** từ trang Overview của App Registration.                              |
| `MICROSOFT_CLIENT_SECRET`  | **Value** của client secret — không phải `Secret ID`.                                            |
| `MICROSOFT_TENANT_ID`      | `common` cho giai đoạn đầu (multi-tenant + personal). Đổi sang tenant cụ thể khi cần.            |
| `MICROSOFT_REDIRECT_URI`   | Phải khớp tuyệt đối với Redirect URI đã đăng ký trong App Registration.                          |

> `.env.example` chỉ chứa **placeholder** (chuỗi rỗng hoặc giá trị mẫu). Mọi giá trị thật chỉ tồn tại trong `.env.local` (local) hoặc secret manager (staging/production).

---

## 7. Checklist xác minh setup

Đánh dấu khi hoàn tất:

```text
[ ] Đã tạo Microsoft App Registration cho local dev.
[ ] Supported account type hỗ trợ đúng loại tài khoản cần test (multitenant + personal account, hoặc tenant cụ thể).
[ ] Redirect URI local đã là http://localhost:3000/api/microsoft/oauth/callback.
[ ] Đã copy Application (client) ID -> MICROSOFT_CLIENT_ID.
[ ] Đã tạo client secret và copy đúng "Value" -> MICROSOFT_CLIENT_SECRET.
[ ] KHÔNG dùng nhầm "Secret ID" thay cho "Value".
[ ] Đã thêm delegated permissions: Mail.Read, offline_access, User.Read.
[ ] KHÔNG thêm Mail.Send, Mail.ReadWrite, MailboxSettings.ReadWrite, Files.Read, Calendars.Read, Contacts.Read.
[ ] Đã cập nhật .env.local với 4 biến MICROSOFT_*.
[ ] .env.local nằm trong .gitignore (không commit).
[ ] .env.example chỉ có placeholder Microsoft, không có giá trị thật.
[ ] Không paste secret/token vào chat AI, log, hoặc docs.
```

---

## 8. Lỗi thường gặp

| Mã / triệu chứng                  | Nguyên nhân                                                                                                                  | Cách xử lý                                                                                                                |
|-----------------------------------|------------------------------------------------------------------------------------------------------------------------------|---------------------------------------------------------------------------------------------------------------------------|
| `AADSTS50011`                     | Redirect URI trong request không khớp App Registration.                                                                      | Kiểm tra chính xác protocol (`http`/`https`), domain, port, path; copy nguyên văn cả phía app code và App Registration.    |
| `invalid_client`                  | Sai `client_id` hoặc `client_secret`, hoặc secret đã hết hạn.                                                                | Kiểm tra `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`. Nếu secret hết hạn, tạo secret mới và update `.env.local`.       |
| Không nhận `refresh_token`        | Thiếu scope `offline_access`, hoặc consent không bao gồm `offline_access`.                                                   | Thêm `offline_access` vào API permissions. Khi build authorize URL ở TASK-018, đảm bảo scope chứa `offline_access`.        |
| Consent bị chặn / cần admin       | Tenant yêu cầu admin consent cho một số scope.                                                                               | Dùng tài khoản admin tenant nhấn **Grant admin consent**, hoặc cấu hình user consent policy phù hợp.                        |
| Dùng nhầm `Secret ID` làm secret  | Microsoft hiển thị `Value` chỉ một lần; lần sau chỉ thấy `Secret ID`.                                                        | Tạo client secret mới, copy đúng `Value` ngay khi tạo.                                                                     |
| `AADSTS65001` / consent required  | User chưa consent cho app, hoặc consent đã bị thu hồi.                                                                       | Yêu cầu user authorize lại; với personal account, kiểm tra **Microsoft account -> Privacy -> Apps and services**.           |
| `AADSTS70011` invalid scope       | Sai chính tả scope, hoặc dùng scope không phải Microsoft Graph.                                                              | Dùng đúng chuỗi `Mail.Read offline_access User.Read` (case-sensitive theo Microsoft Graph delegated permissions).          |

---

## 9. Security rules (bắt buộc đọc)

- **Không** paste Microsoft client secret vào chat AI hoặc message platform.
- **Không** paste nội dung `.env.local` vào chat AI.
- **Không** log client secret / authorization code / access token / refresh token / verification code.
- Nếu cần debug env, chỉ in **tên biến** có tồn tại hay không, **không in giá trị**.
- Nếu nghi ngờ secret đã lộ, **rotate ngay** (tạo secret mới trên Entra portal, xóa secret cũ).
- Production phải dùng HTTPS cho Redirect URI.
- Production secret phải lưu ở secret manager (Vercel, AWS Secrets Manager, GCP Secret Manager, ...), không lưu trong repo.
- App Registration cho production tách biệt với local dev — không tái dùng client secret giữa các môi trường.

---

## 10. Tham chiếu

- File env loader: `lib/env.ts` (`requireMicrosoftEnv`) — đọc và validate 4 biến `MICROSOFT_*` an toàn, không log giá trị.
- File env keys: `lib/env.schema.ts` (`MICROSOFT_REQUIRED`).
- File placeholder: `.env.example` — luôn không chứa secret thật.
- Task gốc: `docs/tasks/TASK-017-microsoft-app-registration-checklist-config.md`.
- Task tiếp theo: TASK-018 (build OAuth connect URL), TASK-019 (OAuth callback), TASK-020 (token encryption service), TASK-021 (lưu mailbox sau OAuth connect), TASK-022 (Microsoft Graph mail service - read Inbox test).
