# TASK-058 — Production environment & secret setup

## Mục tiêu

Chuẩn hóa production environment và secret setup cho Verification Code Relay Tool trước khi deploy production thật.

TASK này chỉ chuẩn bị tài liệu, checklist, placeholder an toàn, và kiểm tra secret safety. TASK này không deploy production.

## Bối cảnh

Dự án là internal staff app cho agency.

Khách hàng không login và không có portal. Khách hàng chỉ nhận verification code qua Telegram group/topic đã được mapping.

TASK-057 đã harden production auth theo hướng fail-closed: production admin access không được mở bằng demo user dev hoặc staging passphrase. TASK-058 tiếp tục bằng việc chuẩn hóa biến môi trường và secret setup production, nhưng không triển khai production.

## Scope được làm

- Rà soát danh sách biến môi trường hiện có trong `.env.example`, `lib/env.ts`, `lib/env.schema.ts`, tài liệu Microsoft setup, staging deployment guide, và các docs liên quan.
- Chuẩn hóa danh sách biến môi trường production theo nhóm chức năng.
- Tạo hoặc cập nhật tài liệu production environment setup an toàn.
- Nếu cần cập nhật `.env.example`, chỉ dùng placeholder an toàn, tuyệt đối không ghi giá trị thật.
- Viết checklist pre-deploy production để kiểm tra resource production tách biệt khỏi local/staging.
- Ghi rõ production secret chỉ sống trong secret manager của deploy platform.
- Ghi rõ không paste secret vào AI/chat/docs/log.
- Ghi rõ không đọc hoặc in nội dung `.env*`.
- Chạy `npm run verify`.
- Chuẩn bị nội dung để Gemini review độc lập.

## Scope không làm

- Không deploy production.
- Không tạo production database/Redis thật trong task này.
- Không chạy production migration.
- Không connect mailbox thật.
- Không dùng Telegram group khách hàng thật.
- Không gửi verification code thật.
- Không yêu cầu người vận hành paste/upload `.env` hoặc secret thật.
- Không đọc hoặc in nội dung `.env`, `.env.local`, `.env.staging`, `.env.production`.
- Không ghi giá trị thật của database connection string, Redis connection string, Microsoft client secret, Telegram bot token, encryption key, session/auth secret vào docs, code, log, commit message, hoặc report.
- Không làm customer login, customer portal, public signup, billing, hoặc payment.
- Không làm một mailbox gửi tới nhiều Telegram destinations.
- Không broadcast code tới nhiều group/topic.
- Không sửa GitHub Actions để nới lỏng secret scan.
- Không tích hợp production sign-in provider thật nếu chưa có task riêng.

## Nguyên tắc sản phẩm bắt buộc

- App là internal staff app.
- OWNER/ADMIN xem toàn bộ.
- STAFF_READ_ONLY chỉ thấy customer/mailbox được assigned.
- Staff assignment scope phải được enforce ở service/API layer.
- Khách hàng không login.
- Nhiều mailbox có thể dùng chung một reusable Telegram destination.
- Mỗi mailbox chỉ có tối đa một active Telegram destination.
- Mailbox disconnected không được poll, renew subscription hoặc relay code.
- Mailbox chưa có mapping hợp lệ không được coi là Ready.
- Không broadcast verification code.

## Nhóm biến môi trường production cần chuẩn hóa

Ghi chú: phần này chỉ liệt kê tên biến. Không ghi giá trị thật trong tài liệu.

### App runtime

- `APP_ENV`
- `APP_URL`
- `LOG_LEVEL`

### Datastore

- `DATABASE_URL`
- `REDIS_URL`

### Queue và worker

- `EMAIL_QUEUE_NAME`
- `EMAIL_WORKER_CONCURRENCY`

### Token encryption

- `ENCRYPTION_KEY`

### Microsoft OAuth và Graph

- `MICROSOFT_CLIENT_ID`
- `MICROSOFT_CLIENT_SECRET`
- `MICROSOFT_TENANT_ID`
- `MICROSOFT_REDIRECT_URI`
- `MICROSOFT_GRAPH_NOTIFICATION_URL`
- `MICROSOFT_GRAPH_LIFECYCLE_NOTIFICATION_URL`

