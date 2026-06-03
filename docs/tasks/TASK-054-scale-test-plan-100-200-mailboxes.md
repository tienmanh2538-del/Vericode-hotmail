# TASK-054 — Scale test plan for 100–200 mailboxes per staff

## 1. Mục tiêu

Tạo kế hoạch scale test an toàn cho mô hình vận hành nội bộ, trong đó một staff có thể quản lý khoảng 100–200 mailbox thuộc nhiều customer, và nhiều mailbox có thể dùng chung reusable Telegram destination.

TASK-054 là scale test plan / readiness plan. Đây chưa phải production scale-up.

## 2. Bối cảnh

Dự án là internal staff app. Khách hàng không login, chỉ nhận verification code qua Telegram group/topic.

Các rule đã chốt vẫn giữ nguyên:

- Nhiều mailbox có thể dùng chung một Telegram destination.
- Mỗi mailbox chỉ có tối đa một active Telegram destination.
- Không làm một mailbox gửi tới nhiều Telegram destinations.
- Không broadcast code tới nhiều group/topic.

TASK-052 đã hoàn tất safe mailbox disconnect flow.
TASK-053 đã hoàn tất reusable Telegram destinations.
TASK-054 bắt đầu Sprint 13 về scale readiness.

## 3. Scope được làm

Trong task này, chỉ thực hiện các việc sau:

- Tạo kế hoạch test cho các mức 50, 100 và 200 mailbox.
- Đề xuất cách tạo dữ liệu giả lập an toàn cho staff, customer, mailbox, reusable Telegram destination và mailbox mapping.
- Xác định các chỉ số cần đo khi scale test.
- Rà soát các rủi ro chính khi nhiều mailbox thuộc cùng một staff hoặc cùng một Telegram destination.
- Đề xuất checklist test an toàn cho local hoặc staging giả lập.
- Tạo report trong `docs/reports/TASK-054-scale-test-plan-100-200-mailboxes.md`.
- Chạy `npm run verify`.
- Cập nhật `docs/ROADMAP.md` ngắn gọn sau khi task hoàn tất.

## 4. Scope không làm

Task này không làm các việc sau:

- Không deploy production.
- Không dùng production database hoặc production Redis.
- Không dùng mailbox khách hàng thật.
- Không dùng Telegram group khách hàng thật.
- Không gửi verification code thật.
- Không chạy live scale test với Microsoft Graph.
- Không gửi hàng loạt message thật qua Telegram.
- Không thay đổi worker concurrency hoặc polling interval cho production.
- Không implement per-mailbox throttling. Việc đó để TASK-055.
- Không làm operational health dashboard mới. Việc đó để TASK-056.
- Không làm một mailbox gửi tới nhiều Telegram destinations.
- Không làm broadcast code tới nhiều group/topic.
- Không sửa các file env local/staging/production.
- Không sửa GitHub Actions theo hướng nới lỏng kiểm tra bảo mật.

## 5. Dữ liệu test được phép dùng

Chỉ dùng dữ liệu giả lập hoặc test data an toàn.

Dataset khuyến nghị:

- Một staff test.
- 10 đến 20 customer test.
- 50, 100 và 200 mailbox fake.
- 5 đến 20 reusable Telegram destination fake.
- Nhiều mailbox dùng chung một destination để mô phỏng mô hình vận hành thật.
- Một số mailbox intentionally ở trạng thái chưa mapping, disconnected hoặc error để kiểm tra readiness.

Không dùng email thật, mailbox thật, group thật của khách hàng, full email body thật hoặc verification code thật.

## 6. Hướng test khuyến nghị

Ưu tiên thứ tự sau:

1. Static readiness review.
2. Mock dataset local.
3. Seed data giả lập trên staging riêng nếu cần.
4. Simulated processing không gọi Microsoft Graph thật và không gửi Telegram thật.

Không thực hiện live scale test trong TASK-054.

## 7. Chỉ số cần đo hoặc cần chuẩn bị cách đo

Các chỉ số cần đưa vào report:

- Queue backlog.
- Job processing latency.
- Worker latency.
- Worker failure rate.
- Delta polling interval.
- Delta pages per mailbox.
- Microsoft Graph throttling signal.
- Telegram send failure count.
- Telegram 429 signal.
- Số mailbox cùng dùng chung một destination.
- UI mailbox list render behavior với 50, 100 và 200 mailbox.
- Search/filter response trong dashboard.
- Readiness counts: Ready, Needs Mapping, Error, Disconnected.
- Staff scope correctness.
- Security check: không lộ giá trị bí mật, không lộ full verification code, không lộ full email body.

