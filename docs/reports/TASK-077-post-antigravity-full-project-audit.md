# TASK-077 — Report: Post-Antigravity full project logic, security & readiness audit

## 1. Tóm tắt kết luận

- **Không phát hiện finding Critical. Không phát hiện finding High mới.** High duy
  nhất của TASK-072 (webhook nuốt enqueue failure) đã được TASK-073 đóng — đã xác
  minh fix **có mặt trong code hiện tại** (route trả 503 khi enqueue fail, jobId
  deterministic + dedup đảm bảo redeliver an toàn).
- **4 Medium còn mở**, đều là các finding **đã biết từ TASK-072 nhưng chưa được
  triển khai fix** (vì TASK-076 dùng số thứ tự cho migration reviewer thay vì cho
  các fix mà TASK-072 dự kiến). Phần lớn là **latent risk** (chưa exploit được ở cấu
  hình hiện tại) hoặc rủi ro **đa-replica** chưa bật.
- **1 đính chính quan trọng so với TASK-072:** lớp dedup "code + time-bucket" (layer
  3) **KHÔNG phải no-op** trong production như TASK-072 kết luận. Prisma store match
  theo `codeHash` + khoảng thời gian `receivedAt` (tự tính lại window), không phụ
  thuộc cột `receivedAtBucket`. Vì vậy **không cần** task thêm cột như TASK-072 đề
  xuất; chỉ còn một điểm Low (thiếu DB constraint cho layer 3 + field/comment gây
  hiểu nhầm).
- **Các bất biến cốt lõi đều CONFIRMED ổn ở code hiện tại:** exactly-once (DB unique
  + claim race backstop), customer isolation tầng service (đường relay chính),
  encryption-at-rest (AES-256-GCM, IV ngẫu nhiên mỗi lần, format versioned), secret
  hygiene logging/masking (code → `sha256:…`, token → `ab****cd`, không lưu email
  body, code-event store từ chối code thô 4+ chữ số), reconnect 401-vs-403
  (TASK-071/074/075), refresh-token classification (TASK-069C).
- **Antigravity migration (TASK-076) đúng:** mọi file source-of-truth / workflow
  hiện hành mô tả reviewer/tester độc lập là Antigravity CLI; mention "Gemini" còn
  lại chỉ là **lịch sử** (report/handoff/task cũ) và đã được đánh dấu rõ.
- **Kết luận readiness:** **đủ điều kiện tiếp tục live beta ở quy mô hiện tại**
  (một runner mỗi loại worker, chỉ OWNER/ADMIN có quyền ghi). Cần đóng nhóm Medium
  trước khi (a) cấp quyền ghi cho role staff bị giới hạn scope, (b) chạy nhiều
  replica subscription renewal, hoặc (c) mở rộng bề mặt webhook public.
- `npm run verify` **PASS** (xem mục 3).

## 2. Baseline nhánh / Git

- Audit được thực hiện trên nhánh làm việc của TASK-077.
- Trước khi tạo 2 file docs của task này, working tree **không hoàn toàn sạch**: nó
  mang sẵn 5 thay đổi docs/script chưa commit kế thừa từ migration TASK-076
  (`.cursor/rules/ecc-project-rules.mdc`, `docs/MICROSOFT_SETUP.md`,
  `docs/PRODUCT_SPEC.md`, `docs/operations/PRODUCTION_SCALE_UP_CHECKLIST.md`,
  `scripts/antigravity-ecc-review.ps1`). Đây là di sản TASK-076 chưa commit, không
  phải thay đổi của TASK-077.
- TASK-077 chỉ thêm đúng 2 file docs mới (task + report này); không đụng runtime,
  test, schema, migration, CI, package scripts.
- Không commit (theo yêu cầu).

## 3. Baseline verify

`npm run verify` (db:generate + lint + typecheck + test + build) chạy ở đầu task:

