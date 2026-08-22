# TASK-082 — Graph Subscription Reconciliation (Locked Implementation Scope)

> **Loại task:** runtime implementation, scope đã được HUMAN APPROVE và khóa.
> Reviewer độc lập: **Antigravity CLI**. **Không commit, không push.**
> Không schema/migration, không env flag mới, không worker/scheduler mới,
> không distributed lock, không production reconciliation/backfill, không gọi
> Microsoft Graph thật, không đọc/in/sửa `.env*`.
>
> File này thay thế bản investigation-only trước đó. Các proposal cũ về
> reconciliation pass chạy sau renewal tick và env-flag gating **đã bị loại**
> theo quyết định human-approved dưới đây và không còn hiệu lực.

## 1. Bối cảnh

TASK-081 đã đóng gap connect-time provisioning: mailbox đi qua OAuth
connect/reconnect được ensure Graph subscription tại connect-time
(`ensureInboxSubscriptionForConnectedMailbox`). Phần còn lại: các mailbox
Microsoft `ACTIVE` hiện hữu connect TRƯỚC TASK-081 chưa bao giờ có Graph
subscription — không có đường webhook, chỉ sống nhờ delta polling backup.
TASK-082 bổ sung **capability** để operator chủ động reconcile nhóm mailbox
này, không tự động hóa bất kỳ bước nào.

## 2. Quyết định kiến trúc đã khóa (HUMAN APPROVED — không tự thay đổi)

### A. Trigger

**Operator-invoked, one-shot reconciliation capability.** KHÔNG có:

- periodic reconciliation;
- reconciliation pass trong renewal scheduler (proposal cũ Finding 4b — đã loại);
- automatic scheduler / new reconciliation worker;
- app-startup / deploy-time reconciliation;
- automatic fleet backfill.

Capability không được invoke → không có gì chạy.

### B. Không env flag

KHÔNG thêm reconciliation env flag nào (proposal cũ
`SUBSCRIPTION_RECONCILIATION_ENABLED` / `SUBSCRIPTION_RECONCILIATION_MAX_PER_CYCLE`
— đã loại). KHÔNG sửa `.env*`, env schema/loader, hay env docs cho task này.

Semantics thay thế:

- không invoke → không chạy;
- invoke mặc định → **dry-run** (non-mutating);
- chỉ explicit apply → mutate.

### C. Execution safety

- Default dry-run / non-mutating; explicit apply mới mutate.
- Bounded batch per invocation; default nhỏ; **hard maximum ở code-level**
  (constant, không phải env variable).
- Sequential processing, concurrency = 1, không expose concurrency option.
- Không infinite retry ở bất kỳ lớp nào.

### D. Candidate scope

Mailbox là candidate khi và chỉ khi đồng thời:

- `provider = 'MICROSOFT'`;
- `status = 'ACTIVE'`;
- `encryptedRefreshToken != null` (credential shape hiện tại);
- KHÔNG có potentially-live Graph subscription.

Potentially-live PHẢI reuse đúng định nghĩa TASK-081
(`BLOCKING_SUBSCRIPTION_STATUSES` trong
`services/microsoft/mailbox-subscription-provisioning.service.ts`): row
`ACTIVE`/`RENEWING`/`FAILED` với `expirationDateTime > now` → no-op/blocking,
không blind-create. Không tạo định nghĩa "usable subscription" thứ hai — nếu
cần dùng lại constant thì export từ chính module TASK-081.

Loại trừ (có chủ đích): `DISABLED`, `RECONNECT_REQUIRED`,
`SUBSCRIPTION_EXPIRED`, và mọi status non-ACTIVE khác.

### E. `SUBSCRIPTION_EXPIRED` — Deferred Finding

Finding từ investigation: mailbox bị renewal flip sang `SUBSCRIPTION_EXPIRED`
hiện không được delta poll và không có webhook (điểm mù relay). Đây là
**reliability issue riêng, KHÔNG thuộc TASK-082**:

- không fix lifecycle này;
- không thay delta candidate semantics;
- không thay webhook behavior;
- không đưa status này vào reconciliation candidates.

Ghi nhận là **Deferred Finding** cho follow-up task (chưa tạo/chốt task số).

### F. Concurrency — Deferred Risk

V1 KHÔNG thêm distributed lock, Redis lock wiring, schema unique constraint,
hay migration. Operator-invoked + bounded + sequential chỉ **giảm** risk.
Race giữa TASK-081 connect-time ensure và TASK-082 reconciliation (cả hai thấy
"no blocking row" → hai remote subscription) vẫn tồn tại về lý thuyết sau khi
reuse ensure seam → ghi **Deferred Risk** trong report. Single-replica
assumption của renewal worker là assumption, KHÔNG phải guarantee.

