
# TASK-062 — Daily operations checklist

## Mục tiêu

Tạo checklist vận hành hằng ngày cho giai đoạn production limited internal beta của Verification Code Relay Tool.

Checklist này dành cho OWNER/ADMIN và staff nội bộ, giúp kiểm tra nhanh mỗi ngày: health dashboard, mailbox readiness, disconnected mailbox, mailbox chưa mapping hợp lệ, Telegram send failure, logs cơ bản, worker/queue/subscription/token issue nếu dashboard có hiển thị, và escalation khi có bất thường.

Đây là internal staff app. Khách hàng không login; khách hàng chỉ nhận verification code qua Telegram group/topic đã được mapping.

## Bối cảnh

Các task trước đã chốt:

- TASK-052: mailbox disconnected không được poll, renew subscription hoặc relay code.
- TASK-053: reusable Telegram destinations; nhiều mailbox có thể dùng chung một destination.
- TASK-054: scale test plan đã có, nhưng full scale-up để task sau.
- TASK-055: per-mailbox throttling và queue safety đã có baseline.
- TASK-056: operational health dashboard cho staff workload đã có.
- TASK-057: production auth hardening giữ production fail-closed khi chưa có sign-in provider thật.
- TASK-058: production environment và secret setup dùng placeholder/secret manager, không ghi secret thật vào repo.
- TASK-059: production limited internal beta guardrails đã có.
- TASK-060: backup, restore và incident response runbook đã có.
- TASK-061: staff onboarding guide đã có.

TASK-062 không thay thế các tài liệu trên. TASK-062 chỉ tạo checklist vận hành hằng ngày.

## Scope được làm

- Tạo checklist vận hành hằng ngày cho OWNER/ADMIN.
- Tạo checklist vận hành hằng ngày cho STAFF_READ_ONLY.
- Hướng dẫn kiểm tra health dashboard ở mức vận hành thường ngày.
- Hướng dẫn kiểm tra mailbox readiness.
- Hướng dẫn kiểm tra mailbox disconnected hoặc chưa mapping hợp lệ.
- Hướng dẫn kiểm tra Telegram send failure và logs cơ bản.
- Hướng dẫn kiểm tra worker, queue, subscription, token issue nếu dashboard hiện có hiển thị.
- Ghi rõ khi nào staff phải báo OWNER/ADMIN.
- Ghi rõ khi nào OWNER/ADMIN phải dùng runbook TASK-060.
- Tạo tài liệu operations dễ đọc cho người không chuyên code.

## Scope không làm

- Không sửa runtime code.
- Không thêm dashboard mới.
- Không thêm monitoring/alerting mới.
- Không deploy production mới.
- Không scale từ beta lên full internal use.
- Không onboarding hàng loạt staff thật.
- Không tạo customer login.
- Không tạo public signup.
- Không thêm billing/payment.
- Không sửa `.env`, `.env.local`, `.env.staging`, `.env.production`.
- Không đọc, ghi, in hoặc yêu cầu người vận hành paste secret thật.
- Không sửa GitHub Actions workflow để nới lỏng secret scan.
- Không thay thế backup/restore/incident runbook TASK-060.
- Không làm 1 mailbox gửi tới nhiều Telegram destinations.
- Không broadcast verification code tới nhiều group/topic.

## Người dùng của checklist

### OWNER/ADMIN

OWNER/ADMIN dùng checklist đầy đủ để xem toàn hệ thống, kiểm tra health dashboard, mailbox readiness, Telegram failures, logs cơ bản, worker/queue/subscription/token issue nếu có hiển thị, và quyết định khi nào cần dùng runbook sự cố.

### STAFF_READ_ONLY

STAFF_READ_ONLY dùng checklist giới hạn theo customer/mailbox được assigned. Staff read-only chỉ phát hiện bất thường và báo OWNER/ADMIN; không tự thay đổi mapping, destination, customer assignment hoặc cấu hình production.

## Daily checklist — đầu ngày

