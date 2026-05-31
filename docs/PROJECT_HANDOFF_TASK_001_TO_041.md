# PROJECT HANDOFF — TASK-001 TO TASK-041

> Tài liệu bàn giao tổng hợp toàn bộ tiến độ dự án từ TASK-001 đến TASK-041.
> Mục đích: upload sang một ChatGPT Project mới để AI ở đó hiểu đầy đủ bối cảnh,
> kiến trúc, quy trình và luật bảo mật trước khi tiếp tục từ TASK-042.
>
> **Lưu ý bảo mật khi đọc file này:** Tài liệu KHÔNG chứa token, refresh token,
> client secret, bot token, verification code thật, full email body hay dữ liệu
> khách hàng thật. Khi nhắc tới biến môi trường, chỉ ghi TÊN biến, không ghi giá trị.

---

## 1. Project name

**Verification Code Relay Tool**

Tool giúp agency tự động nhận email chứa mã xác minh (verification code), nhận diện
email Facebook/Meta, trích xuất mã, và relay mã đó vào đúng Telegram group/topic của
từng khách hàng.

---

## 2. Current status

- **Tiến độ:** Hoàn thành tới **TASK-041** (Sprint 0 → Sprint 9 + TASK-041).
- **Branch hiện tại:** nhánh feature của TASK-041 (flexible Telegram routing). Tên nhánh
  chính xác kiểm tra trực tiếp bằng `git branch --show-current`.
- **Main branch (dùng làm base cho PR):** nhánh base của Sprint 0 (quality gates). Xác nhận
  bằng `git` / GitHub khi cần — không snapshot cứng tên nhánh ở đây vì thông tin Git là động.
- **Commit mới nhất:** xem trực tiếp bằng `git log --oneline --decorate -n 10`. Tại thời điểm
  bàn giao, đỉnh nhánh là các commit: "add logs index page", "wire mock email processing to
  Telegram", "avoid false positive in MVP acceptance report", "support shared Telegram group
  topic routing" (lõi TASK-041), "add MVP acceptance review" (TASK-040).
- **GitHub push status:** nhánh TASK-041 đã được push lên GitHub và có remote tracking ở commit
  mới nhất; working tree sạch. Trạng thái cập nhật kiểm tra bằng `git status` / `git log` /
  GitHub khi cần.
- **`npm run verify` status:** Đã chạy lại trên branch hiện tại → **PASS** (exit 0): lint +
  typecheck OK, **684/684 test pass (56 test files)**, Next production build thành công. (Bản
  MVP review trước đó ghi 670 test; số tăng do 2 commit thêm sau review.)

---

## 3. Product goal

Xây dựng tool cho agency:

- Tự động nhận email chứa mã xác minh từ mailbox khách hàng (mục tiêu cuối:
  Hotmail/Outlook qua Microsoft Graph).
- Nhận diện email verification của Facebook/Meta.
- Trích xuất chính xác mã xác minh.
- Gửi mã vào đúng Telegram group/topic của từng khách hàng.
- Có trang log/audit để theo dõi email nào đã xử lý, mã nào đã gửi, thành công/thất bại.

Người dùng chính: admin nội bộ agency, nhân sự vận hành, và khách hàng (nhận mã qua
Telegram group).

---

## 4. MVP core flow

```text
Email (mock hoặc Microsoft Graph)
   │
   ▼
Webhook receiver  ─┐
                   ├─►  Queue (BullMQ + Redis)  ─►  Email worker pipeline
Delta polling     ─┘                                      │
(backup worker)                                           ▼
                                          Facebook/Meta detector
                                                          │
                                                          ▼
                                              Code extractor (masked)
                                                          │
                                                          ▼
                                   Deduplication (unique [mailboxId, graphMessageId])
                                                          │
                                                          ▼
                          Resolve Telegram destination theo mailbox
                                                          │
                                                          ▼
                          Telegram sender (+ message_thread_id nếu có topic)
                                                          │
                                                          ▼
                              Code event log + Audit log + Health/Alert
```

Nguyên tắc: webhook là path chính, delta polling là backup; cả hai phải dedup để
mỗi message chỉ relay đúng **một lần**.

---

## 5. Completed task summary

### Sprint 0 — Foundation & quality gates

#### TASK-001: Khởi tạo project foundation
- Mục tiêu: Nền móng Next.js + TypeScript cho các task sau.
- Kết quả: Project chạy local, có build/lint, trang mặc định, không secret trong code.
- File/module: `app/`, `components/`, `lib/`, `services/`, `tests/`, `docs/`, `scripts/`

