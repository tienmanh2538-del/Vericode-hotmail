
# TASK-059 — Production deployment limited internal beta

## Mục tiêu

Deploy production ở phạm vi limited internal beta cho nội bộ dùng thử rất giới hạn.

Đây không phải full production rollout. Task này chỉ nhằm xác minh production environment có thể chạy an toàn với số lượng staff và mailbox nhỏ, trước khi làm backup/incident response chi tiết, onboarding staff, daily operations và scale-up.

## Bối cảnh

Các task nền đã hoàn tất:

- TASK-052 đã bổ sung safe mailbox disconnect flow.
- TASK-053 đã bổ sung reusable Telegram destinations.
- TASK-055 đã bổ sung per-mailbox throttling và queue safety.
- TASK-056 đã nâng cấp operational health dashboard.
- TASK-057 đã harden production auth cho internal staff.
- TASK-058 đã chuẩn hóa production environment và secret setup.

Dự án là internal staff app, không phải public SaaS. Khách hàng không login, chỉ nhận verification code qua Telegram group hoặc topic.

## Scope được làm

Trong task này được làm các việc sau:

- Chuẩn bị checklist deploy production limited beta.
- Xác minh production deployment topology tối thiểu gồm web app, database, Redis và worker services.
- Xác minh production Microsoft App Registration và Telegram bot/destination dùng tài nguyên production riêng.
- Xác minh production dùng HTTPS.
- Xác minh migration production dùng lệnh deploy an toàn, không dùng migrate dev.
- Xác minh chỉ 1–2 nhân sự nội bộ tham gia beta.
- Xác minh số mailbox thật ban đầu rất nhỏ, tối đa 5–10 mailbox.
- Xác minh từng mailbox phải có customer, reusable Telegram destination hợp lệ, và Ready status trước khi relay.
- Xác minh health dashboard production mở được và không lộ dữ liệu nhạy cảm.
- Xác minh có cách tắt worker service nếu phát hiện gửi nhầm.
- Tạo hoặc cập nhật report cho TASK-059.
- Chạy npm run verify.
- Đưa diff cho Gemini CLI review trước khi commit.

## Scope không làm

Task này không làm các việc sau:

- Không mở public signup.
- Không tạo customer portal.
- Không tạo customer login.
- Không làm billing hoặc payment.
- Không onboarding staff hàng loạt.
- Không scale production hàng loạt.
- Không connect hàng chục hoặc hàng trăm mailbox.
- Không viết backup, restore và incident response chi tiết; phần đó để TASK-060.
- Không viết staff onboarding guide chi tiết; phần đó để TASK-061.
- Không viết daily operations checklist chi tiết; phần đó để TASK-062.
- Không production scale-up từ beta sang full internal use; phần đó để TASK-063.
- Không sửa file .env, .env.local, .env.staging hoặc .env.production.
- Không đọc hoặc in nội dung file env.
- Không ghi giá trị secret thật vào docs, code, log, commit message hoặc report.
- Không sửa GitHub Actions workflow để nới lỏng secret scan.
- Không dùng staging login/passphrase để bypass production auth hardening.

## Invariants bắt buộc phải giữ

Các rule sau không được phá:

- App vẫn là internal staff app.
- Khách hàng không login.
- OWNER và ADMIN xem toàn bộ dữ liệu.
- STAFF_READ_ONLY chỉ xem customer/mailbox được assigned.
- Nhiều mailbox có thể dùng chung một reusable Telegram destination.
- Mỗi mailbox chỉ có tối đa một active Telegram destination.
- Không làm một mailbox gửi tới nhiều Telegram destinations.
- Không broadcast verification code tới nhiều group/topic.
- Mailbox disconnected không được poll, renew subscription hoặc relay code.
- Mailbox chưa mapping hợp lệ không được coi là Ready.
- Retry, throttling và queue safety từ TASK-055 vẫn giữ nguyên.
- Operational health dashboard từ TASK-056 vẫn giữ nguyên.
- Production auth hardening từ TASK-057 vẫn giữ nguyên.
- Production env/secret setup từ TASK-058 vẫn giữ nguyên.

## Production beta guardrails

Limited internal beta chỉ được coi là hợp lệ nếu:

- Chỉ 1–2 staff nội bộ được dùng thử.
- Số mailbox thật ban đầu rất nhỏ.
- Mỗi mailbox được kiểm tra mapping bằng test-send trước khi bật relay.
- Health dashboard được kiểm tra trước và sau khi bật worker.
- Worker service có thể dừng riêng nếu phát hiện lỗi routing.
- Không có public signup route.
- Không có customer portal.
- Không có billing/payment.
- Không dùng staging resource cho production.
- Không chạy worker local trỏ vào production resource.

