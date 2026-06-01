# TASK-049 Report — Staging Infrastructure Setup

- **Report date:** 2026-06-01
- **Author:** Claude Code
- **Platform đã chốt (từ TASK-048):** Railway (chính), Render (dự phòng tương đương).
- **Scope:** Chuẩn bị checklist hạ tầng staging theo platform đã chốt. **Không deploy,
  không tạo database/Redis thật, không tạo Microsoft App Registration staging
  (TASK-050), không chạy live mailbox E2E (TASK-051), không tạo migration, không sửa
  runtime code, không ghi secret thật.** Chỉ ghi **tên** biến môi trường, không ghi
  giá trị thật.

---

## 1. Kết luận TASK-048 mà TASK-049 bám theo

Nguồn: `docs/reports/TASK-048-choose-deployment-platform-staging-architecture.md`.

- **Platform khuyến nghị: Railway.** Một project chứa được web Next.js + PostgreSQL +
  Redis + các worker long-running, một dashboard, HTTPS public domain tức thì.
- **Dự phòng tương đương: Render** (Web Service + Background Worker + Postgres + Key
  Value Redis). Nếu Railway vướng quota/region/giá thì chuyển Render gần như 1-1.
- **Không dùng Vercel-only cho staging** vì worker long-running phải tách sang nền khác
  → 2 platform, khó vận hành.
- **Worker strategy đã chốt: tách 3 worker service riêng** (email / delta / renewal),
  dùng thẳng npm script đã có, không gộp process (gộp cần runtime wrapper, ngoài scope).
- **Domain staging:** dùng domain mặc định của platform (`.railway.app`) là đủ cho
  OAuth callback và Graph webhook; custom domain là tùy chọn về sau.

→ TASK-049 **không chọn lại platform**, chỉ chi tiết hóa checklist theo Railway (kèm
ghi chú tương đương cho Render).

## 2. Kiến trúc staging tối thiểu (nhắc lại từ TASK-048 §5)

```text
Railway project: verification-tool-staging   (tách hoàn toàn khỏi production)
  1) web             Next.js — build: npm run build  | start: npm run start
                     -> public HTTPS domain (.railway.app)
                     -> phục vụ /admin, OAuth callback, Graph webhook
  2) postgres        Managed PostgreSQL (template Railway) — RIÊNG staging
  3) redis           Managed Redis (template Railway) — RIÊNG staging
  4) worker-email    start: npm run worker:email     (BullMQ consumer)
  5) worker-delta    start: npm run worker:delta     (đường dự phòng webhook-miss)
  6) worker-renewal  start: npm run worker:renewal   (gia hạn Graph subscription)
```

Command đã xác minh trong `package.json`:

```text
build           -> next build
start           -> next start
worker:email    -> tsx scripts/run-email-worker.ts
worker:delta    -> tsx scripts/run-delta-polling-worker.ts
worker:renewal  -> tsx scripts/run-subscription-renewal-worker.ts
```

Không tự bịa command; tất cả khớp script thật trong repo.

## 3. Phần A — việc làm được TRONG repo (Claude đã chuẩn bị)

Đây là phần repo-side; **không** cần thao tác dashboard, **không** chứa secret thật.

```text
[x] Checklist hạ tầng staging theo Railway — file này + docs/STAGING_DEPLOYMENT.md mục Railway.
[x] Danh sách TÊN biến môi trường staging — đã đủ 25 biến, đồng bộ giữa
    .env.example và deployment/staging/env.staging.example (đã đối chiếu khớp 100%).
[x] Template env staging chỉ chứa placeholder (deployment/staging/env.staging.example).
[x] Hướng dẫn web/Postgres/Redis/worker/domain — docs/STAGING_DEPLOYMENT.md §5.3–5.8 + mục Railway.
[x] Lệnh migration an toàn cho staging: prisma migrate deploy (KHÔNG migrate dev).
[x] Smoke test, rollback, security checklist — docs/STAGING_DEPLOYMENT.md §5.9–5.11.
[x] npm run verify chạy được (kết quả trong báo cáo của Claude).
```

**Không có biến môi trường mới** cần thêm: env.staging.example đã liệt kê đủ tên biến
mà schema/`.env.example` yêu cầu, nên TASK-049 không sửa file template.

## 4. Phần B — việc USER phải thao tác THỦ CÔNG trên Railway

