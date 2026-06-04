# TASK-068D — 100-Mailbox Readiness Validation

## Mục tiêu

Xây dựng validation tối thiểu, an toàn, chạy được trong repo để đánh giá hệ thống
đã sẵn sàng **bắt đầu** test ở mốc khoảng 100 mailboxes hay chưa — bằng synthetic
workload, **không** chạm mailbox khách hàng thật, Telegram group thật, Microsoft
Graph thật, hoặc verification code thật.

## Bối cảnh

- TASK-068A: distributed safety / exactly-once (duplicate collision → clean skip;
  Redis-backed mailbox lock seam; partial unique index một mailbox tối đa một
  ACTIVE mapping).
- TASK-068B: throughput guard (worker concurrency clamp; queue/job rate limit;
  Telegram global bot pacing; busy mailbox fairness/backoff có giới hạn).
- TASK-068C: observability read-only (queue backlog snapshot; worker latency /
  queue wait; throttle/defer aggregate; `/admin/health` cho OWNER/ADMIN; Redis/
  queue lỗi → Unknown/Degraded không crash).

TASK-068D là bước validation tổng hợp cho ~100 mailboxes bằng synthetic workload
trước khi cân nhắc live mailbox thật.

## Phạm vi đã làm

1. **Harness validation tự động** (Vitest integration) cho ~100 synthetic mailboxes,
   chạy qua đúng production code path `processEmailWebhookJob` (worker) →
   `processGraphMessageJob` (pipeline) với in-memory store/lock/throttle/metrics
   thật từ 068A/B/C; chỉ mock biên Microsoft Graph fetch và Telegram send.

2. **Dataset synthetic tối thiểu** (`tests/helpers/scale-readiness-fixtures.ts`):
   - ~10 synthetic customers;
   - 100 ready mailboxes (ACTIVE + một ACTIVE mapping);
   - nhiều mailbox dùng chung một pool nhỏ (~12) reusable Telegram destinations;
   - mỗi mailbox tối đa một ACTIVE destination (theo construction);
   - 6 mailbox DISABLED và 6 mailbox ACTIVE-nhưng-chưa-mapping để kiểm tra skip
     an toàn.

3. **Mock Microsoft Graph / message source**: không gọi Graph thật, không cần
   token, không đọc email thật; subject/body là fixture giả (sender
   `security@facebookmail.com`, code 6 chữ số giả) đủ qua detector + extractor.

4. **Mock Telegram sender**: không gọi Telegram API thật; chỉ đếm send attempt +
   destination (chatId/threadId) + flag `sent`; **không** giữ full code/payload.

5. **Scenarios A–F** (`tests/integration/scale-readiness/100-mailbox-readiness.validation.test.ts`).

6. **Report** `docs/reports/TASK-068D-100-mailbox-readiness-validation.md` với kết
   quả aggregate.

7. **ROADMAP** cập nhật ngắn gọn.

## Scenarios

| # | Nội dung | Kỳ vọng |
|---|----------|---------|
| A | 100 ready mailboxes xử lý synthetic verification message | mọi job CODE_SENT, đúng 100 mock send, mỗi send tới đúng chat của mailbox, store mỗi message SENT một lần |
| B | webhook + delta cùng một `graphMessageId` | lần 2 SKIPPED_DUPLICATE, **đúng một** mock send |
| C | nhiều mailbox dùng chung destination | đúng một send/mỗi message (không broadcast), số send mỗi destination khớp số mailbox gán vào, không gửi tới chat lạ |
| D | mailbox DISABLED / chưa mapping | DISABLED → SKIPPED_MAILBOX_NOT_ACTIVE; unmapped → SKIPPED_NO_TELEGRAM_MAPPING; không relay; phân loại `skipped` (không `failed`) |
| E | busy/defer + throttle/backpressure | defer bị chặn bởi `1 + maxRetries` lần acquire rồi DEFERRED_MAILBOX_BUSY, sau release retry → CODE_SENT một lần; per-send wait ≤ cap (destination 15s, global 2s), không drop message |
| F | observability aggregate | snapshot AVAILABLE, counts nhất quán; `JSON.stringify(snapshot)` không chứa code/email/chatId/token/`facebookmail`/`redis://`; log đã sanitize không chứa full code/token |

## Ngoài scope

Không autoscaling; không production rollout; không validation 300–500 mailboxes;
không mailbox/Telegram group khách hàng thật; không gửi code thật; không gọi
Microsoft Graph/Telegram thật; không sửa `.env*`; không sửa GitHub Actions; không
đổi business rules routing; không multi-destination/broadcast; không đổi throughput
default chỉ để "làm đẹp" test.

## Bảo mật

- Không đọc/in `.env*`; không hardcode secret.
- Không log token, refresh token, client secret, Telegram bot token, database URL,
  Redis URL, encryption key, session secret, full verification code, full email body.
- Report chỉ ghi aggregate metrics + synthetic identifiers rõ ràng là giả.
- Tránh wording dễ gây GitHub Actions secret-scan false positive trong docs.

## Tiêu chí nghiệm thu

- [x] Task file trong `docs/tasks/`.
- [x] Report trong `docs/reports/`.
- [x] Automated validation test chứng minh scenarios A–F.
- [ ] `npm run verify` PASS.
- [ ] Gemini review PASS, không Critical/High.
- [x] Không secret/code/body thật trong diff.
- [x] Không sửa `.env*` / GitHub Actions.
- [x] Không gọi Microsoft Graph/Telegram thật.
- [ ] Roadmap cập nhật ngắn gọn.

## File liên quan

- `tests/helpers/scale-readiness-fixtures.ts`
- `tests/integration/scale-readiness/100-mailbox-readiness.validation.test.ts`
- `docs/reports/TASK-068D-100-mailbox-readiness-validation.md`
- `docs/ROADMAP.md`
