# TASK-083 — SUBSCRIPTION_EXPIRED Mailbox Recovery & Relay Continuity

> **Trạng thái:** investigation (mục 1–15) đã được Antigravity CLI review PASS;
> human/ChatGPT đã APPROVE Option A + decisions D1–D5; **implementation phase
> đã thực hiện theo mục 16**. Reviewer độc lập: **Antigravity CLI** (review
> implementation đang chờ). **Không commit, không push.** Không production
> recovery, không schema/migration, không worker/scheduler mới, không
> distributed lock, không đọc/in/sửa `.env*`, không sửa GitHub Actions.
>
> Mọi finding investigation dưới đây đã xác minh trực tiếp ở code-level trên
> working tree tại thời điểm điều tra (HEAD = commit TASK-082).

## 1. Root cause / lifecycle hiện tại

Deferred Finding từ TASK-082 nói mailbox `SUBSCRIPTION_EXPIRED` là relay blind
spot. Investigation này **XÁC NHẬN finding đúng**, với lifecycle chính xác:

```text
GraphSubscription của mailbox hết hạn (theo giờ local) hoặc Graph trả 404/410
→ renewal worker: mark subscription row EXPIRED + mark mailbox SUBSCRIPTION_EXPIRED
→ delta polling loại mailbox (chỉ poll ACTIVE)
→ webhook không còn row ACTIVE/RENEWING để validate notification
→ pipeline gate terminal-skip mọi job của mailbox non-ACTIVE
→ mailbox KHÔNG relay verification message qua bất kỳ đường nào
→ không có code path tự động nào đưa mailbox trở lại ACTIVE
→ UI cũng KHÔNG hiện Reconnect CTA cho status này (chỉ DISABLED/RECONNECT_REQUIRED)
```

Đường thoát duy nhất hiện tại: human chạy lại OAuth connect cho đúng mailbox
đó (qua flow connect chung, không có CTA dẫn lối) — `saveConnectedMailbox` set
`status: 'ACTIVE'` và TASK-081 ensure provision subscription mới. Tức là cần
re-consent tương tác cho từng mailbox, dù refresh credential thường vẫn khỏe.

## 2. Exact files/functions (đã trace)

### A. Ai set `SUBSCRIPTION_EXPIRED` — đúng MỘT writer runtime

- **Writer duy nhất:** `markMailboxSubscriptionExpired` trong
  `services/queue/workers/subscription-renewal-runner.ts` (dòng 115–121) —
  `mailbox.update` **không điều kiện** sang `SUBSCRIPTION_EXPIRED`.
- **Caller duy nhất:** `handleExpired` trong
  `services/microsoft/subscription-renewal.service.ts` (dòng 280–297): mark
  subscription row `EXPIRED` trước, rồi mark mailbox. Cả hai bước bọc `safely`
  (nuốt lỗi từng bước — xem mục 8, edge E1).
- **Hai điều kiện trigger** vào `handleExpired`:
  1. `classifySubscription` → `'expired'`: row còn trong pool
     (ACTIVE/RENEWING/FAILED) nhưng `expirationDateTime <= now` tại tick
     (service dòng 192–194, gọi tại 492–499);
  2. `classifyRenewError` → `'expired'`: Graph trả **404/410** khi renew PATCH
     (service dòng 228–230, xử lý tại 386–388).
- Ngoài renewal, không code path nào khác set status này (grep toàn repo: chỉ
  UI labels/health/alerts/tests đọc nó). Disconnect set `DISABLED`; token chết
  set `RECONNECT_REQUIRED`.
- **Subscription local status tại thời điểm flip:** bình thường là `EXPIRED`
  (đã mark ở bước trước trong cùng `handleExpired`).

### B. Delta polling — LOẠI `SUBSCRIPTION_EXPIRED`

- Candidate query: `services/queue/workers/delta-polling-runner.ts` dòng 64–65
  — `where: { provider: 'MICROSOFT', status: 'ACTIVE' }`.
- Hậu quả relay: mailbox mất luôn đường backup polling — trong khi delta
  **không cần** Graph subscription và credential thường vẫn mint được token.
- Đánh giá: loại non-ACTIVE khỏi delta là fail-safe có chủ đích cho
  DISABLED/RECONNECT_REQUIRED (không được poll mailbox đã tắt/token chết),
  nhưng với `SUBSCRIPTION_EXPIRED` đây là **accidental gap**: status nói về
  lifecycle subscription (webhook path), không nói credential chết, mà lại
  tắt luôn cả đường không-cần-subscription.

