# PROJECT HANDOFF — TASK-042 TO TASK-049

> Tài liệu bàn giao bổ sung, nối tiếp `docs/PROJECT_HANDOFF_TASK_001_TO_041.md`.
> Tổng hợp toàn bộ tiến độ từ **TASK-042 đến TASK-049** để upload vào một ChatGPT
> Project sources, giúp AI ở đó hiểu đầy đủ bối cảnh trước khi bắt đầu **TASK-050**.
>
> **Lưu ý bảo mật khi đọc/giữ file này:** Tài liệu KHÔNG chứa token, refresh token,
> client secret, bot token, encryption key, session secret, verification code thật,
> full email body, hay bất kỳ connection string thật nào. Khi nhắc tới biến môi
> trường, chỉ ghi **TÊN** biến — không ghi giá trị. Giá trị thật chỉ sống trong
> secret manager của platform deploy.
>
> Để hiểu nền móng TASK-001 → TASK-041 (kiến trúc, pipeline, security rules, AI
> workflow), đọc trước file handoff 001→041 ở trên.

---

## 1. Trạng thái hiện tại sau TASK-049

- **Tiến độ:** Hoàn thành tới **TASK-049** (Sprint 10 → Sprint 12 phần hạ tầng staging).
  TASK-042 → 047 là code/docs trong repo; TASK-048 → 049 là quyết định platform +
  checklist hạ tầng staging (chưa deploy thật).
- **Branch hiện tại:** nhánh feature của TASK-049 (staging infrastructure setup).
  Tên nhánh chính xác kiểm tra bằng `git branch --show-current`.
- **Main/base branch cho PR:** nhánh base Sprint 0 (quality gates). Xác nhận lại
  bằng Git/GitHub khi cần — thông tin Git là động, không snapshot cứng ở đây.
- **Commit gần đây (đỉnh nhánh, kiểm tra bằng `git log --oneline`):**
  "add staging infrastructure setup checklist" (TASK-049),
  "choose staging deployment platform architecture" (TASK-048),
  "add safe mailbox onboarding flow" (TASK-047),
  "improve staff mailbox dashboard ux" (TASK-046),
  "add internal staff assignment model" (TASK-045),
  "enforce one mailbox one telegram destination" (TASK-044),
  "harden prisma client generation" (TASK-043),
  "add internal production readiness roadmap" (TASK-042).
- **Bản chất app (đã chốt rõ từ TASK-042/045):** đây là **internal staff app** cho
  agency, **không** phải public SaaS. Khách hàng **không login**; chỉ nhận
  verification code qua Telegram group/topic.
- **TASK tiếp theo:** **TASK-050 — Microsoft App Registration staging validation**
  (xem §4). Sau đó là TASK-051 (live mailbox E2E trên staging).
- **`npm run verify`:** chạy lại trên nhánh hiện tại — xem kết quả PASS/FAIL ở cuối
  file này (mục báo cáo). `verify` = `db:generate` (prisma generate) → lint →
  typecheck → test → build.

---

## 2. Tóm tắt từng task (TASK-042 → TASK-049)

> Mỗi task: **mục tiêu · kết quả đã chốt · file chính · rủi ro còn lại**.
> Task spec gốc ở `docs/tasks/TASK-04X-*.md`; một số task có report ở
> `docs/reports/TASK-04X-*.md`.

### TASK-042 — Internal production readiness plan (docs-only)

- **Mục tiêu:** Lập kế hoạch đưa app vào vận hành **nội bộ** thực tế; mở rộng roadmap
  TASK-042 → TASK-061 theo 6 hướng; chốt 3 nguyên tắc bắt buộc.
- **Kết quả đã chốt:** Task spec + report; cập nhật `docs/ROADMAP.md` thêm Sprint
  10–15 và block "Nguyên tắc bắt buộc cho toàn bộ lộ trình" (mỗi mailbox một
  destination active; không làm 1 mailbox → nhiều destination; Microsoft publisher
  verification không phải blocker hiện tại). Không đụng runtime code/migration.
- **File chính:** `docs/tasks/TASK-042-internal-production-readiness-plan.md`,
  `docs/reports/TASK-042-internal-production-readiness-plan.md`, `docs/ROADMAP.md`.
