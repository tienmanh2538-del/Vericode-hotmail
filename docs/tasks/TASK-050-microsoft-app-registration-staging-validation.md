# TASK-050 — Microsoft App Registration staging validation

## 1. Mục tiêu

Tạo và xác minh checklist Microsoft App Registration riêng cho môi trường staging, dùng cho Railway staging đã chuẩn bị ở TASK-048/TASK-049.

TASK này chỉ xác minh cấu hình App Registration, Redirect URI, webhook URL, permission tối thiểu và cách xử lý secret an toàn.

TASK này không chạy live mailbox E2E. Live mailbox E2E thuộc TASK-051.

## 2. Bối cảnh

Dự án Verification Code Relay Tool là internal staff app cho agency.

Khách hàng không login vào dashboard. Khách hàng chỉ nhận verification code qua Telegram group/topic.

OWNER/ADMIN xem và quản lý toàn bộ. STAFF_READ_ONLY chỉ thấy customer được gán và mailbox thuộc customer đó.

Các rule routing đã chốt:

- Nhiều mailbox có thể dùng chung một Telegram group/topic.
- Mỗi mailbox chỉ có tối đa một active Telegram destination.
- Mailbox chưa có mapping hợp lệ không được coi là Ready.

TASK-048 đã chọn Railway làm platform staging chính.

TASK-049 đã chuẩn bị checklist hạ tầng Railway staging gồm:

- web service
- PostgreSQL staging
- Redis staging
- worker-email
- worker-delta
- worker-renewal
- public HTTPS domain mặc định `.railway.app`

TASK-050 là bước xác minh Microsoft App Registration staging trước khi TASK-051 chạy live mailbox E2E.

## 3. Điều kiện đầu vào từ TASK-048/TASK-049

Cần có hoặc cần biết:

- Railway project staging.
- Public HTTPS staging domain dạng `<STAGING_DOMAIN>.railway.app`.
- Railway env/secret manager cho staging.
- Staging PostgreSQL riêng.
- Staging Redis riêng.
- Không dùng production database.
- Không dùng production Redis.
- Không dùng mailbox khách hàng thật.
- Không dùng Telegram group khách hàng thật.

## 4. Scope được làm

TASK-050 được phép làm:

- Tạo hoặc cập nhật task file này.
- Tạo report/checklist trong `docs/reports/` nếu cần.
- Cập nhật `docs/MICROSOFT_SETUP.md` nếu thiếu checklist staging tối thiểu.
- Cập nhật `docs/STAGING_DEPLOYMENT.md` nếu thiếu cross-reference tới Microsoft App Registration staging.
- Xác minh Redirect URI staging dạng placeholder.
- Xác minh webhook URL staging dạng placeholder.
- Xác minh danh sách env name cần set trên Railway.
- Xác minh Microsoft Graph delegated permissions tối thiểu.
- Xác minh không thêm permission ngoài scope.
- Xác minh client secret staging chỉ nằm trong Railway secret manager.
- Chạy `npm run verify`.
- Báo cáo `git status --short` và `git diff --stat`.

## 5. Scope không làm

TASK-050 không làm:

- Không deploy production.
- Không dùng production database.
- Không dùng production Redis.
- Không dùng mailbox khách hàng thật.
- Không dùng Telegram group khách hàng thật.
- Không chạy live mailbox E2E.
- Không connect mailbox thật để nhận code.
- Không gửi email verification test.
- Không kiểm tra webhook + delta dedupe live.
- Không tạo migration.
- Không sửa `prisma/schema.prisma`.
- Không sửa worker/queue code.
- Không sửa Telegram routing code.
- Không sửa runtime OAuth/Graph code nếu docs/checklist đã đủ.
- Không sửa GitHub Actions workflow để nới lỏng secret scan.
- Không đọc hoặc in `.env`, `.env.local`, `.env.staging`, `.env.production`.
- Không ghi secret thật, token thật, connection string thật, encryption key thật, session secret thật hoặc Telegram bot token thật vào docs/code/log/chat.

