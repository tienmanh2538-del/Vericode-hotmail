# TASK-088 — Railway Staging Deployment Source Alignment & Migration Safety Guard

> **TRẠNG THÁI: PHASE 2A–2D ĐÃ ĐƯỢC HUMAN THỰC THI TRÊN RAILWAY STAGING — EXECUTION EVIDENCE
> ĐÃ GHI (§24) — AWAITING ANTIGRAVITY FINAL EXECUTION REVIEW. TASK-088 CHƯA COMPLETED/CLOSED.**
>
> Lịch sử trạng thái:
> * Antigravity Architecture Review: PASS (kèm 2 Medium + 1 Low finding).
> * Correction re-review: **PASS — TASK-088 CORRECTIONS APPROVED, READY FOR HUMAN RAILWAY
>   EVIDENCE & DECISIONS** (các correction §2.1, §12.4, §13.7, §14.2 đã được duyệt).
> * Human hoàn thành Railway Evidence checklist §4 — kết quả sanitized ở **§21**.
> * Human/ChatGPT khoá OD-1 / OD-4 / OD-7 và quyết định Wait-for-CI — **§22**.
> * Phase 2 Plan Review: **PASS — TASK-088 PHASE 2 PLAN APPROVED FOR CONTROLLED HUMAN
>   EXECUTION** (§23).
> * Human đã thực thi **PHASE 2A → 2D** theo đúng §23 — evidence thực tế ở **§24**.
>   Verdict từng phase: 2A PASS / 2B PASS / 2C PASS / 2D PASS. Overall:
>   **TASK-088 CONTROLLED STAGING EXECUTION COMPLETED WITHOUT OBSERVED REGRESSION.**
>
> Mục 0–20 là kiến trúc Phase 1; §21–§23 là evidence/decisions/plan; §24 là execution evidence.
> Mọi thao tác Railway trong §24 do **HUMAN** thực hiện theo OD-7 — Claude không chạm Railway.
> TASK-088 **chưa** được ghi completed/closed cho tới khi Antigravity Final Execution Review PASS
> và close-out theo workflow (ROADMAP chưa cập nhật).
>
> **Phase 1 KHÔNG làm:** không thay đổi Railway settings, không đổi source branch, không bật/tắt
> Auto Deploy, không sửa Pre-Deploy Command, không redeploy, không pause/resume service, không chạy
> `prisma migrate deploy`, không chạy migration ở bất kỳ môi trường nào, không thao tác database
> staging (ngoài checklist read-only do Human tự chạy), không chạm production, không sửa runtime
> code / Prisma schema / migration / test / package scripts / deployment config / GitHub Actions,
> không sửa hay đọc `.env*`, không cleanup orphan subscription, không tự mở TASK-089, không cập nhật
> `docs/ROADMAP.md`, không commit, không push.
>
> **Ranh giới bằng chứng — đọc trước khi dùng bất kỳ kết luận nào:**
>
> * **REPO EVIDENCE** — Claude đọc trực tiếp file trong repo (hoặc chạy lệnh git read-only trên
>   repo local). Đây là bằng chứng chắc chắn, kiểm chứng lại được bằng cách mở đúng file.
> * **INHERITED HUMAN EVIDENCE** — Human đã quan sát trên Railway dashboard và ghi lại trong
>   TASK-087 §16. Không viết lại, không mở rộng.
> * **HUMAN VERIFICATION REQUIRED** — repo **không** chứng minh được. Tuyệt đối không suy đoán.
>
> **Quy ước tài liệu:** không ghi tên nhánh Git đầy đủ (tránh false positive của CI secret scan).
> Khi cần nhắc, viết là "nhánh làm việc của TASK-0xx".
>
> **Sanitized:** không connection string, không Redis URL, không token/refresh token, không client
> secret của Microsoft, không bot token của Telegram, không encryption/session key, không
> verification code, không full email body, không email address. Không bước nào trong tài liệu này
> yêu cầu Human paste secret vào chat AI.

---

## 0. Context và root operational problem

### 0.1. Vấn đề vận hành gốc

TASK-087 đã hoàn tất và đã **validate một rollout migration thành công trên staging**, nhưng đồng
thời phơi bày một vấn đề **kiến trúc deployment**, không phải vấn đề database:

```text
Một hành động Git thuần tuý (push lên nhánh mà Railway staging đang theo dõi)
đủ để TỰ ĐỘNG apply một database migration lên staging,
mà không đi qua bất kỳ cổng kiểm soát có chủ đích nào.
```

Với migration **additive thuần** thì điều này chấp nhận được. Với migration có **fail-closed data
precondition** (như partial unique index của TASK-086) thì đây là một cấu hình mà **thứ tự đúng chỉ
xảy ra do may mắn**: nếu staging tình cờ có dữ liệu vi phạm invariant, deploy sẽ fail ở Pre-Deploy
và người vận hành phải xử lý sự cố *sau khi* deploy đã bắt đầu, thay vì biết trước bằng một
preflight read-only rẻ tiền.

### 0.2. Vấn đề thứ hai — source alignment

Human xác nhận: hiện **cả bốn** Railway staging service (`web`, `worker-email`, `worker-delta`,
`worker-renewal`) vẫn đang dùng **source branch của TASK-086**.

Trong khi đó repo đã đi tiếp qua TASK-087 và đang ở TASK-088. Đây là một dạng **deployment drift**:
nguồn deploy đứng yên trên một nhánh task đã đóng, còn dòng phát triển thì đi tiếp trên các nhánh
task mới. Drift này **hiện tại vô hại** (xem §5.3 — chứng minh được từ repo), nhưng cơ chế tạo ra nó
là cơ chế sẽ tạo ra drift **có hại** ngay khi task tiếp theo có runtime change.

### 0.3. Câu hỏi TASK-088 phải trả lời

1. Kiến trúc deployment thật sự của 4 service là gì, chứng minh được từ repo tới đâu?
2. Bốn service có bắt buộc luôn chạy cùng một commit không, hay có thể lệch nhau một cách an toàn?
3. Staging nên lấy source từ đâu để việc deploy trở thành **một quyết định**, không phải **một tác
   dụng phụ của `git push`**?
4. Làm sao bảo đảm mọi migration có data precondition đều được preflight **trước** khi bất kỳ hành
   động nào có thể trigger migration?
5. Service nào được phép chạy `prisma migrate deploy`?

### 0.4. Không nằm trong scope TASK-088

Production rollout; orphan remote subscription cleanup; sửa runtime/schema/test; thay đổi bất kỳ
Railway setting nào; mở task mới; cập nhật ROADMAP thành "TASK-088 completed".

---

## 1. Evidence kế thừa từ TASK-087 (không viết lại)

Nguồn: `docs/tasks/TASK-087-staging-migration-preflight-rollout-validation.md` §16 và
`docs/reports/TASK-087-staging-migration-preflight-rollout-validation.md`.

### 1.1. Chronology thật (INHERITED HUMAN EVIDENCE — giữ nguyên)

```text
1. TASK-086 được push lên GitHub.
2. Railway staging AUTO DEPLOY (auto deploy khi push đang bật).
3. Pre-Deploy Command của service web chạy: npx prisma migrate deploy
4. Migration TASK-086 được xử lý; deploy log kết thúc bằng
   "All migrations have been successfully applied."
5. Web container start thành công và đạt trạng thái Ready.
6. TASK-087 Phase 1 (investigation) phát hiện hành vi automatic migration này.
7. Human thực hiện POST-DEPLOYMENT read-only verification.
```

**Prospective preflight chưa từng được thực thi trước migration này.** Không có câu nào trong
TASK-088 được phép ám chỉ ngược lại.

### 1.2. Những gì TASK-087 đã chứng minh (Human-observed)

| # | Fact | Loại |
|---|---|---|
| H1 | Railway staging **có** automatic deploy khi source branch được push | INHERITED HUMAN EVIDENCE |
| H2 | Service `web` **có** Pre-Deploy Command `npx prisma migrate deploy` | INHERITED HUMAN EVIDENCE |
| H3 | Service `web` khi đó kết nối nhánh làm việc của TASK-086 | INHERITED HUMAN EVIDENCE |
| H4 | Migration TASK-086 đã applied thành công (`finished_at` có giá trị, `applied_steps_count = 1`, không rolled back/failed) | INHERITED HUMAN EVIDENCE |
| H5 | Partial unique index tồn tại đúng tên / đúng cột / đúng predicate | INHERITED HUMAN EVIDENCE |
| H6 | Duplicate violations hiện tại = 0 | INHERITED HUMAN EVIDENCE |
| H7 | Cả 4 service ở trạng thái Active / Running | INHERITED HUMAN EVIDENCE |
| H8 | Core health checks (email pipeline, delta polling, queue/Redis, Telegram send) PASS; backlog và failed jobs = 0 | INHERITED HUMAN EVIDENCE |

### 1.3. Những gì TASK-087 **không** chứng minh

```text
[ ] Auto Deploy state của worker-email / worker-delta / worker-renewal
[ ] Pre-Deploy Command của worker-email / worker-delta / worker-renewal
[ ] Build Command / Start Command thực tế của từng service
[ ] Root directory / watch path của từng service
[ ] Deployed commit cụ thể của từng service
[ ] Source branch hiện tại của từng service (Human báo miệng là nhánh TASK-086,
    nhưng chưa có evidence per-service được ghi lại theo checklist)
```

Tất cả các mục trên là **HUMAN VERIFICATION REQUIRED** trong TASK-088 (§4).

### 1.4. Phân loại của TASK-087 được giữ nguyên

Sự kiện "migration chạy trước preflight" là **operational process deviation**, **KHÔNG** phải
database correctness failure. TASK-088 kế thừa nguyên vẹn phân loại này và chỉ làm một việc: thiết
kế cơ chế để nó không lặp lại với migration tương lai.

---

## 2. Kiến trúc deployment thực tế theo repo (REPO EVIDENCE)

### 2.1. F1 — Repo **không** chứa bất kỳ file cấu hình Railway nào

Kiểm chứng (read-only):

```bash
git ls-files | grep -iE "railway|nixpack|procfile|dockerfile|render\.yaml|\.toml$"
```

Kết quả duy nhất: `prisma/migrations/migration_lock.toml` (file của Prisma, không liên quan
platform). **Không có** `railway.json`, `railway.toml`, `Procfile`, `Dockerfile`, `nixpacks.toml`,
`render.yaml`.

**Phân loại nguyên nhân (chỉnh theo Antigravity Architecture Review — không phóng đại F1 thành
root cause):**

```text
DIRECT OPERATIONAL CAUSE của deviation ở TASK-087 là TỔ HỢP bốn yếu tố:
  (1) staging theo dõi một branch được push;
  (2) Auto Deploy đang bật;
  (3) service web có automatic Pre-Deploy migration;
  (4) không có CI/preflight deployment gate nào đứng trước hành động trigger.

F1 (cấu hình deploy chỉ tồn tại trên dashboard) KHÔNG phải causal root cause của deviation.
F1 là CONTRIBUTING ARCHITECTURAL / AUDITABILITY / CONFIG-DRIFT WEAKNESS.
```

Vì sao F1 vẫn là weakness đáng kể dù không phải nguyên nhân trực tiếp:

```text
Toàn bộ cấu hình deploy của staging — source repository, source branch, Auto Deploy on/off,
Build Command, Start Command, Pre-Deploy Command, root directory, watch paths —
sống HOÀN TOÀN trong Railway dashboard, KHÔNG có trong Git.

⇒ Không được version control.
⇒ Không xuất hiện trong git diff — reviewer không nhìn thấy từ repo.
⇒ Antigravity CLI không thể review.
⇒ GitHub Actions không thể kiểm tra.
⇒ Khó audit drift cấu hình giữa 4 service.
```

F1 giải thích vì sao một Pre-Deploy Command có khả năng apply migration tồn tại qua nhiều task mà
**không** tài liệu nào trong repo ghi nhận (xem F3) — tức nó khiến tổ hợp nguyên nhân trực tiếp ở
trên **không bị ai nhìn thấy**, chứ không tự nó gây ra deviation.

### 2.2. F2 — GitHub Actions **không** phải cổng deploy

`.github/workflows/ci.yml` (REPO EVIDENCE):

* trigger: `on: push` và `on: pull_request` — chạy cho **mọi** nhánh;
* các bước: secret pattern check → setup Node 22 → `npm ci` → `npm run db:generate` →
  `npm run db:validate` → `npm run verify`;
* **không có bước deploy nào.**

Kết hợp với H1 (Railway auto deploy on push):

```text
Một lệnh git push khởi động HAI tiến trình ĐỘC LẬP và SONG SONG:

  git push ──┬──> GitHub Actions CI  (lint + typecheck + test + build)
             └──> Railway auto deploy (build + Pre-Deploy migration + start)

CI KHÔNG chặn deploy. Deploy KHÔNG chờ CI.
```

**Finding F2:** cổng chất lượng tự động duy nhất của project chạy **song song với** deploy, không
phải **trước** deploy. Một commit làm fail CI vẫn có thể đã được deploy lên staging và đã chạy
migration xong trước khi CI báo đỏ.

### 2.3. F3 — Tài liệu repo mô tả migration là bước **thủ công**

`docs/STAGING_DEPLOYMENT.md` §5.7 và §5.12, `docs/reports/TASK-048-...`,
`docs/reports/TASK-049-...`, `docs/reports/TASK-059-...` đều mô tả migration như một **lệnh người
vận hành tự chạy**:

```text
[ ] Chạy migration: npx prisma migrate deploy  (KHÔNG migrate dev).
```

Kiểm chứng: `grep -rn -i "pre-deploy\|auto deploy\|migrate deploy" docs/` — **không** file nào
trước TASK-087 nhắc tới Railway Pre-Deploy Command hay Auto Deploy.

**Finding F3:** tài liệu repo và cấu hình Railway thực tế **đã lệch nhau trong nhiều task**. Đây là
divergence tài liệu/thực tế, cần được đóng lại ở Phase 2 (nhưng §5.12 của
`docs/STAGING_DEPLOYMENT.md` **không** được sửa trong Phase 1).

### 2.4. F4 — Build/start path chứng minh được từ `package.json`

`package.json` (REPO EVIDENCE):

```json
"build":  "next build",
"start":  "next start",
"verify": "npm run db:generate && npm run lint && npm run typecheck && npm run test && npm run build",
"postinstall": "prisma generate",
"worker:email":   "tsx scripts/run-email-worker.ts",
"worker:delta":   "tsx scripts/run-delta-polling-worker.ts",
"worker:renewal": "tsx scripts/run-subscription-renewal-worker.ts",
"reconcile:subscriptions": "tsx scripts/run-subscription-reconciliation.ts"
```

Bốn kết luận rút ra được:

1. **Không có npm script nào gọi `prisma migrate deploy`.** Migration chỉ có thể được kích hoạt bởi
   một lệnh `npx` đặt ở nơi khác — thực tế là Pre-Deploy Command của Railway (H2). Nghĩa là hành vi
   nguy hiểm nhất của pipeline nằm ở chỗ **không grep được trong repo**.
2. **`postinstall: prisma generate`** ⇒ mỗi service tự sinh Prisma Client từ `prisma/schema.prisma`
   **của commit mà chính nó deploy**. Prisma Client là per-service, không dùng chung. Do đó một
   service lệch commit sẽ có Prisma Client lệch schema-model.
3. **Ba worker chạy bằng `tsx`**, là `devDependencies`. Worker **không** cần output của `next build`
   nhưng **cần** dev dependencies lúc runtime.
4. `reconcile:subscriptions` **không** phải một trong bốn Railway service — nó là script thủ công.
   Điều này quan trọng ở §8 vì nó là một trong hai đường INSERT vào `GraphSubscription`.

### 2.5. F5 — Prisma / migration coupling