#### TASK-002: Setup lint/typecheck/test/build/verify
- Mục tiêu: Hệ thống quality gates.
- Kết quả: npm scripts `lint` (eslint), `typecheck` (tsc), `test` (vitest), `build` (next), `verify` (chạy tất cả).
- File/module: `.eslintrc.json`, `package.json`, `.github/workflows/ci.yml`

#### TASK-003: Environment config & secret safety
- Mục tiêu: Bảo mật config trước khi làm OAuth/Telegram/DB thật.
- Kết quả: `.env.example` (placeholder), env validation, secret masking, safe logger, test bảo mật, `docs/SECURITY_RULES.md`.
- File/module: `lib/env.ts`, `lib/env.schema.ts`, `lib/security/redact.ts`, `lib/logger.ts`

#### TASK-004: Database ORM & initial schema
- Mục tiêu: Prisma ORM + schema ban đầu.
- Kết quả: Schema User/Customer/Mailbox/TelegramMapping/GraphSubscription/ProcessedMessage/AuditLog; chỉ lưu hash/encrypted token.
- File/module: `prisma/schema.prisma`, `lib/prisma.ts`

### Sprint 1 — Admin shell & access control

#### TASK-005: Admin layout cơ bản
- Mục tiêu: Khung admin dashboard.
- Kết quả: Route `/admin` với sidebar (Customers, Mailboxes, Telegram, Logs, Health) + topbar.
- File/module: `app/admin/`, `components/layout/AdminShell.tsx`, `AdminSidebar.tsx`, `AdminTopbar.tsx`

#### TASK-006: Authentication/admin role skeleton
- Mục tiêu: Khung auth + RBAC tối thiểu.
- Kết quả: Roles (OWNER/ADMIN/STAFF_READ_ONLY), permission constants, route protection `/admin`, trang `/login`.
- File/module: `lib/auth/roles.ts`, `permissions.ts`, `session.ts`, `guards.ts`, `app/login/page.tsx`

#### TASK-007: Customer management tối giản
- Mục tiêu: Màn hình quản lý khách hàng.
- Kết quả: `/admin/customers` list/create/edit, form validation, service layer.
- File/module: `app/admin/customers/*`, `services/customers/`, `components/forms/CustomerForm.tsx`, `components/tables/CustomersTable.tsx`

### Sprint 2 — Telegram validation

#### TASK-008: Telegram bot config & test-send service
- Mục tiêu: Nền tảng gửi Telegram từ backend.
- Kết quả: Telegram sender service, API `POST /api/telegram/test-send`, validate chatId/text, không log token.
- File/module: `services/telegram/telegram-sender.service.ts`, `app/api/telegram/test-send/route.ts`

#### TASK-009: Telegram mapping module
- Mục tiêu: Quản lý mapping mailbox → Telegram group.
- Kết quả: Service CRUD mapping, API routes, trang `/admin/telegram`, form/table UI.
- File/module: `services/telegram/telegram-mapping.service.ts`, `app/api/telegram/mappings/*`, `app/admin/telegram/`

### Sprint 3 — Parser & mock flow

#### TASK-010: Mock email input
- Mục tiêu: Mô phỏng email nhận từ Graph.
- Kết quả: Mock email shape, trang `/admin/mock-email`, API route, fixture sample.
- File/module: `app/admin/mock-email/`, `app/api/mock-email/route.ts`, `tests/fixtures/email-samples/`

#### TASK-011: Facebook/Meta verification detector
- Mục tiêu: Phát hiện email verification của Facebook/Meta.
- Kết quả: Service trả confidence/matched signals/warnings; không return full code; unit test +/-.
- File/module: `services/email/facebook-detector.service.ts`

#### TASK-012: Code extractor module
- Mục tiêu: Trích xuất mã từ email đã được detector chấp nhận.
- Kết quả: Service trả code/maskedCode/confidence/candidates; không lấy bừa số đầu tiên.
- File/module: `services/email/code-extractor.service.ts`

#### TASK-013: Processed message & deduplication service
- Mục tiêu: Chống gửi trùng.
- Kết quả: Dedup theo graphMessageId/internetMessageId/codeHash; không lưu full code.
- File/module: `services/email/deduplication.service.ts`, `services/email/prisma-processed-message-store.ts`

#### TASK-014: Kết nối mock flow end-to-end
- Mục tiêu: Nối detect → extract → dedupe → Telegram.
- Kết quả: Email processing service điều phối toàn bộ flow, trả `EmailProcessingResult`; không log full code.
- File/module: `services/email/email-processing.service.ts`

