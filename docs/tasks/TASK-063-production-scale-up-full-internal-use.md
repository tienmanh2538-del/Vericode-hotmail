# TASK-063 — Production scale-up from beta to full internal use

## 1. Mục tiêu

Lập kế hoạch và checklist an toàn để mở rộng production từ limited internal beta sang full internal use theo từng giai đoạn.

Task này giúp OWNER/ADMIN biết khi nào được tăng số mailbox, staff, customer; cần theo dõi metric gì; khi nào phải dừng scale hoặc rollback; và điều kiện PASS trước mỗi mức scale.

Đây là planning/checklist task. Không thực hiện full rollout hoặc onboarding hàng loạt mailbox thật trong task này.

## 2. Bối cảnh

Dự án là internal staff app cho agency. Khách hàng không login; khách hàng chỉ nhận verification code qua Telegram group/topic.

Các task nền đã hoàn tất:

- TASK-051 chốt trạng thái pre-live staging validation pass có điều kiện.
- TASK-052 thêm safe mailbox disconnect flow.
- TASK-053 thêm reusable Telegram destinations.
- TASK-054 tạo scale test plan cho 100–200 mailbox per staff.
- TASK-055 thêm per-mailbox throttling và queue safety.
- TASK-056 nâng cấp operational health dashboard.
- TASK-057 harden production auth cho internal staff.
- TASK-058 chuẩn hóa production environment và secret setup.
- TASK-059 chuẩn bị production deployment limited internal beta.
- TASK-060 tạo backup, restore và incident response runbook.
- TASK-061 tạo staff onboarding guide.
- TASK-062 tạo daily operations checklist.

TASK-063 nối tiếp các tài liệu trên để chuẩn hóa cách scale từ beta nhỏ sang full internal use.

## 3. Scope được làm

- Tạo production scale-up plan theo từng giai đoạn.
- Định nghĩa các mức scale từ beta nhỏ đến full internal use.
- Định nghĩa điều kiện bắt đầu scale.
- Định nghĩa metric cần theo dõi trong quá trình scale.
- Định nghĩa điều kiện PASS trước khi tăng lên mức scale tiếp theo.
- Định nghĩa rollback criteria khi gặp rủi ro.
- Liên kết cách dùng daily operations checklist từ TASK-062.
- Liên kết cách dùng incident response runbook từ TASK-060.
- Ghi rõ cách bảo vệ các rule routing, staff scope, mailbox readiness và disconnect guard.
- Có thể tạo thêm tài liệu operations checklist riêng cho production scale-up.
- Có thể tạo report ngắn sau khi hoàn tất task.

## 4. Scope không làm

- Không deploy production mới.
- Không onboarding hàng loạt mailbox thật.
- Không tạo customer login.
- Không tạo public signup.
- Không thêm billing/payment.
- Không làm một mailbox gửi tới nhiều Telegram destinations.
- Không broadcast verification code tới nhiều group/topic.
- Không thay đổi production auth hardening.
- Không thay đổi secret setup.
- Không sửa file môi trường chứa giá trị thật.
- Không sửa GitHub Actions để nới lỏng secret scan.
- Không thay đổi database schema nếu không có task riêng.
- Không thay đổi worker concurrency hoặc polling runtime bằng code nếu chưa có task riêng.

## 5. Business rules bắt buộc phải giữ

- Nhiều mailbox có thể dùng chung một reusable Telegram destination.
- Mỗi mailbox chỉ có tối đa một active Telegram destination.
- Mailbox disconnected không được poll, renew subscription hoặc relay code.
- Mailbox chưa có mapping hợp lệ không được coi là Ready.
- OWNER/ADMIN xem toàn bộ.
- STAFF_READ_ONLY chỉ xem customer/mailbox được assigned.
- Retry, throttling và queue safety từ TASK-055 không được phá.
- Operational dashboard từ TASK-056 không được phá.
- Production auth hardening từ TASK-057 không được phá.
- Production limited beta guardrails từ TASK-059 không được phá.
- Backup/restore/incident response runbook từ TASK-060 không được thay thế.
- Staff onboarding guide từ TASK-061 không được thay thế.
- Daily operations checklist từ TASK-062 phải được dùng trong scale-up.

## 6. Vì sao phải scale theo từng giai đoạn

Scale một lần từ beta nhỏ lên full internal use có rủi ro cao vì:

- Microsoft Graph có thể throttle nếu polling hoặc worker tạo quá nhiều request.
- Telegram có thể lỗi hoặc rate limit khi nhiều mailbox cùng gửi về một group/topic.
- Queue backlog có thể tăng dần và gây chậm relay code.
- Mapping sai có thể gửi code nhầm group/topic.
- Staff scope sai có thể làm nhân viên thấy dữ liệu không thuộc assignment.
- Mailbox disconnected hoặc chưa mapping có thể bị xử lý nhầm nếu guard bị phá.
- Incident ở quy mô nhỏ dễ dừng và rollback hơn incident ở quy mô lớn.

Vì vậy scale-up phải đi theo từng mức, có điều kiện PASS rõ ràng trước khi tăng tiếp.

## 7. Các mức scale đề xuất

### Level 0 — Limited internal beta

Mục tiêu: xác nhận production limited beta hoạt động ổn ở tải thật rất nhỏ.

Quy mô đề xuất:

- 1–2 OWNER/ADMIN.
- 0–2 staff nếu production sign-in provider đã sẵn sàng.
- 5–10 mailbox thật.
- Chỉ dùng customer, mailbox và Telegram destination đã được OWNER/ADMIN xác minh.

Điều kiện PASS:

- Health dashboard không có lỗi nghiêm trọng.
- Mailbox mới được xác nhận Ready đúng rule.
- Telegram test-send đúng group/topic.
- Không có duplicate relay.
- Không có full verification code, token, secret hoặc full email body trong log/UI.
- Không có queue backlog kéo dài.
- Không có worker crash lặp lại.

### Level 1 — Expanded beta

Mục tiêu: tăng nhẹ số mailbox và staff để kiểm tra vận hành thật.

Quy mô đề xuất:

- 20–50 mailbox.
- 2–3 staff.
- Một số customer thật đã được OWNER/ADMIN xác minh.

Điều kiện PASS:

- Daily operations checklist PASS trong các ngày vận hành liên tiếp.
- Telegram failure không tăng bất thường.
- Graph throttling không lặp lại.
- Queue latency nằm trong mức chấp nhận được.
- STAFF_READ_ONLY chỉ thấy đúng customer/mailbox được assigned.
- Không có mailbox disconnected hoặc unmapped bị coi là Ready.

### Level 2 — Internal scale pilot

Mục tiêu: kiểm tra vận hành ở quy mô gần thực tế.

Quy mô đề xuất:

- 50–100 mailbox.
- 3–5 staff.
- Nhiều reusable Telegram destinations.
- Có shared destination được nhiều mailbox dùng chung.

Điều kiện PASS:

- Shared destination không gây burst/failure bất thường.
- Worker và queue ổn định.
- Token refresh và subscription renewal ổn định.
- Health dashboard giúp OWNER/ADMIN phát hiện mailbox lỗi.
- Incident runbook sẵn sàng dùng nếu có lỗi.
- Không có routing sai hoặc scope leak.

### Level 3 — Full internal use

Mục tiêu: mở rộng cho vận hành nội bộ đầy đủ.

Quy mô đề xuất:

- 100–200+ mailbox theo nhu cầu thật.
- Staff/customer tăng theo đợt.
- OWNER/ADMIN duyệt từng đợt tăng.

Điều kiện PASS:

- Các mức trước đã PASS.
- Có quy trình daily checklist ổn định.
- Có owner chịu trách nhiệm quyết định tăng hoặc dừng scale.
- Có rollback criteria rõ ràng.
- Có báo cáo ngắn sau mỗi đợt tăng.

## 8. Điều kiện trước khi bắt đầu mỗi đợt scale

Trước khi tăng scale, OWNER/ADMIN cần xác nhận:

- GitHub Actions đang xanh.
- npm run verify đã PASS ở thay đổi gần nhất.
- Gemini review đã PASS cho task liên quan.
- Health dashboard không có lỗi nghiêm trọng.
- Worker/queue không có backlog bất thường.
- Token refresh và subscription renewal không có lỗi lan rộng.
- Telegram send failure không tăng bất thường.
- Không có dấu hiệu routing sai group/topic.
- Không có mailbox disconnected đang được xử lý.
- Không có mailbox chưa mapping hợp lệ bị coi là Ready.
- Staff assignment đã được kiểm tra với tài khoản STAFF_READ_ONLY.
- Daily operations checklist gần nhất không có blocker.
- Runbook incident response sẵn sàng nếu cần rollback.

## 9. Metric cần theo dõi

### Health dashboard

Theo dõi tổng số mailbox Ready, Needs mapping, Error, Disconnected và các trạng thái khác nếu có.

