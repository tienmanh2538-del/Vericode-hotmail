# TASK-087 — Staging Migration Preflight & Controlled Rollout Validation

> **TRẠNG THÁI: PHASE 2 — ĐÃ CÓ STAGING EXECUTION EVIDENCE.**
>
> Mục 0–15 là **kế hoạch Phase 1** (giữ nguyên làm source of truth về ý định thiết kế).
> Mục **16** là **evidence thực tế do Human quan sát trên Railway staging**.
>
> **Đọc mục 16 trước khi dùng mục 5–8 làm hướng dẫn:** rollout thực tế **KHÔNG** diễn ra theo
> thứ tự ở §8.2. Railway `web` staging có Pre-Deploy Command `npx prisma migrate deploy`, nên
> migration TASK-086 đã được **tự động apply** ngay khi TASK-086 được push/deploy, **trước khi**
> TASK-087 Phase 2 kịp chạy preflight dự phòng. Prospective preflight **chưa từng được thực thi
> trước migration này**. Chi tiết + bài học ở §16.4.
>
> Ranh giới bằng chứng trong tài liệu này:
> * **Repo/code evidence** — Claude đọc trực tiếp file trong repo và chạy `npm run verify`.
> * **Human-observed staging evidence** — Human thao tác/quan sát trên Railway dashboard và chạy
>   read-only query trên PostgreSQL staging. **Claude KHÔNG truy cập Railway, KHÔNG chạy
>   migration, KHÔNG chạy query trên staging.**
>
> Vẫn giữ nguyên: **không** sửa runtime code, **không** sửa migration/schema/test, **không** đụng
> production, **không** update `docs/ROADMAP.md`, **không** commit/push.
>
> Sanitized: không token / refresh token / client secret / bot token / verification code /
> full email body / connection string / email address. Không lệnh nào yêu cầu paste secret vào chat.
>
> Quy ước tài liệu: không ghi tên nhánh Git đầy đủ (tránh false positive của CI secret scan).
> Khi cần nhắc, viết là "nhánh làm việc của task hiện tại".

---

## 0. Mục tiêu

TASK-086 đã hoàn tất ở mức code + migration đã commit, nhưng **migration chưa được apply vào
bất kỳ database thật nào** (đúng remaining item (2) và (3) mà dòng TASK-086 trong ROADMAP ghi rõ).

TASK-087 xác định **chính xác** cách đưa migration TASK-086 lên **staging** theo kiểu fail-closed:
có preflight read-only, có STOP conditions, có hậu kiểm, có smoke test tối thiểu, và có quy trình
xử lý khi lỗi.

Phase 1 = lập kế hoạch + xác minh sự thật trong repo.
Phase 2 = Human thực thi trên Railway staging, sau đó ghi kết quả vào report.

---

## 1. Precheck (Phase 1)

```text
git branch --show-current   -> đúng nhánh làm việc của TASK-087
git status --short          -> rỗng (working tree sạch)
git diff --stat             -> rỗng
git log -1 --oneline        -> b8eaa01 fix: guard concurrent graph subscription provisioning
```

HEAD chứa đầy đủ TASK-086 (runtime + migration + tests + docs + dòng ROADMAP của TASK-086).
Không có unexpected change. Không reset, không stash, không tự cleanup.

---

## 2. Nguồn đã đọc trực tiếp (không chỉ dựa vào report TASK-086)

| Nguồn | Dùng để xác minh |
|---|---|
| `AGENTS.md` | luật chung, cấm thao tác production database |
| `CLAUDE.md` | quy trình trước/sau khi sửa, quy ước wording tránh secret scan |
| `ANTIGRAVITY.md` | vai trò reviewer độc lập, format review |
| `docs/SECURITY_RULES.md` | §1 secrets, §3 tokens, §4 logging, §7 database, §9 AI agent rules |
| `docs/STAGING_DEPLOYMENT.md` | §5.7 migration staging, §5.8 worker, §5.9 smoke, §5.10 rollback, §5.12 Railway |
| `docs/MICROSOFT_SETUP.md` | §3.4 staging redirect/webhook, §5 scope tối thiểu |
| `docs/ROADMAP.md` | dòng TASK-081→086; trạng thái TASK-049/050/051 (staging đã tồn tại và từng PASS) |
| `docs/reports/TASK-049-staging-infrastructure-setup.md` | §4.4 lệnh migration staging, §4.6 quy tắc worker |
| `docs/tasks/TASK-086-...md` + `docs/reports/TASK-086-...md` | architecture đã khóa (D1–D8, O1–O4, M2) |
| `prisma/migrations/20260829000000_task086_one_live_graph_subscription/migration.sql` | **migration thật** |
| `prisma/migrations/20260604000000_task068a_one_active_telegram_mapping/migration.sql` | precedent raw-SQL partial unique index |
| `prisma/schema.prisma` | model `GraphSubscription`, enum `GraphSubscriptionStatus`, ghi chú drift |
| `package.json` | script thật (không có script wrapper cho migrate deploy) |
| `services/microsoft/graph-subscription.service.ts` | hằng tên index + phân loại P2002 + cleanup path |
| `.github/workflows/ci.yml` | pattern secret scan (để viết docs an toàn) |

