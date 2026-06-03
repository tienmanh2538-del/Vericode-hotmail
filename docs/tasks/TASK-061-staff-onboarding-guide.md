# TASK-061 — Staff onboarding guide

## Mục tiêu

Tạo tài liệu onboarding cho nhân viên nội bộ không chuyên code sử dụng dashboard trong giai đoạn limited internal beta.

Tài liệu cần giúp staff hiểu cách đăng nhập khi môi trường đã sẵn sàng, xem dashboard, hiểu customer/mailbox được assigned, kiểm tra mailbox readiness, connect mailbox, mapping mailbox tới reusable Telegram destination, test-send an toàn, kiểm tra logs/health ở mức cơ bản, và biết khi nào phải báo OWNER/ADMIN.

## Bối cảnh

Dự án Verification Code Relay Tool là internal staff app cho agency, không phải public SaaS.

Khách hàng không login vào dashboard. Khách hàng chỉ nhận verification code qua Telegram group hoặc topic được cấu hình đúng.

Các task trước đã chốt các nguyên tắc vận hành quan trọng:

- OWNER/ADMIN xem toàn bộ dữ liệu.
- STAFF_READ_ONLY chỉ thấy customer/mailbox được assigned.
- Nhiều mailbox có thể dùng chung một reusable Telegram destination.
- Mỗi mailbox chỉ có tối đa một active Telegram destination.
- Mailbox disconnected không được poll, renew subscription hoặc relay code.
- Mailbox chưa mapping hợp lệ không được coi là Ready.
- Health dashboard đã có mức vận hành tối thiểu.
- Production limited internal beta đã có guardrails.
- Backup, restore và incident response đã có runbook riêng.

## Scope được làm

- Tạo staff onboarding guide cho nhân viên nội bộ không chuyên code.
- Giải thích khác biệt giữa OWNER/ADMIN và STAFF_READ_ONLY.
- Hướng dẫn staff hiểu customer assignment và giới hạn quyền.
- Hướng dẫn kiểm tra mailbox readiness.
- Hướng dẫn connect mailbox ở mức người dùng dashboard.
- Hướng dẫn mapping mailbox tới reusable Telegram destination.
- Hướng dẫn test-send an toàn.
- Hướng dẫn xem logs và health dashboard ở mức cơ bản.
- Ghi rõ khi nào staff phải báo OWNER/ADMIN thay vì tự xử lý.
- Ghi rõ đây là internal staff app, không có customer login.
- Tạo report ngắn cho task nếu repo đang dùng pattern docs/reports.

## Scope không làm

- Không tạo customer login.
- Không tạo public signup.
- Không thêm billing hoặc payment.
- Không thêm production sign-in provider mới.
- Không onboard hàng loạt staff thật.
- Không scale production từ beta lên full internal use.
- Không viết daily operations checklist chi tiết.
- Không viết lại backup, restore hoặc incident response runbook.
- Không sửa runtime code nếu không thật sự cần.
- Không tạo migration.
- Không sửa file `.env`, `.env.local`, `.env.staging`, `.env.production`.
- Không sửa GitHub Actions để nới lỏng secret scan.
- Không làm một mailbox gửi tới nhiều Telegram destinations.
- Không broadcast verification code tới nhiều group/topic.

## Tài liệu cần tạo hoặc cập nhật

Ưu tiên tạo:

- `docs/operations/STAFF_ONBOARDING_GUIDE.md`
- `docs/tasks/TASK-061-staff-onboarding-guide.md`
- `docs/reports/TASK-061-staff-onboarding-guide.md` nếu repo đang duy trì report cho mỗi task

Có thể cập nhật nhẹ:

- `docs/ROADMAP.md` sau khi task hoàn tất

Không cập nhật:

- `.env*`
- GitHub Actions workflow
- Runtime code, trừ khi phát hiện link docs hoặc navigation docs thật sự thiếu và cần sửa tối thiểu

## Nội dung bắt buộc của staff onboarding guide

Guide chính cần có các phần sau:

1. Mục đích tài liệu.
2. Ai được dùng dashboard.
3. Nguyên tắc an toàn bắt buộc.
4. Vai trò và giới hạn quyền.
5. Đăng nhập dashboard.
6. Hiểu customer assignment.
7. Hiểu mailbox readiness.
8. Connect mailbox.
9. Map mailbox tới reusable Telegram destination.
10. Test-send an toàn.
11. Kiểm tra logs cơ bản.
12. Kiểm tra health cơ bản.
13. Khi nào báo OWNER/ADMIN.
14. Những việc staff không được làm.
15. Checklist onboarding cho staff mới.
16. Handoff sau onboarding.

## Yêu cầu nội dung chi tiết

### Vai trò

Guide phải phân biệt rõ:

- OWNER/ADMIN có thể xem toàn bộ và xử lý cấu hình quản trị.
- STAFF_READ_ONLY chỉ xem dữ liệu trong phạm vi customer được assigned.
- Staff không thấy một customer/mailbox không có nghĩa dữ liệu đó không tồn tại.
- Nếu thiếu quyền hoặc thiếu customer/mailbox, staff phải báo OWNER/ADMIN.