### Mailbox readiness

Xác nhận mailbox chỉ Ready khi đã connected, thuộc customer đúng, và có đúng một active destination hợp lệ.

### Telegram failures

Theo dõi lỗi gửi Telegram, lỗi permission bot, lỗi group/topic, retry và destination fail lặp lại.

### Worker và queue

Theo dõi backlog, job age, retry count, delayed jobs, worker heartbeat và worker restart.

### Microsoft Graph throttling

Theo dõi 429, 5xx, retry-after và mailbox bị throttle lặp lại.

### Token và subscription

Theo dõi token refresh failed, subscription expired, subscription renew failed và mailbox cần reconnect.

### Latency

Theo dõi thời gian từ khi email đến tới khi message được gửi vào Telegram.

### Duplicate prevention

Xác nhận cùng một Graph message không bị relay nhiều lần do webhook và delta polling cùng thấy message.

### Staff scope

Xác nhận STAFF_READ_ONLY chỉ thấy đúng customer/mailbox được assigned, bao gồm cả table, detail page, dashboard count và log view nếu có.

## 10. Cách dùng daily operations checklist

Daily operations checklist từ TASK-062 được dùng làm checklist vận hành chính trong scale-up.

Trước khi scale:

- Chạy checklist đầu ngày.
- Không tăng scale nếu checklist có blocker chưa xử lý.
- OWNER/ADMIN xác nhận trạng thái health dashboard và mailbox readiness.

Trong khi scale:

- Tăng mailbox/customer theo cụm nhỏ.
- Kiểm tra lại health dashboard sau mỗi cụm.
- Không tiếp tục nếu queue, Telegram, Graph hoặc token/subscription có dấu hiệu bất thường.

Sau khi scale:

- Chạy checklist cuối ngày.
- Ghi lại lỗi, warning, quyết định dừng hoặc tiếp tục.
- Nếu có incident, chuyển sang runbook TASK-060.

## 11. Cách dùng incident response runbook

Nếu scale gây incident:

- Dừng tăng scale ngay.
- Không onboarding thêm mailbox mới.
- Nếu nghi gửi nhầm Telegram, tắt worker xử lý email trước theo runbook.
- Nếu queue backlog lớn, không xóa dữ liệu thủ công khi chưa xác minh nguyên nhân.
- Nếu nghi lộ secret hoặc code, xử lý theo security incident trong runbook.
- Nếu Microsoft Graph/token/subscription lỗi, xử lý theo nhóm Microsoft trong runbook.
- Nếu Telegram lỗi, kiểm tra destination mapping, bot permission và retry behavior.
- Chỉ rollback hoặc giảm tải khi OWNER/ADMIN đã xác định phạm vi ảnh hưởng.

## 12. Bảo vệ rule một mailbox chỉ có một active destination

Scale-up không được phá rule:

- Một mailbox chỉ có tối đa một active destination.
- Không tạo nhiều active mapping cho cùng mailbox.
- Không gửi cùng một code tới nhiều group/topic.
- Không tự động fallback sang destination khác.
- Không bypass service-layer validation khi tạo hoặc sửa mapping.
- Khi đổi destination, phải đảm bảo mapping cũ không còn active.

## 13. Bảo vệ reusable Telegram destinations

Reusable destinations được phép dùng chung bởi nhiều mailbox, nhưng phải an toàn:

- Destination phải đúng customer/scope.
- Mapping mailbox vào destination phải qua validation.
- Shared destination cần theo dõi failure và burst.
- Nếu destination fail, không tự broadcast sang nơi khác.
- OWNER/ADMIN phải xác minh group/topic trước khi tăng nhiều mailbox vào cùng destination.

## 14. Bảo vệ STAFF_READ_ONLY scope

Khi scale thêm staff/customer:

- OWNER/ADMIN quản lý assignment.
- STAFF_READ_ONLY chỉ thấy customer/mailbox được assigned.
- Không dựa vào UI hiding làm lớp bảo mật duy nhất.
- Service/API/dashboard/log phải scope đúng.
- Staff chưa được assign customer nào thì không thấy dữ liệu.
- Trước mỗi mức scale, cần kiểm tra bằng tài khoản STAFF_READ_ONLY mẫu.

## 15. Xử lý mailbox disconnected, unmapped, hoặc token issue