### C. Webhook — không thể relay

- `services/microsoft/webhook-notification.service.ts` dòng 187–200:
  notification phải match row local theo `subscriptionId`, row phải
  `ACTIVE`/`RENEWING`, clientState hash phải khớp. Sau `handleExpired`, row đã
  `EXPIRED` → skip `subscription_inactive`. Remote subscription (nếu Microsoft
  còn giữ) tự hết hạn ≤ 6 ngày.
- Edge: nếu vì partial failure mà còn row live trong khi mailbox đã
  `SUBSCRIPTION_EXPIRED` → webhook accept + enqueue, nhưng pipeline gate
  `services/email/graph-message-pipeline.service.ts` dòng 562–574
  (`mailbox.status !== 'ACTIVE'` → `SKIPPED_MAILBOX_NOT_ACTIVE`, terminal
  skip) vẫn chặn relay. **Fail-safe đúng, nhưng cũng là lý do chỉ provision
  subscription mới mà không flip status thì mailbox VẪN câm.**

### D. UI/UX

- `lib/mailboxes/mailbox-list-filter.ts`: `deriveMailboxReadiness` map
  `SUBSCRIPTION_EXPIRED` → `SUBSCRIPTION_ISSUE` (dòng 122–123), nhưng
  `mailboxNeedsReconnect` (dòng 102–104) chỉ nhận
  `DISABLED`/`RECONNECT_REQUIRED` → **không có Reconnect CTA** cho
  `SUBSCRIPTION_EXPIRED` (`app/admin/mailboxes/[id]/page.tsx` dòng 158–164).

## 3. Relay blind spot: **CONFIRMED**

Cả bốn lớp đã xác minh trên code hiện tại: (1) không webhook (row EXPIRED /
remote chết); (2) không delta (query loại non-ACTIVE); (3) pipeline gate
terminal-skip nếu job nào đó lọt vào; (4) không auto-recovery + không CTA.
Mailbox `SUBSCRIPTION_EXPIRED` với credential khỏe là mailbox câm vô hạn cho
tới khi human tự nghĩ ra việc chạy lại OAuth connect.

## 4. Credential behavior

- Transition sang `SUBSCRIPTION_EXPIRED` **không đụng**
  `encryptedRefreshToken` (writer chỉ update `status`). Credential vẫn
  encrypted-at-rest, thường vẫn hợp lệ — status này KHÔNG hàm ý token chết
  (token chết đi đường `RECONNECT_REQUIRED` riêng, TASK-069C).
- Mint access token bình thường qua port hiện có
  (`createPrismaRenewalAccessTokenPort`, đã có optional finite `timeoutMs` từ
  TASK-082): decrypt → refresh → persist rotated credential encrypted → token
  in-memory. TASK-069C classification áp dụng nguyên vẹn khi refresh fail
  (`invalid_grant`/`interaction_required` → reconnect; transient → không đổi
  status; config → app-wide).

## 5. Existing seams có thể reuse (đủ, không cần path thứ hai)

| Seam | Reuse cho recovery |
|---|---|
| `ensureInboxSubscriptionForConnectedMailbox` (TASK-081) | Ensure/provision + blocking-row re-check ngay trước POST + timeout 20s cancellation thật + fail-open + compensating DELETE khi persist fail. |
| `createPrismaRenewalAccessTokenPort` + `timeoutMs` (TASK-082) | Token path production, TASK-069C classification nhúng sẵn, finite timeout. |
| `classifyRefreshTokenError` / error kind (TASK-069C) | Reconnect vs transient vs config. |
| `deleteGraphSubscription` (TASK-052 semantics) | Best-effort remote cleanup, idempotent 404, mark row EXPIRED. |
| Toàn bộ máy TASK-082 (`subscription-reconciliation.service.ts` + runner + CLI) | Dry-run default / explicit apply / bounded / sequential / disconnect-race ordering / conditional status marking / sanitized counters. |

Cái **duy nhất chưa tồn tại**: một transition primitive an toàn
`SUBSCRIPTION_EXPIRED → ACTIVE` (mục 6).

## 6. Recovery state machine đề xuất (per mailbox, apply mode)