- **Exit code 0 — PASS.**
- Lint + typecheck: sạch.
- Test: **91 test files / 1081 tests passed**.
- Build: `Compiled successfully`, generate static pages (15/15) OK.

## 4. Bảng findings theo severity

| Mức độ | Vấn đề | File liên quan | Cách xác minh | Rủi ro thực tế | Đề xuất task fix |
|--------|--------|----------------|---------------|----------------|------------------|
| Critical | (không có) | — | — | — | — |
| High | (không có mới; High của TASK-072 đã đóng ở TASK-073) | `app/api/webhooks/microsoft/mail/route.ts` | Route trả 503 khi `enqueueResult.failed > 0`; jobId deterministic + dedup. | — (đã đóng) | — |
| Medium (M1) | **RBAC customer-scope chưa wire đủ** ở đường ghi mapping/destination. Trang edit, server actions, nhánh disable + DELETE đều **không truyền scope**; các hàm service `disableTelegramMapping`/`deleteTelegramMapping`/`disableTelegramDestination` và create/update destination **không có tham số scope**; bỏ scope là **fail-open**. (Nhánh PATCH JSON-update API thì **đã** truyền scope.) | `app/admin/telegram/[id]/edit/page.tsx`, `app/admin/telegram/destinations/[id]/edit/page.tsx`, `app/api/telegram/mappings/[id]/route.ts` (disable + DELETE), `services/telegram/mapping-actions.ts`, `services/telegram/destination-actions.ts`, `services/telegram/telegram-mapping.service.ts`, `services/telegram/telegram-destination.service.ts`, `lib/auth/*` | Soát caller: get/list/update by id chỉ fail-closed **khi** scope được truyền; disable/delete không có scope param. Chỉ `MANAGE_TELEGRAM_MAPPINGS` (OWNER/ADMIN → scope `all`) chạm tới được. | **Latent.** Hiện không exploit được vì không có role ghi bị giới hạn scope. Trở thành rủi ro thật ngay khi thêm role kiểu "staff write" với scope `assigned`. | Bắt buộc scope (không optional, fail-closed) ở mọi caller + thêm scope param cho disable/delete/create/update destination; thêm test cross-customer create/update/disable/delete. |
| Medium (M2) | **Subscription renewal thiếu guard concurrency.** Chuyển subscription sang `RENEWING` là `update` theo primary key **không điều kiện** (không CAS / không affected-count / không lock / không lease). Candidate selection còn `findMany` gồm cả row `RENEWING`. Runner chỉ có guard `inflight` **trong một tiến trình**. | `services/microsoft/graph-subscription.service.ts` (transition RENEWING ~555-567, success update ~612-619), `services/queue/workers/subscription-renewal-runner.ts` (select ~68-87, inflight ~302-307), `scripts/run-subscription-renewal-worker.ts` | Hai worker đọc cùng row ACTIVE → cả hai set RENEWING → cả hai PATCH Graph. | **Đa-replica.** An toàn chỉ khi deploy đúng **một** replica renewal. Chạy nhiều replica → double-PATCH Graph, có thể nhiễu subscription. | Conditional update (`updateMany WHERE status='ACTIVE'` lấy affected-count, loser thành no-op) hoặc loại RENEWING khỏi selection + lease; thêm test 2 worker tranh renew. |
| Medium (M3) | **Webhook endpoint không rate-limit, không verify origin/signature.** Chỉ có validationToken echo + clientState hash (timing-safe). Mỗi POST vẫn tốn JSON parse + một `findUnique` subscription mỗi notification. | `app/api/webhooks/microsoft/mail/route.ts`, `services/microsoft/webhook-notification.service.ts` | Không có `middleware.ts` cho route; không thấy limiter/allowlist/chữ ký. | **DoS surface.** ClientState hash chặn routing giả nhưng không chặn flood request. Chưa chặn live beta quy mô nhỏ; cần xử lý trước khi mở rộng public exposure. | Rate-limit theo IP cho webhook + cân nhắc kiểm tra nguồn; giữ validationToken/clientState như cũ. |
| Medium (M4) | **Thiếu test cross-customer isolation cho create/update/disable/delete** mapping & destination (chỉ có test scope cho read). Liên quan trực tiếp M1. | `tests/unit/telegram/telegram-destination.service.test.ts`, `tests/unit/telegram/telegram-mapping.service.test.ts` | Không có test khẳng định mapping mailbox khách A trỏ destination khách B fail-closed. | Regression isolation không được test bảo vệ → dễ tái phát khi refactor. | Gộp vào task fix M1: thêm test "fails closed khi mailbox và destination khác customer" cho mọi đường mutation. |
| Low (L1) | **Lớp dedup code-bucket (layer 3) không có DB unique constraint** — chỉ check-then-insert ở service. Hai message cùng code, khác `graphMessageId`, trong 5 phút, chạy đua thật có thể cùng vượt check. (Đính chính TASK-072: layer 3 **vẫn hoạt động** trong production qua match `codeHash`+`receivedAt`; chỉ thiếu lớp khóa DB.) Field `receivedAtBucket` trả về luôn `null` + comment schema gây hiểu nhầm. | `services/email/prisma-processed-message-store.ts` (findByCodeBucket, toRecord `receivedAtBucket: null`), `services/email/deduplication.service.ts`, `prisma/schema.prisma` (model `ProcessedMessage`) | `findByCodeBucket` query `where {mailboxId, codeHash, receivedAt: {gte,lt}}` — match được; nhưng không có constraint chặn race. Layer 1/2 không phủ case "cùng code, khác message-id". | **Edge case** hiếm. Layer 1 (graphMessageId) + layer 2 (internetMessageId) vẫn giữ exactly-once cho duplicate thường. | Thêm DB constraint cho layer 3 **hoặc** ghi rõ layer 3 là best-effort; dọn field/comment `receivedAtBucket` gây hiểu nhầm. |
| Low (L2) | **Redis global pacer latch fail-open vĩnh viễn.** Lần resolve client đầu tiên timeout → đặt `clientUnavailable=true` mãi mãi tới khi restart pod, không re-resolve khi Redis hồi phục. (Mailbox lock **không** dính lỗi này — retry mỗi call.) | `services/queue/redis-global-send-throttle.ts` (~183-201) | `clientUnavailable` latch, `resolveClient` short-circuit. | Mất pacing cross-process tới khi restart; **fail-open, không chặn delivery**, vẫn pace per-process. | Re-attempt resolve Redis định kỳ (hoặc reset latch sau N phút). |
| Low (L3) | **UI mailbox detail readiness badge** dựa trên mapping mới nhất thay vì đếm rõ "active destination" → dễ nhập nhằng cho operator. | `app/admin/mailboxes/[id]/page.tsx` | Disable mapping cũ + enable mapping mới; badge vs checklist. | Hiểu nhầm trạng thái, không ảnh hưởng relay. | Hiển thị "1 active / N mappings" rõ ràng. |
| Low (L4) | **Badge skip/renewing thiếu phân biệt:** `CodeEventStatusBadge` gộp `SKIPPED_DUPLICATE` và `SKIPPED_LOW_CONFIDENCE` cùng màu; `SubscriptionStatusBadge` không hiển thị "renewing since…". | `components/status/CodeEventStatusBadge.tsx`, `components/status/SubscriptionStatusBadge.tsx` | Xem 2 dòng skip khác lý do hiển thị giống nhau. | Triage chậm, không ảnh hưởng logic. | Tách variant + tooltip; thêm mốc thời gian renewal. |
| Low (L5) | **Renewal window hardcode 24h**, chưa expose qua biến môi trường để ops tinh chỉnh. | `services/microsoft/subscription-renewal.service.ts` | Tìm cấu hình renewal window — không có. | Cứng nhắc vận hành. | Đưa thành biến môi trường có default 24h. |
| Low (L6) | **Audit store không có regex chặn code thô 4+ chữ số** như code-event store (chỉ redact theo tên key). Không có field body trong schema audit nên rủi ro thấp. | `services/logs/audit-log.service.ts` | So sánh với `code-event-log.service.ts` (có `FULL_NUMERIC_CODE`). | Defense-in-depth thiếu một lớp, chưa có đường ghi code thô vào audit. | Thêm guard numeric-code cho metadata audit (đồng bộ code-event store). |
| Info (I1) | **Đính chính TASK-072:** finding "receivedAtBucket null → layer 3 dedup là no-op" **không đúng** với code hiện tại. Layer 3 hoạt động qua match `codeHash`+`receivedAt`. Task thêm cột mà TASK-072 đề xuất là **không cần**. | (như L1) | (như L1) | — | Bỏ đề xuất "thêm cột receivedAtBucket"; chỉ giữ L1. |
| Info (I2) | **Antigravity migration (TASK-076) đúng & sạch.** Source-of-truth hiện hành trỏ Antigravity CLI; mention Gemini còn lại là lịch sử có chủ đích. | `ANTIGRAVITY.md`, `AGENTS.md`, `docs/SECURITY_RULES.md`, `CLAUDE.md`, `.cursor/rules/ecc-project-rules.mdc`, `docs/PRODUCT_SPEC.md`, `scripts/antigravity-ecc-review.ps1` | Soát các file workflow hiện hành: chỉ còn note "từ TASK-076 thay cho Gemini CLI". | — | Không cần fix. |
| Info (I3) | **TASK-073/074/075 fix CONFIRMED có trong code:** webhook 503 + jobId dedup (073); email pipeline 403 không reconnect (074); delta persistent-403 backoff/cooldown/alert + clear-on-success (075). | route webhook, `graph-message-pipeline.service.ts`, `delta-polling.service.ts` | Đọc trực tiếp các nhánh tương ứng. | — | Không cần fix. |

