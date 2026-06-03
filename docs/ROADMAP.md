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
- TASK-059: Production deployment limited internal beta
- TASK-060: Backup, restore & incident response

## Sprint 15 — Internal operations

- TASK-061: Staff onboarding guide
- TASK-062: Daily operations checklist
- TASK-063: Production scale-up from beta to full internal use