## Rủi ro cần kiểm tra

- Production auth có thể vẫn fail-closed nếu chưa có sign-in provider thật.
- Nhầm tài nguyên staging/local với production.
- Worker production dùng sai database hoặc Redis.
- Gửi nhầm Telegram group/topic do mapping sai.
- Mailbox disconnected vẫn còn job cũ trong queue.
- Webhook và delta polling cùng thấy một message gây duplicate relay.
- Health dashboard báo thiếu thông tin vì chưa có heartbeat/backlog thật.
- Docs/report vô tình dùng wording gây secret-scan false positive.

## Deployment checklist tối thiểu

Claude cần kiểm tra và ghi kết quả vào report, không ghi secret thật:

- Production web service đã có cấu hình deploy.
- Production database là tài nguyên riêng.
- Production Redis là tài nguyên riêng.
- Email worker chạy riêng.
- Delta polling worker chạy riêng.
- Subscription renewal worker chạy riêng.
- Production domain dùng HTTPS.
- Production Microsoft App Registration riêng với redirect/webhook production.
- Production Telegram bot/destination riêng.
- Migration production dùng deploy command an toàn.
- Health dashboard mở được.
- Internal staff auth không bị bypass bằng staging login.
- Staff assignment scope vẫn được enforce.
- Mailbox Ready status đúng.
- Test-send đúng group/topic trước relay thật.
- Không có secret thật trong git diff.

## Smoke test tối thiểu cho limited beta

Nếu user đã thao tác deploy ngoài dashboard, Claude chỉ ghi checklist và hướng dẫn kiểm tra, không yêu cầu paste secret:

- App production mở được bằng HTTPS.
- Login staff nội bộ hoạt động nếu production auth provider đã sẵn sàng.
- Nếu production auth vẫn fail-closed thì ghi blocker, không coi là beta usable.
- Health dashboard mở được.
- Tạo hoặc xem customer nội bộ test được theo đúng quyền.
- Connect mailbox test/internal beta được.
- Tạo mapping tới reusable Telegram destination đúng.
- Test-send đúng group/topic.
- Mock email process/send vẫn hoạt động nếu được dùng làm smoke test.
- Với email thật nếu có điều kiện, webhook hoặc delta path relay đúng một lần.
- Log không có token, secret, full verification code hoặc full email body.
- Mailbox disconnected không relay.
- Mailbox thiếu mapping không Ready và không relay.

## File có thể tạo hoặc sửa

Ưu tiên docs/checklist/report. Chỉ sửa runtime code nếu phát hiện blocker rõ ràng và phải báo trước cho user.

Các file dự kiến:

- docs/tasks/TASK-059-production-deployment-limited-internal-beta.md
- docs/reports/TASK-059-production-deployment-limited-internal-beta.md
- deployment/production/README.md nếu repo chưa có tài liệu production deployment tối thiểu
- docs/ROADMAP.md chỉ cập nhật sau khi task hoàn tất

Không sửa các file env thật.

## Lệnh kiểm tra

Bắt buộc chạy:

```bash
npm run verify
````

Trước commit/push, kiểm tra thêm:

```bash
git branch --show-current
git status --short
git diff --stat
```

## Tiêu chí nghiệm thu

TASK-059 chỉ PASS khi:

* Có task file đúng tên.
* Có report ghi rõ kết quả limited internal beta hoặc blocker nếu chưa thể beta thật.
* Scope không bị mở rộng sang customer portal, billing, onboarding hàng loạt hoặc scale-up.
* Không có secret thật trong diff.
* Không sửa file env thật.
* Không bypass production auth hardening.
* RBAC và staff assignment scope không bị phá.
* Routing rule Telegram không bị phá.
* Disconnect guard không bị phá.
* Throttling/queue safety không bị phá.
* Health dashboard không bị phá.
* npm run verify PASS.
* Gemini CLI review PASS.
* Nếu đã deploy production thật, GitHub Actions phải xanh và smoke test production phải được ghi lại an toàn trong report.

## Report cần ghi gì

Report của TASK-059 nên ghi ngắn gọn:

* Production beta đã deploy thật hay chỉ chuẩn bị checklist.
* Nếu deploy thật, ghi các hạng mục smoke test đã PASS/FAIL, không ghi secret.
* Nếu chưa deploy thật, ghi blocker cụ thể.
* Ghi rõ production auth có usable cho staff chưa.
* Ghi rõ số staff và số mailbox beta dự kiến hoặc thực tế.
* Ghi rõ worker services nào cần chạy.
* Ghi rõ rollback/tắt khẩn cấp ở mức tối thiểu, chi tiết đầy đủ để TASK-060.
* Ghi rủi ro còn lại.
* Ghi task tiếp theo nên đọc gì.

````