## 6. Checklist Microsoft Entra

User thao tác thủ công trên Microsoft Entra:

```text
[ ] Đã tạo App Registration riêng cho staging.
[ ] App name thể hiện rõ staging, ví dụ Verification Code Relay Tool - Staging.
[ ] App Registration staging không dùng chung với local/prod.
[ ] Supported account types hỗ trợ đúng nhu cầu test Hotmail/Outlook cá nhân hoặc tenant cụ thể.
[ ] Platform là Web.
[ ] Redirect URI staging đã thêm đúng dạng:
    https://<STAGING_DOMAIN>.railway.app/api/microsoft/oauth/callback
[ ] Redirect URI không dùng localhost.
[ ] Redirect URI dùng HTTPS.
[ ] Redirect URI không sai domain/path/dấu slash.
[ ] Đã tạo client secret staging mới.
[ ] Đã copy đúng secret Value, không dùng Secret ID.
[ ] Secret Value chỉ được nhập vào Railway secret manager.
[ ] Không paste secret Value vào ChatGPT/Claude/Gemini/Cursor/docs/code/log.
[ ] Đã thêm delegated permissions tối thiểu:
    Mail.Read
    offline_access
    User.Read
[ ] Không thêm Mail.Send.
[ ] Không thêm Mail.ReadWrite.
[ ] Không thêm MailboxSettings.ReadWrite.
[ ] Không thêm Files.Read.
[ ] Không thêm Calendars.Read.
[ ] Không thêm Contacts.Read.
[ ] Publisher verification được ghi nhận là non-blocker hiện tại, trừ khi consent thực tế bị chặn.
````

## 7. Checklist Railway env names

Chỉ set giá trị thật trong Railway secret manager. Không ghi giá trị thật vào repo.

Các env names cần kiểm tra:

```text
APP_ENV
APP_URL
LOG_LEVEL
DATABASE_URL
REDIS_URL
EMAIL_QUEUE_NAME
EMAIL_WORKER_CONCURRENCY
ENCRYPTION_KEY
MICROSOFT_CLIENT_ID
MICROSOFT_CLIENT_SECRET
MICROSOFT_TENANT_ID
MICROSOFT_REDIRECT_URI
MICROSOFT_GRAPH_NOTIFICATION_URL
MICROSOFT_GRAPH_LIFECYCLE_NOTIFICATION_URL
TELEGRAM_BOT_TOKEN
TELEGRAM_ADMIN_ALERT_CHAT_ID
AUTH_DEV_DEMO_USER
STAGING_ADMIN_PASSWORD
STAGING_ADMIN_SESSION_SECRET
DELTA_POLLING_ENABLED
DELTA_POLLING_INTERVAL_SECONDS
DELTA_POLLING_MAX_PAGES_PER_MAILBOX
SUBSCRIPTION_RENEWAL_ENABLED
SUBSCRIPTION_RENEWAL_INTERVAL_SECONDS
SUBSCRIPTION_RENEWAL_WINDOW_HOURS
```

Railway validation checklist:

```text
[ ] APP_URL dùng đúng HTTPS staging domain.
[ ] DATABASE_URL trỏ staging PostgreSQL, không phải production.
[ ] REDIS_URL trỏ staging Redis, không phải production.
[ ] ENCRYPTION_KEY tạo riêng cho staging, không tái dùng local/prod.
[ ] MICROSOFT_CLIENT_ID lấy từ App Registration staging.
[ ] MICROSOFT_CLIENT_SECRET là secret Value staging, chỉ lưu trong Railway.
[ ] MICROSOFT_TENANT_ID phù hợp account type đã chọn.
[ ] MICROSOFT_REDIRECT_URI khớp tuyệt đối với Redirect URI trong App Registration.
[ ] MICROSOFT_GRAPH_NOTIFICATION_URL là public HTTPS webhook URL staging.
[ ] MICROSOFT_GRAPH_LIFECYCLE_NOTIFICATION_URL để trống nếu chưa có endpoint lifecycle.
[ ] TELEGRAM_BOT_TOKEN là test bot/staging bot, không dùng bot production nếu chưa được duyệt.
[ ] TELEGRAM_ADMIN_ALERT_CHAT_ID là test/admin chat phù hợp, không phải group khách hàng thật.
```

## 8. Redirect URI và Webhook URL placeholder

Dùng placeholder, không ghi domain thật nếu chưa cần:

```text
Redirect URI:
https://<STAGING_DOMAIN>.railway.app/api/microsoft/oauth/callback

