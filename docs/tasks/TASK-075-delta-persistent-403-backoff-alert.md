# TASK-075 — Delta persistent 403 backoff/alert

## Bối cảnh

TASK-072 audit ghi nhận một finding **Medium** còn mở sau khi TASK-071 (delta 403 vs
reconnect loop) và TASK-074 (đồng bộ phân loại 403 ở email pipeline) đã đóng:

> Delta polling: 403 **account/endpoint-level** (không phải cursor độc) sẽ tự reset
> cursor → bootstrap lại → vẫn 403 mỗi cycle, **không backoff/không escalation alert**.

Sau TASK-071, một 403 trên Graph data request KHÔNG còn flip mailbox sang
`RECONNECT_REQUIRED` (đúng — refresh grant vẫn khỏe), và một 403 trên cursor đã lưu sẽ
reset cursor để self-heal. Nhưng với 403 mức tài khoản/endpoint (ví dụ
`MailboxNotEnabledForRESTAPI`, `ErrorAccessDenied`), sau khi reset cursor và bootstrap
lại thì **vẫn 403 mỗi ~30s**: poller retry full-speed vô hạn (mỗi cycle còn gọi cả token
endpoint để mint access token) và **im lặng** — OWNER/ADMIN không có tín hiệu.

TASK-075 chỉ xử lý finding này. Gộp luôn finding **Medium** liên quan (audit gọi là
TASK-080): "delta cursor reset (403) không xóa `deltaLastErrorAt`/`deltaLastErrorMessage`
→ dashboard hiển thị lỗi cũ sau khi đã self-heal" — clear stale error metadata khi poll
thành công.

## Mục tiêu

1. Giữ nguyên self-heal TASK-071: 403 có cursor → reset cursor; 403 lúc bootstrap (cursor
   null) → không reset, chỉ retry.
2. 403 account/endpoint-level lặp lại **không** flip mailbox sang `RECONNECT_REQUIRED`.
3. Không retry full-speed vô hạn mỗi cycle: thêm **persistent backoff/cooldown theo
   mailbox**, lưu DB để sống qua worker restart.
4. Thêm **health/alert signal an toàn** cho OWNER/ADMIN khi 403 lặp lại vượt ngưỡng.
5. Reset/clear state backoff + stale error metadata khi poll thành công / self-heal thành công.
6. Giữ delta polling backup, refresh-token classification (TASK-069C), email pipeline 403
   classification (TASK-074), dedup exactly-once.

## Phạm vi

### Được làm
- Sửa tối thiểu `services/microsoft/delta-polling.service.ts` (logic backoff + cooldown
  skip + alert port + clear-on-success) và `services/queue/workers/delta-polling-runner.ts`
  (Prisma repo + alert wiring).
- Thêm 2 cột vào `Mailbox` (`deltaForbiddenCount`, `deltaForbiddenCooldownUntil`) + migration
  để persistent backoff sống qua restart.
- Thêm/điều chỉnh test unit cho delta polling 403 backoff/alert.
- Thêm task file + report.

### KHÔNG làm
- Không sửa webhook enqueue failure (TASK-073 đã xong).
- Không sửa email pipeline Graph 403 classification (TASK-074 đã xong).
- Không sửa RBAC/customer-scope wiring; không sửa dedup `receivedAtBucket`; không sửa
  subscription renewal concurrency; không thêm webhook rate-limit; không UI cleanup lớn;
  không scale test; không live Microsoft/Telegram test.
- Không sửa `.env*`; không sửa GitHub Actions.

## Thiết kế

### Trạng thái persistent (DB)
Thêm vào `Mailbox`:
- `deltaForbiddenCount Int @default(0)` — số cycle forbidden **liên tiếp**.
- `deltaForbiddenCooldownUntil DateTime?` — thời điểm mailbox được poll lại; trước đó thì skip.