---

## 3. Sự thật về migration TASK-086 (exact scope)

### 3.1. Định danh

```text
Thư mục:   prisma/migrations/20260829000000_task086_one_live_graph_subscription
File:      migration.sql
Tên index: GraphSubscription_mailboxId_live_unique
Table:     "GraphSubscription"
Column:    "mailboxId"
```

### 3.2. Câu lệnh DDL duy nhất

```sql
CREATE UNIQUE INDEX IF NOT EXISTS "GraphSubscription_mailboxId_live_unique"
  ON "GraphSubscription" ("mailboxId")
  WHERE "status" IN ('ACTIVE', 'RENEWING', 'FAILED');
```

### 3.3. Xác minh nội dung (đọc file thật, không suy đoán)

| Câu hỏi | Kết quả |
|---|---|
| Có `UPDATE` không? | **Không** |
| Có `DELETE` không? | **Không** |
| Có backfill / dedupe / chọn winner không? | **Không** |
| Có `DROP` không? | **Không** |
| Có `ALTER TABLE` không? | **Không** |
| Có chạm bảng `Mailbox` không? | **Không** |
| Idempotent? | **Có** — `IF NOT EXISTS` |
| Có `CONCURRENTLY` không? | **Không** — build index khoá ghi trong lúc tạo; bảng staging nhỏ nên chấp nhận được |
| Có secret / connection string trong file? | **Không** |
| Preflight query nằm ở đâu? | Trong **comment** của chính `migration.sql` |
| Post-deploy verify query nằm ở đâu? | Trong **comment** của chính `migration.sql` |

### 3.4. Invariant được enforce

```text
AT MOST ONE LIVE GraphSubscription PER MAILBOX
live statuses = ACTIVE | RENEWING | FAILED
key = mailboxId       (resource KHÔNG thuộc correctness key)
```

`EXPIRED` **không** bị ràng buộc → mailbox giữ nguyên lịch sử subscription, TASK-052 (disconnect
không hard-delete) không bị ảnh hưởng.

Enum trong `prisma/schema.prisma`:

```prisma
enum GraphSubscriptionStatus { ACTIVE  EXPIRED  FAILED  RENEWING }
```

→ predicate của index phủ đúng 3/4 giá trị, khớp định nghĩa "live".

### 3.5. Index cố ý KHÔNG có trong `schema.prisma`

Prisma 5.22.0 không biểu diễn được partial (filtered) unique index. Index sống trong raw SQL
migration, có ghi chú drift ở model `GraphSubscription` (`prisma/schema.prisma`, dòng 254–263),
precedent y hệt TASK-068A. **Không được "sửa drift" bằng cách drop index.**

### 3.6. Behavior khi tồn tại historical duplicates (M2 — FAIL CLOSED)

Migration **không** tự dedupe. Nếu một mailbox đang có ≥ 2 row ở live status:

* `CREATE UNIQUE INDEX` **fail** với lỗi PostgreSQL dạng
  `could not create unique index "GraphSubscription_mailboxId_live_unique"` +
  `Key ("mailboxId")=(...) is duplicated`;
* Prisma chạy mỗi migration file trong một transaction → **DDL bị rollback**, dữ liệu **không** đổi;
* nhưng migration bị ghi nhận **failed** trong bảng `_prisma_migrations`, nên **mọi lần
  `prisma migrate deploy` sau đó bị chặn bằng lỗi P3009** cho tới khi được resolve (xem §11.2).
  Đây là fail-closed **có chủ đích**.

### 3.7. Tương thích code cũ (nếu index apply trước khi code TASK-086 được deploy)

Đã đọc `services/microsoft/graph-subscription.service.ts`: compensating remote DELETE **chỉ** nhắm
`subscriptionId` của chính operation đó, **không bao giờ** cleanup theo `mailboxId`. Do đó nếu index
tồn tại trước khi code TASK-086 chạy, code cũ (TASK-081/085) gặp P2002 sẽ đi nhánh generic DB
failure → xoá đúng remote subscription của chính nó → fail-open.

⇒ **Thứ tự deploy không phải blocker correctness**, nhưng §8.2 vẫn khuyến nghị code-trước-migration
để outcome/log đúng ngữ nghĩa (`ownership_conflict` thay vì `database`).

---

## 4. Scope TASK-087 — LOCKED

**Trong scope**

1. Preflight read-only trên **staging** trước migration.
2. Quy trình controlled rollout cho migration **đã commit** (không tạo migration mới).
3. Hậu kiểm sau deploy (migration applied + index tồn tại + predicate đúng + 0 violation).
4. Smoke test staging tối thiểu.
5. Ghi nhận kết quả sau khi Human thực thi Phase 2.

**Ngoài scope — nếu cần thì STOP và báo Human/ChatGPT**

production rollout; sửa dữ liệu production; orphan remote subscription cleanup; multi-resource
redesign; `resource` canonicalization; runtime feature mới; Redis change; UI feature mới;
`.env*` change; GitHub Actions change; tạo migration mới; tự gán số task mới.

