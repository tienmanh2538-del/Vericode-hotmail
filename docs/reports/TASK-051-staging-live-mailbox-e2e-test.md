# TASK-051 Report — Staging Live Mailbox E2E Test

Báo cáo ngày: 2026-06-02
Tác giả: Claude Code

Platform staging (chốt ở TASK-048/049): Railway (chính), Render (dự phòng tương đương).

Phạm vi report này: xác minh phần **trong repo** đã sẵn sàng cho live mailbox E2E
(routes, worker scripts, dedupe, health page, lệnh kiểm tra), gom checklist thao tác
thủ công cho user, và cung cấp **bảng kết quả live E2E để điền sau khi user chạy thật**.

Report này **không** chạy live mailbox E2E thay user. Live E2E bắt buộc thao tác ngoài
repo trên Railway, Microsoft Entra, mailbox TEST và Telegram TEST group/topic. Vì vậy
TASK-051 **chưa hoàn tất** cho tới khi user chạy live và điền kết quả ở mục 6 — và
`docs/ROADMAP.md` **chưa** được cập nhật trạng thái done trong lần này.

Report này không deploy production, không dùng database/Redis production, không dùng
mailbox / Telegram group khách hàng thật, không tạo migration, không sửa runtime code,
không ghi secret thật, không ghi full verification code, không ghi full email body. Chỉ
ghi tên biến môi trường và placeholder, không ghi giá trị thật.

---

## 1. Trạng thái tổng quan

| Nhóm | Trạng thái | Ghi chú |
|---|---|---|
| Task file TASK-051 đúng scope | ✅ Đã có | `docs/tasks/TASK-051-staging-live-mailbox-e2e-test.md` |
| Xác minh sẵn sàng trong repo | ✅ Đã đủ | Mục 3 report này |
| Blocker pre-live (runtime/UI) đã sửa | ✅ Đã sửa | Mục 3.1 report này |
| Checklist hạ tầng staging (TASK-049) | ⏳ User xác nhận | Railway dashboard — mục 5.1 |
| Checklist App Registration staging (TASK-050) | ⏳ User xác nhận | Microsoft Entra — mục 5.2 |
| Live E2E webhook path | ⏳ Chưa chạy | Bảng kết quả mục 6 |
| Live E2E delta polling backup | ⏳ Chưa chạy | Bảng kết quả mục 6 |
| Live E2E duplicate case | ⏳ Chưa chạy | Bảng kết quả mục 6 |
| Log/security spot-check | ⏳ Chưa chạy | Bảng kết quả mục 6 |
| Health dashboard check | ⏳ Chưa chạy | Bảng kết quả mục 6 |
| `docs/ROADMAP.md` update done | ⛔ Chưa làm | Chỉ cập nhật sau khi live E2E có kết quả |

Kết luận trạng thái: **Repo đã sẵn sàng cho live E2E. Phần live còn lại là thao tác
thủ công của user; kết quả sẽ điền vào mục 6 trước khi nghiệm thu TASK-051.**

---

## 2. Luồng cần xác minh

```text
Mailbox TEST
  -> Microsoft Graph webhook (đường chính)  hoặc  delta polling backup (đường dự phòng)
  -> staging queue/worker (BullMQ + Redis staging)
  -> detector (Facebook/Meta) -> extractor (verification code)
  -> dedupe (ProcessedMessage)
  -> Telegram TEST group/topic
  -> logs / health dashboard
```

Webhook và delta polling có thể cùng thấy một `graphMessageId`; dedupe đảm bảo Telegram
chỉ nhận **đúng một lần**.

---

## 3. Phần A — đã xác minh TRONG repo (Claude)

Các thành phần mà live E2E sẽ chạm tới đều tồn tại trong repo ở đúng đường dẫn:

```text
[x] OAuth connect URL route:   app/api/mailboxes/connect-url/route.ts
[x] OAuth callback route:      app/api/microsoft/oauth/callback/route.ts
[x] Webhook receiver route:    app/api/webhooks/microsoft/mail/route.ts
[x] Telegram test-send route:  app/api/telegram/test-send/route.ts
[x] Telegram mapping routes:   app/api/telegram/mappings/route.ts (+ [id])
[x] Health dashboard page:     app/admin/health/page.tsx
[x] Email worker script:       scripts/run-email-worker.ts        (npm run worker:email)
[x] Delta polling worker:      scripts/run-delta-polling-worker.ts (npm run worker:delta)
[x] Subscription renewal:      scripts/run-subscription-renewal-worker.ts (npm run worker:renewal)
[x] Dedupe constraint:         prisma/schema.prisma — ProcessedMessage @@unique([mailboxId, graphMessageId])
[x] E2E test runner:           npm run test:e2e  (vitest run tests/e2e)
[x] Verify pipeline:           npm run verify    (db:generate + lint + typecheck + test + build)
```

Ý nghĩa: live E2E không bị thiếu route/worker/script ở phía repo. Nếu live test fail,
nguyên nhân nằm ở cấu hình staging (env/secret manager, Entra, mailbox, Telegram) chứ
không phải thiếu code — trừ khi xuất hiện bug runtime rõ ràng (lúc đó mới mở task sửa code).

Env names liên quan (chỉ TÊN biến — giá trị thật chỉ sống trong Railway secret manager,
xem `docs/STAGING_DEPLOYMENT.md` §5.4 và TASK-050 report):

```text
APP_ENV
APP_URL
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
DELTA_POLLING_ENABLED
DELTA_POLLING_INTERVAL_SECONDS
DELTA_POLLING_MAX_PAGES_PER_MAILBOX
SUBSCRIPTION_RENEWAL_ENABLED
SUBSCRIPTION_RENEWAL_INTERVAL_SECONDS
SUBSCRIPTION_RENEWAL_WINDOW_HOURS
```

---

## 3.1. Blocker pre-live đã phát hiện & sửa (TASK-051)

Trong giai đoạn pre-live staging validation (trước khi chạy live mailbox E2E), một số
runtime/UI blocker đã được phát hiện và **đã sửa trong repo** để luồng vận hành thật
chạy được. Đây là các fix tối thiểu, không redesign, không đổi business rule/routing:

```text
[x] Staging login redirect anchored to APP_URL
    -> sau đăng nhập staging, redirect bám theo APP_URL thay vì host suy đoán,
       tránh OAuth/redirect trỏ nhầm domain.
[x] Mailbox customer assignment UI
    -> mailbox detail cho phép gán mailbox vào đúng customer (theo scope viewer).
[x] Telegram mapping hiển thị Customer theo mailbox được chọn
    -> form mapping hiển thị đúng customer của mailbox đang chọn, giảm gán nhầm.
[x] Mock Email mailbox dropdown + mapping preview
    -> trang Mock Email chọn mailbox theo scope + preview destination mapping;
       API /api/mock-email/process tự xác minh mailbox thuộc scope viewer (fail-closed).
```

Lưu ý: các fix trên giúp luồng pre-live chạy được, **không** đồng nghĩa live E2E đã PASS.
**Live mailbox E2E vẫn đang pending** — kết quả cuối chỉ điền vào bảng mục 6 sau khi
user chạy thật trên staging (xem mục 1 và mục 6). `docs/ROADMAP.md` vì vậy chưa đánh done.

---

## 4. Điều kiện đầu vào (preconditions) trước khi chạy live

Trước khi chạy live E2E, các điều kiện sau phải đúng (chi tiết ở task file §3, §6, §7):