- **Rủi ro còn lại:** Roadmap mới là định hướng; mỗi task vẫn cần spec riêng. Các
  bước vận hành thật (CI green quan sát được, Gemini review nhánh, live round-trip)
  vẫn treo từ handoff 001→041.

### TASK-043 — Prisma Client generation hardening

- **Mục tiêu:** Đảm bảo Prisma Client luôn được generate đúng từ schema khi cài trên
  PC mới, đổi máy, hoặc CI — tránh client cũ lệch schema gây typecheck/build fail.
- **Kết quả đã chốt:** Thêm npm script `db:generate` (= `prisma generate`); thêm
  `postinstall` chạy `prisma generate` sau khi cài dependency; ghép `db:generate`
  vào đầu `npm run verify`. Không cần kết nối database thật để generate client; không
  sửa schema, không tạo migration.
- **File chính:** `package.json` (scripts), `docs/tasks/TASK-043-prisma-client-generation-hardening.md`.
- **Rủi ro còn lại:** `postinstall` cần network để Prisma tải engine; môi trường
  offline/air-gapped cần cache sẵn. `verify` chậm thêm chút do generate mỗi lần.

### TASK-044 — One mailbox, one active Telegram destination (chốt rule)

- **Mục tiêu:** Chốt chính thức rule routing: **mỗi mailbox chỉ có tối đa MỘT active
  Telegram destination** (group thường hoặc topic trong group), mà không phá rule
  TASK-041 (nhiều mailbox được dùng chung một group/topic).
- **Kết quả đã chốt:** Xác minh service đã enforce đủ (resolve đúng một active
  destination theo mailbox; mailbox không có active mapping thì không relay). Bổ
  sung test khóa rule trong `telegram-mapping.service.test.ts`. **Không** thêm
  multi-destination/broadcast; không cần migration mới.
- **File chính:** `tests/unit/telegram/telegram-mapping.service.test.ts`,
  `docs/tasks/TASK-044-one-mailbox-one-destination-rule.md`.
- **Rủi ro còn lại:** Rule enforce ở service layer; cần giữ mọi API/UI tạo-sửa
  mapping đi qua service này, không bypass.

### TASK-045 — Internal staff ownership & assignment model

- **Mục tiêu:** Đặt nền mô hình nhân viên nội bộ. OWNER/ADMIN xem toàn bộ;
  STAFF_READ_ONLY chỉ thấy customer được gán + mailbox/mapping thuộc customer đó.
  Khách hàng không login.
- **Kết quả đã chốt:**
  - Assignment **theo customer** (không thêm mailbox-level): bảng join
    `StaffAssignment(userId, customerId, assignedById?, createdAt)` với
    `@@unique([userId, customerId])`. Gán customer là tự phủ luôn mailbox + mapping
    thuộc customer đó (tận dụng `Mailbox.customerId` có sẵn).
  - **Enforcement ở service layer** (không chỉ ẩn UI): các service list/detail nhận
    tham số `CustomerScope`; scope resolve một chỗ tại `lib/auth/access-scope.ts`.
    Mailbox/mapping ngoài scope trả `null` (notFound), không lộ sự tồn tại.
  - OWNER/ADMIN scope `all` + permission `MANAGE_STAFF_ASSIGNMENTS`;
    STAFF_READ_ONLY scope `assigned`, không có `MANAGE_*` ⇒ mọi action ghi và trang
    edit/new fail-closed. Staff chưa được gán customer nào ⇒ không thấy gì.
  - **Không phá rule cũ:** logic create/update/disable/delete mapping và
    `findActiveMappingForMailbox` (worker/sender) giữ nguyên ⇒ TASK-041 + TASK-044
    còn đúng.
- **File chính:** `lib/auth/access-scope.ts`, `lib/auth/guards.ts`,
  `lib/auth/permissions.ts`, `services/staff/staff-assignment.service.ts`,
  `services/customers/customer.service.ts`,
  `services/microsoft/mailbox-list.service.ts`,
  `services/microsoft/mailbox-detail.service.ts`,
  `services/telegram/telegram-mapping.service.ts`, `prisma/schema.prisma`,
  migration `task045_staff_assignment`, kèm UI customers/mailboxes/telegram + nhiều
  test (`access-scope`, `guards`, `staff-assignment`, `mailbox-list/detail`...).
