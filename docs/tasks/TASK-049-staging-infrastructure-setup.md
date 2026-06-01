# TASK-049 Staging infrastructure setup

## Mục tiêu

Thiết lập hoặc chuẩn bị thiết lập hạ tầng staging thật cho Verification Code Relay Tool theo đúng platform và staging architecture đã được chốt ở TASK-048.

TASK này chỉ tập trung vào hạ tầng staging. Không deploy production, không chạy live mailbox E2E, không dùng mailbox khách hàng thật, không dùng Telegram group khách hàng thật, và không ghi secret thật vào repo/docs/chat/log.

## Bối cảnh

Dự án hiện là internal staff app cho agency.

OWNER và ADMIN quản lý toàn bộ hệ thống. STAFF_READ_ONLY chỉ thấy customer được gán và mailbox thuộc customer đó. Khách hàng không login vào app và chỉ nhận verification code qua Telegram group hoặc topic.

Các quyết định trước đó vẫn giữ nguyên:

- Nhiều mailbox có thể dùng chung một Telegram group hoặc topic.
- Mỗi mailbox chỉ có tối đa một Telegram destination active.
- Mailbox chưa có mapping hợp lệ không được coi là Ready.
- Staging phải tách biệt production.
- Staging không dùng mailbox khách hàng thật.
- Staging không dùng Telegram group khách hàng thật.

## Vấn đề cần giải quyết

Sau TASK-048, dự án đã có quyết định về deployment platform và staging architecture. TASK-049 cần biến quyết định đó thành checklist hạ tầng staging rõ ràng để người vận hành không chuyên code có thể tạo đúng các service cần thiết trên platform.

Staging cần đủ thành phần để mô phỏng gần production nhưng vẫn an toàn:

- Web service cho Next.js app.
- PostgreSQL riêng cho staging.
- Redis riêng cho staging.
- Worker service cho queue/email processing nếu project cần.
- Delta polling worker nếu staging architecture yêu cầu bật.
- Subscription renewal worker nếu staging architecture yêu cầu bật.
- Public HTTPS domain cho OAuth redirect và Microsoft Graph webhook.
- Environment variables trên platform dashboard, chỉ dùng secret manager của platform.

## Điều kiện đầu vào từ TASK-048

Trước khi sửa file, Claude phải đọc task/report của TASK-048 trong repo local.

Claude cần xác định rõ:

- Platform đã được chọn ở TASK-048.
- Kiến trúc staging đã chốt.
- Dịch vụ nào chạy trong cùng project/platform.
- Worker strategy đã chốt là tách service hay dùng một worker service.
- Domain staging dùng domain mặc định của platform hay custom domain.

Nếu không tìm thấy kết luận TASK-048, Claude phải dừng và báo lại. Không tự chọn lại platform trong TASK-049.

## Scope được làm

TASK-049 được phép:

- Đọc quyết định platform từ TASK-048.
- Tạo hoặc cập nhật checklist hạ tầng staging.
- Tạo báo cáo setup staging nếu cần.
- Cập nhật tài liệu staging deployment nếu cần bổ sung checklist theo platform.
- Cập nhật template env staging nếu chỉ thêm tên biến hoặc placeholder còn thiếu.
- Chuẩn bị hướng dẫn tạo web service.
- Chuẩn bị hướng dẫn tạo PostgreSQL staging.
- Chuẩn bị hướng dẫn tạo Redis staging.
- Chuẩn bị hướng dẫn tạo worker service.
- Chuẩn bị hướng dẫn cấu hình public HTTPS domain.
- Chuẩn bị danh sách tên biến môi trường cần set trên platform.
- Chuẩn bị checklist verify không lộ secret.
- Chạy npm run verify.
- Báo cáo git status và git diff sau khi làm xong.

## Scope không làm

TASK-049 không được:

