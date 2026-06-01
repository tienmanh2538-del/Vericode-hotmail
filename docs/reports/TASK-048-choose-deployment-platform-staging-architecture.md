# TASK-048 Report — Choose Deployment Platform & Staging Architecture

- **Report date:** 2026-06-01
- **Author:** Claude Code
- **Scope:** Planning / documentation only. **No deploy, no real database/Redis,
  no real Microsoft App Registration, no migration, no runtime code change, no real
  secret.** Chỉ ghi **tên** biến môi trường / nhóm biến, không ghi giá trị thật.
- **Out of scope:** TASK-049 (infra setup), TASK-050 (App Registration staging),
  TASK-051 (live E2E). Report này chỉ **chốt quyết định** và **chuẩn bị checklist**.

---

## 1. Tôi đã làm gì

- Rà soát nhu cầu staging thực tế của app từ tài liệu hiện có
  (`docs/STAGING_DEPLOYMENT.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`,
  `docs/MICROSOFT_SETUP.md`) và từ `package.json` (các worker script đã tồn tại).
- Xác minh khả năng nền tảng qua **official docs** của Railway, Render, Vercel
  (xem §9 Nguồn). Không dùng blog/forum làm căn cứ chính.
- So sánh **Railway vs Render vs Vercel + worker riêng**.
- Chọn **một** platform staging khuyến nghị và mô tả **kiến trúc staging tối thiểu**.
- Liệt kê **service cần tạo ở TASK-049** và **rủi ro vận hành** cần kiểm soát.

## 2. App này thực sự cần gì ở staging

Đây là **internal staff app**, không phải public SaaS. Khách không login; chỉ nhận
verification code qua Telegram group/topic. Staging phải chạy được **toàn bộ pipeline**:

| Thành phần | Nguồn trong repo | Tính chất hạ tầng |
|---|---|---|
| Web Admin + API routes (Next.js) | `next build` / `next start` | HTTP service, cần HTTPS public |
| Microsoft OAuth callback | route `/api/microsoft/oauth/callback` | cần **HTTPS public domain** |
| Microsoft Graph webhook | route `/api/webhooks/microsoft/mail` | cần **HTTPS public domain** |
| PostgreSQL | Prisma client | managed DB riêng staging |
| Redis | BullMQ | managed Redis riêng staging |
| Email worker | `npm run worker:email` (`scripts/run-email-worker.ts`) | **process chạy liên tục** |
| Delta polling backup worker | `npm run worker:delta` | **process chạy liên tục** (vòng lặp poll) |
| Subscription renewal worker | `npm run worker:renewal` | **process chạy liên tục** (gia hạn subscription) |
| Telegram sender | service hiện có | gọi ra ngoài, dùng **test bot/test group** |

**Điểm mấu chốt:** ngoài web service "request → response", app còn có **3 process
nền chạy liên tục** (BullMQ consumer + 2 vòng lặp polling/renewal). Đây là yếu tố
quyết định khi chọn platform: nền tảng phải chạy được **long-running worker**, không
chỉ serverless function.

> `worker:delta` và `worker:renewal` có biến thể `--once` (`worker:delta:once`,
> `worker:renewal:once`) phù hợp chạy theo lịch (cron). Nhưng để test live đúng như
> production ở TASK-051 (webhook + đường dự phòng + gia hạn), khuyến nghị chạy
> **liên tục**.

## 3. So sánh platform (trung lập, theo official docs)

### 3.1. Railway

| Tiêu chí | Kết luận | Căn cứ official |
|---|---|---|
| Next.js web service | Có (deploy từ GitHub repo) | docs.railway.com — Services |
| Managed PostgreSQL | Có (template chính thức) | docs.railway.com — Databases |
| Managed Redis | Có (template chính thức) | docs.railway.com — Databases |
| Long-running worker | Có (service riêng từ cùng repo, custom start command) | docs.railway.com — Services |
| Nhiều service trong 1 project | Có | docs.railway.com — Services |
| Public HTTPS domain | Có (`.railway.app` + custom domain, auto SSL) | docs.railway.com — Public Networking |
| Logs / restart / rollback | Có (deploy logs, redeploy/rollback deployment) | docs.railway.com — Observability / Deployments |
| Phù hợp BullMQ worker | Có (process liên tục + Redis cùng project) | suy ra từ Services + Databases |
| Dễ vận hành cho người không chuyên code | Cao — web + Postgres + Redis + worker **trong cùng một project, một dashboard** | — |