* `prisma/schema.prisma`: datasource PostgreSQL, url từ biến database URL của môi trường.
* `lib/prisma.ts`: một `PrismaClient` singleton, dùng chung bởi mọi runtime (web + 3 worker).
* Migration mới nhất: `prisma/migrations/20260829000000_task086_one_live_graph_subscription`.
  Đây là **raw SQL partial unique index**, cố ý không biểu diễn trong `schema.prisma`, và cố ý
  **fail closed**: nếu tồn tại mailbox có nhiều hơn một live row thì `prisma migrate deploy`
  **fail** và deploy dừng.
* Comment trong chính file migration đã ghi sẵn preflight read-only cần chạy **trước** deploy. Ở
  TASK-086/087 preflight đó đã không được chạy trước — không phải vì thiếu tài liệu, mà vì **không
  có cổng kỹ thuật nào chặn deploy lại để chờ nó**.

### 2.6. F6 — Shared runtime contracts (dùng cho §8 và §9)

| Contract | File nguồn (REPO EVIDENCE) | Bên ghi | Bên đọc |
|---|---|---|---|
| Prisma schema / database | `prisma/schema.prisma`, `lib/prisma.ts` | web + 3 worker | web + 3 worker |
| Queue name + job name | `services/queue/email-job.types.ts` (`EMAIL_QUEUE_JOB_NAMES.PROCESS_MICROSOFT_GRAPH_MESSAGE`) | web, worker-delta | worker-email |
| Job payload union | `EmailWebhookJobData` \| `EmailDeltaPollingJobData` cùng file | web (webhook), worker-delta | worker-email |
| Job id scheme (dedupe hàng đợi) | `services/queue/email-job-options.ts` — tiền tố `microsoft-webhook:` và `delta-polling:` | web, worker-delta | BullMQ / worker-email |
| Worker metrics (Redis) | `services/observability/worker-metrics.ts` — `WORKER_METRICS_KEY_PREFIX = 'obs:wm:'`, `WORKER_METRIC_FIELDS`, bucket 5 phút | worker-email | web (`/admin/health` qua `infra-observability.service.ts`) |
| Mailbox lock / send throttle (Redis) | `services/queue/redis-mailbox-lock.ts`, `redis-global-send-throttle.ts` | worker-email | worker-email |
| Microsoft credential refresh + rotation | `services/microsoft/refresh-access-token.service.ts`, `refresh-token-rotation.service.ts` | 3 worker | 3 worker (web ghi credential lúc OAuth callback) |
| Graph subscription lifecycle | `services/microsoft/graph-subscription.service.ts`, `mailbox-subscription-provisioning.service.ts` | web (INSERT), worker-renewal (update/expire), script reconcile (INSERT) | web (webhook clientState hash), worker-renewal |
| Encryption của credential | `lib/security/encryption.ts` | web + 3 worker | web + 3 worker |
| Env contract | `lib/env.schema.ts`, `lib/env.ts` | — | web + 3 worker |

Kiểm chứng nhanh (read-only):

```bash
grep -rn "mailbox-subscription-provisioning" --include=*.ts app services scripts
grep -rn "getWorkerMetricsRecorder\|readWorkerMetricsSnapshot" --include=*.ts app services
grep -n "WORKER_METRICS_KEY_PREFIX" services/observability/worker-metrics.ts
```

---

## 3. Service inventory matrix (4 service)

> Cột 7–9 là nơi **repo dừng lại**. Không suy đoán Railway dashboard.

### 3.1. `web`

| # | Mục | Nội dung |
|---|---|---|
| 1 | Runtime responsibility | Next.js app: admin UI, `/admin/health`, OAuth connect + callback, Graph webhook receiver, Telegram mapping/test-send API, mock-email API |
| 2 | Expected start command (repo) | build `npm run build` (`next build`) → start `npm run start` (`next start`) — khớp `docs/STAGING_DEPLOYMENT.md` §5.12 |
| 3 | Code/modules quan trọng | `app/api/webhooks/microsoft/mail/route.ts`, `app/api/microsoft/oauth/callback/route.ts`, `services/microsoft/mailbox-subscription-provisioning.service.ts`, `services/microsoft/webhook-notification.service.ts`, `services/queue/email-queue.ts` (producer), `services/observability/infra-observability.service.ts` (đọc metrics), `services/health/*` |
| 4 | Shared DB/schema | **Có.** Đọc/ghi `Mailbox`, `Customer`, `TelegramMapping`, `AuditLog`, `CodeEvent`; và là **một trong hai đường INSERT** vào `GraphSubscription` |
| 5 | Redis/queue | **Có.** Producer của email queue; reader của bucket metrics `obs:wm:` |
| 6 | Migration responsibility | Theo H2: **service duy nhất được biết là có** Pre-Deploy `npx prisma migrate deploy`. Repo **không** chứng minh điều này |
| 7 | Repo chứng minh source branch? | **KHÔNG** — HUMAN VERIFICATION REQUIRED |
| 8 | Repo chứng minh Auto Deploy? | **KHÔNG** — chỉ có INHERITED HUMAN EVIDENCE H1 cho service này |
| 9 | Repo chứng minh Pre-Deploy? | **KHÔNG** — chỉ có INHERITED HUMAN EVIDENCE H2 |
| 10 | Cần Human verify | source repo, source branch, deployed commit, Auto Deploy state, Pre-Deploy Command, Build Command, Start Command, root directory, đúng environment staging |

### 3.2. `worker-email`

| # | Mục | Nội dung |
|---|---|---|
| 1 | Runtime responsibility | Consumer BullMQ: mailbox → refresh token → fetch Graph message → detector Facebook/Meta → code extractor → dedupe → Telegram send |
| 2 | Expected start command (repo) | `npm run worker:email` → `tsx scripts/run-email-worker.ts` |
| 3 | Code/modules quan trọng | `services/queue/workers/email-worker.ts`, `email-worker-runner.ts`, `services/email/*`, `services/telegram/*`, `services/queue/mailbox-lock-factory.ts`, `global-send-throttle-factory.ts`, `services/observability/redis-worker-metrics.ts` (writer), `services/microsoft/refresh-*` |
| 4 | Shared DB/schema | **Có.** `Mailbox`, `ProcessedMessage`, `TelegramMapping`, `CodeEvent`, `AuditLog`, credential rows |
| 5 | Redis/queue | **Có — mạnh nhất.** Consumer duy nhất của email queue; writer duy nhất của metrics `obs:wm:`; dùng mailbox lock + throttle |
| 6 | Migration responsibility | Theo kiến trúc đề xuất: **không nên có.** Trạng thái thực tế: HUMAN VERIFICATION REQUIRED |
| 7 | Repo chứng minh source branch? | **KHÔNG** |
| 8 | Repo chứng minh Auto Deploy? | **KHÔNG** |
| 9 | Repo chứng minh Pre-Deploy? | **KHÔNG** |
| 10 | Cần Human verify | như §3.1 mục 10 |

### 3.3. `worker-delta`

| # | Mục | Nội dung |
|---|---|---|
| 1 | Runtime responsibility | Delta polling backup theo chu kỳ: phát hiện message mới khi webhook miss, đẩy job vào cùng email queue; xử lý backoff 403 và alert |
| 2 | Expected start command (repo) | `npm run worker:delta` → `tsx scripts/run-delta-polling-worker.ts` (biến thể `--once` chỉ dùng thủ công) |
| 3 | Code/modules quan trọng | `services/queue/workers/delta-polling-runner.ts`, `services/microsoft/delta-polling.service.ts`, `services/queue/delta-polling-queue.ts` (producer), `services/alerts/alert.service.ts`, `services/microsoft/refresh-*` |
| 4 | Shared DB/schema | **Có.** `Mailbox` (delta link / trạng thái polling / backoff), credential rows |
| 5 | Redis/queue | **Có.** Producer thứ hai của email queue |
| 6 | Migration responsibility | Theo kiến trúc đề xuất: **không nên có.** Thực tế: HUMAN VERIFICATION REQUIRED |
| 7–9 | Repo chứng minh? | **KHÔNG** cho cả ba |
| 10 | Cần Human verify | như §3.1 mục 10 |

### 3.4. `worker-renewal`

| # | Mục | Nội dung |
|---|---|---|
| 1 | Runtime responsibility | Gia hạn Graph subscription trước hạn; CAS claim theo `updatedAt`; xử lý 404/410 → EXPIRED; đánh dấu mailbox subscription-expired khi không còn live row nào khác |
| 2 | Expected start command (repo) | `npm run worker:renewal` → `tsx scripts/run-subscription-renewal-worker.ts` |
| 3 | Code/modules quan trọng | `services/queue/workers/subscription-renewal-runner.ts`, `services/microsoft/subscription-renewal.service.ts`, `graph-subscription.service.ts` (renew), `subscription-claim-window.ts`, `BLOCKING_SUBSCRIPTION_STATUSES` từ provisioning service, `services/logs/prisma-audit-log-store.ts` |
| 4 | Shared DB/schema | **Có.** `GraphSubscription` (UPDATE / expire — **không INSERT**), `Mailbox`, `AuditLog`, credential rows |
| 5 | Redis/queue | **KHÔNG.** Đây là service duy nhất **không** chạm email queue (kiểm chứng: `subscription-renewal-runner.ts` không import `email-queue` / `delta-polling-queue`) |
| 6 | Migration responsibility | Theo kiến trúc đề xuất: **không nên có.** Thực tế: HUMAN VERIFICATION REQUIRED |
| 7–9 | Repo chứng minh? | **KHÔNG** cho cả ba |
| 10 | Cần Human verify | như §3.1 mục 10 |

### 3.5. Tổng hợp cột 7–9

```text
Với CẢ BỐN service, repo KHÔNG chứng minh được:
  - source repository / source branch
  - deployed commit / revision
  - Auto Deploy state
  - Pre-Deploy Command
  - Build Command / Start Command thực tế
  - root directory / watch path

⇒ HUMAN VERIFICATION REQUIRED (§4). Đây là hệ quả trực tiếp của F1.
```

---

## 4. Railway human-evidence checklist (Human tự làm trên dashboard)

> **Quy tắc bảo mật của checklist này:** chỉ mở tab **Settings / Deployments** của service. **KHÔNG**
> mở, không đọc, không chụp, không copy tab **Variables**. Không cần bất kỳ giá trị secret nào để
> hoàn thành checklist. Nếu một ô Settings vô tình hiển thị giá trị nhạy cảm, **bỏ qua ô đó** và ghi
> `REDACTED`.

### 4.0. Bước 0 — xác nhận đúng project/environment

```text
[ ] Đang ở đúng Railway PROJECT staging (không phải production).
[ ] Đang ở đúng ENVIRONMENT staging.
[ ] Nhìn thấy đủ 4 runtime service: web, worker-email, worker-delta, worker-renewal.
[ ] Postgres và Redis của project này là bản staging riêng (KHÔNG dùng chung production).
```

Nếu **bất kỳ** dòng nào không xác nhận được ⇒ **STOP** (§19, S1).

### 4.1. Template lặp lại cho MỖI service

Điền đúng một bản cho `web`, một cho `worker-email`, một cho `worker-delta`, một cho
`worker-renewal`. Trả lời bằng chữ, không kèm ảnh chụp tab Variables.

```text
SERVICE: ................................ (web | worker-email | worker-delta | worker-renewal)

[ 1] Source repository                : ................ (tên repo GitHub; không cần URL đầy đủ)
[ 2] Source branch                    : ................ (chỉ cần: "nhánh TASK-0xx" hoặc tên nhánh)
[ 3] Deployed commit / revision       : ................ (7 ký tự đầu, nếu UI hiển thị;
                                                          nếu không hiển thị ghi "UI không hiển thị")
[ 4] Auto Deploy khi push             : BẬT / TẮT / KHÔNG RÕ
[ 5] Pre-Deploy Command               : (chép nguyên văn, hoặc ghi "TRỐNG")
[ 6] Build Command                    : (chép nguyên văn, hoặc ghi "TRỐNG — dùng mặc định")
[ 7] Start Command                    : (chép nguyên văn, hoặc ghi "TRỐNG — dùng mặc định")
[ 8] Root Directory                   : (chép nguyên văn, hoặc ghi "TRỐNG")
[ 9] Watch Paths / path filter        : (chép nguyên văn, hoặc ghi "TRỐNG" / "không thấy mục này")
[10] Environment                      : staging  (xác nhận lại)
[11] Trạng thái hiện tại              : Active / Running / Crashed / Sleeping
[12] Thời điểm deployment gần nhất    : ................ (ngày giờ, nếu UI hiển thị)
```

### 4.2. Ba câu hỏi quyết định (rút ra sau khi điền đủ 4 bản)

```text
Q1. Bốn service có CÙNG source branch không?          CÓ / KHÔNG / KHÔNG RÕ
Q2. Có bao nhiêu service có Pre-Deploy Command chứa "migrate deploy"?   ....... service
    (liệt kê tên service)
Q3. Bốn service có CÙNG deployed commit không?        CÓ / KHÔNG / UI không hiển thị
```

* Nếu **Q2 ≥ 2** ⇒ **STOP** (§19, S4) — nhiều service cùng có khả năng chạy migration mà kiến trúc
  chưa duyệt. Chỉ ghi finding, **không** sửa cấu hình trong Phase 1.
* Nếu **Q1 = KHÔNG** ⇒ ghi finding source drift; chưa sửa.
* Nếu **Q3 = KHÔNG** ⇒ đối chiếu §9 xem cặp service lệch nhau có vi phạm ràng buộc contract không.

### 4.3. Nếu cần ảnh chụp

Chỉ chụp phần **Settings → Source / Build / Deploy**. **Không** chụp:

```text
[ ] tab Variables (dưới bất kỳ hình thức nào)
[ ] connection string của database hay Redis
[ ] bất kỳ token, refresh token, client secret, bot token, encryption/session key nào
[ ] deploy log có in giá trị biến môi trường
```

### 4.4. Kiểm tra read-only trên database staging (tuỳ chọn, Human chạy)

Chỉ dùng để đối chiếu trạng thái migration; **read-only**, không sửa gì:

```sql
-- Danh sách migration đã áp dụng và trạng thái (không chứa dữ liệu khách hàng)
SELECT migration_name, finished_at, applied_steps_count, rolled_back_at
FROM "_prisma_migrations"
ORDER BY finished_at DESC NULLS FIRST
LIMIT 10;
```

Không chạy `prisma migrate deploy`, không `migrate dev`, không lệnh nào ghi dữ liệu.

---

## 5. Deploy-source findings

### 5.1. D-S1 — Nguồn deploy không được version control

Xem F1 (§2.1). Đây là finding nền tảng: mọi câu hỏi "service này đang chạy code nào" đều **không**
trả lời được từ repo.

### 5.2. D-S2 — Topology nhánh là một chuỗi tuyến tính, mỗi task một nhánh

REPO EVIDENCE:

```bash
git branch -r | wc -l                              # 93 nhánh remote
git merge-base --is-ancestor <tip TASK-086> HEAD   # thành công ⇒ quan hệ tổ tiên tuyến tính
```

Mỗi nhánh task được tạo từ tip của nhánh task trước, và **không có nhánh `main` / `master`** trong
danh sách remote. Hệ quả:

```text
Nhánh của TASK-086 KHÔNG BAO GIỜ tự tiến lên khi TASK-087 / TASK-088 được phát triển.
Nếu staging trỏ vào nhánh của một task đã đóng, staging ĐÓNG BĂNG tại đó
cho tới khi có người đổi source thủ công trên dashboard.
```

Đây chính xác là cơ chế tạo ra tình trạng "4 service kẹt lại trên TASK-086" mà Human mô tả. Nó
**không** phải lỗi, mà là hệ quả tất yếu của mô hình "staging theo nhánh task".

### 5.3. D-S3 — Source lag hiện tại là **vô hại**, và điều này chứng minh được từ repo

REPO EVIDENCE:

```bash
git diff --stat <tip TASK-086>..HEAD
#  docs/ROADMAP.md                          |   2 +
#  docs/reports/TASK-087-...md              | 352 +
#  docs/tasks/TASK-087-...md                | 880 +
#  3 files changed, 1234 insertions(+)
```