Cả hai an toàn mặc định (count 0, cooldown null) nên mailbox hiện có không đổi hành vi.
Status mailbox **không bao giờ** bị hai cột này thay đổi (403 không phải dead grant).

### Backoff model (per mailbox)
- Mỗi cycle 403 liên tiếp tăng count.
- Dưới ngưỡng (`DEFAULT_FORBIDDEN_BACKOFF_THRESHOLD = 3`): giữ full-speed để self-heal
  cursor TASK-071 còn cơ hội phục hồi nhanh khi chỉ là cursor độc.
- Tại/quá ngưỡng: đặt cooldown **luỹ thừa, có cap** — `5 phút × 2^(count − threshold)`, tối
  đa `60 phút`. Khi mailbox đang cooldown, cycle kế **skip hoàn toàn** mailbox đó (không
  fetch token, không gọi Graph) và **không** tính là failure của cycle.
- Khi vào cooldown: raise **một** alert an toàn (best-effort). Việc skip trong cooldown tự
  giãn nhịp re-alert (mỗi cửa sổ cooldown nhiều nhất một alert).
- Poll thành công: clear count + cooldown + stale error metadata.

### Alert an toàn
Đi qua kênh admin alert sẵn có (TASK-035, Telegram cho OWNER/ADMIN, tự skip khi chưa cấu
hình admin channel/bot). Tái dùng alert type `DELTA_POLLING_FAILED` (severity WARNING) để
không mở rộng taxonomy. Payload chỉ gồm trường đã mask/an toàn: mailbox id (cuid), email đã
mask, số lần forbidden liên tiếp, thời điểm hết cooldown, và diagnostics dạng enum-code
(`code=… inner=… reqId=…`). **Không** chứa access/refresh token, client secret, bot token,
DB/Redis URL, encryption key, session secret, full verification code, full email body, hay
raw Graph error message/body. Alert sanitizer của TASK-035 là lớp phòng thủ thứ hai.

## Test bắt buộc (đã phủ)

1. 403 có cursor → reset cursor (self-heal TASK-071) + không reconnect.
2. 403 lặp lại (cursor null/bootstrap) đạt ngưỡng → tăng count + đặt cooldown + không
   `markReconnectRequired`.
3. Mailbox đang cooldown → skip (không gọi Graph, không token fetch, không fail cycle); và
   cooldown đã hết → poll lại bình thường.
4. 403 vượt ngưỡng → alert an toàn cho OWNER/ADMIN, không chứa token/secret/full code/full
   email/raw Graph body; dưới ngưỡng → không alert.
5. Poll thành công sau streak → clear count/cooldown + stale error metadata.
6. 401/auth vẫn reconnect-required (và không tạo forbidden-backoff).
7. Refresh-token classification TASK-069C giữ nguyên (transient không reconnect).
8. Không phá dedup exactly-once/routing/Telegram sender/webhook (TASK-073) — ngoài file này.

## Rủi ro còn lại

- Đây là **synthetic** — chưa xác minh live với Microsoft Graph thật; `error.code` mức tài
  khoản thật sẽ xuất hiện ở `deltaLastErrorMessage`/alert ở lần fail kế tiếp nhờ logging.
- Cooldown serialize per-process theo state DB (mỗi cycle đọc lại) nên đa-replica vẫn nhất
  quán qua DB; nhưng số nhịp thật cần quan sát ở controlled live beta.
- Lỗi giải mã credential vẫn xếp reconnect (đồng nhất TASK-069C) — ngoài phạm vi 403.

## File liên quan

- `services/microsoft/delta-polling.service.ts`
- `services/queue/workers/delta-polling-runner.ts`
- `prisma/schema.prisma`, `prisma/migrations/20260608000000_task075_delta_forbidden_backoff/migration.sql`
- `tests/unit/microsoft/delta-polling.service.test.ts`
- `docs/reports/TASK-075-delta-persistent-403-backoff-alert.md`
