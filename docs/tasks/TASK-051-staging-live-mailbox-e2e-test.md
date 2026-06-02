# TASK-051 Staging live mailbox E2E test

## 1. Mục tiêu

Xác minh môi trường staging có thể xử lý live mailbox E2E an toàn bằng mailbox TEST và Telegram TEST group/topic.

Luồng cần xác minh:

```text
Mailbox TEST
-> Microsoft Graph webhook hoặc delta polling backup
-> staging queue/worker
-> detector/extractor
-> dedupe
-> Telegram TEST group/topic
-> logs/health dashboard
````

TASK này chỉ xác minh staging. Không deploy production, không dùng dữ liệu khách hàng thật, không dùng mailbox khách hàng thật, không dùng Telegram group/topic khách hàng thật.

## 2. Bối cảnh

TASK-049 đã chuẩn bị checklist hạ tầng staging trên Railway gồm web service, PostgreSQL staging, Redis staging, worker-email, worker-delta, worker-renewal và HTTPS Railway domain.

TASK-050 đã xác minh Microsoft App Registration staging ở mức docs/checklist, gồm redirect URI staging, webhook URL staging, permission tối thiểu và an toàn client secret.

TASK-051 là bước chạy live mailbox E2E trên staging để xác minh luồng thật hoạt động trước khi cân nhắc các task sau.

## 3. Điều kiện đầu vào từ TASK-049 và TASK-050

Trước khi test, cần có:

* Railway staging project riêng, không phải production.
* Web service staging mở được bằng HTTPS.
* PostgreSQL staging riêng.
* Redis staging riêng.
* `worker-email` đang chạy trên Railway.
* `worker-delta` đang chạy trên Railway.
* `worker-renewal` đang chạy trên Railway.
* Microsoft App Registration riêng cho staging.
* Redirect URI staging khớp với cấu hình staging.
* Webhook URL staging là public HTTPS và khớp với cấu hình staging.
* Permission Microsoft Graph giữ tối thiểu: `Mail.Read`, `offline_access`, `User.Read`.
* Telegram TEST group/topic riêng.
* Mailbox TEST riêng, không phải mailbox khách hàng thật.
* Không có secret thật trong repo hoặc docs.

## 4. Scope được làm

TASK này được phép:

* Tạo checklist live mailbox E2E cho staging.
* Connect 1 đến 3 mailbox TEST, ưu tiên bắt đầu với 1 mailbox.
* Cấu hình mailbox TEST thuộc customer TEST.
* Cấu hình Telegram mapping tới TEST group/topic.
* Chạy test-send vào Telegram TEST group/topic.
* Gửi email verification TEST vào mailbox TEST.
* Xác minh webhook path xử lý được email mới.
* Xác minh delta polling backup path hoạt động hoặc ghi rõ điều kiện chưa đủ để cô lập.
* Xác minh duplicate case: cùng một message không gửi 2 lần vào Telegram.
* Kiểm tra log/audit/code event không chứa full code, token, secret hoặc full email body.
* Kiểm tra health dashboard nếu có.
* Tạo report/checklist kết quả nếu cần.
* Chạy `npm run verify`.
* Cập nhật `docs/ROADMAP.md` sau khi task hoàn tất.

## 5. Scope không làm

TASK này không làm:

* Không deploy production.
* Không dùng production database.
* Không dùng production Redis.
* Không dùng mailbox khách hàng thật.
* Không dùng Telegram group/topic khách hàng thật.
* Không paste secret thật vào ChatGPT, Claude, Gemini, Cursor, docs, report hoặc commit.
* Không paste Microsoft client secret thật.
* Không paste Telegram bot token thật.
* Không paste database URL, Redis URL, encryption key hoặc session secret.
* Không ghi full verification code.
* Không ghi full email body.
* Không đọc hoặc in nội dung `.env`, `.env.local`, `.env.staging`, `.env.production`.
* Không sửa GitHub Actions workflow để nới lỏng secret scan.
* Không tạo migration mới nếu không có thay đổi schema thật sự.
* Không mở rộng sang production launch.
* Không mở rộng sang scale test 100 đến 200 mailbox.
* Không làm một mailbox gửi tới nhiều Telegram destination.

## 6. Checklist Railway staging

User kiểm tra thủ công trên Railway dashboard:

* Staging project là project riêng, không phải production.
* Web service staging đang chạy.
* Public HTTPS domain mở được.
* PostgreSQL staging tồn tại và không phải production DB.
* Redis staging tồn tại và không phải production Redis.
* `worker-email` đang chạy.
* `worker-delta` đang chạy.
* `worker-renewal` đang chạy.
* Các service dùng env staging.
* Worker không chạy local trỏ vào DB/Redis staging.
* Migration cũ đã được áp dụng bằng `prisma migrate deploy`.
* `/admin` mở được.
* `/admin/health` mở được nếu route này có sẵn.

Không copy giá trị env cho AI. Chỉ xác nhận tên biến có tồn tại hoặc thiếu.

## 7. Checklist Microsoft App Registration staging

User kiểm tra thủ công trong Microsoft Entra:

* App Registration staging là app riêng cho staging.
* Redirect URI dùng HTTPS và đúng path `/api/microsoft/oauth/callback`.
* Webhook URL dùng HTTPS và đúng path `/api/webhooks/microsoft/mail`.
* Redirect URI khớp với cấu hình staging.
* Webhook URL khớp với cấu hình staging.
* Permission tối thiểu gồm `Mail.Read`, `offline_access`, `User.Read`.
* Không thêm permission ngoài scope như gửi email hoặc sửa email.
* Không paste client secret vào chat AI, docs, report hoặc commit.
* Nếu gặp lỗi consent hoặc redirect, chỉ ghi mã lỗi chung và mô tả ngắn, không paste token hoặc secret.

## 8. Checklist mailbox TEST

User thao tác thủ công:

* Dùng mailbox TEST, không phải mailbox khách hàng thật.
* Mailbox TEST có thể nhận email từ nguồn gửi test.
* Connect mailbox TEST qua staging UI.
* Xác nhận mailbox thuộc customer TEST.
* Xác nhận mailbox không bị gắn nhầm customer thật.
* Không paste full email body vào AI hoặc docs.
* Không paste full verification code vào AI hoặc docs.

## 9. Checklist Telegram TEST group/topic

User thao tác thủ công:

* Dùng Telegram TEST group hoặc TEST topic.
* Không dùng Telegram group/topic khách hàng thật.
* Bot test đã được add vào TEST group.
* Nếu dùng topic, TEST topic đã tồn tại.
* Mapping mailbox TEST trỏ đúng TEST group/topic.
* Test-send tới TEST group/topic thành công.
* Không paste Telegram bot token vào AI, docs, report hoặc commit.

## 10. Webhook path test

Mục tiêu: xác minh email mới từ mailbox TEST đi qua webhook path và tới Telegram TEST group/topic.

Các bước:

1. Đảm bảo web service staging đang chạy bằng HTTPS.
2. Đảm bảo Microsoft Graph notification URL trỏ tới webhook staging.
3. Đảm bảo `worker-email` đang chạy.
4. Gửi email verification TEST vào mailbox TEST.
5. Chờ hệ thống xử lý.
6. Xác nhận Telegram TEST group/topic nhận đúng một message.
7. Xác nhận code hiển thị theo thiết kế sản phẩm, nhưng không ghi full code vào report.
8. Xác nhận code event/audit/log có trạng thái thành công nếu UI/log hỗ trợ.
9. Xác nhận không có token, secret, full verification code hoặc full email body trong logs.

Kết quả report chỉ ghi PASS/FAIL và mô tả đã mask, không ghi dữ liệu thật.

## 11. Delta polling backup test

Mục tiêu: xác minh delta polling backup hoạt động trên staging.

Các bước:

1. Đảm bảo `worker-delta` đang chạy.
2. Đảm bảo delta polling dùng env staging.
3. Gửi email verification TEST mới vào mailbox TEST.
4. Xác minh worker-delta có tín hiệu polling/cursor/health nếu hệ thống hiển thị.
5. Xác minh email mới được xử lý và không gửi trùng.
6. Nếu không thể cô lập delta-only vì webhook luôn bật, ghi rõ giới hạn test và bằng chứng đã kiểm tra được.

Điều kiện PASS đầy đủ: có bằng chứng delta backup xử lý được hoặc ít nhất được xác minh theo cách hệ thống hiện hỗ trợ. Nếu chưa đủ bằng chứng, report phải ghi rõ “chưa đủ điều kiện xác minh đầy đủ delta-only path”.

## 12. Duplicate case test

Mục tiêu: cùng một message nếu được webhook và delta polling cùng thấy thì Telegram chỉ nhận đúng một lần.

Các bước:

1. Đảm bảo webhook và `worker-delta` cùng đang hoạt động.
2. Gửi một email verification TEST mới.
3. Theo dõi Telegram TEST group/topic.
4. Theo dõi logs/code event/processed message nếu có UI hoặc safe query hỗ trợ.
5. Kết luận PASS nếu Telegram chỉ nhận một message cho email đó.
6. Kết luận FAIL nếu Telegram nhận hai message hoặc có dấu hiệu processed duplicate không được chặn.

Không ghi full message ID nếu có rủi ro nhạy cảm; có thể ghi mô tả đã mask hoặc rút gọn an toàn.

## 13. Log/security spot-check

Claude cần kiểm tra diff và hướng dẫn user spot-check logs an toàn.

Cần xác nhận:

* Không có token thật trong docs/report/diff.
* Không có client secret thật trong docs/report/diff.
* Không có bot token thật trong docs/report/diff.
* Không có database URL hoặc Redis URL thật trong docs/report/diff.
* Không có encryption key hoặc session secret thật trong docs/report/diff.
* Không có full verification code trong docs/report/diff.
* Không có full email body trong docs/report/diff.
* Không có `.env` hoặc `.env.*` trong diff.
* Logs chỉ hiển thị dữ liệu đã mask hoặc mô tả an toàn.
* Report không dùng dòng metadata ngắn dễ gây secret-scan false positive.

## 14. Health dashboard check

Mở `/admin/health` trên staging nếu route có sẵn.

Cần kiểm tra:

* Web/app health hiển thị ổn.
* Worker signal hiển thị nếu có.
* Polling/subscription signal hiển thị nếu có.
* Không có secret/token/code/full email body trong UI.
* Nếu health dashboard chưa đủ tín hiệu, ghi rõ hạn chế trong report, không tự mở scope sang TASK-054.

## 15. Điều kiện dừng khẩn cấp

Dừng test ngay nếu xảy ra một trong các tình huống:

* Telegram nhận message ở group/topic không phải TEST group/topic.
* Mailbox khách hàng thật bị connect hoặc bị đọc nhầm.
* Staging trỏ nhầm production database.
* Staging trỏ nhầm production Redis.
* Log hoặc UI hiển thị token, secret, full verification code hoặc full email body.
* Microsoft OAuth redirect trỏ nhầm domain hoặc môi trường.
* Worker chạy ở local và Railway cùng trỏ vào staging DB/Redis gây rủi ro xử lý trùng.
* Có nghi ngờ secret bị lộ.

Khi dừng khẩn cấp:

* Tạm dừng worker liên quan nếu cần.
* Không commit.
* Báo root cause.
* Nếu nghi ngờ secret lộ, user phải rotate secret trên provider tương ứng.

## 16. Các điểm Claude cần kiểm tra

Claude có thể làm trong repo:

* Đọc `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `docs/SECURITY_RULES.md`.
* Đọc `docs/ROADMAP.md`.
* Đọc `docs/MICROSOFT_SETUP.md`.
* Đọc `docs/STAGING_DEPLOYMENT.md`.
* Đọc task/report TASK-050 nếu tồn tại.
* Tạo file task TASK-051 nếu chưa có.
* Tạo report/checklist TASK-051 nếu cần.
* Kiểm tra diff không có secret thật.
* Kiểm tra wording docs/report/roadmap tránh false positive secret scan.
* Chạy `npm run verify`.
* Báo `git status --short`.
* Báo `git diff --stat`.