```text
Delta từ commit của TASK-086 tới HEAD = DOCS-ONLY.
Không có thay đổi runtime, schema, migration, test, package script hay CI.
```

Kết luận (không cần Human): **staging đang chạy đúng runtime code hiện hành của repo.** Không có
regression tiềm ẩn nào do source lag ở thời điểm này. Điều này khiến TASK-088 là **thời điểm lý
tưởng** để sửa mô hình source: chi phí đồng bộ hiện đang bằng không, và sẽ khác không ngay khi task
runtime tiếp theo hoàn tất.

### 5.4. D-S4 — Bốn service **có thể** lệch source mà không ai phát hiện

Không có cơ chế nào trong repo (test, CI, health check) so sánh commit giữa 4 service. `/admin/health`
báo trạng thái *chức năng*, không báo *phiên bản*. HUMAN VERIFICATION REQUIRED để biết hôm nay 4
service có thật sự cùng nguồn hay không.

---

## 6. Auto Deploy findings

| # | Finding | Loại |
|---|---|---|
| A1 | Auto deploy khi push **đang bật** cho service `web` | INHERITED HUMAN EVIDENCE (H1) |
| A2 | Auto deploy state của 3 worker **chưa biết** | HUMAN VERIFICATION REQUIRED |
| A3 | Auto deploy **không** chờ GitHub Actions | REPO EVIDENCE (F2) — CI không có bước deploy, và Railway không xuất hiện trong workflow |
| A4 | Với auto deploy bật, **mọi** commit push lên nhánh được theo dõi đều trigger deploy, kể cả **docs-only** | Suy ra từ A1 + F1 (không có watch path nào chứng minh được trong repo). Nếu Railway có cấu hình Watch Paths thì đó là dashboard state ⇒ HUMAN VERIFICATION REQUIRED (§4.1 mục 9) |
| A5 | Deploy của 4 service (nếu cùng theo dõi một nhánh) là **4 build độc lập**, hoàn tất ở **4 thời điểm khác nhau** | Suy ra từ mô hình service của Railway theo `docs/STAGING_DEPLOYMENT.md` §5.12 (mỗi service một entry riêng). ⇒ **không có deploy nguyên tử cho 4 service** |

**A5 là finding quan trọng nhất của mục này** và được dùng trực tiếp ở §8/§9: kể cả khi ta muốn "cả
bốn cùng một commit", Railway vẫn không cung cấp tính nguyên tử. Luôn tồn tại một cửa sổ thời gian
mà một số service đã ở release mới còn số khác vẫn ở release cũ.

---

## 7. Pre-Deploy findings

| # | Finding | Loại |
|---|---|---|
| P1 | Service `web` có Pre-Deploy Command `npx prisma migrate deploy` | INHERITED HUMAN EVIDENCE (H2) |
| P2 | Pre-Deploy Command của 3 worker **chưa biết** | HUMAN VERIFICATION REQUIRED |
| P3 | Repo **không** có npm script nào gọi `migrate deploy` | REPO EVIDENCE (F4) — nghĩa là hành vi này không grep được, không review được, không test được |
| P4 | Migration TASK-086 là **fail-closed**: nếu precondition sai thì Pre-Deploy fail và deploy dừng | REPO EVIDENCE — comment M2 trong file migration |
| P5 | Fail-closed hoạt động **đúng thiết kế** nhưng ở **sai thời điểm**: nó báo lỗi lúc deploy chứ không lúc quyết định | Phân tích kiến trúc |
| P6 | Nếu **nhiều** service cùng có Pre-Deploy `migrate deploy`, các lệnh sẽ chạy đồng thời trên cùng database | Suy ra từ A5. Prisma dùng advisory lock nên thường chỉ một tiến trình thực sự apply, nhưng service còn lại có thể chờ / timeout / fail deploy ⇒ deploy nhiễu và log khó đọc. **Chưa có evidence rằng điều này đang xảy ra** — xem §4.2 Q2 |

**Diễn giải P5 (quan trọng, tránh hiểu sai):** fail-closed **không** phải thứ cần sửa. TASK-086 thiết
kế đúng. Cái cần sửa là **vị trí của cổng quyết định**: hiện tại quyết định "có apply migration
không" bị nhúng vào một tác dụng phụ của `git push`, thay vì là một bước có người bấm.

---

## 8. Code-level service coherency analysis

> Câu hỏi: bốn service có **bắt buộc** cùng commit không? Câu trả lời chứng minh được từ code là
> **không** — nhưng có một tập ràng buộc cụ thể phải giữ.

### 8.1. Đồ thị coupling thật (REPO EVIDENCE)

```text
                       ┌──────────────────────────── PostgreSQL (Prisma) ───────┐
                       │  web ──── worker-email ──── worker-delta ──── worker-renewal
                       └────────────────────────────────────────────────────────┘
                                        (mọi service phụ thuộc schema)

  email queue (BullMQ / Redis):
        web ─(producer: webhook)─┐
                                 ├──> worker-email (consumer DUY NHẤT)
        worker-delta ─(producer)─┘
        worker-renewal:  KHÔNG tham gia queue

  metrics obs:wm: (Redis):
        worker-email (writer) ──────> web (/admin/health reader)

  GraphSubscription lifecycle:
        web              : INSERT  (OAuth connect/reconnect)
        script reconcile : INSERT  (chạy thủ công, KHÔNG phải service Railway)
        worker-renewal   : UPDATE / EXPIRE  (không INSERT)
        web (webhook)    : READ    (đối chiếu clientState hash)
```

Kiểm chứng câu "worker-renewal không INSERT": `grep -n "graphSubscription.create" services/` chỉ ra
đúng một chỗ — `services/microsoft/graph-subscription.service.ts`, được gọi từ provisioning service,
mà provisioning service chỉ có hai caller thật: route OAuth callback (web) và runner reconciliation
(script thủ công).

### 8.2. Trả lời năm câu hỏi bắt buộc

**(1) Service nào bắt buộc chạy cùng commit?**

Không có cặp nào **luôn luôn** bắt buộc. Ràng buộc là **theo loại thay đổi**, không theo service:

```text
BẮT BUỘC cùng release khi thay đổi chạm vào:
  - queue payload / job name / job id scheme        ⇒ web + worker-delta + worker-email
  - metrics key prefix hoặc field name obs:wm:      ⇒ worker-email + web
  - format ciphertext của credential                ⇒ cả 4 (web ghi lúc OAuth, worker đọc)
  - ngữ nghĩa status / invariant GraphSubscription  ⇒ web + worker-renewal
  - Prisma schema kiểu contract-phase (xoá/đổi cột) ⇒ cả 4 + migration
```

**(2) Service nào "nên" cùng release nhưng lệch tạm thời được?**

`worker-email` và `worker-delta` khi thay đổi chỉ nằm trong logic nội bộ của một bên và **payload giữ
nguyên**. Ví dụ: đổi ngưỡng backoff của delta polling, đổi keyword của detector. Lệch tạm thời an
toàn vì contract giữa hai bên không đổi.

**(3) Service nào deploy độc lập an toàn?**

`worker-renewal` là ứng viên rõ nhất: không tham gia queue, không ghi metrics mà web đọc, không
INSERT `GraphSubscription`. Miễn là thay đổi không đụng Prisma schema và không đụng service credential
dùng chung, `worker-renewal` deploy độc lập được.

Kế đến là `web` cho thay đổi thuần UI/route không chạm producer queue và không chạm reader metrics.

**(4) Lệch commit bao lâu thì chấp nhận được?**

Không có con số cứng chứng minh được từ code. Ranh giới chứng minh được là **theo bản chất**, không
theo thời gian:

```text
- Lệch KHÔNG chạm contract  : chấp nhận vô thời hạn về mặt correctness
                              (nhưng vẫn nên đóng lại trong cùng chu kỳ task để tránh
                               "không ai biết staging đang chạy gì" — đó là lý do vận hành,
                               không phải lý do correctness).
- Lệch CÓ chạm contract mở rộng (expand, backward-compatible)
                            : chấp nhận trong cửa sổ một lần promotion; phải đóng trước
                              khi có thay đổi contract kế tiếp.
- Lệch CÓ chạm contract thu hẹp (contract/breaking)
                            : KHÔNG chấp nhận ở bất kỳ độ dài nào.
```

Ràng buộc cứng duy nhất chứng minh được: **job đang nằm trong queue tồn tại lâu hơn một lần deploy.**
`services/queue/email-job-options.ts` giữ job hoàn tất tới 24 giờ và job thất bại tới 7 ngày. Nghĩa
là `worker-email` phiên bản mới **chắc chắn** sẽ gặp job do phiên bản cũ tạo ra ⇒ **consumer luôn
phải đọc được payload cũ**.

**(5) Điều kiện compatibility là gì?**

```text
C1. Consumer phải chấp nhận payload của CẢ phiên bản cũ và mới (do retention 24h/7d).
C2. Migration phải tương thích với code CŨ vẫn đang chạy (do A5 — không có deploy nguyên tử).
C3. Reader metrics phải chịu được bucket rỗng / field thiếu (đổi key = mất số liệu, không crash).
C4. Mọi service phải dùng CÙNG encryption key và CÙNG format ciphertext.
C5. Mọi service phải có đủ biến môi trường mà loader của nó yêu cầu; biến mới phải được set
    TRƯỚC promotion, nếu không service sẽ fail-closed lúc start.
C6. Chỉ MỘT chỗ được apply migration.
```

### 8.3. Kết luận coherency (không phóng đại)

```text
SAI  : "cả bốn service luôn phải chạy cùng commit".
ĐÚNG : "cả bốn service phải luôn ở trong một tập release TƯƠNG THÍCH,
        và mọi thay đổi chạm contract dùng chung phải được promotion cùng nhau
        theo đúng thứ tự expand → deploy → contract."
```

Vì Railway **không** deploy nguyên tử (A5), "cùng commit" là mục tiêu vận hành đáng mong muốn nhưng
**không phải** cơ chế an toàn. Cơ chế an toàn thật sự là **backward compatibility**.

---

## 9. Deployment impact matrix

Ký hiệu: **R** = cần redeploy, **–** = không cần, **⚠** = chỉ cần nếu chạm contract nêu trong ghi chú.

| # | Loại thay đổi | web | worker-email | worker-delta | worker-renewal | Migration | Same-commit hay rolling? | Thứ tự deploy khuyến nghị |
|---|---|---|---|---|---|---|---|---|
| 1 | Web-only UI / trang admin | **R** | – | – | – | Không | Rolling | web |
| 2 | Web API route không phải producer queue (mapping, test-send, connect-url) | **R** | – | – | – | Không | Rolling | web |
| 3 | Webhook route **có** đổi payload enqueue | **R** | **R** | ⚠ | – | Không | Backward-compatible bắt buộc | worker-email trước → web sau |
| 4 | worker-email-only: detector / extractor / dedupe / telegram retry | – | **R** | – | – | Không | Rolling | worker-email |
| 5 | worker-email đổi key hoặc field metrics `obs:wm:` | **R** | **R** | – | – | Không | Cùng promotion | worker-email → web (chấp nhận mất số liệu tạm thời) |
| 6 | worker-delta-only: chu kỳ, backoff, xử lý delta link | – | – | **R** | – | Không | Rolling | worker-delta |
| 7 | worker-delta đổi payload enqueue | – | **R** | **R** | – | Không | Backward-compatible bắt buộc | worker-email trước → worker-delta sau |
| 8 | worker-renewal-only: claim window, phân loại lỗi renew | – | – | – | **R** | Không | Rolling | worker-renewal |
| 9 | Shared library `lib/logger`, `lib/validation` | **R** | **R** | **R** | **R** | Không | Cùng promotion (không bắt buộc về correctness) | bất kỳ thứ tự |
| 10 | `lib/security/encryption` — **đổi format ciphertext** | **R** | **R** | **R** | **R** | Có thể | Cùng promotion, bắt buộc đọc được format cũ | reader trước → writer sau |
| 11 | `services/microsoft/refresh-*` (credential / rotation) | **R** | **R** | **R** | **R** | Không | Cùng promotion | 3 worker → web |
| 12 | Prisma Client / schema **additive** (thêm cột nullable, thêm model) | **R** | **R** | **R** | **R** | **Có (expand)** | Rolling được, migration phải chạy TRƯỚC code dùng cột mới | migration → mọi service |
| 13 | Prisma schema **contract** (xoá / đổi kiểu / thêm NOT NULL) | **R** | **R** | **R** | **R** | **Có (contract)** | Bắt buộc hai pha, không rolling một pha | pha 1 expand + deploy code → pha 2 migration contract |
| 14 | Migration có **data precondition fail-closed** (unique / partial unique / FK / CHECK) | **R** | **R** | **R** | **R** | **Có (fail-closed)** | **Bắt buộc preflight trước** (§13 CASE 3) | preflight → promotion → migration → verify → smoke |
| 15 | Queue job **name** hoặc queue **name** đổi | **R** | **R** | **R** | – | Không | Bắt buộc chạy song song hai tên trong một chu kỳ | consumer đọc cả hai → producer đổi → dọn tên cũ |
| 16 | Job id scheme đổi (dedupe hàng đợi) | **R** | ⚠ | **R** | – | Không | Rolling, chấp nhận dedupe yếu tạm thời (dedupe nội dung ở tầng `ProcessedMessage` vẫn giữ) | producer |
| 17 | Graph subscription lifecycle / ngữ nghĩa status | **R** | – | – | **R** | ⚠ | Cùng promotion | migration (nếu có) → web + worker-renewal |
| 18 | Telegram mapping / routing rule | **R** | **R** | – | – | ⚠ | Cùng promotion | migration (nếu có) → worker-email → web |
| 19 | Env/config contract: **thêm biến bắt buộc** | ⚠ | ⚠ | ⚠ | ⚠ | Không | Set Variables **trước** promotion cho mọi service dùng loader đó | Variables → promotion |
| 20 | Docs-only / test-only | – | – | – | – | Không | Không cần deploy | không deploy (xem §10.1) |

**Quy tắc thứ tự tổng quát rút ra từ bảng trên:**

```text
Khi MỞ RỘNG contract : bên ĐỌC lên trước, bên GHI lên sau.
Khi THU HẸP contract : bên GHI lên trước, bên ĐỌC dọn sau, và chỉ sau khi
                       không còn dữ liệu/định dạng cũ nào trong hệ thống.
Migration expand     : chạy TRƯỚC code dùng nó.
Migration contract   : chạy SAU khi code cũ đã rút hết.
```

---

## 10. Phân tích rủi ro của mô hình hiện tại (staging trỏ thẳng nhánh task)

### 10.1. Push docs-only cũng trigger deploy

Với A1 + A4, một commit chỉ sửa `docs/` vẫn khiến service rebuild và restart. Hệ quả cụ thể trên
kiến trúc này:

* `worker-email` restart ⇒ ngắt consumer trong lúc build; job vẫn nằm trong queue (không mất), nhưng
  độ trễ relay tăng trong cửa sổ đó.
* `worker-delta` restart ⇒ mất một hoặc vài chu kỳ polling.
* `web` restart ⇒ webhook có thể nhận lỗi tạm thời; Microsoft Graph sẽ retry, nhưng đây là rủi ro
  không cần thiết.
* Chính hai tài liệu của TASK-087 và TASK-088 là ví dụ: chúng thuần docs nhưng vẫn có khả năng gây
  redeploy toàn bộ nếu được push lên nhánh mà staging đang theo dõi.

### 10.2. Push runtime chưa review xong

Quy trình project (AGENTS.md) quy định chỉ commit sau khi review PASS. Nhưng đó là **kỷ luật quy
trình**, không phải **rào chắn kỹ thuật**. Với auto deploy bật, bất kỳ push nào — kể cả push sửa
gấp, push nhầm nhánh, push từ Cursor — đều lên staging ngay.

### 10.3. Migration đi chung commit với runtime