---

## 5. Preflight checklist — READ ONLY

> Toàn bộ mục 5 **không sửa dữ liệu**. Không câu lệnh nào là `INSERT` / `UPDATE` / `DELETE` / DDL.
> Chạy trên **staging database**, theo cách thực thi an toàn ở §6.

### A. Xác minh đúng target là STAGING, không phải production

Không cần và **không được** paste connection string vào chat. Xác minh bằng danh tính
service/environment (không phải secret):

```text
[ ] A1. Railway dashboard: đang đứng trong đúng PROJECT staging (tên project + environment hiển
        thị ở header), tách hoàn toàn project production.
[ ] A2. Postgres service được thao tác là Postgres của CHÍNH project staging đó (không phải
        database ngoài, không phải production).
[ ] A3. Trong Variables của web service staging: APP_ENV có giá trị staging.
        (APP_ENV không phải secret — chỉ cần nhìn, không copy giá trị nào khác.)
[ ] A4. Biến DATABASE_URL của web/worker staging là variable reference trỏ tới Postgres service
        trong cùng project staging. CHỈ kiểm tra dạng tham chiếu, KHÔNG mở/copy giá trị.
[ ] A5. Nếu dùng Railway CLI: `railway status` in ra project + environment + service đang link.
        Xác nhận đúng staging TRƯỚC mọi lệnh khác. Lệnh này không in secret.
```

Câu SQL định danh không nhạy cảm (tuỳ chọn, chạy trong query console của Postgres staging):

```sql
SELECT current_database() AS db, current_user AS role;
```

> **STOP** nếu bất kỳ mục A1–A5 nào không xác nhận được. Không đoán.

### B. Trạng thái Prisma migration trước khi deploy

```text
[ ] B1. Chạy read-only:  npx prisma migrate status
[ ] B2. Kỳ vọng: 20260829000000_task086_one_live_graph_subscription ở trạng thái "not yet applied"
        (pending), và KHÔNG có migration nào ở trạng thái failed.
[ ] B3. Nếu đã applied -> migration đã chạy trước đó: BỎ QUA bước deploy, đi thẳng §9 hậu kiểm.
[ ] B4. Nếu có migration failed (P3009) -> STOP, báo Human/ChatGPT (xem §11.2).
```

Query tương đương (read-only, nếu chỉ có query console):

```sql
SELECT migration_name, finished_at, rolled_back_at, applied_steps_count
FROM "_prisma_migrations"
ORDER BY started_at DESC
LIMIT 10;
```

Một dòng có `finished_at IS NULL AND rolled_back_at IS NULL` = migration đang failed hoặc dở dang.

### C. Historical live duplicates (query quyết định STOP)

**C1 — bắt buộc, chỉ trả về CON SỐ (không lộ dữ liệu):**

```sql
SELECT COUNT(*) AS violating_mailboxes
FROM (
  SELECT "mailboxId"
  FROM "GraphSubscription"
  WHERE "status" IN ('ACTIVE', 'RENEWING', 'FAILED')
  GROUP BY "mailboxId"
  HAVING COUNT(*) > 1
) AS v;
```

```text
violating_mailboxes = 0  -> an toàn để deploy.
violating_mailboxes > 0  -> STOP TUYỆT ĐỐI (xem §7).
```

**C2 — chỉ chạy KHI C1 > 0**, và chỉ để Human/ChatGPT quyết định remediation.
Cố ý **không** select `emailAddress`, **không** `clientStateHash`, **không** `subscriptionId`,
**không** nội dung email, **không** credential:

```sql
SELECT "mailboxId",
       COUNT(*) AS live_rows,
       MIN("expirationDateTime") AS earliest_expiry,
       MAX("expirationDateTime") AS latest_expiry
FROM "GraphSubscription"
WHERE "status" IN ('ACTIVE', 'RENEWING', 'FAILED')
GROUP BY "mailboxId"
HAVING COUNT(*) > 1
ORDER BY live_rows DESC;
```

`mailboxId` là cuid nội bộ, không phải PII, và là identifier tối thiểu cần cho remediation.

> Lưu ý race: staging có worker đang chạy, nên C1 phải được chạy **ngay trước** bước deploy.
> Nếu duplicate xuất hiện trong khoảng giữa preflight và deploy, migration vẫn **fail-closed**
> (dữ liệu không hỏng) — chỉ cần xử lý theo §11.2.

### D. Trạng thái index hiện tại

```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'GraphSubscription';
```

```text
[ ] D1. Nếu KHÔNG thấy GraphSubscription_mailboxId_live_unique -> đúng kỳ vọng (chưa migrate).
[ ] D2. Nếu ĐÃ thấy -> index được tạo tay từ trước. migrate deploy vẫn an toàn (IF NOT EXISTS),
        nhưng phải kiểm tra predicate theo §9.3.
        Nếu predicate lệch -> STOP, báo Human/ChatGPT. KHÔNG tự DROP index.
```

### E. Xác minh nguồn code của staging chứa migration TASK-086

