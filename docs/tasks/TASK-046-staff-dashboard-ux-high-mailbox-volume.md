# TASK-046 Staff dashboard UX for high mailbox volume

## Mục tiêu

Cải thiện dashboard nội bộ để nhân viên vận hành dễ quản lý nhiều mailbox cùng lúc.

Task này tập trung vào trải nghiệm đọc, tìm kiếm, lọc, sắp xếp và hiển thị trạng thái. Task này không viết lại phân quyền lõi, không đổi routing rule, không làm customer portal và không làm billing.

## Bối cảnh

Dự án là internal staff app cho agency.

Khách hàng không login vào hệ thống. Khách hàng chỉ nhận verification code qua Telegram group hoặc Telegram topic đã được cấu hình.

OWNER và ADMIN có thể xem, quản lý toàn bộ dữ liệu vận hành.

STAFF_READ_ONLY chỉ được thấy customer được gán và mailbox thuộc các customer đó, dựa trên nền assignment đã làm ở TASK-045.

TASK-041 đã chốt rằng nhiều mailbox có thể dùng chung một Telegram group hoặc cùng một topic trong group.

TASK-044 đã chốt rằng mỗi mailbox chỉ có tối đa một active Telegram destination.

TASK-045 đã thêm nền staff assignment và guard phân quyền. Còn một điểm UX ghi nhận là một số link hoặc action như New hoặc Edit có thể vẫn hiện cho STAFF dù backend guard đã chặn. TASK-046 có thể xử lý phần UX này nếu đúng scope.

## Vấn đề cần giải quyết

Khi một nhân viên quản lý nhiều mailbox, ví dụ 100 đến 200 mailbox, bảng danh sách đơn giản sẽ khó dùng.

Nhân viên cần tìm nhanh mailbox theo email, customer, trạng thái mailbox, trạng thái mapping và lỗi vận hành nếu dữ liệu hiện có hỗ trợ.

Nhân viên cũng cần nhìn rõ mailbox nào đã sẵn sàng gửi code, mailbox nào chưa có active Telegram mapping, mailbox nào có lỗi token hoặc subscription, và mailbox đang gửi về Telegram group hoặc topic nào.

Nếu UI vẫn hiện action mà STAFF không có quyền dùng, trải nghiệm sẽ gây hiểu nhầm dù backend đã chặn an toàn.

## Rule sản phẩm chính thức

Dashboard là dashboard nội bộ cho OWNER, ADMIN và STAFF_READ_ONLY.

STAFF_READ_ONLY chỉ được thấy dữ liệu trong phạm vi assignment từ TASK-045.

OWNER và ADMIN vẫn thấy toàn bộ dữ liệu cần quản lý.

Mỗi mailbox chỉ có tối đa một active Telegram destination.

Nhiều mailbox vẫn có thể dùng chung một Telegram group hoặc cùng một Telegram topic.

Task này không thay đổi business rule routing.

Task này không tạo customer login.

Task này không tạo customer portal.

Task này không tạo billing hoặc payment.

Task này không tạo multi-destination routing.

## Scope được làm

Rà soát các trang admin staff thường dùng, ưu tiên mailbox list.

Cải thiện mailbox list để dễ tìm theo mailbox email, customer, trạng thái mailbox và trạng thái mapping nếu data hiện có hỗ trợ.

Thêm hoặc cải thiện filter theo customer nếu data hiện có hỗ trợ.

Thêm hoặc cải thiện filter theo mailbox status nếu data hiện có hỗ trợ.

Thêm hoặc cải thiện filter theo mapping status, ví dụ Ready, Needs Mapping hoặc No Active Mapping.

Hiển thị rõ Telegram group hoặc topic tương ứng của từng mailbox nếu data hiện có hỗ trợ.

Hiển thị token issue hoặc subscription issue nếu mailbox list service hiện đã có dữ liệu an toàn để hiển thị.

Ẩn hoặc disable các link và action mà STAFF_READ_ONLY không có quyền dùng.

Đảm bảo UI không lộ dữ liệu ngoài staff assignment scope.

Chỉ thêm UI state và filter ở mức tối thiểu, dễ test và dễ bảo trì.

Thêm hoặc chỉnh test phù hợp cho dashboard, filter và permission visibility.

Cập nhật tài liệu task.

Có thể cập nhật PRODUCT_SPEC hoặc ROADMAP nếu cần chốt wording về internal staff dashboard.

## Scope không làm

Không làm customer login.

Không làm customer portal.

Không làm public SaaS.

Không làm billing hoặc payment.

