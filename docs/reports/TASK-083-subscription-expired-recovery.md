# TASK-083 — Report: SUBSCRIPTION_EXPIRED Mailbox Recovery & Relay Continuity

> **Sanitized.** Không chứa secret/token/connection URL/plaintext clientState/
> full verification code/full email body. Reviewer độc lập: **Antigravity CLI**
> (implementation review đang chờ). **Không commit / không push / không
> production recovery.** ROADMAP chưa đổi (chỉ sau khi Antigravity PASS).

## 1. Root cause và cách fix

**Root cause (investigation đã confirm):** mailbox bị renewal worker flip sang
`SUBSCRIPTION_EXPIRED` (subscription hết hạn local hoặc Graph 404/410) trở
thành relay blind spot vô hạn: không webhook (row đã `EXPIRED`), không delta
polling (query chỉ poll `ACTIVE`), pipeline gate terminal-skip mọi job
non-ACTIVE, không code path nào tự đưa mailbox về `ACTIVE`, và UI không có
Reconnect CTA cho status này — dù refresh credential thường vẫn khỏe.

**Fix (Option A đã approve):** recovery mode **opt-in tường minh** trên máy
reconciliation TASK-082 — operator-invoked one-shot, provision subscription
qua ensure seam TASK-081 rồi **conditional flip** `SUBSCRIPTION_EXPIRED →
ACTIVE`. Sau flip, delta polling tự nhận lại mailbox và webhook path sống nhờ
row mới — **không** sửa delta query, pipeline gate, webhook, hay renewal.

## 2. Files/functions changed

Runtime (3):

- `services/microsoft/subscription-reconciliation.service.ts` — option
  `recoverSubscriptionExpired` (default false); repo interface thêm
  `listSubscriptionExpiredRecoveryCandidates`,
  `markMailboxReconnectRequiredIfSubscriptionExpired`,
  `markMailboxActiveIfSubscriptionExpired`; per-mailbox flow pin re-check theo
  status yêu cầu của run (`ACTIVE` normal / `SUBSCRIPTION_EXPIRED` recovery);
  outcome mới `recovered` / `skipped_state_changed`; counters mới
  `recoveredCount` / `skippedStateChangedCount` / `recoveryMode`; helper
  cleanup dùng chung `makeCreatedSubscriptionNonUsable`.
- `services/queue/workers/subscription-reconciliation-runner.ts` — Prisma repo
  implement 3 method mới (shared predicate builder, chỉ pin status; hai
  conditional `updateMany`); CLI parse thêm `--recover-subscription-expired`.
- `scripts/run-subscription-reconciliation.ts` — truyền flag vào service, usage
  + summary counters mới.

Không sửa: ensure/provisioning TASK-081, token port, graph-subscription
service, renewal, delta, webhook, pipeline, disconnect, schema, `.env*`, CI.

## 3. Recovery state machine (đã implement đúng approved)

```text
SUBSCRIPTION_EXPIRED
→ explicit operator recovery (flag + apply)
→ candidate validation (predicate mục 4)
→ local re-check: status vẫn SUBSCRIPTION_EXPIRED + không blocking row
→ access token qua renewal port (decrypt → refresh → rotated credential
  encrypted → token in-memory; finite timeout TASK-082)
→ RE-CHECK status vẫn SUBSCRIPTION_EXPIRED (sau token, trước create)
→ ensure seam TASK-081 (tự re-check blocking row ngay trước POST; timeout 20s;
  fail-open; compensating DELETE khi persist fail)
→ outcome created (remote + local row ACTIVE đã persist — usable proven)
→ conditional flip: updateMany where {id, status SUBSCRIPTION_EXPIRED} → ACTIVE
```

`ACTIVE` là bước CUỐI CÙNG; không tồn tại đường flip-trước-create. Flip lỗi
DB được coi fail-safe như không match (không recovered, cleanup chạy).

## 4. Candidate selection

`provider MICROSOFT` + `status SUBSCRIPTION_EXPIRED` + `encryptedRefreshToken`
khác null + không row potentially-live theo đúng
`BLOCKING_SUBSCRIPTION_STATUSES` của TASK-081 (`ACTIVE`/`RENEWING`/`FAILED`
còn hạn). Implement bằng **repo method riêng** dùng chung predicate builder với
normal reconciliation, chỉ pin status khác — **không** status union trong một
query, normal candidate query không đổi một ký tự semantics. `orderBy
createdAt asc`, `take limit` (default 5 / hard max 20 reuse của TASK-082),
sequential concurrency 1.

## 5. Credential semantics

Reuse nguyên vẹn `createPrismaRenewalAccessTokenPort` (+ finite `timeoutMs` 20
giây như TASK-082): decrypt → `refreshMicrosoftAccessToken` →
`persistRotatedRefreshToken` (encrypted-at-rest) → access token chỉ in-memory.
TASK-069C classification nguyên vẹn qua error kind:

- `reconnect_required` (invalid_grant/interaction_required/credential mất) →
  mark `RECONNECT_REQUIRED` **conditional pin từ `SUBSCRIPTION_EXPIRED`**
  (method riêng — không dùng biến thể pin-ACTIVE của normal mode) → mailbox
  sang đường reconnect UX 069B (status đó có CTA); không create, không flip.
- `transient` (network/timeout/429/5xx/unknown) → giữ `SUBSCRIPTION_EXPIRED`,
  outcome `failed_transient`, đúng một attempt, batch tiếp tục.
- `config` → abort toàn run, không blame/mark mailbox nào.

## 6. Conditional ACTIVE transition

`markMailboxActiveIfSubscriptionExpired`: `updateMany where {id, status:
SUBSCRIPTION_EXPIRED} data {status: ACTIVE}` → true chỉ khi match. Không có
update không điều kiện nào trong recovery path. Không match: **không
overwrite, không resurrect**; số phận subscription vừa tạo được classify theo
status hiện tại (review-fix mục 13): `ACTIVE` → giữ nguyên; non-ACTIVE →
non-usable (mục 7).

## 7. Race handling

- **Race A (disconnect trước token/create):** pre-check pin status → outcome
  `skipped_state_changed`, không token, không create.
- **Race B (disconnect trong token refresh):** post-token re-check chặn create
  (`persistRotatedRefreshToken` chỉ ghi credential+timestamp, không đụng
  status — không resurrect); nếu create đã xảy ra thì lớp flip+cleanup đỡ.
- **Race C (create xong → disconnect):** flip không match → mailbox giữ
  `DISABLED`; row mới bị mark `EXPIRED` local TRƯỚC (inert với webhook —
  ACTIVE/RENEWING only — và renewal — ACTIVE/RENEWING/FAILED only) rồi đúng
  một best-effort remote DELETE (`deleteGraphSubscription`, tolerate 404);
  DELETE fail → log sanitized, dừng, vẫn fail-safe.
- **Race D (OAuth reconnect đồng thời):** reconnect set `ACTIVE` → flip không
  match → status re-read thấy `ACTIVE` → **GIỮ nguyên subscription vừa tạo**
  (không cleanup — review-fix mục 13): mailbox ACTIVE + usable subscription
  intact, webhook path sống; duplicate create window bounded bởi ensure
  re-check + exactly-once dedup downstream (không double-relay).
- **Race E (renewal đồng thời):** candidate recovery không có row
  potentially-live nên renewal không tranh chấp; row xuất hiện giữa chừng →
  ensure `skipped_existing` → giữ `SUBSCRIPTION_EXPIRED`, không flip (đúng D2).

## 8. Dry-run / apply

- Không flag → TASK-082 behavior nguyên vẹn (có test khẳng định recovery query
  không bao giờ được gọi).
- Flag + không `--apply` → **dry-run**: chỉ một read liệt kê recovery
  candidate; không token refresh, không Graph call, không DB write, không flip.
- Flag + `--apply` → mutate theo state machine mục 3.

## 9. Failure semantics

Token: mục 5. Ensure `failed` (config/4xx/5xx/network/timeout/DB) → fail-open,
giữ `SUBSCRIPTION_EXPIRED`. Remote create OK + persist fail → compensating
DELETE đúng một lần bên trong seam TASK-081, outcome `failed`, không flip.
Flip fail → mục 6/7. Cleanup fail → bounded, không retry, local đã fail-safe.
Một mailbox lỗi không phá batch; chỉ config abort run.

## 10. Tests

Mới: `tests/unit/microsoft/subscription-reconciliation.recovery.test.ts`
(**21 tests** sau review-fix) — opt-in gating (không flag → recovery pool không đụng tới; flag
→ chỉ dùng recovery query; dry-run default non-mutating; limit/clamp reuse);
state machine (ensure-trước-flip có assert thứ tự invocation; D2 blocking ở
pre-check và ở ensure seam → `skipped_existing` không flip; ensure failed →
giữ status); token semantics (transient đúng 1 attempt không mark;
reconnect_required dùng đúng conditional pin-SUBSCRIPTION_EXPIRED, biến thể
pin-ACTIVE không bao giờ fire; config abort); races A/B (không token/create
khi state đổi); race C (`DISABLED` → cleanup đúng một lần, không resurrect);
**race D High-regression** (`ACTIVE` concurrent → GIỮ subscription, 0 local
expiry, 0 remote delete, 0 create thêm, không overwrite); biến thể
`RECONNECT_REQUIRED` (preserve status + cleanup một lần); flip malfunction
(status vẫn `SUBSCRIPTION_EXPIRED` → cleanup + outcome `failed`, không retry);
cleanup fail bounded; batch (sequential max-in-flight 1; transient không phá
batch; sanitized results/logs).