Hệ quả duplicate đã bounded bởi lớp hiện có: exactly-once dedup
(`ProcessedMessage @@unique([mailboxId, graphMessageId])`) chặn double-relay;
disconnect dọn mọi live row.

### G. Disconnect race — bắt buộc xử lý tối thiểu

Ordering bắt buộc cho mỗi candidate ở apply mode:

```text
candidate selected
→ (optional) local re-check tránh unnecessary work
→ obtain/refresh access token qua existing path
→ RE-CHECK mailbox vẫn ACTIVE
→ RE-CHECK potentially-live subscription state
→ mới được ensure/provision
```

Local re-check trước token refresh được phép nhưng KHÔNG thay thế hai re-check
sau token refresh và ngay trước provisioning (re-check potentially-live ngay
trước create chính là `findFirst` blocking-row bên trong ensure service
TASK-081 — reuse, không duplicate).

Nếu remote create vừa thành công mà mailbox đã rời `ACTIVE` (disconnect race):

- local subscription mới KHÔNG được để usable: mark row `EXPIRED` (fail-safe
  local state) trước/đồng thời với cleanup — webhook chỉ nhận
  `ACTIVE`/`RENEWING`, renewal chỉ nhận `ACTIVE`/`RENEWING`/`FAILED`, nên row
  `EXPIRED` inert ở mọi lớp;
- best-effort remote cleanup đúng một lần qua existing seam
  (`deleteGraphSubscription`, tolerate 404);
- không infinite retry; cleanup fail → log sanitized và dừng;
- reuse TASK-052/TASK-081 semantics (local-first, remote best-effort);
- không redesign disconnect flow.

Ngoài ra: nếu token classification ra `reconnect_required` đúng lúc mailbox bị
disconnect concurrent, việc mark mailbox PHẢI conditional (chỉ khi status còn
`ACTIVE`) để không overwrite `DISABLED` bằng `RECONNECT_REQUIRED`.

## 3. Kiến trúc implementation

### 3.1 Service

`runSubscriptionReconciliationOnce(deps)` — port-style thuần như
`subscription-renewal.service.ts` (mọi side effect qua injected port, unit-test
không cần DB):

- discover bounded candidates (query một lần, `orderBy createdAt asc`,
  `take limit`);
- dry-run: chỉ đọc local DB, trả sanitized summary;
- apply: xử lý tuần tự từng mailbox theo ordering mục 2.G;
- trả structured sanitized result (counters + internal mailbox IDs, không
  email plaintext, không token, không clientState).

Không nhúng vào renewal worker. Không scheduler.

### 3.2 Operator entrypoint

One-shot CLI `scripts/run-subscription-reconciliation.ts` (runner `tsx` đã có
trong repo — không dependency mới):

- mặc định dry-run; chỉ `--apply` mới mutate;
- `--limit <n>` bounded; default nhỏ; vượt hard maximum code-level → clamp
  deterministic (log rõ); giá trị không hợp lệ → reject;
- không concurrency option; sequential;
- không wire vào deploy/startup/worker; không public API/admin UI.

### 3.3 Reuse bắt buộc (không viết path thứ hai)

- Token: `createPrismaRenewalAccessTokenPort`
  (`services/queue/workers/subscription-renewal-runner.ts`) — decrypt →
  `refreshMicrosoftAccessToken` → `persistRotatedRefreshToken` (rotated
  credential vẫn encrypted-at-rest) → access token in-memory only; error kind
  đã classify sẵn theo TASK-069C (`classifyRefreshTokenError`). Port nhận
  optional finite `timeoutMs` (forward vào `refreshMicrosoftAccessToken`,
  TASK-080 seam); reconciliation BẮT BUỘC truyền finite timeout (reuse hằng
  20 giây của TASK-081) để token request không thể treo one-shot apply;
  renewal caller không truyền → behavior renewal giữ nguyên. Timeout classify
  transient, không bao giờ reconnect.
- Ensure/provision: `ensureInboxSubscriptionForConnectedMailbox` (TASK-081) —
  gồm blocking-row re-check, timeout 20s + real cancellation, fail-open,
  compensating DELETE khi remote-create-success/local-persist-failure.
- Remote cleanup: `deleteGraphSubscription` (TASK-052 semantics, idempotent
  với 404).
- Blocking definition: export `BLOCKING_SUBSCRIPTION_STATUSES` từ module
  TASK-081 và reuse trong candidate query (không đổi behavior TASK-081).