### Telegram

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_ADMIN_ALERT_CHAT_ID`

### Auth và session

- Liệt kê đúng các tên biến auth/session production đang được code TASK-057 sử dụng.
- Không tự bịa tên mới nếu repo chưa có.
- Không dùng demo user dev cho production.
- Không dùng staging passphrase login cho production.

### Delta polling worker

- `DELTA_POLLING_ENABLED`
- `DELTA_POLLING_INTERVAL_SECONDS`
- `DELTA_POLLING_MAX_PAGES_PER_MAILBOX`
- `DELTA_POLLING_BOOTSTRAP_LOOKBACK_HOURS`

### Subscription renewal worker

- `SUBSCRIPTION_RENEWAL_ENABLED`
- `SUBSCRIPTION_RENEWAL_INTERVAL_SECONDS`
- `SUBSCRIPTION_RENEWAL_WINDOW_HOURS`

## Production setup checklist

Checklist này chỉ dùng để chuẩn bị trước TASK-059. Không chạy deploy production trong TASK-058.

- Production app URL phải dùng HTTPS.
- Production Microsoft redirect URI phải khớp tuyệt đối với app URL production và OAuth callback path.
- Production Microsoft webhook URL phải là public HTTPS.
- Production Microsoft App Registration phải tách biệt local/staging nếu dự án quyết định dùng app riêng theo môi trường.
- Production database phải tách biệt staging/local.
- Production Redis phải tách biệt staging/local.
- Production encryption key phải tạo riêng cho production.
- Production Telegram bot token phải lưu trong secret manager.
- Production Telegram admin alert chat phải là chat kiểm soát nội bộ.
- Không dùng Telegram group khách hàng thật cho smoke test trước khi có task internal beta.
- Không dùng mailbox khách hàng thật trước khi có task internal beta.
- Worker production chỉ được bật trong TASK-059 sau khi checklist được duyệt.
- Nếu phát hiện gửi nhầm Telegram destination, phải có cách tắt worker khẩn cấp trong task deploy sau.

## Secret safety checklist

- Không commit `.env`, `.env.local`, `.env.staging`, `.env.production`.
- `.env.example` chỉ chứa placeholder an toàn nếu cần cập nhật.
- Không ghi giá trị thật vào docs/task/report/roadmap.
- Không paste secret vào ChatGPT, Claude, Gemini, Cursor, issue, PR, hoặc commit message.
- Không log token, refresh token, client secret, bot token, encryption key, session/auth secret.
- Không log full verification code.
- Không log full email body.
- Nếu nghi ngờ secret lộ, phải rotate secret trước khi deploy tiếp.

## Docs/report cần tạo hoặc cập nhật

Tối thiểu:

- `docs/tasks/TASK-058-production-environment-secret-setup.md`

Nên có report sau khi hoàn tất:

- `docs/reports/TASK-058-production-environment-secret-setup.md`

Có thể cập nhật nếu cần:

- `.env.example` chỉ với placeholder an toàn
- tài liệu production env setup nếu repo đã có vị trí phù hợp
- `docs/ROADMAP.md` sau khi task hoàn tất

Không sửa:

- `.env`
- `.env.local`
- `.env.staging`
- `.env.production`
- GitHub Actions workflow để nới lỏng secret scan

## Kiểm tra bắt buộc

- Chạy `npm run verify`.
- Kiểm tra `git status --short`.
- Kiểm tra `git diff --stat`.
- Kiểm tra diff không có secret thật.
- Kiểm tra diff không có full verification code.
- Kiểm tra diff không có full email body.
- Kiểm tra docs không có wording dễ gây secret scan false positive, nhất là các dòng ngắn dạng keyword/value liên quan tới token, secret, key, password, auth, bearer, client secret, database url, connection string.
- Gemini CLI review PASS trước khi commit.

## Tiêu chí nghiệm thu

TASK-058 chỉ PASS khi:

- Task file đã được tạo đúng đường dẫn.
- Production env/secret setup được tài liệu hóa rõ ràng.
- Danh sách biến production được chuẩn hóa theo nhóm.
- Tài liệu không chứa secret thật.
- Không đọc/in nội dung `.env*`.
- Không deploy production.
- Không dùng production DB/Redis thật trong code/test.
- Không dùng mailbox hoặc Telegram group khách hàng thật.
- Không thay đổi rule routing.
- Không phá production auth hardening từ TASK-057.
- `npm run verify` PASS.
- Gemini review PASS.