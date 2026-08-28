# TASK-086 — Graph Subscription Provisioning Concurrency Guard

> **PHASE 2 — IMPLEMENTATION ĐÃ THỰC HIỆN** (sau khi Antigravity kết luận
> *PASS — TASK-086 FINAL ARCHITECTURE APPROVED FOR PHASE 2 IMPLEMENTATION*).
> Chi tiết implementation ở mục 22. Antigravity **Implementation Review chưa diễn ra**.
> Không `.env*`, không GitHub Actions, không UI, không ROADMAP, không commit/push.
>
> Các mục 1–21 dưới đây là architecture đã khóa ở Phase 1 và được giữ nguyên làm source of truth.
>
> Sanitized: không token/refresh token/client secret/Telegram bot token/credential ciphertext thật/
> encryption-session secret/verification code/full email body/DB-Redis URL. Credential generation chỉ
> mô tả bằng ký hiệu opaque (G0/G1).

---

## 0. Chronology

```text
1. Initial Claude investigation (Phase 1, vòng 1)
2. Antigravity Architecture Review TASK-086 → BLOCKED
3. Human/ChatGPT decisions D1–D8 (locked)
4. Corrected architecture (vòng 2)
5. Human/ChatGPT decisions O1–O4 (locked) — key = mailboxId, M2 fail-closed,
   fresh-RENEWING temporary block, orphan remediation out of scope
6. Final corrected architecture
7. Antigravity Final Architecture Re-review → PASS (approved for Phase 2)
8. Phase 2 implementation (mục 22 — tài liệu này)
9. → AWAITING ANTIGRAVITY IMPLEMENTATION REVIEW
```

**Implementation review CHƯA diễn ra.** Architecture đã được duyệt; code chưa được review, chưa commit,
chưa push.

Minh bạch: artifact review của Antigravity **không tồn tại dưới dạng file trong repo**; findings được
Human/ChatGPT chuyển tiếp và đã được cô đọng thành D1–D8 + O1–O4. Tài liệu này bám đúng các quyết định
đó và trace lại code tại HEAD, không dựa vào report cũ.

---

## 1. FINAL VERDICTS

```text
Primary local correctness invariant:
AT MOST ONE LIVE GraphSubscription PER MAILBOX

Unique key:
mailboxId

resource:
NOT PART OF TASK-086 CORRECTNESS KEY

Microsoft 409:
DOCUMENTED BUT NOT LOCAL CORRECTNESS GUARANTEE

Expired-state model:
NORMALIZE FIRST, THEN ANY REMAINING LIVE STATUS BLOCKS PROVISIONING

Fresh RENEWING:
TEMPORARILY BLOCK UNTIL CLAIM SETTLES OR BECOMES STALE

Historical duplicate strategy:
M2 FAIL-CLOSED

Redis:
NOT REQUIRED

Long transaction/advisory lock:
NOT REQUIRED

Placeholder:
REJECTED

Orphan remote remediation:
DEFERRED / OUT OF SCOPE
```

Bổ sung (từ D1–D8, vẫn hiệu lực): Stage-1-only implementation **REJECTED**;
schema/migration **APPROVED IN PRINCIPLE** ở Phase 1 → **IMPLEMENTED ở Phase 2** (raw SQL partial
unique index, M2 fail-closed — mục 22).

> Lưu ý đọc tài liệu: các trích dẫn `file:line` trong mục 4–21 phản ánh trạng thái code **trước**
> implementation (Phase 1). Trạng thái sau implementation nằm ở mục 22.

---

## 2. Locked decisions

| # | Nội dung |
|---|---|
| **D1** | Microsoft 409 documented nhưng **không** đủ làm local correctness guarantee. Model/test phải đúng cả khi `A → 201` và `B → 201` |
| **D2** | Không implement Stage-1 riêng; 409 classification là một phần của một implementation duy nhất |
| **D3** | Local DB uniqueness là correctness guard chính; nhóm live = ACTIVE/RENEWING/FAILED; EXPIRED không tham gia uniqueness; migration approve về nguyên tắc, Phase 1 không viết |
| **D4** | Index chỉ encode được status ⇒ phải normalize time-expired rows trước provisioning, concurrency-safe |
| **D5** | Placeholder/claim row **REJECTED** |
| **D6** | Redis **NOT REQUIRED**, không wire mới |
| **D7** | Transaction/advisory lock xuyên HTTP POST **cấm** |
| **D8** | Orphan remote remediation **out of scope** |
| **O1** | **Unique key = `mailboxId`.** Không dùng `(mailboxId, resource)`. `resource` canonicalization chỉ là observation/deferred, **không** là correctness dependency. Multi-resource là scope tương lai riêng |
| **O2** | Historical duplicate strategy = **M2 fail-closed**. Không auto-dedup, không tự chọn winner, không silently mutate lifecycle trong migration |
| **O3** | Fresh RENEWING quá hạn theo thời gian ⇒ **temporarily block** provisioning tới khi claim settle hoặc trở thành stale (≤30 phút). Đây là fail-safe có chủ đích |
| **O4** | Remote orphan discovery/remediation **deferred / out of scope** |

