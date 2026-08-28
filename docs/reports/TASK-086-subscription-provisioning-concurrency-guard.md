# TASK-086 — Graph Subscription Provisioning Concurrency Guard (Implementation Report)

> **PHASE 2 — IMPLEMENTATION.** Antigravity Architecture Re-review đã kết luận
> *PASS — TASK-086 FINAL ARCHITECTURE APPROVED FOR PHASE 2 IMPLEMENTATION*.
> **Antigravity Implementation Review CHƯA diễn ra.** Không commit, không push, không ROADMAP,
> không `.env*`, không GitHub Actions, không UI.
>
> Sanitized: không token/refresh token/client secret/Telegram bot token/credential ciphertext thật/
> encryption-session secret/verification code/full email body/DB-Redis URL.
>
> Architecture đầy đủ: `docs/tasks/TASK-086-subscription-provisioning-concurrency-guard.md`.

---

## 1. Chronology

```text
Initial investigation → Antigravity Architecture Review BLOCKED
→ Human/ChatGPT D1–D8 → corrected architecture
→ Human/ChatGPT O1–O4 → final corrected architecture
→ Antigravity Final Architecture Re-review PASS
→ Phase 2 implementation (bản này)
→ awaiting Antigravity Implementation Review
```

## 2. Precheck

Branch đúng branch TASK-086; HEAD `b67ab86` (TASK-085 hoàn tất); `git diff --stat` rỗng; working tree
chỉ có 2 docs TASK-086 untracked từ Phase 1; không có tracked change ngoài scope.

## 3. Invariant đã implement

```text
AT MOST ONE LOCAL LIVE GraphSubscription PER MAILBOX
live = ACTIVE | RENEWING | FAILED
UNIQUE(mailboxId) WHERE status IN ('ACTIVE','RENEWING','FAILED')
```

Serialization point duy nhất là **local DB unique index**. Không Redis, không long transaction/advisory
lock, không placeholder row. Code đúng cả khi hai POST đồng thời đều nhận 201; Microsoft 409 chỉ là
defensive handling.

## 4. Files changed

**Runtime**

- `services/microsoft/subscription-claim-window.ts` *(mới)* — `STALE_CLAIM_CUTOFF_MS` (30 phút) +
  `computeStaleClaimCutoff`, leaf module dùng chung.
- `services/queue/workers/subscription-renewal-runner.ts` — chỉ đổi **nguồn** hằng stale cutoff sang
  module dùng chung (giá trị + logic TASK-084 không đổi).
- `services/microsoft/graph-subscription.service.ts` — kind `conflict` (409) và `ownership_conflict`;
  export `GRAPH_SUBSCRIPTION_LIVE_UNIQUE_INDEX`; tách unique conflict khỏi generic DB failure.
- `services/microsoft/mailbox-subscription-provisioning.service.ts` — STEP A normalization, fresh/stale
  RENEWING, STEP B blocking không còn điều kiện thời gian, phân loại conflict.
- `services/microsoft/subscription-reconciliation.service.ts` — plumbing outcome mới
  (`blocked_renewing` + counter); dry-run/apply/bounded/sequential không đổi.

**Schema / migration**

- `prisma/migrations/20260829000000_task086_one_live_graph_subscription/migration.sql` *(mới)*.
- `prisma/schema.prisma` — **chỉ comment** (ghi chú drift + ghi chú `updatedAt` là claim generation).
  Không đổi model/field nào.

**Tests**

- *(mới)* `tests/unit/microsoft/mailbox-subscription-provisioning.concurrency.test.ts`
- *(mới)* `tests/unit/microsoft/graph-subscription.live-slot-conflict.test.ts`
- *(sửa)* `tests/unit/microsoft/mailbox-subscription-provisioning.service.test.ts`
- *(sửa)* `tests/unit/microsoft/subscription-reconciliation.service.test.ts`
- *(sửa)* `tests/unit/microsoft/subscription-reconciliation.recovery.test.ts`
- *(sửa)* `tests/api/microsoft-oauth-callback.route.test.ts`

**Docs**: 2 file TASK-086 (task + report này).

## 5. Expired-state normalization (Area A)

`capturedNow` → `findMany` live rows theo status → normalize → (fresh RENEWING ⇒ dừng) → re-read →
còn live row ⇒ block → sạch ⇒ POST.

- ACTIVE/FAILED: `updateMany where { id, status: <status đã đọc>, expirationDateTime: { lte: capturedNow } }`,
  `data { status: 'EXPIRED' }`.