```text
candidate: provider MICROSOFT + status SUBSCRIPTION_EXPIRED
           + encryptedRefreshToken khác null
           + KHÔNG có potentially-live subscription (BLOCKING_SUBSCRIPTION_STATUSES
             của TASK-081: ACTIVE/RENEWING/FAILED còn hạn)
→ local re-check: status vẫn SUBSCRIPTION_EXPIRED + vẫn không blocking row
→ mint access token qua renewal port (finite timeout)
→ RE-CHECK status vẫn SUBSCRIPTION_EXPIRED   ← pin đúng status, không chỉ "khác DISABLED"
→ ensure/provision qua TASK-081 seam (tự re-check blocking row ngay trước POST)
→ nếu outcome created:
    RE-CHECK status vẫn SUBSCRIPTION_EXPIRED
    → conditional flip: updateMany where {id, status: SUBSCRIPTION_EXPIRED}
                        data {status: ACTIVE}
    → flip count = 0 (status đã bị đổi concurrent) → KHÔNG coi là recovered:
        mark row mới EXPIRED (fail-safe local trước)
        + best-effort remote DELETE đúng một lần
→ nếu outcome skipped_existing → KHÔNG flip trong v1 (open decision D2), report
→ nếu outcome failed → giữ nguyên SUBSCRIPTION_EXPIRED, report
```

Điều kiện bắt buộc trước flip `ACTIVE`: (i) remote create thành công VÀ local
row ACTIVE đã persist (outcome `created` của ensure seam — không blind-flip);
(ii) mailbox status ngay trước flip vẫn là `SUBSCRIPTION_EXPIRED` và flip là
conditional update nên **không bao giờ** overwrite `DISABLED`/
`RECONNECT_REQUIRED` do operator/worker khác vừa set. Sau flip, delta polling
tự nhận lại mailbox ở cycle sau và webhook path sống nhờ row mới — không cần
sửa delta query hay pipeline gate.

Residual window chấp nhận được: giữa create và flip, notification tới sớm sẽ
bị pipeline terminal-skip (mailbox chưa ACTIVE) — cửa sổ cỡ giây; sau flip
delta backup + stale guard 30 phút (TASK-080) bound phần mất mát.

## 7. Failure semantics (reuse tối đa semantics hiện có)

| Failure | Mailbox status | Hành vi |
|---|---|---|
| `invalid_grant` / `interaction_required` / credential mất/không decrypt | → `RECONNECT_REQUIRED` **conditional** (chỉ khi vẫn `SUBSCRIPTION_EXPIRED`) | Đúng semantics 069C; mailbox sang đường reconnect UX 069B (status này CÓ CTA); không bao giờ overwrite `DISABLED`. |
| Network timeout / Graph 429 / 5xx / unknown (token hoặc create) | Giữ `SUBSCRIPTION_EXPIRED` | Transient: không đổi status, không retry loop, operator re-run; batch tiếp tục mailbox kế. |
| Config (OAuth chưa cấu hình) | Không đổi | Abort toàn run, không blame mailbox (mirror renewal/082). |
| Create subscription failure (ensure `failed`) | Giữ `SUBSCRIPTION_EXPIRED` | Fail-open của TASK-081; không flip. |
| Remote create OK + local persist fail | Giữ `SUBSCRIPTION_EXPIRED` | Compensating DELETE đúng một lần bên trong seam TASK-081; không local row giả; không flip. |
| Post-create disconnect race / flip-condition fail | KHÔNG flip; row mới → `EXPIRED` local trước + một remote DELETE best-effort | Mirror TASK-082 mục 2.G; cleanup fail → vẫn fail-safe (webhook chỉ nhận ACTIVE/RENEWING; renewal bỏ qua EXPIRED), không retry. |

Nguyên tắc: recovery **không bao giờ** đưa mailbox sang trạng thái xấu hơn
trạng thái nó đang có, và chỉ đi lên `ACTIVE` qua đúng một conditional update.

## 8. Race analysis (disconnect / reconnect / concurrency)

1. **Candidate selected → operator disconnect:** re-check pin
   `status === SUBSCRIPTION_EXPIRED` trước token, sau token, và trước flip →
   mailbox `DISABLED` bị skip ở lớp đầu tiên chạm tới; flip conditional nên kể
   cả lọt qua đọc-bẩn cũng không ghi đè.
