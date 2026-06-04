# TASK-070 — Redis-backed Global Telegram Bot Pacer

> Scale-readiness follow-up. Xuất phát từ một issue **Medium** trong Gemini review
> tổng quát sau TASK-069C: global Telegram bot pacer hiện tại
> (`services/queue/global-send-throttle.ts`, thêm ở TASK-068B) là **in-memory**.

## 1. Bối cảnh

TASK-068B đã thêm một global bot pacer đặt trước mọi lần gửi Telegram, bổ sung cho
per-destination throttle (TASK-055). Nó pace **toàn bộ** send của bot vào một slot
chung (~40ms/slot ⇒ ≤ ~25 send/giây, dưới ngưỡng ~30/giây của bot), có cap thời gian
chờ mỗi send (2s) và không đổi routing.

Hạn chế: pacer đó là **in-memory / per-process**. Khi deploy nhiều worker-email
process/replica (mục tiêu scale ~100 mailboxes — xem TASK-068A→D), mỗi replica giữ
quota pacing riêng. Tổng tốc độ gửi qua một bot = tổng của tất cả replica → có thể
vượt ngưỡng bot Telegram dù mỗi process vẫn "đúng nhịp" của riêng nó.

Hạ tầng đã có sẵn để giải quyết:
- TASK-068A: Redis-backed per-mailbox lock cross-process (Lua compare-and-delete,
  fail-safe khi Redis lỗi) — mẫu `mailbox-lock-factory` (in-memory vs Redis).
- TASK-068C: Redis-backed worker metrics tái dùng client ioredis có sẵn của BullMQ
  (không thêm dependency ioredis top-level, không mở socket lúc import).

## 2. Mục tiêu

Cung cấp một **Redis-backed global Telegram bot pacer** để nhiều worker
process/replica chia sẻ MỘT quota pacing toàn cục, mà KHÔNG:
- phá exactly-once (TASK-068A) hoặc routing / reusable destinations,
- đổi số lần gửi (chỉ điều tiết **thời điểm** gửi),
- gửi trùng / broadcast / đổi Telegram destination,
- chờ vô hạn (giữ cap thời gian chờ của TASK-068B),
- crash delivery khi Redis không sẵn sàng (fail-safe).

## 3. Business rules giữ nguyên (không đổi)

- App internal staff, khách không login.
- Nhiều mailbox dùng chung một reusable Telegram destination; mỗi mailbox tối đa một
  active destination.
- Mailbox DISABLED / chưa mapping hợp lệ không relay.
- Không multi-destination / không broadcast; không đổi routing.

## 4. Phạm vi được làm

1. Thêm Redis-backed global pacer **đằng sau cùng interface** `GlobalSendThrottle`
   hiện có, để pipeline không phải rẽ nhánh. `reserve()` trở thành
   `DestinationReservation | Promise<DestinationReservation>` (in-memory vẫn đồng bộ,
   Redis trả Promise) — pipeline `await` kết quả.
2. Reserve toàn cục atomic bằng một Lua script trên **một** Redis key chung, mô phỏng
   đúng logic spacing của `destination-throttle` (now / interval / cap) nhưng server-side
   để nhiều process serialize trên cùng một slot.
3. Giữ **cap thời gian chờ** mỗi send (maxWaitMs) và **default pacing an toàn** đã có từ
   TASK-068B (40ms/slot, cap 2s).
4. Factory `createGlobalSendThrottle` chọn backend: không có Redis client → in-memory
   (behavior hiện tại không đổi); có → Redis-backed. Mirror `mailbox-lock-factory`.
5. Wire vào `email-worker-runner` cho production path **nếu `REDIS_URL` được cấu hình**
   (tái dùng client ioredis của BullMQ như TASK-068C, không thêm socket/dependency).
   Không có `REDIS_URL` (local/test) → in-memory.
6. **Fail-safe:** Redis không reachable (resolve client lỗi/timeout, hoặc eval lỗi) →
   degrade về in-process pacing (vẫn giãn nhịp trong process), KHÔNG block delivery,
   KHÔNG crash. Theo đúng triết lý fail-open của TASK-068A lock.

## 5. Ngoài scope

- Không đổi reusable destination hoặc Telegram mapping.
- Không đổi rule mỗi mailbox tối đa một active destination.
- Không đổi OAuth / reconnect / token classification.
- Không sửa detector / extractor.
- Không làm DLQ UI; không làm encryption key backup procedure.
- Không chạy live beta hoặc scale test thật.
- Không sửa `.env`, `.env.local`, `.env.staging`, `.env.production`.
- Không sửa GitHub Actions để nới lỏng secret scan.
- Không thêm env var mới (gate trên `REDIS_URL` đã có để tránh nợ tài liệu env như
  Low issue của TASK-068B).

## 6. Tiêu chí nghiệm thu

- `npm run verify` PASS.
- Test tối thiểu:
  - In-memory pacer behavior hiện có vẫn pass (không đổi).
  - Redis pacer: nhiều caller dùng cùng Redis key được serialize theo cùng interval.
  - Redis pacer: `waitMs` bị cap, không chờ vô hạn.
  - Redis pacer: Redis error không làm lộ secret / Redis URL trong log hoặc error snapshot;
    fail-safe trả nhịp an toàn (không throw, không block).
  - `email-worker-runner` wire đúng Redis-backed pacer khi có Redis config, fallback
    in-memory khi không có.
  - Không gửi trùng, không broadcast, không đổi Telegram destination (giữ test pipeline cũ).
- Không log/ghi: access/refresh token, client secret, bot token, database/Redis URL,
  encryption key, session secret, full verification code, full email body.

## 7. Rủi ro cần lưu ý

- **Clock skew giữa các replica.** Pacer dùng `now` của từng process truyền vào Lua;
  slot (`nextAvailableAt`) là chung trên Redis nên serialization vẫn giữ, chỉ lệch nhẹ
  theo skew. Pacing là smoother xấp xỉ, không phải hard guarantee — chấp nhận được, ghi
  nhận residual risk. (Có thể chuyển sang `redis TIME` ở task sau nếu cần chính xác hơn.)
- **Redis trên hot delivery path.** Mỗi send thêm ~1 RTT; ở ~25 send/giây là không đáng
  kể. Resolve client có timeout + cache để không treo path; eval lỗi → fallback ngay.
- Mọi cơ chế chờ vẫn phải có cap; không tạo đường gửi trùng; giữ exactly-once.

## 8. Vị trí trong chuỗi scale-readiness

- TASK-068A — Distributed safety & exactly-once. **Done.**
- TASK-068B — Scale-ready queue throughput (in-memory global pacer). **Done.**
- TASK-068C — Observability. **Done.**
- TASK-068D — 100-mailbox readiness validation (synthetic). **Done.**
- **TASK-070 — Redis-backed global Telegram bot pacer. (task này)**
- Tiếp theo đề xuất: controlled live beta / test-mailbox trial.