### 3.2. Render

| Tiêu chí | Kết luận | Căn cứ official |
|---|---|---|
| Next.js web service | Có (Web Service) | render.com/docs — Web Services |
| Managed PostgreSQL | Có | render.com/docs — Postgres |
| Redis | Có — **Key Value (Redis-compatible)** | render.com/docs — Key Value |
| Long-running worker | Có — **Background Worker** (service type riêng) | render.com/docs — Background Workers |
| Public HTTPS domain | Có (custom domains, HTTPS) | render.com/docs — Custom Domains |
| Logs / rollback | Có (in-dashboard Logging, Rollbacks) | render.com/docs — Logging / Rollbacks |
| Phù hợp BullMQ worker | Có (Background Worker + Key Value) | suy ra từ docs |
| Dễ vận hành cho người không chuyên code | Cao — đủ mọi service type, mô hình tương tự Railway | — |

→ Render đáp ứng **đầy đủ** yêu cầu, là **phương án dự phòng tương đương**.

### 3.3. Vercel + worker riêng

| Tiêu chí | Kết luận | Căn cứ official |
|---|---|---|
| Next.js web service | Rất tốt (Vercel tối ưu cho Next.js) | vercel.com/docs |
| Long-running worker always-on | **Không** — Vercel Functions có **giới hạn thời gian chạy** (không phải process always-on); workload cần chạy không giới hạn thời gian phải dùng Vercel Workflows. Con số giới hạn cụ thể theo official docs và **có thể thay đổi** | vercel.com/docs — Functions: Duration / Limitations |
| BullMQ consumer + vòng lặp polling liên tục | Không hợp với function serverless | suy ra từ giới hạn duration |
| Hệ quả | Phải chạy worker ở **nền tảng khác** (ví dụ Railway/Render) → **2 platform**, **2 nơi xem logs**, **2 nơi quản secret**, networking/deploy order phức tạp hơn | — |

→ Vercel chỉ hợp khi chấp nhận **tách web (Vercel) và worker (nền khác)**. Với người
không chuyên code vận hành trên nhiều máy, đây là phương án **phức tạp nhất**.

## 4. Quyết định: khuyến nghị **Railway** cho staging

**Khuyến nghị chính: Railway.** Lý do:

1. **Một platform, một project** chứa được **tất cả**: web Next.js + PostgreSQL +
   Redis + các worker — official docs xác nhận nhiều service/project và managed
   Postgres/Redis. Giảm tối đa độ phức tạp cho người không chuyên code.
2. **HTTPS public domain tức thì** (`.railway.app`) — đủ cho Microsoft OAuth callback
   và Graph webhook mà không cần cấu hình DNS phức tạp ngay.
3. **Long-running worker** chạy như service riêng từ **cùng repo** với start command
   tùy biến → dùng thẳng `worker:email` / `worker:delta` / `worker:renewal` đã có,
   **không cần sửa runtime code**.
4. **Logs / restart / rollback** tập trung trong một dashboard.

**Phương án dự phòng: Render.** Đáp ứng đầy đủ (Web Service + Background Worker +
Postgres + Key Value Redis + Logging + Rollbacks). Nếu Railway gặp vấn đề về
quota/region/giá, **chuyển sang Render gần như tương đương về mô hình**.

**Không khuyến nghị cho staging giai đoạn này: Vercel-only.** Vì worker phải tách
sang nền khác → 2 platform, khó vận hành. (Vercel vẫn là ứng viên hợp lý cho **web
production** sau này nếu chấp nhận worker chạy nơi khác — nhưng đó là quyết định
ngoài scope TASK-048.)

> Lưu ý về giá: official docs có pricing nhưng số liệu **có thể thay đổi**; report
> này **không khẳng định con số cụ thể**. TASK-049 cần xem pricing official tại thời
> điểm setup. Rủi ro cost ghi ở §7.

## 5. Kiến trúc staging tối thiểu đề xuất (trên Railway)

**Một Railway project "staging"** gồm các service sau (tất cả dùng **chung nhóm env
staging**, secret chỉ nằm trong secret manager của Railway):

