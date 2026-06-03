# TASK-059 — Production deployment limited internal beta (report)

Status: **checklist + production deployment docs prepared; real production
deploy NOT executed.** No real production database, Redis, mailbox, or customer
Telegram group was created or used. No `.env*` content was read or printed. No
real secret is in the diff.

**Headline:** production is **not yet usable for the staff beta** — admin
sign-in is fail-closed and there is no real production sign-in provider yet.
This is a known, intentional blocker (see §4).

## 1. Mục tiêu đã đạt

- Tài liệu hóa production deployment topology tối thiểu cho limited internal
  beta, đồng bộ với platform đã chốt (Railway chính, Render dự phòng — TASK-048)
  và nhóm biến môi trường đã chuẩn hóa (TASK-058).
- Tạo thư mục `deployment/production/` với checklist an toàn và env template
  placeholder-only.
- Xác minh các lệnh trong deployment checklist là **lệnh có thật** trong repo
  (không bịa lệnh).
- Xác minh trạng thái production auth: **fail-closed**, ghi rõ blocker.
- Xác minh bằng diff rằng không phá các invariant (RBAC, routing, disconnect
  guard, throttling, dashboard) — task này chỉ thêm docs, không sửa runtime code.

## 2. File đã thay đổi

- `deployment/production/README.md` (mới) — quick reference + blocker + topology
  + emergency worker kill switch + beta guardrails.
- `deployment/production/env.production.example` (mới) — placeholder-only,
  mirror `deployment/staging/env.staging.example`, đánh dấu rõ production auth
  fail-closed.
- `docs/reports/TASK-059-production-deployment-limited-internal-beta.md` (mới) —
  báo cáo này.
- `docs/tasks/TASK-059-production-deployment-limited-internal-beta.md` — đã tồn
  tại từ trước (task spec), **không sửa**.

Không sửa `.env*`, không sửa runtime code, không sửa GitHub Actions.

## 3. Xác minh npm scripts cho deployment checklist (không bịa lệnh)

Đối chiếu trực tiếp với `package.json`:

| Mục đích | Lệnh dùng trong checklist | Có thật? |
|----------|---------------------------|----------|
| Build web | `npm run build` (`next build`) | ✅ |
| Start web | `npm run start` (`next start`) | ✅ |
| Email worker | `npm run worker:email` | ✅ |
| Delta polling worker | `npm run worker:delta` | ✅ |
| Subscription renewal worker | `npm run worker:renewal` | ✅ |
| Generate Prisma client | `npm run db:generate` (`prisma generate`) | ✅ |
| Verify gate | `npm run verify` | ✅ |
| Migration production | `npx prisma migrate deploy` + `npx prisma migrate status` | ✅ (lệnh Prisma chuẩn, đúng như `docs/STAGING_DEPLOYMENT.md` §5.7) |

Không có alias npm cho `migrate deploy`; checklist gọi thẳng `npx prisma migrate
deploy` (an toàn, không phải `migrate dev`).

## 4. Production auth — BLOCKER cho staff beta

Đã xác minh trong code hiện tại:

- `lib/auth/session.ts` → `getCurrentUser()` là một `switch` theo `APP_ENV`.
  Nhánh `production` (và `test`/default) **luôn trả `null`** — fail-closed
  tường minh. Role/userId không bao giờ lấy từ request/cookie chưa verify.
- `app/login/page.tsx` → nhánh production hiển thị thông báo chung chung
  "Admin sign-in is not available … access is locked"; **không** lộ tên biến,
  **không** mở staging passphrase.

Hệ quả: **staff chưa thể login production admin**. Beta chưa usable qua admin UI
cho tới khi có **production sign-in provider thật** (task riêng, defer).

**Không bypass:** staging passphrase (`STAGING_ADMIN_PASSWORD`) và dev demo user
(`AUTH_DEV_DEMO_USER`) bị bỏ qua khi `APP_ENV=production` theo thiết kế. Task này
**không** tái bật chúng và **không** thêm cơ chế login tạm cho production.

→ Kết luận: production **deploy/infra-verifiable**, nhưng **staff-facing beta =
BLOCKED** cho tới khi có provider thật. Đây là kết quả đúng theo TASK-057, không
phải lỗi.

## 5. Xác minh invariant không bị phá (chỉ thêm docs)

Task này không sửa runtime code nên các invariant được giữ **by construction**.
Đã xác nhận các điểm enforce vẫn nằm nguyên ở service/API layer:

| Invariant | Nơi enforce (không sửa) |
|-----------|-------------------------|
| Internal staff app, khách không login | `app/login/page.tsx`, không có customer auth surface |
| OWNER/ADMIN xem toàn bộ; STAFF_READ_ONLY chỉ thấy assigned | `lib/auth/access-scope.ts`, `lib/auth/guards.ts`, `lib/auth/permissions.ts`, `lib/auth/roles.ts` |
| Reusable destination; mỗi mailbox ≤ 1 active destination | TASK-053 (service-layer mapping validation) |
| Disconnected mailbox không poll/renew/relay | `services/microsoft/mailbox-disconnect*.ts` (TASK-052) |
| Mailbox chưa mapping hợp lệ không Ready | `services/health/health.service.ts`, `lib/mailboxes/mailbox-list-filter.ts` (TASK-056) |
| Throttling / queue safety | `services/queue/mailbox-processing-lock.ts`, `services/queue/destination-throttle.ts`, `services/email/graph-message-pipeline.service.ts` (TASK-055) |
| Operational health dashboard | `services/health/health.service.ts` (TASK-056) |
| Production auth hardening | `lib/auth/session.ts` (TASK-057) |
| Production env/secret setup | `lib/env.schema.ts` / `.env.example` (TASK-058) |

