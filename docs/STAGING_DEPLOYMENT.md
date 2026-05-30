# Staging Deployment Guide

> Hướng dẫn deploy **Verification Code Relay Tool** lên môi trường **staging** một
> cách an toàn. Đây là bước chuẩn bị cho TASK-040 (MVP acceptance review).
>
> Tài liệu này **không** deploy production, **không** dùng khách hàng thật,
> **không** dùng Telegram group thật của khách hàng, và **không** chứa secret
> thật. Mọi giá trị thật chỉ sống trong secret manager của deploy platform.

Liên quan:
- `deployment/staging/env.staging.example` — template biến môi trường (placeholder).
- `deployment/staging/README.md` — tóm tắt thư mục staging.
- `docs/MICROSOFT_SETUP.md` — App Registration (có mục staging redirect URI / webhook).
- `docs/SECURITY_RULES.md` — quy tắc bảo mật nền tảng.
- `.env.example` — nguồn gốc danh sách biến môi trường thật của project.

---

## 5.1. Mục tiêu staging

Staging là môi trường gần giống production, dùng để chạy kiểm tra end-to-end
**trước khi** nghiệm thu MVP (TASK-040) và trước khi deploy production thật.

Staging dùng để:

- Test luồng OAuth connect mailbox với Microsoft App Registration riêng cho staging.
- Test webhook + delta polling backup trên domain HTTPS public.
- Test gửi Telegram vào **test group**, không phải group khách hàng thật.
- Chạy smoke test và E2E trước khi release.

Staging **không** dùng để:

- Phục vụ khách hàng thật.
- Đọc mailbox khách hàng thật.
- Gửi message vào Telegram group khách hàng thật.
- Kết nối tới database production.

---

## 5.2. Staging architecture

```text
GitHub (branch deploy lên staging)
  -> Deploy platform (Vercel / Railway / Render / Fly / ...)
       -> Next.js app (APP_ENV=staging, HTTPS public domain)
       -> Staging PostgreSQL database (riêng, KHÔNG phải production)
       -> Staging Redis / BullMQ queue (cho email worker)
       -> Background workers:
            - delta polling backup  (scripts/run-delta-polling-worker.ts)
            - subscription renewal   (scripts/run-subscription-renewal-worker.ts)
       -> Microsoft App Registration (staging, tách biệt local/prod)
            -> Redirect URI:  https://YOUR_STAGING_DOMAIN/api/microsoft/oauth/callback
            -> Webhook URL:   https://YOUR_STAGING_DOMAIN/api/webhooks/microsoft/mail
       -> Telegram bot + TEST group (không phải group khách hàng thật)
```

Đường đi dữ liệu (tóm tắt):

```text
Microsoft Graph (mail mới)
  -> webhook /api/webhooks/microsoft/mail  (đường chính)
  -> hoặc delta polling backup             (đường dự phòng)
  -> email worker: detect Facebook/Meta -> extract code -> dedupe (ProcessedMessage)
  -> Telegram sender -> test group
```

Webhook và delta polling có thể cùng thấy một `graphMessageId`; dedupe theo
unique `[mailboxId, graphMessageId]` đảm bảo Telegram chỉ nhận **đúng một lần**.

---

## 5.3. Required services

| Service | Bắt buộc | Ghi chú |
|---------|----------|---------|
| Hosting Next.js app | Có | HTTPS public domain. `next build` + `next start`. |
| PostgreSQL staging | Có | Database riêng cho staging. Không dùng production DB. |
| Redis staging | Có | BullMQ queue cho email worker (`REDIS_URL`). |
| Background workers | Có | Delta polling + subscription renewal (xem §5.8). |
| Microsoft App Registration (staging) | Có | Tách biệt local/prod. Scope tối thiểu. |
| Telegram bot + test group | Có | Token trong secret manager; test group, không phải khách hàng. |
| Public HTTPS domain | Có | Bắt buộc cho OAuth redirect + Graph webhook. |

---

## 5.4. Environment variables

Cấu hình các biến sau trên **secret manager / environment settings** của deploy
platform. **KHÔNG** ghi giá trị thật vào repo. Template placeholder đầy đủ nằm ở
`deployment/staging/env.staging.example` (đã đồng bộ với `.env.example`).