- **Rủi ro còn lại:**
  - **Migration `task045_staff_assignment` ĐÃ tạo file SQL nhưng CHƯA được apply**
    (SQL sinh offline bằng `prisma migrate diff`, không kết nối DB). Ops phải chạy
    `prisma migrate deploy` ở dev/staging **trước khi** runtime đọc bảng
    `StaffAssignment`, nếu không runtime sẽ lỗi.
  - **Audit log assign/unassign hoãn lại** (audit store hiện in-memory từ TASK-016;
    thêm action mới sẽ vượt phạm vi tối thiểu) — đề xuất bổ sung khi có UI quản lý
    assignment.

### TASK-046 — Staff dashboard UX cho high mailbox volume

- **Mục tiêu:** Cải thiện dashboard để staff quản lý 100–200 mailbox: search/filter/
  sort, hiển thị rõ trạng thái mailbox & mapping; ẩn/disable action STAFF_READ_ONLY
  không có quyền. Không đổi business rule/routing, không bulk action.
- **Kết quả đã chốt:** Mailbox list có search (email/customer), filter theo
  customer/mailbox status/mapping status; badge readiness (Ready / Needs Mapping /
  Error...) hiển thị mailbox nào chưa có active mapping, gửi về group/topic nào.
  Filter logic tách ra `lib/mailboxes/mailbox-list-filter.ts` (thuần, dễ test);
  dữ liệu vào list vẫn được scope đúng từ server (không bypass assignment scope).
- **File chính:** `components/tables/MailboxListTable.tsx`,
  `components/status/MailboxReadinessBadge.tsx`,
  `lib/mailboxes/mailbox-list-filter.ts`, `app/admin/mailboxes/page.tsx`,
  `components/tables/CustomersTable.tsx`,
  `tests/unit/mailboxes/mailbox-list-filter.test.ts`,
  `docs/tasks/TASK-046-staff-dashboard-ux-high-mailbox-volume.md`.
- **Rủi ro còn lại:** Filter/search chạy phía client trên dữ liệu đã-scope; phải
  luôn giữ server scope đúng (UI hiding không phải lớp bảo mật duy nhất). Hiển thị
  token/subscription issue chỉ khi data hiện có hỗ trợ an toàn.

### TASK-047 — Safe mailbox onboarding flow

- **Mục tiêu:** Sau khi connect mailbox, người vận hành phải thấy rõ mailbox đã
  **Ready** chưa. **Mailbox chưa có active Telegram destination hợp lệ thì KHÔNG
  được coi là Ready.** Ready = đã connect + đúng customer + đúng một active
  destination.
- **Kết quả đã chốt:** Readiness là **computed status** từ dữ liệu hiện có (không
  thêm cột DB, không migration). Mailbox detail + admin home hiển thị trạng thái
  Connected / Needs Mapping / Ready / Error, hiển thị rõ customer + group/topic đích;
  dẫn người dùng sang nơi tạo/chỉnh mapping; STAFF_READ_ONLY chỉ xem read-only.
  Tái dùng `MailboxReadinessBadge` từ TASK-046.
- **File chính:** `app/admin/mailboxes/[id]/page.tsx`, `app/admin/page.tsx`,
  `lib/mailboxes/mailbox-list-filter.ts` (mở rộng readiness),
  `components/status/MailboxReadinessBadge.tsx`,
  `tests/unit/mailboxes/mailbox-list-filter.test.ts`,
  `docs/tasks/TASK-047-safe-mailbox-onboarding-flow.md`.
- **Rủi ro còn lại:** Readiness phản ánh đúng dữ liệu mapping/subscription hiện có;
  nếu sau này thêm trạng thái lỗi mới cần cập nhật logic computed.

### TASK-048 — Choose deployment platform & staging architecture (docs-only)

- **Mục tiêu:** Chọn platform staging + mô tả kiến trúc staging tối thiểu. Không
  deploy, không tạo hạ tầng thật.