- Renewal claim thắng trước ⇒ `status` không còn khớp ⇒ affected count 0.
- Normalization thắng trước ⇒ row EXPIRED ⇒ claim TASK-084 (`status IN (ACTIVE, FAILED)`) không khớp.
- **Không câu lệnh nào chạm bảng `Mailbox`** (có test riêng chứng minh).

## 6. Fresh/stale RENEWING (Area B)

Dùng lại đúng hằng 30 phút của TASK-084 qua module chung (không tạo constant thứ hai).

- Fresh (`updatedAt >= staleCutoff`): trả `blocked_renewing` — không write, không Graph POST, không
  insert, không retry; connect vẫn fail-open.
- Stale (`updatedAt < staleCutoff`): `updateMany where { id, status: 'RENEWING', expirationDateTime:
  { lte: capturedNow }, updatedAt: { lt: staleCutoff } }`. Nếu TASK-084 stale-reclaim bump `updatedAt`
  trước ⇒ count 0. Nếu normalization thắng ⇒ completion CAS cũ (`status='RENEWING' AND
  updatedAt=claimGeneration`) không thể khớp ⇒ không resurrect.

## 7. Partial unique index (Area D)

```text
CREATE UNIQUE INDEX IF NOT EXISTS "GraphSubscription_mailboxId_live_unique"
  ON "GraphSubscription" ("mailboxId")
  WHERE "status" IN ('ACTIVE', 'RENEWING', 'FAILED');
```

Raw SQL theo precedent TASK-068A; additive, idempotent, không backfill. Index **cố ý** không có trong
`schema.prisma` (Prisma 5.22.0 không biểu diễn được partial unique index), kèm ghi chú drift cho
maintainer tại model `GraphSubscription`.

## 8. M2 fail-closed

Migration **không** dedup, **không** chọn winner, **không** mark loser EXPIRED, **không** đổi lifecycle.
Nếu còn duplicate live rows, `prisma migrate deploy` **fail rõ ràng** và deployment dừng. Comment
migration chứa:

- **preflight read-only**: group theo `mailboxId`, lọc status live, `HAVING COUNT(*) > 1`;
- **verify sau deploy**: đọc `pg_indexes` tìm đúng tên index.

Cả hai chỉ đọc, không sửa dữ liệu, không chứa secret/connection URL. Không tạo remediation tool.

## 9. Local unique ownership / P2002 (Area E)

`createInboxSubscription` dùng `lib/db/prisma-error.ts`:

- P2002 + `meta.target` chứa tên index live-slot ⇒ **ownership loss**: log info sanitized →
  compensating DELETE **đúng subscription của chính mình, đúng một lần** → throw kind
  `ownership_conflict`.
- P2002 trên `subscriptionId`, hoặc bất kỳ lỗi nào khác ⇒ **generic**: giữ nguyên kind `database`.

Ensure bắt `ownership_conflict` → re-read live rows theo `mailboxId` → `lost_ownership` (có winner) hoặc
`conflict_unowned` (không có). Không retry Graph create. **Không có cleanup nào theo `mailboxId`** trong
toàn bộ create/cleanup path.

Hành vi Prisma thật được chứng minh bằng test dùng `Prisma.PrismaClientKnownRequestError` từ client đã
generate (không phải object giả).

## 10. Microsoft 409 (Area 10)

`mapHttpStatusToError`: 409 → kind `conflict`. Ensure re-read:

- có local live winner ⇒ `conflict_existing`;
- không có ⇒ `conflict_unowned` với `source: 'remote_conflict'` — không fabricate row, không flip
  mailbox, không blind retry. Orphan remediation vẫn out of scope.

Test xác nhận 409 **không** kích hoạt DELETE (không có subscription nào được tạo để bù).

## 11. Generic DB failure

Remote create thành công + persist lỗi **không phải** unique conflict ⇒ giữ nguyên TASK-081: một
compensating DELETE của chính mình, ensure trả `failed` (fail-open). Không map mọi DB error thành
ownership loss; không log raw Prisma error (test khẳng định chuỗi lỗi gốc không xuất hiện trong log).

## 12. Compatibility