Không làm multi-tenant SaaS phức tạp.

Không làm RBAC mới.

Không sửa lại mô hình StaffAssignment nếu TASK-045 đã ổn.

Không sửa Microsoft OAuth hoặc Microsoft Graph nếu không liên quan trực tiếp đến dashboard.

Không sửa Telegram sender nếu không liên quan trực tiếp đến dashboard.

Không sửa routing rule từ TASK-041.

Không sửa one-mailbox-one-destination rule từ TASK-044.

Không sửa production database.

Không đọc hoặc in nội dung env local.

Không tạo migration mới nếu chưa chứng minh thật sự cần.

Không sửa workflow CI theo hướng nới lỏng secret scan.

Không mở rộng sang TASK-047.

Không làm onboarding flow đầy đủ, vì TASK-047 mới là Safe mailbox onboarding flow.

Không thêm bulk action trong task này.

## UX đề xuất

Ưu tiên cải thiện trang mailboxes.

Mailbox list nên giúp staff trả lời nhanh các câu hỏi sau.

Mailbox này thuộc customer nào.

Mailbox này có đang active không.

Mailbox này đã có active Telegram mapping chưa.

Mailbox này sẽ gửi về Telegram group hoặc topic nào.

Mailbox này có dấu hiệu lỗi token hoặc subscription không, nếu dữ liệu hiện tại có hỗ trợ.

STAFF_READ_ONLY nên thấy giao diện đọc rõ ràng, không thấy hoặc không dùng được các action tạo mới, chỉnh sửa hoặc xóa nếu role không cho phép.

OWNER và ADMIN vẫn thấy các action quản lý cần thiết.

Trạng thái đề xuất.

Ready nghĩa là mailbox có active Telegram destination hợp lệ.

Needs Mapping nghĩa là mailbox chưa có active Telegram mapping.

Error nghĩa là mailbox hoặc luồng vận hành có lỗi mà data hiện tại đã ghi nhận.

Token Issue chỉ hiển thị nếu data hiện tại đã hỗ trợ an toàn.

Subscription Issue chỉ hiển thị nếu data hiện tại đã hỗ trợ an toàn.

## Yêu cầu chức năng

Mailbox list có search tối thiểu theo mailbox email.

Nếu service đã có customer name trong dữ liệu list, search có thể hỗ trợ customer name.

Mailbox list có filter theo customer nếu data hiện có hỗ trợ.

Mailbox list có filter theo mapping status nếu data hiện có hỗ trợ.

Mailbox list có filter theo mailbox status nếu data hiện có hỗ trợ.

Mailbox list hiển thị Telegram group hoặc topic nếu data hiện có hỗ trợ.

Mailbox list hiển thị rõ mailbox nào cần mapping.

STAFF_READ_ONLY không thấy hoặc không dùng được action không thuộc quyền.

OWNER và ADMIN không bị mất action quản lý hiện có.

Nếu cần cải thiện customer list hoặc telegram mapping list, chỉ sửa tối thiểu để đảm bảo UX nhất quán với role và assignment scope.

## Yêu cầu kỹ thuật

Ưu tiên sửa ở UI và service list hiện có.

Không tạo migration nếu chỉ cần dùng field hiện có.

Không viết lại auth hoặc permission lớn.

Không thay đổi business rule routing.

Không thay đổi pipeline xử lý email.

Không thay đổi worker hoặc queue nếu không liên quan.

Không thay đổi Microsoft OAuth hoặc Graph token flow nếu không liên quan.

Không thay đổi Telegram sender core nếu không liên quan.

Filter và search nên đơn giản, dễ đọc, dễ test.

Nếu filter chạy ở server side, cần bảo đảm filter không làm bypass assignment scope.

Nếu filter chạy ở client side, dữ liệu đầu vào vẫn phải là dữ liệu đã được scope đúng từ server.

## Yêu cầu bảo mật

Không đọc hoặc in nội dung env local.

Không log token, refresh token, client secret, Telegram bot token, verification code đầy đủ hoặc full email body.

Không hardcode secret hoặc credential.

Không đưa secret thật vào docs, code comment, test fixture hoặc report.

Không thao tác production database.

Không làm UI hiển thị dữ liệu ngoài phạm vi assignment của STAFF_READ_ONLY.

Không dựa vào UI hiding như lớp bảo mật duy nhất. Backend guard và service scope từ TASK-045 vẫn phải giữ nguyên.

Error message hiển thị cho UI không được chứa secret, token, full verification code hoặc full email body.

Docs trong task này cần tránh wording dễ gây secret scan false positive.