---

## 3. Precheck

| Mục | Thực tế |
|---|---|
| Branch | đúng branch làm việc của TASK-086 |
| HEAD | `b67ab86 fix: guard concurrent credential rotation` (TASK-085 hoàn tất) |
| `git diff --stat` | rỗng |
| Untracked duplicate TASK-085 | đã re-verify byte-identical ở vòng trước và **đã xóa**; report TASK-085 chính nguyên vẹn |

---

## 4. (O1) Xác minh invariant "một live subscription cho mỗi mailbox"

Trace lại toàn bộ consumer của `GraphSubscription` tại HEAD (grep `graphSubscription|graphSubscriptions`
trên `services/`, `app/`, `lib/`, `components/`, `scripts/`):

| Consumer | Cách đọc | Có cần NHIỀU live row/mailbox không? |
|---|---|---|
| `mailbox-subscription-provisioning.service.ts:133` (ensure) | `findFirst` + `orderBy expirationDateTime desc` | **Không** — chỉ cần biết "có hay không" |
| `subscription-reconciliation-runner.ts:71,110` | `none: { status live, expiration > now }` / `findFirst` | **Không** |
| `subscription-renewal-runner.ts:107` (candidate) | `findMany` theo row | Chạy được với nhiều row nhưng **không yêu cầu** |
| `subscription-renewal-runner.ts:266` (`markMailboxSubscriptionExpiredIfNoOtherLiveSubscription`) | `none: { id ≠ failing row, status live, expiration > now }` | **Không** — chỉ *dung thứ* khả năng có row thay thế |
| `webhook-notification.service.ts:187` | `findUnique` theo `subscriptionId` | **Không** |
| `mailbox-disconnect.service.ts:241,269` | `findMany` + `updateMany` trên row live | **Không** — xử lý được nhiều nhưng không cần |
| `health.service.ts:538` | `take: 1`, `orderBy expirationDateTime desc` | **Không** — UI health **đã giả định một subscription đại diện** |
| `mailbox-list.service.ts:80` | `take: 1` | **Không** — cùng giả định |
| `mailbox-detail.service.ts:140` | liệt kê **tất cả** row (gồm EXPIRED) làm lịch sử | **Không** — index là partial nên lịch sử EXPIRED không bị ràng buộc |
| `app/admin/mailboxes/[id]/page.tsx:169` | `graphSubscriptions[0]` = row mới nhất | **Không** |

Ngoài ra: chỉ tồn tại **một** `resource` (`INBOX_RESOURCE`) và **một** `changeType` (`created`) trong
toàn bộ code; không có API/UI/CLI nào cho phép tạo subscription trên resource khác.

**KẾT LUẬN: KHÔNG có production requirement nào cần nhiều live GraphSubscription cho cùng một mailbox.**
Ngược lại, health dashboard và mailbox list **đã** hiển thị theo giả định "một subscription đại diện".
⇒ **Khóa `mailboxId` làm unique key. Không STOP.**

### 4.1 `resource` — observation, deferred (không phải correctness dependency)

Ghi nhận để lại cho tương lai, **không** xử lý trong TASK-086: code gửi hằng
`INBOX_RESOURCE = "/me/mailFolders('Inbox')/messages"` (`graph-subscription.service.ts:12,258`) nhưng
**persist giá trị Microsoft echo về** (`:490`, `readString(responsePayload.resource) ?? INBOX_RESOURCE`),
trong khi tài liệu Microsoft echo dạng không có dấu gạch chéo đầu. Test hiện tại chỉ dùng fake echo lại
chuỗi của ta nên repo không chứng minh được hai chuỗi trùng nhau.

