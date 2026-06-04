# TASK-069C — Harden Refresh Token Failure Classification in Email Worker & Delta Polling

## Mục tiêu

Một mailbox đang khỏe KHÔNG được rơi vào `RECONNECT_REQUIRED` chỉ vì một lỗi
refresh token **tạm thời** (network, timeout, Microsoft 429, Microsoft 5xx, hoặc
lỗi chưa rõ có khả năng tạm thời). Mailbox chỉ nên bị đánh dấu cần reconnect khi
refresh token **thật sự** không còn dùng được và bắt buộc người dùng đăng nhập
lại — tức Microsoft trả `invalid_grant` hoặc `interaction_required`.

## Bối cảnh / root cause (code-level)

- `subscription-renewal-runner.ts` đã phân loại tương đối đúng: token endpoint trả
  mã thu hồi (`invalid_grant` / `interaction_required`) → `reconnect_required`;
  network → `transient`; còn lại → `transient`.
- Nhưng `email-worker-runner.ts` và `delta-polling-runner.ts` gom MỌI lỗi refresh
  (decrypt fail, network, 429, 5xx, invalid_grant…) thành một lỗi `refresh_failed`
  chung chung. Tầng tiêu thụ (`graph-message-pipeline.service.ts`,
  `delta-polling.service.ts`) khi đó gọi `markReconnectRequired` **vô điều kiện**.
- Hệ quả: một blip mạng / Microsoft 5xx có thể đẩy nhầm mailbox khỏe sang
  `RECONNECT_REQUIRED`, khiến mailbox ngừng đọc mail tới khi có người reconnect
  thủ công — dù chỉ cần retry chu kỳ sau là xong (dương tính giả).
- Thông tin để phân biệt đã có sẵn: `refreshMicrosoftAccessToken` ném
  `RefreshAccessTokenError` kèm `kind` + `microsoftErrorCode`, nhưng hai worker này
  `catch` trống và vứt bỏ thông tin đó.

## Scope được làm

1. Tạo helper phân loại dùng chung `services/microsoft/refresh-token-failure.ts`:
   - `REVOKED_GRANT_ERROR_CODES` = `{ invalid_grant, interaction_required }`.
   - `classifyRefreshTokenError(error)` → `reconnect_required | transient | config`
     dựa trên `RefreshAccessTokenError.kind` + `microsoftErrorCode`. Lỗi không rõ →
     `transient` (không bao giờ "brick" mailbox vì một lỗi lạ).
   - `shouldMarkReconnectRequired(error)` — đọc trường `classification` (duck-typed)
     trên token error mà worker ném ra; chỉ `true` khi `reconnect_required`.
2. Áp dụng nhất quán cho đường **email worker** và **delta polling**:
   - Token port gắn `classification` vào lỗi ném ra (missing/decrypt → reconnect;
     refresh exchange → theo `classifyRefreshTokenError`).
   - Tầng tiêu thụ chỉ `markReconnectRequired` khi `shouldMarkReconnectRequired`.
   - Lỗi transient: KHÔNG đổi status; để cơ chế retry sẵn có chạy lại chu kỳ sau.
3. Chuẩn hóa `subscription-renewal-runner.ts` để dùng cùng helper — **giữ nguyên
   behavior** (đã được test khóa).
4. Thêm `FAILED_TOKEN_TRANSIENT` vào pipeline email để đường này vẫn retryable qua
   BullMQ nhưng KHÔNG đánh dấu reconnect.

## Scope KHÔNG làm

- Không sửa UI reconnect đã chốt ở TASK-069B.
- Không đổi OAuth scope / Microsoft App Registration.
- Không sửa routing, Telegram mapping, reusable destination.
- Không đổi queue throughput / concurrency / limiter.
- Không đụng multilingual detection (TASK-069A).
- Không chạy live beta / live mailbox E2E.
- Không tạo migration / không đổi schema (dùng `MailboxStatus` sẵn có).
- Không sửa `.env*`; không nới lỏng secret scan; không thao tác production DB.

## Thay đổi chính

### Logic chung (testable, thuần)
- **MỚI** `services/microsoft/refresh-token-failure.ts`: helper phân loại + đọc
  classification.

### Email worker
- `services/queue/workers/email-worker-runner.ts`: `EmailWorkerTokenError` mang
  thêm `classification`; token port phân loại lỗi refresh exchange.
- `services/email/graph-message-pipeline.service.ts`: thêm trạng thái
  `FAILED_TOKEN_TRANSIENT`; nhánh lấy token chỉ mark reconnect khi classification là
  `reconnect_required`, ngược lại trả `FAILED_TOKEN_TRANSIENT` (retryable, không
  mark).
- `services/queue/workers/email-worker.ts`: thêm `FAILED_TOKEN_TRANSIENT` vào danh
  sách trạng thái retryable.

### Delta polling
- `services/queue/workers/delta-polling-runner.ts`: `DeltaPollingTokenError` mang
  thêm `classification`; token port phân loại lỗi refresh exchange.
- `services/microsoft/delta-polling.service.ts`: chỉ `markReconnectRequired` khi
  classification là `reconnect_required`; lỗi transient vẫn ghi error metadata +
  đếm failed, KHÔNG đổi status (mailbox giữ ACTIVE, chu kỳ sau retry).

### Subscription renewal (chuẩn hóa, không đổi behavior)
- `services/queue/workers/subscription-renewal-runner.ts`: dùng
  `classifyRefreshTokenError` thay cho Set + nhánh phân loại nội bộ.

## Tests

- **MỚI** `tests/unit/microsoft/refresh-token-failure.test.ts`: phủ từng mã lỗi
  (invalid_grant, interaction_required, network, 429, 5xx, config, unknown).
- `tests/unit/queue/email-worker-runner.test.ts`: invalid_grant /
  interaction_required → classification `reconnect_required`; network / 429 / 5xx →
  `transient`.
- `tests/unit/email/graph-message-pipeline.service.test.ts`: reconnect_required →
  `markReconnectRequired` + `FAILED_RECONNECT_REQUIRED`; transient → KHÔNG mark +
  `FAILED_TOKEN_TRANSIENT`.
- `tests/unit/queue/delta-polling-runner.test.ts`: invalid_grant /
  interaction_required → `reconnect_required`; network / 429 / 5xx → `transient`.
- `tests/unit/microsoft/delta-polling.service.test.ts`: reconnect_required → mark;
  transient → KHÔNG mark, mailbox vẫn ACTIVE, có ghi error metadata.
- `tests/unit/queue/email-worker.test.ts`: `FAILED_TOKEN_TRANSIENT` vẫn retryable.
- `tests/unit/queue/subscription-renewal-runner.test.ts`: behavior cũ giữ nguyên.

## Bảo mật

- Không đọc/in `.env*`. Không log access token, refresh token, authorization code,
  client secret, bot token, full verification code, full email body.
- Lỗi chỉ log metadata an toàn qua `createLogger()` (mailboxId, errorName, phân
  loại). Helper phân loại chỉ đọc `kind` + mã lỗi OAuth, không chạm token plaintext.

## Lệnh kiểm tra

```bash
npm run verify
```

## Tiêu chí nghiệm thu

- Email worker & delta polling chỉ `markReconnectRequired` với `invalid_grant` /
  `interaction_required`.
- network / timeout / 429 / 5xx KHÔNG còn đẩy mailbox sang `RECONNECT_REQUIRED`;
  mailbox giữ ACTIVE và được retry chu kỳ sau.
- Subscription renewal behavior cũ không bị phá.
- `npm run verify` PASS.
