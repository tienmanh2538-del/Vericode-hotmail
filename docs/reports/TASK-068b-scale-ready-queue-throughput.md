# Report — TASK-068B Scale-Ready Queue Throughput

Ngày: 2026-06-04 · Tác giả: Claude Code

## 1. Mục tiêu đã làm

Điều tiết throughput **có giới hạn, cấu hình được** để chuẩn bị test ~100 mailboxes,
KHÔNG phá exactly-once/routing (TASK-068A), không retry vô hạn, không log dữ liệu nhạy
cảm. Triển khai đúng tập tối thiểu §4 của task spec.

## 2. Đã thay đổi gì

1. **Email worker concurrency có cận trên.** `loadQueueEnv` vẫn default an toàn (2) và
   vẫn nhận override qua biến môi trường, nhưng giờ **clamp** về `MAX_EMAIL_WORKER_CONCURRENCY`
   (= 20) để không ai vô tình set quá cao và mở quá nhiều call Graph/Telegram song song.
   Giá trị 0 / âm / phi số vẫn rơi về default 2.

2. **Queue-level rate limiter (BullMQ limiter).** Thêm `loadEmailWorkerRateLimitEnv`
   (default thận trọng: tối đa **20 job / 1000ms**, có min-clamp) và truyền `limiter`
   vào BullMQ `Worker`. Limiter chỉ **giãn** thời điểm job được start — KHÔNG fail và
   KHÔNG retry job, nên không thể tạo vòng retry vô hạn. Có thể override qua env hoặc
   tham số factory.

3. **Telegram global bot pacing.** Thêm module `global-send-throttle.ts` (tái dùng đúng
   primitive spacing đã có của `destination-throttle`, nhưng pin vào một key chung) để
   pace **toàn bộ** send của bot — bổ sung cho shared-destination throttle (TASK-055).
   Default ~40ms/slot (≤ ~25 send/giây, dưới ngưỡng ~30/giây của bot) và **có cap** thời
   gian chờ mỗi send (2s). Pipeline sleep bounded trước khi gửi; không đổi routing, không
   broadcast, không multi-destination, không đọc code/nội dung.

4. **Giảm thrash DEFERRED_MAILBOX_BUSY (bounded fairness).** Khi per-mailbox lock đang
   bận, pipeline có thể thử acquire lại vài lần với delay ngắn **trước khi** defer, để job
   in-flight (thường xong nhanh) nhả lock và job hiện tại xử lý ngay tại chỗ thay vì bị
   đẩy lại queue (đốt một attempt + backoff 5s). Bị chặn bởi **cả** `maxRetries` **lẫn**
   `maxTotalWaitMs` → không bao giờ vòng vô hạn, không giữ worker slot quá cap. Production
   wiring bật cấu hình thận trọng (tối đa 2 lần thử, tổng chờ ≤ 1s). Cơ chế này **chỉ**
   acquire lại lock — không claim/dedup khi đang bận → exactly-once (TASK-068A) nguyên vẹn.
   Khi không cấu hình `busyDeferRetry`, hành vi giữ y như TASK-055 (defer ngay).

> Delta polling batch (ứng viên §4.5) đã có cận sẵn (interval ≥ 5s, max trang/mailbox có
> min-clamp) nên giữ nguyên, không cần sửa cho task này.

## 3. File đã sửa / tạo

### Sửa
| File | Thay đổi |
|---|---|
| `lib/env.schema.ts` | Thêm 2 khóa env tùy chọn cho rate limiter (`EMAIL_WORKER_RATE_MAX`, `EMAIL_WORKER_RATE_DURATION_MS`). |
| `lib/env.ts` | Clamp concurrency về `MAX_EMAIL_WORKER_CONCURRENCY`; thêm `loadEmailWorkerRateLimitEnv` (default thận trọng + min-clamp). |
| `services/queue/workers/email-worker.ts` | Truyền `limiter` vào BullMQ `Worker`; thêm override tùy chọn. |
| `services/email/graph-message-pipeline.service.ts` | Helper `acquireMailboxLockWithFairness` (bounded busy-defer); pacing toàn bot trước khi gửi; 2 field deps tùy chọn (`globalSendThrottle`, `busyDeferRetry`). |
| `services/queue/workers/email-worker-runner.ts` | Singleton global pacer + default busy-defer thận trọng cho production. |

### Tạo mới
| File | Vai trò |
|---|---|
| `services/queue/global-send-throttle.ts` | Global bot send pacing (tái dùng primitive throttle, có cap). |
| `docs/tasks/TASK-068B-scale-ready-queue-throughput.md` | Task spec (đã có sẵn từ bước scoping). |
| `docs/reports/TASK-068b-scale-ready-queue-throughput.md` | Report này. |

## 4. Test đã thêm

- `tests/unit/queue/queue-throughput-config.test.ts` — concurrency clamp (default 2,
  in-range giữ nguyên, vượt → clamp về cap, 0/âm/phi số → default); rate limiter (default
  thận trọng, override hợp lệ, dưới-min → clamp, phi số → default).