Vì key là `mailboxId`, **sự khác biệt representation này không ảnh hưởng correctness của TASK-086** — nó
chỉ là dữ liệu hiển thị/chẩn đoán. Nếu sau này có multi-resource subscription, canonicalization sẽ là
**điều kiện tiên quyết của scope đó**, không phải của task này.

---

## 5. Kiến trúc chốt

```text
UNIQUE(mailboxId) WHERE status IN ('ACTIVE', 'RENEWING', 'FAILED')
```

Partial unique index (raw SQL, Phase 2 — **Phase 1 không viết migration**). Serialization point duy nhất
= **local DB unique index**: không Redis (D6), không long transaction/advisory lock (D7), không
placeholder row (D5), không phụ thuộc Microsoft 409 (D1).

**Chứng minh index chỉ có thể bị vi phạm tại INSERT** (code-level, HEAD):

- Mọi write đưa row vào nhóm live đều là **live → live trên cùng một row**: claim ACTIVE/FAILED →
  RENEWING và stale RENEWING → RENEWING (`subscription-renewal-runner.ts:158-181`), RENEWING → ACTIVE
  (`:207-227`). Không thêm key mới.
- **Không tồn tại path EXPIRED → live** (grep toàn `services/`; candidate query của renewal loại EXPIRED).
- Disconnect (`mailbox-disconnect.service.ts:262-270`) và `deleteGraphSubscription`
  (`graph-subscription.service.ts:641-644`) đều đưa row về EXPIRED ⇒ **giải phóng đúng live slot**.
- Nhiều row EXPIRED cùng mailbox luôn hợp lệ (index là partial) ⇒ lịch sử được giữ.

---

## 6. (D4 + mục 2 yêu cầu) Expired-row normalization — corrected

Tách bạch hai khái niệm:

- **time expiration** = `expirationDateTime` đã qua ⇒ subscription không còn giá trị vận hành;
- **local live-slot ownership** = row đang ở status ACTIVE/RENEWING/FAILED ⇒ đang **chiếm slot** của
  unique index.

Index chỉ hiểu khái niệm thứ hai, nên trước khi provisioning phải **quy đổi** khái niệm thứ nhất về
thứ hai.

### 6.1 Thứ tự bắt buộc

```text
capturedNow = now()
→ normalize các live row đủ điều kiện sang EXPIRED
→ nếu có fresh RENEWING claim  → TEMPORARILY BLOCK (dừng tại đây)
→ sau normalize: re-read live rows của mailbox
→ nếu còn BẤT KỲ row ACTIVE/RENEWING/FAILED nào → BLOCK
→ chỉ khi không còn live row nào → remote POST → local INSERT
```

### 6.2 ACTIVE / FAILED expired-by-time

```text
updateMany
where: id = rowId
       AND status = <đúng status đã đọc: 'ACTIVE' hoặc 'FAILED'>
       AND expirationDateTime <= capturedNow
data:  status = 'EXPIRED'
```

- Renewal claim đồng thời thắng trước (row → RENEWING) ⇒ predicate `status` không khớp ⇒
  **transition thua** (đúng yêu cầu).
- Transition thắng trước ⇒ claim của TASK-084 (`status IN ('ACTIVE','FAILED')`) không khớp ⇒
  **claim thua**, không side effect.

### 6.3 RENEWING expired-by-time

**Fresh claim** (`updatedAt >= staleCutoff`): **TEMPORARILY BLOCK** — không normalize, **không Graph
POST**, **không local insert**, **không retry loop tức thời**. Tick/operator invocation sau tự
re-evaluate (O3).

**Stale claim** (`updatedAt < staleCutoff`):

```text
updateMany
where: id = rowId
       AND status = 'RENEWING'
       AND expirationDateTime <= capturedNow
       AND updatedAt < staleCutoff
data:  status = 'EXPIRED'
```

- Nếu TASK-084 stale-reclaim đồng thời thắng và bump `updatedAt` ⇒ predicate `updatedAt <
  staleCutoff` không khớp ⇒ **transition thua**.
- Nếu transition thắng ⇒ claimant/completion cũ **mất CAS ownership**: mọi completion đòi
  `status = 'RENEWING' AND updatedAt = claimGeneration`; sau transition, **cả hai** điều kiện đều lệch
  ⇒ `count = 0`, không resurrect (`markRenewedIfOwner` `:207-227`,
  `markSubscriptionFailedIfOwner` `:229-238`, `markSubscriptionExpiredIfOwner` `:240-249`).