- Deploy production.
- Dùng production database.
- Dùng production Redis.
- Dùng mailbox khách hàng thật.
- Dùng Telegram group khách hàng thật.
- Tạo Microsoft App Registration staging nếu việc đó thuộc TASK-050.
- Chạy live mailbox E2E nếu việc đó thuộc TASK-051.
- Paste secret thật vào ChatGPT, Claude, Gemini, Cursor, docs hoặc logs.
- Commit .env, .env.local, .env.staging hoặc .env.production.
- Ghi database URL thật.
- Ghi Redis URL thật.
- Ghi Microsoft client secret thật.
- Ghi Telegram bot token thật.
- Ghi encryption key thật.
- Ghi session secret thật.
- Sửa OAuth hoặc Graph code nếu không cần.
- Sửa worker hoặc queue code nếu không cần.
- Sửa Telegram routing rule đã chốt ở TASK-041 và TASK-044.
- Làm customer portal, customer login, billing hoặc public SaaS.
- Tạo migration mới nếu không cần.
- Dùng prisma migrate dev cho staging.
- Sửa GitHub Actions secret scan theo hướng nới lỏng.
- Mở rộng sang TASK-050 hoặc TASK-051.

## Checklist staging infrastructure

Checklist hạ tầng staging cần có:

```text
[ ] Đã xác định platform theo TASK-048.
[ ] Đã tạo project/environment staging trên platform.
[ ] Đã tạo Next.js web service.
[ ] Đã tạo PostgreSQL staging riêng.
[ ] Đã tạo Redis staging riêng.
[ ] Đã tạo worker service cho email queue nếu repo có command tương ứng.
[ ] Đã tạo delta polling worker nếu scope staging yêu cầu.
[ ] Đã tạo subscription renewal worker nếu scope staging yêu cầu.
[ ] Đã có public HTTPS domain cho staging.
[ ] Đã chuẩn bị danh sách tên biến môi trường cần set trên platform.
[ ] Đã xác nhận không dùng production database.
[ ] Đã xác nhận không dùng production Redis.
[ ] Đã xác nhận không dùng mailbox khách hàng thật.
[ ] Đã xác nhận không dùng Telegram group khách hàng thật.
[ ] Đã có rollback note cho deploy fail, migration fail, secret leak và gửi nhầm Telegram.
````

## Yêu cầu service staging

Web service cần chạy Next.js app bằng command thực tế trong package.json.

Claude phải kiểm tra package.json để xác nhận command build/start. Không tự bịa command nếu repo dùng command khác.

Worker service cần đọc các script worker hiện có trong package.json và scripts folder. Nếu repo có email worker, delta polling worker và subscription renewal worker riêng, checklist phải ghi rõ service nào dùng command nào.

Nếu platform đã chọn không hỗ trợ long-running worker trong web service, checklist phải yêu cầu tạo background service riêng.

## Yêu cầu environment variables

Chỉ ghi tên biến, không ghi giá trị thật.

Các biến cần kiểm tra và set trên platform dashboard gồm:

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

Nếu repo có thêm env name mới trong .env.example hoặc lib/env schema, Claude chỉ được cập nhật placeholder/template. Không ghi giá trị thật.

## Yêu cầu database và Redis staging

PostgreSQL staging phải là database riêng. Không dùng production database.

Redis staging phải là Redis riêng. Không dùng production Redis.

Chỉ chạy migration staging bằng lệnh an toàn sau khi staging DB đã sẵn sàng:

```bash
npx prisma migrate deploy
```

Không dùng lệnh sau cho staging:

```bash
npx prisma migrate dev
```

Không tạo migration mới trong TASK-049 nếu không có thay đổi schema thật sự và chưa được duyệt.

## Yêu cầu worker staging

Staging cần worker để xử lý queue và các background jobs.

Checklist cần xác định:

* Có email worker service hay chưa.
* Có delta polling worker service hay chưa.
* Có subscription renewal worker service hay chưa.
* Worker dùng env staging.
* Worker không trỏ vào database hoặc Redis production.
* Worker có thể được tắt khẩn cấp nếu phát hiện gửi nhầm Telegram.

## Yêu cầu bảo mật

Bắt buộc:

* Không hardcode secret.
* Không đọc hoặc in nội dung .env.
* Không commit file env thật.
* Không ghi token, password, client secret, database URL, Redis URL, Telegram bot token, encryption key hoặc session secret thật.
* Không log full verification code.
* Không ghi full email body.
* Không dùng mailbox khách hàng thật.
* Không dùng Telegram group khách hàng thật.
* Không dùng production database.
* Không dùng production Redis.
* Không sửa SECURITY_RULES để làm task dễ hơn.
* Không nới lỏng GitHub Actions secret scan trong task này.

Khi cập nhật docs, tránh các dòng metadata ngắn dạng keyword value có dấu hai chấm nếu keyword có thể bị secret scan hiểu nhầm.

## Các điểm Claude cần kiểm tra

Claude cần kiểm tra:

```text
[ ] Repo có task/report TASK-048 không.
[ ] TASK-048 đã chốt platform nào.
[ ] package.json có script build/start/worker nào.
[ ] deployment/staging/env.staging.example đã đủ tên biến chưa.
[ ] docs/STAGING_DEPLOYMENT.md có cần cập nhật theo platform đã chọn không.
[ ] Không có file env thật trong git diff.
[ ] Không có secret thật trong git diff.
[ ] Không có wording dễ gây secret scan false positive.
[ ] Không sửa runtime code nếu không cần.
[ ] Không tạo migration mới.
[ ] npm run verify PASS.
```

## Các thao tác user phải làm thủ công

User phải tự thao tác trên dashboard platform:

```text
[ ] Tạo project/environment staging.
[ ] Tạo web service.
[ ] Tạo PostgreSQL staging.
[ ] Tạo Redis staging.
[ ] Tạo worker service.
[ ] Set environment variables bằng secret thật trong platform dashboard.
[ ] Gắn hoặc xác nhận public HTTPS domain.
[ ] Kiểm tra deployment logs.
[ ] Chạy migration staging theo hướng dẫn nếu platform yêu cầu thao tác thủ công.
```

User không được paste secret thật vào AI.

## Các tình huống Gemini cần review

Gemini cần review:

```text
[ ] TASK-049 bám theo platform đã chốt ở TASK-048.
[ ] Không tự chọn lại platform.
[ ] Không deploy production.
[ ] Không dùng production database hoặc production Redis.
[ ] Không mở rộng sang TASK-050 hoặc TASK-051.
[ ] Checklist đủ web service, PostgreSQL, Redis, worker và HTTPS domain.
[ ] Env section chỉ có tên biến hoặc placeholder, không có giá trị thật.
[ ] Không có secret thật hoặc wording dễ gây secret scan false positive.
[ ] Không sửa runtime code nếu không cần.
[ ] Không tạo migration.
[ ] Không phá routing rule TASK-041 và TASK-044.
[ ] npm run verify PASS.
```

## Lệnh kiểm tra

Claude cần chạy:

```bash
git branch --show-current
git status --short
git diff --stat
npm run verify
git status --short
git diff --stat
```

Không commit trong TASK này nếu user chưa yêu cầu.

## Tiêu chí nghiệm thu

TASK-049 đạt khi:

```text
[ ] Đúng branch TASK-049.
[ ] Có docs/tasks/TASK-049-staging-infrastructure-setup.md.
[ ] Nếu có report, report không chứa secret thật.
[ ] Checklist staging bám theo platform đã chốt ở TASK-048.
[ ] Checklist đủ web service, PostgreSQL, Redis, worker và public HTTPS domain.
[ ] Env section chỉ ghi tên biến hoặc placeholder.
[ ] Không có .env, .env.local, .env.staging, .env.production trong diff.
[ ] Không có secret thật trong diff.
[ ] Không deploy production.
[ ] Không dùng production database hoặc Redis.
[ ] Không tạo Microsoft App Registration staging nếu để TASK-050.
[ ] Không chạy live mailbox E2E nếu để TASK-051.
[ ] Không tạo migration mới.
[ ] Không sửa runtime code nếu không cần.
[ ] npm run verify PASS.
[ ] Gemini review PASS.
[ ] GitHub Actions PASS sau push.
```

## Format báo cáo sau khi Claude làm xong

Claude cần báo cáo theo format:

```text
1. Tôi đã xác định TASK-048 chốt platform nào

2. Tôi đã thay đổi gì

3. File đã thay đổi

4. Những gì tôi cố ý không làm

5. Kiểm tra bảo mật
- Không đọc hoặc in .env
- Không ghi secret thật
- Không có file env thật trong diff
- Không dùng production database hoặc Redis
- Không mở rộng TASK-050/TASK-051

6. Lệnh đã chạy
- git branch --show-current
- git status --short
- git diff --stat
- npm run verify

7. Kết quả verify

8. Git status cuối cùng

9. Phần cần Gemini review kỹ
```

````