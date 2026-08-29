# TASK-088 — Railway Staging Deployment Source Alignment & Migration Safety Guard (Phase 1 Report)

> **PHASE 1 — INVESTIGATION / ARCHITECTURE / DOCUMENTATION ONLY.**
>
> **Trạng thái hiện tại: PHASE 2A–2D ĐÃ ĐƯỢC HUMAN THỰC THI — EXECUTION EVIDENCE ĐÃ GHI
> (mục R / task file §24) — AWAITING ANTIGRAVITY FINAL EXECUTION REVIEW.
> TASK-088 CHƯA COMPLETED/CLOSED.**
>
> Antigravity CLI Architecture Review: PASS (2 Medium + 1 Low — corrections ở mục N).
> Correction re-review: **PASS — CORRECTIONS APPROVED**. Human hoàn thành Railway Evidence
> checklist (mục O); OD-1/OD-4/OD-7 + Wait-for-CI đã khoá (mục P). Phase 2 Plan Review:
> **PASS — TASK-088 PHASE 2 PLAN APPROVED FOR CONTROLLED HUMAN EXECUTION** (mục Q).
> Human đã thực thi Phase 2A–2D theo đúng plan; verdict 2A/2B/2C/2D đều PASS; overall:
> **TASK-088 CONTROLLED STAGING EXECUTION COMPLETED WITHOUT OBSERVED REGRESSION** (mục R).
> Đây **không** phải báo cáo nghiệm thu cuối — ROADMAP chưa cập nhật.
>
> Không sửa runtime code, schema, migration, test, package scripts, deployment config, GitHub
> Actions hay `.env*`. Không chạm Railway. Không chạy migration. Không commit. Không push.
> Không cập nhật `docs/ROADMAP.md`.
>
> Chi tiết kiến trúc đầy đủ nằm ở
> `docs/tasks/TASK-088-railway-staging-source-alignment-migration-safety-guard.md`.
> Báo cáo này **không** chép lại nội dung đó — chỉ tóm tắt findings, evidence và open decisions.

---

## 0. Ranh giới bằng chứng

| Nhãn | Nghĩa |
|---|---|
| **REPO EVIDENCE** | Claude đọc trực tiếp file trong repo hoặc chạy lệnh git read-only trên repo local. Kiểm chứng lại được |
| **INHERITED HUMAN EVIDENCE** | Human quan sát trên Railway ở TASK-087 §16. Không viết lại, không mở rộng |
| **HUMAN VERIFICATION REQUIRED** | Repo không chứng minh được. Không suy đoán |

Claude **không** truy cập Railway, **không** chạy query trên staging, **không** chạy migration trong
task này.

---

## A. Precheck

```text
git branch --show-current  → đúng nhánh làm việc của TASK-088
git status --short         → (rỗng)
git diff --stat            → (rỗng)
git log -1 --oneline       → 7b62c5a docs: validate task 087 staging migration rollout
```

Xác minh:

```text
[x] Đang ở branch TASK-088.
[x] HEAD chứa TASK-087 đã hoàn tất (commit docs của TASK-087 chính là HEAD).
[x] Không có unexpected tracked/untracked change nào trước khi bắt đầu.
```

Không cần STOP ở bước precheck.

---

## B. Source-of-truth đã đọc

```text
CLAUDE.md, AGENTS.md, ANTIGRAVITY.md
.claude/rules/ecc/common/*  (agents, code-review, coding-style, development-workflow,
                             git-workflow, hooks, patterns, performance, security, testing)
.claude/rules/ecc/web/*
docs/STAGING_DEPLOYMENT.md               (đọc toàn bộ — §5.2, §5.7, §5.8, §5.10, §5.12 là trọng tâm)
docs/tasks/TASK-087-...md                (§16 Phase-2 evidence)
docs/reports/TASK-087-...md
docs/tasks/TASK-086-...md, docs/reports/TASK-086-...md
docs/ROADMAP.md                          (các dòng TASK-086 và TASK-087)
docs/reports/TASK-048-..., TASK-049-..., TASK-059-...  (nguồn gốc lựa chọn Railway + checklist setup)

Repo/code trace trực tiếp:
  package.json
  .github/workflows/ci.yml
  prisma/schema.prisma, prisma/migrations/  (đặc biệt migration TASK-086)
  lib/prisma.ts, lib/env.ts, lib/env.schema.ts
  scripts/run-email-worker.ts, run-delta-polling-worker.ts, run-subscription-renewal-worker.ts
  services/queue/  (email-job.types.ts, email-job-options.ts, email-queue.ts,
                    delta-polling-queue.ts, workers/*)
  services/observability/worker-metrics.ts, redis-worker-metrics.ts, infra-observability.service.ts
  services/microsoft/  (provisioning, graph-subscription, subscription-renewal, refresh-*)
  app/api/webhooks/microsoft/mail/route.ts, app/api/microsoft/oauth/callback/route.ts
  deployment/staging/README.md
  git branch -r, git log --name-only, git diff --stat, git merge-base
```

`docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY_RULES.md`, `docs/MICROSOFT_SETUP.md`
được tham chiếu ở phần liên quan deployment/worker/migration/security.

---

## C. Findings đã CHỨNG MINH được từ repo

