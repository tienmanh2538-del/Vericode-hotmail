# TASK-087 — Staging Migration Preflight & Controlled Rollout Validation (Final Report)

> **PHASE 2 — STAGING EXECUTION EVIDENCE.**
> Không sửa runtime code, migration, schema, test. Không thao tác Railway. Không chạy migration.
> Không đụng production. Không update `docs/ROADMAP.md`. Không commit. Không push.
>
> Kế hoạch đầy đủ + evidence chi tiết:
> `docs/tasks/TASK-087-staging-migration-preflight-rollout-validation.md` (mục 16).

---

## 0. Ranh giới bằng chứng (đọc trước)

| Loại | Ai tạo ra | Gồm những gì |
|---|---|---|
| **Repo/code evidence** | **Claude** đọc file trong repo, chạy `npm run verify` trên máy local | Nội dung migration TASK-086, `prisma/schema.prisma`, `package.json`, code `graph-subscription.service.ts`, docs staging, CI secret-scan pattern |
| **Human-observed staging evidence** | **Human** thao tác/quan sát trên Railway dashboard + deploy log + chạy read-only query trên PostgreSQL staging | Deploy source, Pre-Deploy Command, deploy log, 3 kết quả query, trạng thái 4 service, `/admin/health` |

**Claude KHÔNG truy cập Railway, KHÔNG chạy migration, KHÔNG chạy query trên staging database.**
Mọi khẳng định về staging trong report này là ghi lại và phân loại evidence do Human cung cấp.

Production **hoàn toàn ngoài scope**: không rollout production, không hướng dẫn migration production.

---

## A. Precheck

| Lệnh | Kết quả |
|---|---|
| `git branch --show-current` | Đúng nhánh làm việc của TASK-087 |
| `git status --short` | Chỉ 2 file docs TASK-087 (untracked) |
| `git diff --stat` | **rỗng** — không có tracked change |
| `git log -1 --oneline` | `b8eaa01 fix: guard concurrent graph subscription provisioning` |

Không có unexpected runtime / schema / migration / test change → **không STOP**.

---

## B. Files changed

```text
docs/tasks/TASK-087-staging-migration-preflight-rollout-validation.md    (cập nhật: header,
                                                                          §14, §15, thêm §16)
docs/reports/TASK-087-staging-migration-preflight-rollout-validation.md  (viết lại: final report)
```

Không đụng: runtime code, `prisma/schema.prisma`, migration, test, `.env*`, GitHub Actions,
`docs/ROADMAP.md`.

---

## C. Actual Railway deployment chronology

Chronology **thực tế** (Human-observed):

```text
1. TASK-086 được push lên GitHub.
2. Railway staging AUTO DEPLOY (auto deploy khi push đang bật).
3. Pre-Deploy Command của service web chạy: npx prisma migrate deploy
4. Migration 20260829000000_task086_one_live_graph_subscription được xử lý;
   deploy log kết thúc bằng "All migrations have been successfully applied."
5. Web container start thành công và đạt trạng thái Ready.
6. TASK-087 Phase 1 (investigation) phát hiện hành vi automatic migration này.
7. Human thực hiện POST-DEPLOYMENT read-only verification (§E, §F, §G).
```

**Không có bước nào là "preflight chạy trước migration".** Report này không ghi — và không được đọc
thành — việc preflight đã pass trước khi migration chạy.

Deploy source (Human-observed): Railway service `web` staging đang kết nối nhánh làm việc của
TASK-086 — nhánh chứa cả implementation lẫn thư mục migration TASK-086. Auto deploy khi push GitHub
**đang bật**. Đây là câu trả lời cho open decision D1 của Phase 1.

---

## D. Automatic Pre-Deploy migration finding

Railway service `web` staging có **Pre-Deploy Command thực tế**:

```text
npx prisma migrate deploy
```

Deployment của TASK-086 đã **tự động** chạy command này. Human quan sát deploy log: migration
`20260829000000_task086_one_live_graph_subscription` được xử lý, log kết thúc bằng
`All migrations have been successfully applied.`, sau đó web container start thành công và Ready.

