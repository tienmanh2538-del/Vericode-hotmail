# TASK-054 Report — Scale Test Plan for 100–200 Mailboxes per Staff

Báo cáo ngày: 2026-06-03
Tác giả: Claude Code

## Trạng thái TASK-054: **DONE (planning artifact)**

Đây là **scale test plan / readiness plan**, không phải production scale-up. Report mô tả
cách kiểm tra mức tải 50 / 100 / 200 mailbox bằng dữ liệu giả lập an toàn (mock, seed, staging
fake), **không** dùng production resource, **không** dùng mailbox/Telegram group khách hàng
thật, và **không** gửi verification code thật. Mọi rủi ro cần per-mailbox throttling thực sự
được ghi nhận và chuyển cho TASK-055; mọi nhu cầu quan sát vận hành chuyển cho TASK-056.

## 1. Summary

Mô hình vận hành nội bộ: một staff có thể được gán nhiều customer, mỗi customer có nhiều
mailbox, và một staff thực tế có thể nhìn/quản lý 100–200 mailbox. Nhiều mailbox được phép
trỏ chung vào một reusable Telegram destination (TASK-053), nhưng mỗi mailbox vẫn chỉ có tối
đa một active destination và không bao giờ broadcast code.

Mục tiêu của plan này là trả lời câu hỏi: **ở mức 100–200 mailbox/staff, hệ thống có còn an
toàn và đủ nhanh không, và điểm gãy đầu tiên nằm ở đâu** — mà không cần chạy live scale.
Plan ưu tiên hướng ít rủi ro nhất: static review → mock dataset local → seed data trên staging
riêng → simulated processing không gọi Graph thật và không gửi Telegram thật.

Kết luận readiness sơ bộ: kiến trúc hiện tại (BullMQ queue + email worker + delta polling
backup + subscription renewal + Telegram retry) đủ để **đo và lập kế hoạch** ở mức 200
mailbox bằng dữ liệu giả lập. Hai điểm cần củng cố trước khi tăng tải thật là (a) per-mailbox /
per-destination throttling và queue safety (TASK-055) và (b) khả năng quan sát backlog/latency
theo thời gian thực (TASK-056).

## 2. Current baseline

Các giá trị mặc định hiện có trong code (chỉ là default; **không** thay đổi trong task này):

- Email worker concurrency: mặc định 2 job xử lý song song trên mỗi worker process
  (`lib/env.ts`, hằng `DEFAULT_EMAIL_WORKER_CONCURRENCY`). Có thể chỉnh qua biến môi trường
  tên `EMAIL_WORKER_CONCURRENCY` nhưng task này không đổi.
- Delta polling backup: mặc định chu kỳ 30 giây, tối thiểu cho phép 5 giây; tối đa 10 trang
  Graph delta mỗi mailbox mỗi vòng (`lib/env.ts`, các hằng `DEFAULT_DELTA_POLLING_*`). Biến
  môi trường liên quan: tên `DELTA_POLLING_INTERVAL_SECONDS` và
  `DELTA_POLLING_MAX_PAGES_PER_MAILBOX`.
- Subscription renewal: mặc định chu kỳ 15 phút, tối thiểu 60 giây.
- Telegram send retry: tối đa 4 lần (1 lần đầu + 3 retry), backoff 5s / 15s / 30s, tôn trọng
  `retry_after` của Telegram và cap ở 60 giây (`services/telegram/telegram-retry.service.ts`).
- Dedup: mỗi message chỉ relay đúng một lần nhờ ràng buộc duy nhất theo cặp
  `[mailboxId, graphMessageId]` trên `ProcessedMessage`.
- Hạ tầng queue: BullMQ trên Redis cho email worker.

Hệ quả cho scale: với concurrency mặc định 2, throughput của một worker process bị giới hạn;
khi nhiều mailbox cùng nhận mail trong thời gian ngắn, backlog sẽ dồn vào queue thay vì mất
mát — đây là hành vi mong muốn, nhưng latency tới Telegram sẽ tăng. Đây chính là số liệu cần
đo ở mục 5.

## 3. Test data model

Chỉ dùng dữ liệu **giả lập / fake**. Không email thật, không mailbox khách hàng thật, không
group khách hàng thật, không full email body thật, không verification code thật.

Thực thể cần seed:

- 1 staff test (role STAFF_READ_ONLY) + ít nhất 1 OWNER/ADMIN để so sánh phạm vi.
- 10–20 customer test, gán cho staff test.
- 50 / 100 / 200 mailbox fake (theo từng scenario), phân bổ qua các customer.
- 5–20 reusable Telegram destination fake (chat id / topic id giả, không trỏ tới group thật).
- Mailbox ↔ destination mapping sao cho **nhiều mailbox dùng chung một destination** để mô
  phỏng mô hình thật; vẫn giữ rule mỗi mailbox tối đa một active destination.
- Một số mailbox cố ý ở trạng thái chưa mapping / disconnected / error để kiểm tra readiness
  summary và staff scope.

Nguyên tắc an toàn cho dữ liệu giả:

- Telegram destination fake phải là id không tồn tại hoặc trỏ tới một test group nội bộ do
  team kiểm soát — không bao giờ trỏ tới group của khách hàng.
- Credential mailbox: dùng giá trị giả đã mã hóa bằng cơ chế sẵn có, hoặc đánh dấu mailbox ở
  trạng thái không cần gọi Graph. Không nhúng credential thật vào seed script.
- Seed script phải idempotent và chỉ chạy trên DB local/staging riêng (không production).

## 4. Test scenarios

> Tất cả scenario chạy ở chế độ simulated: **không** gọi Microsoft Graph thật, **không** gửi
> Telegram thật. Khi cần đo đường gửi, dùng port/adapter giả (như cách unit test hiện tại
> dùng) để đếm số lần gọi mà không phát sinh request ra ngoài.

### Scenario A — Staff with 50 mailboxes (UI & scope baseline)
- 1 staff, 5 customer, 50 mailbox, 5 reusable destination, một số mailbox chưa mapping.
- Mục tiêu: xác nhận mailbox list render mượt, readiness summary đúng, staff scope đúng
  (staff chỉ thấy customer/mailbox/mapping được gán).

### Scenario B — Staff with 100 mailboxes (volume estimate)
- 1 staff, 10 customer, 100 mailbox, 10 reusable destination, nhiều mailbox chung 1 destination.
- Mục tiêu: ước lượng queue volume khi nhiều mailbox cùng hoạt động; kiểm tra search/filter
  trong dashboard ở mức 100 dòng.

### Scenario C — Staff with 200 mailboxes (concentration & backlog)
- 1 staff, 20 customer, 200 mailbox, 10–20 reusable destination, một số destination có nhiều
  mailbox cùng trỏ vào.
- Mục tiêu: xác định rủi ro concentration (nhiều mailbox → 1 destination), backlog, latency,
  và nhu cầu throttling tương lai. Đây là input chính cho TASK-055.

### Scenario D — One shared destination under burst (throttle risk)
- 20–50 mailbox cùng một reusable destination, simulate nhiều job đến gần như đồng thời.
- Đường gửi dùng adapter giả; đếm số "send" theo từng destination để ước lượng nguy cơ chạm
  rate limit Telegram khi gửi thật. Mục tiêu: định lượng yêu cầu per-destination throttling
  cho TASK-055.

### Scenario E — Disconnected mailbox with queued job (stale job safety)
- Một mailbox bị disconnect (TASK-052) sau khi đã có job trong queue; không gửi request thật.
- Mục tiêu: xác nhận worker re-check trạng thái mailbox tại thời điểm xử lý job và skip nếu
  mailbox không còn ACTIVE; đưa vào checklist xác minh ở internal beta / live email test.

## 5. Metrics to measure

Mỗi scenario cần ghi nhận (hoặc chuẩn bị cách đo) các chỉ số sau:

| Nhóm | Chỉ số | Ghi chú đo |
|------|--------|-----------|
| Queue | Queue backlog (waiting/active/delayed) | Đọc qua BullMQ counts; không cần job thật ra ngoài |
| Queue | Job processing latency | enqueue → completed, trên dataset giả lập |
| Worker | Worker latency / throughput | Thời gian xử lý 1 job trung bình ở concurrency mặc định |
| Worker | Worker failure rate | Số job failed / tổng job (đường giả lập) |
| Graph | Delta polling interval thực tế | So với default 30s; có bị trượt khi nhiều mailbox không |
| Graph | Delta pages per mailbox | So với cap 10 trang/mailbox/vòng |
| Graph | Microsoft Graph throttling signal | Đếm tín hiệu throttle giả lập (mock 429/Retry-After) |
| Telegram | Telegram send failure count | Đếm trên adapter giả, không gửi thật |
| Telegram | Telegram 429 / retry_after signal | Mô phỏng để xác nhận backoff hoạt động đúng |
| Concentration | Số mailbox cùng dùng một destination | Phục vụ phân tích burst Scenario D |
| UI | Mailbox list render với 50/100/200 dòng | Quan sát thời gian render / pagination |
| UI | Search / filter response | Độ trễ thao tác lọc trong dashboard |
| Readiness | Counts: Ready / Needs Mapping / Error / Disconnected | Đối chiếu với dữ liệu seed |
| Bảo mật | Staff scope correctness | Staff chỉ thấy phạm vi được gán |
| Bảo mật | Không lộ secret / full code / full email body | Kiểm tra log & report đầu ra |

Cách ghi kết quả: lập bảng số liệu cho từng mức 50/100/200 và rút ra điểm gãy đầu tiên
(thường là latency tới Telegram khi backlog dồn, hoặc concentration trên một destination).

## 6. Risk analysis

- **Backlog tăng theo số mailbox.** 100–200 mailbox cùng hoạt động làm queue dồn; với
  concurrency mặc định 2, latency tới Telegram tăng. Hành vi an toàn (không mất job) nhưng cần
  đo và có thể cần tăng concurrency hoặc throttling có kiểm soát ở TASK-055.