`staleCutoff = capturedNow - STALE_CLAIM_CUTOFF_MS`, **dùng đúng hằng 30 phút hiện có của TASK-084**
(`subscription-renewal-runner.ts:43`). **Không tạo timeout thứ hai với semantics khác.**

### 6.4 Tương tác với đường "expired" của renewal worker (phát hiện thêm)

Hôm nay renewal cũng tự xử lý row quá hạn: `classifySubscription` trả `'expired'` khi
`remainingMs <= 0` (`subscription-renewal.service.ts:275-282`), rồi claim row và `completeExpired` →
CAS EXPIRED **kèm** relation-aware writer có thể flip mailbox sang `SUBSCRIPTION_EXPIRED`
(`subscription-renewal-runner.ts:253-276`).

Normalization của TASK-086 **chỉ đổi status của row, không bao giờ chạm `Mailbox.status`**. Do đó:

- Renewal claim trước ⇒ ta thua ⇒ temporarily block (fresh RENEWING) ⇒ renewal tự hoàn tất như hôm nay.
- Ta normalize trước ⇒ claim của renewal thua ⇒ **không có flip mailbox → `SUBSCRIPTION_EXPIRED`**, và
  provisioning tiếp tục tạo subscription mới. Đây là kết quả **tốt hơn** (mailbox không bị câm rồi phải
  chờ recovery TASK-083) và **không** vi phạm TASK-084: writer đó vốn chỉ flip khi không có replacement
  live, mà ở đây ta đang chuẩn bị tạo replacement.

Hành vi này chỉ xảy ra **bên trong provisioning path** (connect/reconnect/reconciliation/recovery);
renewal worker cho các mailbox không được provisioning giữ nguyên hành vi.

---

## 7. (Mục 3 yêu cầu) Blocking definition sau normalization

**Hiện tại (TASK-081):** blocking = `status live AND expirationDateTime > now`
(`mailbox-subscription-provisioning.service.ts:133-141`, hằng `BLOCKING_SUBSCRIPTION_STATUSES`).

**Đề xuất Phase 2:**

```text
STEP A: normalize expired live state (mục 6) — concurrency-safe
STEP B: findFirst where mailboxId = target AND status IN ('ACTIVE','RENEWING','FAILED')
        → nếu tồn tại: provisioning BỊ BLOCK
```

**STEP B không còn dùng `expirationDateTime > now`** — semantics thời gian đã được giải quyết ở STEP A.

Lợi ích:

1. **Application blocking definition ≡ DB unique index** (cùng một tập status) ⇒ không còn khoảng lệch
   giữa "app cho phép tạo" và "DB từ chối".
2. **Fresh RENEWING luôn block** ⇒ không cướp ownership của renewal đang chạy.
3. Không bao giờ tạo remote subscription rồi chắc chắn ăn P2002 chỉ vì một fresh claim đang giữ slot —
   tiết kiệm một Graph POST và tránh sinh orphan không cần thiết.

### 7.1 Ảnh hưởng tới TASK-081/082/083/084

| Nơi | Ảnh hưởng | Xử lý đề xuất |
|---|---|---|
| **TASK-081** ensure (`findFirst` blocking) | Thay đổi trực tiếp: bỏ điều kiện thời gian ở STEP B, thêm STEP A trước đó | Nằm trong scope TASK-086. Với mailbox khỏe mạnh, hành vi quan sát được **không đổi**: row quá hạn ACTIVE/FAILED bị normalize rồi vẫn create như trước |
| **TASK-081** hằng `BLOCKING_SUBSCRIPTION_STATUSES` | Vẫn là nguồn duy nhất của "nhóm live"; nay đóng thêm vai trò định nghĩa predicate của index | Giữ nguyên, không tách bản sao thứ hai |
| **TASK-082/083** candidate query (`none: { status live, expiration > now }`, `subscription-reconciliation-runner.ts:71`) và `hasBlockingSubscription` (`:110`) | Đây là **bộ lọc chọn ứng viên rẻ tiền**, không phải cổng quyết định. Nếu giữ nguyên, một mailbox có row live-nhưng-quá-hạn vẫn được liệt kê như hôm nay; ensure sẽ normalize (ACTIVE/FAILED) rồi create, hoặc trả outcome block (fresh RENEWING) | **Đề xuất GIỮ NGUYÊN** để không đổi ops semantics TASK-082 (D3/D8 chống scope creep). Chi phí tối đa: một lần refresh token bị "phí" khi gặp fresh RENEWING — được báo bằng outcome có kiểm soát |
| **TASK-084** `listRenewableCandidates` (`:107`) | Không dùng điều kiện thời gian trong SQL; service tự đánh giá cửa sổ | **Không đổi** |
| **TASK-084** `markMailboxSubscriptionExpiredIfNoOtherLiveSubscription` (`:266`) | Vẫn dùng `expiration > now` — đúng ngữ nghĩa "có replacement dùng được không" | **Không đổi** — TASK-086 không chạm predicate này |
| **TASK-084** claim/CAS | Không đổi; chỉ tương tác qua predicate của normalization (mục 6) | Không đổi |