### Sprint 4 — Logs & audit

#### TASK-015: Code event log page
- Mục tiêu: Trang xem log xử lý verification code.
- Kết quả: `/admin/logs/code-events`, service trả data an toàn (maskedCode), summary cards.
- File/module: `app/admin/logs/code-events/`, `services/logs/code-event-log.service.ts`, `components/tables/CodeEventLogTable.tsx`

#### TASK-016: Audit log service & page
- Mục tiêu: Truy vết hành động hệ thống.
- Kết quả: Audit log service, `/admin/logs/audit`, sanitize metadata, filter/search.
- File/module: `services/logs/audit-log.service.ts`, `app/admin/logs/audit/`, `services/logs/prisma-audit-log-store.ts`

### Sprint 5 — Microsoft OAuth validation

#### TASK-017: Microsoft App Registration checklist & config
- Mục tiêu: Tài liệu + chuẩn bị cấu hình OAuth.
- Kết quả: `docs/MICROSOFT_SETUP.md`, cập nhật `.env.example` (placeholder Microsoft vars), env validation.
- File/module: `docs/MICROSOFT_SETUP.md`, `.env.example`, `lib/env.ts`

#### TASK-018: Microsoft OAuth connect URL
- Mục tiêu: Sinh authorization URL.
- Kết quả: Service build connect URL, API `POST /api/mailboxes/connect-url`, state random chống CSRF.
- File/module: `services/microsoft/oauth-connect-url.service.ts`, `app/api/mailboxes/connect-url/route.ts`

#### TASK-019: Microsoft OAuth callback
- Mục tiêu: Nhận code, đổi access/refresh token.
- Kết quả: Route `GET /api/microsoft/oauth/callback`, validate state, token exchange; không trả token ra browser.
- File/module: `app/api/microsoft/oauth/callback/route.ts`, `services/microsoft/oauth-token-exchange.service.ts`

#### TASK-020: Token encryption service
- Mục tiêu: Mã hóa/giải mã OAuth token trước khi lưu DB.
- Kết quả: AES-256-GCM, validate `ENCRYPTION_KEY`, không log token; unit test round-trip/sai key/malformed.
- File/module: `lib/security/encryption.ts`, `tests/security/encryption.test.ts`

#### TASK-021: Lưu mailbox sau OAuth connect
- Mục tiêu: Lưu mailbox + refresh token đã encrypt.
- Kết quả: Upsert mailbox status ACTIVE, refresh token encrypt, audit log MAILBOX_CONNECTED.
- File/module: `services/microsoft/mailbox-connect.service.ts`, OAuth callback route

#### TASK-022: Microsoft Graph mail service (read Inbox test)
- Mục tiêu: Gọi Graph API đọc Inbox/message detail.
- Kết quả: `listInboxMessages` / `getMessageById`, unit test mock Graph, endpoint test thủ công.
- File/module: `services/microsoft/graph-mail.service.ts`, `app/api/mailboxes/[id]/inbox-test/route.ts`

### Sprint 6 — Microsoft webhook & worker

#### TASK-023: Graph subscription service
- Mục tiêu: Tạo/quản lý Graph subscription cho Inbox.
- Kết quả: `createInboxSubscription`, clientState random, lưu `clientStateHash`; renew/delete.
- File/module: `services/microsoft/graph-subscription.service.ts`, model `GraphSubscription`

#### TASK-024: Microsoft webhook verification endpoint
- Mục tiêu: Xử lý validationToken khi Microsoft verify URL.
- Kết quả: `POST /api/webhooks/microsoft/mail` trả validationToken plain text HTTP 200.
- File/module: `app/api/webhooks/microsoft/mail/route.ts`

#### TASK-025: Webhook notification receiver thật
- Mục tiêu: Xử lý notification payload thật, validate clientState, không xử lý nặng.
- Kết quả: Nhận `{ value: [...] }`, validate clientState, trả `202 Accepted` (accepted/skipped count).
- File/module: `app/api/webhooks/microsoft/mail/route.ts`, `services/microsoft/webhook-notification.service.ts`

#### TASK-026: Queue & worker foundation
- Mục tiêu: BullMQ + Redis foundation.
- Kết quả: Job types, enqueue, worker entry, job options (retry/backoff); không connect Redis khi import.
- File/module: `services/queue/redis-connection.ts`, `email-job.types.ts`, `email-queue.ts`, `workers/email-worker.ts`

