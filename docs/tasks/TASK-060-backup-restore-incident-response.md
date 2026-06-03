# TASK-060 — Backup, restore & incident response

## Mục tiêu

Tạo runbook backup, restore và incident response cho production limited internal beta của Verification Code Relay Tool.

Task này giúp operator nội bộ biết cách phản ứng an toàn khi production gặp sự cố như database issue, Redis/queue issue, worker crash, worker chạy sai môi trường, Microsoft OAuth/Graph/subscription lỗi, Telegram gửi nhầm hoặc gửi thất bại, nghi lộ secret, log nhầm verification code/email body, auth/session lỗi, deploy/migration lỗi, hoặc cần tắt worker khẩn cấp.

## Bối cảnh

Dự án là internal staff app, không phải public SaaS.

Khách hàng không login và không có customer portal. Khách hàng chỉ nhận verification code qua Telegram group/topic đã được cấu hình.

TASK-059 đã hoàn tất production deployment limited internal beta ở mức tài liệu/checklist. TASK-060 tiếp nối bằng runbook vận hành sự cố, chưa phải full production scale-up.

## Scope được làm

- Tạo runbook backup database tối thiểu cho limited internal beta.
- Tạo restore drill an toàn vào môi trường tách biệt.
- Tạo incident response checklist cho các nhóm lỗi production quan trọng.
- Tạo hướng dẫn tắt worker khẩn cấp mà không xóa dữ liệu.
- Tạo hướng dẫn xử lý khi nghi secret bị lộ.
- Tạo hướng dẫn xử lý khi verification code hoặc email body bị log nhầm.
- Có thể cập nhật deployment production docs nếu cần liên kết runbook.
- Sau khi hoàn tất, cập nhật docs/ROADMAP.md ngắn gọn.

## Scope không làm

- Không onboarding staff hàng loạt.
- Không viết daily operations checklist chi tiết.
- Không scale production từ beta sang full internal use.
- Không tạo customer login, customer portal, public signup, billing hoặc self-service.
- Không làm một mailbox gửi tới nhiều Telegram destinations.
- Không broadcast verification code tới nhiều group/topic.
- Không sửa `.env`, `.env.local`, `.env.staging`, `.env.production`.
- Không ghi secret thật vào docs, code, comment, commit message, report hoặc log.
- Không sửa GitHub Actions để nới lỏng secret scan.
- Không thao tác production database bằng AI agent.
- Không chạy restore đè production nếu không phải incident thật và chưa có human approval.

## Nguyên tắc bắt buộc giữ nguyên

- Nhiều mailbox có thể dùng chung một reusable Telegram destination.
- Mỗi mailbox chỉ có tối đa một active Telegram destination.
- Mailbox disconnected không được poll, renew subscription hoặc relay code.
- Mailbox chưa có mapping hợp lệ không được coi là Ready.
- OWNER/ADMIN xem toàn bộ.
- STAFF_READ_ONLY chỉ xem customer/mailbox được assigned.
- Retry/throttling/queue safety từ TASK-055 không được phá.
- Operational health dashboard từ TASK-056 không được phá.
- Production auth hardening từ TASK-057 không được phá.
- Production env/secret setup từ TASK-058 không được phá.
- Limited internal beta guardrails từ TASK-059 không được phá.

## Backup strategy tối thiểu

- Production database phải có backup managed bởi deploy/database provider.
- Trước migration hoặc deploy rủi ro, operator phải xác nhận có backup gần đây.
- Backup không được commit vào repo.
- Backup không được upload vào chat AI.
- Backup không được chứa secret plaintext ngoài những gì database đang lưu hợp lệ.
- Redis/queue không được coi là nguồn dữ liệu chính. Nếu Redis lỗi hoặc mất queue, phục hồi dựa trên database state, Graph/delta polling, audit/code event an toàn, và runbook incident.

## Restore drill tối thiểu

Restore drill phải thực hiện vào môi trường tách biệt, không trỏ production web/worker vào database restore-test.

Checklist restore drill:

- Tạo database restore-test riêng.
- Restore từ một backup gần đây vào restore-test.
- Không bật email worker, delta worker hoặc renewal worker trên restore-test.
- Không dùng Telegram bot production để test restore.
- Không connect mailbox thật trong restore-test.
- Kiểm tra migration status và khả năng đọc dữ liệu tổng quan.
- Không gửi verification code thật.
- Ghi kết quả drill ngắn gọn vào report, không ghi dữ liệu nhạy cảm.

## Incident response: deploy/build/migration lỗi

- Dừng rollout hoặc rollback release trước nếu production bị ảnh hưởng.
- Không dùng `prisma migrate dev` cho production.
- Không tự sửa database bằng tay khi chưa xác định nguyên nhân.
- Nếu migration lỗi, kiểm tra migration status và log deploy.
- Nếu nghi data corruption, dừng worker trước khi xử lý tiếp.
- Chỉ restore production sau khi đã xác minh backup đúng và có human approval.

## Incident response: database lỗi

- Dừng worker để tránh ghi thêm dữ liệu trong lúc database không ổn định.
- Kiểm tra database provider dashboard.
- Không xóa dữ liệu.
- Không restore đè production nếu chưa drill hoặc chưa xác minh backup.
- Nếu cần restore, ưu tiên restore vào môi trường tách biệt để xác minh trước.

## Incident response: Redis/queue lỗi

- Kiểm tra Redis service và queue backlog.
- Nếu queue retry bất thường, dừng worker liên quan.
- Không xóa queue khi chưa biết hậu quả.
- Nếu Redis mất dữ liệu, dùng delta polling hoặc mailbox state để phục hồi luồng nhận email sau khi Redis ổn định.
- Bật lại worker theo từng bước, không bật tất cả cùng lúc nếu chưa rõ nguyên nhân.