## 5. Khu vực đã xác nhận ổn (code hiện tại)

- **Exactly-once / dedup chính:** DB unique `(mailboxId, graphMessageId)` là chốt;
  `claimMessageForProcessing` bắt P2002 → skip sạch (race backstop); jobId
  deterministic `microsoft-webhook:{mailboxId}:{graphMessageId}` để BullMQ khử trùng;
  lock per-mailbox bọc try/finally, release cả nhánh lỗi. Layer 2 (internetMessageId)
  + layer 3 (code+time) là lớp bù, layer 3 vẫn live (xem I1/L1).
- **One active mapping per mailbox:** partial unique index `(mailboxId) WHERE
  status='ACTIVE'` ở DB + pre-check app-level + bắt P2002 → conflict thân thiện.
- **Customer isolation đường relay chính:** `resolveDestinationMapping` chặn cứng
  `mailbox.customerId !== destination.customerId`; mapping trỏ destination DISABLED
  trả null (không relay). (Lưu ý: đường **ghi UI/action** còn gap scope — M1.)
- **Encryption-at-rest:** AES-256-GCM, IV ngẫu nhiên 12 byte mỗi lần mã hóa, auth
  tag verify, format versioned `v1:iv:tag:ciphertext`; key validate đúng 32 byte.
- **Secret hygiene logging/masking:** logger redact theo tên key
  (token/secret/password/code/key/auth…), body key truncate + redact; code →
  `sha256:…` không khôi phục; token → `ab****cd`; code-event store từ chối code thô
  (regex 4+ chữ số) và chỉ nhận dạng masked/hashed; không store email body ở bất kỳ
  log store nào; alert/health dùng field đã mask.
