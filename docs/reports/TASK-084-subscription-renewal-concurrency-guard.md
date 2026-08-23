# TASK-084 — Subscription Renewal Concurrency Guard (Implementation Report)

> Report sanitized: không chứa token/refresh token/client secret/credential ciphertext
> thật, verification code đầy đủ, hay full email body. Không nêu tên nhánh Git đầy đủ.

## 1. Root cause / race đã đóng

Audit finding M2 (TASK-077): subscription renewal thiếu concurrency guard. Trước TASK-084,
mọi write trạng thái của renewal là `update` không điều kiện. Hai tiến trình renewal chạy
song song (multi-replica, hoặc scheduler + `--once` thủ công, hoặc rolling-restart overlap)
có thể cùng chọn một candidate và ghi đè trạng thái của nhau; một failure muộn có thể đè
ACTIVE mới hơn, kéo mailbox vừa recovery (TASK-083) về SUBSCRIPTION_EXPIRED, đè DISABLED của
disconnect, hoặc kéo mailbox vừa OAuth-reconnect về RECONNECT_REQUIRED. TASK-084 đóng các race
này bằng atomic claim + CAS ownership + conditional mailbox writers, KHÔNG cần schema/lock.

## 2. Atomic claim

`claimForRenewal(subscriptionId, now)` trong repo adapter: `updateMany` có điều kiện
(ACTIVE/FAILED sang RENEWING; nếu miss thì RENEWING với `updatedAt < now - 30′` sang RENEWING).
DB đảm bảo đúng một winner (`count = 1`); loser `count = 0` nên bỏ qua hoàn toàn (không token,
không PATCH, không completion, không mailbox side-effect). Claim xảy ra TRƯỚC token acquisition,
credential refresh, và Graph PATCH. Stale cutoff = 30 phút, code-level constant, không env.

## 3. CAS generation (mint-then-verify — đã sửa theo ChatGPT HIGH finding)

Operation TỰ tạo `claimTimestamp` của chính nó và GHI TƯỜNG MINH vào `updatedAt` ngay trong
câu `updateMany` claim (`data: { status: RENEWING, updatedAt: claimTimestamp }`; Prisma dùng
giá trị explicit cho cột `@updatedAt`). Ownership token = chính `claimTimestamp` đó, giữ local.
Read-back sau claim CHỈ để VERIFY round-trip (so exact `=== claimTimestamp`): nếu lệch, hoặc
status không còn RENEWING, hoặc một write khác chen vào → **fail-closed, claim lost**. Token
trả về LUÔN là `claimTimestamp` của operation, KHÔNG BAO GIỜ là giá trị read-back — nên một
worker stall không thể adopt generation của stale-reclaimer (chống hijack). Mọi completion
(`markRenewedIfOwner` sang ACTIVE + expiration + lastRenewedAt; `markSubscriptionFailedIfOwner`
sang FAILED; `markSubscriptionExpiredIfOwner` sang EXPIRED) là `updateMany` kèm
`status = RENEWING AND updatedAt = claimTimestamp`, trả `count > 0` = còn sở hữu. `timestamp(3)`
ms khớp JS Date ms nên round-trip chính xác. Không cần thêm cột.

**Bản implement đầu tiên (đã sửa):** dùng "read-back updatedAt rồi adopt làm token" → tạo lỗ
hổng hijack (A stall, B stale-reclaim gen B, A read-back adopt B rồi completion khớp B). Đã
thay bằng mint-then-verify ở trên.

## 4. Stale reclaim

RENEWING quá 30 phút được worker khác reclaim (bước 2 của claim); DB ghi `updatedAt` mới nên
generation của claimant cũ hết hiệu lực, mọi completion muộn của nó count = 0. `staleReclaimed
Count` đếm reclaim; `claimLostCount` đếm số subscription bỏ qua vì mất claim.

## 5. TASK-083 replacement guard

STEP 1 CAS EXPIRED (count = 1) mới cho STEP 2 chạy. STEP 2 là một `updateMany` mailbox có
relation-predicate: ACTIVE sang SUBSCRIPTION_EXPIRED chỉ khi KHÔNG còn GraphSubscription khác
possibly-live (`BLOCKING_SUBSCRIPTION_STATUSES` + `expirationDateTime > now`, loại chính row
đang lỗi qua `id != failingRowId`). Replacement subscription còn sống thì predicate không khớp
nên mailbox giữ ACTIVE. Một statement DB, tự atomic — không cần transaction.

## 6. Disconnect interaction

Disconnect ghi row live sang EXPIRED (bump `updatedAt`) nên generation cũ hết hiệu lực; mọi
completion muộn count = 0. Read-back lúc claim kiểm tra status còn RENEWING không (chặn race
disconnect chen giữa). DISABLED được bảo vệ: writer expired đòi `status = ACTIVE`, writer
reconnect đòi `status != DISABLED`. DISABLED không bị overwrite, EXPIRED không bị hồi sinh.

