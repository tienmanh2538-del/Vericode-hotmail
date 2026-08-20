# TASK-081 — Report: Graph Subscription Connect-Time Provisioning

> **Sanitized.** Không chứa secret/URL kết nối/token/plaintext clientState/full
> verification code/full email body. Reviewer độc lập: **Antigravity CLI**.
> **Không commit / không push.** ROADMAP chưa đổi trạng thái (chỉ sau khi qua
> Antigravity review PASS). **Option A only** — connect-time provisioning.

## 1. Code-level gap confirmed

Trước fix, production OAuth callback
(`app/api/microsoft/oauth/callback/route.ts`) sau token exchange chỉ gọi
`fetchMicrosoftProfile` → `saveConnectedMailbox` → redirect. Grep toàn repo xác
nhận `createInboxSubscription` **không có production caller nào** (chỉ xuất
hiện trong chính `graph-subscription.service.ts`, unit tests, và docs) — khớp
finding F1 của TASK-079. Mailbox mới connect/reconnect không bao giờ có Graph
subscription; renewal worker không có candidate; webhook path không tồn tại
cho chúng.

## 2. Implementation

```text
OAuth callback (GET)
→ exchangeAuthorizationCodeForTokens (giữ nguyên)
→ fetchMicrosoftProfile + validation (giữ nguyên)
→ saveConnectedMailbox(...)                      ← credential persist, giữ nguyên
→ ensureInboxSubscriptionForConnectedMailbox({   ← MỚI (TASK-081)
    mailboxId: savedMailbox.mailboxId,
    accessToken: tokens.accessToken,             ← fresh token từ token exchange,
  })                                                KHÔNG persist
→ redirect success (luôn — provisioning là fail-open)
```

- Service mới: `services/microsoft/mailbox-subscription-provisioning.service.ts`
  — `ensureInboxSubscriptionForConnectedMailbox(input, deps)`. Orchestration
  nằm ở route, KHÔNG nhét vào `saveConnectedMailbox` (giữ separation:
  identity validation / credential persistence / subscription provisioning).
- Create thật sự delegate cho `createInboxSubscription` hiện có (reuse toàn bộ
  clientState/hash/persist logic); ensure service chỉ thêm: local ensure check,
  timeout-wrapped fetch, fail-open boundary.

## 3. Ensure policy (chính xác)

Query local: `graphSubscription.findFirst({ where: { mailboxId, status: { in:
[ACTIVE, RENEWING, FAILED] }, expirationDateTime: { gt: now } }, orderBy:
{ expirationDateTime: 'desc' } })`.

- **Row tồn tại** (ACTIVE/RENEWING/FAILED và `expirationDateTime > now`) →
  **no-op** (`skipped_existing`). FAILED được tính là "có thể còn sống remote"
  → không blind-create (case D của đề bài).
- **Không row nào match** — tức không có row, hoặc mọi row đã
  `expirationDateTime <= now`, hoặc chỉ còn row status EXPIRED (EXPIRED chỉ
  được ghi khi remote đã xác nhận mất: disconnect, renewal 404/410, quá hạn) →
  **create** một subscription mới.

Không thêm unique constraint/migration — duplicate protection là local ensure
check (đúng scope; concurrency edge ghi ở mục 13).

## 4. Fail-open behavior

`ensureInboxSubscriptionForConnectedMailbox` **không bao giờ throw** (toàn bộ
thân hàm trong try/catch, trả `{ outcome: 'failed', errorName }`); route còn
bọc thêm một try/catch boundary. Provisioning fail (config/400/401/403/429/
5xx/network/timeout/DB):

- mailbox + encrypted refresh token giữ nguyên như `saveConnectedMailbox` đã
  ghi; không rollback, không overwrite account, không duplicate mailbox;
- không flip `RECONNECT_REQUIRED`; status mailbox không bị đụng;
- redirect vẫn `oauth=success`; delta polling backup tiếp tục là đường sống;
- đúng **một** attempt, không retry loop trong OAuth request.

## 5. Timeout/cancellation

Seam: ensure service bọc fetch bằng `fetchWithTimeout` (TASK-080) với hằng
`CONNECT_SUBSCRIPTION_HTTP_TIMEOUT_MS = 20_000` (cùng mức delta path), inject
qua `deps.fetchImpl` của `createInboxSubscription` — **không sửa**
`fetch-with-timeout.ts`, không đổi timeout behavior của renewal/delete/các
Graph path khác (default vẫn không timeout như cũ). Khi quá 20s:
`controller.abort()` hủy thật request (không phải Promise.race chạy nền) →
`HttpTimeoutError` → `performGraphRequest` map thành
`GraphSubscriptionError('network')` → fail-open, OAuth callback settle hữu
hạn. Compensating DELETE (mục 6) dùng cùng fetch đã bọc timeout.

## 6. Remote/local consistency

Trong `createInboxSubscription` (`graph-subscription.service.ts`), nhánh
persist-failure (remote 201 nhưng `prisma.graphSubscription.create` throw):

```text
remote create success → local persist failure
→ reuse deleteGraphSubscription(...) best-effort ĐÚNG MỘT LẦN (trong try/catch)
→ delete fail ⇒ logger.warn sanitized, dừng — không retry, không loop
→ vẫn throw GraphSubscriptionError('database') như trước
```

Không tạo local ACTIVE row giả; không rollback mailbox credential.
`deleteGraphSubscription` được reuse nguyên trạng (tolerate 404; local
status-update trên row không tồn tại được chính nó swallow + warn).

## 7. clientState / security

- Không đổi `generateClientState` / `hashClientState` /
  `verifyGraphClientState`; persist duy nhất `clientStateHash`
  (`hashSensitiveValue`), plaintext chỉ đi trong request tới Microsoft — y
  nguyên semantics hiện hành. Webhook validation không bị sửa.