**Không có evidence** về migration failure hoặc P3009.

Ý nghĩa: rủi ro mà preflight §5.E2 của Phase 1 nêu ra là **có thật và đã hiện thực hoá** — một push
vào nhánh mà staging đang theo dõi có thể apply migration **mà không đi qua bất kỳ cổng preflight
thủ công nào**. Đây là finding vận hành quan trọng nhất của TASK-087, và là câu trả lời cho open
decision D2.

---

## E. Migration-state verification

Query 1 — Prisma migration state (read-only, Human chạy trên PostgreSQL staging):

```text
- migration TASK-086 tồn tại trong bảng lịch sử migration;
- finished_at CÓ giá trị;
- applied_steps_count = 1;
- không ở trạng thái rolled back / failed.
```

```text
Verdict: PASS
```

---

## F. Unique-index verification

Query 2 — `pg_indexes` (read-only, Human chạy). Trả về **đúng một row**:

```text
GraphSubscription_mailboxId_live_unique
```

`indexdef` xác nhận:

```text
[x] CREATE UNIQUE INDEX
[x] table GraphSubscription
[x] btree trên mailboxId (một cột)
[x] predicate gồm đúng ACTIVE, RENEWING, FAILED
```

PostgreSQL hiển thị predicate ở dạng normalized `status = ANY (ARRAY[...])` thay cho literal
`IN (...)` trong file migration. **Hai biểu thức tương đương** — PostgreSQL chuẩn hoá
`IN (danh sách hằng)` thành `= ANY (ARRAY[...])` khi lưu predicate của index. Đây **không** phải
lệch predicate và **không** kích hoạt STOP condition của kế hoạch (§9.3 trong task doc).

```text
Verdict: PASS
```

Đây là bằng chứng **mạnh nhất và độc lập với khối lượng dữ liệu**: ràng buộc ở tầng database đã ở
đúng chỗ, đúng hình dạng.

---

## G. Duplicate verification

Query 3 — duplicate query theo đúng live predicate `ACTIVE` / `RENEWING` / `FAILED` (read-only,
Human chạy):

```text
violating_mailboxes = 0
```

```text
Verdict: PASS
```

Không ghi mailbox identifier cụ thể (không cần cho remediation vì kết quả = 0).

**Ngữ nghĩa chính xác:** đây là **post-deployment verification** — xác nhận trạng thái hiện tại của
staging không vi phạm invariant. Nó **không phải** preflight và **không** chứng minh preflight đã
từng được chạy.

---

## H. Services / admin-health smoke evidence

Bốn Railway service đều `Active / Running` (Human-observed):

```text
[x] web
[x] worker-email
[x] worker-delta
[x] worker-renewal
```

`/admin/health` staging — core operational checks quan sát được:

```text
[x] Email worker pipeline:      PASS
[x] Delta polling:              PASS
[x] Queue / Redis:              PASS
[x] Telegram send reliability:  PASS
```

Queue observation:

```text
backlog total = 0 | waiting = 0 | active = 0 | delayed = 0
jobs failed trong 60 phút gần nhất = 0
```

Ánh xạ sang smoke plan Phase 1: **S1–S3 và phần lớn S4/S5 có evidence**. Reconciliation dry-run
(§10.2 task doc) và smoke tuỳ chọn O1/O2 (§10.3) **chưa chạy**.

---

## I. Operational observations not attributed to TASK-087

Dashboard vẫn hiển thị một số vấn đề vận hành historical/current. **Không** copy email address từ
dashboard vào tài liệu. Tóm tắt (Human-observed):