---

## 8. (O2) Historical duplicate strategy — M2 FAIL-CLOSED

**Không** auto-deduplicate. **Không** tự chọn winner. **Không** tự mark historical live loser EXPIRED
trong migration. **Không** dùng migration để silently mutate lifecycle.

Phase 2 phải có:

1. **Preflight detection read-only**: đếm số row live theo `mailboxId` (`status IN (ACTIVE, RENEWING,
   FAILED)`, `HAVING count > 1`) — chạy trên từng môi trường trước deploy. Read-only, không cần
   capability/code mới.
2. Nếu tồn tại duplicate ⇒ tạo unique index **fail rõ ràng**, deployment **không được tiếp tục**.
   Migration **không được nuốt lỗi**.
3. Historical remediation là bước **có kiểm soát, human-approved**, thực hiện **trước khi** retry deploy.
4. **Không** implement remediation capability trong TASK-086 nếu nó cần thay đổi lifecycle remote
   (đúng D8/O4).

**Precedent trong chính project:** migration TASK-068A
(`prisma/migrations/20260604000000_task068a_one_active_telegram_mapping/migration.sql`) đã dùng đúng
tinh thần này: *"if a legacy duplicate exists, index creation will fail loudly during `migrate deploy`
and must be reconciled operationally rather than silently ignored."*

Đánh giá rủi ro deploy: trước TASK-081 **không có production caller nào** tạo subscription (finding F1
của TASK-079); từ TASK-081 tới nay ensure luôn có blocking-check trước create ⇒ duplicate chỉ có thể
sinh từ đúng cửa sổ race mà task này đóng. **Không khẳng định tuyệt đối** vì Phase 1 không được truy vấn
production DB (AGENTS.md) ⇒ **bắt buộc chạy preflight detection trước**.

---

## 9. (Mục 7 yêu cầu) Corrected local-insert race

Model mạnh nhất (D1 — không dựa vào Microsoft serialize hộ):

```text
A remote POST → 201 subscription A
B remote POST → 201 subscription B
A local INSERT live row → success
B local INSERT live row → UNIQUE CONFLICT
```

B bắt buộc:

1. classify unique conflict là **ownership loss**, không phải infrastructure failure;
2. compensating-delete **chỉ** subscription B (id lấy từ response của chính B);
3. **không bao giờ** cleanup theo `mailboxId`;
4. re-read live local winner theo `mailboxId`;
5. nếu winner tồn tại ⇒ outcome có kiểm soát (`lost_ownership` / `existing`), không phải `failed`;
6. **không** Graph retry loop.

**Generic DB persistence failure** (khác unique conflict): giữ **nguyên** compensation + fail-open của
TASK-081; **không** được gán nhầm thành concurrency loss.

Nền tảng có sẵn trong repo (không giả định): `lib/db/prisma-error.ts` —
`isUniqueConstraintError` (`code === 'P2002'`) và `uniqueConstraintTargetIncludes` (chấp nhận
`meta.target` dạng `string[]` **hoặc** tên index dạng chuỗi, đúng trường hợp raw partial index). Đây là
cơ chế TASK-068A đang dùng. Prisma **5.22.0**. Phase 2 **bắt buộc** có focused test chứng minh hành vi
Prisma thật, không assume.

---

## 10. (Mục 8 yêu cầu) 409 semantics — defensive only

| Case | Hành vi bắt buộc |
|---|---|
| **409 + có local live winner** | outcome `conflict/existing` có kiểm soát; không create thêm; không đổi `Mailbox.status` |
| **409 + không có local live winner** | fail-safe: **không fabricate** row local; **không** flip `SUBSCRIPTION_EXPIRED → ACTIVE`; **không** retry loop; log sanitized (`mailboxId`, `kind`, `httpStatus`) |

