# TASK-058 — Production environment & secret setup (report)

Status: docs + placeholder standardization done; awaiting Gemini review.
Đây **không** phải production deploy. Không tạo/dùng production database, Redis,
mailbox, hoặc Telegram group khách hàng thật. Không đọc/in nội dung `.env*`.
Không có secret thật trong diff.

## 1. Mục tiêu đã đạt

Chuẩn hóa danh sách biến môi trường production và secret setup cho Verification
Code Relay Tool ở mức **tài liệu + placeholder an toàn**, đồng bộ giữa
`.env.example`, env loader, staging template, và các guide. Không deploy, không
sửa runtime code, không phá các rule routing/auth/worker đã chốt.

## 2. Phạm vi rà soát

Đã đọc và đối chiếu:

- `.env.example`
- `lib/env.ts` (env loader + các `require*Env` / `load*Env`)
- `lib/env.schema.ts` (danh sách `EnvValues` + các nhóm `*_REQUIRED`)
- `docs/MICROSOFT_SETUP.md`
- `docs/STAGING_DEPLOYMENT.md`
- `deployment/staging/env.staging.example`
- `docs/ROADMAP.md`
- Task/report liên quan: TASK-052, TASK-053, TASK-055, TASK-056, TASK-057.

## 3. Phát hiện chính

### 3.1. Thiếu placeholder cho một biến đã được code dùng (đã vá)

`DELTA_POLLING_BOOTSTRAP_LOOKBACK_HOURS` (TASK-036) đã được `lib/env.schema.ts`
khai báo trong `EnvValues` và `lib/env.ts` đọc trong `loadDeltaPollingEnv()`
(default 24h, floor 1h), nhưng **chưa có** trong `.env.example` lẫn
`deployment/staging/env.staging.example`. Đây là gap tài liệu thuần (code đã có
default an toàn nên không có lỗi runtime).

Đã thêm placeholder an toàn (giá trị `24`, không phải secret) vào:

- `.env.example`
- `deployment/staging/env.staging.example`
- bảng env trong `docs/STAGING_DEPLOYMENT.md` §5.4
- danh sách biến trong `docs/tasks/TASK-058-...md`

Sau khi vá, danh sách biến trong `.env.example`, env loader, và staging template
đã khớp nhau.

### 3.2. Quan sát secret-hygiene về `ENCRYPTION_KEY` trong `.env.example` (deferred, không sửa trong task này)

`.env.example` hiện ship một giá trị `ENCRYPTION_KEY` base64 32-byte **cụ thể**,
trong khi `deployment/staging/env.staging.example` để trống đúng chuẩn
(SECURITY_RULES §1: "`.env.example` ... contains placeholders only").

Giá trị này hiện được dùng làm **test fixture key** trong 3 file test
(`tests/unit/auth/session.test.ts`, `tests/unit/auth/staging-session.test.ts`,
`tests/api/auth/staging-login.route.test.ts`) và làm default tiện cho local dev.
Theo phân loại của team (TASK-057 report) đây là **giá trị ví dụ generated**, không
phải secret thật của bất kỳ môi trường nào.

Quyết định trong TASK-058: **không thay đổi** giá trị này, vì:

- Đụng vào nó bắt buộc phải sửa test code (ngoài scope "docs/placeholder" của task).
- TASK-058 không deploy nên không có rủi ro vận hành tức thời.

Khuyến nghị (deferred sang TASK-059/TASK-060 — secret hygiene): thay giá trị
trong `.env.example` bằng placeholder rõ ràng là không dùng được, và để 3 test tự
sinh/định nghĩa key riêng, để `.env.example` đúng nguyên tắc "placeholder-only".
Đây là điểm nên để **Gemini review xác nhận**.

### 3.3. Auth/session ở production hiện không cần biến môi trường riêng

Theo TASK-057 (đã done), production auth là **fail-closed tường minh**: admin
access ở production luôn bị từ chối cho tới khi có production sign-in provider
thật. Các biến login tạm thời **không** áp dụng cho production:

- `AUTH_DEV_DEMO_USER` — chỉ có tác dụng khi `APP_ENV=development`; production bỏ qua.
- `STAGING_ADMIN_PASSWORD` — chỉ có tác dụng khi `APP_ENV=staging`; production không dùng.
- `STAGING_ADMIN_SESSION_SECRET` — chỉ ký cookie session staging; production không dùng.

Vì repo **chưa** có production sign-in provider, TASK-058 **không** thêm tên biến
auth production mới (đúng yêu cầu "không tự bịa tên mới"). Việc thêm provider
production và biến đi kèm được defer sang một task riêng (gắn với TASK-059).

## 4. Danh sách nhóm biến môi trường production (chỉ tên biến)

Danh sách chuẩn hóa, đồng bộ với `lib/env.schema.ts`. Không ghi giá trị thật.

- App runtime: `APP_ENV`, `APP_URL`, `LOG_LEVEL`
- Datastore: `DATABASE_URL`, `REDIS_URL`
- Queue/worker: `EMAIL_QUEUE_NAME`, `EMAIL_WORKER_CONCURRENCY`
- Token encryption: `ENCRYPTION_KEY`
- Microsoft OAuth/Graph: `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`,
  `MICROSOFT_TENANT_ID`, `MICROSOFT_REDIRECT_URI`,
  `MICROSOFT_GRAPH_NOTIFICATION_URL`, `MICROSOFT_GRAPH_LIFECYCLE_NOTIFICATION_URL`