Migration và code implementation nằm trong cùng một commit (ví dụ commit của TASK-086 chứa cả
`prisma/migrations/...` lẫn `services/microsoft/...`). Với Pre-Deploy migration, **không thể tách**
"deploy code" khỏi "apply migration" — chúng là một hành động. Đây chính là lý do preflight không có
chỗ chen vào trong mô hình hiện tại.

### 10.4. Automatic deploy + automatic Pre-Deploy = quyết định bị ẩn

Kết hợp A1 + P1: hành động có hậu quả cao nhất trong toàn bộ pipeline (thay đổi lược đồ database)
được kích hoạt bởi hành động có tần suất cao nhất và ít nghi thức nhất (`git push`).

### 10.5. Rollback bất đối xứng

Railway rollback đưa **code** về bản trước. Nó **không** hoàn tác migration — Prisma không có
down-migration trong `prisma/migrations/`, và `migrate deploy` chỉ tiến, không lùi. Sau một
migration contract-phase, rollback code về bản cũ có thể tạo ra tình huống code cũ chạy trên schema
mới. Với migration **additive** (như TASK-086) thì rollback an toàn vì code cũ không biết đến index
mới và không bị nó cản (index chỉ chặn INSERT vi phạm invariant, mà invariant đó vốn là điều code cũ
cũng muốn giữ).

### 10.6. Nhiều service theo cùng hoặc khác nhánh

* Cùng nhánh: 4 build song song, hoàn tất lệch nhau (A5) ⇒ cửa sổ hỗn hợp phiên bản là **luôn tồn
  tại**, kể cả khi ta nghĩ là "deploy cùng lúc".
* Khác nhánh: drift không giới hạn, không có cảnh báo, chỉ phát hiện được bằng cách người vào
  dashboard nhìn từng service.

### 10.7. Nhánh task kế tiếp tạo từ nhánh task trước

Theo D-S2, mỗi nhánh task là một nhánh **mới**. Staging **không** tự theo. Vì vậy mô hình hiện tại
yêu cầu **một thao tác dashboard thủ công cho mỗi service, mỗi task** để giữ staging cập nhật — tức
là 4 thao tác/task, do một người không chuyên code thực hiện, không có checklist bắt buộc và không
có dấu vết trong Git.

### 10.8. Nguy cơ "kẹt lại" (đang hiện hữu)

Đây chính là tình trạng hôm nay: 4 service ở nguồn của TASK-086 trong khi repo đã ở TASK-088. Hiện
vô hại (D-S3), nhưng nếu TASK-089 có runtime change thì staging sẽ **im lặng** chạy code cũ trong
khi mọi người tin rằng nó chạy code mới — và cái giá phải trả là một phiên gỡ lỗi sai hướng.

### 10.9. Release không nhất quán giữa web và worker

Rủi ro cụ thể chứng minh được: nếu `web` được cập nhật (vì nó là service người ta hay nhìn nhất) mà
`worker-email` thì không, thì mọi thay đổi ở mục 3, 5, 10, 11, 18 của §9 sẽ vỡ contract mà
`/admin/health` **không** phát hiện — vì health check kiểm tra *chức năng*, không kiểm tra *phiên
bản*.

### 10.10. Bảng xếp hạng rủi ro

| Rủi ro | Mức | Đang hiện hữu? |
|---|---|---|
| Migration fail-closed chạy trước preflight | **CRITICAL** | Đã xảy ra một lần (TASK-087 §16) |
| Không có rào chắn kỹ thuật giữa push và deploy | **CRITICAL** | Có |
| Cấu hình deploy không version control, không review được | **HIGH** | Có |
| CI chạy song song thay vì trước deploy | **HIGH** | Có |
| Drift phiên bản giữa 4 service không phát hiện được | **HIGH** | Chưa (nhưng cơ chế đã sẵn) |
| Redeploy không cần thiết do docs-only push | **MEDIUM** | Có |
| Rollback bất đối xứng code/schema | **MEDIUM** | Có |
| Tài liệu repo lệch với cấu hình Railway thật | **MEDIUM** | Có (F3) |

---

## 11. Source / promotion models — đánh giá và so sánh

> Lưu ý xuyên suốt mục này: **khả năng thật sự của Railway UI (chọn nhánh, tắt auto deploy, deploy
> theo commit cụ thể, watch paths) KHÔNG chứng minh được từ repo.** Mọi option đều kèm điều kiện
> Human xác nhận ở §18.

### 11.1. Option A — giữ nguyên: staging trỏ thẳng nhánh task

* **Cách hoạt động:** mỗi task xong, Human đổi source của 4 service sang nhánh task mới.
* **An toàn:** thấp. Push = deploy = migration.
* **Kiểm soát promotion:** không có. Promotion chính là `git push`.
* **Rủi ro auto-deploy:** cao nhất.
* **Tương thích preflight:** kém — không có chỗ chen preflight vào (§10.3).
* **Rollback:** đổi source về nhánh cũ, hoặc redeploy bản cũ. Được, nhưng migration không lùi.
* **Vận hành cho người không chuyên code:** nặng — 4 thao tác dashboard mỗi task, dễ quên, dễ lệch.
* **Rủi ro lệch nguồn giữa các service:** cao (chính là §10.6, §10.8).
* **Độ phức tạp:** thấp về mặt thiết lập, cao về mặt kỷ luật vận hành.

### 11.2. Option B — nhánh staging chuyên dụng, nhận promotion sau quality gates

* **Cách hoạt động:** tạo một nhánh dài hạn dành riêng cho staging. Cả 4 service trỏ **cố định** vào
  nhánh đó và **không bao giờ** đổi source nữa. Sau khi task PASS `npm run verify` + Antigravity +
  CI, Human/Claude "promotion" bằng cách đưa commit của nhánh task vào nhánh staging.
* **An toàn:** cao. Push lên nhánh task **không còn** là hành động deploy.
* **Kiểm soát promotion:** rõ ràng — promotion là một hành động riêng, có chủ đích, để lại dấu vết
  trong Git.
* **Rủi ro auto-deploy:** vẫn còn nhưng đã bị **giới hạn vào đúng một hành động cố ý**. Đây là điểm
  mấu chốt: ta không cần tắt auto deploy, ta chỉ cần làm cho thứ nó theo dõi trở nên có ý nghĩa.
* **Tương thích preflight:** **tốt** — preflight nằm giữa "CI PASS" và "promotion" (§13).
* **Rollback:** đưa nhánh staging về commit trước rồi promotion lại; hoặc rollback trên dashboard.
  Có dấu vết Git.
* **Vận hành cho người không chuyên code:** **nhẹ nhất** — sau khi thiết lập một lần, Human **không
  bao giờ** phải đổi source trên dashboard nữa. Việc duy nhất là bấm "promotion" khi checklist cho
  phép.
* **Rủi ro lệch nguồn:** **thấp nhất** — 4 service khoá vào cùng một nhánh, không còn cơ chế nào tạo
  drift ngoài việc build hoàn tất lệch giờ (A5, không tránh được ở bất kỳ option nào).
* **Độ phức tạp:** trung bình — cần một lần thiết lập và một quy ước promotion.

### 11.3. Option C — nhánh release/promotion tách hẳn khỏi dòng phát triển

* **Cách hoạt động:** như B nhưng thêm một tầng: nhánh phát triển → nhánh staging → nhánh release
  (dùng cho production sau này).
* **An toàn:** cao nhất về lý thuyết.
* **Kiểm soát promotion:** rất mạnh, hai cổng.
* **Rủi ro auto-deploy:** thấp.
* **Tương thích preflight:** tốt.
* **Rollback:** tốt nhất — có một nhánh "đã biết là chạy được".
* **Vận hành cho người không chuyên code:** **nặng** — hai lần promotion, hai khái niệm nhánh, dễ
  nhầm. Với dự án hiện tại (một người vận hành, chưa có production rollout thật) đây là chi phí nhận
  thức không tương xứng lợi ích.
* **Rủi ro lệch nguồn:** thấp.
* **Độ phức tạp:** cao.

### 11.4. Option D — deploy theo commit/revision bất biến

* **Cách hoạt động:** thay vì theo nhánh, service được ghim vào một commit cụ thể; deploy là một
  hành động thủ công chọn đúng revision.
* **An toàn:** cao nhất — không có gì tự động xảy ra.
* **Kiểm soát promotion:** tuyệt đối.
* **Rủi ro auto-deploy:** bằng không.
* **Tương thích preflight:** tốt nhất.
* **Rollback:** tốt nhất — chọn lại revision cũ.
* **Vận hành cho người không chuyên code:** nặng — 4 lần thao tác thủ công mỗi lần deploy, và phải
  đọc/so khớp mã commit.
* **Rủi ro lệch nguồn:** trung bình — 4 lần chọn thủ công là 4 cơ hội chọn nhầm.
* **Độ phức tạp:** trung bình về thiết lập, cao về thao tác lặp lại.
* **HUMAN VERIFICATION REQUIRED:** Railway có cho phép ghim commit/redeploy một revision cụ thể theo
  cách vận hành được hay không — repo không chứng minh được.

### 11.5. Bảng so sánh

| Tiêu chí | A (nhánh task) | B (nhánh staging) | C (release tách) | D (ghim commit) |
|---|---|---|---|---|
| Safety | Thấp | **Cao** | Rất cao | Rất cao |
| Kiểm soát promotion | Không có | **Rõ ràng** | Rất mạnh | Tuyệt đối |
| Rủi ro auto-deploy | Cao | **Đã khoanh vùng** | Thấp | Không |
| Tương thích migration preflight | Kém | **Tốt** | Tốt | Tốt nhất |
| Rollback | Được | **Tốt** | Tốt nhất | Tốt nhất |
| Vận hành cho người không chuyên code | Nặng, lặp lại | **Nhẹ nhất** | Nặng | Nặng |
| Rủi ro lệch nguồn giữa 4 service | Cao | **Thấp nhất** | Thấp | Trung bình |
| Độ phức tạp thiết lập | Thấp | **Trung bình** | Cao | Trung bình |
| Dấu vết trong Git | Không | **Có** | Có | Một phần |

---

## 12. Recommended architecture (đề xuất Phase 1 — chưa được duyệt)

### 12.1. Khuyến nghị chính

```text
OPTION B — một nhánh staging chuyên dụng, cả 4 service khoá cố định vào nhánh đó,
           deploy được kích hoạt bằng PROMOTION có chủ đích, không phải bằng push thường ngày.
```

**Lý do chọn B thay vì C hoặc D** (dựa trên evidence, không dựa trên sở thích):

1. B loại bỏ đúng **nguyên nhân gốc** của deviation ở TASK-087 — sự trùng nhau giữa "push code" và
   "deploy + migrate" — mà **không** thêm bước thủ công lặp lại nào cho Human.
2. B loại bỏ luôn nguyên nhân gốc của "kẹt trên nguồn của TASK-086" (§10.8): sau khi khoá nguồn một
   lần, **không còn thao tác đổi source nào nữa**, nên không còn cơ hội quên.
3. C thêm một tầng nhánh mà dự án chưa cần (production rollout thật chưa nằm trong scope hiện tại) —
   vi phạm YAGNI của `.claude/rules/ecc/common/coding-style.md`.
4. D an toàn hơn nhưng chuyển toàn bộ gánh nặng sang thao tác thủ công lặp lại của một người không
   chuyên code — đúng kiểu thiết kế mà thực tế sẽ bị bỏ qua sau vài task.

### 12.2. Bổ sung khuyến nghị (kết hợp một phần D)

Đề xuất **một ngoại lệ có kiểm soát**: với task thuộc CASE 3 (§13), Human **tạm thời** tắt Auto
Deploy của service `web` **trước** khi promotion, chạy preflight, rồi bấm deploy thủ công. Nghĩa là:

```text
Mặc định  : B (auto deploy trên nhánh staging — nhanh, ít thao tác).
CASE 3    : B + tắt auto deploy tạm thời cho web + deploy thủ công sau preflight PASS.
```

Nếu Railway **không** cho phép tắt/bật Auto Deploy per-service một cách dễ dàng
(**HUMAN VERIFICATION REQUIRED**), phương án thay thế được nêu ở §13.5.

### 12.3. Những gì khuyến nghị này **không** đòi hỏi

```text
[x] KHÔNG đòi đổi runtime code.
[x] KHÔNG đòi đổi Prisma schema hay migration.
[x] KHÔNG đòi sửa GitHub Actions.
[x] KHÔNG đòi thêm dependency hay dịch vụ mới.
[x] KHÔNG đòi bỏ Pre-Deploy migration (chỉ đòi nó có đúng MỘT chủ sở hữu — §14).
[x] KHÔNG phá dây chuyền ChatGPT → Claude Code → Antigravity CLI → Cursor → GitHub Actions.
```

Điểm cuối quan trọng: promotion là **một bước được thêm vào SAU** GitHub Actions, không thay thế bước
nào. Dây chuyền trở thành:

```text
ChatGPT → Claude Code → Antigravity CLI → Cursor → GitHub Actions → [PREFLIGHT nếu CASE 3] → PROMOTION
```

### 12.4. Promotion commit identity invariant (bổ sung theo Antigravity review)

Khái niệm "promotion" của Option B phải khoá chặt **commit identity**. Invariant bắt buộc:

```text
REVIEWED COMMIT == PROMOTED COMMIT == DEPLOYED COMMIT
```

Cụ thể hoá cho mô hình dedicated staging branch:

* Nhánh task **KHÔNG** phải nhánh mà Railway staging theo dõi.
* Push lên nhánh task chỉ để GitHub Actions chạy — không phải hành động deploy.
* Promotion chỉ được phép xảy ra sau khi ĐỦ:
  1. `npm run verify` PASS;
  2. Antigravity review PASS;
  3. nhánh task đã push thành công;
  4. GitHub Actions trên nhánh task PASS;
  5. preflight CASE 3 PASS (nếu applicable, §13).
* Promotion phải **giữ nguyên commit identity**. Cơ chế mặc định được khuyến nghị:

```text
git switch <nhánh staging>
git merge --ff-only <nhánh task đã được duyệt>
```

* **KHÔNG** dùng merge commit, squash hay rebase trong promotion path nếu chúng làm thay đổi
  commit SHA đã được review — SHA mới là SHA **chưa ai review**.
* Nếu fast-forward **không** thực hiện được (nhánh staging đã có commit không nằm trong nhánh task):
  **STOP.** Không tự merge/rebase/cherry-pick. Báo Human/ChatGPT quyết định.

**Post-promotion verification principle:**

```text
Deployed revision trên Railway phải được ĐỐI CHIẾU với approved/promoted commit
trước khi coi rollout là thành công. Deploy "xong" chưa phải bằng chứng —
phải xác nhận nó deploy ĐÚNG commit đã duyệt.
```

Phase 1 chỉ document kiến trúc này. **KHÔNG** tạo nhánh staging, **KHÔNG** chạy lệnh promotion
thực tế trong TASK-088 Phase 1.

---

## 13. Migration safety guard architecture (trọng tâm)

### 13.1. Phân loại migration bắt buộc — Claude phải khai báo ở đầu mỗi task runtime

| Case | Định nghĩa | Ví dụ | Cổng bắt buộc |
|---|---|---|---|
| **CASE 1** | Task **không** có migration | docs, test, đổi logic thuần | Không cần preflight. Promotion bình thường |
| **CASE 2** | Migration **additive**, không có data precondition | thêm cột nullable, thêm bảng mới, thêm index **không** unique | Không cần preflight dữ liệu. Vẫn cần post-deploy verify |
| **CASE 3** | Migration có **fail-closed data precondition** | unique / **partial unique** index, `NOT NULL`, FK mới, `CHECK`, hoặc bất kỳ migration nào yêu cầu dữ liệu hiện hữu thoả invariant | **BẮT BUỘC** read-only preflight PASS **trước** mọi hành động có thể trigger migration, **và** khai báo đúng chế độ chống race A/B/C/D (§13.7) |

Migration của TASK-086 là **CASE 3**. Bất kỳ migration nào tương tự trong tương lai cũng vậy.