```text
[ ] E1. Xác nhận service staging (web) đang/sẽ deploy từ commit CÓ thư mục
        prisma/migrations/20260829000000_task086_one_live_graph_subscription.
        Trong repo, commit đó hiện chỉ nằm trên nhánh làm việc của TASK-086 và nhánh hiện tại;
        nhánh mặc định của remote KHÔNG chứa nó.
[ ] E2. Kiểm tra web service staging có sẵn Pre-Deploy Command / release command chạy
        `prisma migrate deploy` tự động hay không.
        - Nếu CÓ: một lần redeploy sẽ TỰ apply migration và bỏ qua cổng preflight
          -> phải chạy preflight §5.C TRƯỚC khi bấm deploy, hoặc tạm gỡ pre-deploy command
             (quyết định vận hành của Human, không phải thay đổi trong repo).
        - Nếu KHÔNG: migration chỉ chạy khi Human chủ động gọi lệnh (§8).
```

Repo **không** chứa `railway.json` / `Procfile` / `nixpacks.toml`, và `package.json` **không** có
script nào tự chạy migration (`postinstall` chỉ `prisma generate`; `build` là `next build`;
`start` là `next start`). ⇒ Mọi hành vi tự-migrate nếu có đều đến từ cấu hình dashboard và phải
kiểm tra thủ công theo E2.

---

## 6. Cách thực thi an toàn (không lộ secret)

Ưu tiên theo thứ tự:

1. **Railway dashboard → Postgres service staging → query/data console** cho toàn bộ SQL read-only
   ở §5.C, §5.D, §9. Không cần copy connection string đi đâu.
2. **Railway one-off / pre-deploy command trên chính service staging** cho
   `npx prisma migrate deploy` và `npx prisma migrate status` — biến môi trường do Railway inject,
   không đi qua terminal của Human.
3. **Railway CLI** (`railway status`, rồi `railway run --service <web-staging> npx prisma migrate status`):
   biến được inject vào tiến trình, **không in ra màn hình**. Chỉ dùng khi (1)/(2) không khả dụng.

**Cấm:**

* copy/paste database URL, Redis URL, token, refresh token, client secret, bot token,
  encryption/session secret vào PowerShell history, chat AI, hay tài liệu;
* chạy worker local trỏ vào DB/Redis staging (vi phạm quy tắc vận hành ở TASK-049 §4.6);
* dùng `npx prisma migrate dev` trên staging (tạo migration mới, có thể reset DB);
* dùng `prisma db push` (bỏ qua migration history).

---

## 7. STOP CONDITION — có duplicate

Nếu §5.C1 trả về `violating_mailboxes > 0`:

```text
STOP — DO NOT RUN prisma migrate deploy
```

TASK-087 **không được**:

* chọn winner;
* mark loser `EXPIRED`;
* `DELETE` row;
* cleanup remote Graph subscription;
* chạy reconciliation với `--apply` để "dọn";
* sửa migration cho bớt chặt.

Việc phải làm: chạy §5.C2, báo **con số + danh sách `mailboxId`** cho Human/ChatGPT, rồi dừng.
Human/ChatGPT quyết định có mở remediation task riêng hay không. **Không tự gán số task.**

Lý do (theo O4 của TASK-086): một local loser row có thể tương ứng subscription **vẫn sống trên
Microsoft**; xoá local trước sẽ tạo orphan remote không ai quản lý.

---

## 8. Staging execution plan (Phase 2 — Human thực thi; Phase 1 CHƯA chạy)

### 8.1. Lệnh chuẩn (đã xác minh khớp repo + docs)

```powershell
npx prisma migrate deploy
npx prisma migrate status
```

Nguồn xác minh: `docs/STAGING_DEPLOYMENT.md` §5.7 và `docs/reports/TASK-049-...` §4.4 đều chốt đúng
2 lệnh này. `package.json` **không** có script wrapper; script `db:migrate` là `prisma migrate dev`
— **chỉ dùng cho local dev, tuyệt đối không dùng cho staging**.

### 8.2. Thứ tự khuyến nghị

```text
1. §5.A  xác minh đúng staging.
2. §5.E  xác minh nguồn code staging có migration TASK-086 + kiểm tra pre-deploy command.
3. §5.B  npx prisma migrate status   (pending, không failed).
4. §5.D  kiểm tra index chưa tồn tại.
5. §5.C1 duplicate count = 0   ->   nếu > 0: STOP theo §7.
6. Deploy code TASK-086 lên staging (khuyến nghị code trước migration — xem §3.7).
7. npx prisma migrate deploy    (đúng một lần, không retry mù).
8. §9  hậu kiểm đầy đủ.
9. §10 smoke test.
```

Bước 6 là **quyết định của Human** (chọn nhánh/commit nào cho staging) — xem §14 Open decisions.

### 8.3. Worker trong lúc migrate

Không bắt buộc dừng worker: DDL chạy trong transaction, fail thì rollback, và code cũ vẫn fail-open
(§3.7). Nếu Human muốn một cửa sổ tuyệt đối yên tĩnh thì có thể tạm dừng `worker-renewal` /
`worker-delta` / `worker-email` trên dashboard rồi bật lại — **tuỳ chọn vận hành, không phải thay
đổi repo**, và phải bật lại ngay sau hậu kiểm.