Case thứ hai có thể là winner concurrent chưa persist (tick sau tự resolve) **hoặc** orphan remote
(deferred, O4). TASK-086 **không** phân biệt và **không** tự sửa.

Hiện trạng cần sửa ở Phase 2: 409 chưa được map riêng trong `mapHttpStatusToError` ⇒ rơi vào kind
`http` ⇒ recovery TASK-083 coi là `failed`.

---

## 11. TASK-083 safety & TASK-081 fail-open

**TASK-083:** chỉ flip `SUBSCRIPTION_EXPIRED → ACTIVE` khi hệ thống local chứng minh có usable
subscription thuộc ownership hợp lệ (row do chính operation INSERT thành công, hoặc row live đọc được
từ DB). **Cấm** flip vì 409, vì ownership loss, hoặc vì suy đoán remote. Giữ nguyên fix High: mailbox
chuyển ACTIVE đồng thời (reconnect hợp lệ) ⇒ **giữ** subscription vừa tạo, không cleanup.

**TASK-081:** OAuth connect/reconnect vẫn thành công khi provisioning gặp 409, unique conflict,
temporarily-blocked, Graph create fail, cleanup fail hay ownership lost. Không rollback mailbox/
credential, không flip `RECONNECT_REQUIRED`, không retry loop, không biến conflict thành connect
failure. Delta polling vẫn là safety net. Mọi outcome mới là **giá trị trả về**, không phải exception.

---

## 12. (Mục 9 yêu cầu) Migration proposal (Phase 2, không viết SQL ở Phase 1)

- Khái niệm: `UNIQUE(mailboxId) WHERE status IN ('ACTIVE','RENEWING','FAILED')` — raw SQL partial
  unique index, idempotent (`IF NOT EXISTS`), additive, không backfill.
- Prisma **5.22.0** không biểu diễn được partial unique index trong schema language ⇒ index **cố ý
  không** xuất hiện trong `prisma/schema.prisma`, kèm ghi chú drift cho maintainer ngay tại model
  `GraphSubscription` — **đúng precedent TASK-068A** (xem ghi chú tương đương ở model `TelegramMapping`).
- Deploy: `prisma migrate deploy` cho staging/production (`docs/STAGING_DEPLOYMENT.md`,
  `deployment/production/README.md`); **không** `migrate dev`.
- **M2 fail-closed:** preflight detection trước, index creation fail rõ ràng nếu còn duplicate.
- Verify sau migration bằng cơ chế repo đã chấp nhận: `prisma migrate status` + truy vấn read-only trên
  `pg_indexes` để chứng minh index tồn tại thật (test đơn vị P2002 **không** thay thế được kiểm tra này).

---

## 13. (Mục 10 yêu cầu) Test matrix Phase 2

**Nhóm bắt buộc theo quyết định mới:**

1. Cùng mailbox: hai remote POST **đều 201** → chỉ **một** live local row tồn tại.
2. Loser compensating-delete **đúng subscription của chính nó** (assert id; assert không có
   `deleteMany`/`updateMany` theo `mailboxId`).
3. Khác mailbox → mỗi mailbox có một live row bình thường (không chặn chéo).
4. Cùng mailbox nhưng `resource` **khác representation** → vẫn bị local uniqueness chặn (vì key là
   `mailboxId`).
5. Nhiều row **EXPIRED** cùng mailbox → hợp lệ.
6. ACTIVE expired-by-time → normalization thành công.
7. FAILED expired-by-time → normalization thành công.
8. RENEWING **stale** expired-by-time → normalization thành công.
9. RENEWING **fresh** expired-by-time → **temporarily blocked**, Graph create spy = **0**.
10. ACTIVE/FAILED bị renewal claim concurrent → normalization **không** overwrite RENEWING.
11. Stale RENEWING được TASK-084 reclaim concurrent (bump `updatedAt`) → normalization **thua**.
12. Normalization thắng → late TASK-084 completion CAS **count = 0** (không resurrect).
13. Sau normalize vẫn còn bất kỳ live row → Graph create spy = **0**.
14. Không còn live row → create được phép.
15. 201 + 409.
16. 409 + có local live winner.
17. 409 + không có local live winner (không fabricate, không flip ACTIVE).
18. M2: preflight detection phát hiện duplicate; tạo index trên dữ liệu vi phạm **fail closed**; dữ liệu
    sạch thì thành công và idempotent.