Mở rộng: `tests/unit/queue/subscription-reconciliation-runner.test.ts` (**+3
tests**, giờ 19) — recovery candidate query đúng predicate pin
`SUBSCRIPTION_EXPIRED` (không union); hai conditional mark mới đúng where/data
+ trả false khi không match; CLI flag (`--recover-subscription-expired` default
false, kết hợp `--apply`/`--limit`, arg lạ vẫn reject).

Cập nhật fakes (thêm 3 repo method) trong 2 file test TASK-082 hiện có; toàn
bộ assertion cũ giữ nguyên PASS — normal reconciliation không đổi behavior.

## 11. `npm run verify`

**PASS** (exit 0, sau review-fix mục 13) — lint + typecheck sạch; test **102
files / 1209 tests passed** (baseline TASK-082: 101 files / 1185 → +1 file,
+24 tests); build `Compiled successfully`.

## 12. Remaining / deferred risks

1. **TOCTOU duplicate-create** giữa recovery ↔ OAuth reconnect (và TASK-081 ↔
   TASK-082 như đã ghi): v1 không distributed lock/schema constraint theo
   scope khóa; bounded bởi ensure re-check + exactly-once dedup + disconnect
   cleanup.
2. **Race D residual — ĐÃ FIX (review-fix mục 13):** nguy cơ "reconnect ensure
   no-op lên row của recovery rồi recovery cleanup row đó" đã bị loại — status
   `ACTIVE` sau flip-fail giờ GIỮ nguyên subscription. Residual còn lại của
   nhánh này chỉ là duplicate remote subscription khi cả hai bên cùng create
   trong cửa sổ hẹp (bounded bởi exactly-once dedup; disconnect dọn mọi live
   row) — trùng với risk 1.
3. **Edge E1 (mailbox `SUBSCRIPTION_EXPIRED` còn row potentially-live do
   partial failure trong `handleExpired`):** đúng D2 — bị loại khỏi candidate
   / `skipped_existing`, không repair trong v1; vẫn là inconsistent-state edge
   deferred.
4. **Cửa sổ giây giữa create và flip:** notification tới trong cửa sổ bị
   pipeline terminal-skip; sau flip delta backup + stale guard 30 phút bound
   phần mất mát.
5. **Live production recovery chưa chạy** — ops action riêng (dry-run xem
   counters trước, rồi mới apply); UI/CTA cho `SUBSCRIPTION_EXPIRED` vẫn không
   tồn tại (D4 — follow-up riêng nếu duyệt).

## 13. Review-fix — Antigravity High (flip-fail classification)

Antigravity implementation review lần 1: **FAIL** với đúng một finding High —
nhánh recovery coi **mọi** `flipped === false` là phải cleanup. Interleaving
lỗi: recovery create + persist subscription usable → OAuth reconnect
concurrent set mailbox `ACTIVE` → ensure của reconnect thấy row của recovery
và no-op → flip của recovery không match → recovery mark row `EXPIRED` + xóa
remote → **mailbox ACTIVE nhưng subscription bị hủy**, phá continuity
provisioning của TASK-081 (webhook primary path chết dù delta còn chạy).

**Fix hẹp (chỉ nhánh flip-fail trong `reconcileOneMailbox`,
`services/microsoft/subscription-reconciliation.service.ts`):** sau khi flip
không match, re-read status hiện tại qua đúng repo seam
(`getMailboxStatus`) rồi classify:

| Status hiện tại | Hành vi |
|---|---|
| `ACTIVE` | Transition concurrent hợp lệ (reconnect): **GIỮ** subscription vừa tạo (không local expiry, không remote delete), không overwrite, không provisioning thêm; outcome `skipped_state_changed` (không kèm cleanup marker). Invariant: ACTIVE mailbox + usable subscription intact. |
| `DISABLED` | Cleanup bắt buộc như cũ: row `EXPIRED` local trước + đúng một remote DELETE; giữ `DISABLED`, không resurrect. |
| `RECONNECT_REQUIRED` | Cleanup bắt buộc như cũ; không overwrite status. |
| Vẫn `SUBSCRIPTION_EXPIRED` (flip malfunction) | Fail-safe: cleanup + outcome `failed` (mailbox vẫn blind, operator re-run); không blind-flip, không retry. |
| Đọc status lỗi / giá trị khác | Fail-safe như nhánh trên (cleanup + `skipped_state_changed`). |

Ownership giữ nguyên: cleanup chỉ nhắm đúng `subscriptionId` mà recovery này
tạo — không bao giờ đụng blocking row của reconnect/renewal/run khác. Races
A/B/C/E và D2 `skipped_existing`, dry-run/apply, batch/sequential, TASK-082
normal mode: không đổi (regression tests giữ nguyên PASS). Tests review-fix:
+3 (race D High-regression giữ subscription; biến thể RECONNECT_REQUIRED;
flip malfunction → failed), race C/cleanup-failure cập nhật pin status
`DISABLED` tường minh. `npm run verify` sau fix: PASS — 102 files / 1209
tests (mục 11). **Antigravity re-review sau fix này chưa diễn ra.**
