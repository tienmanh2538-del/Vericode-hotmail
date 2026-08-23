# TASK-084 — Subscription Renewal Concurrency Guard

## Trạng thái phase

**PHASE 2 — IMPLEMENTATION (đã hoàn tất, chờ Antigravity review). Investigation /
architecture (PHẦN A + B + C bên dưới) đã qua nhiều vòng review và Final Antigravity
Architecture Re-review PASS; hai architecture corrections cuối (A + B) đã được chốt và
implement đúng. Runtime + tests đã được viết; `npm run verify` PASS. Xem PHẦN D cho
chi tiết implementation.** History review được giữ nguyên bên dưới (KHÔNG viết lại lịch
sử) — bao gồm vòng Antigravity review đầu (FAIL — architecture correction required),
correction A (CAS failure phải chặn MỌI mailbox side effect — B1 nguyên tắc 2, B4
ordering, D7) và correction B (RECONNECT_REQUIRED cần credential-generation guard cho
concurrent OAuth reconnect — A11, B5b/B5c/B5d, B13, D8).

Phase 2 đã thực hiện (chi tiết PHẦN D) và giữ nguyên các ràng buộc scope:

- ĐÃ implement atomic claim + CAS ownership + conditional mailbox writers (runtime + tests);
- KHÔNG schema/migration, KHÔNG version column;
- KHÔNG distributed lock / Redis wiring mới;
- KHÔNG worker/scheduler/queue mới;
- KHÔNG production rollout trong phase này;
- KHÔNG đọc/sửa file env cục bộ; KHÔNG thay đổi GitHub Actions;
- KHÔNG kéo broader credential-rotation race vào (vẫn DEFERRED).