- `tests/unit/queue/global-send-throttle.test.ts` — first send không chờ; pace toàn bộ
  send vào một slot chung; **cap** thời gian chờ mỗi send; burst lớn không vượt cap;
  hằng số default hợp lý (≤ ~30/giây).
- `tests/unit/email/graph-message-pipeline.throughput.test.ts` — busy-defer: thử lại lock
  bận rồi gửi thành công; defer sau số lần **bounded** (không vô hạn); `maxTotalWaitMs`
  là cap cứng dù `maxRetries` lớn; không cấu hình → defer ngay như cũ. Global pacing:
  chờ đúng interval rồi gửi đúng 1 lần tới đúng chat; áp dụng cả destination + global;
  spare capacity → không chờ. Exactly-once: chạy 2 job cùng `graphMessageId` với guard
  bật → job 2 `SKIPPED_DUPLICATE`, gửi đúng **một** lần.

Toàn bộ suite cũ (dedup, lock, pipeline throttling, telegram, worker-runner) vẫn pass —
tương thích ngược.

## 5. Lệnh đã chạy & kết quả

- `npm run verify` → **PASS**:
  - `db:generate` OK
  - `lint` (eslint) 0 lỗi
  - `typecheck` (tsc --noEmit) 0 lỗi
  - `test` (vitest) **916 tests / 82 files passed, 0 fail** (TASK-068A: 894/79 → +22 test, +3 file)
  - `build` (next build) compiled OK, 15/15 trang sinh tĩnh
- Ghi chú: các dòng `stderr` khi chạy test là log có chủ đích trong test (mailbox/chat id
  giả, mã đã mask), không phải lỗi.

## 6. An toàn (secret hygiene)

- Không đọc/in `.env*`. Không sửa `.env*`, GitHub Actions, hay package scripts.
- Không hardcode hoặc log: access/refresh token, client secret, bot token, database/Redis
  URL, encryption key, session secret. Không log full verification code hay full email body.
- Global pacer chỉ thao tác thời gian (epoch ms) cho một key hằng số; không chạm
  code/nội dung. Log mới chỉ chứa `mailboxId` + `waitMs`.
- Test chỉ dùng dữ liệu tổng hợp (chat id giả `-100…`, token giả rõ ràng là giả, mã mask).

## 7. Bất biến được giữ

- **Exactly-once (TASK-068A):** busy-defer chỉ acquire lại lock, không claim khi bận; có
  test 2-job cùng id chứng minh gửi đúng một lần.
- **Routing/reusable destination:** mọi guard chỉ giãn thời gian; send vẫn tới đúng một
  chat từ mapping DB; không broadcast, không multi-destination.
- **Không retry vô hạn:** limiter chỉ delay (không fail); busy-defer bị bound bởi cả số
  lần lẫn tổng thời gian; backoff job BullMQ vẫn giới hạn attempts như trước.

## 8. Rủi ro còn lại

- **Guard mới mặc định in-memory / per-process.** Ở nhiều worker replica, global pacing và
  per-mailbox lock chỉ có hiệu lực trong từng tiến trình (giống TASK-055/068A). Để pacing
  toàn cục thật sự cross-process cần seam Redis (cố ý hoãn — ngoài scope task này).
- **Busy-defer giữ worker slot tối đa ~1s** khi mailbox bận liên tục — đánh đổi có chủ đích
  để giảm thrash; đã bound bằng cap. Nếu sau này quan sát thấy slot bị giữ nhiều, có thể
  hạ `maxTotalWaitMs` qua override.
- **Giá trị default (concurrency cap 20, 20 job/giây, ~25 send/giây)** là phỏng đoán thận
  trọng; cần TASK-068C (observability) + TASK-068D (test 100 mailboxes) để tinh chỉnh số
  thật. Chưa chạy tải thật.
- Biến env mới chưa được ghi vào `.env*`/ví dụ env (cố ý không sửa `.env*`); cần bổ sung
  tài liệu env ở khâu vận hành nếu muốn override.

## 9. Cần Gemini review phần nào

1. `acquireMailboxLockWithFairness`: tính bounded (cả `maxRetries` lẫn `maxTotalWaitMs`),
   và khẳng định nó không thể claim/dedup khi đang bận → không ảnh hưởng exactly-once.
2. Thứ tự áp dụng wait trong pipeline: destination throttle → global pacer → send; cả hai
   đều capped, tổng delay bounded; không tạo đường gửi trùng.
3. Giá trị default: concurrency cap (20), limiter (20 job / 1000ms), global pacing
   (40ms/slot, cap 2s), busy-defer (2 lần, ≤ 1s) — có hợp lý cho mốc ~100 mailboxes không.
4. Quyết định dùng BullMQ `limiter` (chỉ delay) thay vì hạ attempts/đổi backoff — có giữ
   đúng nghĩa "không retry vô hạn" và không nuốt mất job không.