#### TASK-027: Email worker pipeline
- Mục tiêu: Worker xử lý Graph message → detector → extractor → dedup → Telegram.
- Kết quả: Pipeline tích hợp, ghi processed message + logs an toàn.
- File/module: `services/email/graph-message-pipeline.service.ts`, `services/queue/workers/email-worker.ts`

### Sprint 7 — Mailbox dashboard

#### TASK-028: Mailbox list page
- Mục tiêu: `/admin/mailboxes` xem danh sách mailbox.
- Kết quả: Bảng mailbox với status, Telegram mapping, subscription; empty state.
- File/module: `app/admin/mailboxes/page.tsx`, `services/microsoft/mailbox-list.service.ts`, status badges

#### TASK-029: Mailbox detail page
- Mục tiêu: `/admin/mailboxes/[id]` xem chi tiết.
- Kết quả: Mailbox info, Telegram mapping, subscription, recent processing.
- File/module: `app/admin/mailboxes/[id]/page.tsx`, `services/microsoft/mailbox-detail.service.ts`

#### TASK-030: Connect mailbox UI
- Mục tiêu: Nâng cấp UI connect (đã làm một phần sớm ở TASK-026).
- Kết quả: Connect button với loading/error state, tái sử dụng OAuth URL endpoint.
- File/module: `components/admin/ConnectMailboxButton.tsx`, `app/admin/mailboxes/page.tsx`

### Sprint 8 — Reliability

#### TASK-031: Delta polling backup worker
- Mục tiêu: Worker polling Graph delta làm backup cho webhook.
- Kết quả: Poll mailbox ACTIVE, lưu delta cursor per mailbox, bootstrap lần đầu không gửi email cũ, enqueue message mới.
- File/module: `services/microsoft/delta-polling.service.ts`, `services/queue/workers/delta-polling-runner.ts`, Mailbox delta fields

#### TASK-032: Subscription renewal worker
- Mục tiêu: Gia hạn subscription trước khi hết hạn.
- Kết quả: Renew khi còn ≤ window (default 24h), update expiration/lastRenewedAt, xử lý lỗi token/transient.
- File/module: `services/microsoft/subscription-renewal.service.ts`, `services/queue/workers/subscription-renewal-runner.ts`

#### TASK-033: Telegram retry & failure handling
- Mục tiêu: Retry/backoff cho Telegram sendMessage.
- Kết quả: Phân loại retryable (429/5xx) vs non-retryable (400/401/403/404), ghi failure status rõ.
- File/module: `services/telegram/telegram-retry.service.ts`, `telegram-sender.service.ts`, `telegram-error.ts`

#### TASK-034: Health dashboard
- Mục tiêu: `/admin/health` kiểm tra vận hành.
- Kết quả: Overview cards, mailbox health per mailbox, operational checks (worker/polling/renewal/Telegram).
- File/module: `app/admin/health/page.tsx`, `services/health/health.service.ts`, `health.types.ts`

#### TASK-035: Alert service
- Mục tiêu: Cảnh báo Telegram cho admin khi lỗi nghiêm trọng.
- Kết quả: Alert types (TOKEN_REFRESH_FAILED, SUBSCRIPTION_RENEW_FAILED, TELEGRAM_SEND_FAILED…), cooldown, gửi vào admin Telegram chat.
- File/module: `services/alerts/alert.service.ts`, `alert-sanitizer.ts`, `alert-message.ts`, `alert.types.ts`

### Sprint 9 — Security & staging readiness

#### TASK-036: Security hardening review
- Mục tiêu: Rà soát rủi ro + hardening.
- Kết quả: `docs/reports/security-review.md` (PASS, không còn Critical/High). Fix: token rotation lưu refresh token mới nếu Microsoft trả về; delta polling bootstrap giới hạn thời gian (`receivedDateTime` filter, default lookback 24h).
- File/module: `docs/reports/security-review.md`, `services/microsoft/refresh-token-rotation.service.ts`, `delta-polling.service.ts`

#### TASK-037: E2E test cho mock flow
- Mục tiêu: E2E mock email → detector → extractor → Telegram → logs.
- Kết quả: Happy path, dedupe, non-verification case; mock Telegram sender; không log secret/code.
- File/module: `tests/e2e/mock-flow.spec.ts`, `tests/fixtures/email-samples/*`

#### TASK-038: E2E test cho Microsoft test mailbox
- Mục tiêu: E2E luồng thật webhook/delta → pipeline → Telegram.
- Kết quả: Test webhook path, delta polling path, duplicate case (webhook+polling cùng graphMessageId chỉ gửi 1 lần). Có manual checklist cho mailbox thật (**Result table chưa điền** — xem §10).
- File/module: `tests/e2e/microsoft-test-mailbox.spec.ts`, `docs/reports/TASK-038-microsoft-test-mailbox-manual-checklist.md`