| # | Finding | Vì sao quan trọng |
|---|---|---|
| **F1** | Repo **không chứa bất kỳ file cấu hình Railway nào** (`git ls-files` chỉ ra `prisma/migrations/migration_lock.toml`; không có `railway.json`/`railway.toml`/`Procfile`/`Dockerfile`/`nixpacks.toml`/`render.yaml`) | Toàn bộ cấu hình deploy sống trong dashboard: không version control, reviewer không nhìn thấy từ repo, CI không kiểm được, khó audit drift giữa 4 service. **Phân loại đúng (theo Antigravity review): F1 là CONTRIBUTING ARCHITECTURAL / AUDITABILITY / CONFIG-DRIFT WEAKNESS — không phải causal root cause. DIRECT OPERATIONAL CAUSE của deviation TASK-087 là tổ hợp: staging theo dõi branch được push + Auto Deploy bật + web có automatic Pre-Deploy migration + không có CI/preflight gate trước hành động trigger** (task file §2.1) |
| **F2** | `.github/workflows/ci.yml` chạy `on: push` cho mọi nhánh nhưng **không có bước deploy nào** | Kết hợp với auto deploy (H1): CI và deploy chạy **song song**, không phải nối tiếp. Một commit fail CI vẫn có thể đã deploy + đã migrate xong |
| **F3** | Không tài liệu nào trong repo trước TASK-087 nhắc tới Pre-Deploy Command hay Auto Deploy; `docs/STAGING_DEPLOYMENT.md` §5.7/§5.12 mô tả migration là **lệnh thủ công** | Tài liệu và cấu hình thật đã lệch nhau qua nhiều task |
| **F4** | `package.json` **không có script nào** gọi `prisma migrate deploy` | Hành vi rủi ro nhất của pipeline nằm ở nơi không grep được trong repo |
| **F5** | `postinstall: prisma generate` ⇒ Prisma Client được sinh **per-service, theo commit của chính service đó** | Service lệch commit ⇒ Prisma Client lệch schema-model |
| **F6** | Ba worker chạy bằng `tsx` (devDependency), không cần output `next build` | Ảnh hưởng tới kỳ vọng Build/Start Command khi Human đối chiếu dashboard |
| **F7** | `worker-renewal` **không** import `email-queue`/`delta-polling-queue` ⇒ là service duy nhất không tham gia queue | Nó là ứng viên deploy độc lập an toàn nhất |
| **F8** | INSERT vào `GraphSubscription` chỉ có **hai** đường: route OAuth callback (**web**) và runner reconciliation (**script thủ công**). `worker-renewal` chỉ UPDATE/EXPIRE | Partial unique index của TASK-086 chỉ có thể bị vi phạm bởi INSERT. Với khuyến nghị Pre-Deploy ownership, đây là **supporting consideration** — KHÔNG phải correctness proof (task file §14.2) |
| **F9** | Contract Redis giữa web và worker-email là cụ thể: `WORKER_METRICS_KEY_PREFIX = 'obs:wm:'` + `WORKER_METRIC_FIELDS`, worker-email ghi, web đọc ở `/admin/health` | Một cặp coupling thật, không phải giả định |
| **F10** | Job retention: hoàn tất 24h, thất bại 7 ngày (`email-job-options.ts`) | Job tồn tại **lâu hơn một lần deploy** ⇒ consumer **luôn** phải đọc được payload phiên bản cũ. Đây là ràng buộc compatibility cứng duy nhất chứng minh được từ code |
| **F11** | Topology nhánh là **chuỗi tuyến tính**, 93 nhánh remote, mỗi task một nhánh, **không có nhánh `main`/`master`**; tip của nhánh TASK-086 là tổ tiên của HEAD | Giải thích chính xác vì sao staging "kẹt" lại: nhánh task đã đóng không bao giờ tự tiến lên |
| **F12** | `git diff --stat <tip TASK-086>..HEAD` = **docs-only** (ROADMAP + 2 file của TASK-087, 1234 dòng thêm, 0 file runtime) | **Source lag hiện tại là VÔ HẠI** — staging đang chạy đúng runtime code hiện hành. Chứng minh được **không cần Human** |
| **F13** | Railway không deploy nguyên tử cho 4 service (mỗi service một build riêng theo mô hình ở §5.12) | ⇒ luôn tồn tại cửa sổ hỗn hợp phiên bản ⇒ **backward compatibility là cơ chế an toàn thật sự, không phải "cùng commit"** |

### C.1. Kết luận coherency (quan trọng — không phóng đại)

```text
SAI  : "cả bốn service luôn phải chạy cùng một commit".
ĐÚNG : "cả bốn phải ở trong một tập release TƯƠNG THÍCH;
        thay đổi chạm contract dùng chung phải promotion cùng nhau,
        theo thứ tự expand → deploy → contract."
```

Code **không** chứng minh yêu cầu same-commit tuyệt đối. Đã lập DEPLOYMENT IMPACT MATRIX 20 dòng
(§9 của task file) để phân biệt từng loại thay đổi.

---

## D. Railway facts ĐÃ CÓ evidence (kế thừa từ TASK-087)

| # | Fact | Phạm vi |
|---|---|---|
| H1 | Auto deploy khi push **đang bật** | service `web` |
| H2 | Pre-Deploy Command `npx prisma migrate deploy` | service `web` |
| H3 | Service `web` khi đó kết nối nhánh làm việc của TASK-086 | service `web` |
| H4 | Migration TASK-086 applied thành công | database staging |
| H5 | Partial unique index tồn tại đúng tên/cột/predicate | database staging |
| H6 | Duplicate violations hiện tại = 0 | database staging |
| H7 | Cả 4 service Active/Running | 4 service |
| H8 | Core health checks PASS; backlog = 0; failed jobs = 0 | staging |