- **Reconnect 401 vs 403:** 401/auth → reconnect; 403/forbidden → KHÔNG reconnect,
  self-heal cursor + persistent backoff/cooldown + alert an toàn (TASK-071/074/075),
  đồng bộ giữa delta polling, email pipeline, subscription renewal.
- **Refresh-token failure classification (TASK-069C):** single source of truth, mặc
  định transient để tránh false reconnect; chỉ `invalid_grant`/`interaction_required`
  → reconnect.
- **ClientState webhook:** hash trước khi lưu, so sánh timing-safe, skip notification
  sai clientState **trước** enqueue (skip không bị tính là enqueue failure).
- **Queue fail-safe:** mailbox lock Redis fail-open về no-op handle nhưng **retry mỗi
  call** (self-heal khi Redis hồi phục); exactly-once vẫn được DB constraint bảo đảm
  độc lập với lock.
- **Session/auth theo môi trường:** production/test fail-closed (null), không demo
  user hardcode; staging token có HMAC + giới hạn thời gian.

## 6. Test coverage gaps

| Khu vực | Trạng thái | Ghi chú |
|---------|-----------|---------|
| Dedup exactly-once (layer 1) | Có (tốt) | `tests/unit/email/deduplication.exactly-once.test.ts` |
| Reconnect 401 vs 403 + delta backoff | Có | `tests/unit/microsoft/delta-polling.service.test.ts` |
| Refresh-token classification | Có | `tests/unit/microsoft/refresh-token-failure.test.ts` |
| One-active mapping/mailbox (race) | Có | `tests/unit/telegram/telegram-mapping.one-active-race.test.ts` |
| RBAC scope (read) | Có | `tests/unit/auth/access-scope.test.ts`, `guards.test.ts` |
| Webhook clientState + enqueue-failure 503 | Có | `tests/api/microsoft-webhook-notification.test.ts` (TASK-073) |
| Queue jobId idempotency + global pacer | Có | `tests/unit/queue/*` |
| **Cross-customer create/update/disable/delete isolation (telegram)** | **Thiếu** | M4 — chỉ có test scope read. |
| **Subscription renewal concurrency (2 worker tranh renew)** | **Thiếu** | M2 — chưa có test conditional update / lease. |
| **Layer-3 dedup race (cùng code, khác message-id, trong window)** | **Thiếu** | L1 — chưa test đường code-bucket dưới đua thật. |
| **Redis global pacer re-resolve sau latch** | **Thiếu** | L2 — chưa test hành vi sau khi Redis hồi phục. |
| **Webhook rate-limit** | **N/A** | M3 — chưa có tính năng để test. |