#### TASK-039: Staging deployment setup
- Mục tiêu: Tài liệu + cấu hình mẫu deploy staging.
- Kết quả: `docs/STAGING_DEPLOYMENT.md`, checklist Microsoft/Telegram/DB/worker, smoke-test, rollback plan; placeholder env staging.
- File/module: `docs/STAGING_DEPLOYMENT.md`, `deployment/staging/README.md`, `deployment/staging/env.staging.example`

#### TASK-040 (Preflight): Operational readiness
- Mục tiêu: Xử lý blocker vận hành trước MVP review.
- Kết quả: Staging admin login, email worker runner thật, token rotation consistency, audit/code event logs lưu DB, health dashboard runtime signals.
- File/module: `lib/auth/staging-session.ts`, `app/api/auth/staging-login/route.ts`, `scripts/run-email-worker.ts`, migration `task040_log_persistence`

#### TASK-040: MVP acceptance review
- Mục tiêu: Nghiệm thu MVP.
- Kết quả: `docs/reports/mvp-acceptance-review.md` → **CONDITIONAL PASS** (code/test xong; còn confirm vận hành live). 670/670 test pass, build OK.
- File/module: `docs/reports/mvp-acceptance-review.md`

### TASK-041

#### TASK-041: Flexible Telegram routing (many mailboxes → one group/topic)
- Mục tiêu: Cho phép NHIỀU mailbox cùng gửi code vào CÙNG MỘT Telegram group, và cùng một topic trong group.
- Kết quả:
  - Schema: `telegramThreadId` + `telegramTopicName` optional thêm vào `TelegramMapping`.
    **Không** có unique trên `telegramChatId` hay `[telegramChatId, telegramThreadId]` (nhiều mailbox dùng chung là hợp lệ). Vẫn giữ `@@unique([mailboxId, telegramChatId])` để 1 mailbox không trùng row tới cùng chat.
  - Sender truyền `message_thread_id` khi mapping có `telegramThreadId`; gửi group thường khi không có.
  - Mỗi mailbox vẫn chỉ resolve **một** active destination chính (chưa làm 1 mailbox → nhiều destination).
  - Test-send hỗ trợ cả group và topic.
- File/module: `prisma/schema.prisma` + migration `task041_telegram_topic_routing`, `services/telegram/telegram-mapping.service.ts`, `telegram-sender.service.ts`, `components/forms/TelegramMappingForm.tsx`, `components/tables/TelegramMappingTable.tsx`

---

## 6. Current architecture

- **Next.js (app router) + admin UI:** Tất cả UI nằm dưới `app/admin/*` (customers,
  mailboxes, telegram, logs, health, mock-email). `app/login` cho staging admin login.
  Server components đọc qua service layer.
- **API routes:** `app/api/*` — telegram mappings/test-send, mailboxes connect-url +
  inbox-test, microsoft oauth callback, webhooks/microsoft/mail, mock-email, auth
  staging login/logout.
- **Prisma / database (PostgreSQL):** `prisma/schema.prisma`. Models: User, Customer,
  Mailbox, TelegramMapping, GraphSubscription, ProcessedMessage, AuditLog, CodeEvent.
  4 migrations (init → delta polling fields → log persistence → telegram topic routing).
- **Microsoft OAuth/Graph:** `services/microsoft/*` — connect URL, token exchange,
  refresh access token + rotation, graph mail, graph subscription, mailbox connect/
  list/detail, profile. Refresh token luôn encrypt at rest (AES-256-GCM).
- **Webhook:** `app/api/webhooks/microsoft/mail/route.ts` + `webhook-notification.service.ts`.
  Validate clientState bằng hash; verification token cho handshake; xử lý nhẹ rồi enqueue.
- **Delta polling:** `services/microsoft/delta-polling.service.ts` + delta runner —
  backup cho webhook, lưu opaque `microsoftDeltaCursor` (deltaLink) per mailbox.
- **Email processing:** `services/email/*` — facebook detector, code extractor,
  deduplication, email-processing orchestrator, graph-message-pipeline.
- **Queue/worker:** `services/queue/*` (BullMQ + Redis) — email queue, delta polling
  queue, workers + runners trong `scripts/run-*-worker.ts`.
- **Telegram sender/routing:** `services/telegram/*` — sender (+ retry), mapping
  service, error classification. Topic routing qua `message_thread_id` (TASK-041).