- Mailbox disconnected không được poll, renew subscription hoặc relay code.
- Mailbox chưa mapping hợp lệ không được coi là Ready.
- Mailbox có token issue cần xử lý reconnect hoặc điều tra theo runbook.
- Mailbox có subscription issue cần được báo trong health/dashboard nếu có.
- Không dùng mailbox lỗi để tăng scale.
- Không cố retry vô hạn với mailbox lỗi.

## 16. Rollback criteria

Phải dừng scale hoặc giảm tải nếu có một trong các dấu hiệu sau:

- Có code gửi nhầm group/topic.
- Có duplicate relay cho cùng một message.
- Có dấu hiệu full verification code, token, secret hoặc full email body trong log/UI.
- Queue backlog tăng liên tục và không tự giảm.
- Worker crash hoặc restart lặp lại.
- Graph throttling lặp lại ở nhiều mailbox.
- Telegram failure tăng bất thường.
- Token refresh hoặc subscription renewal lỗi lan rộng.
- STAFF_READ_ONLY thấy dữ liệu ngoài assignment.
- Mailbox disconnected vẫn bị xử lý.
- Mailbox unmapped vẫn được coi là Ready.
- OWNER/ADMIN chưa xác minh mapping của mailbox mới.

Hành động rollback có thể gồm:

- Dừng onboarding mailbox mới.
- Tạm disable nhóm mailbox mới thêm.
- Tạm dừng worker email nếu nghi routing sai.
- Giảm tải theo task riêng nếu cần thay đổi concurrency/polling.
- Dùng runbook TASK-060 để xử lý incident.

## 17. Checklist trước khi tăng lên mức tiếp theo

- Daily operations checklist gần nhất PASS.
- Health dashboard không có blocker.
- Queue backlog ổn định.
- Telegram failure trong ngưỡng chấp nhận được.
- Graph throttling không lặp lại.
- Token/subscription issue đã xử lý.
- Mapping của mailbox mới đã được OWNER/ADMIN xác nhận.
- STAFF_READ_ONLY scope đã kiểm tra.
- Không có incident mở.
- OWNER/ADMIN đã ghi nhận quyết định tăng scale.

## 18. Security requirements

- Không ghi secret thật trong docs, code, logs, commit message hoặc report.
- Không đọc hoặc in nội dung file môi trường chứa giá trị thật.
- Không log token, refresh token, client secret, bot token, full verification code hoặc full email body.
- Không sửa GitHub Actions để nới lỏng secret scan.
- Tránh wording dễ gây secret-scan false positive trong docs/report/roadmap.
- Trước khi commit docs, yêu cầu Claude/Gemini kiểm tra diff để tránh secret-scan false positive.

## 19. Files dự kiến

Task này dự kiến tạo hoặc cập nhật:

- docs/tasks/TASK-063-production-scale-up-full-internal-use.md
- docs/operations/PRODUCTION_SCALE_UP_CHECKLIST.md
- docs/reports/TASK-063-production-scale-up-full-internal-use.md
- docs/ROADMAP.md sau khi task hoàn tất

Nếu có file khác cần sửa, Claude phải giải thích lý do trước khi sửa.

## 20. Commands kiểm tra

Sau khi hoàn tất, phải chạy:

```bash
npm run verify
````

Trước khi commit, kiểm tra:

```bash
git branch --show-current
git status --short
git diff --stat
```

## 21. Tiêu chí nghiệm thu

Task chỉ PASS khi:

* Có task file TASK-063.
* Có production scale-up checklist rõ ràng.
* Có các mức scale theo giai đoạn.
* Có điều kiện PASS trước mỗi mức scale.
* Có metric cần theo dõi.
* Có rollback criteria.
* Có hướng dẫn dùng TASK-062 daily checklist.
* Có hướng dẫn dùng TASK-060 incident runbook.
* Giữ nguyên internal staff app, không customer login, không public signup, không billing/payment.
* Giữ nguyên reusable destinations và rule mỗi mailbox chỉ một active destination.
* Giữ nguyên STAFF_READ_ONLY scope.
* Không sửa runtime code ngoài scope.
* Không sửa file môi trường chứa giá trị thật.
* Không có secret thật hoặc wording dễ gây secret-scan false positive trong diff.
* npm run verify PASS.
* Gemini review PASS.

## 22. Báo cáo sau task

Sau khi hoàn tất, tạo report ngắn trong docs/reports với:

* Task đã làm gì.
* File đã tạo/sửa.
* Kết quả verify.
* Kết quả Gemini review.
* Rủi ro còn lại.
* Việc cần đọc trước task tiếp theo.

Report không được chứa secret thật, full verification code, full email body hoặc log nhạy cảm.