## 8. Rủi ro cần phân tích trong report

Report cần phân tích tối thiểu các rủi ro sau:

- 100–200 mailbox làm queue backlog tăng.
- Một destination dùng chung bởi quá nhiều mailbox gây Telegram throttling.
- Delta polling quá dày gây Microsoft Graph throttling.
- Retry/backoff không phù hợp làm tăng tải thay vì giảm tải.
- Worker xử lý chậm làm code đến Telegram trễ.
- UI dashboard chậm khi staff có nhiều mailbox.
- Staff scope sai làm lộ mailbox hoặc mapping ngoài phạm vi được gán.
- Mapping bypass service layer làm hỏng customer isolation.
- Mailbox vừa disconnected nhưng job cũ vẫn còn trong queue.
- Log/report vô tình chứa dữ liệu nhạy cảm.

## 9. Tài liệu report cần tạo

Tạo file:

`docs/reports/TASK-054-scale-test-plan-100-200-mailboxes.md`

Report nên có cấu trúc:

1. Summary.
2. Current baseline.
3. Test data model.
4. Test scenarios.
5. Metrics to measure.
6. Risk analysis.
7. Safe execution checklist.
8. What is deferred to TASK-055.
9. What is deferred to TASK-056.
10. Acceptance checklist.
11. Remaining risks.

## 10. Gợi ý test scenarios

Report cần có các scenario sau:

### Scenario A — Staff with 50 mailboxes

- 1 staff.
- 5 customer.
- 50 mailbox.
- 5 reusable destinations.
- Một số mailbox chưa mapping.
- Mục tiêu là kiểm tra UI, readiness summary và staff scope.

### Scenario B — Staff with 100 mailboxes

- 1 staff.
- 10 customer.
- 100 mailbox.
- 10 reusable destinations.
- Nhiều mailbox dùng chung một destination.
- Mục tiêu là kiểm tra queue volume estimate và UI search/filter.

### Scenario C — Staff with 200 mailboxes

- 1 staff.
- 20 customer.
- 200 mailbox.
- 10 đến 20 reusable destinations.
- Một số destination có nhiều mailbox cùng trỏ vào.
- Mục tiêu là xác định rủi ro concentration, backlog, latency và future throttling need.

### Scenario D — One shared destination under burst

- 20 đến 50 mailbox cùng dùng một reusable destination.
- Simulate nhiều job cùng lúc nhưng không gửi Telegram thật.
- Mục tiêu là xác định rủi ro Telegram rate limit và yêu cầu cho TASK-055.

### Scenario E — Disconnected mailbox with queued job

- Một mailbox bị disconnect sau khi job đã được enqueue.
- Không gửi external request thật.
- Mục tiêu là đưa vào checklist kiểm tra worker re-check mailbox status ở task sau hoặc beta test.

## 11. Yêu cầu bảo mật

- Không ghi giá trị thật của bất kỳ biến môi trường nào.
- Không ghi credential, OAuth value, Telegram credential hoặc database connection value thật.
- Không ghi full verification code.
- Không ghi full email body.
- Không dùng dữ liệu khách hàng thật.
- Không đọc hoặc in nội dung file env.
- Trước khi commit, Claude và Gemini phải kiểm tra diff để tránh secret-scan false positive trong docs/report/roadmap.

## 12. Lệnh kiểm tra bắt buộc

Sau khi tạo task/report và cập nhật roadmap:

```bash
npm run verify
git status --short
git diff --stat
````

## 13. Tiêu chí nghiệm thu

TASK-054 chỉ được coi là PASS khi:

* Có file task đúng đường dẫn.
* Có report scale test plan rõ ràng.
* Report không dùng production resources.
* Report không yêu cầu mailbox thật hoặc Telegram group thật để scale test.
* Report phân biệt rõ phần TASK-054 với TASK-055 và TASK-056.
* Report có test plan cho 50, 100 và 200 mailbox.
* Report có danh sách metrics cần đo.
* Report có risk analysis.
* Report có safe execution checklist.
* `npm run verify` PASS.
* Gemini review PASS.
* Không có secret thật hoặc dữ liệu nhạy cảm trong diff.