- **Logs/audit:** `services/logs/*` — audit log + code event log, có prisma store
  (persist DB để Web process và worker process đọc/ghi cùng store).
- **Health/alert:** `services/health/*` (health dashboard signals) + `services/alerts/*`
  (alert service, sanitizer, cooldown).
- **Tests/CI:** Vitest (`tests/unit`, `tests/api`, `tests/security`, `tests/db`,
  `tests/e2e`). CI ở `.github/workflows/ci.yml` chạy secret-grep + `npm run verify`.

---

## 7. Important directories and files

| Đường dẫn | Vai trò |
|---|---|
| `docs/PRODUCT_SPEC.md` | Mục tiêu sản phẩm, MVP scope, tiêu chí nghiệm thu |
| `docs/ARCHITECTURE.md` | Kiến trúc MVP, công nghệ, nguyên tắc |
| `docs/SECURITY_RULES.md` | Luật bảo mật bắt buộc (source of truth) |
| `docs/ROADMAP.md` | Sprint 0–9 + danh sách task |
| `docs/MICROSOFT_SETUP.md` | Hướng dẫn Microsoft App Registration / OAuth |
| `docs/STAGING_DEPLOYMENT.md` | Setup deploy staging, smoke-test, rollback |
| `docs/tasks/TASK-0XX-*.md` | Task spec từng task (001–041) |
| `docs/reports/` | mvp-acceptance-review, security-review, TASK-038 checklist, gemini-ecc-review |
| `AGENTS.md` / `CLAUDE.md` / `GEMINI.md` | Vai trò & luật cho từng AI agent |
| `prisma/schema.prisma` | Database schema + comment bảo mật từng field |
| `prisma/migrations/` | 4 migrations theo thứ tự |
| `lib/security/encryption.ts` | AES-256-GCM cho token at rest |
| `lib/security/redact.ts`, `lib/logger.ts` | Masking/redaction + safe logger |
| `lib/env.ts`, `lib/env.schema.ts` | Validate env (trả result, không throw) |
| `services/microsoft/` | OAuth, Graph mail, subscription, delta polling, token rotation |
| `services/email/` | Detector, extractor, dedup, processing pipeline |
| `services/telegram/` | Sender, retry, mapping (routing + topic) |
| `services/queue/` | BullMQ queue + workers |
| `services/logs/`, `services/health/`, `services/alerts/` | Logs/audit, health, alert |
| `scripts/run-*-worker.ts` | Entry point chạy worker (email/delta/renewal) |
| `app/admin/` | Toàn bộ admin UI |
| `app/api/` | API routes + webhook |
| `.github/workflows/ci.yml` | CI: secret grep + verify |
| `.env.example` | Placeholder env (chỉ tên biến + ví dụ, KHÔNG secret thật) |

---

## 8. AI workflow

Dự án dùng nhiều AI theo dây chuyền:

| AI | Vai trò |
|---|---|
| **ChatGPT** | Planner / PM / reviewer cuối. Viết spec, chia task, giải thích, review báo cáo. KHÔNG sửa code local. |
| **Claude Code** | Coder chính. Được sửa code khi task đã rõ. Phải khai báo file sẽ sửa trước, báo cáo sau. |
| **Gemini CLI** | Reviewer/tester độc lập. Mặc định KHÔNG sửa file (chỉ sửa khi prompt có `ALLOW_GEMINI_EDIT=true`). Luôn kết luận PASS/FAIL. |
| **Cursor** | Xem project, duyệt UI, chỉnh sửa nhỏ khi user duyệt. |
| **GitHub Actions** | CI tự động (secret grep + `npm run verify`). |

**Quy tắc bắt buộc:**
- Một thời điểm chỉ **một** AI sửa code (không để Cursor agent và Claude cùng sửa).
- Claude sửa code; Gemini review/test (mặc định không sửa file).
- Mỗi task phải có **task file** trong `docs/tasks/`.
- Mỗi task phải **pass `npm run verify`**.
- Mỗi task phải **pass Gemini review** (không còn Critical/High) trước khi commit/nghiệm thu.
- Trước khi sửa: nói rõ hiểu task gì, sửa file nào, không làm gì ngoài scope, rủi ro.
- Sau khi sửa: báo đã đổi gì, file nào, lệnh kiểm tra, PASS/FAIL, cần review phần nào.

---

## 9. Security rules that must continue

Tóm tắt từ `docs/SECURITY_RULES.md` (source of truth — phải tiếp tục tuân thủ):