---

## 9. Post-migration verification (read-only)

### 9.1. Migration status sạch

```powershell
npx prisma migrate status
```

Kỳ vọng: báo schema đã up to date; **không** có migration failed hay pending.

### 9.2. Migration TASK-086 được đánh dấu applied

```sql
SELECT migration_name, finished_at, rolled_back_at, applied_steps_count
FROM "_prisma_migrations"
WHERE migration_name = '20260829000000_task086_one_live_graph_subscription';
```

Kỳ vọng: đúng 1 dòng, `finished_at` **không null**, `rolled_back_at` null, `applied_steps_count` = 1.

### 9.3. Index tồn tại đúng tên + predicate đúng

```sql
SELECT indexname, indexdef
FROM pg_indexes
WHERE tablename = 'GraphSubscription'
  AND indexname = 'GraphSubscription_mailboxId_live_unique';
```

Kỳ vọng: đúng 1 dòng; `indexdef` có dạng `CREATE UNIQUE INDEX ... ON public."GraphSubscription"
USING btree ("mailboxId") WHERE (status = ANY (ARRAY['ACTIVE'..., 'RENEWING'..., 'FAILED'...]))`.

```text
[ ] unique = có
[ ] cột    = mailboxId (chỉ một cột)
[ ] predicate chứa ĐỦ 3 giá trị ACTIVE / RENEWING / FAILED
[ ] predicate KHÔNG chứa EXPIRED
```

Nếu predicate lệch → **STOP**; không tự `DROP`/`CREATE` lại; báo Human/ChatGPT.

### 9.4. Duplicate query sau deploy = 0

Chạy lại §5.C1. Kỳ vọng `violating_mailboxes = 0` (về logic phải bằng 0 vì index đã tồn tại — đây
là kiểm tra chéo).

### 9.5. App/worker khởi động bình thường

```text
[ ] web service staging deploy thành công, không lỗi Prisma/schema lúc boot.
[ ] worker-email / worker-delta / worker-renewal khởi động được; log không có lỗi migration/schema
    và không có P2002 bất thường lặp lại.
[ ] Không có log lỗi mới liên quan GraphSubscription trong ~15 phút đầu.
```

### 9.6. `/admin/health` không regression

```text
[ ] /admin/health mở được (đăng nhập staging theo cơ chế hiện có).
[ ] Bảng mailbox health hiển thị subscription status / expiry như trước.
[ ] Số liệu subscriptionExpired / subscriptionExpiringSoon không nhảy bất thường so với trước deploy
    (ghi lại giá trị TRƯỚC deploy để so sánh).
[ ] Không thấy secret/token/verification code trên UI.
```

**Không** chạm production ở bất kỳ bước nào.

---

## 10. Staging functional smoke plan (tối thiểu, không mở rộng scope)

### 10.1. An toàn — chạy được ngay

```text
[ ] S1. Web staging load qua HTTPS bình thường.
[ ] S2. /admin và /admin/health mở được.
[ ] S3. 3 worker service ở trạng thái running, log sạch.
[ ] S4. Trang mailbox list hiển thị đúng, không lỗi 500.
[ ] S5. Không thấy secret/token/verification code trong UI hay log.
```

### 10.2. Reconciliation dry-run vẫn non-mutating (kiểm tra gián tiếp invariant)

```powershell
npm run reconcile:subscriptions
```

Chạy **trong môi trường staging** theo §6; mặc định là dry-run. **Không** thêm `--apply`,
**không** thêm cờ recovery.

```text
[ ] Lệnh chạy xong, chỉ in counter đã sanitize (mailboxId nội bộ; không email/token).
[ ] createdCount = 0 và không có DB write (dry-run theo TASK-082 không gọi ensure).
[ ] Không có lỗi P2002 phát sinh từ dry-run.
```

Đây là smoke **read-only**; nếu Human không muốn chạy CLI trên staging thì bỏ qua — không bắt buộc.

### 10.3. Tuỳ chọn — cần Human approve trước khi chạy

```text
[ ] O1. Nếu staging đang có Microsoft TEST mailbox hợp lệ: có thể quan sát log provisioning khi
        reconnect mailbox TEST đó, để xác nhận không thể tạo 2 live row.
        -> CHỈ chạy khi Human đồng ý rõ ràng. Không tự chạy.
[ ] O2. Telegram test-send vào TEST group (nếu muốn xác nhận relay path còn sống).
        -> chỉ TEST group, không dùng group khách hàng thật.
```

**Cấm trong smoke:** gửi verification code thật; dùng mailbox/group khách hàng thật; gọi Microsoft
Graph thật trong Phase 1; chạy `--apply`; ép buộc live E2E.

**Phase 1 không gọi Graph thật và không chạy lệnh nào trên staging.**

---

## 11. Failure handling / rollback

### 11.1. Preflight phát hiện duplicate

```text
-> STOP. Không chạy migrate deploy. Theo §7. Không remediation tự động.
```