Chronology của TASK-087 được giữ nguyên: **prospective preflight chưa từng chạy trước migration
TASK-086**; đây là **operational process deviation**, **không** phải database correctness failure.

---

## E. Railway facts CÒN THIẾU — cần Human kiểm tra, cho TỪNG service

> **CẬP NHẬT: Human đã hoàn thành checklist này cho cả 4 service.** Kết quả sanitized ghi ở
> **mục O** dưới đây và task file **§21**. Mục E giữ nguyên làm bằng chứng về những gì đã được
> yêu cầu kiểm tra tại thời điểm Phase 1.

Áp dụng template §4.1 của task file cho **cả bốn** service (`web`, `worker-email`, `worker-delta`,
`worker-renewal`). Với **mỗi** service cần:

```text
[ ] source repository
[ ] source branch
[ ] deployed commit / revision (nếu UI hiển thị)
[ ] Auto Deploy: BẬT / TẮT
[ ] Pre-Deploy Command (nguyên văn, hoặc "TRỐNG")
[ ] Build Command
[ ] Start Command
[ ] Root Directory
[ ] Watch Paths / path filter (nếu có mục này)
[ ] xác nhận đúng environment staging
[ ] trạng thái hiện tại + thời điểm deployment gần nhất
```

Ba câu hỏi quyết định rút ra sau khi điền đủ:

```text
Q1. Bốn service có CÙNG source branch không?
Q2. CÓ BAO NHIÊU service có Pre-Deploy Command chứa "migrate deploy"?   ← quan trọng nhất
Q3. Bốn service có CÙNG deployed commit không?
```

**Nếu Q2 ≥ 2 ⇒ STOP condition S4.** Chỉ ghi finding, không sửa cấu hình trong Phase 1.

**Ràng buộc bảo mật của checklist:** chỉ mở tab Settings/Deployments. **Không** mở, không chụp,
không copy tab Variables. Không cần bất kỳ giá trị secret nào.

---

## F. Recommendation ở mức Phase 1

### F.1. Mô hình source — khuyến nghị **Option B**

```text
Một nhánh staging chuyên dụng. Cả 4 service khoá cố định vào nhánh đó và KHÔNG BAO GIỜ đổi source
nữa. Deploy được kích hoạt bằng PROMOTION có chủ đích, không phải bằng git push thường ngày.
```

Lý do (đã so sánh đủ 4 option theo 9 tiêu chí ở §11 task file):

1. Loại bỏ đúng nguyên nhân gốc: sự trùng nhau giữa "push code" và "deploy + migrate".
2. Loại bỏ luôn nguyên nhân "kẹt trên nguồn cũ" — sau một lần thiết lập, không còn thao tác đổi
   source nào để mà quên.
3. Tạo ra **chỗ trống tự nhiên** để cắm cổng preflight vào (giữa CI PASS và promotion) mà không bắt
   task không-migration phải chịu thêm nghi thức nào.
4. Nhẹ nhất cho một người vận hành không chuyên code.
5. Không phá dây chuyền ChatGPT → Claude Code → Antigravity CLI → Cursor → GitHub Actions —
   promotion là bước **thêm vào sau** CI, không thay thế bước nào.

Option C bị loại vì thêm một tầng nhánh dự án chưa cần (YAGNI). Option D an toàn hơn nhưng dồn toàn
bộ gánh nặng sang thao tác thủ công lặp lại.

**Promotion commit identity (bổ sung theo Antigravity review — task file §12.4):**

```text
Invariant: REVIEWED COMMIT == PROMOTED COMMIT == DEPLOYED COMMIT.
Promotion mặc định: git switch <nhánh staging> && git merge --ff-only <nhánh task đã duyệt>.
Không merge commit / squash / rebase nếu chúng đổi SHA đã review.
Fast-forward không được ⇒ STOP, báo Human/ChatGPT (không tự merge/rebase/cherry-pick).
Post-promotion: đối chiếu deployed revision trên Railway với promoted commit
trước khi coi rollout là thành công.
Phase 1 chỉ document — KHÔNG tạo staging branch, KHÔNG chạy lệnh promotion thật.
```

### F.2. Migration safety guard

Phân loại bắt buộc cho mọi task runtime: **CASE 1** (không migration) / **CASE 2** (additive, không
data precondition) / **CASE 3** (fail-closed data precondition: unique, partial unique, NOT NULL, FK,
CHECK). Không chắc ⇒ coi là CASE 3.

Ordering cho CASE 3:

```text
implement → npm run verify PASS → Antigravity PASS → push nhánh task (KHÔNG deploy)
→ GitHub Actions PASS → ── CỔNG PREFLIGHT read-only ── → chỉ khi PASS mới promotion
→ Pre-Deploy migration trên web → post-deploy verification → smoke 4 service → ROADMAP.
```

Nguyên tắc trung tâm: **preflight phải chạy trước hành động có thể TRIGGER migration, không phải
trước lệnh migrate.** Dưới Option A hai thứ đó là một (`git push`) nên preflight luôn muộn; dưới
Option B chúng tách ra.

**Preflight-to-migration race (bổ sung theo Antigravity review — task file §13.7):** read-only
preflight chỉ là snapshot; race `preflight PASS → writer vẫn chạy → dữ liệu mới vi phạm → migration
vẫn fail` là có thật. Mục tiêu thật của cổng preflight:

```text
PRECONDITION MUST REMAIN TRUE UNTIL THE MIGRATION ENFORCES IT.
```

Mỗi migration CASE 3 phải khai báo đúng một trong bốn chế độ:

```text
A — read-only preflight alone đủ (chỉ khi không có relevant writer trong cửa sổ rollout,
    hoặc application-level guard đã deploy và đang enforce invariant; phải lập luận từ code
    cho từng migration, không mặc định);
B — two-phase guard: deploy application guard backward-compatible trước, verify guard
    operational, rồi mới preflight → migration;
C — writer quiesce: pause CHỈ writer liên quan, xác minh đã ngừng ghi, chạy LẠI preflight,
    migration, verify, resume, smoke (Phase 1 chỉ document — không pause service nào);
D — STOP / multi-stage: migration không backward-compatible với mixed-version services hoặc
    không bảo đảm được precondition ổn định ⇒ tách expand/contract hoặc task riêng.
```

### F.3. Pre-Deploy ownership

```text
RECOMMENDATION (chưa phải locked decision — chờ Human checklist §4 + quyết định OD-4):
  CHỈ MỘT migration executor duy nhất. Nếu giữ mô hình Railway Pre-Deploy: web.
  worker-email / worker-delta / worker-renewal: Pre-Deploy Command TRỐNG.
```

Lý do **chính**: (1) migration phải có single executor; (2) cần ordering deterministic;
(3) tránh 4 service cạnh tranh / chạy migration lặp trên cùng database; (4) deployment/smoke của
web cung cấp một điểm kiểm soát rõ ràng (Ready + deploy log tại một chỗ).

Supporting considerations — **không** phải correctness proof: web có đường INSERT vào
`GraphSubscription` (F8, liên quan riêng invariant TASK-086), `/admin/health` nằm trên web, và web
đã là executor trên thực tế (H2) nên chi phí thay đổi thấp.

Alternative vẫn mở (OD-4): dedicated/manual one-off migration executor — gỡ `migrate deploy` khỏi
Pre-Deploy, chạy như lệnh có người bấm, nếu Railway capability phù hợp.

**Đánh đổi được nói rõ:** vì worker không chờ migration và deploy không nguyên tử (F13), worker mới
có thể start trước khi web migrate xong ⇒ **mọi migration phải backward-compatible với code cũ**.
Cách xử lý đúng khi worker cần schema mới **không** phải thêm Pre-Deploy cho worker, mà là expand
trước / promotion sau, hoặc Human chủ động promotion web trước.

---

## G. Open decisions dành cho Human/ChatGPT

> **CẬP NHẬT:** OD-1 / OD-4 / OD-7 đã **APPROVED** (mục P); OD-3 / OD-5 đã trả lời bằng evidence
> (mục O); OD-2 đủ dữ liệu cho phần cần thiết; OD-6 DEFERRED; OD-9 không kích hoạt (Q2 = 1).
> Còn mở: OD-8 (đóng divergence tài liệu — close-out Phase 2) và OD-10 (ngoài scope TASK-088).
> Bảng dưới giữ nguyên làm trạng thái tại thời điểm Phase 1.

| # | Quyết định | Trạng thái |
|---|---|---|
| OD-1 | Chọn Option A / B / C / D | **Chờ Human.** Claude đề xuất B |
| OD-2 | Railway có cho phép chọn nhánh per-service, tắt/bật Auto Deploy per-service, deploy một revision cụ thể? | HUMAN VERIFICATION REQUIRED |
| OD-3 | Pre-Deploy Command hiện tại của 3 worker | HUMAN VERIFICATION REQUIRED |
| OD-4 | Có gỡ hẳn `migrate deploy` khỏi Pre-Deploy, chạy như lệnh one-off không? | Chờ Human — đánh đổi an toàn CASE 3 vs gánh nặng CASE 2 |
| OD-5 | Bốn service có cùng deployed commit không? | HUMAN VERIFICATION REQUIRED |
| OD-6 | Có bật Watch Paths để docs-only push không redeploy không? | HUMAN VERIFICATION REQUIRED (Option B làm vấn đề này gần như tự hết) |
| OD-7 | Ai bấm promotion — Human hay Claude được uỷ quyền? | Chờ Human |
| OD-8 | Có đóng divergence tài liệu ở `docs/STAGING_DEPLOYMENT.md` §5.7/§5.12 ở Phase 2 không? | Chờ Human — Phase 1 không được sửa |
| OD-9 | Nếu Q2 ≥ 2 service có Pre-Deploy migration thì xử lý sao? | Chờ dữ liệu Human |
| OD-10 | Có cần app tự báo "đang chạy commit nào" không? | Ghi nhận — là runtime change ⇒ **ngoài scope TASK-088** |

---

## H. Remaining risks (sau Phase 1)