- **Kết quả đã chốt:** **Railway là khuyến nghị chính** (web Next.js + PostgreSQL +
  Redis + worker long-running trong **một** project, một dashboard, HTTPS public
  domain tức thì). **Render là phương án dự phòng tương đương** (Web Service +
  Background Worker + Postgres + Key Value). **Vercel-only không phù hợp** vì worker
  long-running phải tách nền khác → 2 platform khó vận hành. Worker strategy: **tách
  3 worker service riêng** (email/delta/renewal) dùng thẳng npm script đã có.
  So sánh dựa trên **official docs**, trung lập; không khẳng định con số pricing.
- **File chính:** `docs/reports/TASK-048-choose-deployment-platform-staging-architecture.md`,
  `docs/tasks/TASK-048-choose-deployment-platform-staging-architecture.md`,
  cập nhật `docs/ROADMAP.md` + `docs/STAGING_DEPLOYMENT.md`.
- **Rủi ro còn lại:** Chi phí nhiều service (web + Postgres + Redis + 3 worker);
  pricing official có thể đổi — xem lại lúc setup. Vận hành 2 PC dễ gây worker chạy
  trùng (xem quy tắc ở TASK-049).

### TASK-049 — Staging infrastructure setup (checklist, chưa deploy)

- **Mục tiêu:** Chi tiết hóa checklist hạ tầng staging theo Railway đã chốt; tách rõ
  "việc làm trong repo" vs "việc user thao tác thủ công trên dashboard". **Không**
  deploy, **không** tạo database/Redis/App Registration thật, **không** chạy live
  E2E, **không** tạo migration, **không** ghi secret thật.
- **Kết quả đã chốt:**
  - Service cần tạo trên một Railway project staging (tách hoàn toàn production):
    `web` (build `npm run build`, start `npm run start`), `postgres` (template),
    `redis` (template), `worker-email` (`npm run worker:email`), `worker-delta`
    (`npm run worker:delta`), `worker-renewal` (`npm run worker:renewal`). Tất cả
    command đã đối chiếu khớp `package.json` thật, không bịa.
  - **Domain mặc định `.railway.app`** (HTTPS public) là đủ cho OAuth callback +
    Graph webhook; custom domain là tùy chọn về sau.
  - Danh sách **25 tên** biến môi trường staging — đồng bộ giữa `.env.example` và
    `deployment/staging/env.staging.example` (chỉ tên/placeholder, không giá trị).
    **Không có biến mới** cần thêm.
  - Migration staging an toàn: **`prisma migrate deploy`** (KHÔNG `migrate dev`),
    kiểm tra `prisma migrate status`. Không tạo migration trong task này.
  - Quy tắc 2 máy: **worker CHỈ chạy trên Railway**; không chạy worker local trỏ
    DB/Redis staging (tránh xử lý trùng / job chạy 2 nơi). Mỗi worker tắt khẩn cấp
    độc lập nếu phát hiện gửi nhầm Telegram.
- **File chính:** `docs/reports/TASK-049-staging-infrastructure-setup.md`,
  `docs/STAGING_DEPLOYMENT.md` (mục Railway §5.12), `deployment/staging/README.md`.
- **Rủi ro còn lại:** Worker crash/không restart → ngừng relay/miss mail (giám sát
  qua logs + `/admin/health`); mất Redis → job dừng; sai URL webhook HTTPS →
  không nhận notification (có đường dự phòng delta polling); dùng nhầm `migrate dev`
  trên staging; lộ secret nếu paste nhầm; cost nhiều service.

---

## 3. Các quyết định quan trọng (phải giữ nguyên ở mọi task sau)

1. **App là internal staff app, KHÔNG phải public SaaS.** Không self-signup cho
   người lạ; chỉ nhân viên agency đăng nhập dashboard.
2. **Khách hàng KHÔNG login.** Khách chỉ nhận verification code qua Telegram
   group/topic. Không customer portal, không billing/payment.
3. **OWNER/ADMIN xem toàn bộ.** Scope `all`; không bị `StaffAssignment` giới hạn;
   có permission quản lý assignment.