1. Đăng nhập dashboard bằng tài khoản nội bộ hợp lệ.
2. Mở `/admin/health`.
3. Xác nhận dashboard không có lỗi đỏ hoặc degraded bất thường.
4. Kiểm tra mailbox overview:
   - Ready
   - Needs mapping
   - Needs customer
   - Disconnected
   - Error
5. Mở danh sách mailboxes và lọc mailbox không Ready.
6. Kiểm tra Telegram failures gần đây trong logs hoặc dashboard nếu có.
7. Kiểm tra worker/queue/subscription/token issue nếu dashboard có hiển thị.
8. Ghi nhận issue bằng mô tả ngắn, không copy full verification code, không copy full email body, không ghi secret.
9. Nếu issue nghiêm trọng hoặc không hiểu nguyên nhân, staff báo OWNER/ADMIN. OWNER/ADMIN quyết định có dùng runbook TASK-060 hay không.

## Health dashboard check

OWNER/ADMIN kiểm tra toàn hệ thống. STAFF_READ_ONLY chỉ kiểm tra customer/mailbox được assigned.

Cách đọc trạng thái:

- OK: tiếp tục checklist.
- Unknown: chưa tự kết luận là incident; kiểm tra thêm logs hoặc báo OWNER/ADMIN nếu kéo dài.
- Degraded: ghi nhận và báo OWNER/ADMIN.
- Error: OWNER/ADMIN kiểm tra ngay; nếu ảnh hưởng relay code hoặc an toàn dữ liệu, dùng runbook TASK-060.

Không dùng dashboard để bypass service-layer scope. Nếu staff không thấy customer/mailbox cần vận hành, staff phải báo OWNER/ADMIN kiểm tra assignment.

## Mailbox readiness check

Mailbox chỉ được coi là Ready khi:

- mailbox connected/active;
- có customer đúng;
- có đúng một active Telegram destination hợp lệ;
- mailbox không disconnected.

Checklist:

- Lọc mailbox Needs mapping.
- Lọc mailbox Needs customer nếu UI có.
- Lọc mailbox Error.
- Lọc mailbox Disconnected.
- Với mỗi mailbox không Ready, xác định customer và vấn đề chính.
- Không gửi test verification thật khi destination chưa rõ.
- STAFF_READ_ONLY báo OWNER/ADMIN nếu cần sửa mapping hoặc assignment.

## Disconnected mailbox check

Với mailbox disconnected:

- Không coi là Ready.
- Không poll mailbox đó.
- Không renew subscription cho mailbox đó.
- Không relay verification code từ mailbox đó.
- Nếu disconnected ngoài ý muốn, STAFF_READ_ONLY báo OWNER/ADMIN.
- OWNER/ADMIN chỉ reconnect khi đã xác nhận đúng customer và đúng destination.

## Unmapped mailbox check

Với mailbox chưa mapping hợp lệ:

- Không coi là Ready.
- Không relay verification code.
- OWNER/ADMIN kiểm tra reusable Telegram destination phù hợp.
- OWNER/ADMIN tạo hoặc sửa mapping qua UI/service hiện có.
- Sau khi mapping xong, dùng test-send an toàn nếu phù hợp.
- Không tạo nhiều active destination cho cùng một mailbox.

## Telegram send failure check

Kiểm tra các failure gần đây ở logs hoặc dashboard nếu có.

Cần chú ý:

- Failure có tăng bất thường không.
- Failure có tập trung vào một customer, mailbox hoặc destination không.
- Có dấu hiệu bot mất quyền gửi vào group/topic không.
- Có dấu hiệu gửi nhầm group/topic không.

Không copy full verification code, full email body, bot token hoặc secret thật vào report/chat.

Nếu nghi gửi nhầm destination, OWNER/ADMIN phải dùng runbook TASK-060 và cân nhắc dừng worker theo quy trình an toàn.

## Logs basic check

Khi xem logs:

- Chỉ dùng thông tin cần thiết để hiểu trạng thái.
- Không copy full email body.
- Không copy full verification code.
- Không copy token, refresh token, bot token, client secret hoặc connection string.
- Nếu phát hiện log đang hiển thị dữ liệu nhạy cảm, báo OWNER/ADMIN ngay và xử lý theo runbook TASK-060.

## Worker, queue, subscription và token issue

Chỉ kiểm tra những tín hiệu mà dashboard hoặc logs hiện có hỗ trợ.

Nếu có hiển thị worker status:

- Email worker nên chạy.
- Delta polling worker nên chạy nếu được bật.
- Subscription renewal worker nên chạy nếu được bật.

Nếu có hiển thị queue status:

- Queue backlog không được tăng bất thường.
- Job failure không được tăng bất thường.

Nếu có hiển thị subscription issue:

- Subscription expired hoặc renewal failed cần OWNER/ADMIN kiểm tra.

Nếu có hiển thị token issue:

- Token refresh failed hoặc mailbox cần reconnect phải được OWNER/ADMIN xử lý.

Nếu dashboard chỉ hiển thị Unknown, ghi nhận là Unknown. Unknown kéo dài hoặc đi kèm failure thực tế thì escalate.

## Khi STAFF_READ_ONLY phải báo OWNER/ADMIN

STAFF_READ_ONLY phải báo OWNER/ADMIN khi:

- Không thấy customer/mailbox mình cần vận hành.
- Mailbox bị disconnected.
- Mailbox Needs mapping hoặc mapping có vẻ sai.
- Telegram send failure lặp lại.
- Health dashboard có Error, Degraded hoặc cảnh báo không hiểu.
- Khách báo không nhận code nhưng staff không xác định được nguyên nhân.
- Nghi verification code gửi nhầm group/topic.
- Nghi full code, full email body hoặc secret bị lộ trong UI/log.
- Cần thay đổi customer assignment, mailbox mapping hoặc reusable destination.

## Khi OWNER/ADMIN phải dùng runbook TASK-060

OWNER/ADMIN dùng runbook TASK-060 khi có dấu hiệu incident:

- Deploy, build hoặc migration lỗi.
- Database lỗi hoặc nghi mất dữ liệu.
- Redis hoặc queue lỗi kéo dài.
- Worker crash hoặc worker chạy sai môi trường.
- Microsoft OAuth, Graph hoặc subscription lỗi diện rộng.
- Telegram send failure hàng loạt.
- Telegram gửi nhầm destination.
- Nghi lộ secret.
- Nghi full verification code hoặc full email body bị log nhầm.
- Auth/session bất thường.
- Cần emergency worker shutdown.

## Security rules

Checklist này không được yêu cầu người vận hành paste hoặc ghi lại secret thật.

Không ghi vào docs, report, issue, chat AI hoặc commit message:

- secret thật;
- token thật;
- refresh token thật;
- bot token thật;
- client secret thật;
- database hoặc Redis connection string thật;
- full verification code;
- full email body.

Khi cần mô tả lỗi, chỉ ghi mô tả ngắn, masked reference nếu UI đã cung cấp, thời điểm tương đối và khu vực chức năng bị ảnh hưởng.

## Acceptance criteria

TASK-062 chỉ được nghiệm thu khi:

- Có file task này trong `docs/tasks/`.
- Có daily operations checklist trong `docs/operations/`.
- Checklist phân biệt rõ OWNER/ADMIN và STAFF_READ_ONLY.
- Checklist không trùng nội dung onboarding của TASK-061.
- Checklist không thay thế incident runbook TASK-060.
- Checklist không mở rộng sang production scale-up TASK-063.
- Checklist giữ nguyên internal staff app, không customer login, không public signup.
- Checklist giữ nguyên rule nhiều mailbox có thể dùng chung reusable destination nhưng mỗi mailbox chỉ có tối đa một active destination.
- Checklist ghi rõ mailbox disconnected hoặc chưa mapping hợp lệ không Ready.
- Checklist không chứa secret thật, full verification code hoặc full email body.
- `npm run verify` PASS.
- Gemini review PASS.
```