- Telegram: `TELEGRAM_BOT_TOKEN`, `TELEGRAM_ADMIN_ALERT_CHAT_ID`
- Delta polling worker: `DELTA_POLLING_ENABLED`, `DELTA_POLLING_INTERVAL_SECONDS`,
  `DELTA_POLLING_MAX_PAGES_PER_MAILBOX`, `DELTA_POLLING_BOOTSTRAP_LOOKBACK_HOURS`
- Subscription renewal worker: `SUBSCRIPTION_RENEWAL_ENABLED`,
  `SUBSCRIPTION_RENEWAL_INTERVAL_SECONDS`, `SUBSCRIPTION_RENEWAL_WINDOW_HOURS`
- Dev/staging-only (KHÔNG dùng ở production): `AUTH_DEV_DEMO_USER`,
  `STAGING_ADMIN_PASSWORD`, `STAGING_ADMIN_SESSION_SECRET`

Lưu ý phân loại bắt buộc (theo `lib/env.schema.ts`): nhóm `MICROSOFT_REQUIRED`,
`TELEGRAM_REQUIRED`, `DATABASE_REQUIRED`, `ENCRYPTION_REQUIRED`,
`GRAPH_SUBSCRIPTION_REQUIRED` được validate qua các `require*Env`. Validator trả
kết quả thay vì throw lúc load, nên local dev/CI không fail chỉ vì secret chưa set.

## 5. Không phá các task trước (xác nhận, không sửa code)

- **TASK-052 (safe disconnect):** Không đụng disconnect flow. Mailbox disconnected
  vẫn không poll/renew/relay. Không thêm biến nào nới lỏng guard này.
- **TASK-053 (reusable destinations):** Giữ nguyên — nhiều mailbox dùng chung một
  reusable Telegram destination, mỗi mailbox vẫn tối đa một active destination.
  Không có biến env nào bật broadcast hay one-mailbox-nhiều-destination.
- **TASK-055 (throttling/queue safety):** Các hằng số per-mailbox lock và
  shared-destination throttle vẫn nằm trong code; TASK-058 không thêm biến override
  và không đổi default `EMAIL_WORKER_CONCURRENCY`.
- **TASK-056 (health dashboard):** Read-only, không bị ảnh hưởng; không thêm biến
  nào khiến dashboard tự probe external.
- **TASK-057 (auth hardening):** Production vẫn fail-closed; không thêm cơ chế
  login tạm cho production; các biến dev/staging-only vẫn được giữ đúng phạm vi
  môi trường.
- **One-mailbox-one-destination rule:** Không thay đổi. Không broadcast.

## 6. Cách giữ internal staff app + RBAC + scope

- App vẫn là internal staff app: khách hàng **không** login, không portal, không
  signup, không billing/payment. TASK-058 không thêm bất kỳ surface khách hàng nào.
- OWNER/ADMIN xem toàn bộ; STAFF_READ_ONLY chỉ thấy customer/mailbox/mapping được
  assigned. Scope enforce ở service/API layer (không phải chỉ ẩn UI). TASK-058
  thuần tài liệu nên không chạm các guard này.

## 7. Checklist pre-deploy production (tóm tắt — chi tiết trong task file)

Chỉ dùng để chuẩn bị, **không** chạy trong TASK-058:

- Production app URL dùng HTTPS; Microsoft redirect URI + webhook URL khớp tuyệt
  đối app URL production và là public HTTPS.
- Production database, Redis, encryption key, Microsoft App Registration đều **tách
  biệt** local/staging; encryption key tạo riêng cho production.
- Mọi secret production chỉ sống trong secret manager của deploy platform; không
  commit, không paste vào AI/chat/docs/log.
- Telegram admin alert chat là chat kiểm soát nội bộ; smoke test **không** dùng
  mailbox / Telegram group khách hàng thật (chờ task internal beta).
- Worker production chỉ bật ở TASK-059 sau khi checklist được duyệt; phải có cách
  tắt worker khẩn cấp nếu nghi gửi nhầm destination.

## 8. Secret safety checklist (đã tuân thủ trong task này)

- Không commit `.env`, `.env.local`, `.env.staging`, `.env.production`.
- Không đọc/in nội dung `.env*`.
- `.env.example` và staging template chỉ thêm placeholder an toàn (số `24`).
- Không ghi giá trị thật của connection string, client secret, bot token,
  encryption key, hay session/auth secret vào docs/code/log/report.
- Không log token, full verification code, hay full email body.
- Tránh wording dạng `keyword: value` nhạy cảm; chỉ liệt kê **tên biến**.

## 9. Deferred sang TASK-059/060/061+

- **TASK-059 (limited internal beta):** thực thi production deploy theo checklist;
  bật worker production có kiểm soát; thêm production sign-in provider thật + biến
  đi kèm; smoke test có kiểm soát.
- **TASK-060 (backup/restore/incident response):** thực hiện khuyến nghị secret
  hygiene ở §3.2 (đưa `.env.example` về placeholder-only, test tự sinh key); quy
  trình rotate secret và purge log khi nghi lộ.
- **TASK-061+ (internal operations):** staff onboarding, daily ops checklist,
  scale-up từ beta.

## 10. Kết quả kiểm tra

- `npm run verify`: xem mục báo cáo trong tin nhắn của Claude (kèm log).
- `git status --short` và `git diff --stat`: xem trong tin nhắn của Claude.
- Diff không chứa secret thật, full verification code, hay full email body.

## 11. Phần cần Gemini review kỹ

- Xác nhận §3.2: có nên đưa `.env.example` về placeholder-only ngay (sửa 3 test)
  hay defer như đề xuất.
- Xác nhận danh sách biến §4 đã khớp `lib/env.schema.ts` và không thiếu/thừa.
- Xác nhận không có dòng metadata nào trong diff dễ gây GitHub Actions secret-scan
  false positive.