| Biến | Mục đích | Ghi chú staging |
|------|----------|-----------------|
| `APP_ENV` | Môi trường runtime | `staging` |
| `APP_URL` | Base URL của app | `https://YOUR_STAGING_DOMAIN` |
| `LOG_LEVEL` | Mức log | `info` |
| `DATABASE_URL` | Postgres staging | Riêng staging, không phải prod |
| `REDIS_URL` | Redis cho BullMQ | Riêng staging |
| `EMAIL_QUEUE_NAME` | Tên queue | mặc định `email-processing` |
| `EMAIL_WORKER_CONCURRENCY` | Concurrency worker | mặc định `2` |
| `ENCRYPTION_KEY` | Mã hóa token (AES-256-GCM) | base64 32 bytes, **tạo mới cho staging** |
| `MICROSOFT_CLIENT_ID` | Client ID staging | Từ App Registration staging |
| `MICROSOFT_CLIENT_SECRET` | Client secret staging | **Không** tái dùng secret local |
| `MICROSOFT_TENANT_ID` | Tenant | `common` (multitenant + personal) |
| `MICROSOFT_REDIRECT_URI` | OAuth callback | `https://YOUR_STAGING_DOMAIN/api/microsoft/oauth/callback` |
| `MICROSOFT_GRAPH_NOTIFICATION_URL` | Webhook URL | `https://YOUR_STAGING_DOMAIN/api/webhooks/microsoft/mail` |
| `MICROSOFT_GRAPH_LIFECYCLE_NOTIFICATION_URL` | Lifecycle URL (optional) | Để trống nếu chưa có endpoint |
| `TELEGRAM_BOT_TOKEN` | Bot token | Secret manager, không lưu DB |
| `TELEGRAM_ADMIN_ALERT_CHAT_ID` | Chat ID alert admin | Chat ID test |
| `AUTH_DEV_DEMO_USER` | Demo user dev-only | Để trống ở staging (ignored khi APP_ENV != development) |
| `DELTA_POLLING_ENABLED` | Bật/tắt delta polling | `true` |
| `DELTA_POLLING_INTERVAL_SECONDS` | Chu kỳ poll | `30` |
| `DELTA_POLLING_MAX_PAGES_PER_MAILBOX` | Giới hạn trang | `10` |
| `SUBSCRIPTION_RENEWAL_ENABLED` | Bật/tắt renewal | `true` |
| `SUBSCRIPTION_RENEWAL_INTERVAL_SECONDS` | Chu kỳ renewal | `900` |
| `SUBSCRIPTION_RENEWAL_WINDOW_HOURS` | Cửa sổ renew trước hạn | `24` |

> Khi `.env.example` thêm biến mới, cập nhật cả bảng này và
> `deployment/staging/env.staging.example`.

---

## 5.5. Microsoft staging setup

Tham chiếu chi tiết: `docs/MICROSOFT_SETUP.md`. Riêng cho staging cần nhớ:

- Staging **phải** dùng **HTTPS** (không dùng `http://localhost`).
- Tạo **App Registration riêng cho staging** — **không** tái dùng client secret
  của local dev.
- Redirect URI staging phải **khớp tuyệt đối** với `MICROSOFT_REDIRECT_URI`:
  `https://YOUR_STAGING_DOMAIN/api/microsoft/oauth/callback`
  (sai protocol/port/path/dấu `/` đều gây `AADSTS50011`).
- Webhook URL staging phải là **public HTTPS**:
  `https://YOUR_STAGING_DOMAIN/api/webhooks/microsoft/mail`.
- **Không** paste client secret vào chat AI / log / docs.
- Scope giữ **tối thiểu**: `Mail.Read`, `offline_access`, `User.Read`.

---

## 5.6. Telegram staging setup

- Dùng **Telegram test group**, tuyệt đối **không** dùng group khách hàng thật.
- `TELEGRAM_BOT_TOKEN` chỉ nằm trong **secret manager / env** của deploy platform,
  **không** lưu trong database (theo SECURITY_RULES §3).
- Chat ID test nằm trong database (mapping per customer) hoặc env tùy cấu hình
  hiện tại; **không hardcode** Telegram chat ID trong code.
- Mỗi customer map đúng một Telegram group; message của A không bao giờ được route
  sang group của B, kể cả khi retry (SECURITY_RULES §5).

---

## 5.7. Database staging setup