4. **STAFF_READ_ONLY chỉ thấy customer/mailbox được gán.** Scope `assigned`; chỉ
   thấy customer được gán + mailbox/mapping thuộc các customer đó; mọi action ghi
   fail-closed. Enforce ở **service layer**, không chỉ ẩn UI.
5. **Nhiều mailbox CÓ THỂ dùng chung một Telegram group/topic** (hợp lệ, có chủ
   đích — TASK-041).
6. **Mỗi mailbox chỉ có tối đa MỘT active Telegram destination** (TASK-044). Không
   làm 1 mailbox → nhiều destination; không broadcast/multi-destination.
7. **Mailbox chưa có mapping hợp lệ KHÔNG được coi là Ready** (TASK-047). Ready =
   connected + đúng customer + đúng một active destination hợp lệ. Mailbox không có
   active destination thì không relay code.
8. **Railway là platform staging đã chốt ở TASK-048** (Render là dự phòng tương
   đương; Vercel-only không phù hợp do worker long-running).
9. **TASK-049 dùng Railway** với: web service, PostgreSQL, Redis, worker-email,
   worker-delta (delta polling backup), worker-renewal (subscription renewal), và
   **domain mặc định `.railway.app`** cho OAuth callback + Graph webhook.

> Nguyên tắc nền (từ handoff 001→041, vẫn áp dụng): dedup theo
> `@@unique([mailboxId, graphMessageId])` đảm bảo webhook + delta polling cùng thấy
> một message thì Telegram chỉ nhận **đúng một lần**; refresh token encrypt at rest;
> không log token/verification code; webhook validate `clientState`.

---

## 4. TASK tiếp theo: TASK-050 — Microsoft App Registration staging validation

TASK-050 là bước **validate App Registration cho staging** trên nền hạ tầng Railway
đã chuẩn bị ở TASK-049, để chuẩn bị cho live mailbox E2E ở TASK-051.

Phạm vi định hướng (chi tiết sẽ nằm trong task spec riêng `docs/tasks/TASK-050-*.md`):

- Tạo / cấu hình **App Registration riêng cho staging** (tách hoàn toàn local/prod).
- Redirect URI staging phải **khớp tuyệt đối** với biến môi trường tương ứng:
  dạng `https://<staging-domain>.railway.app/api/microsoft/oauth/callback` (sai
  protocol/port/path/dấu `/` gây `AADSTS50011`).
- Webhook URL staging là public HTTPS:
  dạng `https://<staging-domain>.railway.app/api/webhooks/microsoft/mail`.
- Scope giữ **tối thiểu**: `Mail.Read`, `offline_access`, `User.Read`.
- Microsoft publisher verification **không phải blocker hiện tại** — chỉ theo dõi,
  chỉ xử lý nếu consent thực tế bị chặn (ví dụ tenant yêu cầu admin consent, hoặc
  `AADSTS65001` / consent required). Tham chiếu `docs/MICROSOFT_SETUP.md`.

---

## 5. TASK-050 KHÔNG được làm

- **KHÔNG deploy production** (và không thao tác production database/Redis).
- **KHÔNG dùng mailbox khách hàng thật** — chỉ mailbox TEST.
- **KHÔNG dùng Telegram group khách hàng thật** — chỉ Telegram TEST bot + TEST group.
- **KHÔNG paste secret thật** (client secret, bot token, encryption key, session
  secret, connection string...) vào bất kỳ AI nào (ChatGPT/Claude/Gemini/Cursor),
  vào docs, code, log, hay commit. Giá trị thật chỉ sống trong secret manager Railway.
- **KHÔNG chạy live mailbox E2E** ở TASK-050 — việc đó để dành cho **TASK-051**.
- Ngoài ra giữ nguyên các ràng buộc nền: không đọc/in `.env*`; không tạo migration
  trừ khi có thay đổi schema thật sự (và chỉ `prisma migrate deploy` cho staging);
  không sửa GitHub Actions theo hướng nới lỏng secret scan; không phá routing rule
  (nhiều mailbox dùng chung group/topic được, một mailbox chỉ một destination active).

---

## 6. Tên biến môi trường cần cho staging (chỉ TÊN — KHÔNG giá trị)