| Task | Kết quả |
|---|---|
| **081** | Fail-open giữ nguyên: mọi nhánh (blocked/409/unique conflict/create fail/cleanup fail) là outcome, không exception; callback không rollback. Test TASK-081 vẫn xanh sau khi cập nhật fake prisma theo surface mới |
| **082** | Dry-run vẫn **strictly non-mutating** — dry-run không gọi ensure nên normalization **không thể** write (có test riêng khẳng định). Apply vẫn bounded + sequential; CLI semantics không đổi; chỉ thêm counter `blockedRenewingCount` |
| **083** | Recovery chỉ flip khi ensure trả `created`. `blocked_renewing`, `lost_ownership`, `conflict_existing`, `conflict_unowned` **không bao giờ** flip và **không** cleanup winner. Fix High của TASK-083 giữ nguyên |
| **084** | Claim/CAS/stale reclaim/candidate query/relation writer không đổi; chỉ đổi nguồn hằng stale cutoff. Có test cho 4 chiều race (claim thắng/normalization thắng/stale reclaim thắng/late completion count 0) |
| **085** | Không dùng credential field làm ownership marker; không chạm `refresh-token-rotation.service.ts`. Regression suite TASK-085 vẫn xanh |

## 13. Test matrix đã implement

Unique ownership: hai POST đều 201 → chỉ một live row; loser nhận unique conflict; loser chỉ cleanup
subscription của chính nó; winner không bị đụng; cleanup fail vẫn fail-safe; khác mailbox có live row
riêng; nhiều EXPIRED cùng mailbox hợp lệ.

Normalization: ACTIVE/FAILED/stale-RENEWING expired → conditional EXPIRED (assert đúng predicate);
fresh RENEWING → block + Graph create spy = 0; renewal claim thắng trước → count 0; normalization
thắng → claim/completion không khớp; stale reclaim thắng → normalization thua; còn live row → create
spy = 0; sạch → create đúng một lần; live-row read không có predicate thời gian.

409: 201 + 409; 409 + winner; 409 + không winner; không fabricate; không retry.

DB failure: P2002 live-slot → ownership path; P2002 `subscriptionId` và lỗi khác → generic; helper nhận
diện Prisma error thật.

Regressions: TASK-081 fail-open (gồm timeout/cancellation), OAuth reconnect không rollback, TASK-082
dry-run non-mutating, TASK-083 recovery safety, TASK-084 CAS, TASK-085 credential CAS, disconnect
concurrent, sanitization.

## 14. Security / sanitization

Không đọc/sửa `.env*`; không log access token, refresh token, client secret, bot token, ciphertext,
verification code, email body, DB/Redis URL; không log clientState plaintext; không log raw Prisma
error. Migration không chứa secret/connection URL. Không sửa secret scan của CI.

## 15. Verification

| Lệnh | Kết quả |
|---|---|
| `npm run verify` | **PASS — exit code 0** |
| Test | **104 test files / 1281 tests passed** (trước TASK-086: 102 files / 1244 tests) |
| Lint | PASS |
| Typecheck | PASS |
| Build | PASS (`✓ Compiled successfully`) |
| `git diff --check` | sạch |

Migration **không** được chạy vào bất kỳ database nào trong phase này (không local apply, không
staging, không production).

## 16. Remaining / deferred risks

1. **Orphan remote subscription** (remote sống, local không sở hữu) — out of scope (O4); có thể gây 409
   kéo dài cho mailbox đó tới khi subscription hết hạn. Follow-up chưa gán số task.
2. **Remote PATCH thành công nhưng CAS local thua** do normalization — cùng lớp orphan, deferred.
3. **`resource` representation** chưa canonical — observation, không phải correctness dependency.
4. **Fresh RENEWING trì hoãn provisioning ≤30 phút** — fail-safe có chủ đích (O3).
5. **Candidate query TASK-082/083 giữ nguyên** điều kiện thời gian ⇒ có thể tốn một lần refresh token
   khi ensure trả `blocked_renewing` (được báo bằng counter riêng).
6. **Migration chưa chạy trên môi trường thật** ⇒ preflight duplicate detection phải chạy trước khi
   deploy; nếu có duplicate, deploy sẽ dừng theo đúng M2.

## 17. Antigravity implementation review focus

1. Predicate normalization và 4 chiều race với TASK-084.
2. Phân loại P2002 (live-slot index vs `subscriptionId` vs lỗi khác) và ownership-aware cleanup.
3. STEP B bỏ điều kiện thời gian — parity với partial unique index.
4. TASK-083: không outcome concurrency nào flip mailbox.
5. TASK-082 dry-run vẫn tuyệt đối non-mutating.
6. Migration M2 fail-closed + preflight read-only + ghi chú drift trong `schema.prisma`.
7. Sanitization của log/result và của 2 docs.

---

**READY FOR ANTIGRAVITY IMPLEMENTATION REVIEW — NO COMMIT / NO PUSH**