| Observation | Phân loại |
|---|---|
| Một số mailbox ở trạng thái `RECONNECT_REQUIRED` | Existing / independent operational observation |
| Một mailbox disabled/error | Existing / independent operational observation |
| Dashboard có Graph-related error observation (historical/current) | Existing / independent operational observation |
| `Subscription renewal` = UNKNOWN vì dashboard báo chưa ghi nhận Graph subscription nào | Existing / independent operational observation |
| `Webhook health` = UNKNOWN vì receipt history không được track đủ để kết luận delivery health | Existing / independent operational observation |

Với tất cả các mục trên:

```text
— KHÔNG phải evidence của migration failure;
— KHÔNG được ghi là đã được TASK-087 sửa (TASK-087 không sửa runtime code);
— KHÔNG được kết luận là regression của TASK-086 khi không có evidence;
— NẰM NGOÀI scope remediation của TASK-087.
```

---

## J. Process deviation / future rollout lesson

Kế hoạch Phase 1:

```text
(pause writers nếu cần) -> duplicate preflight -> migrate -> verify -> resume
```

Thực tế:

```text
migrate (tự động, do Pre-Deploy Command) -> post-deployment verify
```

```text
Prospective preflight was not executed before this migration because
Railway automatic Pre-Deploy migration had already applied TASK-086
before TASK-087 Phase 2.
```

Phân loại trung thực:

* Đây là **operational process observation** — quy trình rollout không chạy như thiết kế.
* Đây **KHÔNG** phải database correctness failure ở thời điểm hiện tại: migration applied, index
  đúng, duplicate hiện tại = 0.
* Cơ chế fail-closed M2 của migration vẫn giữ nguyên giá trị — chỉ là nó đã "tự quyết định" bên
  trong pipeline deploy thay vì dưới một cổng preflight có chủ đích. Nếu staging từng có duplicate
  thì deploy đã fail và web sẽ không Ready; evidence cho thấy điều đó **không** xảy ra.

**Residual lesson (không mở task mới, không tự gán số task):**

```text
Với mọi migration tương lai có fail-closed data precondition (unique / partial-unique index,
NOT NULL, FK mới, CHECK constraint...), read-only preflight PHẢI được chạy TRƯỚC bất kỳ hành
động nào có thể trigger auto-deploy / Pre-Deploy migration — nghĩa là trước cả bước push lên
nhánh mà staging đang theo dõi, chứ không phải chỉ trước một lệnh migrate thủ công.
```

Việc có siết quy trình này thành thay đổi cấu hình/tài liệu hay không là quyết định của
Human/ChatGPT.

---

## K. Security

```text
[x] Không ghi database URL, Redis URL, token, refresh token, client secret, bot token,
    credential ciphertext, verification code, full email body.
[x] Không copy email address nhìn thấy trên dashboard vào tài liệu.
[x] Không ghi mailbox identifier cụ thể (không cần vì duplicate = 0).
[x] Không đọc/sửa .env*; không sửa GitHub Actions; không sửa secret scan.
[x] Không thao tác production database, không hướng dẫn migration production.
[x] Wording tránh false positive secret scan: không ghi tên nhánh Git đầy đủ, task id viết HOA,
    không viết tên biến secret kèm dấu bằng.
[x] Tự chạy pattern secret-scan của CI trên 2 file docs (bỏ CR để mô phỏng blob LF như CI Linux)
    -> CLEAN.
```

---

## L. `npm run verify`

| Lệnh | Kết quả |
|---|---|
| `npm run verify` (generate + lint + typecheck + test + build) | **PASS — exit code 0** |
| Test | **104 test files / 1281 tests passed** |
| Lint / Typecheck / Build | PASS (`✓ Compiled successfully`) |
| `git diff --check` | sạch |

Số liệu không đổi so với TASK-086 vì Phase 2 chỉ sửa docs.

---

## M. Git status / diff

```text
Branch:  đúng nhánh làm việc của TASK-087
HEAD:    b8eaa01 (TASK-086)
Tracked changes: KHÔNG có (git diff --stat rỗng)
Untracked:       đúng 2 file docs TASK-087
Không commit. Không push. Không tag. Không đụng ROADMAP.
```

---

## N. Remaining risks

