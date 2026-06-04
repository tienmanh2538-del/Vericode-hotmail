# Báo cáo TASK-069C — Harden Refresh Token Failure Classification in Email Worker & Delta Polling

## Tóm tắt

Trước task này, email worker và delta polling gom MỌI lỗi refresh token (kể cả
lỗi tạm thời như mạng, timeout, Microsoft 429/5xx) thành một lỗi chung rồi đánh
dấu mailbox cần reconnect. Hệ quả là một mailbox khỏe có thể bị buộc reconnect
thủ công chỉ vì một blip thoáng qua.

Đã chuẩn hóa logic phân loại dùng chung cho cả ba worker. Giờ một mailbox chỉ bị
chuyển sang trạng thái cần reconnect khi refresh token thật sự không còn dùng
được (Microsoft trả `invalid_grant` hoặc `interaction_required`), hoặc khi mailbox
không có / không giải mã được credential. Lỗi tạm thời để cơ chế retry sẵn có chạy
lại chu kỳ sau, không đổi trạng thái mailbox.

## Đã thay đổi gì

1. Thêm helper phân loại dùng chung làm nguồn sự thật duy nhất cho cả ba worker:
   - Tập mã thu hồi hẹp: `invalid_grant`, `interaction_required`.
   - `classifyRefreshTokenError(error)` → `reconnect_required | transient | config`.
     Lỗi không rõ → `transient` (không bao giờ làm hỏng một mailbox khỏe).
   - `shouldMarkReconnectRequired(error)` — đọc trường phân loại trên lỗi token mà
     worker ném ra (duck-typed), chỉ true khi `reconnect_required`.
2. Email worker:
   - Token port gắn phân loại vào lỗi ném ra (thiếu/không giải mã được → reconnect;
     lỗi exchange → theo helper phân loại).
   - Pipeline chỉ đánh dấu reconnect khi phân loại là `reconnect_required`; lỗi tạm
     thời trả trạng thái mới `FAILED_TOKEN_TRANSIENT` (vẫn retryable qua BullMQ,
     KHÔNG đổi trạng thái mailbox).
3. Delta polling:
   - Token port gắn phân loại tương tự.
   - Service chỉ đánh dấu reconnect khi phân loại là `reconnect_required`; lỗi tạm
     thời vẫn ghi error metadata + đếm failed nhưng giữ mailbox ACTIVE để chu kỳ
     sau retry.
4. Subscription renewal: chuyển sang dùng helper phân loại chung. Behavior cũ được
   giữ nguyên (đã được test khóa).

## File đã thay đổi

Code:
- `services/microsoft/refresh-token-failure.ts` (mới — helper phân loại dùng chung)
- `services/queue/workers/email-worker-runner.ts`
- `services/email/graph-message-pipeline.service.ts`
- `services/queue/workers/email-worker.ts`
- `services/queue/workers/delta-polling-runner.ts`
- `services/microsoft/delta-polling.service.ts`
- `services/queue/workers/subscription-renewal-runner.ts`

Tests:
- `tests/unit/microsoft/refresh-token-failure.test.ts` (mới)
- `tests/unit/queue/email-worker-runner.test.ts`
- `tests/unit/queue/delta-polling-runner.test.ts`
- `tests/unit/email/graph-message-pipeline.service.test.ts`
- `tests/unit/microsoft/delta-polling.service.test.ts`
- `tests/unit/queue/email-worker.test.ts`

Docs:
- `docs/tasks/TASK-069C-refresh-token-failure-classification-workers.md` (mới)
- `docs/reports/TASK-069C-refresh-token-failure-classification-workers.md` (mới)
- `docs/ROADMAP.md`

## Test đã thêm / cập nhật

- Helper phân loại (mới): phủ `invalid_grant`, `interaction_required`, network,
  Microsoft 429, Microsoft 5xx, config, và lỗi không rõ.
- Email worker token port: `invalid_grant` / `interaction_required` → reconnect;
  network / 429 / 5xx → transient; thiếu credential → reconnect.
- Pipeline email: reconnect → đánh dấu + `FAILED_RECONNECT_REQUIRED`; transient →
  KHÔNG đánh dấu + `FAILED_TOKEN_TRANSIENT`.
- Delta polling token port: cùng bộ phân loại như email worker.
- Delta polling service: reconnect → đánh dấu; transient → KHÔNG đánh dấu, mailbox
  vẫn ACTIVE, vẫn ghi error metadata.
- Email worker wiring: `FAILED_TOKEN_TRANSIENT` vẫn được retry.
- Subscription renewal: bộ test cũ vẫn xanh (behavior không đổi).

## Lệnh đã chạy & kết quả

```bash
npm run verify
```

- Lint (eslint): PASS
- Typecheck (tsc --noEmit): PASS
- Test (vitest): PASS — 90 test files, 1049 tests
- Build (next build): PASS

## Bảo mật

- Không đọc/in nội dung file môi trường.
- Không log access token, refresh token, authorization code, client secret, bot
  token, full verification code, hay full email body.
- Helper phân loại chỉ đọc loại lỗi + mã lỗi OAuth (vd `invalid_grant`), không chạm
  token plaintext, không tự log.
- Lỗi chỉ log metadata an toàn qua logger sẵn có (mailboxId, errorName).

## Rủi ro còn lại

- Lỗi giải mã credential vẫn được xếp là cần reconnect (đồng nhất với renewal đã
  có từ trước). Nếu khóa mã hóa bị đổi/cấu hình sai trên diện rộng, nhiều mailbox
  có thể cùng bị xếp cần reconnect. Đây là sự cố vận hành cấu hình, nằm ngoài phạm
  vi task này; có thể tách thành một task riêng để phân biệt "credential hỏng theo
  mailbox" với "cấu hình khóa sai toàn hệ thống".
- Phân loại dựa trên mã lỗi do Microsoft trả về; nếu Microsoft đổi mã lỗi trong
  tương lai, cần cập nhật tập mã thu hồi.

## Task tiếp theo cần chú ý

- Cần Gemini review độc lập phần phân loại lỗi và ngưỡng đánh dấu reconnect.
- Khi chạy live mailbox sau này, nên theo dõi số lần đánh dấu cần reconnect so với
  số lỗi tạm thời để xác nhận hết dương tính giả; cân nhắc thêm chỉ số quan sát.
