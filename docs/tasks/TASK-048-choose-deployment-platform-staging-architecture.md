# TASK-048 Choose deployment platform and staging architecture

## Mục tiêu

TASK này dùng để chốt nền tảng deploy staging và kiến trúc staging tối thiểu cho Verification Code Relay Tool.

Kết quả mong muốn là một quyết định rõ ràng về platform staging, danh sách service cần tạo trong task tiếp theo, các rủi ro cần kiểm soát, và checklist chuẩn bị cho TASK-049.

TASK này chưa deploy staging thật và chưa deploy production.

## Bối cảnh

App hiện tại là internal staff app cho agency, không phải public SaaS.

Khách hàng không login vào hệ thống. Khách hàng chỉ nhận verification code qua Telegram group hoặc Telegram topic.

OWNER và ADMIN có thể xem, quản lý toàn bộ. STAFF_READ_ONLY chỉ thấy customer được gán và mailbox thuộc customer đó.

Các quyết định đã chốt trước đó cần giữ nguyên:

- Nhiều mailbox có thể cùng dùng chung một Telegram group hoặc cùng một Telegram topic.
- Mỗi mailbox chỉ có tối đa một Telegram destination active.
- Mailbox chưa mapping không được coi là Ready.
- Mailbox chưa Ready không được tự động relay code.
- Staff assignment và guard phân quyền đã là nền tảng cho vận hành nội bộ.

Staging cần giống production ở các thành phần hạ tầng chính, nhưng chỉ dùng dữ liệu test.

## Vấn đề cần giải quyết

Dự án không chỉ là một Next.js web app đơn giản.

Staging cần hỗ trợ:

- Web Admin và API routes.
- PostgreSQL riêng cho staging.
- Redis cho BullMQ queue.
- Background worker xử lý email job.
- Delta polling worker làm đường dự phòng.
- Subscription renewal worker để gia hạn Microsoft Graph subscription.
- Microsoft OAuth callback trên HTTPS domain public.
- Microsoft Graph webhook endpoint trên HTTPS domain public.
- Telegram sender dùng test bot hoặc test group.
- Logs để quan sát lỗi vận hành.

Nếu chọn sai platform, TASK-049 có thể khó deploy, khó chạy worker, khó xem logs, hoặc phải ghép nhiều provider khiến người không chuyên code khó vận hành.

## Quyết định cần chốt

Claude cần phân tích và đề xuất rõ:

- Railway có phù hợp cho staging không.
- Render có phù hợp cho staging không.
- Vercel có phù hợp không nếu app cần long-running workers.
- Có nên dùng Vercel chỉ cho web app và chạy worker ở platform khác không.
- Có nên tách web service và worker service không.
- Có nên dùng managed PostgreSQL và managed Redis cùng một platform không.
- Platform nào dễ vận hành hơn cho người không chuyên code.
- Platform nào dễ xem logs, restart worker, rollback, và debug.
- Phương án staging tối thiểu nên gồm những service nào.
- Checklist nào cần chuyển sang TASK-049.

Khuyến nghị cần trung lập nhưng phải có lựa chọn cuối cùng.

## Scope được làm

TASK này được phép:

- Rà soát nhu cầu staging của app hiện tại.
- Rà soát tài liệu staging hiện có.
- So sánh Railway, Render, Vercel kết hợp worker riêng, và phương án khác nếu thật sự có lý do.
- Dùng nguồn official docs khi cần thông tin platform mới nhất.
- Đề xuất một kiến trúc staging cụ thể.
- Xác định các service cần tạo trong TASK-049.
- Xác định nhóm biến môi trường cần chuẩn bị nhưng không ghi giá trị thật.
- Tạo báo cáo quyết định nếu cần.
- Cập nhật wording tối thiểu trong tài liệu staging hoặc roadmap nếu phát hiện tài liệu hiện tại thiếu rõ ràng.
- Chạy lệnh kiểm tra repo sau khi sửa tài liệu.

## Scope không làm

TASK này không được:

- Không deploy staging thật.
- Không deploy production.
- Không tạo database thật.
- Không tạo Redis thật.
- Không tạo Microsoft App Registration staging.
- Không nhập secret thật.
- Không yêu cầu paste nội dung env file.
- Không dùng mailbox khách hàng thật.
- Không dùng Telegram group khách hàng thật.
- Không chạy migration lên production.
- Không thao tác production database.
- Không sửa OAuth hoặc Microsoft Graph runtime code nếu không có lý do rất rõ.
- Không sửa worker hoặc queue runtime code nếu không có lý do rất rõ.
- Không sửa Telegram routing rule đã chốt.
- Không làm customer portal.
- Không làm billing.
- Không biến app thành public SaaS.
- Không sửa GitHub Actions theo hướng nới lỏng secret scan.
- Không tạo migration.
- Không mở rộng sang TASK-049, TASK-050 hoặc TASK-051.

## Yêu cầu phân tích platform

Claude cần so sánh tối thiểu các phương án sau.

### Railway

Cần kiểm tra:

- Có hỗ trợ Next.js web service không.
- Có hỗ trợ managed PostgreSQL không.
- Có hỗ trợ Redis không.
- Có hỗ trợ background worker chạy liên tục không.
- Có thể đặt nhiều service trong cùng một project không.
- Có logs dễ xem không.
- Có public HTTPS domain cho web service không.
- Có phù hợp với BullMQ worker không.
- Có dễ vận hành cho người không chuyên code không.

### Render

Cần kiểm tra:

- Có hỗ trợ Next.js web service không.
- Có hỗ trợ managed PostgreSQL không.
- Có hỗ trợ Redis hoặc Redis-like service không.
- Có hỗ trợ background worker chạy liên tục không.
- Có logs dễ xem không.
- Có public HTTPS domain cho web service không.
- Có phù hợp với BullMQ worker không.
- Có dễ vận hành cho người không chuyên code không.

### Vercel kết hợp worker riêng

Cần kiểm tra:

- Vercel có phù hợp cho Next.js web service không.
- Vercel có phù hợp để chạy long-running worker không.
- Nếu dùng Vercel cho web, worker sẽ phải chạy ở đâu.
- Việc tách web và worker sang nhiều platform có làm vận hành khó hơn không.
- Có tăng rủi ro debug env, networking, logs, deploy order không.

## Yêu cầu staging architecture

Kiến trúc staging đề xuất cần ghi rõ tối thiểu:

- Một web service chạy Next.js.
- Một PostgreSQL database riêng cho staging.
- Một Redis service riêng cho staging.
- Một email worker service.
- Một delta polling worker service.
- Một subscription renewal worker service.
- Một HTTPS public domain cho app staging.
- Microsoft OAuth callback dùng domain staging.
- Microsoft Graph webhook dùng domain staging.
- Telegram test bot hoặc test group, không phải group khách hàng thật.
- Secret chỉ nằm trong secret manager của deploy platform.
- Database staging không liên quan production.
- Worker staging không trỏ tới production database hoặc production Redis.

Có thể đề xuất giai đoạn đầu tạo ít worker service hơn nếu code hiện tại yêu cầu, nhưng phải giải thích tradeoff và không được làm mất khả năng test live E2E ở TASK-051.

## Yêu cầu bảo mật

Claude phải tuân thủ:

- Không đọc hoặc in nội dung env file.
- Không tạo secret thật.
- Không ghi token, client secret, database credential, Redis credential, Telegram bot token vào docs.
- Không ghi full verification code.
- Không ghi full email body.
- Không hardcode chat ID, token, password, key, credential.
- Nếu cần nhắc biến môi trường, chỉ nhắc tên biến hoặc nhóm biến, không ghi giá trị.
- Tránh wording tài liệu có dạng metadata nhạy cảm kèm dấu hai chấm.
- Trước khi báo xong, kiểm tra diff để tránh secret scan false positive trong docs.
- Không sửa workflow CI để né secret scan.

## Các điểm Claude cần kiểm tra

Claude cần đọc tối thiểu:

- AGENTS.md
- CLAUDE.md
- GEMINI.md
- docs/SECURITY_RULES.md
- docs/PRODUCT_SPEC.md
- docs/ARCHITECTURE.md
- docs/ROADMAP.md
- docs/STAGING_DEPLOYMENT.md
- docs/MICROSOFT_SETUP.md
- Roadmap detail nếu có trong repo hoặc tài liệu nguồn tương ứng

Claude cần kiểm tra thêm:

- package scripts hiện có để biết worker command nào đã có.
- docs hiện có có đang nói staging quá chung chung không.
- Có cần tạo report quyết định riêng không.
- Có cần cập nhật staging guide sau khi chọn platform không.
- Có chạm vào runtime code không. Mặc định là không.

## Các tình huống Gemini cần review

Gemini cần review:

- Quyết định platform có hợp lý với Next.js, PostgreSQL, Redis, BullMQ, worker và webhook HTTPS không.
- So sánh Railway, Render, Vercel có trung lập không.
- Phương án khuyến nghị có phù hợp với người không chuyên code không.
- Có mở rộng sang TASK-049, TASK-050 hoặc TASK-051 không.
- Có deploy thật hoặc tạo resource thật không.
- Có secret thật trong diff không.
- Có wording dễ gây secret scan false positive trong docs không.
- Có sửa runtime code không cần thiết không.
- Có tạo migration không.
- Có phá routing rule đã chốt trước đó không.
- Có giữ đúng staging chỉ dùng mailbox test và Telegram test group không.

## Lệnh kiểm tra

Sau khi sửa tài liệu, chạy:

```bash
npm run verify
git status --short
git diff --stat
````

Nếu `npm run verify` fail, Claude phải báo rõ lỗi và root cause trước khi sửa tiếp.

## Tiêu chí nghiệm thu

TASK này chỉ được coi là PASS khi:

* Có file task TASK-048 trong docs/tasks.
* Nếu có report quyết định thì report nằm trong docs/reports và không chứa secret thật.
* Đã so sánh Railway, Render, Vercel kết hợp worker riêng.
* Đã chọn một platform staging khuyến nghị.
* Đã mô tả kiến trúc staging tối thiểu.
* Đã liệt kê service cần tạo trong TASK-049.
* Đã liệt kê rủi ro vận hành chính.
* Không deploy staging thật.
* Không deploy production.
* Không tạo database hoặc Redis thật.
* Không tạo Microsoft App Registration staging.
* Không nhập hoặc ghi secret thật.
* Không sửa runtime code nếu không cần.
* Không tạo migration.
* Không mở rộng sang TASK-049, TASK-050 hoặc TASK-051.
* `npm run verify` PASS.
* Gemini review PASS.

## Format báo cáo sau khi Claude làm xong

Claude cần báo cáo bằng tiếng Việt theo format:

1. Tôi đã làm gì
2. File đã thay đổi
3. Quyết định platform khuyến nghị
4. Kiến trúc staging đề xuất
5. Những việc tôi không làm
6. Rủi ro còn lại
7. Lệnh đã chạy và kết quả
8. Kết quả `git status --short`
9. Kết quả `git diff --stat`
10. Phần cần Gemini review kỹ
