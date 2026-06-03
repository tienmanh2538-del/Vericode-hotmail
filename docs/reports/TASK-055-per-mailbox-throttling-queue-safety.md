# TASK-055 Report — Per-mailbox Throttling & Queue Safety

Báo cáo ngày: 2026-06-03
Tác giả: Claude Code

## Trạng thái TASK-055: **DONE (minimal implementation)**

Đây là implementation tối thiểu cho per-mailbox throttling và queue safety dựa trên pipeline
đã có (TASK-027 worker pipeline, TASK-031 delta polling, TASK-033 Telegram retry, TASK-053
reusable destination). Không phải production scale-up đầy đủ, không deploy production, không
dùng production database hoặc production Redis, không dùng mailbox/Telegram group khách hàng
thật, và không gửi verification code thật. Gemini đã review PASS phần code.

## 1. Mục tiêu

Sau TASK-054, rủi ro chính là một mailbox hoặc một reusable Telegram destination dùng chung có
thể tạo burst job/request, làm nghẽn queue hoặc bị Microsoft Graph / Telegram rate-limit. TASK-055
thêm cơ chế tối thiểu để:

- Một mailbox không xử lý nhiều job song song theo cách gọi Graph/Telegram đồng thời.
- Job của mailbox disconnected hoặc chưa có mapping hợp lệ bị skip an toàn trước khi relay.
- Retry/backoff có giới hạn, không retry vô hạn.
- Nhiều mailbox dùng chung một reusable destination không gửi quá dày vào cùng group/topic.

Tất cả phải giữ nguyên customer isolation, rule một mailbox chỉ có một active destination, và
không thêm broadcast / multi-destination.

## 2. Những thay đổi chính đã triển khai

Hai module mới (thuần in-memory, không I/O lúc import):

- `services/queue/mailbox-processing-lock.ts` — per-mailbox processing lock.
- `services/queue/destination-throttle.ts` — shared-destination burst guard.

Tích hợp tối thiểu vào pipeline và worker hiện có:

- `services/email/graph-message-pipeline.service.ts` — acquire/release lock quanh thân pipeline,
  thêm bước giãn cách send theo destination, thêm status mới `DEFERRED_MAILBOX_BUSY`. Các dependency
  mới đều optional nên hành vi cũ giữ nguyên khi không inject.
- `services/queue/workers/email-worker.ts` — coi `DEFERRED_MAILBOX_BUSY` là retryable để worker
  re-attempt có giới hạn.
- `services/queue/workers/email-worker-runner.ts` — tạo hai singleton dùng chung và wire vào
  production deps (vẫn cho phép override trong test).

## 3. Per-mailbox throttling / processing lock (tóm tắt)

Lock theo `mailboxId`, giữ trong bộ nhớ của tiến trình worker. Trước khi chạm vào Graph hoặc
Telegram, pipeline cố lấy lock của mailbox đó:

- Nếu lấy được: chạy thân pipeline trong khối `try { ... } finally { release() }`, nên lock luôn
  được trả lại kể cả khi pipeline lỗi.
- Nếu mailbox đang bận (job khác cùng mailbox đang chạy): pipeline trả `DEFERRED_MAILBOX_BUSY` và
  **không** gọi Graph/Telegram. Worker ném lỗi để BullMQ retry job này sau, có backoff, và bị
  chặn trên bởi số attempt — không phải vòng lặp vô hạn.

Mỗi lease có thời hạn tự hết hạn (mặc định 60 giây). Nếu một job treo và không bao giờ release,
lease tự hết hạn để mailbox không bị kẹt vĩnh viễn. `release()` an toàn khi gọi nhiều lần và chỉ
xóa đúng lease của chính nó (không vô tình giải phóng lease của job đã tiếp quản sau khi hết hạn).

Phạm vi: lock này serialize trong **một** tiến trình worker, đủ cho baseline hiện tại (worker
concurrency mặc định 2 theo TASK-054). Trường hợp nhiều tiến trình worker song song cần lock chia
sẻ qua hạ tầng ngoài — đã chừa sẵn interface để mở rộng sau, nằm ngoài scope TASK-055.

## 4. Destination throttle / shared Telegram destination safety (tóm tắt)

Vì nhiều mailbox được phép trỏ chung vào một reusable destination (TASK-053), guard này giãn cách
các lần gửi tới **cùng một** đích. Khóa giãn cách được dựng từ chat id và topic id đã resolve
(`chatId::threadId`), nên hai mailbox gửi vào cùng group/topic sẽ được giãn cách chung, còn topic
khác trên cùng group là khóa khác.

Cơ chế là **delay nội tuyến có giới hạn**, không phải defer/retry ở tầng queue:

- Pipeline xin một slot giãn cách rồi chờ `waitMs` trước khi send.
- `waitMs` bị cap (mặc định tối đa 15 giây) nên một verification code không bao giờ bị trì hoãn
  vô hạn; khi quá tải, mức giãn cách suy giảm mượt về phía cap thay vì chặn delivery.

Lý do chọn delay nội tuyến thay vì defer-retry: nếu defer sau bước claim/dedup, lần retry sẽ bị
coi là trùng và code có thể bị bỏ. Delay nội tuyến tránh hoàn toàn xung đột đó.

Guard này **không** đổi routing, **không** broadcast, **không** thêm đích mới, và chỉ đọc khóa đích
mờ — không đọc verification code hay nội dung email.