### 11.2. `prisma migrate deploy` FAIL

```text
1. Thu log đã sanitize (chỉ message + tên migration + tên index + mailboxId nếu Postgres in ra).
   KHÔNG copy connection string, KHÔNG copy giá trị env.
2. Phân loại:
   a) Lỗi unique/duplicate key trên GraphSubscription_mailboxId_live_unique
      -> đúng M2 fail-closed: staging có duplicate. DDL đã rollback, dữ liệu không đổi.
   b) Lỗi kết nối / auth / timeout tới database
      -> setup/environment failure, KHÔNG phải lỗi migration.
   c) Lỗi P3009 "failed migrations in the target database"
      -> có migration failed từ lần trước, chưa được resolve.
3. KHÔNG retry mù. KHÔNG chạy migrate dev. KHÔNG db push. KHÔNG sửa file migration.
4. KHÔNG tự tạo/DROP index bằng tay. KHÔNG sửa dữ liệu.
5. Báo Human/ChatGPT kèm phân loại (a)/(b)/(c).
```

Ghi chú kỹ thuật cho case (a)/(c): sau một migration failed, Prisma chặn deploy tiếp theo bằng P3009.
Cách gỡ chuẩn là `prisma migrate resolve --rolled-back "<tên migration>"` — chỉ sửa metadata trong
`_prisma_migrations`, **không** chạm dữ liệu ứng dụng. **Phase 1 không đề xuất chạy lệnh này tự
động**; chỉ chạy sau khi Human/ChatGPT xác nhận nguyên nhân và duplicate đã được xử lý.

### 11.3. App/worker lỗi sau khi migrate

```text
1. Xác định chính xác service nào fail (web / worker-email / worker-delta / worker-renewal)
   và bước nào fail (build / boot / runtime).
2. KHÔNG rollback database thủ công khi chưa review.
   Index này là additive; rollback DB gần như không bao giờ là bước đúng đầu tiên.
3. Rollback CODE trước nếu cần: Railway rollback về release trước
   (theo docs/STAGING_DEPLOYMENT.md §5.10). Index vẫn tồn tại và vẫn an toàn với code cũ (§3.7).
4. Thu log sanitized, báo Human/ChatGPT.
```

### 11.4. Secret / environment issue

```text
-> Human thao tác trên Railway dashboard.
-> Không paste secret vào AI, không in ra terminal, không ghi vào docs.
-> Nếu nghi secret bị lộ: rotate theo SECURITY_RULES §10 trước khi tiếp tục.
```

### 11.5. Rollback ngữ nghĩa của chính index

Nếu (và chỉ nếu) Human/ChatGPT quyết định phải gỡ index, đó là một **quyết định riêng cần review**;
TASK-087 không thực hiện và cố ý **không** viết sẵn lệnh `DROP` để tránh bị copy nhầm.

---

## 12. Security

```text
[x] Không đọc, không in, không sửa .env / .env.local / .env.staging / .env.production.
[x] Không yêu cầu Human paste database URL, Redis URL, token, refresh token, client secret,
    bot token, encryption/session secret.
[x] Query preflight/hậu kiểm chỉ đọc metadata + mailboxId nội bộ; không email address,
    không clientStateHash, không subscriptionId ở bước triage đầu.
[x] Không ghi verification code (kể cả đã mask), không ghi full email body.
[x] Không sửa .github/workflows — secret scan giữ nguyên.
[x] Wording tài liệu tránh false positive của CI secret scan: không ghi tên nhánh Git đầy đủ,
    task id luôn viết HOA, không viết tên biến secret kèm dấu bằng.
[x] Không thao tác production database (AGENTS.md luật 6, SECURITY_RULES §7).
```

---

## 13. Orphan remote subscription (ghi nhận, không hành động)

TASK-086 (O4) đã defer việc discovery/cleanup subscription orphan phía Microsoft.
TASK-087 **không** implement remediation.

Chỉ ghi nhận: nếu trong Phase 2 staging xuất hiện log dạng **409 từ Microsoft mà local không có
live winner** (`conflict_unowned` với `source: 'remote_conflict'`), đó là **evidence** để
Human/ChatGPT cân nhắc một follow-up sau TASK-087. **Không tự mở task mới, không tự gán số.**

---

## 14. Open decisions / blockers — trạng thái sau Phase 2

> Câu hỏi gốc của Phase 1 giữ nguyên. Cột kết quả là **Human-observed staging evidence** (§16),
> **không phải** Claude tự truy cập Railway.