**Quy tắc phân loại (không được suy đoán):** nếu không chắc là CASE 2 hay CASE 3, **coi như CASE 3**.

### 13.2. Nguyên tắc trung tâm

```text
Preflight phải chạy trước hành động có thể TRIGGER migration,
chứ không phải trước lệnh migrate.

Trong mô hình hiện tại (Option A) hai thứ đó là MỘT: hành động trigger chính là `git push`.
⇒ Preflight sẽ luôn muộn.

Trong Option B chúng TÁCH RA:
  - `git push` lên nhánh task      : KHÔNG trigger deploy, KHÔNG trigger migration.
  - promotion vào nhánh staging     : TRIGGER deploy, TRIGGER migration.
⇒ Preflight có một chỗ đứng tự nhiên: NGAY TRƯỚC promotion.
```

Đây là toàn bộ lý do kiến trúc vì sao §12 khuyến nghị Option B: **nó tạo ra chỗ trống để cắm cổng
preflight vào, mà không cần thêm nghi thức nào cho các task không có migration.**

### 13.3. Ordering cho CASE 3 (đề xuất)

```text
 1. Claude Code implement (runtime + migration + test)         [không đụng staging]
 2. npm run verify PASS                                        [local]
 3. Antigravity CLI review PASS                                [không đụng staging]
 4. Cursor xem diff / Human duyệt                              [không đụng staging]
 5. git commit + git push lên NHÁNH TASK                       [KHÔNG deploy — đây là điểm mấu chốt]
 6. GitHub Actions CI PASS                                     [cổng tự động]
 7. ── CỔNG PREFLIGHT ──
    Human chạy read-only preflight query trên staging DB
    (query lấy nguyên văn từ comment M2 trong file migration),
    THEO ĐÚNG chế độ chống race đã khai báo cho migration đó (§13.7 — A/B/C/D)
 8. Đọc kết quả:
      - Kết quả RỖNG  ⇒ PASS ⇒ được phép sang bước 9
      - Kết quả KHÁC RỖNG ⇒ STOP. Không promotion. Không deploy.
        Ghi finding, đưa Human/ChatGPT quyết định remediation.
 9. PROMOTION vào nhánh staging (hành động deploy duy nhất) — bằng fast-forward,
    giữ nguyên commit identity theo §12.4; ff không được ⇒ STOP
10. Pre-Deploy của web chạy `npx prisma migrate deploy`
11. Post-deploy verification (read-only):
      - deployed revision trên Railway khớp với approved/promoted commit (§12.4)
      - trạng thái migration record
      - đối tượng DB được tạo đúng (tên / cột / predicate)
      - invariant hiện tại không bị vi phạm
12. Smoke từng service theo §15
13. Cập nhật docs/ROADMAP.md
14. Báo cáo hoàn tất
```

**So sánh trực tiếp với những gì đã xảy ra ở TASK-086/087:**

| Bước | TASK-086/087 (thực tế) | Đề xuất TASK-088 |
|---|---|---|
| Push lên nhánh task | **trigger deploy + migration** | không trigger gì |
| Preflight | **không chạy trước migration** | cổng bắt buộc, trước promotion |
| Migration | tự động, không ai bấm | chạy sau một hành động có chủ đích |
| Nếu precondition sai | phát hiện lúc deploy fail | phát hiện lúc preflight, **trước** khi động vào staging |

### 13.4. Ordering cho CASE 1 và CASE 2

```text
CASE 1 (không migration):
  verify → Antigravity → push nhánh task → CI PASS → promotion (nếu task cần lên staging)
  → smoke các service bị ảnh hưởng theo §9 → ROADMAP.
  KHÔNG cần preflight. KHÔNG cần thao tác database.

CASE 2 (additive, không precondition):
  như CASE 1, cộng thêm post-deploy verification đọc trạng thái migration record
  và xác nhận đối tượng mới tồn tại. KHÔNG cần preflight dữ liệu.
```

Điểm thiết kế quan trọng: **không** bắt task CASE 1/CASE 2 phải chịu nghi thức của CASE 3. Một quy
trình nặng đều tay là quy trình sẽ bị bỏ qua.

### 13.5. Phương án dự phòng nếu không tách được push khỏi deploy

Nếu Human quyết định **giữ Option A**, hoặc Railway không cho phép cấu hình như §12
(**HUMAN VERIFICATION REQUIRED**), thì cổng preflight bắt buộc phải dịch lên **trước bước 5**:

```text
CASE 3 dưới Option A:
  verify PASS → Antigravity PASS → ── PREFLIGHT ── → chỉ khi PASS mới được git push.
```

Nhược điểm rõ ràng (phải nói thẳng): preflight khi đó chạy **trước** GitHub Actions CI, nên một
commit fail CI vẫn có thể đã deploy và đã migrate. Đây là lý do §12 không khuyến nghị giữ Option A.

Phương án dự phòng thứ hai, độc lập với lựa chọn nhánh: **gỡ `migrate deploy` khỏi Pre-Deploy** và
chạy migration như một lệnh one-off có người bấm. An toàn nhất cho CASE 3, nhưng thêm gánh nặng vận
hành cho mọi CASE 2 — xem §18, quyết định OD-4.

### 13.6. Bất biến phải giữ cho mọi migration tương lai

```text
I1. Mọi migration phải tương thích với code CŨ đang chạy (do A5 — không có deploy nguyên tử).
I2. Migration CASE 3 chỉ được chạy sau preflight PASS.
I3. Preflight phải là READ-ONLY và phải là chính query ghi trong comment của file migration.
I4. Migration KHÔNG BAO GIỜ tự "dọn dẹp" dữ liệu để tự thoả precondition (giữ nguyên quyết định M2
    của TASK-086: fail closed, không chọn winner, không sửa lifecycle state).
I5. Chỉ một chỗ được apply migration (§14).
I6. Sau mỗi migration phải có post-deploy verification read-only.
I7. Preflight PASS chỉ có giá trị khi precondition CÒN ĐÚNG cho tới lúc migration enforce nó (§13.7).
```

### 13.7. Preflight-to-migration race — precondition phải giữ được cho tới lúc migration enforce nó (bổ sung theo Antigravity review)

Read-only preflight chỉ là một **snapshot**. Race sau đây là có thật và CASE 3 phải cover:

```text
preflight PASS
  → application writer vẫn đang chạy
  → dữ liệu MỚI vi phạm precondition được ghi vào
  → migration chạy
  → migration VẪN FAIL.
(fail-closed hoạt động đúng thiết kế, nhưng preflight đã trở nên vô nghĩa.)
```

Nguyên tắc trung tâm:

```text
Mục tiêu của cổng preflight KHÔNG phải "query từng PASS một lần".
Mục tiêu thật là: PRECONDITION MUST REMAIN TRUE UNTIL THE MIGRATION ENFORCES IT.
```

Do đó mỗi migration CASE 3 phải được khai báo (trong task file của chính migration đó, Human xác
nhận) thuộc đúng **một** trong bốn chế độ sau:

**A — READ-ONLY PREFLIGHT ALONE ĐỦ.** Chỉ được khai báo A khi chứng minh được từ code một trong hai:

```text
- KHÔNG có relevant writer nào hoạt động trong cửa sổ rollout
  (đường ghi vào invariant chỉ là thao tác thủ công đang không diễn ra); hoặc
- một application-level correctness guard ĐÃ được deploy và ĐANG enforce đúng invariant đó
  trước khi preflight/migration chạy.
```

Việc "A có áp dụng được không" phải lập luận từ code cho **từng** migration — không mặc định.

**B — TWO-PHASE GUARD REQUIRED.** Nếu runtime hiện tại vẫn có thể tạo dữ liệu vi phạm:

```text
Phase A: deploy một application guard BACKWARD-COMPATIBLE enforce invariant ở tầng service TRƯỚC.
         Verify guard operational (test/log/smoke evidence).
Sau đó : read-only preflight → PASS → promotion/apply migration.
```

**C — WRITER QUIESCE REQUIRED.** Nếu không thể deploy guard trước và writer vẫn có thể phá
precondition:

```text
1. Pause/quiesce CHỈ writer/service liên quan tới invariant (không pause toàn hệ thống).
2. Xác minh writer đã thật sự ngừng tạo write thuộc invariant (queue/log evidence).
3. Chạy LẠI preflight SAU khi quiesce.
4. Migration → post-deploy verify.
5. Resume writer → smoke.
```

Phase 1 chỉ document nguyên tắc này — **KHÔNG** pause service nào trong TASK-088.

**D — STOP / MULTI-STAGE MIGRATION.** Nếu migration không backward-compatible với mixed-version
services (vi phạm I1), hoặc không có cách nào bảo đảm precondition ổn định bằng A/B/C:

```text
STOP. Tách thành multi-stage expand/contract hoặc một task architecture riêng.
Không tự implement trong TASK-088 Phase 1. Không tự gán số task.
```

---

## 14. Pre-Deploy ownership recommendation

### 14.1. Có nên chỉ một service chạy `prisma migrate deploy`?

**Có.** Lý do (dựa trên evidence, không dựa trên quy ước):

1. **A5** — 4 service deploy song song. Nếu nhiều service cùng có Pre-Deploy migration, các lệnh
   `migrate deploy` sẽ chạy đồng thời trên cùng một database. Prisma dùng advisory lock nên thường
   chỉ một tiến trình thực sự apply, nhưng những tiến trình còn lại phải chờ hoặc có thể fail ⇒
   deploy nhiễu, log khó đọc, và với migration **fail-closed** thì rất khó phân biệt "migration fail
   vì dữ liệu sai" với "deploy fail vì tranh chấp lock".
2. **Nguyên tắc một điểm serialization** — đây đúng là nguyên tắc mà TASK-086 đã áp dụng ở tầng
   database (một partial unique index làm điểm serialization duy nhất). Cùng nguyên tắc nên áp cho
   tầng deploy.
3. **Khả năng quan sát** — một chủ sở hữu nghĩa là chỉ có một deploy log cần đọc khi migration lỗi.

### 14.2. Service nào nên là chủ sở hữu?

**Đề xuất: `web`.** Đây vẫn là **RECOMMENDATION, KHÔNG phải locked decision** — chỉ được khoá sau
khi Human hoàn thành Railway evidence checklist (§4) và Human/ChatGPT quyết định OD-4.

**Lý do CHÍNH (đúng cho mọi lựa chọn executor, không riêng web):**

1. Migration phải có đúng **một executor duy nhất** — một điểm serialization ở tầng deploy (§14.1).
2. Cần **ordering deterministic**: migration chạy tại một điểm biết trước trong pipeline, không phải
   "service nào build xong trước thì chạy".
3. Tránh **4 service cạnh tranh / chạy migration lặp** trên cùng một database (hệ quả của A5).
4. Deployment + smoke của `web` cung cấp **một điểm kiểm soát rõ ràng**: web có trạng thái Ready và
   deploy log dễ đọc, nên câu hỏi "migration đã xong và thành công chưa" trả lời được tại đúng một
   chỗ. Ba worker là tiến trình nền không có health endpoint riêng ⇒ migration lỗi ở đó khó phát
   hiện hơn nhiều.

**Supporting considerations — KHÔNG phải correctness proof cho migration ownership:**

* `web` là service duy nhất trong bốn service có đường INSERT vào `GraphSubscription`
  (`app/api/microsoft/oauth/callback/route.ts` → `ensureInboxSubscriptionForConnectedMailbox`, F8).
  Điều này liên quan tới invariant TASK-086 **nói riêng**, nhưng không chứng minh web phải sở hữu
  migration **nói chung**.
* `/admin/health` nằm trên web — tiện cho kiểm chứng, không phải bằng chứng bắt buộc.
* Web **đã** là executor trên thực tế (H2) ⇒ nếu giữ nguyên thì chi phí thay đổi cấu hình cho
  Phase 2 thấp — đây là cân nhắc vận hành, không phải lập luận correctness.

**Alternative vẫn để mở (chờ OD-4):** dedicated/manual one-off migration executor — gỡ
`migrate deploy` khỏi Pre-Deploy và chạy migration như một lệnh có người bấm (§13.5). Là option cần
Human decision nếu Railway capability phù hợp.

### 14.3. Ba service còn lại nên có Pre-Deploy migration không?

**Không.** Pre-Deploy Command của `worker-email`, `worker-delta`, `worker-renewal` nên **trống** (hoặc
chứa lệnh không liên quan đến migration).

**Đánh đổi phải nói rõ:** vì worker **không** chờ migration, và deploy không nguyên tử (A5), một
worker phiên bản mới **có thể start trước khi web hoàn tất migration**. Do đó bất biến **I1** ở §13.6
không phải lời khuyên — nó là **điều kiện cần**. Nếu một task tương lai cần worker phụ thuộc chặt vào
schema mới, phương án đúng **không** phải là thêm Pre-Deploy migration cho worker, mà là:

```text
- hoặc dùng migration expand-only rồi mới promotion code dùng cột mới ở chu kỳ sau;
- hoặc Human chủ động promotion `web` trước, xác nhận migration xong, rồi mới promotion worker
  (khả thi nếu tách được thời điểm deploy giữa các service — HUMAN VERIFICATION REQUIRED).
```

### 14.4. Làm sao tránh nhiều service cùng chạy migration?

```text
G1. Quy tắc kiến trúc: đúng MỘT service (web) được có Pre-Deploy migration. Ghi vào tài liệu.
G2. Kiểm chứng định kỳ bằng §4.2 câu Q2 — đếm số service có "migrate deploy" trong Pre-Deploy.
G3. Bổ sung một dòng vào checklist của mọi task có migration:
    "Đã xác nhận Pre-Deploy Command của 3 worker là TRỐNG."
G4. KHÔNG dựa vào advisory lock của Prisma như một cơ chế an toàn — nó là chi tiết cài đặt,
    không phải hợp đồng kiến trúc.
```

### 14.5. Nếu thực tế khác khuyến nghị

```text
Phase 1 CHỈ ghi finding. KHÔNG sửa Railway settings.
Nếu §4.2 Q2 cho kết quả ≥ 2 service có Pre-Deploy migration:
  ⇒ kích hoạt STOP condition S4 (§19)
  ⇒ ghi vào report, chuyển Human/ChatGPT quyết định
  ⇒ việc sửa thuộc Phase 2, sau Antigravity Architecture Review.
```

---

## 15. Future runtime-task deployment workflow

### 15.1. Mười câu trả lời bắt buộc

**1. Khi nào một task chỉ cần commit/push mà KHÔNG cần đổi staging?**

```text
- task docs-only (như TASK-087 và TASK-088);
- task chỉ sửa test;
- task runtime mà Human chủ động chưa muốn đưa lên staging.
Dưới Option B: không promotion ⇒ staging không đổi. Không thao tác dashboard nào.
```

**2. Khi nào `web` cần redeploy?** Khi thay đổi chạm: `app/**`, `components/**`, service mà web
import (provisioning, webhook-notification, telegram mapping, health, `infra-observability`),
`lib/security/encryption`, `lib/env*`, Prisma schema/client, hoặc metrics key mà web đọc.

**3. Khi nào `worker-email` cần redeploy?** Khi chạm: `services/queue/workers/email-worker*`,
`services/email/**`, `services/telegram/**`, `services/queue/mailbox-*`, `global-send-throttle*`,
`services/observability/*worker-metrics*`, `services/microsoft/refresh-*`, `services/logs/**`, Prisma
schema/client, hoặc payload/job-name của queue.

**4. Khi nào `worker-delta` cần redeploy?** Khi chạm:
`services/queue/workers/delta-polling-runner.ts`, `services/microsoft/delta-polling.service.ts`,
`services/queue/delta-polling-queue.ts`, `services/alerts/**`, `services/microsoft/refresh-*`, Prisma
schema/client, hoặc biến môi trường delta polling.

**5. Khi nào `worker-renewal` cần redeploy?** Khi chạm:
`services/queue/workers/subscription-renewal-runner.ts`,
`services/microsoft/subscription-renewal.service.ts`, `graph-subscription.service.ts` (phần renew),
`subscription-claim-window.ts`, `BLOCKING_SUBSCRIPTION_STATUSES`, `services/logs/**`,
`services/microsoft/refresh-*`, Prisma schema/client, hoặc biến môi trường renewal.