1. **Không commit `.env` / `.env.local`.** Chỉ `.env.example` (placeholder) được commit.
   AI không đọc/in nội dung `.env` nếu không được human cho phép có lý do.
2. **Không hardcode secret** (token, API key, password, client secret, chat ID, encryption key)
   trong code/comment/commit/PR/log.
3. **Không log token / verification code / secret.** Dùng `createLogger()` (auto-mask key
   khớp `/token|secret|password|code|key|auth/i`); dùng `maskCode()` / `maskSecret()` khi cần
   fingerprint. Không interpolate secret vào message string.
4. **Refresh token phải encrypt at rest** bằng `ENCRYPTION_KEY` (AES-256-GCM). Token rotation:
   nếu Microsoft trả refresh token mới → lưu bản encrypt mới.
5. **Verification code phải mask/hash trong log và DB.** DB chỉ lưu `codeHash` / masked code,
   không bao giờ plaintext. Code persist (nếu cần) phải có expiry.
6. **Telegram bot token chỉ ở env var**, không lưu DB (DB chỉ lưu chat ID / thread ID).
7. **Customer isolation:** mỗi mapping route đúng destination của mailbox/khách hàng tương ứng —
   không gửi nhầm sang chat của khách khác, kể cả khi retry. (TASK-041 cho phép nhiều mailbox →
   cùng group/topic một cách CÓ CHỦ ĐÍCH, nhưng vẫn resolve đúng destination active theo mailbox.)
8. **Webhook phải validate `clientState`** (so hash, không log/return clientState khi mismatch).
9. **Dedup chống gửi trùng:** `@@unique([mailboxId, graphMessageId])` + logic pipeline đảm bảo
   webhook + delta polling cùng thấy 1 message chỉ relay đúng MỘT lần.
10. **Error message UI** không chứa secret/full code/full email body.
11. **CI** phải chạy `npm run verify` + secret-pattern grep; fail CI chặn merge.

---

## 10. Known risks / areas to verify before TASK-042

Tổng hợp từ MVP acceptance review (CONDITIONAL PASS), security review, và TASK-038 checklist:

- [x] **`npm run verify` trên branch hiện tại:** ĐÃ chạy lại → PASS (684/684 test, build OK).
      Đây là verify local; vẫn cần confirm trên GitHub Actions (mục dưới).