## 7. Live-beta / readiness checklist sau TASK-077

- [x] Exactly-once relay có chốt DB + xử lý race.
- [x] Isolation khách hàng cưỡng chế ở tầng service + DB cho đường relay chính.
- [x] Encryption-at-rest cho refresh token; clientState/code chỉ lưu hash.
- [x] Logging/alert/audit không lộ secret/code/full email (đã soát lại).
- [x] Webhook không bỏ sót notification khi enqueue lỗi (TASK-073 confirmed).
- [x] Reconnect loop 403 + backoff/alert (TASK-071/074/075 confirmed).
- [x] Queue scale-ready + global Telegram pacer + locks (fail-safe confirmed).
- [x] Antigravity migration đúng; source-of-truth nhất quán (TASK-076 confirmed).
- [ ] **RBAC scope wire đủ ở mọi caller mapping/destination** trước khi cấp quyền ghi
      cho role scope-limited (M1/M4).
- [ ] **Guard concurrency subscription renewal** trước khi chạy nhiều replica renewal
      (M2).
- [ ] **Rate-limit/origin webhook** trước khi mở rộng bề mặt public (M3).
- [ ] Dọn layer-3 dedup (constraint hoặc tài liệu hóa) + field/comment gây hiểu nhầm
      (L1).

## 8. Rủi ro còn lại

- **Latent isolation regression (M1/M4):** nếu vội cấp quyền ghi cho role staff
  scope-limited trước khi đóng M1, có thể cho phép thao tác mapping/destination của
  khách khác (omit scope = fail-open ở đường ghi UI/action/disable/delete).