### Mailbox readiness

Guide phải giải thích mailbox chỉ được coi là Ready khi:

- Mailbox đã connect hợp lệ.
- Mailbox thuộc đúng customer.
- Mailbox không bị disconnected.
- Mailbox có đúng một active Telegram destination hợp lệ.
- Destination trỏ đúng group/topic cần nhận message.
- Không có lỗi token, subscription hoặc Telegram rõ ràng trên dashboard.

Guide phải ghi rõ:

- Mailbox disconnected không Ready.
- Mailbox thiếu mapping không Ready.
- Mailbox có mapping không rõ destination cần báo OWNER/ADMIN.
- Mailbox không Ready thì không nên dùng cho live relay.

### Reusable Telegram destination

Guide phải giải thích:

- Reusable Telegram destination là group/topic Telegram được cấu hình một lần để nhiều mailbox có thể dùng chung.
- Một mailbox chỉ được có tối đa một active destination.
- Không tạo hoặc hướng dẫn broadcast code tới nhiều group/topic.
- Khi mapping, staff phải kiểm tra customer, mailbox và destination trước khi test-send.

### Test-send an toàn

Guide phải yêu cầu:

- Chỉ test-send sau khi xác nhận đúng customer, mailbox và destination.
- Nội dung test không chứa verification code thật.
- Nội dung test không chứa token, secret, full email body hoặc dữ liệu khách hàng nhạy cảm.
- Nếu test-send vào nhầm group/topic, dừng thao tác và báo OWNER/ADMIN ngay.

### Logs và health cơ bản

Guide chỉ hướng dẫn mức cơ bản:

- Staff có thể xem status thành công/thất bại nếu được phân quyền.
- Không cần xem full email body.
- Không cần biết hoặc copy full verification code.
- Staff có thể xem health dashboard để nhận biết mailbox needs mapping, Telegram failed, token/subscription issue hoặc trạng thái hệ thống nếu role được phép.
- Daily operations checklist chi tiết sẽ nằm ở task sau.

### Khi báo OWNER/ADMIN

Guide phải có danh sách tình huống báo OWNER/ADMIN:

- Không thấy customer/mailbox cần làm.
- Mailbox không Ready.
- Mailbox bị disconnected.
- Destination thiếu, sai hoặc nghi ngờ sai.
- Test-send vào nhầm group/topic.
- Telegram send failed tăng bất thường.
- Nghi ngờ lộ secret, verification code hoặc email body.
- Gặp lỗi login hoặc quyền truy cập.
- Health dashboard báo lỗi worker, queue, subscription hoặc service.
- Cần thay đổi assignment, destination hoặc quyền.

## Yêu cầu bảo mật

- Không ghi secret thật.
- Không ghi database connection string, token, client secret, bot token, encryption key hoặc session secret.
- Không ghi full verification code.
- Không ghi full email body.
- Không yêu cầu người dùng paste `.env` hoặc secret thật.
- Không thêm ví dụ có dạng giống secret thật.
- Tránh wording dễ gây GitHub Actions secret scan false positive.
- Tránh các dòng metadata ngắn dạng keyword/value liên quan đến branch, token, secret, key, password, auth, bearer, client secret, database url hoặc connection string.
- Nếu cần nhắc tới thông tin nhạy cảm, dùng câu mô tả bằng prose, không dùng giá trị mẫu giống thật.

## Yêu cầu kiểm tra

Claude phải chạy:

```bash
npm run verify
````

Trước khi báo hoàn tất, Claude phải báo:

* File đã tạo/sửa.
* `git status --short`.
* `git diff --stat`.
* Kết quả `npm run verify`.
* Có hay không có nội dung nhạy cảm trong diff.
* Có hay không có wording dễ gây secret scan false positive.

## Tiêu chí nghiệm thu

Task chỉ PASS khi:

* Có file task `docs/tasks/TASK-061-staff-onboarding-guide.md`.
* Có staff onboarding guide rõ ràng cho người không chuyên code.
* Guide phân biệt đúng OWNER/ADMIN và STAFF_READ_ONLY.
* Guide giữ đúng internal staff app, không tạo customer login.
* Guide bảo vệ rule nhiều mailbox dùng chung reusable destination nhưng mỗi mailbox chỉ có một active destination.
* Guide ghi rõ mailbox disconnected hoặc chưa mapping hợp lệ không Ready.
* Guide có hướng dẫn test-send an toàn.
* Guide có hướng dẫn logs/health ở mức cơ bản.
* Guide có mục khi nào báo OWNER/ADMIN.
* Không sửa `.env*`.
* Không sửa GitHub Actions để nới lỏng secret scan.
* Không có secret thật hoặc full verification code trong diff.
* `npm run verify` PASS.
* Gemini review PASS.