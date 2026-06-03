\# ROADMAP.md



\## Sprint 0 — Foundation \& quality gates



\- TASK-001: Khởi tạo project foundation

\- TASK-002: Setup lint/typecheck/test/build/verify

\- TASK-003: Setup environment config \& secret safety

\- TASK-004: Setup database ORM \& initial schema



\## Sprint 1 — Admin shell \& access control



\- TASK-005: Tạo admin layout cơ bản

\- TASK-006: Tạo authentication/admin role skeleton

\- TASK-007: Tạo customer management tối giản



\## Sprint 2 — Telegram validation



\- TASK-008: Setup Telegram bot config \& test-send service

\- TASK-009: Tạo Telegram mapping module



\## Sprint 3 — Parser \& mock flow



\- TASK-010: Tạo mock email input

\- TASK-011: Tạo Facebook/Meta verification detector

\- TASK-012: Tạo code extractor module

\- TASK-013: Tạo processed message \& deduplication service

\- TASK-014: Kết nối mock flow: mock email → detect → extract → dedupe → Telegram



\## Sprint 4 — Logs \& audit



\- TASK-015: Tạo code event log page

\- TASK-016: Tạo audit log service \& page



\## Sprint 5 — Microsoft OAuth validation



\- TASK-017: Tạo Microsoft App Registration checklist \& config

\- TASK-018: Tạo Microsoft OAuth connect URL

\- TASK-019: Tạo Microsoft OAuth callback

\- TASK-020: Tạo token encryption service

\- TASK-021: Lưu mailbox sau OAuth connect

\- TASK-022: Tạo Microsoft Graph mail service: read Inbox test



\## Sprint 6 — Microsoft webhook \& worker



\- TASK-023: Tạo Graph subscription service

\- TASK-024: Tạo Microsoft webhook verification endpoint

\- TASK-025: Tạo webhook receiver cho notification thật

\- TASK-026: Setup queue \& worker foundation

\- TASK-027: Worker xử lý Graph message → detector → extractor → Telegram



\## Sprint 7 — Mailbox dashboard



\- TASK-028: Tạo mailbox list page

\- TASK-029: Tạo mailbox detail page

\- TASK-030: Tạo connect mailbox UI ( (Đã làm sớm một phần ở TASK-026 để test luồng: Nút Connect & Banner lỗi
     tại Admin Dashboard). Khi tới Sprint 7 chỉ cần review và tinh chỉnh nếu cần.)



\## Sprint 8 — Reliability



\- TASK-031: Tạo delta polling backup worker

\- TASK-032: Tạo subscription renewal worker

\- TASK-033: Tạo Telegram retry \& failure handling

\- TASK-034: Tạo health dashboard
  - Note from TASK-031: verify production email-worker is wired to a real pipeline (createEmailWorker hiện default chỉ là type-only cast, không thực sự chạy production) và surface trạng thái qua dashboard / operational check.

\- TASK-035: Tạo alert service



\## Sprint 9 — Security \& staging readiness



\- TASK-036: Security hardening review
lưu ý:   - Tối ưu hóa Delta Polling: Hỗ trợ bootstrap mailbox cực lớn (dùng $filter thời gian hoặc tăng max pages cho
      lần chạy đầu).
    5   - Sửa lỗi Token Rotation: Đảm bảo service cấp mới Access Token (ví dụ `refresh-access-token.service.ts`) có
      lưu lại Refresh Token mới xuống database nếu Microsoft trả về (hiện tại có rủi ro mất token nếu bị cấp mới).

\- TASK-037: E2E test cho mock flow

\- TASK-038: E2E test cho Microsoft test mailbox
  - Note from TASK-031: cover trường hợp webhook + delta polling cùng thấy 1 graphMessageId — Telegram phải nhận đúng 1 lần (dựa vào ProcessedMessage unique [mailboxId, graphMessageId]).

\- TASK-039: Staging deployment setup
\- TASK-040 Preflight: Operational Readiness Before MVP Acceptance Review