- **Double-PATCH renewal đa-replica (M2):** chỉ an toàn khi đúng một replica renewal;
  scale ngang renewal mà chưa có conditional update sẽ gây tranh chấp.
- **DoS webhook (M3):** endpoint không xác thực/không rate-limit; mỗi POST tốn parse
  + DB lookup.
- **Edge dedup (L1):** hai message cùng code khác message-id trong 5 phút chạy đua có
  thể lọt layer 3 (layer 1/2 phủ duplicate thường).
- **Mất pacing cross-process (L2)** sau latch Redis tới khi restart pod (không chặn
  delivery).
- Một số xác minh dừng ở mức đọc code theo ràng buộc audit-only (không chạy
  production / không gọi Graph-Telegram thật), nên các finding cần test thực trước
  khi đóng.

## 9. Đề xuất thứ tự task tiếp theo sau TASK-077

> Lưu ý đánh số: TASK-072 từng đề xuất số TASK-076/077/078/079 cho các fix này,
> nhưng ROADMAP thực tế đã dùng TASK-076 cho migration reviewer và TASK-077 cho audit
> này. Vì vậy đề xuất số mới bên dưới (điều chỉnh theo thứ tự ROADMAP hiện hành nếu
> cần).

1. **TASK-078 (Medium, ưu tiên cao nhất) — RBAC scope wiring mapping/destination:**
   bắt buộc scope fail-closed ở mọi caller (edit page, server action, disable,
   delete); thêm scope param cho các hàm service đang thiếu; thêm test cross-customer
   create/update/disable/delete (đóng M1 + M4). Làm **trước** khi thêm bất kỳ role
   ghi bị giới hạn scope.
2. **TASK-079 (Medium) — Subscription renewal concurrency guard:** conditional update
   (`WHERE status='ACTIVE'` + affected-count) hoặc lease; loại RENEWING khỏi
   selection; test 2 worker tranh renew (đóng M2). Làm **trước** khi chạy nhiều
   replica renewal.
3. **TASK-080 (Medium) — Webhook rate-limit + origin hardening:** rate-limit theo IP,
   cân nhắc kiểm tra nguồn; giữ validationToken/clientState (đóng M3). Làm **trước**
   khi mở rộng bề mặt public.
4. **TASK-081 (Low cleanup gộp):** layer-3 dedup constraint/tài liệu hóa + dọn field
   `receivedAtBucket` (L1); Redis pacer re-resolve định kỳ (L2); UI readiness/skip/
   renewing badges (L3/L4); renewal window qua env (L5); audit numeric-code guard
   (L6).

## 10. Cần Antigravity CLI review gì

- **M1/M4:** xác nhận đã liệt kê đủ mọi caller đường ghi mapping/destination (không
  sót điểm bỏ scope), và mô hình quyền khi role staff được cấp quyền ghi trong tương
  lai. Xác nhận "omit scope = fail-open" là đánh giá đúng.
- **M2:** tính đúng đắn của đề xuất conditional update / lease so với giả định
  single-runner hiện tại; có rủi ro nào khi đổi sang `updateMany` affected-count.
- **M3:** ranh giới rate-limit cho webhook để không chặn nhầm Microsoft Graph retry
  hợp lệ (TASK-073 dựa vào redeliver).
- **L1/I1:** xác nhận đính chính "layer 3 không phải no-op" là đúng, và đánh giá rủi
  ro race của layer-3 không-constraint là Low (không phải Medium).
- **Tổng thể:** xác nhận không có Critical/High bị bỏ sót ở vùng routing/dedup/
  isolation/secret; xác nhận Antigravity migration không còn workflow hiện hành dùng
  Gemini như reviewer hiện tại.
- Kết luận PASS/FAIL theo `ANTIGRAVITY.md`.

## 11. Lệnh đã chạy

```bash
npm run verify        # PASS — exit 0, 91 files / 1081 tests, lint/typecheck/build sạch
git status --short
git diff --stat
```

Không commit (chờ Antigravity CLI review).
