# TASK-073 — Report: Webhook enqueue failure handling

## 1. Tóm tắt kết luận

Đã fix High finding của TASK-072. Microsoft webhook route giờ trả **503** khi có bất
kỳ enqueue thất bại thật sự nào trong request (kể cả partial success), thay vì luôn
trả 202. Microsoft Graph nhờ đó retry cả batch và không còn nguy cơ âm thầm bỏ sót
verification email. validationToken flow và clientState skip behavior giữ nguyên.
`npm run verify` **PASS** (1072 tests).

## 2. Đã thay đổi gì

**Runtime (tối thiểu)** — `app/api/webhooks/microsoft/mail/route.ts`:
- Sau khi `enqueueAcceptedNotifications` chạy xong, tính `hasEnqueueFailure =
  enqueueResult.failed > 0`.
- Nếu có enqueue failure → trả **503** với `ok: false`; nếu không → giữ **202** với
  `ok: true`. Body vẫn chỉ gồm các count tổng hợp an toàn (`received`, `accepted`,
  `skipped`, `enqueued`, `enqueueFailed`) — không thêm payload nhạy cảm.
- Không đổi: validationToken verification (vẫn 200 text/plain, không phụ thuộc
  queue), clientState validation/skip (skip **không** tính là enqueue failure),
  vòng lặp enqueue (vẫn một lần mỗi notification, không retry loop thủ công),
  `enqueueMicrosoftGraphMessageJob`, job options, hay logic jobId.

**Tại sao 503 an toàn để retry:** mỗi job có jobId deterministic
`microsoft-webhook:{mailboxId}:{graphMessageId}` → BullMQ khử trùng job; pipeline có
unique `(mailboxId, graphMessageId)` ở `ProcessedMessage` chặn gửi Telegram trùng.
Vì vậy Microsoft redeliver cả batch không tạo gửi trùng — chỉ phần enqueue hụt được
bù lại.

## 3. File nào đã thay đổi

- `app/api/webhooks/microsoft/mail/route.ts` (runtime, ~32 dòng đổi).
- `tests/api/microsoft-webhook-notification.test.ts` (thêm test).
- `docs/tasks/TASK-073-webhook-enqueue-failure-handling.md` (mới).
- `docs/reports/TASK-073-webhook-enqueue-failure-handling.md` (mới, file này).

## 4. Test nào đã thêm/cập nhật

Thêm describe block "TASK-073 enqueue failure" trong
`tests/api/microsoft-webhook-notification.test.ts` (7 test mới), import thêm
`enqueueMicrosoftGraphMessageJob` (đã mock) để điều khiển failure:

1. 1 notification hợp lệ + enqueue throw → **503**, `ok:false`, `enqueueFailed:1`,
   khẳng định không phải 202.
2. Batch 2 accepted, 1 enqueue fail + 1 success → **503**, `accepted:2`,
   `enqueued:1`, `enqueueFailed:1` (partial vẫn 503).
3. Tất cả enqueue thành công → vẫn **202**, `ok:true`, `enqueueFailed:0`.
4. clientState mismatch → **202**, skip, không enqueue, không thành failure.
5. validationToken verification → **200** text/plain, không enqueue.
6. Mỗi accepted notification enqueue đúng một lần (route không retry loop):
   `enqueueCalls` = 2 và mock called 2 lần.
7. Response 503 không lộ clientState/secret (body chỉ là count envelope).

Test cũ (success 202, các skip case, không lộ clientState) giữ nguyên và vẫn PASS —
các case đó đều có `enqueueFailed=0` nên không bị behavior mới ảnh hưởng.

Lưu ý kỹ thuật test: suite không bật global `clearMocks`. Một test count-sensitive
dùng `mockClear()` (chỉ xóa call history, giữ implementation). Đã tránh leak
`mockRejectedValueOnce` chưa được tiêu thụ giữa các test (test validationToken không
set rejection để không rớt sang test sau).

## 5. npm run verify

**PASS**: db:generate ✓, lint sạch, typecheck sạch, **91 test files / 1072 tests
passed** (thêm 7 so với 1065), build production "Compiled successfully".

## 6. Bảo mật

- Không log/ghi token, refresh token, client secret, Telegram bot token,
  database/Redis URL, encryption key, session secret, full verification code, full
  email body, hay raw clientState.
- Response 503/202 chỉ chứa count tổng hợp; có test khẳng định body không chứa
  `clientState`/`resource`/giá trị clientState.
- Không đọc/in/sửa `.env*`, không gọi Graph thật, không gửi Telegram thật, không
  đụng production database, không sửa GitHub Actions/package scripts.

## 7. Rủi ro / đánh đổi còn lại

- **Microsoft retry cả batch** khi chỉ một phần enqueue hụt → các notification đã
  enqueue thành công sẽ được giao lại; an toàn nhờ jobId deterministic + dedup
  (đã nêu mục 2). Không gửi trùng, chỉ tốn thêm một vòng xử lý idempotent.
- **Out of scope (theo task):** chưa rate-limit endpoint (TASK-078) → 503 path có
  thể bị ép retry; chưa verify origin/signature. Đây là hardening riêng, không thuộc
  TASK-073.
- Hành vi retry thực tế của Microsoft Graph (số lần, khoảng cách) **chưa kiểm chứng
  live** theo ràng buộc không chạm production; logic phía ta đã đúng (trả 503 khi
  fail). Cần xác nhận ở controlled live beta.

## 8. Cần Gemini review phần nào

- Quyết định mã trạng thái: 503 cho mọi enqueue failure (kể cả partial), không dùng
  2xx/207 — có đúng kỳ vọng retry của Microsoft Graph không.
- Ranh giới "skip vs enqueue failure": clientState/subscription-inactive skip
  **không** ép 503 — xác nhận không mở đường cho payload rác ép Microsoft retry.
- Đánh đổi redeliver-cả-batch dựa trên dedup: xác nhận không có kịch bản gửi trùng.
- Chất lượng test (đặc biệt phần tránh leak mock once-implementation giữa các test).

## 9. Lệnh đã chạy & kết quả

```bash
npm run verify        # PASS — 91 files / 1072 tests, lint/typecheck/build sạch
git status --short
git diff --stat
```

Không commit (chờ Gemini review).