\- TASK-040: MVP acceptance review
\- TASK-041-flexible-telegram-routing.md

## Nguyên tắc bắt buộc cho toàn bộ lộ trình internal production (Sprint 10 → 15)

Các nguyên tắc sau áp dụng cho **mọi** task từ TASK-042 đến TASK-061:

1. **Mỗi mailbox chỉ có một active Telegram group/topic destination.** Khi gửi verification
   code, mailbox resolve đúng **một** destination active của chính nó.
2. **KHÔNG làm 1 mailbox → nhiều Telegram destination.** Hướng này nằm ngoài scope toàn bộ
   lộ trình. (TASK-041 cho phép NHIỀU mailbox → CÙNG một group/topic một cách có chủ đích,
   nhưng một mailbox vẫn chỉ có một destination.)
3. **Microsoft publisher verification KHÔNG phải blocker hiện tại.** Chỉ theo dõi; chỉ xử lý
   nếu/khi consent thực tế bị chặn (ví dụ tenant yêu cầu admin consent, hoặc `AADSTS65001` /
   consent required). Tham chiếu `docs/MICROSOFT_SETUP.md`.

## Sprint 10 — Internal production readiness

- TASK-042: Internal production readiness plan
- TASK-043: Prisma Client generation hardening
- TASK-044: Confirm one-mailbox-one-destination routing rule

## Sprint 11 — Staff operation model