## 5. Queue safety trong worker/pipeline

- Payload thiếu `mailboxId`/`graphMessageId` bị từ chối sớm (non-retryable) như trước.
- Lock bảo đảm một mailbox không bị nhiều job giữ worker song song; job bận được defer có giới hạn.
- Retry/backoff giữ nguyên giới hạn sẵn có: job queue mặc định 3 attempt với backoff lũy thừa;
  Telegram retry tối đa 4 lần với backoff 5/15/30 giây và có cap cho `retry_after`. Không có nhánh
  nào retry vô hạn.
- Lỗi transient (Graph fetch lỗi tạm thời, cần reconnect, Telegram send lỗi, deferred-busy) là
  retryable; các skip xác định (không phải verification, trùng, không có mapping) là terminal nên
  không tiêu tốn attempt một cách vô ích.

## 6. Mailbox disconnected hoặc chưa Ready / chưa mapping hợp lệ

- Mailbox không ở trạng thái active bị skip **trước khi** gọi Graph (status được kiểm tra ngay sau
  khi load mailbox), trả về một skip status rõ ràng và không relay.
- Mailbox chưa có active mapping hợp lệ bị skip **trước khi** gửi Telegram; không có chat id dự
  phòng nào được dùng.
- Việc resolve mapping đi qua service layer hiện có; một mapping còn active nhưng trỏ tới reusable
  destination đã bị vô hiệu hóa thì cũng không relay (kế thừa kiểm tra của TASK-053).

## 7. Giữ rule many mailboxes → one reusable destination

Guard giãn cách chỉ khóa theo đích đã resolve, nên nhiều mailbox khác nhau trỏ chung một destination
vẫn gửi được — chỉ được giãn cách theo thời gian để tránh burst, không bị chặn. Không thay đổi cách
nhiều mailbox chia sẻ một reusable destination đã làm ở TASK-053.

## 8. Giữ rule one mailbox → one active destination

TASK-055 không đụng vào logic tạo/cập nhật mapping. Mỗi mailbox vẫn resolve đúng một active
destination của chính nó qua service hiện có; ràng buộc "một mailbox chỉ có tối đa một active
mapping" và customer isolation được giữ nguyên. Lock và throttle hoạt động sau khi đích đã được
resolve, nên không mở đường cho một mailbox gửi tới nhiều đích và không tạo broadcast.

## 9. Test đã thêm/chạy

Test mới:

- `tests/unit/queue/mailbox-processing-lock.test.ts` — cấp/giữ/nhả lock, hai job cùng mailbox không
  cùng giữ lock, các mailbox khác nhau không chặn nhau, tự hết hạn theo TTL, từ chối id rỗng,
  release idempotent và không xóa nhầm lease.
- `tests/unit/queue/destination-throttle.test.ts` — khóa đích theo chat + topic, giãn cách burst vào
  cùng đích, các đích khác nhau độc lập, cap wait, không dồn wait khi traffic đã thưa.
- `tests/unit/email/graph-message-pipeline.throttling.test.ts` — hai job cùng mailbox không chạy
  Graph/Telegram song song; job bận trả deferred và không gọi Graph/Telegram; lock được nhả sau khi
  job xong, sau lỗi pipeline, và sau lỗi Telegram; pipeline chờ đúng khoảng giãn cách trước khi send;
  throttle được khóa theo chat + topic đã resolve.

Test cập nhật:

- `tests/unit/queue/email-worker.test.ts` — bổ sung `DEFERRED_MAILBOX_BUSY` vào nhóm status retryable.

Đã chạy test hẹp cho queue/email/worker (50 test PASS) và toàn bộ suite.

## 10. Kết quả npm run verify

`npm run verify` **PASS**: db:generate, lint, typecheck, test (toàn bộ 835 test / 72 file PASS),
và build đều xanh. Không log token, refresh token, client secret, Telegram bot token, full
verification code, hay full email body — log của lock/throttle chỉ chứa `mailboxId` và số mili-giây
chờ.

## 11. Rủi ro còn lại

- Lock serialize trong một tiến trình worker. Nếu sau này chạy nhiều tiến trình worker song song,
  cần một lock chia sẻ qua hạ tầng ngoài; interface đã sẵn để thay thế mà không đụng pipeline.
- Khi destination bị throttle, job chờ nội tuyến nên giữ slot worker trong thời gian chờ; điều này
  được chặn trên bởi cap thời gian chờ và bởi mức concurrency thấp của baseline.
- Các hằng số giãn cách/TTL hiện đặt mặc định trong code (có thể override khi khởi tạo). Việc đưa ra
  biến cấu hình vận hành chưa làm trong task này.
- Chưa chạy live với mailbox Microsoft thật và Telegram group thật ở mức tải cao; phần xác minh tải
  thật vẫn theo kế hoạch của TASK-054 và internal beta sau này.

## 12. Phần deferred sang task sau

- Quan sát vận hành theo thời gian thực (queue backlog, worker latency, tần suất defer/throttle,
  tỉ lệ Telegram fail) chuyển cho **TASK-056 — Operational health dashboard for staff workload**.
- Lock chia sẻ đa tiến trình và cấu hình throttling theo môi trường để dành cho giai đoạn production
  scale-up sau (tham chiếu lộ trình Sprint 14–15).
