# TASK-068B — Scale-Ready Queue Throughput

> Scale-readiness, bước 2 (sau TASK-068A). **Đây là task spec / scoping — chưa
> implement.** Mục đích: chốt phạm vi throughput trước khi sửa code, để bước test
> 100 mailboxes có thể chạy mà không làm nghẽn queue hoặc bị Microsoft Graph /
> Telegram rate-limit.

## 1. Bối cảnh

TASK-068A đã đóng các blocker an toàn concurrency (dedup exactly-once, distributed
mailbox lock phương án Redis, partial unique index cho one-active mapping). Nhưng
"an toàn" chưa đồng nghĩa với "đủ throughput": ở ~100 mailboxes, webhook + delta
polling tạo nhiều job hơn, và các guard hiện có (per-mailbox lock, shared-destination
throttle — TASK-055) có thể khiến job bị **defer/retry** nhiều, hoặc bị nhà cung cấp
(Graph / Telegram) bóp tần suất.

Baseline hiện tại (theo TASK-054/055):
- Email worker concurrency mặc định 2 (có biến môi trường cấu hình).
- Delta polling 30s / tối đa 10 trang mỗi mailbox.
- Subscription renewal ~15 phút.
- Telegram retry tối đa 4 lần, backoff 5/15/30s, có cap cho thời gian chờ.
- Per-mailbox processing lock (lease TTL) + shared-destination throttle (giãn cách
  gửi cùng group/topic, có cap).

## 2. Mục tiêu

Cho phép hệ thống xử lý ổn định ở mức ~100 mailboxes (và mở đường cho 300–500) bằng
cách điều tiết throughput **có giới hạn, có thể cấu hình**, mà KHÔNG:
- phá exactly-once (TASK-068A),
- phá routing / reusable destinations,
- gửi trùng hoặc mất verification code,
- retry vô hạn.

## 3. Business rules giữ nguyên (không đổi)

- App internal staff, khách không login.
- Nhiều mailbox dùng chung một reusable Telegram destination; mỗi mailbox tối đa một
  active destination.
- Mailbox DISABLED / chưa mapping hợp lệ không relay.
- Không multi-destination / không broadcast; không đổi routing.

## 4. Phạm vi đề xuất (cần chốt trước khi code)

Các hướng dưới đây là **ứng viên**; khi implement sẽ chọn tập tối thiểu, có test:

1. **Worker concurrency có kiểm soát.** Xác nhận/chuẩn hóa biến cấu hình concurrency
   của email worker; đảm bảo default an toàn và có cận trên hợp lý cho 100 mailboxes.
2. **Queue-level rate limiting (BullMQ limiter).** Giới hạn số job/giây ở mức worker
   để tôn trọng ngưỡng Microsoft Graph; cấu hình được, có giá trị mặc định an toàn.
3. **Telegram gửi: rate-limit toàn bot, không chỉ per-chat.** Telegram giới hạn tần
   suất cả ở mức bot; cân nhắc một guard tần suất toàn cục bổ sung cho
   shared-destination throttle (TASK-055), vẫn có cap, không broadcast.
4. **Giảm thrash từ DEFERRED_MAILBOX_BUSY.** Ở 100 mailboxes, job defer khi mailbox bận
   có thể retry dày. Cân nhắc backoff/fairness để job bận không chiếm slot worker, vẫn
   giữ giới hạn attempt (không retry vô hạn) và không đụng dedup claim.
5. **Delta polling batch ở quy mô lớn.** Xác nhận kích thước batch / số trang / nhịp
   poll vẫn hợp lý khi số mailbox tăng, tránh burst đầu chu kỳ.

> Quan sát/đo throughput thời gian thực (queue backlog, worker latency, tần suất
> defer/throttle) **thuộc TASK-068C (observability)** — không làm trong 068B.

## 5. Ngoài scope

- Không làm observability/health dashboard realtime (để TASK-068C).
- Không chạy validation 100 mailboxes thật (để TASK-068D).
- Không sửa `.env*`, GitHub Actions, package scripts để nới lỏng kiểm tra.
- Không multi-destination/broadcast; không đổi routing; không đổi business rules.
- Không tự mở socket Redis production cho lock (đã ghi nhận ở TASK-068A — việc inject
  client thật là quyết định riêng).

## 6. Rủi ro cần lưu ý

- Tăng concurrency/throughput có thể làm tăng khả năng chạm rate-limit Graph/Telegram
  → cần limiter có cận và default thận trọng.
- Backpressure sai có thể giữ slot worker hoặc làm trễ code → mọi cơ chế chờ phải có
  cap thời gian, mọi retry phải có giới hạn attempt.
- Mọi thay đổi phải giữ exactly-once (TASK-068A) và không tạo đường gửi trùng.
- Hằng số throughput nên cấu hình được, có default an toàn, không hardcode rải rác.

## 7. Tiêu chí nghiệm thu (khi implement)

- `npm run verify` PASS.
- Test cho từng cơ chế throughput được thêm (limiter, backpressure/fairness, Telegram
  rate-limit toàn cục nếu làm), kèm test khẳng định KHÔNG phá exactly-once/routing.
- Không log/ghi token, refresh token, client secret, bot token, full verification code,
  full email body, database/Redis URL, encryption key, session secret.
- Không sửa `.env*`/GitHub Actions/package scripts để nới lỏng kiểm tra.

## 8. Vị trí trong chuỗi scale-readiness

- TASK-068A — Distributed safety & exactly-once. **Done.**
- **TASK-068B — Scale-ready queue throughput. (task này)**
- TASK-068C — Observability (queue backlog, worker latency, throttle/defer signals).
- TASK-068D — 100-mailbox readiness validation (chạy thử an toàn bằng dữ liệu giả/seed
  trước khi cho tải thật tăng lên).

> Bước tiếp theo: chốt tập phạm vi tối thiểu ở §4, rồi mới sang implement (thay đổi
> code + test + report + Gemini review riêng).
