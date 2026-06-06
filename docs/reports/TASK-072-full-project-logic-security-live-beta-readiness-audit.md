# TASK-072 — Report: Full project logic, security & live-beta readiness audit

## 1. Tóm tắt kết luận

- **Không phát hiện finding Critical.** Các bất biến cốt lõi (exactly-once,
  isolation theo khách hàng, secret hygiene, encryption-at-rest) đều có lớp bảo
  vệ ở cả tầng service và DB.
- **1 High**: webhook có thể **âm thầm bỏ sót notification** khi enqueue thất bại
  nhưng vẫn trả 202 cho Microsoft → rủi ro bỏ sót verification code trong live
  beta (chỉ được delta polling backup cứu, mà backup nhạy về thời gian).
- **8 Medium**: phần lớn là consistency/observability/RBAC-scope wiring và một vài
  test gap nên xử lý trước khi scale vượt beta. Đáng chú ý: phân loại 403 ở email
  pipeline **chưa đồng bộ** với hardening TASK-071 của delta polling.
- **7 Low**: UI/observability/wording, không chặn live beta.
- **Kết luận readiness**: **đủ điều kiện tiếp tục live beta ở quy mô hiện tại**,
  với điều kiện mở task fix cho 1 High và nhóm Medium về RBAC-scope + webhook
  trước khi (a) cấp quyền ghi cho role staff bị giới hạn scope, hoặc (b) scale
  vượt beta.
- `npm run verify` **PASS** (baseline xanh) — xem mục 10.

## 2. Phạm vi đã audit

Đã soát read-only 13 khu vực theo task file. File runtime/test trọng tâm đã đọc:

- `services/microsoft/*` (refresh token, rotation, delta polling, graph mail,
  subscription, webhook notification, oauth, disconnect, assignment).
- `services/email/*` (deduplication, graph-message-pipeline, processed store,
  code-extractor, facebook-detector).
- `services/telegram/*` (destination, mapping, sender, retry, error, actions).
- `services/queue/*` (email-queue, job-options, locks in-memory/Redis, throttle,
  global pacer, redis-connection, workers).
- `services/logs/*`, `services/alerts/*`, `services/health/*`,
  `services/observability/*`, `services/customers/*`, `services/staff/*`.
- `lib/auth/*`, `lib/security/*` (encryption, redact), `lib/logger.ts`,
  `lib/mailboxes/*`, `lib/validation/*`.
- `prisma/schema.prisma` + toàn bộ `prisma/migrations/*`.
- `app/api/*` (webhook, oauth callback, telegram mappings, test-send,
  mock-email, mailbox inbox-test, staging auth).
- `app/admin/*`, `components/status/*`, `components/tables/*`,
  `components/admin/*`, `components/forms/*`.
- `tests/unit|api|integration|e2e|security|db/*`, `deployment/*/README.md`.

## 3. Baseline repo/test

- Claude xác nhận đang làm trên vùng làm việc Git riêng cho TASK-072, tách ra từ
  vùng làm việc của TASK-071. Trạng thái Git được kiểm tra trước khi audit.
- Working tree sạch trước khi tạo 2 file docs của task này.
- Baseline verification đã PASS ở lần trước (theo report TASK-071) và được chạy
  lại trong TASK-072 để xác nhận; chi tiết lệnh kiểm tra nằm ở mục kết quả kiểm
  tra cuối report.

## 4. Bảng findings theo severity