- [ ] **GitHub Actions chưa được quan sát xanh** trên branch này (tiêu chí nghiệm thu #8).
      Cần confirm CI green sau push.
- [ ] **Gemini review của branch + report hiện tại chưa làm** (tiêu chí #7 / TASK-040 §9).
      Lưu ý: `docs/reports/gemini-ecc-review.md` là review CŨ của TASK-001, không phải review hiện tại.
- [ ] **TASK-038 manual checklist chưa điền Result:** chưa chạy live round-trip trên mailbox/
      group thật:
      - Webhook path: email thật → webhook → enqueue → worker → Telegram → `ProcessedMessage status=SENT`.
      - Delta polling path: gửi đúng một lần, cursor advance, `deltaLastErrorAt` null.
      - **Duplicate case (CRITICAL):** webhook + delta cùng thấy 1 message → Telegram chỉ nhận
        ĐÚNG 1 lần (kiểm chứng `@@unique([mailboxId, graphMessageId])`).
      - Security spot-check: log không có full code/token; DB không có plaintext code.
- [ ] **Many mailboxes → one group/topic (TASK-041):** xác nhận test phủ đủ — hai mailbox dùng
      chung `telegramChatId`, dùng chung `telegramChatId + telegramThreadId`, sender truyền
      `message_thread_id` đúng khi có topic và không truyền khi không có, mailbox không có mapping
      active thì không gửi. Đảm bảo không gửi nhầm destination.
- [ ] **Delta polling source label (LOW):** cả webhook và delta path đang set `source: 'webhook'`
      trên job pipeline (vô hại về chức năng, nhưng mất observability nguồn gốc). Cân nhắc fix nhỏ.
- [ ] **Token rotation edge case:** refresh token mới persist OK, nhưng nếu worker offline trước khi
      dùng → token cycle này vẫn valid; xác nhận handling non-fatal vẫn đúng.
- [ ] **Staging/production env:** xem `docs/STAGING_DEPLOYMENT.md` §env — cần set đầy đủ biến
      (xem danh sách §"env variable names" bên dưới), HTTPS bắt buộc (cookie `secure`),
      chạy `npx prisma migrate deploy` trước nghiệm thu; live smoke-test chưa chạy.
- [ ] **Deferred (Low) từ security review:** L-1 production CSP/security headers (HSTS,
      X-Content-Type-Options…); L-2 mở rộng CI secret grep; L-3 alert khi rotation-persist fail.
- [ ] **Lưu ý:** `.env.example` hiện chứa một giá trị `ENCRYPTION_KEY` mẫu commit sẵn (dùng cho
      local dev). Đảm bảo staging/production dùng key riêng trong secret manager, KHÔNG dùng lại
      giá trị mẫu này.

**Env variable names (chỉ tên, KHÔNG giá trị):** `APP_ENV`, `APP_URL`, `LOG_LEVEL`,
`DATABASE_URL`, `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`, `MICROSOFT_TENANT_ID`,
`MICROSOFT_REDIRECT_URI`, `MICROSOFT_GRAPH_NOTIFICATION_URL`,
`MICROSOFT_GRAPH_LIFECYCLE_NOTIFICATION_URL`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_ADMIN_ALERT_CHAT_ID`, `ENCRYPTION_KEY`, `AUTH_DEV_DEMO_USER`,
`STAGING_ADMIN_PASSWORD`, `STAGING_ADMIN_SESSION_SECRET`, `REDIS_URL`, `EMAIL_QUEUE_NAME`,
`EMAIL_WORKER_CONCURRENCY`, `DELTA_POLLING_ENABLED`, `DELTA_POLLING_INTERVAL_SECONDS`,
`DELTA_POLLING_MAX_PAGES_PER_MAILBOX`, `SUBSCRIPTION_RENEWAL_ENABLED`,
`SUBSCRIPTION_RENEWAL_INTERVAL_SECONDS`, `SUBSCRIPTION_RENEWAL_WINDOW_HOURS`.

---

## 11. Recommended next step (cách bắt đầu TASK-042)

1. **Không code ngay.** Trước hết xử lý các mục còn treo ở §10 (verify xanh, CI green,
   Gemini review, TASK-038 live checklist) để chốt MVP từ CONDITIONAL PASS → PASS.
2. **Cập nhật `docs/ROADMAP.md`** nếu TASK-042 mở scope mới (ví dụ: 1 mailbox → nhiều
   destination, multi-platform, production deploy…).
3. **Tạo task file** `docs/tasks/TASK-042-<slug>.md` theo cấu trúc các task hiện có
   (Mục tiêu / Bối cảnh / Scope được làm / Scope KHÔNG làm / Yêu cầu chức năng / Bảo mật /
   DB / Service / Tests / Lệnh kiểm tra / Tiêu chí nghiệm thu / Format báo cáo).
4. **Tạo nhánh Git mới** cho TASK-042 theo quy ước đặt tên nhánh của repo (tiền tố `feature/`
   + mã task + mô tả ngắn), base từ nhánh hiện tại hoặc theo quy ước repo.
5. **Cho Claude làm đúng scope:** khai báo file sẽ sửa trước, không vượt scope, chạy
   `npm run verify` sau khi sửa.
6. **Cho Gemini review** (PASS/FAIL, không còn Critical/High) trước khi commit/nghiệm thu.

---

## 12. How to use this file in a new ChatGPT Project

Tạo một ChatGPT Project mới, upload file này (`docs/PROJECT_HANDOFF_TASK_001_TO_041.md`),
rồi dán prompt mẫu sau:

```text
Bạn là ChatGPT đóng vai Planner / Product Manager cho dự án
"Verification Code Relay Tool".

Tôi đã upload file PROJECT_HANDOFF_TASK_001_TO_041.md mô tả toàn bộ bối cảnh,
kiến trúc, tiến độ (TASK-001 → TASK-041), AI workflow và luật bảo mật.

Hãy đọc kỹ file đó trước khi trả lời. Quy tắc khi làm việc:
- Bạn KHÔNG sửa code local. Claude Code là coder chính; Gemini CLI là reviewer/tester.
- Một thời điểm chỉ một AI sửa code.
- Mọi đề xuất phải tôn trọng docs/SECURITY_RULES.md: không hardcode secret,
  không log token/verification code, refresh token phải encrypt, customer isolation,
  webhook validate clientState, dedup chống gửi trùng.
- Mỗi task mới phải có task file trong docs/tasks/, pass `npm run verify`,
  và pass Gemini review trước khi nghiệm thu.

Việc đầu tiên tôi cần bạn giúp: dựa trên mục "Known risks" và "Recommended next step"
trong file handoff, đề xuất nội dung cho TASK-042 (mục tiêu, scope được làm,
scope KHÔNG làm, tiêu chí nghiệm thu). Chưa viết code — chỉ lập kế hoạch.
```