2. **Disconnect trong lúc token refresh:** `persistRotatedRefreshToken` chỉ
   ghi credential + timestamp, không đụng status (đã xác minh ở TASK-082);
   reconnect-mark và flip đều conditional → không resurrect `DISABLED`.
3. **Remote create OK → disconnect:** re-check + conditional flip fail → row
   mới bị mark `EXPIRED` local TRƯỚC, rồi một best-effort remote DELETE
   (pattern TASK-082 đã có test); không tạo usable subscription cho mailbox đã
   disconnect.
4. **User reconnect OAuth đồng thời recovery:** reconnect set `ACTIVE`
   (`saveConnectedMailbox`) + chạy ensure riêng → hai bên có thể cùng thấy "no
   blocking row" trong cửa sổ hẹp → duplicate remote subscription (đúng TOCTOU
   đã ghi ở TASK-081/082, bounded bởi exactly-once dedup — không double-relay
   — và disconnect dọn mọi live row). Flip của recovery điều kiện trên
   `SUBSCRIPTION_EXPIRED` nên không tranh chấp với `ACTIVE` reconnect vừa set.
   → **Deferred Risk**, không phải blocker.
5. **Renewal đồng thời recovery:** candidate recovery theo định nghĩa không có
   row potentially-live → renewal không có gì để renew cho mailbox đó; nếu row
   FAILED-còn-hạn xuất hiện giữa chừng thì ensure no-op (blocking). Subscription
   mới do recovery tạo vào renewal pool như mọi row khác; nếu sau này nó thật
   sự hết hạn, renewal flip lại `SUBSCRIPTION_EXPIRED` là hành vi đúng.

**Edge E1 (ghi nhận, không sửa trong task này):** trong `handleExpired`, hai
bước mark đều `safely` — nếu mark row fail nhưng mark mailbox thành công, có
thể tồn tại mailbox `SUBSCRIPTION_EXPIRED` kèm row live → candidate query loại
mailbox này (có blocking row) và v1 không flip trên `skipped_existing` → nó
vẫn câm; thuộc open decision D2.

## 9. Concurrency — v1 không cần lock/schema

Operator-invoked + bounded + sequential (concurrency 1) + ensure re-check +
conditional transitions là đủ cho v1, cùng lập luận đã được duyệt ở TASK-082:
race còn lại (mục 8.4) có hệ quả bounded bởi dedup exactly-once và disconnect
cleanup. **Distributed lock/schema constraint KHÔNG phải mandatory safety
blocker** — ghi Deferred Risk, không mở scope.

## 10. Options A–D

| Option | Mô tả | Đánh giá |
|---|---|---|
| **A — operator-invoked recovery (KHUYẾN NGHỊ)** | One-shot, opt-in mode trên máy reconciliation TASK-082: candidate `SUBSCRIPTION_EXPIRED`, provision qua ensure seam, rồi conditional flip `→ ACTIVE`. | An toàn nhất: không automatic fleet mutation; dry-run default; blast radius = số mailbox operator cho phép (bounded); reuse ~toàn bộ seam; chỉ thêm một transition primitive conditional; race đã phân tích, bounded. |
| B — automatic self-heal trong renewal path | Renewal tick tự provision + tự flip. | Bị loại: automatic fleet mutation không operator gate; renewal worker tự đưa mailbox đi LÊN `ACTIVE` là hướng nguy hiểm hơn nhiều so với đi xuống; mâu thuẫn triết lý trigger đã khóa ở TASK-082; thừa hưởng renewal concurrency finding (M2) chưa đóng. |
| C — delta polling poll luôn `SUBSCRIPTION_EXPIRED` như fallback | Nới candidate delta. | Bị loại làm hướng chính: **không đủ** — pipeline gate vẫn terminal-skip mailbox non-ACTIVE nên relay vẫn câm; muốn hết câm phải nới cả pipeline gate → làm yếu fail-safe mà disconnect/pipeline đang dựa vào, blast radius lan sang mọi consumer của status semantics (health, alerts, UI). |
| D — TASK-082 mở rộng candidate scope trần (thêm status vào query) | Chỉ nới query 082. | Bị loại ở dạng trần (đúng scope rule đề bài): provision xong mailbox vẫn `SUBSCRIPTION_EXPIRED` → delta vẫn loại + pipeline vẫn skip → **vẫn câm**, chỉ tốn Graph quota. D chỉ có nghĩa khi kèm state transition — khi đó nó chính là Option A. |