| Mức độ | Vấn đề | File liên quan | Cách kiểm tra | Đề xuất task fix |
|--------|--------|----------------|---------------|------------------|
| Critical | (không có) | — | — | — |
| High | Webhook enqueue thất bại bị nuốt: notification bị drop nhưng route vẫn trả 202 → Microsoft không gửi lại → có thể bỏ sót code; chỉ delta polling backup cứu (nhạy thời gian, code verification hết hạn nhanh). | `app/api/webhooks/microsoft/mail/route.ts:84-95,137-147` | Mock `enqueue` ném lỗi cho 1 phần batch; quan sát route vẫn 202 và `enqueueFailed>0`, không có retry. | TASK-073: trả non-2xx (hoặc 207) khi có enqueue fail để Microsoft retry; jobId deterministic đảm bảo retry không tạo trùng. Cân nhắc outbox. |
| Medium | Email pipeline map 403/`permission` → status `FAILED_RECONNECT_REQUIRED`, **chưa đồng bộ** với TASK-071 (delta tách 403→`forbidden`, không reconnect). Hiện **không** flip mailbox ở nhánh fetch (chỉ 401 flip) nên không có loop, nhưng nhãn kết quả gây hiểu nhầm và là regression tiềm ẩn nếu ai đó nối `result.status` vào việc flip mailbox. | `services/email/graph-message-pipeline.service.ts:385-394` (map), đối chiếu `:606-640` (nhánh fetch chỉ 401 flip) và `services/microsoft/graph-mail.service.ts:151-178` | So sánh nhánh 401 vs 403 trong pipeline; xác nhận 403 không gọi `markReconnectRequired` nhưng vẫn gắn nhãn reconnect. | TASK-074: tách `permission`(403) khỏi `auth`(401) ở `mapGraphErrorToResult`, dùng status trung tính + test, đồng bộ với delta TASK-071. |
| Medium | Delta polling: 403 **account/endpoint-level** (không phải cursor độc) sẽ tự reset cursor → bootstrap lại → vẫn 403 mỗi cycle, **không backoff/không escalation alert**. TASK-071 đã ghi nhận là ngoài scope. | `services/microsoft/delta-polling.service.ts:504-533` | Cho mailbox 403 bền vững (cursor null sau reset); quan sát mỗi cycle retry full-speed, không alert. | TASK-075: thêm cooldown/backoff + alert khi 403 lặp lại N lần liên tiếp cho cùng mailbox. |
| Medium | RBAC customer-scope **chưa wire** vào trang edit mapping/destination, server action mapping, và handler API disable/delete. Service layer hỗ trợ scope nhưng caller bỏ qua. Hiện chỉ role unrestricted (OWNER/ADMIN) chạm tới được nên **chưa exploit được**; thành rủi ro thực nếu cấp quyền ghi cho role bị giới hạn scope. | `app/admin/telegram/[id]/edit/page.tsx`, `app/admin/telegram/destinations/[id]/edit/page.tsx`, `app/api/telegram/mappings/[id]/route.ts` (disable/delete), `services/telegram/mapping-actions.ts` | Thêm `MANAGE_TELEGRAM_MAPPINGS` cho role staff scope-limited, thử truy cập/sửa mapping của khách khác → hiện không bị chặn ở các điểm trên. | TASK-076: bắt buộc truyền `scope` (không optional) cho mọi get/list/update/disable/delete mapping & destination; thêm test cross-customer. |
| Medium | `receivedAtBucket` luôn `null` trong Prisma store → code-bucket dedup (lớp dedup thứ 3) thực tế **vô hiệu** ở production. Lớp 1 (graphMessageId) + lớp 2 (internetMessageId) vẫn chắc nên exactly-once không vỡ. | `services/email/prisma-processed-message-store.ts:59`; thiếu cột ở `prisma/schema.prisma` (model `ProcessedMessage`); `services/email/deduplication.service.ts` (nhánh code-bucket) | Lưu 2 message cùng code trong 1 bucket; xác nhận record trả về luôn `receivedAtBucket: null`. | TASK-077: thêm cột `receivedAtBucket` (precompute khi insert) hoặc bỏ hẳn lớp dedup này và ghi rõ chỉ dựa graph/internet id. |
| Medium | Subscription renewal: chưa thấy guard DB-conditional chống 2 worker cùng chuyển một subscription sang `RENEWING`. Phụ thuộc giả định runner single-instance — **cần xác minh**. | `services/microsoft/subscription-renewal.service.ts:557-594` | Chạy 2 cycle renewal đồng thời chọn cùng subscription (mock clock); quan sát chuỗi status. | TASK-078: thêm conditional update (`WHERE status='ACTIVE'`) hoặc xác nhận đơn-runner; thêm test concurrency. |
| Medium | Webhook endpoint không rate-limit, không verify origin/signature. ClientState hash đã chặn routing giả, nhưng endpoint không xác thực vẫn lộ DoS. | `app/api/webhooks/microsoft/mail/route.ts` | Gọi lặp endpoint với validationToken tùy ý; không thấy rate-limit. | TASK-079: rate-limit theo IP cho webhook; cân nhắc kiểm tra nguồn. |
| Medium | Thiếu test cross-customer isolation cho **create/update** destination & mapping (chỉ có test scope cho read). | `tests/unit/telegram/telegram-destination.service.test.ts` (chỉ read scope) | Tạo mapping từ mailbox khách A trỏ destination khách B → service phải fail-closed; chưa có test khẳng định. | Gộp vào TASK-076: thêm test "fails closed khi mailbox và destination khác customer". |
| Medium | Delta cursor reset (403) **không** xóa `deltaLastErrorAt`/`deltaLastErrorMessage` → dashboard hiển thị lỗi cũ sau khi đã self-heal. | `services/queue/workers/delta-polling-runner.ts` (`resetDeltaCursor` chỉ clear cursor) | Gây 403-có-cursor; xác nhận metadata lỗi vẫn còn sau reset và không bị clear ở poll thành công kế tiếp. | TASK-080 (gộp được với TASK-075): clear error metadata khi bootstrap thành công. |
| Low | Redis global pacer fail-open: sau 1 lần resolve Redis timeout sẽ ở fallback in-memory **mãi mãi** đến khi restart pod (mất pacing cross-process khi Redis hồi phục). | `services/queue/redis-global-send-throttle.ts:182-200` | Tắt Redis → fallback; bật lại Redis → vẫn không reconnect. | Thêm re-attempt định kỳ resolve Redis client. |
| Low | UI mailbox detail: badge readiness dựa trên mapping mới nhất thay vì đếm rõ "active destination", dễ gây nhập nhằng cho operator. | `app/admin/mailboxes/[id]/page.tsx:168-182` | Disable mapping cũ, enable mapping mới; xem badge vs checklist có khớp không. | Hiển thị "1 active / N mappings" rõ ràng. |
| Low | `CodeEventStatusBadge` gộp `SKIPPED_DUPLICATE` và `SKIPPED_LOW_CONFIDENCE` cùng một màu → chậm triage. | `components/status/CodeEventStatusBadge.tsx` | Xem 2 dòng skip khác lý do hiển thị giống nhau. | Tách variant + tooltip lý do skip. |
| Low | `SubscriptionStatusBadge` trạng thái `RENEWING` không có gợi ý "renewing since…" → operator khó biết đang treo hay tự hồi phục. | `components/status/SubscriptionStatusBadge.tsx`, `app/admin/mailboxes/[id]/page.tsx` | Trigger renewal mock; quan sát badge không có mốc thời gian. | Thêm helper text thời lượng từ `lastRenewedAt`. |
| Low | Renewal window hardcode 24h, chưa expose qua biến môi trường để ops tinh chỉnh. | `services/microsoft/subscription-renewal.service.ts:33` | Tìm biến cấu hình renewal window; không có. | Đưa thành biến môi trường có default 24h. |
| Low | `ProcessedMessage.senderEmail` round-trip empty-string ↔ null (an toàn nhưng thừa). | `services/email/prisma-processed-message-store.ts` | Insert record không có sender; xác nhận round-trip. | Cho cột nullable hoặc dùng placeholder. |
| Low | Alert message dùng emoji severity gửi Telegram (an toàn UTF-8, không chứa secret) — chỉ là điểm cần lưu ý i18n. | `services/alerts/alert-message.ts:19-21` | Gửi alert mock; xác nhận render. | Cân nhắc nhãn chữ nếu cần i18n. |