### 3.4 Token/error policy

- `invalid_grant` / `interaction_required` (hoặc credential mất/không decrypt
  được) → reconnect-required semantics hiện hành, mark **conditional** (chỉ
  khi mailbox còn `ACTIVE`);
- network/timeout/429/5xx/unknown → transient: KHÔNG đổi mailbox status,
  bounded failed/skipped result, không retry loop, xử lý mailbox kế tiếp;
- config (OAuth chưa cấu hình) → abort toàn bộ run, không blame mailbox nào
  (đồng nhất renewal semantics);
- không persist access token; không token-refresh implementation mới.

## 4. Acceptance criteria

- [ ] Default invocation = dry-run, thật sự non-mutating: không token refresh,
      không Graph call, không DB write, không persistent audit.
- [ ] Explicit apply mới đi mutation path; batch limit enforce; vượt hard max
      clamp deterministic; sequential (max in-flight = 1).
- [ ] Candidate selection đúng mục 2.D; mọi status non-ACTIVE và mailbox thiếu
      credential bị loại; potentially-live (ACTIVE/RENEWING/FAILED còn hạn) →
      no-op; expired/không có row → candidate.
- [ ] Token path reuse renewal port + TASK-069C nguyên vẹn; rotated refresh
      credential persist encrypted; transient không flip mailbox; config abort
      run; reconnect mark conditional (không overwrite DISABLED).
- [ ] Disconnect race: mailbox rời ACTIVE trước provisioning → không Graph
      create; blocking row xuất hiện sau selection → no blind-create; rời
      ACTIVE sau create → local row EXPIRED + best-effort remote cleanup đúng
      một lần; cleanup fail → vẫn fail-safe, không retry.
- [ ] Một mailbox transient failure không phá batch, không unbounded retry.
- [ ] Summary/log sanitized: không credential/token/plaintext clientState/full
      code/full email body; ưu tiên internal ID + counters.
- [ ] Không schema/migration, không env flag, không worker mới, không
      distributed lock, không sửa `.env*`, không đổi behavior
      renewal/delta/webhook/disconnect/dedup (regression PASS).
- [ ] `npm run verify` PASS toàn bộ.

## 5. Tests bắt buộc

Mock/fake toàn bộ Microsoft boundary; không secret thật. Nhóm bắt buộc:

1. **Invocation safety:** default dry-run; dry-run không token refresh /
   Graph create-delete / DB write; apply mới mutate; limit enforce; hard max
   clamp; sequential = 1.
2. **Candidate filtering:** ACTIVE+credential+no-blocking → candidate;
   DISABLED / RECONNECT_REQUIRED / SUBSCRIPTION_EXPIRED / thiếu credential →
   excluded; ACTIVE/RENEWING/FAILED còn hạn → no-op; expired → candidate.
3. **Token semantics:** reuse renewal port; rotation persistence;
   invalid_grant/interaction_required → reconnect semantics; transient →
   không flip, không infinite retry.
4. **TOCTOU/disconnect:** rời ACTIVE trước provisioning → không create;
   blocking row xuất hiện → no blind-create; rời ACTIVE sau create → row
   EXPIRED + cleanup đúng một lần; cleanup fail → fail-safe; TASK-081
   compensation regression; reconnect-mark không overwrite disconnect.
5. **Batch/regression/security:** transient không phá batch; counters
   sanitized; không log secret; TASK-081/TASK-052/TASK-069C/renewal
   regression tests PASS.

## 6. Không làm trong TASK-082

Periodic/scheduler/worker reconciliation; automatic fleet scan/backfill; env
flags; schema/migration; distributed lock/Redis lock wiring; renewal
concurrency hardening; `SUBSCRIPTION_EXPIRED` lifecycle fix; delta polling
redesign; TASK-080 stale-message changes; webhook hardening; Telegram routing;
RBAC redesign; detector/extractor; queue purge; production DB/reconciliation;
OAuth permission expansion; `.env*`; CI relaxation; ROADMAP (cập nhật sau khi
Antigravity review PASS); unrelated refactor.

## 7. Security

Theo `docs/SECURITY_RULES.md`: không đọc/in/sửa `.env*`; không hardcode/log
access token, refresh credential, client secret, Telegram bot token,
connection URL, encryption/session secret, plaintext clientState, full
verification code, full email body. Refresh credential tiếp tục
encrypted-at-rest; clientState giữ hashing semantics hiện hành. Docs/tests
không chứa secret-like values có thể kích hoạt CI secret scan.