```text
R-1  [ĐÃ GIẢI QUYẾT — mục R] Phase 2A–2D đã thực thi: 4 service theo nhánh staging, Wait for CI
     ON, chỉ web có Pre-Deploy migration. Các rủi ro cấu trúc chính của §10 (push nhánh task =
     deploy = migrate; kẹt nguồn; drift không kiểm soát) đã được đóng bởi mô hình mới.
R-2  [THU HẸP — mục R] Push lên nhánh task KHÔNG còn trigger staging deploy, nên deviation kiểu
     TASK-087 không còn xảy ra qua đường đó. Với migration CASE 3 tương lai: rủi ro còn lại nằm
     ở kỷ luật quy trình — BẮT BUỘC preflight + khai báo mode A/B/C/D (§13.7) TRƯỚC khi
     promotion vào nhánh staging; preflight PASS một lần không đủ nếu writer vẫn có thể phá
     precondition trước khi migration enforce nó.
R-3  [ĐÃ GIẢI QUYẾT — mục O] Cấu hình 3 worker đã được Human xác minh: KHÔNG worker nào có
     Pre-Deploy migration. Chỉ web là migration executor (Q2 = 1). Rủi ro này đóng.
R-4  [PHẦN LỚN ĐÃ GIẢI QUYẾT — mục O] Human đã thấy và thao tác được các setting per-service
     cần cho Option B (source branch, Wait for CI, Pre-Deploy). Phần còn lại chỉ được xác nhận
     trọn vẹn khi Phase 2 thực thi thật (đổi source không gây hành vi bất ngờ).
R-5  Tài liệu deployment trong repo vẫn đang mô tả sai thực tế (F3) cho tới khi Phase 2 sửa.
R-6  [THU HẸP — mục R] Cơ chế tạo drift chính (mỗi task đổi source 4 lần bằng tay) đã bị loại bỏ:
     4 service khoá vào cùng nhánh staging. Drift giờ chỉ còn ở dạng cửa sổ build lệch giờ (A5 —
     không tránh được) hoặc thao tác dashboard thủ công ngoài quy trình. /admin/health vẫn không
     kiểm tra phiên bản — OD-10 (app tự báo commit) vẫn mở, ngoài scope TASK-088.
R-7  Các observation vận hành historical/current đã ghi ở TASK-087 §16.9 (mailbox
     RECONNECT_REQUIRED, mailbox disabled, renewal/webhook health UNKNOWN) KHÔNG thuộc scope
     TASK-088 và KHÔNG được coi là đã sửa.
```

---

## I. Files changed

```text
A  docs/tasks/TASK-088-railway-staging-source-alignment-migration-safety-guard.md
A  docs/reports/TASK-088-railway-staging-source-alignment-migration-safety-guard.md
```

**Không** file nào khác được tạo hay sửa. Cụ thể **không** chạm:

```text
[x] runtime code (app/, components/, lib/, services/, scripts/)
[x] prisma/schema.prisma, prisma/migrations/
[x] tests/
[x] package.json, package-lock.json
[x] .github/workflows/
[x] .env, .env.local, .env.example, deployment/
[x] docs/ROADMAP.md
[x] docs/STAGING_DEPLOYMENT.md
```

---

## J. Verification

Kết quả cụ thể (lệnh và output) được ghi ở phần báo cáo cuối cho Human trong phiên làm việc; tóm tắt:

```text
npm run verify   : (xem mục kết luận cuối phiên — docs-only nên không kỳ vọng thay đổi kết quả)
git diff --check : không có whitespace error
git status --short : chỉ 2 file docs mới của TASK-088
git diff --stat  : working tree chỉ chứa 2 file untracked của TASK-088
```