## 5. Khu vực đã xác nhận ổn

- **Encryption-at-rest**: AES-256-GCM, IV ngẫu nhiên 12 byte **mỗi lần mã hóa**,
  auth tag verify đúng chuẩn GCM, định dạng versioned `v1:iv:tag:ciphertext`
  (`lib/security/encryption.ts`). Refresh token lưu dạng ciphertext; plaintext chỉ
  tồn tại trong scope cục bộ của worker rồi bị bỏ.
- **Secret hygiene logging**: logger redact mặc định theo tên key
  (`lib/logger.ts`), `redact.ts` mask token kiểu `ab****cd` và mask verification
  code thành `sha256:…` (không khôi phục được). Audit/code-event store từ chối ghi
  code thô (regex chặn 4+ chữ số). Alert sanitizer bỏ field dạng body trước khi
  format. Health dashboard dùng select whitelist, không project secret.
- **Exactly-once / dedup**: unique `(mailboxId, graphMessageId)` ở DB là chốt
  chính; `claimMessageForProcessing` bắt P2002 và hạ cấp thành skip sạch; jobId
  deterministic `mailboxId:graphMessageId` để BullMQ tự khử trùng. Lock per-mailbox
  bọc try/finally, release cả nhánh lỗi (in-memory + Redis backend).