19. TASK-081 fail-open trên mọi nhánh (409, unique conflict, blocked, create fail, cleanup fail).
20. TASK-082 dry-run vẫn hoàn toàn non-mutating (không token, không Graph, không write).
21. TASK-083 recovery safety (ACTIVE concurrent ⇒ giữ subscription; không flip vì 409/ownership loss).
22. TASK-084 CAS regressions (claim, stale reclaim 30 phút, completion CAS).
23. TASK-085 credential CAS regressions (G0→G1, CAS-loss có kiểm soát).
24. P2002 + `meta.target` focused behavior (chứng minh hành vi Prisma thật với tên raw index).
25. Generic DB failure **khác** P2002 → giữ compensation/fail-open TASK-081, không gán nhầm ownership loss.
26. Logging/sanitization: không log token/clientState/ciphertext/response body/message lỗi thô.

**Giữ thêm các race test hữu ích từ matrix trước:** disconnect concurrent (trước và sau create); OAuth
reconnect concurrent; reconciliation vs reconciliation; recovery concurrent; winner không bị loser
cleanup; loser cleanup thất bại vẫn fail-safe; remote create thành công + local persist failure.

---

## 14. Open items còn lại

| # | Nội dung | Trạng thái |
|---|---|---|
| **R1** | Orphan remote (remote sống, local không sở hữu) → có thể gây 409 kéo dài cho mailbox đó tới khi hết hạn | **Deferred / out of scope** (O4). Follow-up chưa gán số task |
| **R2** | Remote PATCH thành công nhưng CAS local thua do normalization (mục 6.3) → cùng lớp orphan | Deferred cùng R1 |
| **R3** | `resource` chưa canonical (mục 4.1) | **Observation only** — không phải correctness dependency của TASK-086; là tiền đề của scope multi-resource tương lai |
| **R4** | Fresh RENEWING trì hoãn provisioning ≤30 phút | **Chấp nhận có chủ đích** (O3), phải báo outcome có kiểm soát |
| **R5** | TASK-082/083 candidate query giữ nguyên điều kiện thời gian ⇒ có thể tốn một lần refresh token khi ensure trả "blocked" | Đề xuất chấp nhận để không đổi ops semantics TASK-082; reviewer xác nhận |

**Không có STOP condition mới.** Các hạng mục từng bị nghi ngờ đã được chứng minh bằng code hoặc
precedent: invariant một live row/mailbox (mục 4), CAS semantics TASK-084 (mục 6), Prisma/raw SQL
tooling (mục 12), loser cleanup an toàn (mục 9).

---

**Trạng thái: FINAL CORRECTED ARCHITECTURE — AWAITING ANTIGRAVITY FINAL RE-REVIEW. NO IMPLEMENTATION.**

---

## 22. PHASE 2 — IMPLEMENTATION ĐÃ THỰC HIỆN

> Antigravity Architecture Re-review: **PASS — approved for Phase 2**.
> Antigravity **Implementation Review chưa diễn ra**. Không commit, không push, không ROADMAP.

### 22.1 File đã thay đổi

| File | Loại | Nội dung |
|---|---|---|
| `services/microsoft/subscription-claim-window.ts` | mới | Hằng `STALE_CLAIM_CUTOFF_MS` (30 phút) + `computeStaleClaimCutoff` — leaf module dùng chung, tránh tạo timeout thứ hai |
| `services/queue/workers/subscription-renewal-runner.ts` | sửa | Chỉ đổi **nguồn** của hằng stale cutoff sang module dùng chung; giá trị và mọi chỗ dùng giữ nguyên |
| `services/microsoft/graph-subscription.service.ts` | sửa | Thêm kind `conflict` (HTTP 409) + `ownership_conflict`; export tên index; tách unique-conflict khỏi generic DB failure trong nhánh persist |
| `services/microsoft/mailbox-subscription-provisioning.service.ts` | sửa | STEP A normalization + fresh/stale RENEWING + STEP B blocking không còn điều kiện thời gian + phân loại conflict |
| `services/microsoft/subscription-reconciliation.service.ts` | sửa | Plumbing outcome mới (thêm `blocked_renewing` + counter); không đổi dry-run/apply/bounded/sequential |
| `prisma/migrations/20260829000000_task086_one_live_graph_subscription/migration.sql` | mới | Partial unique index + M2 fail-closed + preflight/verify query read-only trong comment |
| `prisma/schema.prisma` | sửa | **Chỉ comment** (ghi chú drift cho maintainer + ghi chú `updatedAt` là claim generation của TASK-084). Không đổi model/field |
| `tests/unit/microsoft/mailbox-subscription-provisioning.concurrency.test.ts` | mới | Test matrix normalization + blocking + conflict |
| `tests/unit/microsoft/graph-subscription.live-slot-conflict.test.ts` | mới | Phân loại P2002 với **Prisma error thật** + 409 |
| `tests/unit/microsoft/mailbox-subscription-provisioning.service.test.ts` | sửa | Fake prisma theo surface mới (findMany/updateMany) |
| `tests/unit/microsoft/subscription-reconciliation.service.test.ts` | sửa | Fake ensure theo union mới + test outcome mới + dry-run non-mutating |
| `tests/unit/microsoft/subscription-reconciliation.recovery.test.ts` | sửa | Test TASK-083: không outcome concurrency nào được flip mailbox |
| `tests/api/microsoft-oauth-callback.route.test.ts` | sửa | Prisma mock của route theo surface mới |