## 7. Credential-generation guard Case A/B

Token port (WithGeneration) báo generation = opaque `encryptedRefreshToken`. Case A (reconnect
trước rotation): generation = giá trị đọc lúc bắt đầu, mang trong `SubscriptionRenewalToken
Error.credentialGeneration` (null nếu thiếu token). Case B (Graph 401 sau khi lấy token; có
thể đã tự rotate): generation = giá trị post-rotation (`persistRotatedRefreshToken` trả
ciphertext đã ghi). Writer: `updateMany where { id, status != DISABLED, encryptedRefreshToken
= generation }` (`null` biên dịch `IS NULL`). Concurrent OAuth reconnect ghi credential mới thì
predicate lệch, count 0, mailbox vừa reconnect giữ ACTIVE. Writer chỉ chạy sau STEP 1 CAS FAILED
count = 1 (correction A). Credential là opaque marker, không log/decrypt.

## 8. Genuine TASK-069C regression behavior

Không có thay đổi credential đồng thời: invalid_grant / interaction_required / Graph 401 vẫn
sang RECONNECT_REQUIRED như TASK-069C (generation khớp, count = 1). 403 vẫn transient (TASK-071).
Classification không đổi.

## 9. Files changed

Runtime: `services/microsoft/subscription-renewal.service.ts`,
`services/queue/workers/subscription-renewal-runner.ts`,
`services/microsoft/graph-subscription.service.ts`,
`services/microsoft/refresh-token-rotation.service.ts`.
Tests: `tests/unit/microsoft/subscription-renewal.service.test.ts`,
`tests/unit/queue/subscription-renewal-runner.test.ts`,
`tests/unit/microsoft/graph-subscription.service.test.ts`,
`tests/unit/microsoft/refresh-token-rotation.service.test.ts`.
Docs: `docs/tasks/TASK-084-...md` (thêm PHẦN D), report này.

## 10. Tests added/updated

Atomic claim mint-then-verify (win với `updatedAt` explicit / lost / stale reclaim ghi
generation riêng / disconnect-race / **HIJACK GUARD: read-back thấy generation B → claim-lost,
không adopt** / fail-closed khi round-trip lệch 1 ms), stale-reclaim race end-to-end (resumed
worker zero side-effect), CAS completion where-clauses,
correction A (lost claim & CAS throw → zero mailbox writer), TASK-083 relation predicate
(exclude failing row, replacement giữ ACTIVE), credential guard Case A/B (+ IS NULL + concurrent
reconnect miss + lost-claim gate), genuine 069C, counters, token port string + WithGeneration,
graph adapter PATCH-only, rotation ciphertext field. Regression: reconciliation/069C/071/082/083
giữ PASS. Toàn suite 1236 tests PASS.

## 11. `npm run verify` result

**PASS (exit 0)** — `db:generate && lint && typecheck && test (1236) && build`.
`git diff --check` sạch (chỉ cảnh báo CRLF vô hại).

## 12. Remaining / deferred risks

Broader multi-worker credential-rotation last-writer-wins race (renewal / delta polling / email
worker / reconciliation cùng ghi `encryptedRefreshToken` không version) vẫn DEFERRED (A6/D4).
Residual bounded của reconnect guard: sub-case operation tự rotate đồng thời OAuth reconnect
dưới LWW là CÙNG deferred item, không phải blocker mới. Không sửa trong TASK-084.

## 13. Xác nhận scope

Không schema/migration; không version column; không Redis/distributed lock; không worker/
scheduler/queue mới; không env mới; không `.env*` changes; không GitHub Actions; không UI;
không OAuth permission; không redesign TASK-082/083; không đổi classification TASK-069C; không
kéo broader credential-rotation CAS. Không đổi scheduler interval / renewal window. Chưa commit,
chưa push, chưa update ROADMAP.

## 14. Phần Antigravity cần review kỹ

- Atomic claim: đúng một winner; đúng loại fresh RENEWING; stale cutoff 30 phút.
- **Mint-then-verify**: operation ghi `updatedAt = claimTimestamp` tường minh, giữ token
  local, read-back CHỈ verify; KHÔNG adopt read-back value (chống hijack stale-reclaimer).
- Exact `updatedAt` CAS; precision timestamp(3) ↔ Date; fail-closed khi round-trip lệch.
- Stale owner: mọi completion muộn count = 0, không side-effect.
- Correction A: CAS count 0 / throw → ZERO mailbox side-effect (cả expired lẫn reconnect path).
- TASK-083 relation guard: exclude failing row; dùng đúng possibly-live source-of-truth.
- Disconnect: mọi late path bị chặn; DISABLED không bị overwrite.
- OAuth reconnect Case A/B: capture đúng generation; concurrent reconnect làm writer miss.
- Genuine TASK-069C reconnect vẫn hoạt động.
- Secret hygiene: credential chỉ là opaque marker, không log/không ciphertext trong docs.