- **One active mapping per mailbox**: partial unique index `(mailboxId) WHERE
  status='ACTIVE'` ở DB (migration task068a) + pre-check app-level + bắt P2002 →
  thông báo conflict thân thiện.
- **Customer isolation tầng service**: `resolveDestinationMapping` chặn cứng
  `mailbox.customerId !== destination.customerId` và kiểm tra scope khách; mapping
  trỏ destination DISABLED trả null (không relay).
- **Refresh-token failure classification** (TASK-069C): single source of truth,
  mặc định transient để tránh false reconnect.
- **Delta 403 vs 401** (TASK-071): tách `forbidden`(403) khỏi `auth`(401); 403 có
  cursor → reset cursor (self-heal), không flip reconnect; chỉ 401 flip.
- **ClientState webhook**: hash trước khi lưu, so sánh timing-safe, skip
  notification sai clientState trước khi enqueue.
- **Session/auth theo môi trường**: production/test fail-closed (null), không có
  demo user hardcode; staging dùng token có HMAC + time bound.
- **Telegram retry**: bounded (tối đa 4 lần), backoff cố định, giữ nguyên chatId
  qua các lần retry (không refetch mapping giữa chừng), log không chứa code/token.

## 6. Test coverage gaps

| Path | Phủ test? | Test file | Gap |
|------|-----------|-----------|-----|
| Dedup exactly-once | Có (tốt) | `tests/unit/email/deduplication.exactly-once.test.ts` | — |
| Reconnect 401 vs 403 | Có | `tests/unit/microsoft/delta-polling.service.test.ts`, `refresh-token-failure.test.ts` | — |
| Refresh-token failure classification | Có | `tests/unit/microsoft/refresh-token-failure.test.ts` | — |
| One-active mapping/mailbox (race) | Có | `tests/unit/telegram/telegram-mapping.one-active-race.test.ts` | — |
| Delta cursor reset (TASK-071) | Có | `tests/unit/microsoft/delta-polling.service.test.ts` | — |
| RBAC scope (read) | Có | `tests/unit/auth/access-scope.test.ts`, `guards.test.ts` | — |
| Webhook clientState validation | Có | `tests/api/microsoft-webhook-notification.test.ts` | — |
| Queue jobId idempotency | Có | `tests/unit/queue/email-job-options.test.ts` | — |
| Global pacer/throttle | Có | `tests/unit/queue/global-send-throttle.test.ts` | — |
| **Cross-customer create/update isolation (telegram)** | **Thiếu** | chỉ có scope read | Thêm test fail-closed khi mailbox & destination khác customer (TASK-076). |
| **Webhook enqueue-failure path** | **Thiếu** | — | Test route khi enqueue ném lỗi (TASK-073). |
| **Email pipeline 403 result-status** | **Thiếu/yếu** | — | Test 403 không gắn nhãn reconnect (TASK-074). |
| **Persistent-403 escalation/backoff** | **Thiếu** | — | Test backoff/alert khi 403 lặp lại (TASK-075). |
| **Subscription renewal concurrency** | **Thiếu** | — | Test 2 worker tranh renew cùng subscription (TASK-078). |