```text
[ ] Railway staging là project RIÊNG, không phải production.
[ ] Web service staging mở được bằng HTTPS public domain.
[ ] PostgreSQL staging riêng; KHÔNG dùng production DB.
[ ] Redis staging riêng; KHÔNG dùng production Redis.
[ ] worker-email, worker-delta, worker-renewal đang chạy trên Railway (không chạy local trỏ staging).
[ ] Migration cũ đã áp dụng bằng prisma migrate deploy (không migrate dev).
[ ] App Registration staging riêng; Redirect URI + Webhook URL staging dùng HTTPS, khớp env.
[ ] Permission Microsoft tối thiểu: Mail.Read, offline_access, User.Read (không thêm scope khác).
[ ] Mailbox TEST riêng; KHÔNG dùng mailbox khách hàng thật.
[ ] Telegram TEST group/topic + TEST bot; KHÔNG dùng group/topic khách hàng thật.
[ ] Không có secret thật trong repo/docs.
```

---

## 5. Phần B — việc USER phải thao tác THỦ CÔNG

Nằm ngoài repo. **Không paste secret thật, full verification code, hay full email body
vào bất kỳ AI nào.**

### 5.1. Trên Railway dashboard

```text
[ ] Xác nhận project staging tách hoàn toàn production.
[ ] Web service staging đang chạy; public HTTPS domain mở được.
[ ] postgres + redis là service staging riêng (không production).
[ ] worker-email / worker-delta / worker-renewal đang chạy.
[ ] Các service dùng đúng nhóm Variables staging.
[ ] /admin mở được; /admin/health mở được.
[ ] Chỉ xác nhận env NAME tồn tại/thiếu; KHÔNG copy giá trị env cho AI.
```

### 5.2. Trên Microsoft Entra admin center

```text
[ ] App Registration staging riêng (không dùng chung local/prod).
[ ] Redirect URI staging dùng HTTPS, đúng path /api/microsoft/oauth/callback, khớp env.
[ ] Webhook URL staging dùng HTTPS, đúng path /api/webhooks/microsoft/mail, khớp env.
[ ] Permission tối thiểu: Mail.Read, offline_access, User.Read.
[ ] Không có permission ngoài scope (Mail.Send / Mail.ReadWrite / ...).
[ ] Nếu gặp lỗi consent/redirect, chỉ ghi mã lỗi chung (vd AADSTS50011/AADSTS65001); không paste token/secret.
```

### 5.3. Mailbox TEST + Telegram TEST

```text
[ ] Connect mailbox TEST qua staging UI (OAuth connect URL).
[ ] Mailbox TEST thuộc customer TEST; không gắn nhầm customer thật.
[ ] Bot TEST đã add vào TEST group; nếu dùng topic, TEST topic đã tồn tại.
[ ] Mapping mailbox TEST trỏ đúng TEST group/topic (một mailbox → một destination).
[ ] Test-send tới TEST group/topic thành công.
[ ] Gửi email verification TEST vào mailbox TEST từ nguồn test.
[ ] Không paste full email body / full verification code vào AI hoặc docs.
```

---

## 6. Bảng kết quả live E2E (điền sau khi user chạy thật)

> Ghi PASS / FAIL / BLOCKED và mô tả đã mask. **Không** ghi full code, full email body,
> token, secret hay connection string. Mỗi dòng "Bằng chứng đã mask" chỉ mô tả ngắn
> (vd "Telegram TEST nhận 1 message; code hiển thị đúng định dạng; log dùng sha256 ref").

| Hạng mục | Kết quả | Bằng chứng đã mask | Ghi chú |
|---|---|---|---|
| OAuth connect mailbox TEST | ☐ chưa chạy | | |
| Telegram TEST mapping (test-send) | ☐ chưa chạy | | |
| Webhook path (email mới → Telegram, đúng 1 lần) | ☐ chưa chạy | | task file §10 |
| Delta polling backup | ☐ chưa chạy | | task file §11 (ghi rõ nếu chưa cô lập được delta-only) |
| Duplicate case (webhook + delta → Telegram 1 lần) | ☐ chưa chạy | | task file §12 |
| Log/security spot-check | ☐ chưa chạy | | task file §13 |
| Health dashboard check | ☐ chưa chạy | | task file §14 |

