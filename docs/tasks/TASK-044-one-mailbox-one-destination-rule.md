

## 8. Nội dung chi tiết cho file task

Bạn có thể copy toàn bộ nội dung dưới đây vào file:

`docs/tasks/TASK-044-one-mailbox-one-destination-rule.md`

````markdown
# TASK-044 One mailbox one destination routing rule

## Mục tiêu

Chốt chính thức rule routing cho Telegram destination:

Mỗi mailbox chỉ được có đúng một Telegram destination đang active.

Destination có thể là một Telegram group thường hoặc một topic trong Telegram group.

Task này không mở rộng routing. Task này chỉ làm rõ và kiểm tra rằng hệ thống không cho một mailbox gửi verification code tới nhiều destination cùng lúc.

## Bối cảnh

TASK-041 đã cho phép nhiều mailbox cùng dùng chung một Telegram group hoặc cùng một topic trong group. Đây là hành vi hợp lệ.

Ví dụ hợp lệ:

```text
Mailbox A gửi về Group X hoặc Topic Y.
Mailbox B cũng gửi về Group X hoặc Topic Y.
Mailbox C cũng gửi về Group X hoặc Topic Y.
````

Nhưng điều đó không có nghĩa là một mailbox được gửi tới nhiều destination.

Ví dụ không hợp lệ trong scope hiện tại:

```text
Mailbox A gửi về Group X.
Mailbox A cũng gửi về Group Z.
Mailbox A cũng gửi về Topic Y.
```

App này dùng nội bộ cho nhân viên vận hành, không phải public SaaS. Vì vậy rule đơn giản và an toàn nhất là mỗi mailbox chỉ có một destination active.

## Vấn đề cần giải quyết

Nếu một mailbox có nhiều active Telegram mapping, hệ thống có thể gặp các rủi ro sau:

* Gửi verification code nhầm group hoặc nhầm topic.
* Gửi cùng một code tới nhiều nơi ngoài ý muốn.
* Nhân viên vận hành không biết destination nào là destination chính.
* Audit log khó giải thích khi xảy ra sự cố.
* UI có thể làm người dùng hiểu nhầm rằng app hỗ trợ broadcast hoặc multi-destination.

TASK-044 cần biến rule này thành rule rõ ràng trong docs, code hoặc test nếu cần.

## Rule chính thức

Rule chính thức của TASK-044:

```text
Mỗi mailbox chỉ được có đúng một active Telegram destination.
```

Destination được hiểu là một trong hai loại sau:

```text
Telegram group thường.
Telegram topic trong một Telegram group.
```

Các rule đi kèm:

```text
Nhiều mailbox được phép dùng chung cùng một group.
Nhiều mailbox được phép dùng chung cùng một topic trong group.
Một mailbox không được có nhiều active destination cùng lúc.
Mailbox chưa có active destination thì không được relay verification code.
```

## Scope được làm

TASK-044 được phép làm các việc sau:

* Rà soát Prisma schema liên quan TelegramMapping.
* Rà soát service resolve Telegram destination theo mailbox.
* Rà soát logic tạo và cập nhật Telegram mapping.
* Rà soát UI form và table Telegram mapping.
* Rà soát test hiện có liên quan Telegram mapping và routing.
* Cập nhật docs để rule one mailbox one destination trở thành rule chính thức.
* Thêm hoặc chỉnh test để chứng minh mỗi mailbox chỉ có một active destination.
* Nếu code hiện tại chưa enforce đủ, sửa tối thiểu ở service hoặc UI liên quan.
* Đảm bảo không phá rule từ TASK-041 rằng nhiều mailbox có thể dùng chung group hoặc topic.

## Scope không làm

TASK-044 không làm các việc sau:

* Không làm một mailbox gửi tới nhiều destination.
* Không broadcast verification code tới nhiều group.
* Không thay đổi rule many mailboxes to one group or topic từ TASK-041.
* Không sửa Microsoft OAuth hoặc Microsoft Graph nếu không liên quan.
* Không sửa webhook, delta polling, queue worker nếu không liên quan.
* Không sửa email detector hoặc code extractor nếu không liên quan.
* Không sửa Telegram retry hoặc failure handling nếu không liên quan.
* Không tạo migration mới nếu không thật sự cần.
* Không thao tác production database.
* Không đọc hoặc in nội dung env file.
* Không sửa CI workflow để nới lỏng secret scan.
* Không mở rộng sang TASK-045 hoặc các task sau.

## Yêu cầu chức năng

Hệ thống cần đáp ứng các yêu cầu sau:

```text
Khi resolve destination cho một mailbox, hệ thống chỉ chọn một active destination.
Nếu mailbox không có active destination, hệ thống không được gửi verification code.
Nếu người dùng cố tạo thêm active destination thứ hai cho cùng một mailbox, hệ thống phải ngăn lại hoặc xử lý theo logic an toàn đã được chọn.
Nếu người dùng đổi destination của mailbox, trạng thái sau cùng vẫn phải chỉ có một active destination.
Nhiều mailbox vẫn được phép cùng trỏ tới một group hoặc cùng một topic.
```

Claude cần kiểm tra hiện tại code đang dùng mô hình nào:

```text
Tạo mapping mới rồi deactivate mapping cũ.
Hoặc reject khi đã có active mapping khác.
Hoặc update trực tiếp mapping hiện có.
```

Nếu đã có mô hình an toàn, không đổi hành vi lớn. Chỉ thêm docs và test để khóa rule.

## Yêu cầu kỹ thuật

Claude cần ưu tiên giải pháp tối thiểu.

Thứ tự ưu tiên:

```text
1. Nếu code hiện tại đã enforce đủ, chỉ bổ sung docs và test.
2. Nếu thiếu test, thêm test nhỏ nhất để chứng minh rule.
3. Nếu service cho phép nhiều active destination cho cùng mailbox, sửa ở service layer trước.
4. Nếu API bypass service validation, sửa API để dùng service đúng cách.
5. Chỉ sửa UI nếu UI gây hiểu nhầm hoặc cho phép thao tác nguy hiểm.
6. Chỉ sửa schema hoặc tạo migration nếu có bằng chứng service-level enforcement không đủ.
```

Không được sửa rộng sang kiến trúc routing mới.

Không được thêm multi-destination array, broadcast list, routing policy phức tạp, hoặc feature flag cho nhiều destination.

## Yêu cầu bảo mật

Claude và Gemini phải tuân thủ các yêu cầu sau:

```text
Không đọc hoặc in nội dung env file.
Không ghi token, client secret, bot token, refresh token, verification code đầy đủ, full email body vào docs, code, test output hoặc log.
Không hardcode Telegram bot token, chat ID thật, mailbox thật, hoặc dữ liệu khách hàng thật.
Test chỉ dùng fake data an toàn.
Không thao tác production database.
Không sửa workflow secret scan để bỏ qua cảnh báo.
Không đưa wording trong docs dễ bị hiểu nhầm là secret thật.
```

Nếu cần nói về secret, chỉ nói bằng mô tả chung. Không ghi bất kỳ giá trị thật nào.

## Các điểm Claude cần kiểm tra

Claude cần kiểm tra tối thiểu các khu vực sau:

```text
Prisma model TelegramMapping.
Service quản lý Telegram mapping.
Service hoặc pipeline resolve Telegram destination theo mailbox.
API routes tạo hoặc cập nhật Telegram mapping.
UI form Telegram mapping.
UI table Telegram mapping.
Unit test hoặc E2E test liên quan Telegram mapping và routing.
```

Claude cần trả lời rõ:

```text
Hiện tại code có cho một mailbox có nhiều active mapping không?
Nếu có, nguyên nhân nằm ở service, API, UI, schema hay test thiếu?
Nếu không, test nào chứng minh điều đó?
Có còn cho phép nhiều mailbox dùng chung một group hoặc topic không?
Có cần sửa schema hoặc migration không?
```

## Các tình huống test cần có

Tối thiểu cần có test hoặc bằng chứng tương đương cho các tình huống sau:

```text
Một mailbox có một active Telegram group destination thì resolve đúng group đó.
Một mailbox có một active Telegram topic destination thì resolve đúng group và thread.
Mailbox không có active destination thì không gửi verification code.
Không thể tạo trạng thái cuối cùng trong đó một mailbox có nhiều active destination.
Hai mailbox khác nhau vẫn có thể dùng chung cùng một Telegram group.
Hai mailbox khác nhau vẫn có thể dùng chung cùng một Telegram topic.
Nếu đổi destination cho một mailbox, trạng thái sau cùng vẫn chỉ còn một active destination.
```

Nếu một số test đã tồn tại, Claude không cần viết trùng. Claude chỉ cần bổ sung phần còn thiếu.

## Lệnh kiểm tra

Sau khi sửa, Claude phải chạy:

```powershell
npm run verify
```

Claude cũng cần báo lại:

```powershell
git status --short
git diff --stat
```

Không commit trong task này. Commit chỉ thực hiện sau khi Gemini review PASS và người dùng xác nhận.

## Tiêu chí nghiệm thu

TASK-044 được coi là PASS khi:

```text
Có file task này trong docs/tasks.
Rule one mailbox one active Telegram destination được ghi rõ trong docs phù hợp.
Code hoặc test chứng minh một mailbox không thể có nhiều active destination cùng lúc.
Nhiều mailbox vẫn được phép dùng chung một group hoặc topic.
Không có multi-destination hoặc broadcast routing mới.
Không sửa Microsoft OAuth, Graph, webhook, queue worker, email detector hoặc extractor nếu không liên quan.
Không tạo migration mới nếu không có bằng chứng thật sự cần.
Không đọc hoặc in env file.
Không có secret thật trong diff.
Docs không có wording dễ gây secret scan false positive.
npm run verify PASS.
Gemini review PASS.
```

## Format báo cáo sau khi Claude làm xong

Sau khi hoàn tất, Claude phải báo cáo theo format sau:

```text
1. Tôi đã kiểm tra những file nào

2. Kết luận về trạng thái hiện tại
- Code trước task đã enforce đủ hay chưa.
- Nếu chưa, thiếu ở đâu.

3. Tôi đã thay đổi những gì
- Docs.
- Service.
- UI.
- Test.

4. File đã thay đổi

5. Lệnh đã chạy
- npm run verify
- git status --short
- git diff --stat

6. Kết quả kiểm tra
- PASS hoặc FAIL.
- Nếu FAIL, ghi rõ lỗi và chưa commit.

7. Xác nhận scope
- Không làm multi-destination.
- Không phá rule nhiều mailbox dùng chung group hoặc topic.
- Không đọc hoặc in env file.
- Không tạo migration nếu không cần.

8. Phần cần Gemini review kỹ
```

````

---