Đã đối chiếu nội dung hai file với pattern secret scan của `.github/workflows/ci.yml` để tránh false
positive (đặc biệt: **không ghi tên nhánh Git đầy đủ**, không dòng metadata dạng "từ khoá nhạy cảm:
giá trị").

---

## K. Security

```text
[x] Không ghi connection string database/Redis.
[x] Không ghi access token, refresh token, client secret của Microsoft, bot token của Telegram,
    encryption key, session secret.
[x] Không ghi verification code, full email body, email address.
[x] Không copy giá trị Railway Variables.
[x] Checklist Human chỉ yêu cầu Settings/Deploy, KHÔNG yêu cầu mở tab Variables.
[x] Không đọc, không in, không sửa .env / .env.local / .env.staging / .env.production.
[x] Query đề xuất cho Human là READ-ONLY và không trả về dữ liệu khách hàng.
[x] Không nới lỏng secret scan.
[x] Không ghi tên nhánh Git đầy đủ.
```

---

## L. STOP conditions gặp phải trong Phase 1

```text
Không kích hoạt STOP nào ở bước precheck hay bước đọc repo.

Đang ở trạng thái CHỜ DỮ LIỆU cho các STOP condition sau (chưa kích hoạt, chưa loại trừ):
  S2  — source branch / deployed commit từng service chưa xác minh được
  S3  — Auto Deploy / Pre-Deploy của 3 worker chưa rõ
  S4  — chưa biết có bao nhiêu service chạy migration (§E, Q2)

Đã tuân thủ trước S6/S7/S9/S10: không thay đổi Railway settings, không chạm production,
không sửa runtime/schema/test/CI, không đọc .env.
```

---

## N. Corrections áp dụng theo Antigravity Architecture Review

Antigravity kết luận **PASS — TASK-088 PHASE 1 ARCHITECTURE READY FOR HUMAN DECISIONS**, kèm
2 finding Medium + 1 finding Low. Các correction đã phản ánh vào source-of-truth:

| # | Finding | Mức | Đã phản ánh ở |
|---|---|---|---|
| C1 | Promotion chưa khoá chặt commit identity | Medium | Task file **§12.4** (mới): invariant `REVIEWED == PROMOTED == DEPLOYED`, promotion mặc định `git merge --ff-only`, cấm merge commit/squash/rebase đổi SHA đã review, ff không được ⇒ STOP, post-promotion đối chiếu deployed revision với promoted commit. Đồng bộ vào §13.3 (bước 9, 11), §15.3 (mục 9–10), §19 (S14) |
| C2 | CASE 3 chưa cover race preflight-PASS → writer ghi dữ liệu vi phạm → migration vẫn fail | Medium | Task file **§13.7** (mới): nguyên tắc "PRECONDITION MUST REMAIN TRUE UNTIL THE MIGRATION ENFORCES IT" + 4 chế độ A (preflight alone đủ, có điều kiện) / B (two-phase guard) / C (writer quiesce) / D (STOP / multi-stage). Đồng bộ vào §13.1 (bảng CASE 3), §13.3 (bước 7), §13.6 (I7), §15.3 (mục 5), §19 (S13) |
| C3 | Không gọi F1 là "root cause trực tiếp" | Low | Task file **§2.1**: phân loại lại — direct operational cause là tổ hợp (branch được theo dõi bị push + Auto Deploy bật + web có automatic Pre-Deploy migration + không có gate trước trigger); F1 là contributing architectural / auditability / config-drift weakness. Đồng bộ bảng C (dòng F1) của report này |
| C4 | Rationale cho web = migration executor dựa quá nhiều vào GraphSubscription INSERT / `/admin/health` | (đi kèm) | Task file **§14.2**: lý do chính = single executor + deterministic ordering + tránh 4 service cạnh tranh/chạy lặp + web là điểm kiểm soát rõ ràng; GraphSubscription INSERT và `/admin/health` hạ xuống supporting consideration, không phải correctness proof; ghi rõ đây là RECOMMENDATION chưa locked, alternative one-off executor vẫn mở (OD-4). Đồng bộ §F.3 và dòng F8 của report này |

Không phần nào khác của task file bị viết lại: 4-service inventory, Deployment Impact Matrix,
evidence labels, Railway Human checklist, phân tích queue compatibility, finding source-lag hiện
tại và scope Phase 1 giữ nguyên.

---

## O. Human-observed Railway evidence (checklist §4 — đã hoàn thành; chi tiết ở task file §21)

**Sanitized summary — Human quan sát dashboard (không mở tab Variables), Claude không truy cập
Railway:**

Cả bốn service (`web`, `worker-email`, `worker-delta`, `worker-renewal`):

```text
[x] Cùng GitHub repository; cùng source branch (nhánh làm việc của TASK-086).
[x] Auto Deploy = ON; Wait for CI = OFF; Builder = Railpack mặc định; 1 replica.
[x] Không Custom Build Command; không Watch Paths; không Root Directory.
[x] Deployment hiện tại Active / successful.
[x] Start Command đúng kỳ vọng repo: npm run start / worker:email / worker:delta / worker:renewal.
[x] Pre-Deploy: CHỈ web có `npx prisma migrate deploy`; ba worker KHÔNG có.
```

**Verdict Q1/Q2/Q3:**

```text
Q1 (cùng source branch?)      : CÓ — cả bốn cùng nhánh TASK-086.
Q2 (bao nhiêu migration executor?) : ĐÚNG MỘT (web) ⇒ STOP condition S4 KHÔNG xảy ra;
                                     hiện trạng ĐÃ KHỚP recommendation §14 / OD-4.
Q3 (cùng deployed commit?)    : Railway UI KHÔNG expose SHA trực tiếp trong các màn hình đã
                                kiểm tra. Evidence chain: cả 4 cùng branch + cùng commit message
                                "fix: guard concurrent graph subscription provisioning" + cùng
                                đợt deploy; Git local/remote xác nhận tip nhánh TASK-086 =
                                b8eaa01ec942f1cb187800dde2c98a536a7b86b2. Không có evidence
                                service nào chạy revision khác. (Suy luận qua chain — không
                                phải Railway hiển thị SHA trực tiếp.)
```

Hệ quả lên finding Phase 1: A2/P2 đã trả lời; P6 không xảy ra; A4 xác nhận (không Watch Paths);
D-S4 hiện không drift; OD-3/OD-5 đóng; OD-6 (Watch Paths) phân loại **optional operational
optimization, không phải correctness requirement — DEFERRED**, TASK-088 không tự cấu hình.

---

## P. Locked Human/ChatGPT decisions (chi tiết ở task file §22)

```text
OD-1 — APPROVED: Option B — dedicated staging branch. Bốn service cố định vào một nhánh staging
       chuyên dụng; task branch không còn được staging theo dõi; push task branch chỉ phục vụ
       source control + GitHub Actions.

OD-4 — APPROVED (mô hình staging hiện tại): web là SOLE Pre-Deploy migration executor
       (`npx prisma migrate deploy`); ba worker KHÔNG Pre-Deploy migration. Rationale: single
       executor, deterministic ordering, tránh nhiều service cùng chạy migration, đơn giản cho
       Human operator, web deployment là control point rõ. KHÔNG dựa vào GraphSubscription INSERT
       làm correctness proof. Manual one-off executor vẫn là future alternative.
       Evidence mục O xác nhận hiện trạng ĐÃ ĐÚNG quyết định này — Phase 2 không đổi Pre-Deploy.

OD-7 — APPROVED: promotion do HUMAN thực hiện bằng PowerShell theo hướng dẫn ChatGPT.
       Claude Code / Antigravity không promotion; không agent nào tự thay đổi Railway.

WAIT-FOR-CI (quyết định Phase 2 bổ sung): giữ Auto Deploy = ON trên nhánh staging; đổi
       Wait for CI OFF → ON cho CẢ BỐN service. Mục tiêu: promotion push → GitHub Actions PASS
       → Railway mới deploy. Defense-in-depth vá finding F2 ở tầng nhánh staging.

PROMOTION INVARIANT (giữ nguyên §12.4): REVIEWED == PROMOTED == DEPLOYED;
       ff-only; ff fail ⇒ STOP; không merge commit / squash / rebase đổi SHA đã review.

DOCS-ONLY RULE (§22.6): không phải mọi task completed đều promotion staging; task docs-only
       không cần promotion/redeploy; staging được phép ở runtime commit cũ hơn HEAD; docs commit
       ở giữa đi cùng history khi runtime task sau promotion ff. ChatGPT dùng Deployment Impact
       Matrix để chỉ rõ service cần deploy.
```

---

## Q. Phase 2 Execution Plan — tóm tắt (kế hoạch đầy đủ ở task file §23; CHƯA THỰC THI)

```text
2A — Tạo nhánh staging an toàn: nhánh `staging` trỏ ĐÚNG commit TASK-086
     b8eaa01ec942f1cb187800dde2c98a536a7b86b2 (KHÔNG phải HEAD — không đưa docs TASK-087/088
     hay runtime chưa chủ đích vào staging). Human tạo/push bằng PowerShell khi Railway còn theo
     nhánh TASK-086 (không trigger deploy). GitHub Actions trên nhánh staging PHẢI PASS trước 2C.

2B — Railway safety settings (TRƯỚC khi đổi source), thứ tự worker-renewal → worker-delta →
     worker-email → web: bật Wait for CI = ON cho cả 4. KHÔNG đổi Auto Deploy / Build Command /
     Watch Paths / Pre-Deploy / Start Command. Verify sau từng service.

2C — Chuyển source 4 service sang nhánh staging, TỪNG service một (không giả định atomic),
     thứ tự worker-renewal → worker-delta → worker-email → web (web cuối vì có Pre-Deploy).
     Cùng commit ⇒ zero runtime change; web Pre-Deploy nếu chạy phải là no-op
     ("không có pending migration"). Verify sau từng bước; lệch kỳ vọng ⇒ STOP.

2D — Verification: cả 4 source = staging, Wait for CI ON, Auto Deploy ON, Pre-Deploy chỉ web,
     Start Command không đổi, Active. Web không apply migration mới. Smoke: web + /admin/health
     + email worker + delta polling + renewal + queue/Redis. Không dùng production.

2E — Future promotion runbook 15 bước: task branch → implement → verify → Antigravity →
     push + CI task branch → classify impact (docs-only ⇒ dừng, không promotion) → CASE 3 thì
     chọn mode A/B/C/D và giữ precondition đúng tới migration → HUMAN ff-only promotion →
     CI staging PASS → Railway deploy → web sole migration executor → đối chiếu deployed
     revision (mức UI cho phép — evidence chain như mục O) → smoke theo impact → ROADMAP.

Ghi chú: với hiện trạng cùng branch + không Watch Paths, một promotion có thể trigger deploy
cả 4 service — chấp nhận được (cùng commit, backward-compatible §8). Watch Paths = DEFERRED.

STOP riêng Phase 2 (task file §23.1): CI staging FAIL; tip staging sai SHA; service không trở
lại Active; web Pre-Deploy định apply migration ngoài kỳ vọng; đòi đọc secret/Variables;
cấu hình lệch §21.1 trước khi bắt đầu.
```

---

## R. PHASE 2 EXECUTION EVIDENCE — tóm tắt (chi tiết đầy đủ ở task file §24)

> Phase 2 Plan Review: **PASS — TASK-088 PHASE 2 PLAN APPROVED FOR CONTROLLED HUMAN EXECUTION.**
> Human đã thực thi 2A–2D theo đúng plan. Claude không chạm Railway (OD-7). Evidence sanitized.

### R.1. Verdict từng phase

```text
PHASE 2A — Tạo branch staging:  PASS
  Human: fetch → xác minh branch chưa tồn tại → tạo tại ĐÚNG commit TASK-086
  b8eaa01ec942f1cb187800dde2c98a536a7b86b2 (không tạo từ HEAD TASK-088) → push →
  GitHub Actions trên staging/b8eaa01 PASS.
  Repo-verified độc lập: git ls-remote origin refs/heads/staging → đúng SHA kỳ vọng.

PHASE 2B — Wait for CI:  PASS
  Bật Wait for CI = ON cho cả 4 (thứ tự renewal → delta → email → web); Auto Deploy giữ ON.
  Railway staged changes được Human kiểm tra CHỈ chứa đúng 4 thay đổi Wait-for-CI rồi mới apply.
  Không đổi source/Build/Start/Pre-Deploy/Watch Paths/Variables/replica ở bước này.

PHASE 2C — Source switch:  PASS
  Chuyển từng service một (không giả định atomic), mỗi service verify Active trước khi tiếp.
  Sau switch cả 4: source = staging; Auto Deploy ON; Wait for CI ON; Active/successful;
  Start Command không đổi; Pre-Deploy vẫn CHỈ web.

WEB PRE-DEPLOY (wording đúng mức):
  Prisma schema + datasource staging load thành công; Prisma tìm thấy 9 migrations trong thư mục;
  KHÔNG có evidence dòng apply migration mới; KHÔNG migration failure / P3009.
  "Pre-Deploy completed successfully; no evidence of a new migration being applied;
   application container then started successfully." Next.js Ready; web Active.
  (Không khẳng định log có nguyên văn "No pending migrations".)

PHASE 2D — Admin health smoke:  PASS — no new deployment-source-alignment regression observed.
  Email worker pipeline PASS | Delta polling PASS | Queue/Redis PASS | Telegram send PASS.
  Subscription renewal UNKNOWN + Webhook health UNKNOWN = pre-existing limitations (TASK-087
  §16.9), KHÔNG phải TASK-088 regression.
  Mailbox: ~275 tổng, phần lớn Ready/Active; một số RECONNECT_REQUIRED + 1 disabled/error
  (pre-existing); SUBSCRIPTION_EXPIRED = 0; EXPIRING <24H = 0; Telegram failures 24h = 0.
  Queue: backlog/waiting/active/delayed = 0; failed 60 phút gần nhất = 0; một số ít skipped;
  mailbox-busy defers = 0; latency bình thường.
  PHÂN BIỆT: cumulative FAILED historical count ≠ recent deployment regression.
```

### R.2. Observation không quy cho TASK-088

Một Graph **410 / SyncStateNotFound** error quan sát được trên dashboard — phân loại
**EXISTING / INDEPENDENT OPERATIONAL OBSERVATION**: Graph/runtime operational; Delta polling hiện
PASS; TASK-088 không thay runtime; không có evidence source switch gây ra. Không mở rộng scope để
fix. (Cùng phân loại: hai UNKNOWN và các mailbox observation nêu trên — chi tiết task file §24.6.)

### R.3. Overall verdict + final staging model

```text
PHASE 2A PASS · PHASE 2B PASS · PHASE 2C PASS · PHASE 2D PASS
Overall: TASK-088 CONTROLLED STAGING EXECUTION COMPLETED WITHOUT OBSERVED REGRESSION.
Không STOP condition nào (S1–S14, P2-S1..P2-S6) bị kích hoạt.

FINAL STAGING MODEL (từ nay):
  Cả 4 service theo branch: staging  (không còn theo nhánh task hay nhánh feature nào trực tiếp)
  Auto Deploy = ON | Wait for CI = ON
  Migration executor: CHỈ web (npx prisma migrate deploy); 3 worker không Pre-Deploy
  Watch Paths: chưa cấu hình — deferred optional optimization
  Deployed content: commit TASK-086 b8eaa01ec942f1cb187800dde2c98a536a7b86b2 (không đổi)

FUTURE TASKS: docs-only ⇒ không promote/redeploy; runtime ⇒ ChatGPT dùng Deployment Impact
Matrix; không Watch Paths ⇒ một promotion có thể trigger cả 4; migration CASE 3 ⇒ Mode A/B/C/D
(§13.7), precondition phải giữ đúng tới lúc migration enforce invariant.

TASK-088 CHƯA completed/closed — chờ Antigravity FINAL EXECUTION REVIEW.
```

---

## M. Kết luận

```text
PHASE 1 DELIVERABLE: HOÀN THÀNH ở mức tài liệu.

  [x] Context / root operational problem
  [x] Existing evidence từ TASK-087 (không viết lại chronology)
  [x] Exact repo deployment architecture (13 finding có REPO EVIDENCE)
  [x] 4-service inventory matrix (đủ 10 mục cho mỗi service)
  [x] Human Railway evidence checklist (không yêu cầu secret)
  [x] Deploy-source findings
  [x] Auto Deploy findings
  [x] Pre-Deploy findings
  [x] Code-level service coherency analysis (trả lời đủ 5 câu hỏi)
  [x] Deployment impact matrix (20 loại thay đổi × 4 service × migration × thứ tự)
  [x] Feature-branch risk analysis (10 kịch bản + bảng xếp hạng rủi ro)
  [x] Source/promotion options A/B/C/D + so sánh 9 tiêu chí
  [x] Recommended architecture (Option B, có lý do và có điều kiện phụ thuộc)
  [x] Promotion commit identity invariant (§12.4 — ff-only, reviewed == promoted == deployed)
  [x] Migration safety guard (CASE 1/2/3 + ordering + 7 bất biến I1–I7 + chế độ chống race
      A/B/C/D §13.7 + phương án dự phòng)
  [x] Pre-Deploy ownership recommendation (single executor, đề xuất web — chưa locked, chờ OD-4)
  [x] Future runtime-task deployment workflow (10 câu trả lời + bảng tra + checklist promotion)
  [x] Rollback principles
  [x] Security constraints
  [x] Open questions / Human decisions (OD-1..OD-10)
  [x] STOP conditions (S1..S12)
  [x] Phase-2 boundary

TASK-088 KHÔNG được ghi là completed. ROADMAP CHƯA được cập nhật.

TRẠNG THÁI: PHASE 2A–2D ĐÃ ĐƯỢC HUMAN THỰC THI THEO PLAN ĐÃ APPROVED —
            EXECUTION EVIDENCE ĐÃ GHI (mục R / task file §24) —
            2A PASS · 2B PASS · 2C PASS · 2D PASS —
            TASK-088 CONTROLLED STAGING EXECUTION COMPLETED WITHOUT OBSERVED REGRESSION.

KẾT LUẬN: READY FOR ANTIGRAVITY FINAL EXECUTION REVIEW.

Phạm vi review đề nghị: task file §24 (execution evidence + verdicts + final staging model +
observations không quy cho TASK-088) và mục R của report này, đối chiếu với plan §23 đã được
approve. Kiến trúc §0–§20 và evidence/decisions/plan §21–§23 đã PASS các vòng review trước,
không bị viết lại — chỉ bổ sung ghi chú trạng thái.

Sau khi Antigravity Final Execution Review PASS: close-out theo workflow (cập nhật ROADMAP,
commit/push theo quy trình — KHÔNG làm ở bước này). Các việc ngoài scope vẫn giữ nguyên:
orphan cleanup, production, Watch Paths (deferred), OD-8 (đóng divergence tài liệu deployment),
OD-10 (app tự báo commit).
```