## 7. Live-beta readiness checklist

- [x] Exactly-once relay có chốt DB + xử lý race.
- [x] Isolation khách hàng cưỡng chế ở tầng service + DB cho đường relay chính.
- [x] Encryption-at-rest cho refresh token; clientState/code chỉ lưu hash.
- [x] Logging/alert/audit không lộ secret/code/full email (đã soát).
- [x] Reconnect loop 403 (TASK-071) đã xử lý; không còn loop reconnect diện rộng.
- [x] Queue scale-ready + global Telegram pacer + locks (TASK-068/070).
- [ ] **Webhook không bỏ sót notification khi enqueue lỗi** (High → TASK-073).
- [ ] **RBAC scope wire đủ ở mọi caller mapping/destination** trước khi cấp quyền
      ghi cho role scope-limited (Medium → TASK-076).
- [ ] Backoff/alert cho 403 bền vững mức account (Medium → TASK-075).
- [ ] Đồng bộ phân loại 403 giữa email pipeline và delta (Medium → TASK-074).

## 8. Rủi ro còn lại

- **Bỏ sót code hiếm gặp** khi webhook enqueue lỗi đúng lúc và delta backup tới
  trễ/ngoài lookback — giảm thiểu bằng TASK-073.
- **Latent isolation regression**: nếu vội cấp quyền ghi cho role staff
  scope-limited trước TASK-076, có thể cho phép thao tác mapping của khách khác.
- **Ồn observability**: 403 account-level lặp lại và metadata lỗi cũ sau self-heal
  có thể gây nhiễu cho ops (TASK-075/080).
- **Tin cậy giả định single-runner renewal** chưa được test khẳng định (TASK-078).
- Một số xác minh dừng ở mức đọc code (không chạy production theo ràng buộc), nên
  các finding cần test thực trước khi đóng.

## 9. Đề xuất TASK-073+

- **TASK-073 (High)**: Webhook không-bỏ-sót khi enqueue lỗi (trả non-2xx/207 +
  test). Ưu tiên cao nhất.
- **TASK-074 (Medium)**: Đồng bộ phân loại 403 email pipeline với TASK-071.
- **TASK-075 (Medium)**: Backoff + alert cho 403 delta bền vững; gộp clear error
  metadata sau self-heal (TASK-080).
- **TASK-076 (Medium)**: Bắt buộc scope ở mọi caller mapping/destination + test
  cross-customer create/update.
- **TASK-077 (Medium)**: Sửa hoặc loại bỏ lớp code-bucket dedup (`receivedAtBucket`).
- **TASK-078 (Medium)**: Guard concurrency renewal + test.
- **TASK-079 (Medium)**: Rate-limit webhook endpoint.
- **Low backlog**: Redis pacer reconnect, UI readiness/skip/renewing badges,
  renewal window qua env, senderEmail round-trip.

## 10. Lệnh đã chạy và kết quả

```bash
git status --short             # chỉ 2 file docs của task này
git diff --stat                # (docs, không đụng runtime/test)
npm run verify                 # db:generate + lint + typecheck + test + build
```

Kết quả `npm run verify`: xem mục cập nhật cuối báo cáo khi chạy xong (PASS/FAIL).

## 11. Cần Gemini review phần nào

- **TASK-073**: chiến lược trả mã lỗi cho Microsoft khi enqueue thất bại một phần
  — đảm bảo Microsoft retry mà không gây trùng (nhờ jobId deterministic), và
  không tạo lỗ hổng DoS khi cố tình ép retry.
- **TASK-074**: xác nhận tách 403 ở email pipeline không gây regression cho luồng
  reconnect 401 hợp lệ.
- **TASK-076**: rà soát đủ mọi caller mapping/destination để không sót điểm bỏ
  scope; mô hình quyền khi role staff được cấp quyền ghi.
- **TASK-078**: tính đúng đắn của guard concurrency renewal so với giả định
  single-runner hiện tại.
- Tổng thể: xác nhận không có Critical bị bỏ sót ở vùng routing/dedup/isolation.