Không có file runtime nào trong diff → không có rủi ro hồi quy với các rule trên.

## 6. Smoke test tối thiểu cho limited beta (hướng dẫn — chưa chạy thật)

Vì chưa deploy production thật và auth còn fail-closed, đây là checklist để
chạy **khi** production sign-in provider sẵn sàng. Không yêu cầu paste secret.

```text
[ ] App production mở được bằng HTTPS.
[BLOCKED] Login staff nội bộ — chờ production sign-in provider (xem §4).
[ ] /admin/health mở được, không lộ token/secret/full code/full email body.
[ ] Tạo/xem customer nội bộ test đúng theo quyền (OWNER/ADMIN vs STAFF_READ_ONLY).
[ ] Connect mailbox test/internal beta.
[ ] Tạo mapping tới reusable Telegram destination đúng customer.
[ ] Test-send đúng group/topic TRƯỚC khi bật relay thật.
[ ] Mock email process/send vẫn hoạt động (nếu dùng làm smoke test).
[ ] Email thật (nếu có): webhook hoặc delta path relay ĐÚNG MỘT LẦN
    (dedupe theo unique [mailboxId, graphMessageId]).
[ ] Mailbox disconnected KHÔNG relay.
[ ] Mailbox thiếu mapping KHÔNG Ready và KHÔNG relay.
[ ] Health dashboard kiểm tra trước và sau khi bật worker.
```

## 7. Rollback / tắt khẩn cấp (tối thiểu — chi tiết để TASK-060)

- Nghi gửi nhầm destination → **dừng ngay** `worker-email` / `worker-delta` /
  `worker-renewal` (mỗi worker dừng độc lập); web app giữ nguyên để xem
  `/admin/health`.
- Disconnect mailbox để chặn poll/renew/relay (TASK-052).
- Deploy lỗi → rollback release trên platform.
- Migration lỗi → **không** sửa DB tay; xem `npx prisma migrate status`, khôi
  phục từ backup nếu cần.
- Nghi lộ secret → rotate ngay, cập nhật secret manager, không commit giá trị mới.

Backup/restore/incident response đầy đủ: **TASK-060**.

## 8. Số staff / mailbox beta dự kiến

- Staff: **1–2** nội bộ.
- Mailbox thật ban đầu: **5–10 tối đa**.
- Worker cần chạy: `worker-email`, `worker-delta`, `worker-renewal` (3 service
  riêng, chỉ chạy trên platform production, không chạy local trỏ production).

## 9. Kết quả kiểm tra

- `git branch --show-current`, `git status --short`, `git diff --stat`,
  `npm run verify`: kết quả PASS/FAIL được ghi trong tin nhắn của Claude kèm log.
- Diff **không** chứa secret thật, full verification code, hay full email body.
- Env template chỉ chứa placeholder (mirror staging template đã được CI chấp nhận).

## 10. Secret-scan false-positive risk

- `deployment/production/env.production.example` theo đúng style của
  `deployment/staging/env.staging.example`: các biến SENSITIVE
  (`ENCRYPTION_KEY`, `MICROSOFT_CLIENT_SECRET`, `TELEGRAM_BOT_TOKEN`) để **trống**;
  chỉ placeholder mô tả (`replace_with_*`, `YOUR_PRODUCTION_DOMAIN`,
  `USER:PASSWORD@HOST:PORT`). Không có giá trị giống token/key thật.
- README/report tránh dòng ngắn dạng `keyword: value` nhạy cảm; chỉ liệt kê
  **tên biến**.
- Rủi ro false-positive: **thấp**. Cần Gemini xác nhận thêm.

## 11. Còn lại / blocker / việc tiếp theo

- **Blocker chính:** chưa có production sign-in provider thật → staff beta chưa
  usable. Cần một task riêng thêm provider + biến đi kèm (không tái dùng
  staging/dev login).
- Health dashboard production có thể báo Unknown/Degraded cho queue backlog /
  worker heartbeat (chưa có heartbeat thật — baseline TASK-055/056), an toàn.
- Lock/scope đa-tiến-trình vẫn theo baseline TASK-055.
- Task tiếp theo nên đọc: TASK-057 (auth), TASK-058 (env/secret),
  `docs/STAGING_DEPLOYMENT.md`, `deployment/production/README.md`. Backup/incident
  → TASK-060; staff onboarding → TASK-061; daily ops → TASK-062; scale-up →
  TASK-063.

## 12. Phần cần Gemini review kỹ

- Xác nhận production auth **đúng là fail-closed** và report không gợi ý bypass.
- Xác nhận `env.production.example` không có giá trị nào có thể bị secret-scan
  flag và đã đủ placeholder-only.
- Xác nhận deployment checklist chỉ dùng lệnh có thật trong `package.json` /
  Prisma chuẩn.
- Xác nhận task chỉ thêm docs, không phá invariant nào ở §5.
- Kết luận PASS/FAIL theo `GEMINI.md`.