**6. Khi nào cả bốn cần cùng promotion?** Khi chạm bất kỳ mục nào ở §9 hàng 9–14, 17–19: Prisma
schema/migration, `lib/env*`, `lib/logger`, `lib/security/encryption`, `services/microsoft/refresh-*`,
lifecycle Graph subscription, contract env.

**7. Nếu có migration thì migration chạy ở đâu, khi nào?** Ở Pre-Deploy Command của **`web`** và chỉ
ở đó (§14). Thời điểm: ngay khi promotion. Với **CASE 3**, chỉ sau khi preflight PASS (§13.3).

**8. Khi nào cần smoke từng service?**

```text
- Service nào được redeploy ⇒ smoke service đó.
- Có migration ⇒ smoke CẢ BỐN, không ngoại lệ.
- Đổi contract queue hoặc metrics ⇒ smoke web + worker-email (+ worker-delta nếu là producer).

Smoke tối thiểu theo service:
  web            : trang admin mở được; /admin/health không lỗi mới; webhook endpoint phản hồi
                   validationToken đúng khi Microsoft verify.
  worker-email   : trạng thái Running; backlog queue không tăng bất thường; failed jobs không tăng.
  worker-delta   : trạng thái Running; delta polling ở /admin/health không chuyển xấu.
  worker-renewal : trạng thái Running; không có lỗi lặp lại trong log khởi động.
```

**9. Khi nào cập nhật ROADMAP?** Sau khi Antigravity review PASS, và nếu task có deploy thì sau khi
post-deploy verification + smoke xong. Không ghi "completed" trước Antigravity.

**10. Điều kiện nào bắt buộc STOP?** Xem §19.

### 15.2. Bảng tra nhanh cho ChatGPT — "task này cần cập nhật service nào?"

> Dùng bảng này ngay khi Claude báo danh sách file đã thay đổi. Tra theo đường dẫn.

| Đường dẫn thay đổi | web | worker-email | worker-delta | worker-renewal | Cần migration? |
|---|---|---|---|---|---|
| `docs/**` | – | – | – | – | Không |
| `tests/**` | – | – | – | – | Không |
| `app/**`, `components/**` | **R** | – | – | – | Không |
| `app/api/webhooks/**` | **R** | ⚠ | – | – | Không |
| `services/email/**` | – | **R** | – | – | Không |
| `services/telegram/**` | **R** | **R** | – | – | ⚠ |
| `services/queue/email-job*.ts` | **R** | **R** | **R** | – | Không |
| `services/queue/workers/email-worker*` | – | **R** | – | – | Không |
| `services/queue/workers/delta-polling-runner.ts` | – | – | **R** | – | Không |
| `services/queue/workers/subscription-renewal-runner.ts` | – | – | – | **R** | Không |
| `services/queue/{mailbox-,global-send-,redis-}*` | – | **R** | – | – | Không |
| `services/microsoft/delta-polling.service.ts` | – | – | **R** | – | Không |
| `services/microsoft/subscription-renewal.service.ts` | – | – | – | **R** | Không |
| `services/microsoft/graph-subscription.service.ts` | **R** | – | – | **R** | ⚠ |
| `services/microsoft/mailbox-subscription-provisioning.service.ts` | **R** | – | – | **R** | ⚠ |
| `services/microsoft/refresh-*` | **R** | **R** | **R** | **R** | Không |
| `services/observability/**` | **R** | **R** | – | – | Không |
| `services/health/**` | **R** | – | – | – | Không |
| `services/logs/**` | **R** | **R** | – | **R** | ⚠ |
| `lib/security/encryption.ts` | **R** | **R** | **R** | **R** | Không |
| `lib/env*.ts`, `lib/logger.ts`, `lib/prisma.ts` | **R** | **R** | **R** | **R** | Không |
| `prisma/schema.prisma` | **R** | **R** | **R** | **R** | Thường **CÓ** |
| `prisma/migrations/**` | **R** | **R** | **R** | **R** | **CÓ** — phân loại CASE 1/2/3 |
| `package.json` (đổi script khởi động) | **R** | **R** | **R** | **R** | Không — và cần Human đối chiếu Start Command trên dashboard |

### 15.3. Checklist promotion để ChatGPT nhắc Human

```text
[ ] 1. npm run verify PASS?
[ ] 2. Antigravity CLI review PASS?
[ ] 3. Đã push lên nhánh làm việc của task và GitHub Actions PASS?
[ ] 4. Task này có migration không? Nếu có, thuộc CASE 1 / 2 / 3?
[ ] 5. Nếu CASE 3: chế độ chống race A/B/C/D (§13.7) đã được khai báo và điều kiện của chế độ đó
       đã thoả chưa? Preflight read-only đã chạy đúng chế độ và trả kết quả RỖNG chưa?
       (nếu chưa ⇒ DỪNG, không promotion)
[ ] 6. Tra §15.2: những service nào cần promotion?
[ ] 7. Nếu có biến môi trường mới: đã set cho TẤT CẢ service liên quan TRƯỚC promotion chưa?
[ ] 8. Đã xác nhận chỉ MỘT service (theo quyết định OD-4) có Pre-Deploy migration chưa?
[ ] 9. Promotion bằng fast-forward, giữ nguyên commit identity (§12.4).
       Fast-forward không được ⇒ DỪNG, báo Human/ChatGPT.
[ ] 10. Đối chiếu deployed revision trên Railway với approved/promoted commit (§12.4).
[ ] 11. Post-deploy verification (nếu có migration).
[ ] 12. Smoke các service đã redeploy (cả 4 nếu có migration).
[ ] 13. Cập nhật ROADMAP.
```

---

## 16. Rollback principles

```text
R1. Rollback CODE và rollback SCHEMA là hai việc khác nhau. Rollback code KHÔNG hoàn tác migration.
R2. Prisma trong repo này KHÔNG có down-migration. `migrate deploy` chỉ tiến.
    ⇒ Không được "rollback" migration bằng cách sửa database bằng tay khi chưa hiểu nguyên nhân
      (nguyên tắc đã có sẵn trong docs/STAGING_DEPLOYMENT.md §5.10).
R3. Vì R1+R2, migration ADDITIVE là loại duy nhất rollback thực sự an toàn: code cũ không biết đến
    đối tượng mới và không bị nó cản.
R4. Với migration CONTRACT (xoá/đổi kiểu/thêm NOT NULL), rollback code về bản cũ có thể tạo ra code
    cũ chạy trên schema mới ⇒ phải thiết kế hai pha ngay từ đầu (§9 hàng 13), đừng trông vào rollback.
R5. Dưới Option B, rollback = đưa nhánh staging về commit trước rồi promotion lại ⇒ có dấu vết Git,
    và 4 service quay về cùng một điểm.
R6. Rollback KHÔNG BAO GIỜ được thực hiện bằng cách xoá dữ liệu để "hợp" với schema cũ.
R7. Nếu migration CASE 3 fail ở Pre-Deploy: deploy dừng là ĐÚNG THIẾT KẾ. Không retry mù.
    Chạy preflight read-only để biết chính xác dữ liệu nào vi phạm, rồi để Human quyết định
    remediation. Không tự dọn dữ liệu.
R8. Rollback của một service đơn lẻ phải được kiểm tra lại theo §9: nó có làm vỡ contract với
    service khác đang ở release mới không?
```

---

## 17. Security constraints (áp dụng cho toàn bộ TASK-088)

```text
[x] Không ghi vào tài liệu: connection string database/Redis, access token, refresh token,
    client secret của Microsoft, bot token của Telegram, encryption key, session secret,
    verification code, full email body, email address.
[x] Không copy giá trị Variables của Railway vào tài liệu hay vào chat AI.
[x] Checklist §4 chỉ yêu cầu Settings/Deploy, KHÔNG yêu cầu mở tab Variables.
[x] Ảnh chụp (nếu có) không được chứa Variables hay deploy log in giá trị biến môi trường.
[x] Không đọc, không in, không sửa .env / .env.local / .env.staging / .env.production.
[x] Query duy nhất được đề xuất cho Human là READ-ONLY và không trả về dữ liệu khách hàng.
[x] Không nới lỏng secret scan của GitHub Actions.
[x] Không ghi tên nhánh Git đầy đủ (tránh false positive của secret scan).
[x] Không dòng metadata ngắn dạng "từ khoá nhạy cảm: giá trị".
```

---

## 18. Open questions / Human decisions

> **Cập nhật trạng thái:** bảng dưới đây là trạng thái tại thời điểm Phase 1. Sau Human evidence
> (§21) và locked decisions (§22): **OD-1 / OD-4 / OD-7 = APPROVED (§22.1–§22.3)**;
> **OD-3 / OD-5 = ĐÃ TRẢ LỜI** (§21.1, §21.3); **OD-2 = đã đủ dữ liệu cho phần cần thiết**
> (§21.4); **OD-6 = DEFERRED** (Watch Paths — optional optimization); **OD-9 = không kích hoạt**
> (Q2 = 1). Còn mở thực sự: **OD-8** (đóng divergence tài liệu — thuộc close-out Phase 2) và
> **OD-10** (runtime change — ngoài scope TASK-088).

| # | Câu hỏi | Ai quyết định | Vì sao chưa trả lời được |
|---|---|---|---|
| **OD-1** | Chọn Option A / B / C / D làm mô hình source cho staging? | Human + ChatGPT | Đây là quyết định vận hành, không phải quyết định code. Claude đề xuất **B** (§12) |
| **OD-2** | Railway có cho phép mỗi service chọn nhánh riêng, tắt/bật Auto Deploy per-service, và deploy thủ công một revision cụ thể không? | Human (xác minh trên dashboard) | **HUMAN VERIFICATION REQUIRED** — repo không có file cấu hình Railway nào (F1) |
| **OD-3** | Ba worker hiện có Pre-Deploy Command gì? | Human (§4.1 mục 5) | **HUMAN VERIFICATION REQUIRED** |
| **OD-4** | Có nên gỡ hẳn `migrate deploy` khỏi Pre-Deploy và chạy migration như lệnh one-off có người bấm? | Human + ChatGPT | Đánh đổi giữa an toàn tối đa cho CASE 3 và gánh nặng vận hành cho CASE 2 (§13.5) |
| **OD-5** | Bốn service hiện có cùng deployed commit không? | Human (§4.2 Q3) | **HUMAN VERIFICATION REQUIRED** — UI có thể không hiển thị |
| **OD-6** | Railway có hỗ trợ Watch Paths để docs-only push không gây redeploy không, và có nên bật không? | Human | **HUMAN VERIFICATION REQUIRED**. Nếu chọn Option B thì vấn đề này gần như tự hết |
| **OD-7** | Ai là người bấm promotion — Human, hay Claude được uỷ quyền trong một bước có tên rõ ràng? | Human | Ảnh hưởng trực tiếp tới thiết kế checklist §15.3 |
| **OD-8** | Có cần đóng divergence tài liệu ở `docs/STAGING_DEPLOYMENT.md` §5.7/§5.12 (F3) trong Phase 2 không? | Human + ChatGPT | Phase 1 **không** được sửa tài liệu đó |
| **OD-9** | Nếu Q2 ở §4.2 cho ra ≥ 2 service có Pre-Deploy migration thì xử lý thế nào? | Human | Chưa có dữ liệu; kích hoạt STOP S4 |
| **OD-10** | Có cần một cách để nhìn thấy "service đang chạy commit nào" từ chính ứng dụng (thay vì chỉ trên dashboard) không? | Human + ChatGPT | Đây sẽ là **runtime change** ⇒ **ngoài scope TASK-088**, chỉ ghi nhận |

---

## 19. STOP conditions

Khi gặp bất kỳ điều kiện nào dưới đây: **chỉ document finding + open decision, rồi báo
Human/ChatGPT.** Không tự sửa, không tự mở rộng scope.

| # | Điều kiện | Hành động |
|---|---|---|
| **S1** | Không xác định được đúng Railway project / environment staging | STOP. Không thao tác gì thêm trên dashboard |
| **S2** | Source branch hoặc deployed commit của một service không xác minh được | STOP với quyết định phụ thuộc thông tin đó. Ghi HUMAN VERIFICATION REQUIRED |
| **S3** | Auto Deploy hoặc Pre-Deploy state không rõ trong một quyết định critical | STOP. Không suy đoán |
| **S4** | Phát hiện **nhiều** service cùng có Pre-Deploy chạy migration mà kiến trúc chưa duyệt | STOP. Ghi finding. **Không sửa** trong Phase 1 |
| **S5** | Có migration mang data precondition nhưng không có cổng nào chạy trước automatic deploy | STOP. Không push, không promotion cho tới khi có quyết định về OD-1 |
| **S6** | Mô hình deployment đòi thay đổi Railway settings | STOP — Phase 1 chỉ thiết kế, Phase 2 mới thực thi sau Antigravity Architecture Review |
| **S7** | Cần thao tác production (database, service, secret) | STOP tuyệt đối. Ngoài scope |
| **S8** | Cần orphan remote subscription cleanup | STOP. Ngoài scope TASK-088 |
| **S9** | Cần sửa runtime code, Prisma schema, migration, test, package script hay CI | STOP. Phase 1 là docs-only |
| **S10** | Cần đọc `.env*` hoặc bất kỳ giá trị secret nào | STOP tuyệt đối |
| **S11** | Scope cần mở rộng ngoài TASK-088 | STOP. Đề xuất task mới cho Human/ChatGPT; **không** tự gán số task |
| **S12** | Preflight của một migration CASE 3 trả về kết quả khác rỗng | STOP. Không promotion, không deploy, không tự dọn dữ liệu |
| **S13** | Migration CASE 3 không bảo đảm được precondition ổn định bằng chế độ A/B/C của §13.7, hoặc không backward-compatible với mixed-version services | STOP. Tách multi-stage expand/contract hoặc task riêng — chế độ D (§13.7) |
| **S14** | Promotion fast-forward không thực hiện được (nhánh staging có commit không nằm trong nhánh task đã duyệt) | STOP. Không tự merge/rebase/cherry-pick. Báo Human/ChatGPT (§12.4) |

---

## 20. Phase-2 boundary

### 20.1. Phase 2 sẽ làm gì (chỉ sau khi Human chốt OD-1 và Antigravity Architecture Review PASS)

```text
[ ] Human thực hiện checklist §4 và cung cấp evidence cho cả 4 service.
[ ] Human/ChatGPT chốt OD-1 (mô hình source) và OD-4 (vị trí của migrate deploy).
[ ] Nếu chọn Option B: thiết lập nhánh staging và trỏ 4 service vào đó
    (thao tác dashboard do Human làm, có checklist do Claude viết).
[ ] Xác nhận chỉ web có Pre-Deploy migration; ghi thành quy tắc.
[ ] Cập nhật tài liệu deployment để phản ánh cấu hình THẬT (đóng divergence F3).
[ ] Thêm checklist promotion vào quy trình task chuẩn.
[ ] Chạy một promotion thử với một task CASE 1 để kiểm chứng quy trình trước khi gặp CASE 3 thật.
```

### 20.2. Phase 2 **không** làm

```text
[x] Không production rollout.
[x] Không orphan cleanup.
[x] Không runtime/schema implementation.
[x] Không tự mở task mới.
[x] Không nới secret scan.
```

### 20.3. Điều kiện để rời Phase 1

```text
Phase 1 kết thúc khi:
  1. Human hoàn thành checklist §4 cho cả 4 service; VÀ
  2. Human/ChatGPT chốt OD-1; VÀ
  3. Antigravity CLI correction re-review xác nhận các correction (§2.1, §12.4, §13.7, §14.2)
     đã được phản ánh đúng (Architecture Review lần đầu đã PASS kèm 2 Medium + 1 Low finding).

Trước khi đủ ba điều kiện đó, TASK-088 KHÔNG được ghi là completed hay approved ở bất kỳ đâu,
kể cả trong docs/ROADMAP.md.
```