Phần này nằm **ngoài repo**. User tự làm trên dashboard Railway; **không paste secret
thật vào bất kỳ AI nào** (ChatGPT/Claude/Gemini/Cursor). Giá trị thật chỉ sống trong
secret manager của Railway.

### 4.1. Tạo project và service

```text
[ ] Tạo Railway project mới đặt tên gợi nhớ staging, tách hoàn toàn khỏi production.
[ ] Service web: deploy từ GitHub repo, branch staging.
      - Build command:  npm run build
      - Start command:  npm run start
[ ] Service postgres: thêm từ template PostgreSQL của Railway (RIÊNG staging).
[ ] Service redis: thêm từ template Redis của Railway (RIÊNG staging).
[ ] Service worker-email:   cùng repo, Start command: npm run worker:email
[ ] Service worker-delta:   cùng repo, Start command: npm run worker:delta
[ ] Service worker-renewal: cùng repo, Start command: npm run worker:renewal
```

### 4.2. Public HTTPS domain

```text
[ ] Ở service web, bật domain công khai (Generate Domain) để có URL .railway.app HTTPS.
[ ] Ghi lại domain này — dùng cho APP_URL, MICROSOFT_REDIRECT_URI và
    MICROSOFT_GRAPH_NOTIFICATION_URL (App Registration staging là việc của TASK-050).
[ ] (Tùy chọn) Gắn custom domain nếu muốn; không bắt buộc cho staging.
```

### 4.3. Biến môi trường (chỉ set giá trị thật trên dashboard)

```text
[ ] Đặt nhóm biến staging trong phần Variables của Railway cho web + cả 3 worker.
[ ] DATABASE_URL và REDIS_URL: trỏ tới service Postgres/Redis staging vừa tạo
    (dùng variable reference của Railway), KHÔNG trỏ production.
[ ] ENCRYPTION_KEY: tạo MỚI cho staging, không tái dùng key local/prod.
[ ] Các biến nhạy cảm (client secret, bot token, admin password, session secret):
    chỉ nhập trên dashboard, không commit, không log, không paste vào AI.
[ ] Danh sách tên biến đầy đủ: xem mục 6 và deployment/staging/env.staging.example.
```

### 4.4. Migration staging (sau khi Postgres đã sẵn sàng)

```text
[ ] Chạy migration đã commit bằng lệnh AN TOÀN:
        npx prisma migrate deploy
[ ] KHÔNG dùng cho staging:
        npx prisma migrate dev
[ ] Kiểm tra trạng thái sau khi chạy:
        npx prisma migrate status
[ ] Có thể chạy qua Railway one-off/release command hoặc Railway CLI; tùy chọn
    vận hành, không nằm trong repo.
```

Không tạo migration mới trong TASK-049 (không có thay đổi schema).

### 4.5. Telegram và mailbox (an toàn)

```text
[ ] Dùng Telegram TEST bot + TEST group. KHÔNG dùng group khách hàng thật.
[ ] Dùng mailbox TEST. KHÔNG dùng mailbox khách hàng thật.
[ ] TELEGRAM_BOT_TOKEN chỉ trong secret manager Railway, không lưu DB, không commit.
```

### 4.6. Worker an toàn (quy tắc vận hành 2 máy)

```text
[ ] Worker CHỈ chạy trên Railway. KHÔNG chạy worker local trỏ vào DB/Redis staging
    (tránh xử lý trùng / job chạy 2 nơi).
[ ] Mỗi worker có thể TẮT KHẨN CẤP độc lập nếu phát hiện gửi nhầm Telegram.
[ ] Máy local chỉ dev + git push; không đồng bộ secret bằng tay giữa 2 máy.
```

## 5. Thứ tự thực hiện đề xuất

```text
1. Tạo project staging.
2. Tạo Postgres + Redis (lấy được connection để tham chiếu).
3. Tạo web service; set Variables (gồm DATABASE_URL/REDIS_URL trỏ service staging).
4. Bật public HTTPS domain; cập nhật APP_URL + URL OAuth/webhook.
5. Chạy prisma migrate deploy lên Postgres staging.
6. Tạo 3 worker service (email/delta/renewal) dùng chung nhóm Variables staging.
7. Smoke test theo docs/STAGING_DEPLOYMENT.md §5.9.
   (App Registration staging = TASK-050; live mailbox E2E = TASK-051.)
```