Claude không được đọc/in `.env` hoặc giá trị secret.

## 17. Các thao tác user phải làm thủ công

User phải tự thao tác ngoài repo:

* Railway dashboard.
* Microsoft Entra portal.
* Mailbox TEST.
* Telegram TEST group/topic.
* Xác nhận message Telegram nhận được mà không paste full code vào AI.
* Xác nhận lỗi Microsoft bằng mã lỗi chung nếu có, không paste token/secret.

## 18. Các tình huống Gemini cần review

Gemini cần review:

* Task file có đúng scope TASK-051 không.
* Report/checklist có ghi kết quả đủ rõ không.
* Không có production trong scope.
* Không dùng mailbox khách hàng thật.
* Không dùng Telegram group/topic khách hàng thật.
* Không có secret thật.
* Không có full verification code.
* Không có full email body.
* Không có `.env` hoặc `.env.*` trong diff.
* Không có wording dễ gây secret-scan false positive.
* Webhook checklist đầy đủ.
* Delta polling backup checklist đầy đủ.
* Duplicate case checklist đầy đủ.
* Log/security spot-check đầy đủ.
* Health dashboard check đầy đủ.
* Không sửa runtime code nếu không cần.
* Không tạo migration nếu không cần.
* `npm run verify` PASS.

## 19. Lệnh kiểm tra