## Incident response: worker crash hoặc worker chạy sai môi trường

- Xác định worker lỗi là email, delta hay renewal.
- Nếu worker chạy sai môi trường, dừng ngay service đó.
- Không chạy worker local trỏ vào production database hoặc production Redis.
- Kiểm tra platform service đang dùng đúng môi trường bằng cách kiểm tra tên biến/cấu hình, không in giá trị secret.
- Sau khi sửa, bật lại từng worker một.

## Incident response: Microsoft OAuth, Graph hoặc subscription lỗi

- Phân loại lỗi: redirect mismatch, consent revoked, token refresh failed, Graph throttling, subscription expired, webhook miss hoặc delta polling lỗi.
- Không paste Microsoft client secret, access token, refresh token hoặc authorization code vào chat AI/log/docs.
- Nếu nghi client secret bị lộ, rotate tại Microsoft Entra, cập nhật secret manager, restart/redeploy service liên quan.
- Nếu mailbox bị revoke quyền, yêu cầu reconnect mailbox; không bypass OAuth.
- Nếu webhook lỗi, giữ delta polling làm backup nhưng theo dõi throttling và queue load.

## Incident response: Telegram gửi thất bại hoặc gửi nhầm

Khi Telegram gửi thất bại:

- Kiểm tra lỗi bot/group/topic ở mức an toàn.
- Không retry vô hạn.
- Không log bot token.
- Nếu bot bị remove khỏi group/topic, sửa trong Telegram UI rồi test-send lại.

Khi Telegram gửi nhầm destination:

- Tắt email worker ngay.
- Nếu cần, tắt delta worker để tránh enqueue thêm email mới.
- Không xóa database hoặc queue ngay.
- Kiểm tra mapping mailbox với reusable destination.
- Kiểm tra customer isolation.
- Không bật lại worker cho đến khi root cause được xác minh và fix được review.

## Incident response: nghi secret bị lộ

- Dừng deploy tiếp theo.
- Xác định nhóm secret bị ảnh hưởng mà không ghi giá trị secret.
- Rotate secret tại nguồn phù hợp.
- Cập nhật secret manager của platform.
- Restart/redeploy service liên quan.
- Purge/redact log hoặc file bị lộ nếu có.
- Fix code path nếu leak do code.
- Chạy npm run verify.
- Yêu cầu Gemini review trước commit.

## Incident response: verification code hoặc email body bị log nhầm

- Dừng worker nếu leak đang tiếp diễn.
- Xác định log source mà không copy full code/email body vào chat.
- Purge hoặc redact log nếu platform hỗ trợ.
- Sửa code path để dùng masking/sanitizer.
- Kiểm tra không interpolate secret/code/email body vào log message string.
- Chạy test bảo mật nếu có.
- Gemini phải review phần log redaction.

## Incident response: auth/session lỗi

- Nếu production admin access mở sai khi chưa có sign-in provider production thật, coi là incident nghiêm trọng.
- Không dùng staging login hoặc dev demo user để bypass production.
- Rollback hoặc disable admin access nếu cần.
- Xác minh role/userId chỉ lấy từ session đã verify server-side.
- Giữ mô hình internal staff app; không tạo customer login.

## Emergency worker shutdown

Mục tiêu là dừng xử lý mà không xóa dữ liệu.

Thứ tự ưu tiên:

1. Tắt email worker nếu nghi gửi nhầm Telegram hoặc leak code/email body.
2. Tắt delta polling worker nếu nghi đang enqueue thêm email mới.
3. Tắt subscription renewal worker nếu lỗi liên quan Microsoft/subscription lan rộng.
4. Giữ database và Redis nguyên trạng để điều tra.
5. Không xóa queue hoặc database nếu chưa có phân tích root cause.
6. Sau khi fix, bật lại từng worker một và theo dõi health dashboard.

## Production beta safety checklist

- Không dùng customer login.
- Không public signup.
- Không billing/payment.
- Không scale-up hàng loạt.
- Không dùng một mailbox gửi nhiều Telegram destinations.
- Không broadcast code.
- Không log full verification code.
- Không log full email body.
- Không log token, refresh token, client secret, bot token hoặc session secret.
- Không sửa env thật trong repo.
- Không nới lỏng CI secret scan.

## Files dự kiến thay đổi

- docs/tasks/TASK-060-backup-restore-incident-response.md
- docs/reports/TASK-060-backup-restore-incident-response.md
- deployment/production/README.md nếu cần link tới runbook
- docs/ROADMAP.md sau khi task hoàn tất

## Lệnh kiểm tra

Chạy tối thiểu:

```powershell
npm run verify
git status --short
git diff --stat
````

Nếu chỉ sửa docs, vẫn phải chạy `npm run verify` theo rule của dự án.

## Tiêu chí nghiệm thu

* Có task file TASK-060.
* Có report TASK-060 nếu repo đang duy trì report cho mỗi task.
* Runbook có đủ backup, restore drill, incident response, emergency worker shutdown.
* Không chứa secret thật.
* Không chứa full verification code.
* Không chứa full email body.
* Không có wording dễ gây secret-scan false positive.
* Không sửa `.env*`.
* Không sửa GitHub Actions để nới lỏng secret scan.
* Không mở rộng sang TASK-061, TASK-062 hoặc TASK-063.
* npm run verify PASS.
* Gemini review PASS.
* docs/ROADMAP.md được cập nhật ngắn gọn sau khi task hoàn tất.

````

---