Quy tắc PASS theo task file §20:
- Webhook / delta / duplicate được xác minh **hoặc** ghi rõ blocker.
- Telegram TEST group/topic nhận đúng kết quả, không gửi nhầm group.
- Logs/security spot-check đạt; health dashboard được kiểm tra nếu có.
- Không secret thật / không full code / không full email body / không `.env*` trong diff.

---

## 7. Điều kiện dừng khẩn cấp (rút gọn — chi tiết ở task file §15)

Dừng live test ngay nếu:

```text
- Telegram nhận message ở group/topic KHÔNG phải TEST.
- Mailbox khách hàng thật bị connect hoặc đọc nhầm.
- Staging trỏ nhầm production database hoặc production Redis.
- Log/UI hiển thị token, secret, full verification code, hoặc full email body.
- Microsoft OAuth redirect trỏ nhầm domain/môi trường.
- Worker local và Railway cùng trỏ staging DB/Redis gây xử lý trùng.
- Nghi ngờ secret bị lộ.
```

Khi dừng: tạm dừng worker liên quan nếu cần, KHÔNG commit, báo root cause, và nếu nghi
secret lộ thì user rotate secret trên provider tương ứng (Entra / BotFather / DB provider).

---

## 8. Những việc tôi KHÔNG làm

- Không chạy live mailbox E2E thay user (bắt buộc thao tác ngoài repo).
- Không đọc/in `.env`, `.env.local`, `.env.staging`, `.env.production`.
- Không ghi secret thật / token thật / connection string thật / encryption key thật /
  session secret thật / bot token thật / verification code / email body.
- Không deploy production; không dùng database/Redis production.
- Không dùng mailbox khách hàng thật; không dùng Telegram group/topic khách hàng thật.
- Không tạo migration; không sửa `prisma/schema.prisma`.
- Không sửa runtime OAuth/Graph code, worker/queue code, Telegram routing code (chưa có bug rõ ràng).
- Không sửa GitHub Actions workflow / không nới lỏng secret scan.
- Không sửa `docs/STAGING_DEPLOYMENT.md` (§5.9 smoke test + §5.12 đã cover live E2E checklist).
- Không cập nhật `docs/ROADMAP.md` trạng thái done (live E2E chưa chạy xong).
- Không mở rộng sang TASK-052 (scale test) hay production launch.

---

## 9. Rủi ro còn lại

- Kết quả live E2E phụ thuộc hoàn toàn vào cấu hình staging của user (env/secret manager,
  Entra, mailbox TEST, Telegram TEST). Repo đã sẵn sàng nhưng không thể tự xác nhận live.
- Delta-only path có thể khó cô lập nếu webhook luôn bật; khi đó ghi rõ giới hạn test thay
  vì kết luận PASS thiếu căn cứ (task file §11).
- Nếu live test lộ ra bug runtime, cần mở task sửa code riêng — nằm ngoài scope docs này.

---

## 10. Phần cần Gemini review kỹ

```text
[ ] Task file + report đúng scope TASK-051 (staging live E2E, không production).
[ ] Không dùng mailbox khách hàng thật; không dùng Telegram group/topic khách hàng thật.
[ ] Không có secret thật / không có .env* / không có URL DB-Redis production trong diff.
[ ] Không có full verification code; không có full email body trong diff.
[ ] Không có wording dễ gây secret-scan false positive (không có dòng keyword: value nhạy cảm).
[ ] Bảng kết quả live E2E (mục 6) phản ánh đúng "chưa chạy", không khẳng định PASS khi chưa có bằng chứng.
[ ] Webhook / delta polling / duplicate / log spot-check / health dashboard checklist đầy đủ.
[ ] Không sửa runtime code; không tạo migration; không sửa GitHub Actions.
[ ] ROADMAP chưa đánh done là đúng (live E2E chưa hoàn tất).
[ ] npm run verify PASS.
[ ] Kết luận PASS/FAIL theo GEMINI.md.
```