Chạy các lệnh repo local an toàn:

```powershell
git branch --show-current
git status --short
git diff --stat
npm run verify
```

Nếu có file docs/report thay đổi, kiểm tra kỹ diff trước khi commit:

```powershell
git diff -- docs/tasks/TASK-051-staging-live-mailbox-e2e-test.md docs/reports/TASK-051-staging-live-mailbox-e2e-test.md docs/STAGING_DEPLOYMENT.md docs/ROADMAP.md
```

Không chạy lệnh in nội dung `.env` hoặc env secret.

## 20. Tiêu chí nghiệm thu

TASK-051 chỉ PASS khi:

* Đang ở đúng branch task.
* Có task file TASK-051.
* Có report/checklist nếu đã chạy live test.
* Railway staging dùng DB/Redis staging.
* Không dùng production DB/Redis.
* Không dùng mailbox khách hàng thật.
* Không dùng Telegram group/topic khách hàng thật.
* OAuth connect mailbox TEST được xác minh hoặc ghi rõ blocker.
* Webhook path được xác minh hoặc ghi rõ blocker.
* Delta polling backup được xác minh hoặc ghi rõ blocker.
* Duplicate case được xác minh hoặc ghi rõ blocker.
* Telegram TEST group/topic nhận đúng kết quả, không gửi nhầm group.
* Logs/security spot-check đạt.
* Health dashboard được kiểm tra nếu có.
* Không có secret thật trong diff.
* Không có full verification code trong diff.
* Không có full email body trong diff.
* Không có `.env` hoặc `.env.*` trong diff.
* Không tạo migration nếu không cần.
* Không sửa runtime code nếu không cần.
* `npm run verify` PASS.
* Gemini review PASS.
* `docs/ROADMAP.md` được cập nhật ngắn gọn sau khi task hoàn tất.
* Roadmap update đã được Gemini review trước commit/push.