| # | Câu hỏi Phase 1 | Kết quả Phase 2 |
|---|---|---|
| **D1** | Staging web/worker hiện deploy từ nguồn nào? Nhánh mặc định của remote KHÔNG chứa commit TASK-086. | **ĐÃ TRẢ LỜI.** Human quan sát Railway `web` staging đang kết nối nhánh làm việc của TASK-086 (nhánh chứa implementation + migration TASK-086); **auto deploy khi push GitHub đang bật**. |
| **D2** | Web service staging có Pre-Deploy Command chạy migrate tự động không? | **ĐÃ TRẢ LỜI — CÓ.** Pre-Deploy Command thực tế: `npx prisma migrate deploy`. Hệ quả: cổng preflight fail-closed ở §8.2 **đã bị bỏ qua** trong lần rollout này (§16.4). |
| **D3** | Kênh chạy SQL read-only trên staging? | **ĐÃ GIẢI QUYẾT.** Human chạy được 3 read-only query trực tiếp trên PostgreSQL staging (§16.5–§16.7). |
| **D4** | Có tạm dừng 3 worker trong cửa sổ migrate không? | **KHÔNG CÒN ÁP DỤNG** cho lần rollout này — migration chạy trong pipeline deploy nên không có cửa sổ thủ công để pause. Khuyến nghị Phase 1 (không cần pause) vẫn giữ cho migration tương lai. |
| **D5** | Staging có Microsoft TEST mailbox hợp lệ cho smoke tuỳ chọn O1 không? | **VẪN MỞ.** Smoke tuỳ chọn O1 chưa chạy. Liên quan: dashboard báo chưa ghi nhận Graph subscription (§16.8, §16.9). |

---

## 15. Tiêu chí nghiệm thu

**Phase 1 (tài liệu này)**

```text
[x] Precheck sạch, đúng nhánh, HEAD chứa TASK-086.
[x] Đọc migration thật + schema thật + code thật, không chỉ dựa vào report TASK-086.
[x] Có preflight read-only đầy đủ (A–E) và STOP rule rõ ràng.
[x] Có execution plan bằng lệnh có thật trong repo/docs.
[x] Có hậu kiểm 6 mục và smoke plan tối thiểu.
[x] Có failure/rollback strategy phân loại rõ.
[x] Chỉ tạo 2 file docs; không runtime, không migration mới, không ROADMAP, không commit/push.
[x] npm run verify PASS.
```

**Phase 2 — kết quả thực tế (Human-observed staging evidence, chi tiết ở §16)**

```text
[!] Prospective preflight duplicate TRƯỚC migration: KHÔNG THỰC THI.
    Railway Pre-Deploy Command đã tự apply migration TASK-086 trước khi Phase 2 bắt đầu.
    Đây là process deviation, ghi rõ ở §16.4 — KHÔNG được đọc là "preflight đã pass".
[x] migrate deploy chạy thành công (do Pre-Deploy Command của Railway, không phải lệnh thủ công).
[x] Migration TASK-086 applied: finished_at có giá trị, applied_steps_count = 1, không rolled back.
[x] Index tồn tại đúng tên + unique + btree trên mailboxId + predicate đúng 3 status.
[x] Duplicate SAU deploy = 0 (post-deployment verification, không phải preflight).
[x] Web + 3 worker Active/Running.
[x] /admin/health: 4 core operational check PASS, không có regression quy được cho deployment.
[~] Smoke S1–S5: phần liên quan (web/health/worker/queue) đã có evidence; smoke tuỳ chọn O1/O2
    và reconciliation dry-run CHƯA chạy.
[x] Kết quả được ghi vào docs/reports/TASK-087-staging-migration-preflight-rollout-validation.md.
```

---

## 16. PHASE 2 — Staging execution evidence (Human-observed)

> **Nguồn bằng chứng:** Human thao tác và quan sát trực tiếp trên Railway staging dashboard, deploy
> log, và chạy read-only query trên PostgreSQL staging.
> **Claude KHÔNG truy cập Railway, KHÔNG chạy migration, KHÔNG chạy query trên staging.**
> Mục này chỉ ghi lại và phân loại evidence do Human cung cấp.
>
> Production **hoàn toàn ngoài scope**: không bước nào ở đây chạm production, và tài liệu này
> **không** đưa hướng dẫn migration cho production.

### 16.1. Chronology thực tế

```text
1. TASK-086 được push lên GitHub.
2. Railway staging AUTO DEPLOY (auto deploy khi push đang bật).
3. Pre-Deploy Command của service web chạy: npx prisma migrate deploy
4. Migration 20260829000000_task086_one_live_graph_subscription được xử lý;
   deploy log kết thúc bằng "All migrations have been successfully applied."
5. Web container start thành công và đạt trạng thái Ready.
6. TASK-087 Phase 1 (investigation) phát hiện hành vi automatic migration này.
7. Human thực hiện POST-DEPLOYMENT read-only verification (§16.5–§16.8).
```

**Không có bước nào trong chronology trên là "preflight chạy trước migration".**

### 16.2. D1 — Deploy source (Human-observed)

Railway service `web` staging đang kết nối nhánh làm việc của TASK-086 — nhánh chứa cả
implementation lẫn thư mục migration TASK-086. Auto deploy khi push GitHub **đang bật**.

⇒ Câu hỏi của Phase 1 §5.E1 (deploy source có chứa migration không) được trả lời: **có**.

### 16.3. D2 — Automatic Pre-Deploy migration (finding vận hành quan trọng)

Railway service `web` staging có **Pre-Deploy Command thực tế**:

```text
npx prisma migrate deploy
```