- TASK-045: Internal staff ownership & assignment model — done. Confirms this is an internal staff app: OWNER/ADMIN see everything; STAFF_READ_ONLY sees only customers assigned to them (and those customers' mailboxes/mappings). Customers never log in.
- TASK-046: Staff dashboard UX for high mailbox volume
- TASK-047: Safe mailbox onboarding flow

## Sprint 12 — Staging deployment

- TASK-048: Choose deployment platform & staging architecture — quyết định: Railway (khuyến nghị), Render (dự phòng), Vercel-only không phù hợp do worker long-running. Xem `docs/reports/TASK-048-choose-deployment-platform-staging-architecture.md`.
- TASK-049: Staging infrastructure setup
- TASK-050: Microsoft App Registration staging validation — done. Đã xác minh ở mức docs/checklist: App Registration staging riêng, Redirect URI + Webhook URL staging (placeholder), permission tối thiểu (Mail.Read, offline_access, User.Read), an toàn client secret. Xem `docs/tasks/TASK-050-microsoft-app-registration-staging-validation.md`, `docs/reports/TASK-050-microsoft-app-registration-staging-validation.md`. Rủi ro còn lại: chưa chạy live mailbox E2E → để TASK-051.
- TASK-051: Staging live mailbox E2E test — **pre-live staging validation pass (conditional)**. Đã PASS trên staging: login/logout, /admin/health smoke check, customer + mailbox assignment UI, Telegram mapping UI + test-send, Mock Email dropdown + Process & send to Telegram, API scope check cho mock-email process. Live Microsoft email path (webhook / delta polling / duplicate bằng email thật) **deferred** sang internal beta / product trial vì hiện chưa có email thật phù hợp. Xem `docs/reports/TASK-051-staging-live-mailbox-e2e-test.md` (mục 6 + 6.1). Trước khi chạy phần live còn lại, đọc `docs/MICROSOFT_SETUP.md`, `docs/STAGING_DEPLOYMENT.md`, và task/report TASK-050.
- TASK-052: Safe mailbox disconnect flow — done. OWNER/ADMIN có thể disconnect mailbox an toàn mà không hard delete mailbox hoặc xóa lịch sử xử lý. Mailbox disconnected không còn được poll, renew subscription, hoặc relay code. Active Telegram mapping liên quan được chuyển khỏi trạng thái active để tránh relay nhầm. Graph subscription cleanup được xử lý fail-safe: nếu remote cleanup lỗi, local state vẫn chặn relay. Xem docs/tasks/TASK-052-safe-mailbox-disconnect-flow.md và docs/reports/TASK-052-safe-mailbox-disconnect-flow.md. Rủi ro còn lại: nếu có email thật đã enqueue trước khi disconnect, worker/pipeline phải dựa vào re-check mailbox status để bỏ qua; cần tiếp tục xác minh trong internal beta/live Microsoft email test.
- TASK-053: Reusable Telegram destinations
 Reusable Telegram destinations — done. Added reusable Telegram destinations so Owner/Admin can configure a Telegram group/topic once and reuse it across mailbox mappings. Many mailboxes can share one destination, while each mailbox still has at most one active destination. Customer isolation is enforced when mapping mailbox to destination. See `docs/tasks/TASK-053-reusable-telegram-destinations.md` and related task report if created. Remaining risk: keep future mapping changes going through service-layer validation to avoid bypassing customer isolation.

## Sprint 13 — Scale readiness

- TASK-054: Scale test plan for 100–200 mailboxes per staff — done (planning artifact). Scale test plan / readiness plan an toàn cho mức 50/100/200 mailbox per staff bằng dữ liệu giả lập (mock/seed/staging fake), không live scale, không production resource, không mailbox/Telegram group khách hàng thật, không gửi code thật. Báo gồm baseline (worker concurrency mặc định 2, delta polling 30s / max 10 pages, subscription renewal 15 phút, Telegram retry 4 lần backoff 5/15/30s), test data model, scenarios A–E, metrics (queue backlog, worker latency, delta polling, Graph throttling, Telegram failure, UI, readiness), risk analysis, safe execution checklist. Nhu cầu per-mailbox/per-destination throttling & queue safety chuyển TASK-055; observability realtime chuyển TASK-056. Xem `docs/tasks/TASK-054-scale-test-plan-100-200-mailboxes.md` và `docs/reports/TASK-054-scale-test-plan-100-200-mailboxes.md`.
- TASK-055: Per-mailbox throttling & queue safety — done (minimal implementation). Thêm per-mailbox processing lock (một mailbox không xử lý Graph/Telegram song song; lease tự hết hạn; release trong finally; job bận defer có giới hạn, không retry vô hạn) và shared-destination burst guard (giãn cách gửi tới cùng group/topic bằng delay nội tuyến có giới hạn, không broadcast, không đổi routing). Mailbox disconnected skip trước Graph, mailbox chưa có active mapping hợp lệ skip trước Telegram. Giữ nguyên rule nhiều mailbox dùng chung một reusable destination và rule mỗi mailbox chỉ có một active destination; giữ customer isolation. `npm run verify` PASS; không log token/secret/full code/full email body. Xem `docs/tasks/TASK-055-per-mailbox-throttling-queue-safety.md` và `docs/reports/TASK-055-per-mailbox-throttling-queue-safety.md`. Follow-up: thêm test coverage cho graph message pipeline throttling (`tests/unit/email/graph-message-pipeline.throttling.test.ts`) bảo vệ per-mailbox lock và shared-destination throttle; Gemini review PASS, `npm run verify` PASS — đây là follow-up coverage, không mở rộng scope. Rủi ro còn lại: lock chỉ serialize trong một tiến trình worker (đa tiến trình cần lock chia sẻ qua hạ tầng ngoài), hằng số throttle/TTL còn ở mặc định trong code, và chưa xác minh tải thật với mailbox/Telegram group thật.
- TASK-056: Operational health dashboard for staff workload — done (minimal implementation). Nâng cấp `/admin/health` thành dashboard vận hành tối thiểu với customer scope enforce ở service layer: OWNER/ADMIN thấy toàn bộ, STAFF_READ_ONLY chỉ thấy mailbox của customer được phân công (mọi count/aggregate đều scope theo mailbox, fail-closed khi không có assignment), operational/infra checks toàn hệ thống chỉ hiển thị cho OWNER/ADMIN. Thêm overview cards (Ready / Needs mapping / Needs customer / …), Workload by customer, và mailbox issues table dùng chung định nghĩa readiness (mailbox disconnected không bao giờ Ready; ACTIVE thiếu mapping → Needs mapping; nhiều mailbox dùng chung reusable destination vẫn hợp lệ). Read-only, không gọi Microsoft Graph/Telegram để render; không log/hiển thị token/secret/full code/full email body. `npm run verify` PASS. Xem `docs/tasks/TASK-056-operational-health-dashboard-staff-workload.md` và `docs/reports/TASK-056-operational-health-dashboard.md`. Rủi ro/deferred còn lại: chưa có queue backlog/worker heartbeat thật (hiển thị Unknown/Degraded an toàn, không tự probe external); ngưỡng "recent issue" tạm dùng tổng Telegram fail 24h; scope đa-tiến-trình phụ thuộc baseline TASK-055.

## Sprint 14 — Production security & internal launch

- TASK-057: Production auth hardening for internal staff — done. Gemini review PASS, `npm run verify` PASS. Kết quả chính đã chốt: production fail-closed tường minh (admin access ở production luôn bị từ chối khi chưa có sign-in provider thật — không dùng demo user dev, không dùng staging passphrase login); role/userId chỉ lấy từ session đã verify server-side, không lấy từ request/cookie chưa verify; staging session cookie giữ httpOnly/secure/sameSite Lax/expiry và logout xóa đúng; RBAC OWNER/ADMIN vs STAFF_READ_ONLY và customer assignment scope vẫn enforce ở service/API layer; login page production không lộ tên biến môi trường hay cơ chế; thêm audit tối thiểu cho login/logout/access-denied (metadata an toàn). Khách hàng vẫn không có login/portal/signup. Không phá routing Telegram, disconnect guard (TASK-052), throttling/queue safety (TASK-055), health dashboard (TASK-056). Xem `docs/tasks/TASK-057-production-auth-hardening-internal-staff.md` và `docs/reports/TASK-057-production-auth-hardening-internal-staff.md`. Rủi ro còn lại: chưa có production sign-in provider thật (cố ý — admin access production khóa an toàn cho tới khi TASK-058 thêm provider); audit là best-effort nên có thể không ghi khi store không sẵn sàng nhưng luồng auth vẫn an toàn; scope đa-tiến-trình vẫn theo baseline TASK-055. Bàn giao tiếp cho TASK-058 (production environment & secret setup) rồi TASK-059 (production deployment limited internal beta).
- TASK-058: Production environment & secret setup — docs/placeholder standardization done (chưa deploy production, không tạo/dùng DB/Redis/mailbox/Telegram group thật). Chuẩn hóa danh sách biến môi trường production theo nhóm và đồng bộ giữa `.env.example`, `lib/env.schema.ts`, `deployment/staging/env.staging.example`, `docs/STAGING_DEPLOYMENT.md`; vá placeholder còn thiếu cho biến delta-polling bootstrap lookback (đã có trong code, default an toàn). Production auth vẫn fail-closed theo TASK-057 (không thêm cơ chế login production mới). Giữ nguyên internal staff app, RBAC OWNER/ADMIN vs STAFF_READ_ONLY + assignment scope, one-mailbox-one-destination, reusable destinations, disconnect guard, throttling/queue safety, health dashboard. `npm run verify` PASS. Xem `docs/tasks/TASK-058-production-environment-secret-setup.md` và `docs/reports/TASK-058-production-environment-secret-setup.md`. Còn lại: quan sát secret-hygiene về giá trị `ENCRYPTION_KEY` mẫu trong `.env.example` (đang là test fixture) được defer; chờ Gemini review trước khi chốt. Bàn giao tiếp cho TASK-059.
- TASK-059: Production deployment limited internal beta — done (Gemini review PASS, `npm run verify` PASS). Đây là **limited internal beta**, không phải full production rollout: chuẩn bị tài liệu/checklist deploy production tối thiểu (web + database + Redis + 3 worker email/delta/renewal), thêm `deployment/production/README.md` và `deployment/production/env.production.example` placeholder-only; xác minh deployment checklist chỉ dùng lệnh có thật trong `package.json` và `npx prisma migrate deploy` (không `migrate dev`). Chỉ thêm docs, không sửa runtime code. Giữ nguyên internal staff app (không public SaaS, không customer login/portal/signup, không billing/payment, không scale-up hàng loạt — scale-up để TASK-063), RBAC OWNER/ADMIN xem toàn bộ vs STAFF_READ_ONLY chỉ xem customer/mailbox được assigned, reusable Telegram destinations + rule mỗi mailbox tối đa một active destination, disconnect guard (TASK-052), throttling/queue safety (TASK-055), health dashboard (TASK-056), production auth hardening (TASK-057), production env/secret setup (TASK-058). File liên quan: `docs/tasks/TASK-059-production-deployment-limited-internal-beta.md`, `docs/reports/TASK-059-production-deployment-limited-internal-beta.md`, `deployment/production/README.md`, `deployment/production/env.production.example`. Rủi ro/blocker còn lại: production auth vẫn fail-closed vì chưa có sign-in provider production thật → staff-facing beta chưa usable qua admin UI (deploy/infra-verifiable, không bypass bằng staging/dev login); live beta với email/Telegram thật chưa chạy. Bàn giao tiếp cho TASK-060 (backup, restore & incident response).
- TASK-060: Backup, restore & incident response — done (Gemini review PASS, `npm run verify` PASS). Docs-only runbook cho **production limited internal beta**, không phải full rollout. Kết quả chính: thêm runbook gồm backup strategy tối thiểu (backup do deploy/database provider quản lý, không commit/không upload vào chat AI), restore drill an toàn vào **môi trường tách biệt** (không trỏ production web/worker vào restore-test, không bật worker, không dùng bot production, không connect mailbox thật, không gửi code thật), và incident response cho: deploy/build/migration (chỉ `prisma migrate deploy`, không `migrate dev`, không sửa DB tay), database, Redis/queue (Redis không phải nguồn dữ liệu chính — phục hồi qua database state + delta polling), worker crash hoặc worker chạy sai môi trường, Microsoft OAuth/Graph/subscription, Telegram gửi thất bại hoặc gửi nhầm destination, nghi lộ secret, verification code hoặc email body bị log nhầm, auth/session, và emergency worker shutdown **không xóa dữ liệu** (thứ tự email → delta → renewal, giữ database/Redis nguyên trạng). Chỉ thêm/sửa docs, không sửa runtime code, không sửa `.env*`, không sửa GitHub Actions; giữ nguyên internal staff app, RBAC OWNER/ADMIN vs STAFF_READ_ONLY + assignment scope, reusable destinations + rule mỗi mailbox tối đa một active destination, disconnect guard (TASK-052), throttling/queue safety (TASK-055), health dashboard (TASK-056), production auth fail-closed (TASK-057), production env/secret setup (TASK-058), limited beta guardrails (TASK-059). File liên quan: `docs/tasks/TASK-060-backup-restore-incident-response.md`, `docs/reports/TASK-060-backup-restore-incident-response.md`, `deployment/production/README.md` (thêm link ngắn tới runbook). Scope **không** gồm staff onboarding, daily operations checklist, hay full scale-up. Rủi ro/blocker còn lại: kế thừa từ TASK-059 — chưa có production sign-in provider thật nên staff beta chưa usable qua admin UI; restore drill mới ở mức hướng dẫn, chưa chạy thật. Deferred: TASK-061 (staff onboarding guide), TASK-062 (daily operations checklist), TASK-063 (production scale-up from beta to full internal use).

## Sprint 15 — Internal operations

- TASK-061: Staff onboarding guide — done (Gemini review PASS, `npm run verify` PASS). Docs-only staff onboarding guide cho **internal staff** trong limited internal beta. Guide hướng dẫn cho người không chuyên code: login expectation (production hiện fail-closed, phụ thuộc sign-in provider từ task trước), phân biệt role OWNER/ADMIN (xem toàn bộ) vs STAFF_READ_ONLY (chỉ customer/mailbox được assign), customer assignment, mailbox readiness, connect mailbox, reusable Telegram destination mapping, safe test-send, logs/health ở mức cơ bản, và khi nào báo OWNER/ADMIN. Giữ nguyên internal staff app: không customer login, không public signup, không billing/payment; nhiều mailbox dùng chung một reusable destination nhưng mỗi mailbox chỉ một active destination, không broadcast, mailbox disconnected hoặc chưa mapping hợp lệ không Ready. Chỉ thêm docs, không sửa runtime code, không sửa `.env*`, không sửa GitHub Actions. **Không** lấn sang TASK-062 (daily operations checklist) hay TASK-063 (production scale-up). File liên quan: `docs/operations/STAFF_ONBOARDING_GUIDE.md`, `docs/tasks/TASK-061-staff-onboarding-guide.md`, `docs/reports/TASK-061-staff-onboarding-guide.md`. Rủi ro còn lại: production staff-facing beta vẫn phụ thuộc trạng thái production sign-in provider từ task trước (TASK-057/TASK-059); daily routine để TASK-062; full scale-up để TASK-063.
- TASK-062: Daily operations checklist — done (Gemini review PASS, `npm run verify` PASS). Docs-only daily operations checklist cho **OWNER/ADMIN** và **STAFF_READ_ONLY** trong production limited internal beta. Checklist hướng dẫn vòng kiểm tra đầu ngày: health dashboard, mailbox readiness (xác nhận disconnected hoặc chưa mapping → không Ready), Telegram send failure, logs cơ bản, worker/queue/subscription/token signals (nếu dashboard hỗ trợ), và escalation (khi nào báo OWNER/ADMIN, khi nào OWNER/ADMIN dùng runbook TASK-060). Giữ nguyên internal staff app: không customer login, không public signup, không billing/payment; giữ rule reusable Telegram destinations + mỗi mailbox tối đa một active destination. Không thay thế incident runbook (TASK-060) và không trùng onboarding guide (TASK-061). Chỉ thêm docs, không sửa runtime code, không sửa `.env*`, không sửa GitHub Actions. File liên quan: `docs/operations/DAILY_OPERATIONS_CHECKLIST.md`, `docs/tasks/TASK-062-daily-operations-checklist.md`, `docs/reports/TASK-062-daily-operations-checklist.md`. Rủi ro còn lại: chưa chạy thử qua chu kỳ vận hành thật với email/Telegram thật. Tiếp theo: TASK-063 Production scale-up from beta to full internal use.
- TASK-063: Production scale-up from beta to full internal use — done (Gemini review PASS, `npm run verify` PASS). Docs-only planning/checklist để mở rộng production từ limited internal beta sang full internal use **theo từng giai đoạn**. Kết quả chính: định nghĩa các mức scale (Level 0 limited beta → Level 1 expanded beta → Level 2 internal scale pilot → Level 3 full internal use) với điều kiện PASS trước mỗi mức, metric cần theo dõi (health dashboard, mailbox readiness, Telegram failures, worker/queue, Graph throttling, token/subscription, latency, duplicate prevention, staff scope), và rollback criteria. Có hướng dẫn dùng lại daily operations checklist (TASK-062) làm nhịp kiểm tra trong mỗi đợt scale và incident runbook (TASK-060) khi scale gây sự cố; không thay thế hai tài liệu đó. Giữ nguyên internal staff app: không customer login, không public signup, không billing/payment; nhiều mailbox dùng chung một reusable destination nhưng mỗi mailbox chỉ tối đa một active destination, không broadcast; mailbox disconnected/unmapped không Ready; STAFF_READ_ONLY chỉ xem customer/mailbox được assign. Chỉ thêm docs, không sửa runtime code, không sửa `.env*`, không sửa GitHub Actions. File liên quan: `docs/tasks/TASK-063-production-scale-up-full-internal-use.md`, `docs/operations/PRODUCTION_SCALE_UP_CHECKLIST.md`, `docs/reports/TASK-063-production-scale-up-full-internal-use.md`. Rủi ro còn lại: cần chạy scale thật theo từng giai đoạn và theo dõi metric vận hành trước khi tăng lên full internal use.

## Test phase 1 — Final technical audit

- TASK-064: Final technical audit & phase 1 test review — **CONDITIONAL PASS** (Gemini review CONDITIONAL PASS, `npm run verify` PASS: 857 tests, lint/typecheck/build sạch). Đã hoàn tất vai trò technical audit phase 1 (audit + automated test/review; CHƯA test UI sâu, CHƯA tối ưu UI — để phase 2). Không sửa runtime code. Không có finding Critical; các business rule cốt lõi (RBAC + scope, routing one-active + reusable destination, pipeline dedup, disconnect safety, queue/throttle/retry hữu hạn, secret/token/code masking, production auth fail-closed, production/staging safety) đều CONFIRMED ở service layer. **Backlog/risk bắt buộc khi chuyển phase 2:** H1 (High) — legacy Telegram mapping API `POST/PATCH /api/telegram/mappings[/id]` có thể bypass customer isolation khi dùng raw telegramChatId (hiện chỉ OWNER/ADMIN, không lộ qua UI), **phải fix trước production / staff real use**; M1 (Medium) — dedup race condition (read-then-write, chưa bắt unique-constraint), **phải xử lý trước khi chạy nhiều worker replica**; M2 (Medium) — one-active-mapping guard có TOCTOU risk, nên xử lý đầu phase 2. File liên quan: `docs/tasks/TASK-064-final-technical-audit-phase-1.md`, `docs/reports/TASK-064-final-technical-audit-phase-1.md`. **Task tiếp theo đề xuất: TASK-065 — Fix legacy Telegram mapping API customer isolation (H1) trước production / staff real use** (retire route legacy / route qua đường destination-based đã enforce isolation / thêm validation isolation + customer-scope, kèm test cross-customer cho mọi route mutation mapping).

## Test phase 2 — Backlog fixes

- TASK-065: Fix legacy Telegram mapping API customer isolation (H1 từ TASK-064) — done (`npm run verify` PASS: 870 tests, lint/typecheck/build sạch; chờ Gemini review). Đã đóng H1: route legacy `POST /api/telegram/mappings` và `PATCH /api/telegram/mappings/[id]` giờ đi qua đường destination-based (đã enforce customer isolation) thay vì nhận raw `telegramChatId`. Mailbox và destination bắt buộc cùng customer; raw chat id không kèm `destinationId` → 400; cross-customer bị chặn kể cả OWNER/ADMIN → 409; STAFF_READ_ONLY vẫn 403. Thêm tham số `scope?` fail-closed (customer scope của người gọi) vào đường destination-based. Giữ nguyên rule nhiều mailbox dùng chung một reusable destination và mỗi mailbox tối đa một active destination; không multi-destination/broadcast; không sửa UI; không sửa `.env*`/GitHub Actions. File liên quan: `docs/tasks/TASK-065-fix-legacy-telegram-mapping-isolation.md`, `docs/reports/TASK-065-fix-legacy-telegram-mapping-isolation.md`, `services/telegram/telegram-mapping.service.ts`, `app/api/telegram/mappings/route.ts`, `app/api/telegram/mappings/[id]/route.ts`, `tests/api/telegram-mappings.route.test.ts`, `tests/unit/telegram/telegram-mapping.service.test.ts`. Rủi ro còn lại: disable/delete by id chưa resolve customer-scope (L2, admin-only, không nhận raw data — follow-up); primitive raw `createTelegramMapping`/`updateTelegramMapping` còn export (không còn route gọi) nên retire ở task dọn dẹp; M1 (dedup race), M2 (TOCTOU one-active), M3 (scope optional), L1 (Telegram `description` log) vẫn là backlog phase 2.