> Cập nhật: điều kiện 1 và 2 đã đạt (evidence §21, decisions §22). Điều kiện còn lại để đóng
> TASK-088: Antigravity Phase 2 Plan Review PASS cho §23, sau đó Phase 2 được thực thi và
> verify theo chính §23.

---

## 21. HUMAN-OBSERVED RAILWAY EVIDENCE (Phase 1 checklist §4 — đã hoàn thành)

> **Nguồn:** Human quan sát trực tiếp Railway staging dashboard (tab Settings/Deployments,
> KHÔNG mở tab Variables) và chạy lệnh Git read-only. Claude KHÔNG truy cập Railway.
> Evidence dưới đây là **sanitized summary** — không chứa secret, không copy Variables.

### 21.1. Kết quả checklist cho CẢ BỐN service

Cả bốn service (`web`, `worker-email`, `worker-delta`, `worker-renewal`) đều:

```text
[x] Kết nối CÙNG GitHub repository.
[x] Kết nối CÙNG source branch — nhánh làm việc của TASK-086.
[x] Auto Deploy khi GitHub push = ON.
[x] Wait for CI = OFF.
[x] Builder = Railpack mặc định.
[x] KHÔNG có Custom Build Command.
[x] KHÔNG có Watch Paths.
[x] KHÔNG có Root Directory.
[x] 1 replica.
[x] Deployment hiện tại: Active / successful.
```

Start Command từng service (khớp đúng kỳ vọng repo ở §3):

| Service | Start Command (Human-observed) | Khớp repo? |
|---|---|---|
| web | `npm run start` | ✅ (§3.1) |
| worker-email | `npm run worker:email` | ✅ (§3.2) |
| worker-delta | `npm run worker:delta` | ✅ (§3.3) |
| worker-renewal | `npm run worker:renewal` | ✅ (§3.4) |

Pre-Deploy Command:

| Service | Pre-Deploy Command (Human-observed) |
|---|---|
| web | `npx prisma migrate deploy` |
| worker-email | (không có) |
| worker-delta | (không có) |
| worker-renewal | (không có) |

### 21.2. Verdict ba câu hỏi quyết định (§4.2)

```text
Q1. Bốn service có CÙNG source branch không?
    → CÓ — cả bốn cùng nhánh làm việc của TASK-086.

Q2. Có bao nhiêu service có Pre-Deploy Command chứa "migrate deploy"?
    → ĐÚNG MỘT — chỉ web.
    ⇒ STOP condition S4 (">= 2 migration executor") KHÔNG xảy ra.
    ⇒ Trạng thái thực tế ĐÃ KHỚP recommendation §14 — Phase 2 không cần sửa Pre-Deploy.

Q3. Bốn service có CÙNG deployed commit không?
    → Xem §21.3 — Railway UI không expose SHA trực tiếp; evidence chain kết luận CÓ.
```

### 21.3. Deployed revision evidence (wording chính xác — không viết quá mức)

Railway UI **không cung cấp direct deployed-SHA evidence** trong các màn hình Human đã kiểm tra.
Tuy nhiên evidence chain sau đây nhất quán:

```text
1. Railway hiển thị cả 4 service: cùng source branch (nhánh TASK-086), cùng deployed commit
   message "fix: guard concurrent graph subscription provisioning", cùng đợt deployment,
   đều successful/Active.                                    [Human-observed]
2. Git local:  git show -s --format="%H %s" b8eaa01
   → b8eaa01ec942f1cb187800dde2c98a536a7b86b2
     fix: guard concurrent graph subscription provisioning   [repo-verified]
3. Git remote: git ls-remote origin <nhánh TASK-086>
   → tip = b8eaa01ec942f1cb187800dde2c98a536a7b86b2          [repo-verified]
```

**Kết luận đúng mức:** Railway không hiển thị SHA trực tiếp, nhưng evidence chain xác nhận cả bốn
service cùng source branch và cùng commit message, trong khi Git local/remote xác nhận tip của
nhánh đó chính là commit TASK-086 (`b8eaa01ec942f1cb187800dde2c98a536a7b86b2`). **Không có evidence
nào cho thấy bất kỳ service nào đang chạy revision khác.** Đây là suy luận qua chain, KHÔNG phải
Railway trực tiếp hiển thị SHA.

### 21.4. Ảnh hưởng lên các finding/OD của Phase 1

| Mục Phase 1 | Trạng thái sau evidence |
|---|---|
| A2 (Auto Deploy 3 worker chưa biết) | **ĐÃ TRẢ LỜI:** ON cho cả 4 |
| P2 (Pre-Deploy 3 worker chưa biết) | **ĐÃ TRẢ LỜI:** không có — chỉ web |
| P6 (nguy cơ nhiều executor) | **KHÔNG xảy ra** (Q2 = 1) |
| A4 (docs-only push trigger deploy) | **XÁC NHẬN:** không Watch Paths ⇒ mọi push lên nhánh được theo dõi trigger cả 4 |
| D-S4 (drift giữa 4 service) | Hiện **không** drift (Q1 = CÓ, §21.3) |
| OD-2 | Đã đủ dữ liệu cho phần cần thiết: per-service settings tồn tại (Wait for CI, Pre-Deploy, source) — Human đã thấy và thao tác được |
| OD-3 | **ĐÃ TRẢ LỜI** (bảng §21.1) |
| OD-5 | **ĐÃ TRẢ LỜI** qua evidence chain §21.3 |
| OD-6 (Watch Paths) | Hiện không service nào có Watch Paths. **TASK-088 KHÔNG tự cấu hình Watch Paths.** Phân loại: optional operational optimization, KHÔNG phải correctness requirement — **DEFERRED** |
| OD-9 | Không kích hoạt (Q2 = 1) |

---

## 22. LOCKED HUMAN/CHATGPT DECISIONS

> Các quyết định dưới đây đã được Human/ChatGPT **khoá** sau khi Antigravity correction re-review
> PASS và Human hoàn thành evidence checklist. Chúng thay thế trạng thái "chờ quyết định" của các
> dòng tương ứng trong §18.

### 22.1. OD-1 — APPROVED: Option B — dedicated staging branch

```text
- Bốn Railway service sẽ được CỐ ĐỊNH vào cùng MỘT dedicated staging branch.
- Feature/task branch KHÔNG còn được Railway staging theo dõi trực tiếp sau Phase 2.
- Push lên task branch chỉ phục vụ source control + GitHub Actions — KHÔNG tự deploy staging.
```

### 22.2. OD-4 — APPROVED (cho mô hình staging hiện tại): web là SOLE migration executor

```text
- web:            Pre-Deploy = npx prisma migrate deploy  (GIỮ NGUYÊN)
- worker-email:   KHÔNG Pre-Deploy migration
- worker-delta:   KHÔNG Pre-Deploy migration
- worker-renewal: KHÔNG Pre-Deploy migration
```

Rationale đã khoá (theo §14.2 sau correction): (1) single executor; (2) deterministic migration
ordering; (3) tránh nhiều service cùng chạy migration; (4) đơn giản cho Human operator; (5) web
deployment cung cấp một migration/deployment control point rõ ràng. Quyết định này **KHÔNG** dựa
vào GraphSubscription-specific INSERT behavior làm correctness proof. Dedicated/manual one-off
migration executor vẫn là **future alternative** nếu một migration cụ thể yêu cầu kiến trúc khác.

Evidence §21.1 xác nhận trạng thái Railway hiện tại **đã đúng** quyết định này ⇒ Phase 2 không cần
đổi Pre-Deploy của bất kỳ service nào.

### 22.3. OD-7 — APPROVED: promotion do HUMAN thực hiện

```text
- Promotion do HUMAN thực hiện bằng PowerShell theo hướng dẫn của ChatGPT.
- Claude Code KHÔNG tự promotion.
- Antigravity KHÔNG promotion.
- KHÔNG agent nào tự thay đổi Railway.
```

### 22.4. Quyết định Wait-for-CI (bổ sung Phase 2)

```text
- GIỮ Auto Deploy = ON trên dedicated staging branch.
- ĐỔI Wait for CI: OFF → ON cho CẢ BỐN Railway service (thực hiện ở Phase 2B).

Mục tiêu: promotion push vào dedicated staging branch
          → GitHub Actions PASS
          → Railway MỚI deploy.
```

Đây là **defense-in-depth** bổ sung, nằm NGOÀI các quality gate đã chạy trên task branch (verify /
Antigravity / CI task branch / preflight CASE 3). Nó vá đúng finding F2 của Phase 1 (CI chạy song
song thay vì trước deploy) ở tầng nhánh staging.

### 22.5. Promotion invariant (giữ nguyên §12.4 — nhắc lại vì đã locked)

```text
REVIEWED COMMIT == PROMOTED COMMIT == DEPLOYED COMMIT

Default promotion:
  git switch <dedicated staging branch>
  git merge --ff-only <approved task branch>

ff-only FAIL ⇒ STOP. Không merge commit. Không squash. Không rebase/cherry-pick
trong promotion path nếu làm thay đổi reviewed commit identity.
```

### 22.6. Docs-only / non-deploy task rule (bổ sung nguyên tắc)

```text
KHÔNG phải mọi task completed đều phải promotion staging.

Nếu task chỉ thay đổi docs/report/ROADMAP, hoặc thay đổi không ảnh hưởng staging runtime:
  - KHÔNG cần promotion;
  - KHÔNG cần Railway redeploy;
  - staging được phép hợp lệ ở một runtime commit CŨ HƠN repo HEAD.

Khi một runtime task sau đó được promotion bằng fast-forward, các docs commit nằm giữa sẽ đi cùng
history một cách tự nhiên mà không ảnh hưởng runtime correctness.

ChatGPT PHẢI dùng Deployment Impact Matrix (§9, §15.2) để chỉ rõ service nào thực sự cần deploy
cho mỗi task.
```

Lưu ý hiện trạng: vì cả 4 service cùng theo một nhánh và **không có Watch Paths** (§21.1), một
promotion push sẽ có thể trigger deploy **cả 4** service — kể cả service không bị ảnh hưởng. Đây là
hành vi chấp nhận được ở hiện tại (nội dung cùng commit, backward-compatible theo §8); Watch Paths
là optimization DEFERRED (§21.4, OD-6).

---

## 23. PHASE 2 EXECUTION PLAN (kế hoạch — CHƯA THỰC THI)

> Toàn bộ mục này là **plan**. Không bước nào dưới đây đã được chạy trong TASK-088 tính tới thời
> điểm tài liệu này. Mọi thao tác Railway/PowerShell do **HUMAN** thực hiện (OD-7). Kế hoạch chỉ
> được thực thi sau khi **Antigravity Phase 2 Plan Review PASS**.
>
> Quy ước tên: nhánh staging chuyên dụng được đề xuất tên đơn giản **`staging`** (an toàn với
> secret scan, không mang số task, không bao giờ cần đổi). Nếu Human muốn tên khác, chỉ cần thay
> thế nhất quán trong runbook — không đổi kiến trúc.

### 23.0. Trạng thái xuất phát đã xác minh (điều kiện tiên quyết)

```text
[x] Cả 4 service đang theo nhánh TASK-086, cùng commit
    b8eaa01ec942f1cb187800dde2c98a536a7b86b2 (§21.3).
[x] Chỉ web có Pre-Deploy migration (§21.1) — đúng OD-4, không cần sửa.
[x] Migration TASK-086 đã applied trên staging DB (TASK-087 §16).
[x] Auto Deploy ON, Wait for CI OFF (sẽ đổi ở 2B).
```

Nếu bất kỳ dòng nào ở trên thay đổi trước khi Phase 2 bắt đầu ⇒ dừng, xác minh lại từ đầu.

### PHASE 2A — Tạo dedicated staging branch an toàn

**Nguyên tắc then chốt:** nhánh `staging` ban đầu phải trỏ vào **ĐÚNG commit runtime đang deploy**
— commit TASK-086 `b8eaa01ec942f1cb187800dde2c98a536a7b86b2` — **KHÔNG** phải HEAD hiện tại của
repo. Lý do: không đưa docs TASK-087/TASK-088 hay bất kỳ runtime chưa chủ đích nào vào staging
trong lúc đổi source model. Đổi source model phải là thao tác **zero-content-change**.

```text
2A.1  Human (PowerShell):
        git fetch origin
        git branch staging b8eaa01ec942f1cb187800dde2c98a536a7b86b2
        git push -u origin staging
2A.2  An toàn vì: Railway lúc này vẫn theo nhánh TASK-086 ⇒ việc tạo/push nhánh staging
      KHÔNG trigger bất kỳ deploy nào.
2A.3  Chờ GitHub Actions chạy trên nhánh staging → PHẢI PASS trước khi làm 2C.
      (CI đã từng PASS cho chính commit này trên nhánh TASK-086; chạy lại trên nhánh staging
       là xác nhận độc lập, đồng thời cần thiết cho Wait-for-CI ở 2B/2C.)
2A.4  Verify: git ls-remote origin refs/heads/staging
      → tip phải đúng b8eaa01ec942f1cb187800dde2c98a536a7b86b2.
```

STOP nếu: push bị reject; CI trên nhánh staging FAIL; tip không đúng SHA kỳ vọng.

### PHASE 2B — Railway safety settings (làm TRƯỚC khi đổi source)

Cho **từng** service, theo thứ tự `worker-renewal → worker-delta → worker-email → web`
(service ít coupling nhất trước, web — nơi có Pre-Deploy — sau cùng):

```text
2B.1  Bật Wait for CI: OFF → ON.
2B.2  KHÔNG đổi Auto Deploy (giữ ON).
2B.3  KHÔNG đổi Build Command (giữ Railpack mặc định).
2B.4  KHÔNG thêm Watch Paths trong TASK-088 (trừ khi Human/ChatGPT approve riêng — hiện DEFERRED).
2B.5  KHÔNG đổi Pre-Deploy (giữ nguyên trạng thái đã xác minh §21.1: chỉ web có).
2B.6  KHÔNG đổi Start Command.
2B.7  Verify sau từng service: Wait for CI hiển thị ON; service vẫn Active; không deploy mới
      ngoài ý muốn được kích hoạt bởi thao tác đổi setting.
```

Làm 2B **trước** 2C để khi source được chuyển, cổng CI đã đứng sẵn trước mọi deploy tương lai.

### PHASE 2C — Chuyển source branch của 4 service

Chuyển từng service từ nhánh TASK-086 → nhánh `staging`. **Không giả định Railway switch atomic** —
mỗi lần đổi source có thể trigger một redeploy của service đó.

Vì nhánh `staging` trỏ đúng **cùng commit** TASK-086:

```text
- Nội dung runtime KHÔNG đổi (cùng SHA).
- Migration TASK-086 ĐÃ applied ⇒ nếu web Pre-Deploy chạy lại, `prisma migrate deploy`
  phải báo KHÔNG có pending migration (no-op) — đây là hành vi kỳ vọng, không phải lỗi.
- KHÔNG có intended runtime upgrade trong bước này.
```

Thứ tự đề xuất + verify sau TỪNG service:

```text
2C.1  worker-renewal  → đổi source → chờ deploy (nếu trigger) → verify Active, log start sạch.
      (chọn đầu tiên vì §8: không queue, không metrics-writer, ít coupling nhất — nếu có
       hành vi bất ngờ ở bước đổi source thì phát hiện trên service rủi ro thấp nhất)
2C.2  worker-delta    → như trên; verify delta polling ở /admin/health không chuyển xấu.
2C.3  worker-email    → như trên; verify backlog queue không tăng bất thường, failed không tăng.
2C.4  web             → đổi source cuối cùng → nếu redeploy: Pre-Deploy log PHẢI cho thấy
      không migration mới nào được apply → web Ready → /admin/health mở được.
```

Trong cửa sổ giữa 2C.1 và 2C.4, các service tạm thời khác "source branch label" nhưng **cùng
commit content** ⇒ không có version drift thực chất (§8).