Deployment của TASK-086 đã **tự động** chạy command này. Deploy log Human quan sát cho thấy
migration `20260829000000_task086_one_live_graph_subscription` được xử lý và log kết thúc bằng
`All migrations have been successfully applied.`; sau đó web container start thành công và Ready.

**Không có evidence** về migration failure hay P3009.

⇒ Rủi ro mà §5.E2 của Phase 1 nêu ra là **có thật và đã hiện thực hoá**: một push vào nhánh mà
staging đang theo dõi có thể apply migration mà **không** đi qua cổng preflight thủ công nào.

### 16.4. Process deviation (ghi trung thực, không làm đẹp report)

Phase 1 thiết kế rollout theo thứ tự:

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

Phân loại chính xác:

* Đây là **operational process observation** — quy trình rollout không chạy như thiết kế.
* Đây **KHÔNG** phải database correctness failure ở thời điểm hiện tại: migration đã applied,
  index đúng, duplicate hiện tại = 0 (§16.5–§16.7).
* Cơ chế fail-closed M2 của migration vẫn còn nguyên giá trị — chỉ là nó đã "tự quyết định" bên
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

### 16.5. Query 1 — Prisma migration state (read-only, Human chạy)

```text
- migration TASK-086 tồn tại trong bảng lịch sử migration;
- finished_at CÓ giá trị;
- applied_steps_count = 1;
- không ở trạng thái rolled back / failed.
```

```text
Verdict: PASS
```

### 16.6. Query 2 — Partial unique index thật (read-only, Human chạy)

Human query `pg_indexes`. Kết quả trả về **đúng một row**:

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
`IN (...)` trong file migration. **Hai biểu thức tương đương** (PostgreSQL chuẩn hoá
`IN (danh sách hằng)` thành `= ANY (ARRAY[...])` khi lưu predicate của index). Đây **không** phải
lệch predicate và **không** kích hoạt STOP condition ở §9.3.

```text
Verdict: PASS
```

### 16.7. Query 3 — Duplicate violations hiện tại (read-only, Human chạy)

Human chạy đúng duplicate query theo live predicate (`ACTIVE` / `RENEWING` / `FAILED`):

```text
violating_mailboxes = 0
```

```text
Verdict: PASS
```

Không ghi mailbox identifier cụ thể (không cần cho remediation vì kết quả = 0).

**Ngữ nghĩa chính xác:** đây là **post-deployment verification** — xác nhận trạng thái hiện tại của
staging không vi phạm invariant. Nó **không phải** preflight và **không** chứng minh rằng preflight
đã từng được chạy.

### 16.8. Service / health smoke evidence (Human-observed)

Bốn Railway service đều `Active / Running`:

```text
[x] web
[x] worker-email
[x] worker-delta
[x] worker-renewal
```

`/admin/health` trên staging — core operational checks quan sát được:

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

⇒ Tương ứng smoke S1–S3 và phần lớn S4/S5 của §10.1. Reconciliation dry-run (§10.2) và smoke tuỳ
chọn O1/O2 (§10.3) **chưa chạy**.

### 16.9. Observation KHÔNG quy cho TASK-086 / TASK-087

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

### 16.10. Caveat về độ mạnh của bằng chứng

`violating_mailboxes = 0` là kết quả **thật** và đạt yêu cầu. Nhưng cần đọc đúng mức:

* Dashboard báo **chưa ghi nhận Graph subscription nào** (§16.9). Nếu staging hiện không có row nào
  ở live status thì `= 0` là kết quả **đúng nhưng ít áp lực dữ liệu**: index đã tồn tại và đúng
  hình dạng, nhưng **chưa được chứng minh dưới tải provisioning đồng thời thật**.
* Bằng chứng mạnh và độc lập với dữ liệu là **§16.6**: index tồn tại, unique, đúng cột, đúng
  predicate. Ràng buộc ở tầng DB đã ở đúng chỗ kể từ thời điểm này.
* Quan sát hành vi ownership-conflict thật (P2002 → `ownership_conflict`) cần một Microsoft TEST
  mailbox hoạt động — vẫn là **D5 đang mở**, và là smoke tuỳ chọn cần Human approve (§10.3).

### 16.11. Verdict Phase 2

```text
STAGING DATABASE ROLLOUT / POST-DEPLOY VALIDATION: PASS
  - migration applied successfully
  - partial unique index exists correctly (đúng tên, đúng cột, đúng predicate)
  - current duplicate violations = 0
  - web + 3 worker running
  - core health checks không cho thấy deployment regression rõ ràng

PROCESS: DEVIATION ĐƯỢC GHI NHẬN
  - prospective preflight KHÔNG được thực thi trước migration này
  - nguyên nhân: Railway automatic Pre-Deploy migration đã apply TASK-086
    trước khi TASK-087 Phase 2 bắt đầu
  - đây là operational process observation, không phải database correctness failure

PRODUCTION: OUT OF SCOPE — không rollout, không hướng dẫn, không đụng tới.
```

TASK-087 do đó đã **validate được một rollout thực tế thành công**, đồng thời **phát hiện một yêu
cầu vận hành cho các migration tương lai** (§16.4).