Webhook URL:
https://<STAGING_DOMAIN>.railway.app/api/webhooks/microsoft/mail
```

Khi triển khai thật, `<STAGING_DOMAIN>` phải thay bằng Railway staging domain chính xác.

Redirect URI trong Microsoft Entra phải khớp tuyệt đối với env name `MICROSOFT_REDIRECT_URI`.

Webhook URL phải khớp với env name `MICROSOFT_GRAPH_NOTIFICATION_URL`.

## 9. Permission tối thiểu

Chỉ dùng Microsoft Graph delegated permissions:

```text
Mail.Read
offline_access
User.Read
```

Không thêm permission ngoài scope:

```text
Mail.Send
Mail.ReadWrite
MailboxSettings.ReadWrite
Files.Read
Calendars.Read
Contacts.Read
```

Lý do:

* Hệ thống chỉ cần đọc mailbox để nhận verification email.
* Hệ thống không gửi email.
* Hệ thống không sửa email.
* Hệ thống không đọc calendar/contact/file.
* Nếu sau này cần permission mới, phải tạo task riêng và review security riêng.

## 10. Bảo mật client secret

Quy tắc bắt buộc:

* Không paste client secret vào AI chat.
* Không paste client secret vào docs.
* Không paste client secret vào commit message.
* Không paste client secret vào report.
* Không paste client secret vào log.
* Không paste nội dung `.env*`.
* Không dùng Secret ID thay cho secret Value.
* Nếu nghi ngờ secret đã lộ, rotate ngay trên Microsoft Entra rồi cập nhật Railway secret manager.

## 11. Các điểm Claude cần kiểm tra

Claude cần đọc:

```text
AGENTS.md
CLAUDE.md
GEMINI.md
docs/SECURITY_RULES.md
docs/PRODUCT_SPEC.md
docs/ARCHITECTURE.md
docs/ROADMAP.md
docs/MICROSOFT_SETUP.md
docs/STAGING_DEPLOYMENT.md
docs/PROJECT_HANDOFF_TASK_001_TO_041.md
PROJECT HANDOFF — TASK-042 TO TASK-049
Roadmap Detail - TASK 42 to TASK 61.txt
```

Claude cần kiểm tra:

```text
[ ] TASK-050 task file đã tồn tại và đúng scope.
[ ] MICROSOFT_SETUP.md đã có staging redirect URI/webhook checklist hoặc được bổ sung tối thiểu.
[ ] STAGING_DEPLOYMENT.md đã cross-reference đúng Microsoft setup hoặc được bổ sung tối thiểu.
[ ] Không có secret thật trong diff.
[ ] Không có `.env*` trong diff.
[ ] Không có URL production DB/Redis trong diff.
[ ] Không có mailbox khách hàng thật.
[ ] Không có Telegram group khách hàng thật.
[ ] Không tạo migration.
[ ] Không sửa runtime code nếu không cần.
[ ] Không mở rộng sang TASK-051.
```

## 12. Thao tác user phải làm thủ công

User phải tự thao tác trong Microsoft Entra:

```text
[ ] Tạo App Registration staging.
[ ] Chọn supported account types.
[ ] Thêm Redirect URI staging.
[ ] Tạo client secret staging.
[ ] Copy secret Value trực tiếp vào Railway secret manager.
[ ] Thêm delegated permissions tối thiểu.
[ ] Xác nhận không có permission ngoài scope.
```

User phải tự thao tác trong Railway:

```text
[ ] Xác định staging domain.
[ ] Set env values thật trong Railway secret manager.
[ ] Đảm bảo Microsoft env names dùng staging App Registration.
[ ] Đảm bảo DB/Redis là staging.
[ ] Không dùng production DB/Redis.
[ ] Không dùng mailbox hoặc Telegram group khách hàng thật.
```

## 13. Các tình huống Gemini cần review

Gemini cần review:

```text
[ ] Task file đúng scope TASK-050.
[ ] Không mở rộng TASK-051.
[ ] Không chạy live mailbox E2E.
[ ] Không yêu cầu paste secret thật.
[ ] Không có secret thật trong diff.
[ ] Không có secret scan false positive dễ thấy trong docs/report.
[ ] Permission Microsoft tối thiểu đúng.
[ ] Redirect URI placeholder đúng.
[ ] Webhook URL placeholder đúng.
[ ] App Registration staging tách local/prod.
[ ] Không sửa runtime code nếu không cần.
[ ] Không tạo migration.
[ ] Không sửa GitHub Actions workflow.
[ ] npm run verify PASS.
```

## 14. Lệnh kiểm tra

Chạy:

```powershell
git branch --show-current
git status --short
git diff --stat
npm run verify
```

Không chạy lệnh đọc/in `.env*`.

Không chạy live E2E mailbox trong TASK-050.

## 15. Tiêu chí nghiệm thu

TASK-050 PASS khi:

```text
[ ] Đúng branch TASK-050.
[ ] Có task file docs/tasks/TASK-050-microsoft-app-registration-staging-validation.md.
[ ] Có report/checklist docs/reports/TASK-050-microsoft-app-registration-staging-validation.md nếu cần.
[ ] MICROSOFT_SETUP.md/STAGING_DEPLOYMENT.md rõ checklist staging hoặc đã được xác nhận đủ.
[ ] Redirect URI staging placeholder đúng.
[ ] Webhook URL staging placeholder đúng.
[ ] Permission tối thiểu đúng: Mail.Read, offline_access, User.Read.
[ ] Không thêm Mail.Send/Mail.ReadWrite hoặc permission ngoài scope.
[ ] Không có secret thật trong diff.
[ ] Không có `.env*` trong diff.
[ ] Không dùng production DB/Redis.
[ ] Không dùng mailbox khách hàng thật.
[ ] Không dùng Telegram group khách hàng thật.
[ ] Không deploy production.
[ ] Không chạy TASK-051 live E2E.
[ ] Không tạo migration.
[ ] Không sửa runtime code nếu không cần.
[ ] npm run verify PASS.
[ ] Gemini review PASS.
[ ] ROADMAP.md được cập nhật sau khi task hoàn tất và được Gemini review trước commit/push.
```

## 16. Format báo cáo sau khi Claude làm xong

Claude báo cáo theo format:

```text
1. Tôi đã làm gì
- ...

2. File đã thay đổi
- ...

3. Những việc tôi KHÔNG làm
- Không đọc/in .env*
- Không ghi secret thật
- Không deploy production
- Không dùng production DB/Redis
- Không dùng mailbox khách hàng thật
- Không dùng Telegram group khách hàng thật
- Không chạy live mailbox E2E
- Không tạo migration
- Không sửa runtime code nếu không cần

4. Kết quả kiểm tra
- npm run verify: PASS/FAIL
- git status --short:
- git diff --stat:

5. Điểm cần Gemini review
- Scope TASK-050
- Secret safety
- Microsoft permission
- Redirect URI/Webhook URL checklist
- Không mở rộng TASK-051
```

````

