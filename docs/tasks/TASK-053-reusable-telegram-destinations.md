
# TASK-053 — Reusable Telegram destinations

## Mục tiêu

Thiết kế và triển khai reusable Telegram destinations để Admin/Owner chỉ cần cấu hình một Telegram group hoặc group topic một lần, sau đó khi tạo mapping cho mailbox thì chọn destination đã lưu sẵn.

Task này phải giữ nguyên các rule routing đã chốt:
- Nhiều mailbox có thể dùng chung một Telegram destination.
- Mỗi mailbox chỉ có tối đa một active Telegram destination.
- Không làm một mailbox gửi tới nhiều Telegram destinations.
- Không broadcast verification code tới nhiều group hoặc topic.

## Bối cảnh

Hiện tại khi tạo Telegram mapping cho mailbox, người vận hành phải nhập lại nhiều thông tin như group name, topic name, chat ID, và topic/thread ID. Việc này bất tiện và dễ nhập sai khi nhiều mailbox cùng dùng một group hoặc topic.

TASK-053 tách phần cấu hình Telegram group/topic thành reusable destination. Mapping mailbox chỉ còn chọn destination phù hợp.

Dự án là internal staff app. Khách hàng không login; khách hàng chỉ nhận verification code qua Telegram group/topic. Owner/Admin quản lý toàn bộ. Staff read-only chỉ xem dữ liệu được gán và không được thực hiện thao tác ghi.

## Scope được làm

- Tạo model/table mới cho Telegram destination.
- Mỗi destination đại diện cho một Telegram group thường hoặc một topic trong group.
- Destination nên gắn với customer để tránh chọn nhầm group/topic giữa các customer.
- Thêm service quản lý destination.
- Thêm UI cho Owner/Admin tạo, xem, sửa, disable destination.
- Cập nhật UI Telegram mapping để chọn destination đã lưu sẵn.
- Cập nhật mapping service để validate mailbox và destination thuộc cùng customer.
- Cập nhật pipeline resolve Telegram destination để lấy thông tin gửi từ destination đã liên kết.
- Hỗ trợ nhiều mailbox dùng chung một destination.
- Giữ rule mỗi mailbox chỉ có tối đa một active mapping.
- Thêm test unit và integration phù hợp.
- Cập nhật docs/report liên quan nếu cần.

## Scope không làm

- Không làm một mailbox gửi tới nhiều Telegram destinations.
- Không broadcast code tới nhiều group hoặc topic.
- Không làm customer portal.
- Không làm customer login.
- Không làm scale test.
- Không deploy production.
- Không dùng production database hoặc production Redis.
- Không dùng mailbox khách hàng thật.
- Không dùng Telegram group khách hàng thật.
- Không sửa các file env local/staging/production.
- Không sửa GitHub Actions để nới lỏng secret scan.
- Không cleanup/xóa field cũ trong TelegramMapping nếu việc đó làm migration rủi ro; có thể để task cleanup riêng sau.

## Thiết kế đề xuất

Tạo model TelegramDestination với các thông tin tối thiểu:
- customerId để gắn destination với customer.
- displayName để người vận hành dễ nhận diện.
- telegramGroupName.
- telegramTopicName nếu là topic.
- telegramChatId.
- telegramThreadId nếu là topic.
- status để bật/tắt destination.
- createdAt và updatedAt.

TelegramMapping nên liên kết tới TelegramDestination qua destination id.

Nếu hiện tại TelegramMapping đang lưu trực tiếp chat/thread fields, triển khai migration theo hướng additive:
1. Thêm bảng TelegramDestination.
2. Thêm field destination id vào TelegramMapping.
3. Backfill destination từ mapping hiện có nếu an toàn.
4. Cập nhật service/UI dùng destination mới.
5. Không xóa field cũ trong cùng task nếu chưa cần.

## Quy tắc customer isolation

Khi tạo hoặc cập nhật mapping:
- Service phải load mailbox.
- Service phải load destination.
- Service phải kiểm tra mailbox và destination thuộc cùng customer.
- Nếu khác customer thì reject.
- UI cũng phải filter destination theo customer của mailbox, nhưng UI không được là lớp bảo mật duy nhất.

Staff read-only không được tạo/sửa destination hoặc mapping.

## Quy tắc one mailbox one active destination

TASK-053 không được làm thay đổi rule này.

Service tạo hoặc cập nhật mapping phải đảm bảo:
- Một mailbox chỉ có tối đa một active mapping.
- Nhiều mailbox được phép dùng chung một destination.
- Mailbox không có active mapping thì pipeline không gửi Telegram.
- Destination disabled thì mapping không được coi là hợp lệ để gửi.

## Yêu cầu UI

Trang Telegram nên có hai phần rõ ràng:
1. Danh sách Telegram destinations đã lưu.
2. Danh sách mailbox mappings.

Khi tạo mapping:
- Chọn customer hoặc mailbox.
- Danh sách mailbox phải theo scope quyền hiện có.
- Danh sách destination phải lọc theo customer tương ứng.
- Không yêu cầu nhập lại chat/thread ID nếu chọn destination đã lưu.
- Hiển thị rõ group/topic đang được chọn để tránh nhầm.

## Yêu cầu test

Cần có test cho các case sau:

- Tạo destination group thường.
- Tạo destination topic trong group.
- Không tạo trùng destination trong cùng customer nếu chat/thread giống nhau.
- Cho phép nhiều mailbox cùng customer dùng chung một destination.
- Không cho một mailbox có hai active mappings.
- Không cho mailbox của customer A map sang destination của customer B.
- Mapping tới destination disabled không được dùng để gửi.
- Worker/pipeline resolve đúng chat/thread từ destination.
- Test-send destination dùng đúng group/topic.
- STAFF_READ_ONLY không có quyền tạo/sửa destination hoặc mapping nếu role hiện tại quy định như vậy.

## Bảo mật

- Không log Telegram bot token.
- Không log verification code đầy đủ.
- Không log full email body.
- Không đọc hoặc in nội dung file env.
- Không hardcode chat ID/thread ID trong code hoặc docs.
- Error message trên UI không được lộ secret hoặc nội dung email đầy đủ.
- Khi ghi docs/report, tránh wording dễ gây secret scan false positive.

## Lệnh kiểm tra bắt buộc

Claude phải chạy:

```powershell
npm run verify
````

Nếu có migration/schema thay đổi, Claude phải đảm bảo Prisma client được generate qua verify flow hiện có.

## Tiêu chí nghiệm thu

* Admin/Owner tạo được reusable Telegram destination.
* Admin/Owner tạo mapping mailbox bằng cách chọn destination đã lưu.
* Nhiều mailbox dùng chung một destination thành công.
* Một mailbox không thể có nhiều active destinations.
* Không thể map mailbox sang destination của customer khác.
* Mailbox không có active mapping hoặc destination bị disabled thì không gửi Telegram.
* UI không còn bắt nhập lại chat/thread ID khi mapping đã chọn destination.
* Test liên quan đã được bổ sung hoặc cập nhật.
* npm run verify PASS.
* Gemini review PASS.
* Không có secret, token, verification code đầy đủ, full email body trong diff.