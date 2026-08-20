# TASK-081 — Graph Subscription Connect-Time Provisioning

> **Loại task:** runtime fix scope hẹp. **Option A only — connect-time Graph
> subscription provisioning.** Reviewer độc lập: **Antigravity CLI**.
> **Không commit, không push.** Không đọc/in `.env*`. Không thao tác production
> DB/queue. Không gọi Microsoft Graph thật / gửi Telegram thật.

## 1. Bối cảnh (finding F1 từ TASK-079)

TASK-079 xác nhận: `createInboxSubscription(...)` trong
`services/microsoft/graph-subscription.service.ts` đã tồn tại đầy đủ (create +
clientState hash + persist) nhưng **không có production caller nào**. OAuth
callback chỉ gọi `saveConnectedMailbox(...)` rồi redirect — mailbox mới
connect/reconnect không bao giờ có Graph subscription, đường webhook không tồn
tại cho chúng, renewal worker không có candidate. TASK-080 đã fix delta stuck +
stale guard; TASK-081 đóng gap provisioning cho mailbox đi qua OAuth flow.

Đã xác minh lại ở code-level trước khi implement (grep toàn repo): caller của
`createInboxSubscription` chỉ có trong chính service, unit tests, và docs.
Finding còn nguyên hiệu lực.

## 2. Mục tiêu

Sau OAuth connect/reconnect thành công:

```text
OAuth success
→ saveConnectedMailbox
→ ensure Graph subscription
→ nếu cần thì create + persist
```

Sửa missing production caller cho mailbox connect/reconnect mới. KHÔNG xử lý
các mailbox ACTIVE hiện hữu đang thiếu subscription (deferred — xem mục 8).

## 3. Quyết định kiến trúc đã khóa

- **Option A only.** Không Option B: không scan/reconcile/backfill fleet, không
  scheduled reconciliation worker, không tự reconnect mailbox cũ.
- Orchestration đặt ở **OAuth callback route**, sau khi `saveConnectedMailbox`
  đã thành công, qua một service mới nhỏ
  (`ensureInboxSubscriptionForConnectedMailbox`) — không nhét external Graph
  provisioning vào trong `saveConnectedMailbox` để giữ separation:
  identity-validation / credential-persistence / subscription-provisioning.
- Dùng **fresh access token đã có sẵn trong OAuth callback** (từ token
  exchange). Không persist thêm access token.

## 4. Ensure semantics (policy chính xác)

Trước khi create, đọc local `GraphSubscription` của mailbox:

- **A. Không có row nào** với `status ∈ {ACTIVE, RENEWING, FAILED}` và
  `expirationDateTime > now` → **create** subscription mới.
- **B. Có row ACTIVE/RENEWING chưa hết hạn** → **no-op** (không duplicate).
- **C. Row local đã hết hạn rõ ràng** (`expirationDateTime <= now`) hoặc
  status EXPIRED → không chặn; được phép **create** mới.
- **D. Row FAILED nhưng `expirationDateTime > now`** (remote có thể còn sống)
  → **no-op, không blind-create** thêm remote subscription.

Nguyên tắc an toàn: không create thêm remote subscription khi local evidence
chưa chứng minh subscription cũ đã hết hiệu lực.

## 5. Fail-open policy (bắt buộc)

Nếu OAuth connect thành công → mailbox/credential đã persist an toàn → Graph
subscription provisioning thất bại (bất kỳ lý do gì):

- KHÔNG rollback mailbox; KHÔNG corrupt refresh token;
- KHÔNG chuyển mailbox sang account khác; KHÔNG tạo duplicate mailbox;
- KHÔNG tự flip `RECONNECT_REQUIRED` chỉ vì provisioning lỗi;
- mailbox vẫn dùng được delta polling backup;
- provisioning failure kết thúc hữu hạn (không retry loop), log sanitized,
  OAuth callback vẫn redirect success.

## 6. Safety requirement — remote/local consistency

Nếu Microsoft tạo remote subscription thành công nhưng local DB persist thất
bại:

```text
remote create success → local persist failure
→ best-effort compensating remote DELETE đúng một lần (reuse deleteGraphSubscription)
→ nếu cleanup cũng fail: log sanitized và dừng
→ không retry vô hạn, không tạo local ACTIVE row giả, không rollback mailbox
```

## 7. Timeout requirement

Connect-time subscription HTTP operation phải có finite timeout + cancellation
thật. **Reuse `lib/http/fetch-with-timeout.ts`** (TASK-080): ensure service bọc
`fetch` bằng `fetchWithTimeout` (20s, cùng mức với delta path) rồi inject qua
`deps.fetchImpl` của `createInboxSubscription`. Timeout → request bị abort thật
→ map thành `GraphSubscriptionError('network')` → fail-open. Không tạo timeout
framework thứ hai; không đổi timeout behavior của renewal/delete/unrelated
Graph paths (default không đổi).

## 8. Không làm trong TASK-081

- Option B / reconciliation / backfill existing ACTIVE mailboxes (deferred —
  candidate follow-up, chưa commit scope).
- Production operations (DB, queue, Graph thật, Telegram thật).
- Schema/migration (đã xác minh không cần: model `GraphSubscription` hiện tại
  đủ; ensure check là query thường).
- Renewal worker redesign / renewal concurrency hardening.
- Delta polling, stale guard, dedup, Telegram routing, RBAC, webhook
  hardening, detector/extractor, `.env*`, CI/workflow.
- Không thêm Microsoft OAuth permission mới.

## 9. Security

Theo `docs/SECURITY_RULES.md`: không đọc/in/sửa `.env*`; không log access
token / refresh token / client secret / plaintext clientState / full code /
full email body; giữ nguyên clientState plaintext→hash semantics hiện hành
(persist chỉ `clientStateHash`); không sửa encryption-at-rest của refresh
token; không persist access token.

## 10. Acceptance criteria

- [ ] Production OAuth callback gọi ensure sau khi save mailbox thành công.
- [ ] Ensure semantics đúng policy mục 4 (có test A–D).
- [ ] Fail-open: provisioning fail không phá connect (test các kind
      400/401/403/429/5xx/network + hanging).
- [ ] Hanging create → finite timeout + abort thật + settle (fake timers).
- [ ] Remote success + persist fail → compensating DELETE đúng một lần; DELETE
      fail → dừng, sanitized.
- [ ] Save fail / wrong-account reconnect → provisioning không bao giờ được gọi.
- [ ] Subscription mới tương thích renewal worker hiện hành (status ACTIVE,
      expiration ~6 ngày, `subscriptionId` unique).
- [ ] Regression: webhook clientState validation, disconnect (TASK-052),
      exactly-once dedup, TASK-080 tests — tất cả PASS.
- [ ] `npm run verify` PASS toàn bộ.