### 22.2 Normalization (Area A/B)

`ensureInboxSubscriptionForConnectedMailbox` chạy: `capturedNow` → đọc live rows (`findMany` theo
status) → normalize → nếu có fresh RENEWING thì trả `blocked_renewing` → re-read → còn live row thì
`skipped_existing` → chỉ khi sạch mới POST.

- ACTIVE/FAILED: `updateMany where { id, status: <status đã đọc>, expirationDateTime: { lte: capturedNow } }`.
- RENEWING stale: thêm `updatedAt: { lt: staleCutoff }`.
- Fresh RENEWING: **không** write, **không** Graph POST, **không** insert, **không** retry.
- Không câu lệnh nào chạm bảng `Mailbox`.

### 22.3 Blocking definition (Area C)

Cả hai lần đọc đều là `where { mailboxId, status: { in: ['ACTIVE','RENEWING','FAILED'] } }` — **không
còn** `expirationDateTime > now`, nên application semantics khớp đúng partial unique index. Candidate
query của TASK-082/083 giữ nguyên (bộ lọc chọn ứng viên; ensure là cổng correctness).

### 22.4 Partial unique index + M2 (Area D)

`CREATE UNIQUE INDEX IF NOT EXISTS "GraphSubscription_mailboxId_live_unique" ON "GraphSubscription"
("mailboxId") WHERE "status" IN ('ACTIVE','RENEWING','FAILED')` — raw SQL theo precedent TASK-068A,
additive, idempotent, **không** dedup/không chọn winner/không đổi lifecycle. Nếu còn duplicate lịch sử
thì `prisma migrate deploy` fail rõ ràng. Comment migration chứa **preflight read-only** (group by
`mailboxId`, `HAVING COUNT(*) > 1`) và truy vấn verify index qua `pg_indexes`.

### 22.5 Local unique conflict (Area E)

`createInboxSubscription` phân loại lỗi persist bằng `lib/db/prisma-error.ts`:

- P2002 + `meta.target` chứa tên index live-slot ⇒ log info sanitized → **compensating DELETE đúng
  subscription của chính mình, đúng một lần** → throw kind `ownership_conflict`;
- P2002 trên `subscriptionId` hoặc lỗi khác ⇒ giữ nguyên kind `database` (semantics TASK-081).

Ensure bắt `ownership_conflict` → re-read live rows → `lost_ownership` (có winner) hoặc
`conflict_unowned` (không có). Không retry Graph create.

### 22.6 Microsoft 409 (Area 10)

`mapHttpStatusToError` map 409 → kind `conflict`. Ensure → re-read → `conflict_existing` (có winner)
hoặc `conflict_unowned` với `source: 'remote_conflict'`. Không fabricate row, không flip mailbox,
không retry loop. Orphan remediation vẫn out of scope.

### 22.7 Kết quả verify

`npm run verify` **PASS (exit 0)** — **104 test files / 1281 tests passed**, lint + typecheck + build sạch.

### 22.8 Deferred/residual (không đổi so với Phase 1)

R1/R2 orphan remote (out of scope), R3 `resource` representation (observation), R4 fresh RENEWING trì
hoãn ≤30 phút (có chủ đích), R5 candidate query TASK-082/083 giữ nguyên.