## 11. Minimal safe recommendation (ONE)

**Option A:** mở rộng máy reconciliation TASK-082 bằng một **recovery mode
opt-in tường minh** (ví dụ flag CLI riêng; naming là open decision D1):

- không truyền flag → behavior TASK-082 hiện tại, không đụng
  `SUBSCRIPTION_EXPIRED` (backward-compatible tuyệt đối);
- truyền flag → candidate là mailbox `SUBSCRIPTION_EXPIRED` (predicate còn lại
  giống 082: MICROSOFT + credential + không blocking row); dry-run default;
  explicit apply; bounded (giữ default 5 / hard max 20 code-level); sequential;
- apply per mailbox theo state machine mục 6 + failure semantics mục 7;
- một mutation primitive mới duy nhất: conditional flip
  `SUBSCRIPTION_EXPIRED → ACTIVE` (updateMany có điều kiện status), cộng
  conditional reconnect-mark tương tự pattern 082 nhưng pin từ
  `SUBSCRIPTION_EXPIRED`.

Không sửa delta query, không sửa pipeline gate, không sửa webhook, không sửa
renewal, không schema/migration, không lock, không env flag, không worker mới.

## 12. Scope implementation đề xuất / KHÔNG làm

**Đề xuất làm (sau khi duyệt):** service/runner/CLI extension trên các file
TASK-082 + transition primitive + tests + report. **KHÔNG làm:** mọi mục ở
header (schema/migration, worker/scheduler mới, distributed lock, Redis
wiring, `.env*`, GitHub Actions, OAuth permission), production
recovery/backfill, sửa delta/pipeline/webhook/renewal/disconnect behavior,
sửa `handleExpired` (edge E1 chỉ ghi nhận), UX Reconnect CTA cho
`SUBSCRIPTION_EXPIRED` (tách follow-up riêng nếu duyệt — D4), unrelated
refactor.

## 13. Test matrix đề xuất

1. **Opt-in gating:** không flag → candidate `SUBSCRIPTION_EXPIRED` không bao
   giờ được chọn/đụng (082 behavior nguyên vẹn, regression 082 tests PASS);
   có flag + dry-run (default) → chỉ đọc, không token/Graph/DB-write; chỉ
   explicit apply mới mutate; bounded limit + hard max + sequential giữ nguyên.
2. **Candidate:** `SUBSCRIPTION_EXPIRED` + credential + không blocking row →
   candidate; `ACTIVE`/`DISABLED`/`RECONNECT_REQUIRED`/thiếu credential/còn
   blocking row (kể cả FAILED còn hạn — edge E1) → loại.
3. **Happy path:** created → conditional flip → status `ACTIVE`, row mới vào
   renewal pool (regression `classifySubscription`); dry-run báo candidate
   không mutate.
4. **Token semantics:** invalid_grant → `RECONNECT_REQUIRED` conditional (không
   overwrite `DISABLED`); transient → giữ `SUBSCRIPTION_EXPIRED`, đúng 1
   attempt; config → abort run; rotation persist encrypted; timeout hanging →
   abort thật + settle hữu hạn (fake timers, reuse pattern test TASK-082).
5. **Races:** disconnect trước token / sau token / sau create → không create
   hoặc không flip + row mới `EXPIRED` + đúng 1 remote cleanup; cleanup fail →
   vẫn fail-safe; flip-count-0 → không recovered; blocking row xuất hiện sau
   selection → no blind-create; reconnect OAuth concurrent → không tranh chấp
   flip (conditional).
6. **Batch/sanitize/regression:** 1 mailbox lỗi không phá batch; counters/log
   sanitized (không token/clientState/email); TASK-081/082/052/069C/renewal
   suites PASS nguyên trạng.

## 14. Acceptance criteria đề xuất

- [ ] Không flag → không có behavior change nào cho bất kỳ status nào.
- [ ] Flag + dry-run default non-mutating thật sự; chỉ explicit apply mutate.
- [ ] Candidate đúng mục 6; bounded + hard max code-level + sequential.
- [ ] Flip `→ ACTIVE` chỉ sau ensure outcome `created` và chỉ bằng conditional
      update từ `SUBSCRIPTION_EXPIRED`; flip fail → row mới thành non-usable +
      một best-effort remote cleanup.