## 6. Nhóm biến môi trường staging (chỉ TÊN — không giá trị)

Đầy đủ tên + ghi chú ở `docs/STAGING_DEPLOYMENT.md` §5.4 và
`deployment/staging/env.staging.example`. Tóm theo nhóm:

- **App runtime:** APP_ENV, APP_URL, LOG_LEVEL.
- **Datastore:** DATABASE_URL, REDIS_URL.
- **Queue / worker:** EMAIL_QUEUE_NAME, EMAIL_WORKER_CONCURRENCY.
- **Token encryption:** ENCRYPTION_KEY (tạo mới cho staging).
- **Microsoft OAuth / Graph:** MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET,
  MICROSOFT_TENANT_ID, MICROSOFT_REDIRECT_URI, MICROSOFT_GRAPH_NOTIFICATION_URL,
  MICROSOFT_GRAPH_LIFECYCLE_NOTIFICATION_URL.
- **Telegram:** TELEGRAM_BOT_TOKEN, TELEGRAM_ADMIN_ALERT_CHAT_ID.
- **Auth / staging admin:** AUTH_DEV_DEMO_USER, STAGING_ADMIN_PASSWORD,
  STAGING_ADMIN_SESSION_SECRET.
- **Delta polling worker:** DELTA_POLLING_ENABLED, DELTA_POLLING_INTERVAL_SECONDS,
  DELTA_POLLING_MAX_PAGES_PER_MAILBOX.
- **Subscription renewal worker:** SUBSCRIPTION_RENEWAL_ENABLED,
  SUBSCRIPTION_RENEWAL_INTERVAL_SECONDS, SUBSCRIPTION_RENEWAL_WINDOW_HOURS.

Quy tắc: giá trị thật **chỉ** sống trong secret manager của Railway.

## 7. Rủi ro vận hành còn lại

| Rủi ro | Giảm thiểu |
|---|---|
| Worker crash/không restart → ngừng relay hoặc miss mail | Chạy worker trên Railway (có restart); giám sát qua logs + `/admin/health` |
| Mất Redis → job dừng | Redis managed riêng staging; không trỏ Redis production |
| Sai webhook HTTPS/validationToken → không nhận notification | Dùng domain HTTPS Railway; URL khớp tuyệt đối biến notification; có đường dự phòng delta polling |
| Sai/thiếu env hoặc lộ secret | Chỉ đặt trong secret manager; ENCRYPTION_KEY mới cho staging; không log giá trị |
| Dùng nhầm `migrate dev` trên staging | Chỉ `prisma migrate deploy`; không tạo migration ở task này |
| Cost nhiều service; pricing có thể đổi | Xem pricing official lúc setup; tắt service khi không test |
| Vận hành 2 PC → job chạy trùng | Worker chỉ chạy trên Railway; local chỉ dev + push |

## 8. Những việc tôi KHÔNG làm

- Không deploy staging, không deploy production.
- Không tạo Railway project/database/Redis thật; không tạo App Registration staging (TASK-050).
- Không chạy live mailbox E2E (TASK-051).
- Không nhập/ghi secret thật; không đọc/in `.env*`.
- Không tạo migration; không thao tác production database/Redis.
- Không sửa runtime code (OAuth/Graph, worker/queue, Telegram routing, auth/permission).
- Không sửa GitHub Actions; không nới lỏng secret scan.
- Không phá routing rule TASK-041/044 (nhiều mailbox dùng chung group/topic được;
  một mailbox chỉ một destination active).

## 9. Phần cần Gemini review kỹ

- TASK-049 có **bám đúng Railway** đã chốt ở TASK-048 không; có vô tình chọn lại platform không.
- Checklist có **tách rõ** phần Claude-làm-trong-repo và phần user-thao-tác-thủ-công không.
- Checklist có đủ **web + PostgreSQL + Redis + worker-email + worker-delta + worker-renewal
  + public HTTPS domain** không.
- Có nhấn đúng **prisma migrate deploy** (không `migrate dev`) cho staging không.
- Có nhắc rõ **không dùng mailbox khách hàng thật / Telegram group khách hàng thật** không.
- Docs **chỉ ghi tên biến**, không có giá trị thật; không có wording dễ gây secret scan
  false positive.
- Không mở rộng sang TASK-050/051; không sửa runtime code; không tạo migration.
- Kết luận PASS/FAIL theo `GEMINI.md`.