- Access token chỉ chảy từ token exchange → ensure → header Authorization;
  không persist, không log (test secret-hygiene cho cả ensure path và
  compensation path).
- Không đọc/in/sửa `.env*`; không đụng encryption-at-rest refresh token.

## 8. Renewal interaction

Row do provisioning ghi có shape đúng cái renewal worker chọn:
`subscriptionId` (unique, non-empty), `status: 'ACTIVE'` (nằm trong filter
`in [ACTIVE, RENEWING, FAILED]` của `listRenewableCandidates`),
`expirationDateTime ≈ now + 6 ngày` (clamp ≤ 7 ngày) → vào renewal window 24h
như mọi row cũ. Có test dùng chính `classifySubscription` của renewal service:
row mới → `skip` khi còn xa hạn, → `renew` khi vào window. Không sửa renewal
worker.

## 9. Disconnect interaction

Không sửa disconnect. TASK-052 semantics giữ nguyên: disconnect vẫn đánh dấu
local live subs → EXPIRED + best-effort remote delete. Tương tác đúng chiều:
sau disconnect (row EXPIRED) mà mailbox được reconnect qua OAuth → ensure thấy
không còn row blocking → tạo subscription mới (mong muốn). Provisioning chỉ
chạy ngay sau khi `saveConnectedMailbox` vừa set ACTIVE trong cùng request —
không có đường nào tạo subscription cho mailbox DISABLED (disconnect tests
hiện có vẫn PASS).

## 10. Tests

Mới (2 file mới + 1 file mở rộng — 27 test mới):

- `tests/unit/microsoft/mailbox-subscription-provisioning.service.test.ts`
  (18): ensure A–D (+EXPIRED không chặn, +scope theo mailbox); fail-open cho
  400/401/403/429/5xx/network (mỗi loại đúng 1 attempt, không throw); prisma
  read fail; validation input; secret hygiene; **H. hanging create** (fake
  timers + signal-aware fake fetch: abort thật sau 20s, settle `failed`);
  **L. renewal compatibility** qua `classifySubscription` thật.
- `tests/unit/microsoft/graph-subscription.compensation.test.ts` (3): **I.**
  remote 201 + persist fail → đúng 1 DELETE tới đúng URL rồi throw `database`;
  **J.** DELETE 500 → vẫn chỉ 1 attempt, terminate; secret hygiene trên
  compensation path.
- `tests/api/microsoft-oauth-callback.route.test.ts` (+6): A. fresh connect
  provisions (1 POST, row ACTIVE, hash ≠ plaintext clientState); B. reconnect
  với sub còn sống → không duplicate; G. Graph 403 → fail-open, mailbox intact;
  fail-open khi thiếu notification-URL config; **E.** save fail → provisioning
  không bao giờ gọi; **F.** wrong-account reconnect → mismatch trước
  provisioning, không subscription call.

Regression: toàn bộ test cũ chạy nguyên trạng — webhook clientState validation
(K), disconnect TASK-052 (M), exactly-once/dedup + TASK-080 stale/timeout (N),
TASK-071/074/075 403 semantics, TASK-069B/C. Không sửa test cũ nào ngoài việc
mở rộng mock/router của route test (các assertion cũ giữ nguyên).

## 11. Verification

`npm run verify`: **PASS** (exit 0) — lint + typecheck sạch; test **98 test
files / 1142 tests passed** (baseline TASK-080: 96 files / 1115 → +2 files,
+27 tests); build `Compiled successfully`.

## 12. Files changed

Runtime (3):
- `services/microsoft/mailbox-subscription-provisioning.service.ts` (mới)
- `services/microsoft/graph-subscription.service.ts` (chỉ nhánh
  persist-failure của `createInboxSubscription`: compensating delete)
- `app/api/microsoft/oauth/callback/route.ts` (gọi ensure sau save, fail-open)

Tests (3):
- `tests/unit/microsoft/mailbox-subscription-provisioning.service.test.ts` (mới)
- `tests/unit/microsoft/graph-subscription.compensation.test.ts` (mới)
- `tests/api/microsoft-oauth-callback.route.test.ts` (mở rộng)

Docs (2): task file + report này. Không sửa `.env*`, schema/migration,
GitHub Actions/CI.

## 13. Deferred / Remaining risks

- **Existing ACTIVE mailboxes thiếu subscription:** TASK-081 closes the
  connect-time provisioning gap for new/reconnected mailboxes going through
  the OAuth flow after this implementation. Existing ACTIVE mailboxes that
  already lack a usable subscription remain a deferred reconciliation/backfill
  concern. Candidate follow-up: Graph subscription reconciliation for existing
  ACTIVE mailboxes (chưa commit scope).
- **Concurrent duplicate OAuth callback:** hai callback đồng thời cho cùng
  mailbox về lý thuyết có thể cùng qua ensure check và tạo 2 remote
  subscription (không có unique constraint theo mailbox). Xử lý đúng cần
  constraint/lock/migration → ngoài scope, severity thấp (cửa sổ hẹp, cần
  double-submit OAuth); ghi nhận, không sửa.
- **Renewal concurrency finding cũ** (nhiều worker cùng renew) vẫn tồn tại —
  không thuộc TASK-081, không sửa.
- **Live Microsoft validation chưa chạy** — task chỉ mock/test local theo ràng
  buộc (không gọi Graph/Telegram thật). Cần xác nhận trên staging khi deploy:
  notification URL env đã cấu hình, mailbox connect mới sinh row
  `GraphSubscription` và webhook nhận notification.
- Hằng timeout 20s là code-level (không env-tunable) — nhất quán với TASK-080.