## 21. Format báo cáo sau khi Claude làm xong

Claude báo cáo theo format:

```text
TASK-051 report

1. Tôi đã làm gì
- ...

2. File đã thay đổi
- ...

3. Kết quả live E2E staging
- OAuth connect mailbox TEST:
- Telegram TEST mapping:
- Webhook path:
- Delta polling backup:
- Duplicate case:
- Log/security spot-check:
- Health dashboard:

4. Việc user đã xác nhận thủ công
- Railway:
- Microsoft Entra:
- Mailbox TEST:
- Telegram TEST group/topic:

5. Lệnh đã chạy
- npm run verify: PASS/FAIL
- git status --short:
- git diff --stat:

6. Rủi ro còn lại
- ...

7. Cần Gemini review
- ...
```

Không ghi secret thật, không ghi full code, không ghi full email body, không ghi connection string.

## 22. Lưu ý tránh secret-scan false positive trong docs/report/roadmap

Khi viết docs/report/roadmap:

* Không dùng dòng metadata ngắn kiểu `Branch: ...`.
* Tránh dòng ngắn dạng `token: ...`, `secret: ...`, `key: ...`, `password: ...`, `auth: ...`, `bearer: ...`, `database url: ...`, `connection string: ...`.
* Nếu cần nhắc tên nhánh, viết thành câu thường hoặc bỏ.
* Chỉ ghi tên biến môi trường, không ghi giá trị.
* Không paste log có secret hoặc code thật.
* Không ghi full verification code.
* Không ghi full email body.
* Trước khi commit, yêu cầu Claude và Gemini kiểm tra diff docs/report/roadmap để tránh secret-scan false positive.

````