```text
Railway project: verification-tool-staging
  1) web            Next.js (next build + next start)
                    -> public HTTPS domain (.railway.app hoặc custom)
                    -> phục vụ /admin, OAuth callback, Graph webhook
  2) postgres       Managed PostgreSQL (template) — RIÊNG staging
  3) redis          Managed Redis (template) — RIÊNG staging
  4) worker-email   start command: npm run worker:email   (BullMQ consumer)
  5) worker-delta   start command: npm run worker:delta   (đường dự phòng)
  6) worker-renewal start command: npm run worker:renewal (gia hạn subscription)
```

Đường đi dữ liệu giữ nguyên như `docs/STAGING_DEPLOYMENT.md` §5.2:

```text
Microsoft Graph (mail mới)
  -> webhook /api/webhooks/microsoft/mail   (đường chính, qua web service)
  -> hoặc delta polling backup (worker-delta) (đường dự phòng)
  -> email worker (worker-email): detect -> extract code -> dedupe (ProcessedMessage)
  -> Telegram sender -> TEST group (không phải group khách hàng thật)
```

Dedupe theo unique `[mailboxId, graphMessageId]` đảm bảo Telegram nhận **đúng một lần**
dù webhook và delta polling cùng thấy một message.

### 5.1. Tradeoff về số lượng worker service

- **Khuyến nghị (đầy đủ):** 3 worker service riêng (email/delta/renewal) — dùng thẳng
  npm script đã có, **mỗi worker restart/đọc log độc lập**, giữ đủ khả năng test live
  E2E ở TASK-051 (webhook + đường dự phòng + renewal). Đây là phương án rõ ràng nhất
  cho vận hành.
- **Giai đoạn đầu có thể rút gọn (tùy chọn):** chạy `worker:delta:once` /
  `worker:renewal:once` theo **lịch (cron)** thay vì always-on để tiết kiệm tài nguyên,
  giữ `worker-email` always-on. **Tradeoff:** giảm độ giống production và có thể bỏ
  sót cửa sổ test webhook-miss/renewal liên tục → **không khuyến nghị nếu mục tiêu là
  test live TASK-051**.
- **KHÔNG làm trong scope này:** gộp 3 worker vào **một process** — sẽ cần thêm một
  wrapper runtime (runtime code), nằm ngoài scope TASK-048. Nếu muốn giảm còn 1 worker
  service, cần tạo task riêng để viết runner an toàn.

## 6. Service cần tạo ở TASK-049 (checklist bàn giao)

> TASK-049 mới là nơi **tạo thật**. Dưới đây chỉ là danh sách chuẩn bị.

```text
[ ] Railway project "staging" (tách hoàn toàn khỏi production).
[ ] Service: web (Next.js, public HTTPS domain) — ghi lại domain để dùng cho OAuth/webhook.
[ ] Service: PostgreSQL managed (staging) — KHÔNG dùng/đụng production DB.
[ ] Service: Redis managed (staging) — KHÔNG dùng/đụng production Redis.
[ ] Service: worker-email   (start: npm run worker:email).
[ ] Service: worker-delta   (start: npm run worker:delta).
[ ] Service: worker-renewal (start: npm run worker:renewal).
[ ] Cấu hình nhóm biến môi trường staging trong secret manager Railway (xem §6.1).
[ ] Chạy migration đã commit bằng prisma migrate deploy (KHÔNG migrate dev) — ở TASK-049.
[ ] Telegram TEST bot + TEST group (không phải khách hàng thật).
[ ] Microsoft App Registration staging — thuộc TASK-050, chỉ tham chiếu ở đây.
[ ] Smoke test theo docs/STAGING_DEPLOYMENT.md §5.9.
```

### 6.1. Nhóm biến môi trường cần chuẩn bị (chỉ TÊN, không giá trị)

Danh sách **tên** biến đầy đủ đã có ở `docs/STAGING_DEPLOYMENT.md` §5.4 và
`deployment/staging/env.staging.example`. Theo nhóm:

- **App runtime:** nhóm biến APP/LOG (môi trường, base URL, mức log).
- **Datastore:** nhóm biến kết nối PostgreSQL và Redis của staging.
- **Queue/worker:** nhóm biến tên queue và concurrency.
- **Token encryption:** biến khóa mã hóa — **tạo mới cho staging**, không tái dùng.
- **Microsoft OAuth/Graph:** nhóm biến client/tenant/redirect/notification URL staging.
- **Telegram:** nhóm biến bot token (chỉ trong secret manager) + chat ID alert test.
- **Worker scheduling:** nhóm biến bật/tắt + chu kỳ delta polling và renewal.