Nguồn gốc: finding M2 của audit TASK-077 ("subscription renewal thiếu guard
concurrency") + ghi nhận single-replica assumption trong TASK-082. Phần A là kết quả
trace code hiện tại (sau TASK-083); phần B là kiến trúc guard đã được chốt sau
review.

---

# PHẦN A — INVESTIGATION FINDINGS (đã xác nhận qua review)

## A0. Tóm tắt verdicts đã được Antigravity xác nhận

1. Same-process scheduler: **PASS** — inflight guard + sequential batch ngăn overlap
   trong một process.
2. Cross-process / multi-replica: **CONFIRMED unsafe** — không có atomic
   claim/ownership.
3. Candidate selection hiện tại **chứa cả RENEWING**.
4. Write RENEWING hiện có **không phải atomic claim** (unconditional update).
5. Completion writers **không có ownership/CAS** → stale worker có thể overwrite
   state mới hơn của worker khác.
6. TASK-083 interaction: old renewal failure có thể kéo mailbox ACTIVE vừa recovered
   về SUBSCRIPTION_EXPIRED.
7. Disconnect race: late renewal writer có thể overwrite operator DISABLED state khi
   writer không conditional.
8. Credential rotation race: **CONFIRMED nhưng DEFERRED** ngoài TASK-084.

## A1. Current renewal lifecycle (đã trace, sau TASK-083)

```text
scheduler tick (mặc định mỗi 15 phút, SUBSCRIPTION_RENEWAL_INTERVAL_SECONDS)
  → repo.listRenewableCandidates()
      findMany GraphSubscription
        where status in (ACTIVE, RENEWING, FAILED)
          and mailbox.status != DISABLED
        orderBy expirationDateTime asc          ← KHÔNG limit, KHÔNG claim
  → per candidate: classifySubscription (pure)
      subscriptionId trống            → invalid (skip)
      mailbox DISABLED                → skip
      expiration <= now               → expired → markSubscriptionExpired
                                                 + markMailboxSubscriptionExpired
      expiration <= window (24h)      → renew
      còn xa                          → skip
  → renew path:
      accessToken port: đọc encryptedRefreshToken → decrypt → refresh exchange
        → persistRotatedRefreshToken (ghi đè credential, last-writer-wins)
      renewGraphSubscription:
        (a) update status = RENEWING          ← UNCONDITIONAL, lỗi chỉ log warn
        (b) PATCH Graph /subscriptions/{id} (now + 6 ngày)
        (c) lỗi PATCH → update status = FAILED    ← UNCONDITIONAL
        (d) thành công → update expirationDateTime + status = ACTIVE
                        + lastRenewedAt            ← UNCONDITIONAL
      classify lỗi (TASK-069C / TASK-071 semantics):
        auth (401)        → markMailboxReconnectRequired + markSubscriptionFailed
        permission (403)  → transient, retry bounded (không reconnect)
        404/410           → markSubscriptionExpired + markMailboxSubscriptionExpired
        429/5xx/network   → transient, retry tối đa 3 lần trong tick
        khác              → fatal → markSubscriptionFailed
```

Mọi write ở repo renewal (`markSubscription*`, `markMailbox*`) đều là `update` theo
khóa (subscriptionId unique / mailbox id) **không điều kiện status** — không CAS,
không affected-count.

## A2. Exact files/functions

| Thành phần | File | Ghi chú |
|---|---|---|
| Candidate selection | `services/queue/workers/subscription-renewal-runner.ts` → `createPrismaSubscriptionRenewalRepo().listRenewableCandidates` (dòng ~64–96) | findMany thuần, gồm cả RENEWING |
| Classify/orchestration | `services/microsoft/subscription-renewal.service.ts` → `classifySubscription`, `renewOneSubscription`, `runSubscriptionRenewalOnce` | pure + port-injected |
| RENEWING/FAILED/ACTIVE writer | `services/microsoft/graph-subscription.service.ts` → `renewGraphSubscription` (dòng ~548–649) | caller duy nhất là renewal runner |
| Mailbox status writers | `subscription-renewal-runner.ts` → `markMailboxReconnectRequired`, `markMailboxSubscriptionExpired` (dòng ~109–121) | unconditional |
| Token port | `subscription-renewal-runner.ts` → `createPrismaRenewalAccessTokenPort` (dòng ~151–204) | decrypt → refresh → persist rotated |
| Rotation persistence | `services/microsoft/refresh-token-rotation.service.ts` → `persistRotatedRefreshToken` | last-writer-wins, không version check |
| Scheduler | `subscription-renewal-runner.ts` → `startSubscriptionRenewalScheduler` (dòng ~294–356) | inflight guard in-process |
| CLI entry | `scripts/run-subscription-renewal-worker.ts` (`worker:renewal`, `worker:renewal:once`) | không có process-level mutex |
| Redis mailbox lock (TASK-068A) | `services/queue/redis-mailbox-lock.ts`, `mailbox-lock-factory.ts` | chỉ email worker dùng, fail-open |
| Conditional transition pattern (TASK-082/083) | `services/queue/workers/subscription-reconciliation-runner.ts` (dòng ~120–158) | `updateMany where {id, status}` + affected-count |
| Possibly-live/blocking definition (TASK-081) | `services/microsoft/mailbox-subscription-provisioning.service.ts` → `BLOCKING_SUBSCRIPTION_STATUSES = ACTIVE, RENEWING, FAILED` + `expirationDateTime > now` | source of truth duy nhất |
| Disconnect (TASK-052) | `services/microsoft/mailbox-disconnect.service.ts` | local DISABLED trước, remote delete best-effort sau; KHÔNG xóa encryptedRefreshToken |

## A3. Same-process concurrency: ĐÃ CÓ GUARD

`startSubscriptionRenewalScheduler` giữ một promise `inflight`; tick mới bị skip khi
tick trước chưa xong, `stop()` await tick đang chạy. Batch xử lý tuần tự. Không cần
sửa gì cho same-process.

## A4. Cross-process / multi-replica: KHÔNG CÓ GUARD — M2 CONFIRMED

- Không có cơ chế code-level nào ngăn hai process renewal chạy song song.
- Hai process (hai replica, scheduler + `--once` thủ công, hoặc rolling-restart
  overlap) cùng `findMany` ra cùng tập candidate → cùng renew.
- Candidate selection bao gồm RENEWING nên bước set RENEWING không loại row khỏi
  worker thứ hai; comment trong code nói RENEWING chống race là sai so với hành vi
  thực tế.
- Single-replica assumption chỉ tồn tại ở mức deployment, không enforce ở code.

## A5. Duplicate remote-renew race

- PATCH renew chỉ set expiration mới; hai PATCH sát nhau chênh vài giây, remote
  last-PATCH-wins — chủ yếu tốn quota/log noise.
- Race nguy hiểm hơn là interleaving success/failure: worker A fail muộn SAU KHI
  worker B renew thành công → FAILED (unconditional) đè ACTIVE của B → webhook gate
  (chỉ nhận ACTIVE/RENEWING) skip notification tới tick sau (~15 phút; delta polling
  vẫn backup).
- Open question external (không đoán, không cần chốt vì guard loại bỏ double-PATCH):
  hành vi Microsoft với hai PATCH renewal sát nhau.

## A6. Credential rotation race — CONFIRMED, DEFERRED khỏi TASK-084

`persistRotatedRefreshToken` là last-writer-wins không version check, được gọi từ
**bốn** đường ghi đè cùng `mailbox.encryptedRefreshToken`:

1. renewal worker (`createPrismaRenewalAccessTokenPort`);
2. delta polling worker (`delta-polling-runner.ts` dòng ~234);
3. email worker (`email-worker-runner.ts` dòng ~264);
4. reconciliation/recovery (tái dùng port renewal).

Race này tồn tại ngay hôm nay giữa các worker khác loại (mỗi loại 1 replica). Nếu
Microsoft invalid hóa credential không phải bản mới nhất, writer cuối có thể persist
bản stale → invalid_grant → RECONNECT_REQUIRED. Hành vi rotation/invalidation chính
xác của Microsoft là open question — không đoán.

**Quyết định (D4): DEFER.** Không sửa token storage/CAS trong TASK-084. Ghi thành
backlog follow-up sau khi TASK-084 hoàn tất. Nếu implementation phát hiện đây là
mandatory blocker cho renewal claim safety → STOP và báo human/ChatGPT.

## A7. Local state overwrite race (GraphSubscription)

Mọi writer trạng thái subscription trong đường renewal đều unconditional: FAILED có
thể đè ACTIVE mới hơn hoặc đè EXPIRED của disconnect; ACTIVE + expiration có thể đè
EXPIRED của disconnect. Vì `subscriptionId` unique, writer muộn chỉ đụng đúng row cũ
— không đụng row mới do TASK-083 recovery tạo; thiệt hại giới hạn ở row cũ + mailbox
status.

## A8. Disconnect race — HAZARD CÓ THẬT NGAY VỚI 1 REPLICA

Disconnect: transaction set mailbox DISABLED + mapping DISABLED + subscription live →
EXPIRED, rồi remote delete best-effort; KHÔNG xóa encryptedRefreshToken. Renewal chỉ
check DISABLED lúc select/classify, không re-check trước persist. Interleaving với
candidate in-flight:

- Remote delete xong trước → PATCH 404/410 → `markMailboxSubscriptionExpired`
  unconditional → DISABLED bị đè thành SUBSCRIPTION_EXPIRED → mailbox disconnect
  trở thành candidate hợp lệ của TASK-083 recovery → có thể resurrect qua 2 bước.
- Remote delete fail → PATCH thành công → row EXPIRED bị ghi ngược về ACTIVE +
  expiration mới → local xuất hiện lại subscription "live" trên mailbox DISABLED
  (relay không chạy vì các gate đòi mailbox ACTIVE, nhưng row blocking làm sai
  ensure/reconnect sau này và ngược ordering fail-safe TASK-052).
- Token auth lỗi → `markMailboxReconnectRequired` unconditional → DISABLED bị đè
  thành RECONNECT_REQUIRED.

## A9. TASK-083 interaction — guard một chiều, chưa đủ

Chiều TASK-083 → renewal: mọi transition recovery đều conditional + affected-count →
không ghi đè state của renewal. ĐỦ.

Chiều renewal → TASK-083: KHÔNG đủ:

1. Renewal đang xử lý subscription cũ A (FAILED, expiration còn trong tương lai).
2. Operator chạy recovery: tạo subscription mới B, conditional flip mailbox
   SUBSCRIPTION_EXPIRED → ACTIVE thành công.
3. Renewal cũ kết thúc muộn 404/410 trên A → `markMailboxSubscriptionExpired`
   unconditional → mailbox ACTIVE (có B sống) bị kéo về SUBSCRIPTION_EXPIRED.
4. Mailbox bị loại khỏi webhook gate + delta polling dù B còn sống; chạy lại recovery
   không cứu được vì B là blocking row (edge D2 của TASK-083) → kẹt tới khi can
   thiệp tay.

## A10. Existing guard seams

| Seam | Trạng thái | Dùng cho TASK-084? |
|---|---|---|
| DB conditional `updateMany` + affected-count (TASK-082/083) | Proven, đang chạy | **CÓ — seam chính** |
| `GraphSubscription.updatedAt` (có sẵn, @updatedAt) | Có sẵn trong schema | **CÓ — CAS token** (xem B2, B3) |
| `Mailbox.encryptedRefreshToken` value (có sẵn) | Có sẵn; token port đã đọc | **CÓ — credential-generation seam R2** (xem A11, B5b/B5c) |
| `Mailbox.tokenLastRefreshedAt` (có sẵn) | Có sẵn | **ALT — credential-generation seam R3** (xem A11, B5c) |
| `Mailbox.updatedAt` (có sẵn, @updatedAt) | Có sẵn | **KHÔNG** làm credential seam — bị bump bởi mọi write (R1 rejected, B5c) |
| Scheduler inflight guard | Có sẵn | Giữ nguyên |
| TASK-081 blocking definition | Có sẵn, đã export | **CÓ — relation predicate** (xem B4) |
| Redis mailbox lock TASK-068A | Có code, production chưa wire, fail-open | KHÔNG — sai key (mailbox ≠ subscription), cần wiring mới vượt scope, fail-open đúng lúc cần guard nhất, không chặn được operator flows |
| In-memory mailbox lock | Per-process | Vô dụng cross-process |

## A11. Mailbox credential-generation seams (đã trace cho correction B)

Câu hỏi: khi nào từng cột của `Mailbox` thay đổi, để chọn seam chứng minh "credential
generation của operation vẫn hiện hành". Đã trace các đường ghi:

| Operation | `encryptedRefreshToken` | `tokenLastRefreshedAt` | `updatedAt` (@updatedAt) | `status` |
|---|---|---|---|---|
| OAuth reconnect (`mailbox-connect.service.ts` → `saveConnectedMailbox`, existing row, dòng ~157–167) | **set = credential mới B** | set `now()` | bump | → ACTIVE |
| Renewal token rotation (`refresh-token-rotation.service.ts` → `persistRotatedRefreshToken`, gọi TRONG token port dòng ~188, **chỉ khi MS rotate**) | set mới | set `now()` | bump | không đổi |
| Delta polling rotation (cùng `persistRotatedRefreshToken`) | set mới | set `now()` | bump | không đổi |
| Email worker rotation (cùng helper) | set mới | set `now()` | bump | không đổi |
| Status writes (markMailbox*, reconciliation, TASK-083) | không đổi | không đổi | bump | đổi |
| Delta polling progress (deltaLastPolledAt/lastSuccessfulSyncAt) | không đổi | không đổi | bump | thường không đổi |
| Disconnect (`mailbox-disconnect.service.ts`) | **KHÔNG xóa** (giữ nguyên) | không đổi | bump | → DISABLED |

Rút ra:

1. `updatedAt` bị bump bởi **mọi** đường trên → KHÔNG phân biệt được "credential đổi"
   với "một status/progress write vô hại" → loại làm credential seam (R1 rejected).
2. `tokenLastRefreshedAt` đổi **đúng khi** credential đổi (OAuth reconnect + mọi
   rotation) → là "credential generation timestamp" (R3, alternative).
3. `encryptedRefreshToken` value **chính là** credential generation; token port đã
   `select` sẵn (dòng ~159) → seam trực tiếp, không cần đọc thêm cho Case A (R2, chính).
4. Token port hiện chỉ trả `accessToken`; để mang seam xuống writer cần đổi kiểu trả
   (plumbing trong layer, không schema — xem B5b). Case B cần capture giá trị
   **post-rotation** vì chính operation có thể đã rotate.
5. Disconnect KHÔNG clear credential → sau disconnect `encryptedRefreshToken` vẫn khớp
   capture, nên guard DISABLED cho reconnect vẫn phải dựa trên `status != DISABLED`
   (credential seam một mình không chặn được late writer sau disconnect vì credential
   không đổi khi disconnect).

---

# PHẦN B — LOCKED ARCHITECTURE (đã chốt sau Antigravity review)

## B1. Nguyên tắc chốt

- **KHÔNG** Redis distributed lock làm guard chính.
- Guard = **atomic DB claim + CAS ownership** trên GraphSubscription, cộng
  **conditional mailbox writers** (relation-aware cho SUBSCRIPTION_EXPIRED; operator-
  state + credential-generation-aware cho RECONNECT_REQUIRED).
- Nguyên tắc trung tâm 1: **Only current claim owner may apply subscription-level
  completion/failure effects.**
- Nguyên tắc trung tâm 2 (correction A — locked): **ONLY THE CURRENT CLAIM OWNER MAY
  APPLY ANY RESULTING MAILBOX LIFECYCLE SIDE EFFECT.** Một mailbox lifecycle write
  (SUBSCRIPTION_EXPIRED, RECONNECT_REQUIRED) chỉ được phép SAU KHI subscription-level
  CAS chứng minh operation vẫn giữ claim (affected count = 1). CAS count = 0 hoặc CAS
  throw ⇒ mất/không chứng minh được ownership ⇒ **DỪNG trước mọi mailbox mutation**.
  `relation predicate correctness does NOT permit mailbox side effects after a lost
  CAS claim` — predicate đúng về mặt logic KHÔNG thay thế cho việc phải sở hữu claim.
- Nguyên tắc trung tâm 3 (correction B — locked): **GraphSubscription claim ownership
  KHÁC Mailbox credential-generation ownership.** CAS trên `GraphSubscription.updatedAt`
  chứng minh operation còn sở hữu subscription row; nó KHÔNG tự động chứng minh credential
  mailbox mà operation dùng vẫn là credential hiện hành sau một OAuth reconnect đồng thời.
  RECONNECT_REQUIRED là quyết định credential/auth-level nên cần guard riêng ở mức
  credential generation (xem B5, B5b, B13). KHÔNG conflate hai loại ownership.

## B2. Atomic claim

Claim eligibility:

- status ACTIVE;
- status FAILED;
- status RENEWING **nhưng stale hơn cutoff** (fresh RENEWING không được claim lại).

Claim là một `updateMany` conditional + affected-count, conceptually:

```text
where:
  subscriptionId = <id>
  AND (
    status in (ACTIVE, FAILED)
    OR (status = RENEWING AND updatedAt < staleCutoff)
  )
data:
  status    = RENEWING
  updatedAt = claimTimestamp        ← set TƯỜNG MINH, worker giữ lại giá trị này
```

- Claim thành công ⇔ affected count = 1.
- Count = 0 → claimant thua: KHÔNG refresh credential, KHÔNG Graph PATCH, KHÔNG
  completion write, tăng `claimLostCount`, không retry ngay — tick sau re-evaluate.
- Candidate query loại RENEWING tươi (chỉ giữ ACTIVE/FAILED, hoặc RENEWING có
  `updatedAt < staleCutoff`) để không tốn công vào row đang được xử lý.

## B3. CAS ownership qua `updatedAt` (claim generation)

`status = RENEWING` một mình KHÔNG đủ chứng minh ownership (hai claimant nối tiếp
đều thấy RENEWING). Claim generation dùng cột `updatedAt` **có sẵn** làm CAS token:

- Mỗi successful claimant giữ `claimTimestamp` (giá trị nó đã set tường minh).
- **Completion writer chỉ được mutate khi match đồng thời:**

```text
where:
  subscriptionId = <id>
  AND status     = RENEWING
  AND updatedAt  = claimTimestamp
```

- Stale reclaim: Worker B reclaim row stale của Worker A → set
  `updatedAt = claimTimestampB` → generation đổi. Completion muộn của A (match
  `claimTimestampA`) trả count = 0 → A KHÔNG được: write ACTIVE, write FAILED,
  overwrite expiration, overwrite lastRenewedAt, hay trigger mailbox lifecycle
  writer dựa trên stale ownership.
- Mọi write khác vào row (vd disconnect updateMany live → EXPIRED) bump `updatedAt`
  qua `@updatedAt` → CAS của mọi claimant hiện hành mất hiệu lực → late writer
  count = 0. Đây chính là cơ chế chặn late subscription writer sau disconnect (B6).

### `updatedAt` safety — bắt buộc verify ở implementation phase bằng focused tests

1. Claim write set được và đọc lại được **exact** `updatedAt` value dùng làm CAS
   (Prisma cho phép set tường minh cột `@updatedAt` trong `data`).
2. Exact DateTime equality hoạt động với Prisma/PostgreSQL hiện tại (Prisma
   DateTime → `timestamp(3)`, độ phân giải ms — JS Date cùng độ phân giải; phải
   chứng minh không lệch round-trip).
3. Stale reclaim thực sự đổi generation.
4. Old claimant completion trả count = 0.
5. Disconnect / local state change làm CAS cũ mất hiệu lực.

**Nếu implementation chứng minh `updatedAt` không usable làm exact CAS → STOP và
báo human/ChatGPT. KHÔNG tự thêm schema/version column.**

## B4. Mailbox writer SUBSCRIPTION_EXPIRED — relation-aware (correction bắt buộc)

Predicate `WHERE mailbox.status = ACTIVE` **một mình KHÔNG đủ**: sau TASK-083
recovery mailbox đã ACTIVE trở lại, nên old-subscription failure vẫn match và vẫn
expire nhầm mailbox đang được subscription mới bảo vệ.

Mailbox chỉ được chuyển sang SUBSCRIPTION_EXPIRED khi đồng thời:

1. mailbox vẫn ACTIVE;
2. failing renewal operation vẫn sở hữu current claim (CAS B3) nếu side effect bắt
   nguồn từ claimed subscription;
3. **KHÔNG tồn tại một GraphSubscription KHÁC vẫn possibly-live**, theo đúng
   source-of-truth TASK-081/TASK-082 (không phát minh definition thứ hai):
   `status in (ACTIVE, RENEWING, FAILED) AND expirationDateTime > now`, và **phải
   exclude chính subscription đang thất bại** khỏi relation check.

Conceptually:

```text
mailbox updateMany where:
  id = mailboxId
  AND status = ACTIVE
  AND graphSubscriptions none(
        id != failingSubscriptionRowId
        AND status in (ACTIVE, RENEWING, FAILED)
        AND expirationDateTime > now
      )
data: status = SUBSCRIPTION_EXPIRED
```

Nếu subscription B mới (TASK-083 recovery) tồn tại → predicate không match →
mailbox giữ ACTIVE; old subscription A failure KHÔNG được expire mailbox.

### Ordering an toàn (correction A — CAS failure MUST stop ALL side effects)

Wording cũ ("bước 2 đúng KỂ CẢ khi bước 1 thất bại/bị swallow") **BỊ HỦY** — không
an toàn. Lý do: nếu bước 1 (CAS mark EXPIRED) thất bại vì mất claim (count = 0) hoặc
vì DB error, thì operation KHÔNG còn (hoặc không chứng minh được) là current claim
owner; theo nguyên tắc trung tâm 2 nó KHÔNG được phép chạm mailbox. "Relation predicate
loại được failing row khỏi chính nó" chỉ nói predicate không tự-mâu-thuẫn — nó KHÔNG
cấp quyền side-effect cho một stale owner.

Thứ tự bắt buộc mới cho nhánh expired/404/410:

```text
STEP 1 — CAS-complete the failing GraphSubscription
  updateMany where:
    subscriptionId = <id>
    AND status     = RENEWING
    AND updatedAt  = claimTimestamp        ← exact claim generation
  data: status = EXPIRED (terminal/non-usable)
  → branch trên affected count:

  ── count = 1 ────────────────────────────────────────────────
     Operation VẪN sở hữu claim. CHỈ KHI ĐÓ mới được evaluate/apply
     relation-aware Mailbox writer (STEP 2).

  ── count = 0 ────────────────────────────────────────────────
     Mất claim ownership (bị stale-reclaim / disconnect bump updatedAt /
     worker khác đã complete). Bắt buộc:
       • tăng/ghi nhận claimLostCount;
       • KHÔNG Mailbox mutation;
       • KHÔNG SUBSCRIPTION_EXPIRED transition;
       • KHÔNG RECONNECT_REQUIRED side-effect dựa trên stale result này;
       • không retry loop (backstop = tick sau).

  ── CAS throws / DB error ─────────────────────────────────────
     Coi như failed persistence:
       • KHÔNG mailbox lifecycle mutation;
       • KHÔNG giả định ownership;
       • không blind retry loop.

STEP 2 — Mailbox writer với relation predicate ở trên (chỉ đạt khi STEP 1 count = 1)
  updateMany where:
    id = mailboxId
    AND status = ACTIVE
    AND graphSubscriptions none(
          id != failingSubscriptionRowId
          AND status in (ACTIVE, RENEWING, FAILED)
          AND expirationDateTime > now
        )
  data: status = SUBSCRIPTION_EXPIRED
```

Điểm khác biệt then chốt so với draft cũ: **STEP 2 KHÔNG BAO GIỜ chạy khi STEP 1
count = 0 hoặc throw.** Relation predicate correctness (exclude failing row) vẫn được
giữ ở STEP 2 như một lớp bảo vệ thứ hai, nhưng nó **không còn là lý do** để cho phép
mailbox side effect sau khi mất CAS claim.

**Kết luận atomicity:** relation-predicate `updateMany` của STEP 2 tự atomic ở mức DB
(một UPDATE + NOT EXISTS subquery). STEP 1 và STEP 2 là hai statement tuần tự, **được
gate bằng affected-count của STEP 1** — không cần transaction bao hai bước vì STEP 2
chỉ chạy khi STEP 1 đã xác nhận ownership. Race "subscription B tạo NGAY SAU STEP 2"
tự lành qua recovery/reconnect flow TASK-082/083 (re-check nhiều bước, flip conditional).
Nếu implementation phát hiện Prisma không express được predicate STEP 2 bằng updateMany
→ mới cân nhắc transaction, ghi rõ trong implementation report (không tự thêm trước).

## B5. Mailbox writer RECONNECT_REQUIRED — GIỮ semantics TASK-069C (correction 9)

**KHÔNG** áp dụng máy móc relation-predicate "không có subscription khác live" cho
RECONNECT_REQUIRED. Lý do: RECONNECT_REQUIRED phản ánh **mailbox credential/auth
failure** theo TASK-069C, không phải subscription-only failure. Một subscription
remote còn live KHÔNG chứng minh refresh credential còn khỏe. Câu hỏi đúng KHÔNG phải
"còn subscription live không" mà là **ownership/freshness của credential**: làm sao
renewal chứng minh auth failure thuộc về **credential generation HIỆN HÀNH của mailbox**
chứ không phải một operation cũ trước reconnect.

Trace exact caller/source-state hiện tại:

- Caller duy nhất trong đường renewal: `handleReconnectRequired`
  (`subscription-renewal.service.ts` dòng ~299–316), được gọi từ hai nguồn:
  1. token port throw `SubscriptionRenewalTokenError('reconnect_required')` —
     không có encryptedRefreshToken / decrypt fail / `classifyRefreshTokenError`
     trả reconnect (invalid_grant, interaction_required) — xảy ra TRƯỚC Graph PATCH
     và TRƯỚC bất kỳ rotation persist nào (**Case A**);
  2. `classifyRenewError` = `reconnect_required` khi PATCH trả 401 (`kind: auth`)
     trên access token vừa mint — xảy ra SAU access-token acquisition, nơi operation
     có thể đã persist một rotated refresh credential (**Case B**).
- Source mailbox state tại thời điểm write: candidate chỉ được lọc
  `status != DISABLED` lúc select, nên mailbox có thể đang ở ACTIVE,
  RECONNECT_REQUIRED, SUBSCRIPTION_EXPIRED, WEBHOOK_FAILED, ERROR — và có thể vừa
  bị operator disconnect (DISABLED) HOẶC vừa được OAuth reconnect (ACTIVE + credential
  mới) sau khi select.

### Concurrent OAuth reconnect race (correction B — phải phân tích, KHÔNG được silently accept)

Draft cũ chỉ guard `status != DISABLED` và **chấp nhận residual** rằng một stale
renewal có thể kéo mailbox vừa reconnect về RECONNECT_REQUIRED. Điều này KHÔNG được
chấp nhận nếu ngăn được bằng state có sẵn. Race cụ thể:

```text
1. renewal bắt đầu với credential generation A;
2. OAuth reconnect đồng thời thành công → persist credential generation B, mailbox ACTIVE;
3. operation renewal cũ (generation A) sau đó tạo ra reconnect-required / auth failure;
4. writer chỉ guard `status != DISABLED` vẫn match ACTIVE của B;
5. stale operation A đổi mailbox vừa reconnect B → RECONNECT_REQUIRED (SAI).
```

`status != DISABLED` đủ cho disconnect safety nhưng **KHÔNG đủ** cho concurrent OAuth
reconnect. Cần một predicate ở mức **credential generation**.

### B5b. Credential-generation guard (proposed minimal)

**Conditional predicate mới:**

```text
mailbox updateMany where:
  id = mailboxId
  AND status != DISABLED
  AND encryptedRefreshToken = <capturedCredentialGeneration>   ← credential ownership
data: status = RECONNECT_REQUIRED
```

- `count = 1` → operation vẫn sở hữu credential generation hiện hành → mark
  RECONNECT_REQUIRED (giữ nguyên TASK-069C semantics).
- `count = 0` → hoặc DISABLED (operator) hoặc credential generation đã đổi (OAuth
  reconnect / rotation đồng thời) → treat as lost/stale side effect: KHÔNG write,
  giữ nguyên mailbox state, report (dùng chung claimLost/observability B10).

**Capture point cho từng case:**

- **Case A** (reconnect failure TRƯỚC rotation): capture = giá trị `encryptedRefreshToken`
  mà token port đọc lúc `getAccessTokenForMailbox` bắt đầu (`select encryptedRefreshToken`
  đã có sẵn — dòng ~159). Đây đúng là credential mà operation "đã chứng minh invalid".
  - Nguồn "no encryptedRefreshToken": capture = `null` → predicate `encryptedRefreshToken IS NULL`;
    OAuth reconnect thêm B (non-null) → count 0 → không mark (đúng).
  - Nguồn "decrypt fail": capture = ciphertext hỏng đã đọc; nếu reconnect ghi B khác
    → count 0; nếu không → count 1, mark (đúng: token thật sự không decrypt được).
  - Nguồn "invalid_grant / interaction_required": capture = ciphertext A đã dùng để
    exchange; reconnect B khác → count 0; không reconnect → count 1, mark (giữ TASK-069C).
- **Case B** (Graph 401 SAU access-token acquisition): operation có thể đã tự
  `persistRotatedRefreshToken` (A→A'). Capture phải là **credential generation mà
  operation commit/dùng cho Graph call = giá trị SAU rotation của chính nó** (nếu MS
  không rotate thì = giá trị đã đọc). Một OAuth reconnect B đáp SAU rotation persist
  của operation → mailbox giữ B ≠ capture → count 0 → không mark (đúng).

**Plumbing (trong renewal runner/service/repo layer, không schema):** token port hiện
chỉ trả `accessToken: string`. Để mang được `capturedCredentialGeneration` xuống writer,
port cần trả thêm generation đã capture (giá trị đọc ở Case A; giá trị post-rotation ở
Case B). Vì `persistRotatedRefreshToken` không surface ciphertext đã ghi, Case B cần
hoặc (i) port re-read `encryptedRefreshToken` một lần tại điểm commit trước Graph PATCH,
hoặc (ii) `persistRotatedRefreshToken` trả về ciphertext đã ghi. Cả hai đều nằm trong
layer renewal, không đụng schema. **Credential value KHÔNG BAO GIỜ được log** — nó chỉ
đi qua WHERE predicate dưới dạng ciphertext (không plaintext, không log).

### B5c. Seam options đã đánh giá (không implement)

| Option | Seam | Verdict |
|---|---|---|
| **R1** | `Mailbox.updatedAt` CAS | **REJECT làm credential seam.** `@updatedAt` bị bump bởi MỌI mailbox write (status flips, delta polling `deltaLastPolledAt`/`lastSuccessfulSyncAt`, mọi rotation, cả write của chính operation). Không credential-specific → capture-then-compare sẽ false-negative liên tục (suppress reconnect hợp lệ). |
| **R2** | `encryptedRefreshToken` value (exact ciphertext trong DB predicate) | **APPROVED — seam chính.** Đúng credential generation operation dùng; token port ĐÃ đọc sẵn value này; string-equality predicate an toàn, không plaintext, không log; không có rủi ro precision/aliasing như timestamp. Encryption non-deterministic KHÔNG ảnh hưởng: ta so exact stored string đã capture, không re-encrypt. |
| **R3** | `Mailbox.tokenLastRefreshedAt` (đổi khi OAuth reconnect + mọi rotation) | **ALTERNATIVE chấp nhận được.** Semantically là "credential generation timestamp", không phải secret, log được. Nhược điểm: port hiện chưa select nó; cần chứng minh exact DateTime equality `timestamp(3)` round-trip (giống rủi ro B3); nullable; hai credential write cùng 1 ms có thể alias. Dùng nếu team không muốn đưa ciphertext vào WHERE predicate. |

**Chốt: R2 làm seam chính, R3 làm phương án dự phòng.** Cả hai KHÔNG cần schema/migration.

### B5d. Giới hạn của guard & quan hệ với deferred credential-rotation race

Guard R2 ngăn hazard "stale renewal mark mailbox vừa reconnect → RECONNECT_REQUIRED"
trong MỌI trường hợp **trừ** một sub-case: Case B khi operation TỰ rotate (A→A') và
OAuth reconnect (B) cùng ghi `encryptedRefreshToken` dưới **last-writer-wins không
version** (A6/D4). Nếu rotation persist A' của operation đáp SAU write B của reconnect,
nó overwrite B bằng A' (stale) — mailbox giữ A', operation capture A', predicate match
→ mark RECONNECT_REQUIRED, VÀ credential B đã bị clobber.

Điểm mấu chốt: sub-case này **chính là deferred credential-rotation race** (A6/D4), KHÔNG
phải một hazard mới do writer này tạo ra. Guard reconnect làm đúng việc của nó (predicate
match đúng cái đang lưu); cái sai là giá trị đang lưu bị hỏng bởi LWW rotation overwrite.
Sửa triệt để sub-case này đòi hỏi credential-rotation CAS redesign (deferred).

**Kết luận blocker (D7):** guard R2 dùng existing field là **ĐỦ** để ngăn hazard
stale-reconnect-undo trong mọi case KHÔNG dính LWW rotation overwrite. Sub-case còn lại
đã được bao bởi decision DEFER hiện có (cùng một LWW write hazard) — **KHÔNG phải mandatory
blocker mới** cho TASK-084, KHÔNG kéo full credential-rotation redesign vào. Phải document
rõ residual bounded này; nếu implementation phát hiện guard R2 không tách được khỏi
credential-rotation CAS (vd không capture được post-rotation generation an toàn) → **STOP,
báo human/ChatGPT** — không tự thêm version column.

### B5e. Tổng hợp thay đổi so với TASK-069C

- Giữ nguyên toàn bộ classification TASK-069C: invalid_grant / interaction_required /
  401 vẫn dẫn reconnect như hiện tại, từ mọi state không phải operator-disabled, khi
  credential generation KHÔNG đổi. KHÔNG suppress reconnect chỉ vì có another live
  GraphSubscription.
- Thêm hai lớp guard: (1) không overwrite DISABLED (operator state); (2) credential-
  generation match (không overwrite mailbox vừa reconnect bằng credential mới).

## B6. Disconnect race — cách kiến trúc đóng

Chuỗi: renewal claimed → operator disconnect → late Graph result.

- Disconnect transaction set row live → EXPIRED ⇒ `@updatedAt` bump ⇒ **CAS của
  claimant mất hiệu lực** → late completion (ACTIVE hoặc FAILED) count = 0 → row
  EXPIRED của disconnect không bao giờ bị stale claimant ghi lại ACTIVE/FAILED.
- Late 404/410 path: bước 1 (CAS mark EXPIRED) count = 0 → dừng, không mailbox
  side effect. Kể cả nếu logic tới được mailbox writer: predicate
  `status = ACTIVE` không match DISABLED.
- Late auth failure: predicate `status != DISABLED` (B5) không match DISABLED.
- Kết quả bắt buộc đạt: DISABLED không trở lại ACTIVE; DISABLED không thành
  SUBSCRIPTION_EXPIRED; DISABLED không bị overwrite RECONNECT_REQUIRED; row
  EXPIRED do disconnect cleanup không bị stale claimant ghi đè.

## B7. Completion writers — tổng hợp

| Path | Điều kiện write (tất cả updateMany + affected-count) | Kết quả |
|---|---|---|
| Renew thành công | `subscriptionId + status=RENEWING + updatedAt=claimTimestamp` | → ACTIVE + expiration + lastRenewedAt |
| Fail (transient hết retry / fatal / token transient) | `subscriptionId + status=RENEWING + updatedAt=claimTimestamp` | → FAILED |
| 404/410 | `subscriptionId + status=RENEWING + updatedAt=claimTimestamp` | → EXPIRED, rồi mailbox writer B4 |
| Mọi path có count = 0 | — | Stale owner: KHÔNG mailbox side effect, report claim-lost, không retry ngay |

`graph-subscription.service.ts` KHÔNG được giữ unconditional update phá CAS
ownership (xem B8).

## B8. Claim placement (approved)

- Claim/state-ownership orchestration nằm ở **renewal runner/service/repository
  layer**.
- `graph-subscription.service.ts` thu về vai trò Graph operation/adapter hẹp
  (PATCH + parse response); bỏ unconditional RENEWING/FAILED/ACTIVE writer hiện có
  trong `renewGraphSubscription` khỏi đường renewal — persistence chuyển về repo
  layer có CAS. Caller duy nhất của `renewGraphSubscription` là renewal runner nên
  blast radius refactor gọn.
- Refactor tối thiểu, tránh hai nơi cùng sở hữu state transition. Không unrelated
  refactor.

## B9. Stale reclaim (approved)

- Stale cutoff: **30 phút**, code-level constant (2× interval mặc định). KHÔNG thêm
  env config.
- Fresh RENEWING: skip, không Graph call.
- Stale RENEWING: reclaim được qua atomic claim; reclaim tạo generation mới qua
  `updatedAt`; previous claimant thành stale owner (mọi completion của nó count 0).
- Không retry loop tức thời — backstop là tick sau.
- Trong lúc chờ reclaim, webhook gate vẫn nhận RENEWING nên relay không gián đoạn.

## B10. Observability (approved minimal)

- Thêm tối đa `claimLostCount` và `staleReclaimedCount` vào
  `SubscriptionRenewalRunResult` / run summary log hiện có.
- KHÔNG dashboard mới, KHÔNG Redis metrics, KHÔNG env, KHÔNG alert redesign.
- Nếu counters làm mở scope đáng kể trong implementation → defer counters, giữ
  safety.

## B11. Schema / lock / infra — locked expectation

- No schema/migration; no Redis lock; no distributed lock; no new worker; no new
  scheduler; no queue; không đụng file env cục bộ; no GitHub Actions.
- `GraphSubscription.updatedAt` có sẵn là CAS candidate duy nhất. Nếu
  implementation không dùng nó safely được (B3) → **STOP**.

## B12. Failure semantics của guard

| Tình huống | Hành vi |
|---|---|
| Claim thua (count 0) | Skip subscription tick này; không token refresh, không PATCH; tick sau re-evaluate. Fail-closed per-subscription — chấp nhận vì window renew 24h / interval 15' (~96 cơ hội) + delta polling backup |
| DB unavailable | Renewal vốn không list/persist được — không đổi hành vi hiện tại |
| Redis unavailable | Không liên quan (không dùng Redis) |
| Process chết sau claim | Row kẹt RENEWING → reclaim sau 30' qua stale cutoff; webhook vẫn nhận RENEWING trong lúc chờ |
| Stale reclaim rồi old claimant quay lại | Mọi completion của old claimant count 0 (CAS); không side effect |
| Token timeout / transient (TASK-069C giữ nguyên) | CAS completion → FAILED; tick sau retry |
| Graph 429/5xx | Transient retry bounded trong tick (không đổi); hết retry → CAS FAILED |
| Graph 401 (current credential) | reconnect_required (không đổi); mailbox mark theo B5b — `status != DISABLED` AND credential generation match → count 1 mark |
| Graph 401 SAU OAuth reconnect đồng thời | credential generation đổi → B5b count 0 → KHÔNG mark; mailbox vừa reconnect giữ ACTIVE |
| Graph 403 | Transient theo TASK-071 — không đổi semantics |
| Graph 404/410 — còn claim | STEP 1 CAS mark EXPIRED count 1 → STEP 2 mailbox writer relation-aware B4 |
| Graph 404/410 — mất claim | STEP 1 CAS count 0 (hoặc throw) → DỪNG, KHÔNG mailbox side effect (correction A) |
| Token reconnect_required (Case A) SAU OAuth reconnect đồng thời | credential generation đổi → B5b count 0 → KHÔNG mark |
| Local persist fail sau PATCH thành công | Row còn RENEWING (generation của mình) → stale reclaim sau cutoff; remote đã gia hạn nên không mất webhook |
| Cleanup/mark failure | Giữ `safely()` best-effort; count-0 phân biệt với write error khi log |

## B13. Claim ownership vs credential ownership (correction B — locked)

Task file phải phân biệt tường minh hai loại ownership, KHÔNG conflate:

| | **GraphSubscription claim ownership** | **Mailbox credential-generation ownership** |
|---|---|---|
| Seam | `GraphSubscription.updatedAt` = `claimTimestamp` (B3) | `Mailbox.encryptedRefreshToken` value = captured (B5b, R2) |
| Chứng minh | operation vẫn sở hữu subscription row | credential mà operation dùng vẫn là credential hiện hành của mailbox |
| Gate cho | mọi subscription-level completion + mọi mailbox lifecycle side effect (correction A) | RECONNECT_REQUIRED write cụ thể (credential/auth-level) |
| KHÔNG chứng minh | credential còn hiện hành sau OAuth reconnect đồng thời | operation còn sở hữu subscription row |

Hệ quả: một RECONNECT_REQUIRED write phải thỏa **cả hai** về mặt khái niệm —
subscription CAS (nếu side effect bắt nguồn từ claimed subscription failure ở Case B)
**và** credential-generation match. CAS trên `GraphSubscription.updatedAt` giải quyết
stale renewal ownership của subscription row; nó KHÔNG tự động chứng minh credential
mailbox còn hiện hành sau một OAuth reconnect đồng thời. Đó là lý do RECONNECT_REQUIRED
cần guard credential-generation RIÊNG (B5b), không thể tái dùng subscription CAS.

---

# PHẦN C — SCOPE, TESTS, ACCEPTANCE, DECISIONS

## C1. Scope implementation đề xuất (phase 2, sau khi design này được duyệt)

- `subscription-renewal-runner.ts` (repo layer): candidate query loại RENEWING tươi;
  method claim CAS mới; completion writers CAS; `markMailboxSubscriptionExpired`
  relation-aware **gate sau STEP 1 CAS count = 1** (B4, correction A);
  `markMailboxReconnectRequired` conditional `status != DISABLED` **AND credential-
  generation match** (B5b, correction B); token port trả thêm captured credential
  generation (A11/B5b) — không schema.
- `subscription-renewal.service.ts`: claim trước renew, skip khi thua; truyền
  claimTimestamp + capturedCredentialGeneration qua context; STEP 1→STEP 2 ordering
  với count-branch (correction A); counters B10.
- `graph-subscription.service.ts`: thu `renewGraphSubscription` về adapter hẹp (B8).
- Focused tests cho `updatedAt` CAS safety (B3), credential-generation seam (B5b),
  correction A/B (R1–R7) + test matrix C3.

## C2. Scope KHÔNG làm

- Không schema/migration, không version column mới.
- Không Redis wiring mới, không distributed lock, không đổi TASK-068A.
- Không worker/scheduler/queue mới; không đổi interval/env semantics.
- Không đổi classification TASK-069C / 403 semantics TASK-071/075.
- Không redesign TASK-083 recovery, OAuth, credential storage, webhook.
- Không sửa credential rotation race đa-worker (DEFERRED — A6/D4).
- Không đụng file env cục bộ, không đổi GitHub Actions, không unrelated refactor.

## C3. Test matrix (implementation phase)

### Claim

1. ACTIVE claim success (count 1, status RENEWING, updatedAt = claimTimestamp).
2. FAILED claim success.
3. Hai worker claim cùng row → đúng một winner (count 1 + count 0).
4. Fresh RENEWING → không claim, không Graph call.
5. Stale RENEWING (updatedAt < cutoff) → reclaim success.

### Claim ownership (CAS)

6. Worker A claim thành công, giữ claimTimestampA.
7. Worker B stale-reclaim → generation đổi (updatedAt = claimTimestampB).
8. Worker A completion (ACTIVE hoặc FAILED) → count 0.
9. Worker B completion → success.
10. Stale A count 0 → KHÔNG mailbox side effect nào được apply.

### Successful renewal

11. Current owner → ACTIVE + expiration mới + lastRenewedAt.
12. Stale owner không overwrite ACTIVE mới hơn (expiration/lastRenewedAt giữ nguyên).

### TASK-083 interaction

13. Old subscription A fails (404/410) khi...
14. ...replacement subscription B ACTIVE còn hạn tồn tại →
15. mailbox remains ACTIVE (relation predicate không match).
16. Không có replacement subscription nào possibly-live →
17. old subscription failure được conditionally set SUBSCRIPTION_EXPIRED (count 1).

### Disconnect

18. Disconnect sau khi claim → mọi late completion count 0.
19. Old success completion không reactivate được local subscription (row EXPIRED
    giữ nguyên).
20. Old failure không overwrite DISABLED (cả SUBSCRIPTION_EXPIRED lẫn
    RECONNECT_REQUIRED path).

### Correction A — mailbox side-effect ownership (CAS gate)

R1. Lost claim: Worker A mất claim vào tay B; A nhận expired/not-found; STEP 1 CAS
    completion của A count = 0 → A **MUST NOT** update Mailbox (không SUBSCRIPTION_EXPIRED,
    không RECONNECT_REQUIRED); claimLostCount tăng.
R2. CAS DB failure: STEP 1 subscription completion CAS **throws** → mailbox lifecycle
    writer (STEP 2) **MUST NOT** được gọi; không giả định ownership; không retry loop.
R3. Còn claim: STEP 1 count = 1 → STEP 2 mailbox writer relation-aware được evaluate.

### Reconnect required

21. Lỗi reconnect-required thật theo TASK-069C (KHÔNG có credential-generation change)
    giữ nguyên classification và vẫn mark được mailbox (từ state không phải DISABLED);
    credential seam match → count 1.
22. Không overwrite DISABLED.
23. Một GraphSubscription khác còn live KHÔNG suppress mailbox-level credential
    failure (mailbox vẫn được mark RECONNECT_REQUIRED).

### Correction B — concurrent OAuth reconnect (credential-generation guard)

R4. Case A (token failure) SAU concurrent OAuth reconnect: renewal start với credential
    generation A; OAuth reconnect persist generation B (mailbox ACTIVE); stale renewal A
    báo reconnect-required; conditional writer (credential seam) **MUST NOT** overwrite
    ACTIVE của generation B → count 0.
R5. Case B (Graph 401) SAU concurrent OAuth reconnect: token refresh của A thành công
    trước, Graph PATCH sau trả 401; capture/verify đúng credential generation
    (post-rotation của A); reconnect B đáp sau acquisition làm stale renewal side-effect
    vô hiệu → count 0, mailbox giữ ACTIVE.
R6. Credential seam capture cho Case A: null-credential / decrypt-fail / invalid_grant —
    mỗi nguồn capture đúng giá trị đọc; reconnect đổi seam → count 0.
R7. Genuine auth failure, KHÔNG có concurrent credential-generation change → TASK-069C
    reconnect-required vẫn hoạt động (count 1, mark).

### Stale reclaim

24. Cutoff boundary (ngay dưới/ngay trên 30 phút).
25. Reclaim đổi CAS generation.
26. Không immediate/unbounded retry sau khi thua claim hoặc mất ownership.

### `updatedAt` CAS safety (focused, B3)

- Round-trip exact-equality: set tường minh → đọc lại → match trong where.
- Precision: giá trị ms qua Prisma/PostgreSQL `timestamp(3)` không lệch.

### Regression

27. Normal single-replica renewal vẫn hoạt động end-to-end.
28. TASK-083 recovery tests giữ PASS.
29. TASK-082 reconciliation tests giữ PASS.
30. TASK-069C classification tests giữ PASS.

## C4. Acceptance criteria (implementation không được bắt đầu trước khi design chứng minh đủ)

1. Chỉ MỘT current claim owner persist được completion cho một subscription tại một
   thời điểm (CAS chứng minh bằng tests 3, 8, 9).
2. Stale owner không persist được gì sau reclaim — subscription-level lẫn
   mailbox-level (tests 8, 10, 12).
3. **(correction A) Lost GraphSubscription claim → ZERO mailbox lifecycle effects**
   (STEP 1 CAS count 0 → không SUBSCRIPTION_EXPIRED, không RECONNECT_REQUIRED) — test R1.
4. **(correction A) Subscription completion CAS DB failure → ZERO mailbox lifecycle
   effects** (STEP 2 writer không được gọi) — test R2.
5. Old subscription failure không expire được mailbox đang được replacement
   subscription bảo vệ (tests 13–15); và vẫn expire đúng khi không có replacement
   (tests 16–17).
6. Disconnect state không bị overwrite dưới mọi late-writer path (tests 18–20).
7. **(correction B) Stale pre-reconnect renewal KHÔNG mark được mailbox vừa reconnect
   → RECONNECT_REQUIRED** (credential-generation guard) cho cả Case A và Case B
   (tests R4, R5, R6).
8. **(correction B) Genuine current-credential auth failure vẫn dùng TASK-069C
   semantics** (không có concurrent credential change → vẫn mark) — test R7; chỉ thêm
   bảo vệ DISABLED (test 22) và không suppress vì another-live-subscription (test 23).
9. Không cần Redis/schema/migration: `GraphSubscription.updatedAt` CAS (B3) +
   `Mailbox.encryptedRefreshToken` credential seam (B5b/R2) đều là field có sẵn.
   Nếu `updatedAt` CAS fail HOẶC credential seam không tách được khỏi credential-
   rotation CAS → STOP báo human/ChatGPT, không tự thêm cột.
10. Broader multi-worker credential rotation race vẫn documented/DEFERRED (A6/D4),
    không bị sửa lẫn vào; residual bounded của reconnect guard (B5d) là cùng deferred
    item, KHÔNG phải mandatory blocker mới.
11. `npm run verify` PASS.

## C5. Decisions (đã chốt sau Antigravity review)

| # | Decision | Trạng thái |
|---|---|---|
| D1 | Option A | **APPROVED WITH MODIFICATION**: atomic claim + CAS ownership (updatedAt generation) + relation-aware subscription-expired writer |
| D2 | Stale cutoff | **APPROVED** = 30 phút, code-level constant, không env |
| D3 | Claim placement | **APPROVED** = renewal runner/service/repo layer; graph-subscription.service thu về adapter hẹp |
| D4 | Credential rotation race | **APPROVED DEFER** — backlog follow-up sau TASK-084; nếu hóa ra là mandatory blocker cho claim safety → STOP báo human/ChatGPT |
| D5 | Counters | **APPROVED optional/minimal**: chỉ claimLostCount + staleReclaimedCount trong run result hiện có; defer nếu phình scope |
| D6 | RECONNECT_REQUIRED | Giữ mailbox-level TASK-069C semantics; KHÔNG dùng other-live-subscription guard để suppress reconnect. **UPDATED (correction B):** conditional writer = `status != DISABLED` (operator state) **AND credential-generation match** (`encryptedRefreshToken` = captured, R2) để không overwrite mailbox vừa OAuth-reconnect |
| D7 | Correction A — mailbox side-effect ownership | **LOCKED:** mọi mailbox lifecycle write phải gate sau subscription CAS count = 1; CAS count 0 / throw → ZERO mailbox side effect |
| D8 | Correction B — credential-generation seam | **APPROVED:** R2 (`encryptedRefreshToken` value) làm seam chính, R3 (`tokenLastRefreshedAt`) alternative; R1 (`updatedAt`) rejected. Existing field ĐỦ; NOT mandatory blocker — residual sub-case (LWW rotation overwrite) = cùng deferred D4. Nếu không tách được khỏi credential-rotation CAS → STOP |

## C6. Security notes

- Task file không chứa credential/token/secret/URL hạ tầng/clientState/code thật.
- Không đọc/in file env cục bộ trong quá trình investigation/correction.
- Không nêu tên nhánh Git đầy đủ trong tài liệu (tránh secret-scan false positive).

---

# PHẦN D — IMPLEMENTATION PHASE (đã thực hiện, `npm run verify` PASS)

Phần này ghi lại implementation thực tế của kiến trúc PHẦN B. History PHẦN A/B/C được
giữ nguyên (không viết lại). Không secret/ciphertext thật trong tài liệu.

## D1. Files đã đổi

| File | Vai trò thay đổi |
|---|---|
| `services/microsoft/subscription-renewal.service.ts` | Interface repo mới (claim + CAS completion + conditional mailbox writers); token port trả `RenewalCredential { accessToken, credentialGeneration }`; `SubscriptionRenewalTokenError` mang `credentialGeneration`; orchestration: claim TRƯỚC token, STEP1 đến STEP2 ordering với count-branch, outcome `claim_lost`, counters `claimLostCount`/`staleReclaimedCount` |
| `services/queue/workers/subscription-renewal-runner.ts` | Repo adapter: candidate query loại fresh RENEWING (OR stale-cutoff); `claimForRenewal` (2 bước atomic + read-back generation); CAS completion `updateMany`+count; relation-aware `markMailboxSubscriptionExpiredIfNoOtherLiveSubscription`; credential-guard `markMailboxReconnectRequiredIfCredentialCurrent`; tách helper `acquireRenewalCredential`; giữ port string `createPrismaRenewalAccessTokenPort` (reconciliation reuse) + thêm `createPrismaRenewalAccessTokenPortWithGeneration`; constant `STALE_CLAIM_CUTOFF_MS` = 30 phút |
| `services/microsoft/graph-subscription.service.ts` | `renewGraphSubscription` thu về THIN PATCH adapter: chỉ PATCH + parse expiration, KHÔNG DB write (bỏ RENEWING/FAILED/ACTIVE unconditional). Trả `{ subscriptionId, expirationDateTime }` |
| `services/microsoft/refresh-token-rotation.service.ts` | `persistRotatedRefreshToken` trả thêm `encryptedRefreshToken?` (ciphertext đã ghi) để token port capture post-rotation generation Case B. Backward-compatible (field optional) |
| `tests/unit/microsoft/subscription-renewal.service.test.ts` | Fakes theo interface CAS; thêm test claim-lost, CAS count=0 / throw zero mailbox effect, relation-aware, Case A/B credential guard, counters |
| `tests/unit/queue/subscription-renewal-runner.test.ts` | Token port string + WithGeneration; repo: candidate query shape, claim 2 bước + read-back + disconnect-race, CAS where-clauses, relation predicate, credential predicate (kể cả IS NULL) |
| `tests/unit/microsoft/graph-subscription.service.test.ts` | `renewGraphSubscription` PATCH-only (không DB write) |
| `tests/unit/microsoft/refresh-token-rotation.service.test.ts` | Assert field ciphertext mới |

## D2. Cách atomic claim + CAS hoạt động (đơn giản)

> **Correction (ChatGPT HIGH finding, đã sửa):** bản implement đầu tiên dùng
> "updateMany → read-back updatedAt → adopt giá trị đọc lại làm token". Đó là SAI so với
> B2/B3 và tạo lỗ hổng hijack: worker A claim rồi stall; worker B stale-reclaim (ghi
> generation B); A tỉnh dậy read-back thấy generation B lúc row vẫn RENEWING → A adopt B →
> A completion khớp generation B → hijack row của B. Đã sửa sang locked pattern bên dưới.

- **Mint generation trước**: worker tự tạo `claimTimestamp = new Date(now)` của CHÍNH NÓ
  TRƯỚC khi claim.
- **Claim ghi tường minh**: một câu `updateMany` có điều kiện (ACTIVE/FAILED; hoặc RENEWING
  cũ hơn 30 phút) với `data: { status: RENEWING, updatedAt: claimTimestamp }` — set tường
  minh `updatedAt` (Prisma dùng giá trị bạn cung cấp cho cột `@updatedAt` khi field có mặt
  trong `data`; đã xác nhận field `updatedAt` nằm trong `GraphSubscriptionUncheckedUpdateManyInput`
  của generated client). DB đảm bảo chỉ MỘT worker thắng (affected count = 1); loser count = 0
  bỏ qua (không token, không gọi Microsoft, không ghi gì).
- **Ownership token = chính `claimTimestamp` đó**, giữ local. Mọi completion đòi
  `status = RENEWING AND updatedAt = claimTimestamp`; không khớp → count = 0 → không ghi đè.
- **Read-back CHỈ để VERIFY** round-trip (không phải nguồn của token): đọc lại `updatedAt`
  và so exact `=== claimTimestamp`. Nếu lệch (Prisma/PostgreSQL không round-trip đúng, HOẶC
  một write khác — disconnect / stale-reclaimer — chen vào), HOẶC status không còn RENEWING
  → **fail-closed: coi như claim lost**, không token/PATCH/mailbox side-effect. Token trả về
  LUÔN là `claimTimestamp` của chính operation, KHÔNG BAO GIỜ là giá trị read-back →
  loại hoàn toàn khả năng adopt generation của worker khác.
- `timestamp(3)` (ms) khớp chính xác JS `Date` (ms) nên round-trip không lệch. Không cần
  thêm cột schema nên KHÔNG chạm STOP condition #1.

## D3. Stale reclaim

Nếu worker A giữ RENEWING rồi chết/treo quá 30 phút, `claimTimestamp` của A (đã ghi tường
minh vào `updatedAt`) trở nên "cũ". Worker B ở tick sau giành lại (câu `updateMany` bước 2)
và ghi `claimTimestamp` của CHÍNH B vào `updatedAt`, nên vé của A hết hiệu lực. Nếu A hồi
sinh và cố ghi hoàn tất, điều kiện `updatedAt = claimTimestampA` khớp 0 dòng nên A không ghi
đè B, không gây side-effect mailbox. Quan trọng: A giữ `claimTimestampA` local nên dù A có
read-back thấy generation của B, A cũng KHÔNG adopt (verify mismatch → claim-lost).
`staleReclaimedCount` đếm số lần reclaim.

## D4. TASK-083 replacement guard

Nhánh 404/410 (subscription mất trên Microsoft): STEP 1 CAS mark EXPIRED. CHỈ khi count = 1
mới chạy STEP 2 — một câu `updateMany` mailbox có relation-predicate: chuyển
ACTIVE sang SUBSCRIPTION_EXPIRED **chỉ khi không còn GraphSubscription KHÁC possibly-live**
(`status in ACTIVE/RENEWING/FAILED AND expirationDateTime > now`, loại chính row đang lỗi
qua `id != failingRowId`). Nếu recovery TASK-083 đã tạo subscription B còn sống thì predicate
không khớp nên mailbox giữ ACTIVE. Dùng đúng `BLOCKING_SUBSCRIPTION_STATUSES` (source-of-truth
TASK-081/082) — không phát minh definition thứ hai. Prisma express được bằng `updateMany`
với `graphSubscriptions: { none: {...} }` nên KHÔNG cần transaction, KHÔNG chạm STOP #2.

## D5. Disconnect guard

Disconnect ghi row live sang EXPIRED (đổi `updatedAt`) nên vé CAS của claimant cũ hết hiệu
lực, mọi completion muộn (ACTIVE/FAILED/EXPIRED) count = 0. Ngoài ra read-back lúc claim
kiểm tra status: nếu disconnect chen vào giữa claim và read-back, status không còn RENEWING
nên coi như claim thất bại. Mailbox DISABLED được bảo vệ thêm: writer expired đòi
`status = ACTIVE`, writer reconnect đòi `status != DISABLED`. Kết quả: DISABLED không bị
kéo về SUBSCRIPTION_EXPIRED/RECONNECT_REQUIRED, row EXPIRED không bị hồi sinh.

## D6. Credential-generation guard Case A/B (correction B)

Token port (bản WithGeneration) báo về "credential generation" = giá trị opaque
`encryptedRefreshToken` mà operation dùng:

- **Case A** (reconnect trước khi đổi token thành công — thiếu token / decrypt fail /
  invalid_grant / interaction_required): generation = giá trị đọc lúc bắt đầu, mang trong
  `SubscriptionRenewalTokenError.credentialGeneration`. Thiếu token thì generation = null.
- **Case B** (Graph 401 SAU khi lấy token; operation có thể đã tự rotate A sang A′):
  generation = giá trị post-rotation (`persistRotatedRefreshToken` trả ciphertext đã ghi;
  không rotate thì bằng giá trị đọc ban đầu).

Writer reconnect: `updateMany where { id, status != DISABLED, encryptedRefreshToken = gen }`.
Prisma `equals: null` biên dịch thành `IS NULL` nên Case A "thiếu token" khớp đúng. Nếu OAuth
reconnect đồng thời đã ghi credential mới thì predicate lệch, count 0, mailbox vừa reconnect
giữ ACTIVE. Correction A vẫn áp: writer này CHỈ chạy sau STEP 1 CAS FAILED count = 1; mất
claim hoặc CAS throw thì không đụng mailbox kể cả credential khớp. Giá trị credential là
opaque marker — KHÔNG log/in/decrypt-để-log, KHÔNG đưa ciphertext thật vào tài liệu.

## D7. Genuine TASK-069C regression

Khi KHÔNG có thay đổi credential đồng thời: invalid_grant / interaction_required / Graph 401
vẫn phân loại reconnect_required như TASK-069C, generation khớp nên writer count = 1, mailbox
sang RECONNECT_REQUIRED. 403 vẫn transient (TASK-071). Không đổi classification. Test R7 +
suite 069C/071 giữ PASS.

## D8. Tests đã thêm/cập nhật (nhóm ↔ invariant)

- **Atomic claim (mint-then-verify)**: fresh ACTIVE/FAILED win (count 1, 1 câu updateMany,
  data có `updatedAt = claimTimestamp` tường minh); stale reclaim (bước 2, ghi generation
  của chính nó, reclaimedStale); lost (count 0); disconnect-race read-back status khác
  RENEWING nên lost. **HIJACK GUARD**: read-back thấy generation của stale-reclaimer B (khác
  claimTimestamp của A) → A coi là claim-lost, KHÔNG adopt B. **Fail-closed round-trip**:
  read-back lệch 1 ms so với claimTimestamp → claim-lost. (runner test)
- **CAS completion**: where `{status:RENEWING, updatedAt:gen}` + data cho ACTIVE/FAILED/
  EXPIRED; count 0 nên owned=false. (runner test)
- **Correction A**: lost claim nên zero mailbox writer; CAS throw nên zero mailbox writer.
  (service test)
- **TASK-083 replacement**: relation predicate shape + exclude failing row; predicate miss
  nên mailbox giữ ACTIVE; không replacement nên EXPIRED. (runner + service test)
- **Credential guard Case A/B**: generation từ token error (A) / post-rotation (B); IS NULL;
  predicate miss (concurrent reconnect) nên mailbox không đổi; lost claim chặn writer.
  (runner + service test)
- **Genuine 069C**: reconnect thật vẫn mark. **Counters**: claimLost/staleReclaimed.
- **Regression**: reconciliation (reuse token port) + graph-subscription + rotation +
  069C/071/082/083 giữ PASS. Toàn suite **1236 tests PASS**.

## D9. Verify

`npm run verify` = `db:generate && lint && typecheck && test && build` nên **PASS** (exit 0).
`git diff --check` sạch (chỉ cảnh báo CRLF vô hại của Windows working tree).

## D10. STOP conditions — không cái nào xảy ra

`updatedAt` dùng được làm CAS qua read-back (không cần schema); relation predicate express
được bằng `updateMany`; Case B capture được post-rotation generation qua ciphertext helper
(không cần credential-rotation redesign); không cần schema/migration/version column/Redis/
distributed lock; không đổi classification TASK-069C; không đổi kiến trúc TASK-082/083;
source thực tế khớp locked architecture; không cần đọc file env.

## D11. Remaining / deferred risk

Broader multi-worker credential-rotation last-writer-wins race (renewal / delta polling /
email worker / reconciliation cùng ghi `encryptedRefreshToken` không version) vẫn
**DEFERRED** (A6 / D4). Residual bounded của reconnect guard (B5d): sub-case operation tự
rotate A sang A′ đồng thời OAuth reconnect ghi B dưới LWW — là CÙNG deferred item, không
phải blocker mới; guard credential-generation đóng mọi case còn lại. Không sửa lẫn trong
TASK-084.