## Các điểm Claude cần kiểm tra

Đọc AGENTS.md, CLAUDE.md, GEMINI.md, docs/PRODUCT_SPEC.md, docs/ARCHITECTURE.md, docs/SECURITY_RULES.md, docs/ROADMAP.md và task file này.

Đọc các file liên quan từ TASK-045 để hiểu assignment scope hiện tại.

Kiểm tra mailbox list hiện đang lấy dữ liệu từ service nào.

Kiểm tra STAFF_READ_ONLY hiện thấy những trang, link và action nào.

Kiểm tra OWNER và ADMIN hiện dùng những action nào.

Kiểm tra Telegram mapping status hiện có thể suy ra từ dữ liệu nào.

Kiểm tra token hoặc subscription status hiện có dữ liệu an toàn để hiển thị hay chưa.

Kiểm tra các test hiện có liên quan dashboard và permission.

Trước khi sửa file, Claude phải báo hiểu task, file dự kiến sửa, phần không sửa và rủi ro.

## Các tình huống test cần có

STAFF_READ_ONLY chỉ thấy customer được gán.

STAFF_READ_ONLY chỉ thấy mailbox thuộc customer được gán.

STAFF_READ_ONLY không thấy dữ liệu ngoài assignment scope khi dùng search.

STAFF_READ_ONLY không thấy dữ liệu ngoài assignment scope khi dùng filter.

STAFF_READ_ONLY không thấy hoặc không dùng được action New hoặc Edit nếu role không cho phép.

OWNER thấy toàn bộ customer và mailbox.

ADMIN thấy toàn bộ customer và mailbox nếu quyền hiện tại cho phép.

Mailbox không có active mapping hiển thị trạng thái cần mapping.

Mailbox có active mapping hiển thị trạng thái sẵn sàng.

Mailbox có Telegram topic hiển thị topic rõ nếu dữ liệu hiện có hỗ trợ.

Search theo mailbox email hoạt động.

Filter theo customer hoạt động nếu được implement.

Filter theo mapping status hoạt động nếu được implement.

Không tạo hoặc gửi Telegram message trong test dashboard nếu không cần.

Không log secret, token, code đầy đủ hoặc full email body trong test.

## Lệnh kiểm tra

Chạy các lệnh kiểm tra chuẩn của project.

```powershell
npm run verify
````

Có thể chạy thêm test targeted nếu Claude xác định được file test liên quan.

```powershell
npm test -- --run
```

Trước khi báo hoàn tất, Claude cần chạy.

```powershell
git status --short
git diff --stat
```

## Tiêu chí nghiệm thu

Task có file docs/tasks/TASK-046-staff-dashboard-ux-high-mailbox-volume.md.

Dashboard mailbox dễ dùng hơn cho staff khi số lượng mailbox lớn.

STAFF_READ_ONLY chỉ thấy dữ liệu trong phạm vi assignment.

OWNER và ADMIN vẫn thấy dữ liệu cần quản lý.

Search hoặc filter tối thiểu hoạt động và không bypass assignment scope.

Mailbox chưa có active mapping được hiển thị rõ.

Telegram group hoặc topic được hiển thị rõ nếu data hiện có hỗ trợ.

STAFF_READ_ONLY không thấy hoặc không dùng được action không có quyền.

Không thay đổi routing rule từ TASK-041.

Không thay đổi one-mailbox-one-destination rule từ TASK-044.

Không mở rộng sang TASK-047.

Không tạo customer portal.

Không tạo billing hoặc payment.

Không đọc hoặc in env local.

Không có secret thật trong diff.

Không tạo migration nếu không có lý do kỹ thuật rõ.

npm run verify PASS.

Gemini review PASS.

GitHub Actions PASS sau khi push.

## Format báo cáo sau khi Claude làm xong

Claude cần báo cáo bằng tiếng Việt dễ hiểu.

Nội dung báo cáo cần có.

Một là đã thay đổi gì.

Hai là file nào đã thay đổi.

Ba là đã giữ scope như thế nào.

Bốn là cách dashboard hỗ trợ staff quản lý nhiều mailbox.

Năm là cách đảm bảo STAFF_READ_ONLY không thấy dữ liệu ngoài assignment scope.

Sáu là cách đảm bảo OWNER và ADMIN không bị mất quyền.

Bảy là test đã thêm hoặc chỉnh.

Tám là lệnh đã chạy và kết quả PASS hoặc FAIL.

Chín là kết quả git status short.

Mười là kết quả git diff stat.

Claude không được commit.

````

---