- [ ] Failure semantics đúng bảng mục 7; không retry loop; không overwrite
      `DISABLED`.
- [ ] Reuse seams mục 5 nguyên trạng — không token/create/cleanup path mới.
- [ ] Không schema/migration/lock/worker/env flag/`.env*`/CI change.
- [ ] Test matrix mục 13; `npm run verify` PASS; log/report sanitized.

## 15. Open decisions cần human/ChatGPT duyệt

- **D1 — Entrypoint & naming:** recovery mode là flag trên CLI reconciliation
  hiện có (khuyến nghị — một máy, một audit surface) hay script one-shot
  riêng; tên flag/outcome.
- **D2 — Edge E1 (`skipped_existing`):** mailbox `SUBSCRIPTION_EXPIRED` còn
  row potentially-live (partial failure cũ hoặc tạo concurrent). V1 khuyến
  nghị KHÔNG flip, chỉ report outcome để ops xử lý; phương án thay thế (flip
  khi row là ACTIVE/RENEWING còn hạn) cần duyệt riêng vì "FAILED còn hạn"
  không chứng minh usable.
- **D3 — Batch defaults:** giữ default 5 / hard max 20 dùng chung với 082 hay
  đặt cap riêng cho recovery mode.
- **D4 — UX follow-up:** thêm Reconnect CTA / hiển thị hướng dẫn cho
  `SUBSCRIPTION_EXPIRED` (hiện không có CTA) — tách task UI riêng hay gộp.
- **D5 — Số phận Deferred Finding trong ROADMAP/TASK-082 report:** sau khi
  TASK-083 implementation xong sẽ cập nhật ở đâu (ROADMAP update là bước sau
  Antigravity PASS, như quy trình 082).

## 16. Implementation đã chốt (phase 2 — theo approvals D1–D5)

- **D1:** reuse CLI `npm run reconcile:subscriptions`; recovery mode là flag
  opt-in `--recover-subscription-expired` (không flag → behavior TASK-082
  nguyên vẹn; default dry-run; chỉ `--apply` mutate). Không script/process
  thứ hai.
- **D2:** blocking/possibly-live row → `skipped_existing`, giữ nguyên
  `SUBSCRIPTION_EXPIRED`, không create, không flip, không repair.
- **D3:** reuse bounded batch của TASK-082 (default 5 / hard max 20
  code-level), sequential, concurrency 1.
- **D4:** không UI.
- **D5:** không rewrite history TASK-082; report riêng
  `docs/reports/TASK-083-subscription-expired-recovery.md`; ROADMAP để sau
  Antigravity PASS.
- Candidate recovery list qua **repo method riêng**
  (`listSubscriptionExpiredRecoveryCandidates`) — cùng predicate với normal
  reconciliation, chỉ pin status khác; KHÔNG status union trong một query.
- Mutation primitive mới duy nhất: `markMailboxActiveIfSubscriptionExpired`
  (conditional `updateMany where {id, status: SUBSCRIPTION_EXPIRED}`), chỉ gọi
  SAU khi ensure outcome `created`; flip không match → row mới bị mark
  `EXPIRED` local trước + đúng một best-effort remote DELETE → outcome
  `skipped_state_changed`. Reconnect-mark trong recovery pin từ
  `SUBSCRIPTION_EXPIRED` (`markMailboxReconnectRequiredIfSubscriptionExpired`).
- Outcome/counters mới: `recovered`, `skipped_state_changed`,
  `recoveredCount`, `skippedStateChangedCount`, `recoveryMode` — sanitized như
  TASK-082.
- **Review-fix (Antigravity High):** flip không match KHÔNG tự động cleanup
  nữa — re-read status hiện tại rồi classify: `ACTIVE` (reconnect concurrent
  hợp lệ) → GIỮ nguyên subscription vừa tạo (không delete, không overwrite,
  outcome `skipped_state_changed` không kèm cleanup); `DISABLED` /
  `RECONNECT_REQUIRED` / unexpected → cleanup đúng một lần như cũ; vẫn
  `SUBSCRIPTION_EXPIRED` (flip malfunction) → cleanup + outcome `failed`,
  không retry. Cleanup luôn chỉ nhắm đúng `subscriptionId` do recovery này
  tạo (ownership), không đụng blocking row khác.