- Dùng **database riêng cho staging**. **Không** dùng production DB.
- **Không** nạp dữ liệu khách hàng thật vào staging.
- Chạy migration an toàn:
  ```bash
  npx prisma migrate deploy   # áp dụng migration đã commit (không tạo mới)
  ```
  (Dùng `prisma migrate deploy` cho staging/prod, không dùng `migrate dev`.)
- Sau deploy, kiểm tra trạng thái migration:
  ```bash
  npx prisma migrate status
  ```
- Connection string chỉ sống trong env/secret manager; **không** log credentials.

---

## 5.8. Worker / queue setup

Project có queue (BullMQ + Redis) và background workers, nên staging cần:

- **Email worker / queue**: dùng `REDIS_URL`, `EMAIL_QUEUE_NAME`,
  `EMAIL_WORKER_CONCURRENCY` của staging.
- **Delta polling backup worker**: `npm run worker:delta`
  (`scripts/run-delta-polling-worker.ts`). Đường dự phòng khi webhook miss.
- **Subscription renewal worker**: `npm run worker:renewal`
  (`scripts/run-subscription-renewal-worker.ts`). Gia hạn subscription trước khi hết hạn.

Quy tắc:

- Worker staging phải dùng **đúng env staging**.
- **Không** chạy worker staging trỏ vào database/Redis production.
- Health dashboard (`/admin/health`) phải hiển thị trạng thái
  worker / polling / subscription nếu đã có.
- Nếu platform không hỗ trợ long-running process (ví dụ serverless thuần), cần
  chạy worker ở một service riêng (worker dyno / background service) dùng chung
  env staging.

---

## 5.9. Smoke test checklist

Smoke test = test nhanh sau deploy để biết staging sống hay chết.

```text
[ ] App staging mở được bằng HTTPS.
[ ] /admin mở được.
[ ] Health dashboard (/admin/health) mở được.
[ ] Không thấy secret/token/code trong UI.
[ ] OAuth connect URL tạo được (/api/mailboxes/connect-url).
[ ] Microsoft OAuth callback dùng đúng staging redirect URI.
[ ] Webhook endpoint (/api/webhooks/microsoft/mail) trả validationToken đúng khi Microsoft verify.
[ ] Telegram test-send gửi được vào test group.
[ ] E2E mock flow pass (npm run test:e2e).
[ ] E2E Microsoft test mailbox pass nếu có đủ env thật.
[ ] Không gửi trùng khi webhook và delta polling cùng thấy một graphMessageId.
[ ] npm run verify pass.
```

---

## 5.10. Rollback plan

Rollback = quay lại phiên bản deploy trước nếu bản mới lỗi.

- **Deploy fail**: rollback về build/deployment trước trên deploy platform
  (Vercel: redeploy bản trước; Railway/Render: rollback release).
- **Migration fail**: **không** tự sửa DB bằng tay nếu chưa hiểu nguyên nhân.
  Dừng deploy, kiểm tra `prisma migrate status`, khôi phục từ backup nếu cần.
- **Secret lộ**: **rotate ngay** secret bị ảnh hưởng (tạo secret mới trên Entra /
  BotFather / DB provider, xóa secret cũ), rồi cập nhật env staging.
- **Telegram gửi nhầm group**: **disable worker/automation ngay**, kiểm tra mapping
  customer ↔ chat ID, xem audit log, sửa mapping trước khi bật lại.
- **Microsoft OAuth lỗi redirect** (`AADSTS50011`): kiểm tra lại Redirect URI trong
  App Registration staging và biến `MICROSOFT_REDIRECT_URI` cho khớp tuyệt đối.

---

## 5.11. Security checklist

```text
[ ] Không commit .env / .env.local / .env.staging / secret thật.
[ ] Không đưa token / client secret vào docs.
[ ] Không log access token / refresh token.
[ ] Không log full verification code (dùng maskCode()).
[ ] Không dùng Telegram group khách hàng thật cho staging.
[ ] Không dùng mailbox khách hàng thật cho staging.
[ ] Không dùng database production.
[ ] Staging domain dùng HTTPS.
[ ] Microsoft redirect URI khớp tuyệt đối với env.
[ ] App Registration staging tách biệt local/prod; ENCRYPTION_KEY tạo mới cho staging.
[ ] GitHub Actions / CI pass (npm run verify).
```

---

## Báo cáo sau deploy

Sau khi deploy staging, ghi lại: build version, kết quả smoke test checklist,
và bất kỳ env nào còn thiếu. Khi tất cả mục §5.9 pass → sẵn sàng cho TASK-040.