1. **Auto-deploy bỏ qua cổng preflight (vận hành).** Pre-Deploy Command `npx prisma migrate deploy`
   + auto deploy khi push nghĩa là mọi migration tương lai sẽ tự apply lên staging khi push. Với
   migration có fail-closed precondition, đây là rủi ro quy trình cần Human/ChatGPT quyết định cách
   xử lý (§J). TASK-087 **không** tự sửa cấu hình này.
2. **Duplicate = 0 dưới áp lực dữ liệu thấp.** Dashboard báo chưa ghi nhận Graph subscription nào
   (§I). Nếu staging hiện không có row nào ở live status thì `violating_mailboxes = 0` là kết quả
   **đúng nhưng ít áp lực dữ liệu**: index đã tồn tại và đúng hình dạng (§F), nhưng **chưa được
   chứng minh dưới tải provisioning đồng thời thật**.
3. **Chưa quan sát ownership-conflict path thật.** Hành vi P2002 → `ownership_conflict` chỉ có thể
   xác nhận trực tiếp với một Microsoft TEST mailbox hoạt động — vẫn là open decision D5, và là
   smoke tuỳ chọn cần Human approve trước khi chạy.
4. **Smoke chưa đầy đủ.** Reconciliation dry-run và smoke tuỳ chọn O1/O2 chưa chạy.
5. **Orphan remote subscription vẫn deferred (TASK-086 O4).** Nếu về sau staging xuất hiện log 409
   mà local không có live winner (`conflict_unowned`, `source: 'remote_conflict'`), đó là evidence
   để Human/ChatGPT cân nhắc follow-up. **Không tự mở task mới, không tự gán số task.**
6. **Mailbox `RECONNECT_REQUIRED` / disabled / Graph error / renewal + webhook UNKNOWN** — quan sát
   vận hành độc lập, ngoài scope TASK-087, không được quy cho TASK-086 khi chưa có evidence (§I).
7. **Production chưa rollout và cố ý ngoài scope.** Không có bước nào của TASK-087 chạm production.

---

## P1. Phụ lục — Repo/code evidence từ Phase 1 (tóm tắt)

Do Claude xác minh trực tiếp trong repo (không phải từ report TASK-086):

* Migration `20260829000000_task086_one_live_graph_subscription` chỉ có **một DDL**:
  `CREATE UNIQUE INDEX IF NOT EXISTS "GraphSubscription_mailboxId_live_unique"
  ON "GraphSubscription" ("mailboxId") WHERE "status" IN ('ACTIVE','RENEWING','FAILED');`
* **Không** `UPDATE` / `DELETE` / backfill / dedupe / `DROP` / `ALTER`; **không** chạm `Mailbox`;
  idempotent (`IF NOT EXISTS`); **không** chứa secret.
* Enum `GraphSubscriptionStatus` có 4 giá trị (`ACTIVE / EXPIRED / FAILED / RENEWING`) → predicate
  phủ đúng 3 giá trị live; `EXPIRED` không bị ràng buộc nên lịch sử subscription được giữ.
* Index **cố ý** không có trong `schema.prisma` (Prisma 5.22.0 không biểu diễn được partial unique
  index), có ghi chú drift ở model `GraphSubscription`, cùng precedent với TASK-068A.
* `services/microsoft/graph-subscription.service.ts`: compensating remote DELETE chỉ nhắm
  `subscriptionId` của chính operation đó, **không bao giờ** cleanup theo `mailboxId` → code cũ vẫn
  fail-open an toàn nếu gặp index trước khi được nâng cấp.
* Repo **không** có `railway.json` / `Procfile` / `nixpacks.toml`, và `package.json` không có script
  nào tự chạy migration — nên hành vi tự-migrate chỉ có thể đến từ cấu hình dashboard. Phase 2 đã
  xác nhận đúng như vậy (§D).

---

**READY FOR ANTIGRAVITY TASK-087 FINAL REVIEW — NO COMMIT / NO PUSH**
