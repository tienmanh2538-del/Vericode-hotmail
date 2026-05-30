
# TASK-039: Staging deployment setup

## 1. Mục tiêu

Chuẩn bị tài liệu và cấu hình mẫu để deploy dự án Verification Code Relay Tool lên môi trường staging một cách an toàn.

Staging là môi trường test gần giống production, dùng để kiểm tra end-to-end trước TASK-040 MVP acceptance review.

TASK này không deploy production thật, không dùng khách hàng thật, không dùng Telegram group thật của khách hàng, không chứa secret thật trong repo.

---

## 2. Bối cảnh

Dự án đã có các phần chính:

- Microsoft OAuth connect mailbox.
- Microsoft Graph webhook/subscription.
- Delta polling backup.
- Email processing pipeline.
- Facebook/Meta verification detector.
- Code extractor.
- Deduplication bằng ProcessedMessage.
- Telegram sender/retry.
- Health dashboard.
- Alert service.
- E2E test mock flow.
- E2E test Microsoft test mailbox.

TASK-039 cần chuẩn bị staging để có thể chạy kiểm tra cuối trước TASK-040.

---

## 3. Phạm vi công việc

Claude Code chỉ được làm các việc sau:

1. Tạo tài liệu hướng dẫn staging deployment.
2. Tạo thư mục cấu hình staging mẫu.
3. Tạo file env staging example chỉ chứa placeholder, không chứa secret thật.
4. Ghi rõ checklist cần làm thủ công trên nền tảng deploy.
5. Ghi rõ checklist Microsoft App Registration cho staging.
6. Ghi rõ checklist Telegram test group cho staging.
7. Ghi rõ checklist database/Redis/worker cho staging.
8. Ghi rõ checklist smoke test sau deploy.
9. Ghi rõ rollback plan nếu staging fail.
10. Đảm bảo `npm run verify` vẫn pass.

---

## 4. File/thư mục dự kiến tạo hoặc sửa

Ưu tiên tạo mới:

```text
docs/STAGING_DEPLOYMENT.md
deployment/staging/README.md
deployment/staging/env.staging.example
````

Có thể sửa nếu cần:

```text
docs/MICROSOFT_SETUP.md
README.md
```

Chỉ sửa `docs/MICROSOFT_SETUP.md` nếu cần bổ sung mục staging redirect URI / webhook URL.

Chỉ sửa `README.md` nếu muốn thêm link tới tài liệu staging, không viết dài trong README.

---

## 5. Nội dung bắt buộc của `docs/STAGING_DEPLOYMENT.md`

Tài liệu staging phải có các phần sau:

### 5.1. Mục tiêu staging

Giải thích staging dùng để test trước production, không dùng khách hàng thật.

### 5.2. Staging architecture

Mô tả tối thiểu:

```text
GitHub main/branch
  -> Deploy platform
  -> Next.js app
  -> Staging database
  -> Staging Redis/queue nếu có
  -> Microsoft App Registration staging
  -> Microsoft webhook HTTPS URL
  -> Telegram test group