> Quy tắc giữ nguyên: giá trị thật **chỉ** sống trong secret manager của Railway, không
> commit, không paste vào chat AI/log/docs.

## 7. Rủi ro vận hành còn lại

| Rủi ro | Mô tả | Giảm thiểu (cho TASK-049) |
|---|---|---|
| **Worker** | Worker là process liên tục; nếu crash/không restart → ngừng relay hoặc miss mail | Chạy worker trên Railway (có restart), giám sát qua logs + `/admin/health` |
| **Redis** | BullMQ phụ thuộc Redis; mất Redis → job dừng | Redis managed riêng staging; không trỏ vào Redis production |
| **Webhook HTTPS** | Graph yêu cầu HTTPS public; sai URL/validationToken → không nhận notification | Dùng domain HTTPS Railway; URL khớp tuyệt đối biến notification; đường dự phòng delta polling |
| **Env / secret** | Sai/thiếu env hoặc lộ secret | Chỉ đặt trong secret manager; tạo khóa mã hóa mới cho staging; không log giá trị |
| **Migration** | Áp nhầm migration hoặc dùng `migrate dev` trên staging | Chỉ `prisma migrate deploy` (đã có trong §5.7); không tạo migration ở task này |
| **Cost** | Nhiều service (web + Postgres + Redis + 3 worker) làm tăng chi phí; pricing official có thể đổi | Xem pricing official lúc setup; cân nhắc rút gọn worker theo §5.1 nếu cần; tắt service khi không test |
| **Logs / rollback** | Cần xem được lỗi và quay lại bản tốt | Railway: deploy logs theo service + rollback/redeploy deployment trước (xem §5.10 staging guide) |
| **Vận hành trên 2 PC** | Hai máy cùng push/deploy, hoặc chạy worker local trỏ vào staging → **xử lý trùng / job chạy 2 nơi** | **Worker chỉ chạy trên Railway**, không chạy worker local trỏ staging; máy local chỉ dev + git push; tránh deploy đồng thời từ 2 máy; secret chỉ ở Railway, không đồng bộ tay giữa 2 máy |

## 8. Những việc tôi KHÔNG làm

- Không deploy staging, không deploy production.
- Không tạo database/Redis/Microsoft App Registration thật.
- Không nhập/ghi secret thật; không đọc/in `.env*`.
- Không tạo migration; không thao tác production database.
- Không sửa runtime code (OAuth/Graph, worker/queue, Telegram routing, auth/permission).
- Không sửa GitHub Actions; không nới lỏng secret scan.
- Không phá routing rule đã chốt (TASK-041/044: nhiều mailbox → cùng group/topic được,
  nhưng một mailbox chỉ một destination active).
- Không mở rộng sang TASK-049/050/051.

## 9. Nguồn (chỉ official docs)

- Railway — Services: https://docs.railway.com/guides/services
- Railway — Databases (PostgreSQL, Redis): https://docs.railway.com/reference/databases
- Railway — Public Networking (HTTPS domain): https://docs.railway.com/guides/public-networking
- Render — Documentation (Web Services, Background Workers, Postgres, Key Value, Logging, Rollbacks): https://render.com/docs
- Vercel — Functions: Configuring Maximum Duration: https://vercel.com/docs/functions/configuring-functions/duration
- Vercel — Functions: Limitations: https://vercel.com/docs/functions/limitations
- Microsoft — App Registration / Graph (tham chiếu nội bộ): `docs/MICROSOFT_SETUP.md`

## 10. Phần cần Gemini review kỹ

- Quyết định **Railway** có hợp lý với Next.js + PostgreSQL + Redis + BullMQ + 3
  long-running worker + webhook HTTPS không; so sánh 3 platform có **trung lập** không.
- Kiến trúc §5 (1 web + 1 Postgres + 1 Redis + 3 worker) và tradeoff §5.1 có phù hợp
  người không chuyên code, có giữ đủ khả năng test live ở TASK-051 không.
- Rủi ro **vận hành trên 2 PC** (§7) đã đủ rõ để tránh worker chạy trùng chưa.
- Không có secret/token/chat ID/credential thật trong report (chỉ **tên/nhóm** biến).
- Không mở rộng sang TASK-049/050/051; không sửa runtime code; không tạo migration.
- Kết luận PASS/FAIL theo `GEMINI.md`.