- **Concentration trên một destination.** Nhiều mailbox chung một reusable destination có thể
  vượt rate limit Telegram khi gửi thật, dù mỗi mailbox vẫn chỉ gửi tới đúng một destination.
  Cần per-destination throttling (TASK-055).
- **Delta polling quá dày gây Graph throttling.** Chu kỳ ngắn × nhiều mailbox có thể tạo nhiều
  request Graph; cần cân nhắc interval và max pages khi tăng số mailbox thật.
- **Retry/backoff không phù hợp làm tăng tải.** Nếu nhiều job cùng fail và cùng retry, backoff
  cần đủ giãn để không tạo thundering herd. Backoff Telegram hiện cố định 5/15/30s + tôn trọng
  retry_after; cần xem có nên thêm jitter / per-destination cap (TASK-055).
- **Worker chậm làm code tới trễ.** Latency cao làm verification code tới Telegram trễ, ảnh
  hưởng trải nghiệm; cần ngưỡng cảnh báo (TASK-056).
- **UI dashboard chậm khi nhiều mailbox.** 200 dòng + search/filter cần pagination/ảo hóa hợp
  lý để không nghẽn render.
- **Staff scope sai làm lộ dữ liệu.** Phải đảm bảo staff chỉ thấy mailbox/mapping trong phạm
  vi được gán; mọi truy vấn phải đi qua service layer áp scope.
- **Mapping bypass service layer phá customer isolation.** Mọi thay đổi mapping phải qua service
  layer có validate isolation (kế thừa rule từ TASK-053).
- **Mailbox vừa disconnected nhưng job cũ còn trong queue.** Worker phải re-check trạng thái
  mailbox tại thời điểm xử lý (đã có từ TASK-052); cần xác minh lại ở mức scale.
- **Log/report lộ dữ liệu nhạy cảm.** Không log full verification code, full email body, hay
  giá trị credential; chỉ log id và số liệu tổng hợp.

## 7. Safe execution checklist

Trước khi chạy bất kỳ scale test nào:

- [ ] Chạy trên DB và Redis local hoặc staging riêng, **không** production.
- [ ] Tất cả mailbox/customer/destination là dữ liệu giả lập; không có resource khách hàng thật.
- [ ] Đường gửi Telegram và đường gọi Graph dùng adapter/port giả; không request ra ngoài.
- [ ] Không gửi verification code thật; không broadcast.
- [ ] Không thay đổi worker concurrency / polling interval của production.
- [ ] Seed script idempotent, có thể teardown sạch.
- [ ] Không in nội dung file env; không nhúng credential thật vào seed.
- [ ] Sau khi đo, kiểm tra log/report không chứa secret, full code, full email body.
- [ ] Ghi lại bảng số liệu 50/100/200 và điểm gãy đầu tiên.

## 8. What is deferred to TASK-055 (Per-mailbox throttling & queue safety)

- Per-mailbox và per-destination rate limiting / throttling thực sự (đặc biệt cho destination
  dùng chung — Scenario D).
- Queue safety: giới hạn concurrency có kiểm soát, backpressure, jitter cho backoff, chống
  thundering herd khi nhiều job cùng retry.
- Chính sách xử lý khi chạm Graph throttling / Telegram 429 ở mức tải cao.

TASK-054 chỉ **đo và định lượng** nhu cầu này; không implement throttling.

## 9. What is deferred to TASK-056 (Operational health dashboard)

- Dashboard quan sát realtime: queue backlog, worker latency, failure rate, throttling signal,
  readiness counts theo staff.
- Cảnh báo khi backlog/latency vượt ngưỡng.

TASK-054 chỉ **liệt kê metrics cần đo**; không xây dashboard mới.

## 10. Acceptance checklist

- [x] Có file task đúng đường dẫn (`docs/tasks/TASK-054-scale-test-plan-100-200-mailboxes.md`).
- [x] Có report scale test plan rõ ràng (file này).
- [x] Report không dùng production resource.
- [x] Report không yêu cầu mailbox thật hoặc Telegram group thật để scale test.
- [x] Report phân biệt rõ TASK-054 với TASK-055 và TASK-056.
- [x] Report có test plan cho 50, 100 và 200 mailbox.
- [x] Report có danh sách metrics cần đo.
- [x] Report có risk analysis.
- [x] Report có safe execution checklist.
- [ ] `npm run verify` PASS (chạy ở mục lệnh kiểm tra).
- [ ] Không có secret thật / dữ liệu nhạy cảm trong diff (tự kiểm trước khi báo xong).

## 11. Remaining risks

- Plan này dựa trên dữ liệu giả lập và adapter giả; số liệu thật chỉ xác nhận được khi có
  internal beta / live email test (đường live Microsoft vẫn deferred từ TASK-051).
- Điểm gãy thực tế về rate limit Telegram và Graph throttling chỉ định lượng chính xác khi
  TASK-055 triển khai throttling và đo lại.
- Không có dashboard realtime cho tới TASK-056, nên trong giai đoạn này việc theo dõi vẫn thủ
  công qua số liệu thu thập từ test.
- Staff scope và customer isolation được kiểm ở mức service-layer/contract; cần E2E ở mức scale
  để chắc chắn không hồi quy khi số mailbox tăng.