```

### 5.3. Required services

Liệt kê dịch vụ cần có:

* Hosting app Next.js.
* PostgreSQL staging database.
* Redis staging nếu queue/worker cần Redis.
* Microsoft App Registration cho staging.
* Telegram bot/test group cho staging.
* Public HTTPS domain.

### 5.4. Environment variables

Liệt kê biến môi trường cần cấu hình trên staging, nhưng KHÔNG ghi giá trị thật.

Các biến tối thiểu:

```text
APP_ENV=staging
APP_URL=https://YOUR_STAGING_DOMAIN
DATABASE_URL=postgresql://...
# Sensitive — để TRỐNG trong tài liệu/example; giá trị thật chỉ cấu hình trong
# secret manager của deploy platform, không commit vào repo.
ENCRYPTION_KEY=
MICROSOFT_CLIENT_ID=...
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TENANT_ID=common
MICROSOFT_REDIRECT_URI=https://YOUR_STAGING_DOMAIN/api/microsoft/oauth/callback
MICROSOFT_WEBHOOK_URL=https://YOUR_STAGING_DOMAIN/webhooks/microsoft/mail
TELEGRAM_BOT_TOKEN=
TELEGRAM_ADMIN_ALERT_CHAT_ID=...
LOG_LEVEL=info
```

Các biến nhạy cảm (`ENCRYPTION_KEY`, `MICROSOFT_CLIENT_SECRET`, `TELEGRAM_BOT_TOKEN`)
để **trống** trong tài liệu — giá trị thật chỉ nằm trong secret manager của deploy
platform, **không** commit vào repo.

Nếu project thực tế có thêm biến khác, Claude phải đọc `.env.example` và đồng bộ danh sách placeholder tương ứng.

### 5.5. Microsoft staging setup

Phải nhắc:

* Staging phải dùng HTTPS.
* Redirect URI staging phải khớp tuyệt đối với env.
* Webhook URL staging phải là public HTTPS.
* Không tái dùng local client secret cho staging.
* Không paste client secret vào chat AI.
* Scope vẫn giữ tối thiểu: `Mail.Read`, `offline_access`, `User.Read`.

### 5.6. Telegram staging setup

Phải nhắc:

* Dùng Telegram test group, không dùng group khách hàng thật.
* Bot token nằm trong secret manager/env của deploy platform.
* Chat ID test nằm trong database hoặc env tùy project hiện tại.
* Không hardcode Telegram chat ID trong code.

### 5.7. Database staging setup

Phải nhắc:

* Dùng database riêng cho staging.
* Không dùng production DB.
* Không dùng dữ liệu khách hàng thật.
* Chạy migration theo cách an toàn.
* Sau deploy cần kiểm tra migration status.

### 5.8. Worker / queue setup

Nếu project có queue/worker:

* Staging phải có process worker riêng nếu app architecture yêu cầu.
* Worker phải dùng cùng env staging.
* Không chạy worker staging trỏ vào database production.
* Health dashboard phải hiển thị trạng thái worker/polling/subscription nếu đã có.

### 5.9. Smoke test checklist

Smoke test là test nhanh sau deploy để biết staging sống hay chết.

Checklist tối thiểu:

```text
[ ] App staging mở được bằng HTTPS.
[ ] /admin mở được.
[ ] Health dashboard mở được.
[ ] Không thấy secret/token/code trong UI.
[ ] OAuth connect URL tạo được.
[ ] Microsoft OAuth callback dùng đúng staging redirect URI.
[ ] Webhook endpoint trả validationToken đúng khi Microsoft verify.
[ ] Telegram test-send gửi được vào test group.
[ ] E2E mock flow pass.
[ ] E2E Microsoft test mailbox pass nếu có đủ env thật.
[ ] Không gửi trùng khi webhook và delta polling cùng thấy một graphMessageId.
[ ] npm run verify pass.
```

### 5.10. Rollback plan

Rollback nghĩa là quay lại phiên bản deploy trước nếu bản mới lỗi.

Phải có hướng dẫn:

* Nếu deploy fail: rollback về build trước.
* Nếu migration fail: không tự sửa DB bằng tay nếu chưa hiểu nguyên nhân.
* Nếu secret lộ: rotate secret ngay.
* Nếu Telegram gửi nhầm group: disable worker/automation ngay, kiểm tra mapping, audit log.
* Nếu Microsoft OAuth lỗi redirect: kiểm tra lại App Registration và env.

### 5.11. Security checklist

Phải có checklist:

```text
[ ] Không commit .env / .env.local / secret thật.
[ ] Không đưa token/client secret vào docs.
[ ] Không log access token/refresh token.
[ ] Không log full verification code.
[ ] Không dùng Telegram group khách hàng thật cho staging.
[ ] Không dùng mailbox khách hàng thật cho staging.
[ ] Không dùng database production.
[ ] Staging domain dùng HTTPS.
[ ] Microsoft redirect URI khớp tuyệt đối.
[ ] GitHub Actions pass.
```

---

## 6. Nội dung bắt buộc của `deployment/staging/README.md`

File này là bản tóm tắt nhanh cho thư mục staging.

Bắt buộc có:

* Mục đích thư mục.
* Danh sách file trong thư mục.
* Cách dùng `env.staging.example`.
* Cảnh báo không lưu secret thật trong thư mục này.
* Link trỏ về `docs/STAGING_DEPLOYMENT.md`.

---

## 7. Nội dung bắt buộc của `deployment/staging/env.staging.example`

File này chỉ chứa placeholder, ví dụ:

```env
APP_ENV=staging
APP_URL=https://YOUR_STAGING_DOMAIN

DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DATABASE
REDIS_URL=redis://USER:PASSWORD@HOST:PORT

# Sensitive — để TRỐNG; giá trị thật chỉ cấu hình trong secret manager.
ENCRYPTION_KEY=

MICROSOFT_CLIENT_ID=replace_with_staging_client_id
# Sensitive — để TRỐNG; giá trị thật chỉ cấu hình trong secret manager.
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TENANT_ID=common
MICROSOFT_REDIRECT_URI=https://YOUR_STAGING_DOMAIN/api/microsoft/oauth/callback
MICROSOFT_WEBHOOK_URL=https://YOUR_STAGING_DOMAIN/webhooks/microsoft/mail

# Sensitive — để TRỐNG; giá trị thật chỉ cấu hình trong secret manager.
TELEGRAM_BOT_TOKEN=
TELEGRAM_ADMIN_ALERT_CHAT_ID=replace_with_staging_admin_alert_chat_id

LOG_LEVEL=info
```

Biến nhạy cảm (`ENCRYPTION_KEY`, `MICROSOFT_CLIENT_SECRET`, `TELEGRAM_BOT_TOKEN`) để
**trống**: giá trị thật phải cấu hình trong secret manager của deploy platform và
**không** commit secret thật vào repo.

Nếu project thực tế không dùng một biến nào đó, Claude có thể ghi chú trong docs nhưng không được xóa bừa nếu biến đó có thể cần cho staging.

---

## 8. Không được làm

Claude Code không được:

* Không đọc hoặc in nội dung `.env`, `.env.local`.
* Không tạo `.env.staging` chứa secret thật.
* Không commit secret thật.
* Không sửa code xử lý Microsoft OAuth nếu không cần.
* Không sửa code Telegram sender nếu không cần.
* Không sửa parser/extractor/dedup nếu không cần.
* Không sửa Prisma schema/migration nếu không cần.
* Không đổi stack deploy lớn.
* Không deploy production.
* Không tạo TASK-040.
* Không đánh dấu MVP accepted.

---

## 9. Lệnh kiểm tra

Sau khi sửa, chạy:

```powershell
npm run verify
git status
git diff -- docs/STAGING_DEPLOYMENT.md deployment/staging docs/tasks/TASK-039-staging-deployment-setup.md
```

Nếu có sửa `docs/MICROSOFT_SETUP.md` hoặc `README.md`, kiểm tra thêm:

```powershell
git diff -- docs/MICROSOFT_SETUP.md README.md
```

---

## 10. Tiêu chí nghiệm thu

TASK-039 được coi là PASS khi:

```text
[ ] Có docs/tasks/TASK-039-staging-deployment-setup.md.
[ ] Có docs/STAGING_DEPLOYMENT.md.
[ ] Có deployment/staging/README.md.
[ ] Có deployment/staging/env.staging.example.
[ ] Tất cả env trong example chỉ là placeholder, không có secret thật.
[ ] Tài liệu có staging architecture.
[ ] Tài liệu có required services.
[ ] Tài liệu có env checklist.
[ ] Tài liệu có Microsoft staging checklist.
[ ] Tài liệu có Telegram staging checklist.
[ ] Tài liệu có database/Redis/worker checklist.
[ ] Tài liệu có smoke test checklist.
[ ] Tài liệu có rollback plan.
[ ] Tài liệu có security checklist.
[ ] Không có `.env`, `.env.local`, `.env.staging` bị commit.
[ ] Không có token/client secret/code thật trong diff.
[ ] `npm run verify` pass.
[ ] Gemini review pass, không còn Critical/High/Medium.
```

---

## 11. Kết quả Claude phải báo lại

Claude phải báo lại theo format:

```text
1. Đã làm gì
2. File nào đã tạo/sửa
3. File nào không đụng tới
4. Lệnh đã chạy
5. Kết quả npm run verify
6. Rủi ro còn lại
7. Có cần user thao tác thủ công gì trên deploy platform/Microsoft/Telegram không
```
