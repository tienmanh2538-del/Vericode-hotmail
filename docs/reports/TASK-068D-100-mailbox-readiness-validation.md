# Report — TASK-068D: 100-Mailbox Readiness Validation

Status: **DONE** — `npm run verify` PASS (951 tests; lint/typecheck/build sạch).
Gemini review: pending.

## 1. Bối cảnh & mục tiêu

TASK-068A/B/C đã đóng distributed safety/exactly-once, scale-ready throughput, và
observability read-only. TASK-068D là bước **validation tổng hợp** bằng synthetic
workload để xác nhận hệ thống đã sẵn sàng **bắt đầu** test ở mốc ~100 mailboxes,
trước khi cân nhắc live mailbox thật. Toàn bộ chạy bằng dữ liệu giả/mock — không
mailbox khách hàng thật, không Telegram group thật, không Microsoft Graph thật,
không gửi verification code thật.

## 2. Cách tiếp cận

Harness chạy qua **đúng production code path**, chỉ mock hai biên ngoài:

```
makeWebhookJob / makeDeltaJob
   → processEmailWebhookJob          (worker thật — TASK-027/068C)
       → processGraphMessageJob      (pipeline thật)
           → ProcessedMessage store  (in-memory thật — exactly-once 068A)
           → mailbox processing lock  (in-memory thật — 055/068A)
           → destination + global throttle (in-memory thật — 055/068B)
           → worker-metrics recorder  (builders + aggregateBuckets thật — 068C)
           → Microsoft Graph fetch    (MOCK — không gọi Graph thật)
           → Telegram send            (MOCK đếm — không gọi Telegram thật)
```

Việc giữ store/lock/throttle/metrics **thật** (chỉ mock Graph/Telegram) khiến các
seam của 068A/B/C được kiểm chứng thực sự, không phải mock rỗng.

## 3. Dataset synthetic (tất cả là giả)

| Nhóm | Số lượng | Đặc điểm |
|------|----------|----------|
| Customers | 10 | `cust-00..09`, tên "Synthetic Customer NN (FAKE)" |
| Ready mailboxes | 100 | ACTIVE + một ACTIVE mapping; gán round-robin vào pool destination |
| Reusable destinations | 12 | chatId `-100900000NNNN`; một nửa có forum topic threadId |
| DISABLED mailboxes | 6 | có mapping nhưng mailbox không ACTIVE |
| Unmapped mailboxes | 6 | ACTIVE nhưng không có active mapping |

- Mỗi mailbox tối đa **một** ACTIVE destination (đảm bảo bằng construction).
- 100 ready mailboxes chia sẻ chỉ 12 destinations ⇒ nhiều mailbox dùng chung
  destination (đúng pattern reusable destination của TASK-053/041).
- Synthetic verification email: sender `security@facebookmail.com`, subject "Your
  Facebook security code", body chứa **code 6 chữ số giả**; đủ qua detector
  (confidence ≥ 70) + extractor.

## 4. Kết quả theo scenario

| # | Scenario | Kết quả aggregate | PASS |
|---|----------|-------------------|------|
| A | 100 ready mailboxes relay | 100/100 CODE_SENT; **đúng 100** mock send; mỗi send tới đúng chat của mailbox; store 100 row SENT; metrics completed=100, failed=0, deferred=0, skipped=0 | ✅ |
| B | webhook + delta cùng `graphMessageId` | lần 1 CODE_SENT, lần 2 SKIPPED_DUPLICATE (`duplicate_graph_message_id`); **đúng 1** mock send; metrics completed=1, skipped=1 | ✅ |
| C | nhiều mailbox chung destination | **đúng 1** send/message (100 send, không broadcast); số send mỗi destination khớp số mailbox gán; không gửi tới chat lạ | ✅ |
| D | DISABLED / unmapped | DISABLED → SKIPPED_MAILBOX_NOT_ACTIVE; unmapped → SKIPPED_NO_TELEGRAM_MAPPING; **0** send; metrics skipped=12, failed=0 | ✅ |
| E (defer) | mailbox busy | acquire đúng `1 + maxRetries` (=4) lần rồi DEFERRED_MAILBOX_BUSY; sau release retry → CODE_SENT một lần; metrics deferred=1, completed=1, mailboxBusyDefer=1 | ✅ |
| E (throttle) | 30 mailbox → 1 destination | tất cả 30 vẫn gửi (không drop); destination wait ≤ 15s cap; global wait ≤ 2s cap; throttle thực sự được kích hoạt (count > 0) | ✅ |
| F | observability aggregate | snapshot AVAILABLE; queueWait/processing count=100; `JSON.stringify(snapshot)` không chứa code/email/chatId/token/`facebookmail`/`redis://`; log đã sanitize không chứa full code/token | ✅ |

Tổng: **7 test** trong file validation, tất cả PASS (~190ms).

## 5. Đánh giá độ sẵn sàng

- **Exactly-once**: giữ vững ở quy mô — webhook + delta race cho cùng message chỉ
  relay một lần (Scenario B), không double-send ở 100-mailbox batch (Scenario A).
- **Routing đúng & không broadcast**: nhiều mailbox dùng chung destination vẫn
  route đúng từng message, đúng một send mỗi message (Scenario C).
- **Skip an toàn**: mailbox DISABLED hoặc chưa mapping không bao giờ relay, và được
  phân loại `skipped` (không `failed`) nên worker không retry vô ích (Scenario D).
- **Backpressure có giới hạn**: defer chặn bởi `maxRetries`, throttle wait chặn bởi
  cap (15s/2s); không retry vô hạn, không drop message (Scenario E).
- **Observability an toàn**: aggregate chỉ gồm count/ms; không lộ payload/email/
  code/token/chat/Redis URL (Scenario F).

⇒ Theo synthetic validation, hệ thống đã đủ điều kiện **bắt đầu** test ở mốc ~100
mailboxes. Đây **chưa** phải bằng chứng tải thật với mailbox/Telegram/code thật.

## 6. Bảo mật

- Không đọc/in `.env*`; không hardcode secret; không gọi Microsoft Graph/Telegram
  thật; không token thật.
- Telegram sender mock chỉ giữ destination + flag, **không** giữ payload/full code.
- Scenario F khẳng định snapshot và log đã sanitize không chứa code/email/chatId/
  token/`facebookmail`/`redis://`.
- Identifier trong dataset rõ ràng là giả (`@synthetic.invalid`, `(FAKE)`, chatId
  `-100900000xxxx`, code 6 chữ số giả) để tránh secret-scan false positive.

## 7. Ngoài scope / deferred

- Không autoscaling, không production rollout, không validation 300–500 mailboxes.
- Không live mailbox/Telegram/code thật — live path để internal beta / product trial.
- Throttle clock được inject cố định để deterministic; số liệu wait là minh hoạ cơ
  chế bị-chặn, không phải benchmark wall-clock thật.
- Lock in-memory một tiến trình (đa tiến trình dùng Redis lock seam của 068A).

## 8. File liên quan

- `tests/helpers/scale-readiness-fixtures.ts`
- `tests/integration/scale-readiness/100-mailbox-readiness.validation.test.ts`
- `docs/tasks/TASK-068D-100-mailbox-readiness-validation.md`
- `docs/ROADMAP.md`

## 9. Kết quả kiểm tra

- `npm run verify` PASS: 951 tests (944 + 7 mới), lint/typecheck/build sạch.
- Gemini review: pending.