STOP nếu ở bất kỳ bước nào: deploy FAIL; service không trở lại Active; Pre-Deploy của web định
apply migration ngoài danh sách đã có; hoặc dashboard hiển thị source/commit khác kỳ vọng.

### PHASE 2D — Verification sau khi chuyển xong

Xác minh **cả bốn** service:

```text
[ ] Source branch = staging (dedicated staging branch).
[ ] Wait for CI = ON.
[ ] Auto Deploy = ON.
[ ] Pre-Deploy: vẫn CHỈ web có `npx prisma migrate deploy`.
[ ] Start Command không đổi (đúng bảng §21.1).
[ ] Deployment successful / Active.
[ ] Web Pre-Deploy KHÔNG apply migration mới nào ngoài các migration đã có
    (đối chiếu qua deploy log; tuỳ chọn: Human chạy lại query read-only §4.4).
```

Smoke (theo §15.1 câu 8 — không dùng production, không dùng dữ liệu khách hàng thật):

```text
[ ] web accessible qua HTTPS; /admin mở được.
[ ] /admin/health không lỗi mới.
[ ] Email worker: Running; queue backlog/failed không tăng bất thường.
[ ] Delta polling: Running; trạng thái health không chuyển xấu.
[ ] Subscription renewal: Running; không lỗi lặp trong log khởi động.
[ ] Queue / Redis health: PASS trên /admin/health.
```

### PHASE 2E — Future promotion runbook (cho mọi runtime task sau Phase 2)

```text
 1. Tạo task branch cho task mới (theo quy trình hiện hành).
 2. Claude Code implementation.
 3. npm run verify PASS.
 4. Antigravity review PASS.
 5. Commit + push task branch (KHÔNG deploy — staging không theo dõi task branch nữa).
 6. GitHub Actions trên task branch PASS.
 7. Classify deployment impact theo §9 / §15.2 (ChatGPT chỉ rõ service nào cần deploy;
    task docs-only ⇒ DỪNG ở đây theo §22.6, không promotion).
 8. Nếu có migration: phân loại CASE 1/2/3 (§13.1). Nếu CASE 3: chọn mode A/B/C/D (§13.7)
    và giữ precondition ĐÚNG cho tới khi migration enforce nó.
 9. HUMAN promotion (PowerShell, theo ChatGPT hướng dẫn — OD-7):
      git switch staging
      git merge --ff-only <approved task branch>
      git push origin staging
    ff-only FAIL ⇒ STOP (S14).
10. GitHub Actions trên nhánh staging PASS (Wait for CI chặn deploy cho tới lúc đó).
11. Railway auto deploy các service.
12. Migration (nếu có) chạy duy nhất qua web Pre-Deploy (OD-4).
13. Đối chiếu deployed revision với promoted commit — theo mức UI/capability cho phép:
    tối thiểu là commit message + branch + đợt deploy (evidence chain kiểu §21.3);
    trực tiếp SHA nếu Railway expose ở nơi nào đó.
14. Service-specific smoke theo impact matrix (cả 4 nếu có migration).
15. ROADMAP close-out theo đúng project workflow (sau review PASS + verify + smoke).
```

Ghi chú vận hành: với hiện trạng "cả 4 service cùng nhánh + không Watch Paths", **một promotion có
thể trigger deploy cả 4 service** kể cả khi impact matrix nói chỉ 1 service cần — chấp nhận được vì
cùng commit và backward-compatible (§8). Không yêu cầu tránh redeploy service không bị ảnh hưởng
trong TASK-088; nếu tương lai muốn tránh, đó là lúc xem lại Watch Paths (OD-6, DEFERRED).

### 23.1. STOP conditions riêng cho Phase 2 (bổ sung S1–S14 của §19)

| # | Điều kiện | Hành động |
|---|---|---|
| P2-S1 | CI trên nhánh staging FAIL ở 2A.3 | STOP trước 2C. Không chuyển source |
| P2-S2 | Tip nhánh staging không đúng SHA TASK-086 ở 2A.4 | STOP. Không tự sửa bằng force-push — báo Human/ChatGPT |
| P2-S3 | Một service không trở lại Active sau đổi setting/source | STOP chuỗi switch. Không đổi tiếp service kế. Rollback source của service đó về nhánh TASK-086 là phương án Human cân nhắc |
| P2-S4 | Web Pre-Deploy định apply migration mới trong 2C.4 | STOP. Đây là dấu hiệu nhánh staging không trỏ đúng commit |
| P2-S5 | Bất kỳ bước nào đòi đọc/copy secret hoặc mở tab Variables | STOP tuyệt đối |
| P2-S6 | Phát hiện lệch cấu hình so với §21.1 trước khi bắt đầu | STOP. Xác minh lại evidence từ đầu |

### 23.2. Ranh giới sau Phase 2

```text
Phase 2 KẾT THÚC khi toàn bộ PHASE 2D pass và được ghi lại (sanitized) vào report TASK-088.
Chỉ sau đó TASK-088 mới đủ điều kiện close-out (Antigravity final review + ROADMAP theo workflow).
Orphan cleanup, production, Watch Paths, runtime "app tự báo commit" (OD-10) — vẫn NGOÀI scope.
```

> Cập nhật: Phase 2A–2D đã được Human thực thi — evidence ở §24. Điều kiện close-out còn lại:
> Antigravity Final Execution Review PASS, sau đó ROADMAP theo workflow.

---

## 24. PHASE 2 EXECUTION EVIDENCE (Human-observed + repo-verified)

> **Nguồn bằng chứng:**
> * **Human-observed** — Human thao tác/quan sát trực tiếp trên Railway dashboard, GitHub Actions
>   UI và staging `/admin/health`, theo đúng plan §23 đã được Antigravity approve
>   (**PASS — TASK-088 PHASE 2 PLAN APPROVED FOR CONTROLLED HUMAN EXECUTION**).
> * **Repo-verified** — Claude chạy lệnh Git read-only trên repo local để đối chiếu độc lập.
>
> **Claude KHÔNG chạm Railway, KHÔNG redeploy, KHÔNG chạy migration** (đúng OD-7).
> Evidence sanitized: không email address / mailbox identifier cụ thể, không datasource URL/host,
> không Redis info, không token/secret, không copy Variables.

### 24.1. PHASE 2A — Tạo dedicated staging branch — **PASS**

Human đã thực hiện (PowerShell, theo §23 2A):

```text
[x] git fetch origin.
[x] Xác minh branch `staging` CHƯA tồn tại trước khi tạo.
[x] Tạo branch `staging` tại ĐÚNG commit TASK-086 đã xác minh:
    b8eaa01ec942f1cb187800dde2c98a536a7b86b2
    (KHÔNG tạo từ HEAD của nhánh TASK-088 — đúng nguyên tắc zero-content-change §23 2A).
[x] Push branch `staging` lên origin.
[x] Xác minh remote tip.
[x] GitHub Actions trên branch `staging`, commit b8eaa01: workflow PASS.
```

**Đối chiếu độc lập (repo-verified, read-only):**

```text
git ls-remote origin refs/heads/staging
→ b8eaa01ec942f1cb187800dde2c98a536a7b86b2   refs/heads/staging
```

Tip nhánh `staging` trên remote khớp chính xác SHA kỳ vọng của §23 2A.4 ⇒ P2-S2 không kích hoạt.

```text
Verdict: PHASE 2A PASS
```

### 24.2. PHASE 2B — Wait for CI — **PASS**

Human bật `Wait for CI = ON` cho cả 4 service, theo đúng thứ tự §23 2B
(`worker-renewal → worker-delta → worker-email → web`). Auto Deploy giữ ON.

Railway áp dụng thay đổi qua cơ chế **staged changes**; Human đã kiểm tra danh sách staged changes
**chỉ chứa đúng 4 thay đổi Wait-for-CI** rồi mới apply — không thay đổi ngoài ý muốn nào đi kèm.

Không đổi (đúng 2B.2–2B.6): source branch (ở bước 2B), Build Command, Start Command, Pre-Deploy,
Watch Paths, Variables, replica.

```text
Verdict: PHASE 2B PASS
```

### 24.3. PHASE 2C — Source switch — **PASS**

Human chuyển source từng service một (không giả định atomic), đúng thứ tự §23 2C:

```text
worker-renewal → worker-delta → worker-email → web
```

Mỗi service được xác minh **Active** trước khi chuyển service kế tiếp (đúng 2C.1–2C.4; P2-S3
không kích hoạt).

Trạng thái cả 4 service sau switch (Human-observed):

```text
[x] Source = staging (không còn theo nhánh làm việc của TASK-086).
[x] Auto Deploy = ON.
[x] Wait for CI = ON.
[x] Active / deployment successful.
```

Start Command giữ nguyên (khớp §21.1): web `npm run start`; worker-email `npm run worker:email`;
worker-delta `npm run worker:delta`; worker-renewal `npm run worker:renewal`.

Pre-Deploy giữ nguyên (khớp OD-4): **chỉ web** có `npx prisma migrate deploy`; ba worker không có.

```text
Verdict: PHASE 2C PASS
```

### 24.4. Web Pre-Deploy evidence (wording chính xác)

Human quan sát deploy log của `web` sau source switch:

```text
[x] Prisma schema load thành công.
[x] Datasource staging load thành công (không ghi URL/host vào tài liệu).
[x] Prisma tìm thấy 9 migrations trong thư mục migrations
    (khớp đúng số thư mục migration trong repo tại commit TASK-086).
[x] KHÔNG có evidence dòng nào apply migration mới.
[x] KHÔNG có migration failure / P3009.
[x] Pre-Deploy kết thúc; container tiếp tục start.
[x] npm run start / next start chạy thành công; Next.js báo Ready; web Active.
```

**Kết luận đúng mức (không viết quá evidence):**

```text
Pre-Deploy completed successfully; no evidence of a new migration being applied;
application container then started successfully.
```

Không khẳng định log hiển thị nguyên văn câu "No pending migrations" — screenshot Human kiểm tra
không chứa câu đó; kết luận "không migration mới" dựa trên việc log không có dòng apply nào và
không có failure, đúng hành vi no-op kỳ vọng của §23 2C (nhánh `staging` cùng commit với runtime
đang chạy, migration TASK-086 đã applied từ TASK-087). ⇒ P2-S4 không kích hoạt.

```text
Verdict: web source switch PASS
```

### 24.5. PHASE 2D — Admin health smoke — **PASS**

Human mở staging `/admin/health` sau khi cả 4 service đã theo `staging`.

Core operational checks:

```text
[x] Email worker pipeline:      PASS
[x] Delta polling:              PASS
[x] Queue / Redis:              PASS
[x] Telegram send reliability:  PASS
[~] Subscription renewal:       UNKNOWN  (pre-existing — xem §24.6)
[~] Webhook health:             UNKNOWN  (pre-existing — xem §24.6)
```

Mailbox summary (Human-observed; không copy email address / mailbox identifier cụ thể):

```text
- Tổng khoảng 275 mailbox; phần lớn Ready/Active.
- Một số mailbox vẫn RECONNECT_REQUIRED (pre-existing — §24.6).
- Một mailbox disabled/error (pre-existing — §24.6).
- SUBSCRIPTION_EXPIRED = 0.
- EXPIRING <24H = 0.
- Telegram failures 24h = 0.
```

Queue/worker observability:

```text
- backlog total = 0 | waiting = 0 | active = 0 | delayed = 0.
- cumulative FAILED count: CÓ historical entries (tích lũy từ trước — xem phân biệt dưới).
- failed jobs trong 60 phút gần nhất = 0.
- jobs skipped trong 60 phút gần nhất: một số ít.
- mailbox-busy defers = 0.
- queue wait / processing latency: bình thường.
```

**Phân biệt bắt buộc:**

```text
cumulative FAILED historical count  ≠  recent deployment regression.
Con số tích lũy phản ánh lịch sử vận hành trước Phase 2; chỉ số 60 phút gần nhất (= 0 failed)
mới là chỉ báo cho đợt source switch này.
```

```text
Verdict: PHASE 2D PASS — no new deployment-source-alignment regression observed.
```

### 24.6. Observations KHÔNG quy cho TASK-088 (EXISTING / INDEPENDENT OPERATIONAL OBSERVATION)

| Observation | Phân loại | Vì sao không phải TASK-088 regression |
|---|---|---|
| `Subscription renewal` = UNKNOWN | Pre-existing (đã ghi ở TASK-087 §16.9) | Dashboard chưa có đủ Graph subscription evidence để kết luận — giới hạn quan sát có từ trước Phase 2 |
| `Webhook health` = UNKNOWN | Pre-existing (TASK-087 §16.9) | Receipt history chưa đủ để xác nhận delivery health — có từ trước Phase 2 |
| Một số mailbox `RECONNECT_REQUIRED`; một mailbox disabled/error | Pre-existing (TASK-087 §16.9) | Trạng thái vận hành mailbox độc lập với source model |
| Một Graph **410 / SyncStateNotFound** error trên dashboard | **EXISTING / INDEPENDENT OPERATIONAL OBSERVATION** | Đây là Graph/runtime operational observation; Delta polling hiện PASS; TASK-088 không thay đổi runtime code; không có evidence nào cho thấy source switch gây ra lỗi này |

```text
Với tất cả các mục trên:
— KHÔNG phải evidence của Phase 2 execution failure;
— KHÔNG được ghi là đã được TASK-088 sửa (TASK-088 không sửa runtime);
— KHÔNG mở rộng scope TASK-088 để fix — nếu cần xử lý, đó là quyết định task riêng
  của Human/ChatGPT (không tự gán số task).
```

### 24.7. Overall Phase 2 execution verdict

```text
PHASE 2A PASS
PHASE 2B PASS
PHASE 2C PASS
PHASE 2D PASS

Overall: TASK-088 CONTROLLED STAGING EXECUTION COMPLETED WITHOUT OBSERVED REGRESSION.

Không STOP condition nào của §19 (S1–S14) hay §23.1 (P2-S1..P2-S6) bị kích hoạt.

TASK-088 CHƯA được ghi completed/closed — chờ Antigravity FINAL EXECUTION REVIEW.
```

### 24.8. Current final staging model (trạng thái mới — source of truth vận hành)

```text
Cả 4 Railway staging service (web, worker-email, worker-delta, worker-renewal) hiện theo:

  Source branch     : staging   (KHÔNG còn trực tiếp theo nhánh task hay nhánh feature nào)
  Auto Deploy       : ON
  Wait for CI       : ON        (GitHub Actions PASS rồi Railway mới deploy)
  Replica           : 1 / service
  Start Command     : như §21.1 (không đổi)

Migration executor : CHỈ web — Pre-Deploy `npx prisma migrate deploy`.
                     worker-email / worker-delta / worker-renewal: KHÔNG migration Pre-Deploy.

Watch Paths        : CHƯA cấu hình — deferred optional optimization (OD-6).

Deployed content   : commit TASK-086 b8eaa01ec942f1cb187800dde2c98a536a7b86b2
                     (không đổi qua Phase 2 — đúng nguyên tắc zero-content-change).
```

### 24.9. Future task reminder (nhắc lại rule đã khóa — áp dụng từ nay)

```text
1. Task docs-only: KHÔNG cần promote/redeploy staging (§22.6).
2. Task runtime: ChatGPT PHẢI dùng Deployment Impact Matrix (§9, §15.2) để xác định
   service bị ảnh hưởng.
3. Với hiện trạng KHÔNG Watch Paths: một promotion vào `staging` có thể trigger deploy
   CẢ 4 service — chấp nhận được (cùng commit, backward-compatible §8).
4. Future migration CASE 3: BẮT BUỘC tuân thủ Mode A/B/C/D (§13.7) và bảo đảm
   precondition giữ ĐÚNG cho tới lúc migration enforce invariant.
5. Promotion luôn theo §12.4/§22.5: ff-only, REVIEWED == PROMOTED == DEPLOYED,
   do HUMAN thực hiện (OD-7), theo runbook §23 2E.
```