Nguồn gốc đầy đủ + ghi chú: `docs/STAGING_DEPLOYMENT.md` §5.4 và
`deployment/staging/env.staging.example` (đồng bộ với `.env.example`). Phân theo nhóm:

- **App runtime:** `APP_ENV`, `APP_URL`, `LOG_LEVEL`.
- **Datastore:** `DATABASE_URL`, `REDIS_URL`.
- **Queue / worker:** `EMAIL_QUEUE_NAME`, `EMAIL_WORKER_CONCURRENCY`.
- **Token encryption:** `ENCRYPTION_KEY` (tạo MỚI cho staging, không tái dùng giá
  trị local/prod).
- **Microsoft OAuth / Graph:** `MICROSOFT_CLIENT_ID`, `MICROSOFT_CLIENT_SECRET`,
  `MICROSOFT_TENANT_ID`, `MICROSOFT_REDIRECT_URI`, `MICROSOFT_GRAPH_NOTIFICATION_URL`,
  `MICROSOFT_GRAPH_LIFECYCLE_NOTIFICATION_URL`.
- **Telegram:** `TELEGRAM_BOT_TOKEN` (chỉ trong secret manager, không lưu DB),
  `TELEGRAM_ADMIN_ALERT_CHAT_ID`.
- **Auth / staging admin:** `AUTH_DEV_DEMO_USER`, `STAGING_ADMIN_PASSWORD`,
  `STAGING_ADMIN_SESSION_SECRET`.
- **Delta polling worker:** `DELTA_POLLING_ENABLED`, `DELTA_POLLING_INTERVAL_SECONDS`,
  `DELTA_POLLING_MAX_PAGES_PER_MAILBOX`.
- **Subscription renewal worker:** `SUBSCRIPTION_RENEWAL_ENABLED`,
  `SUBSCRIPTION_RENEWAL_INTERVAL_SECONDS`, `SUBSCRIPTION_RENEWAL_WINDOW_HOURS`.

> Quy tắc: giá trị thật **chỉ** sống trong secret manager của Railway. Không commit,
> không log, không paste vào chat AI. `DATABASE_URL` / `REDIS_URL` trỏ tới service
> Postgres/Redis **staging** (variable reference của Railway), không trỏ production.

---

## 7. Cách dùng file này trong ChatGPT Project

Upload **cả hai** file handoff vào ChatGPT Project sources:
`docs/PROJECT_HANDOFF_TASK_001_TO_041.md` (nền móng) và file này
(`docs/PROJECT_HANDOFF_TASK_042_TO_049.md`, cập nhật mới nhất). Sau đó dán prompt:

```text
Bạn là ChatGPT đóng vai Planner / Product Manager cho dự án
"Verification Code Relay Tool".

Tôi đã upload 2 file handoff: TASK-001→041 (nền móng) và TASK-042→049 (mới nhất).
Hãy đọc kỹ cả hai trước khi trả lời.

Ràng buộc cố định:
- App là internal staff app, KHÔNG phải public SaaS. Khách hàng không login.
- OWNER/ADMIN xem toàn bộ; STAFF_READ_ONLY chỉ thấy customer/mailbox được gán.
- Nhiều mailbox có thể dùng chung một Telegram group/topic; mỗi mailbox chỉ có
  một active destination. Mailbox chưa mapping hợp lệ không phải Ready.
- Railway là platform staging đã chốt (TASK-048/049).
- Tuân thủ docs/SECURITY_RULES.md: không hardcode/không log secret hay verification
  code; refresh token encrypt; webhook validate clientState; dedup chống gửi trùng.
- Bạn KHÔNG sửa code local. Claude Code là coder chính; Gemini CLI là reviewer/tester.
- Mỗi task mới phải có task file trong docs/tasks/, pass `npm run verify`, và pass
  Gemini review trước khi nghiệm thu.

Việc đầu tiên: dựa trên §4 và §5 của file handoff 042→049, soạn nội dung TASK-050
(Microsoft App Registration staging validation): mục tiêu, scope được làm, scope
KHÔNG làm, tiêu chí nghiệm thu. Chưa viết code — chỉ lập kế hoạch.
```
