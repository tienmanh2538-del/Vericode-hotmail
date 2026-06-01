# TASK-045 Internal staff ownership and assignment model

## Mục tiêu

TASK-045 đặt nền cho mô hình nhân viên nội bộ quản lý customer và mailbox trong Verification Code Relay Tool.

Mục tiêu chính là đảm bảo OWNER và ADMIN có thể xem toàn bộ dữ liệu vận hành, còn STAFF chỉ thấy customer và mailbox được giao phụ trách.

Task này không biến sản phẩm thành public SaaS. Khách hàng vẫn chỉ nhận verification code qua Telegram group hoặc topic. Khách hàng chưa cần tài khoản đăng nhập.

## Bối cảnh

Dự án đã hoàn thành các phần cốt lõi như customer management, mailbox dashboard, Telegram mapping, Microsoft mailbox flow, worker, logs, health và routing rule.

Từ TASK-041, nhiều mailbox có thể cùng dùng chung một Telegram group hoặc topic.

Từ TASK-044, mỗi mailbox chỉ có tối đa một Telegram destination đang active.

Ứng dụng này dùng nội bộ cho agency. Người dùng dashboard chính là OWNER, ADMIN và nhân viên vận hành nội bộ.

Khi số lượng mailbox tăng, nếu mọi nhân viên đều thấy toàn bộ customer và mailbox thì dễ xem nhầm, sửa nhầm, hoặc mapping nhầm Telegram destination.

## Vấn đề cần giải quyết

Cần có mô hình assignment tối thiểu để xác định nhân viên nào được phép xem hoặc vận hành customer và mailbox nào.

Cần tránh việc STAFF nhìn thấy customer hoặc mailbox ngoài phạm vi được giao.

Cần giữ OWNER và ADMIN có quyền xem toàn bộ để quản lý hệ thống.

Cần tận dụng role và permission skeleton hiện có nếu đã có. Không viết lại hệ auth lớn trong task này.

## Rule sản phẩm chính thức

Ứng dụng là internal staff app cho agency.

Khách hàng không đăng nhập dashboard trong task này.

OWNER và ADMIN được xem và quản lý toàn bộ customer, mailbox và Telegram mapping.

STAFF chỉ thấy customer được gán và mailbox thuộc các customer đó.

Mailbox thuộc customer đã được gán cho STAFF thì tự nằm trong phạm vi STAFF đó.

STAFF không được thấy customer hoặc mailbox ngoài phạm vi được gán.

TASK-045 ưu tiên assignment theo customer. Mailbox-level assignment chỉ được thêm nếu code hiện tại đã có nền hoặc Claude chứng minh thật sự cần.

TASK-045 không thay đổi rule nhiều mailbox dùng chung một Telegram group hoặc topic.

TASK-045 không thay đổi rule mỗi mailbox chỉ có một Telegram destination active.

## Scope được làm

Rà soát role hiện có như OWNER, ADMIN, STAFF_READ_ONLY hoặc role tương tự.

Rà soát các file auth, permission, guard hiện có.

Rà soát schema User, Customer và Mailbox nếu có liên quan.

Đề xuất hoặc triển khai mô hình staff assignment tối thiểu.

Ưu tiên mô hình staff được gán theo customer.

Đảm bảo mailbox thuộc customer được gán sẽ nằm trong phạm vi STAFF.

Cập nhật docs task này.

Cập nhật PRODUCT_SPEC hoặc ROADMAP nếu cần để chốt ứng dụng là internal staff app.

Nếu cần sửa code, chỉ sửa tối thiểu ở auth, permission, service query hoặc guard liên quan.

Thêm hoặc chỉnh test để xác nhận STAFF không xem hoặc sửa dữ liệu ngoài phạm vi được gán.

Đảm bảo OWNER và ADMIN vẫn xem được toàn bộ dữ liệu.

Đảm bảo customer không cần login.

Nếu audit log hiện tại dễ dùng, thêm ghi nhận khi assign hoặc unassign staff. Nếu chưa phù hợp, ghi rõ là yêu cầu cho task sau và không mở rộng quá mức.

## Scope không làm

Không làm customer login.

Không làm customer portal.

Không làm public SaaS.

Không làm billing hoặc payment.

Không làm multi-tenant SaaS phức tạp.

Không làm RBAC phức tạp vượt nhu cầu nội bộ.

Không sửa Microsoft OAuth hoặc Microsoft Graph nếu không liên quan.

Không sửa Telegram sender nếu không liên quan.

Không sửa routing rule đã chốt ở TASK-041.

Không sửa one-mailbox-one-active-destination rule đã chốt ở TASK-044.

Không sửa production database.

Không đọc hoặc in nội dung .env hay .env.local.

Không tạo migration mới nếu chưa chứng minh thật sự cần.

Không sửa workflow CI theo hướng nới lỏng secret scan.

Không mở rộng sang TASK-046 hoặc các task sau.

Không làm dashboard UX lớn cho 100 đến 200 mailbox. Việc đó để TASK-046.

## Mô hình quyền đề xuất

OWNER là quyền cao nhất của hệ thống.

ADMIN là quyền quản trị nội bộ, có thể xem và quản lý toàn bộ customer, mailbox, Telegram mapping, logs và assignment.

STAFF là nhân viên vận hành nội bộ, chỉ thấy dữ liệu được giao.

Nếu code hiện tại chỉ có STAFF_READ_ONLY, hãy tận dụng role đó trước thay vì đổi auth lớn.

Trong TASK-045, STAFF nên có quyền xem customer được gán, mailbox thuộc customer được gán, mapping liên quan và log liên quan nếu service hỗ trợ filter an toàn.

Trong TASK-045, STAFF chưa nên có quyền assign hoặc unassign staff.

Trong TASK-045, STAFF chưa nên có quyền sửa role của user.

Nếu mở quyền sửa mapping cho STAFF, chỉ được sửa mapping trong phạm vi customer được gán và phải có test rõ ràng. Nếu không chắc, giữ STAFF ở mức xem trước.

## Yêu cầu chức năng

OWNER và ADMIN xem được toàn bộ danh sách customer.

OWNER và ADMIN xem được toàn bộ danh sách mailbox.

OWNER và ADMIN xem được toàn bộ mapping liên quan.

STAFF chỉ xem được customer được gán.

STAFF chỉ xem được mailbox thuộc customer được gán.

STAFF không xem được mailbox thuộc customer chưa được gán.

STAFF không xem hoặc sửa được Telegram mapping của mailbox ngoài phạm vi được gán.

Nếu có trang hoặc service detail cho mailbox, STAFF truy cập mailbox ngoài phạm vi phải bị chặn hoặc nhận kết quả không tìm thấy theo cách an toàn.

Nếu có log service liên quan mailbox hoặc customer, STAFF chỉ được xem log trong phạm vi được gán nếu filter đã an toàn. Nếu chưa có filter an toàn thì không mở quyền xem log cho STAFF trong task này.

OWNER và ADMIN có thể dùng toàn bộ dashboard như trước.

Customer không có tài khoản login và không truy cập dashboard.

## Yêu cầu kỹ thuật

Claude phải đọc các file auth, permission, guard, schema và service liên quan trước khi sửa.

Claude phải xác minh code hiện tại đã có role skeleton nào.

Claude phải tận dụng role và permission skeleton hiện có nếu phù hợp.

Claude phải ưu tiên filter và guard ở service layer để tránh UI chỉ ẩn nhưng backend vẫn lộ dữ liệu.

Nếu cần schema mới, Claude phải giải thích vì sao không thể dùng schema hiện tại.

Nếu cần migration mới, Claude phải giải thích rõ lý do, phạm vi thay đổi, và rủi ro.

Không tạo migration chỉ vì muốn đổi tên role hoặc làm đẹp schema.

Không thao tác production database.

Không đọc hoặc in nội dung .env hay .env.local.

Không sửa Microsoft OAuth, token rotation, Graph subscription, webhook, delta polling, email detector, code extractor, Telegram sender hoặc queue nếu không liên quan.

Không phá các test hiện có.

Nếu thêm test, ưu tiên unit test hoặc service test dễ hiểu.

## Yêu cầu bảo mật

Không hardcode token, API key, password, client secret hoặc giá trị nhạy cảm.

Không log token, refresh token, client secret, Telegram bot token, verification code đầy đủ hoặc full email body.

Không đưa secret thật vào docs, code comment, test fixture hoặc commit message.

Không đọc hoặc in nội dung .env hay .env.local.

Không làm lộ dữ liệu customer hoặc mailbox ngoài phạm vi STAFF được gán.

Error message hiển thị cho STAFF không được tiết lộ dữ liệu ngoài phạm vi.

Docs task không được chứa metadata nhạy cảm dạng keyword value dễ gây secret scan false positive.

Không sửa workflow secret scan trong task này.

## Các điểm Claude cần kiểm tra

Kiểm tra hiện tại có những role nào trong auth skeleton.

Kiểm tra permission hiện tại đang được định nghĩa ở đâu.

Kiểm tra guard hiện tại bảo vệ route hoặc service như thế nào.

Kiểm tra User, Customer và Mailbox hiện tại có quan hệ nào có thể tận dụng cho assignment không.

Kiểm tra customer list service hiện lọc dữ liệu thế nào.

Kiểm tra mailbox list service hiện lấy dữ liệu thế nào.

Kiểm tra mailbox detail service có guard theo user hoặc role chưa.

Kiểm tra Telegram mapping service có guard theo mailbox hoặc customer chưa.

Kiểm tra logs service có thể filter an toàn theo customer hoặc mailbox không.

Kiểm tra test hiện tại có pattern nào để tạo user role OWNER, ADMIN, STAFF_READ_ONLY không.

Kiểm tra docs có wording nào dễ gây secret scan false positive không trước khi hoàn tất.

## Các tình huống test cần có

OWNER xem được toàn bộ customer.

ADMIN xem được toàn bộ customer.

STAFF chỉ xem được customer được gán.

STAFF không thấy customer chưa được gán.

OWNER xem được toàn bộ mailbox.

ADMIN xem được toàn bộ mailbox.

STAFF chỉ xem được mailbox thuộc customer được gán.

STAFF không xem được mailbox detail ngoài phạm vi được gán.

STAFF không sửa được mapping ngoài phạm vi được gán.

Nếu STAFF được phép sửa mapping trong phạm vi được gán, cần test chỉ sửa được mapping của mailbox thuộc customer được gán.

OWNER hoặc ADMIN vẫn không bị giới hạn bởi staff assignment.

Customer không có login hoặc portal trong task này.

Các rule TASK-041 và TASK-044 vẫn đúng sau thay đổi.

npm run verify phải pass.

## Lệnh kiểm tra

Claude cần chạy các lệnh phù hợp sau khi sửa.

```bash
npm run verify
git status --short
git diff --stat
````

Nếu có thay đổi Prisma schema, Claude cần chạy thêm lệnh generate phù hợp với project hiện tại.

```bash
npx prisma generate
npm run verify
```

Không chạy lệnh migration trên production database.

## Tiêu chí nghiệm thu

Có file task TASK-045 trong docs/tasks.

Mô hình internal staff app được mô tả rõ.

OWNER và ADMIN có quyền toàn hệ thống.

STAFF chỉ thấy dữ liệu được gán.

Customer không cần login.

Không làm public SaaS.

Không làm billing hoặc payment.

Không làm customer portal.

Không phá rule nhiều mailbox dùng chung Telegram group hoặc topic.

Không phá rule mỗi mailbox chỉ có một active destination.

Không sửa Microsoft OAuth hoặc Graph nếu không liên quan.

Không đọc hoặc in nội dung .env hay .env.local.

Không có secret thật trong diff.

Không có wording docs dễ gây secret scan false positive.

npm run verify pass.

Gemini review pass.

## Format báo cáo sau khi Claude làm xong

Claude cần báo cáo bằng tiếng Việt theo cấu trúc sau.

### Tôi đã thay đổi gì

Tóm tắt ngắn gọn thay đổi chính.

### File đã thay đổi

Liệt kê từng file đã sửa hoặc tạo.

### Mô hình assignment đã chọn

Nêu rõ chọn assignment theo customer, theo mailbox, hay tận dụng mô hình sẵn có.

### Quyền của từng role

Nêu rõ OWNER, ADMIN và STAFF hoặc STAFF_READ_ONLY được làm gì.

### Test đã thêm hoặc đã chỉnh

Liệt kê test liên quan.

### Lệnh đã chạy

Ghi rõ npm run verify pass hay fail.

### Trạng thái git

Dán kết quả git status --short và git diff --stat.

### Rủi ro còn lại

Nêu rủi ro nếu có, không che giấu.

### Phần cần Gemini review kỹ

Chỉ rõ các file hoặc logic cần Gemini xem kỹ.

````

---

## Kết quả triển khai (Claude)

### Mô hình assignment đã chọn

Assignment theo **customer** (không thêm mailbox-level). Lý do: quan hệ
`Mailbox.customerId` đã có sẵn nên gán customer là tự động phủ luôn mailbox và
Telegram mapping thuộc customer đó — tránh tạo nguồn sự thật thứ hai. Thêm bảng
join `StaffAssignment(userId, customerId, assignedById?, createdAt)` với
`@@unique([userId, customerId])`.

### Quyền sau khi sửa

- OWNER / ADMIN: scope `all` — xem & quản lý toàn bộ customer, mailbox, mapping;
  không bị `StaffAssignment` giới hạn. Có thêm permission `MANAGE_STAFF_ASSIGNMENTS`.
- STAFF_READ_ONLY: scope `assigned` — chỉ thấy customer được gán + mailbox/mapping
  thuộc các customer đó. Không có permission `MANAGE_*` nào ⇒ mọi action ghi
  (customer / telegram mapping / assignment) và mọi trang edit/new đều fail-closed.
  Staff chưa được gán customer nào ⇒ không thấy gì (fail-closed).

### Enforcement

Lọc/guard đặt ở **service layer** (`listCustomers` / `listMailboxesForAdmin` /
`getMailboxDetailById` / `listTelegramMappings` / `getTelegramMappingById` nhận
tham số `CustomerScope`), không chỉ ẩn ở UI. Scope được resolve một chỗ tại
`lib/auth/access-scope.ts`. Mailbox/mapping ngoài scope trả `null` (notFound),
không lộ sự tồn tại.

### Không phá rule cũ

`findActiveMappingForMailbox` (worker/sender) và toàn bộ logic create/update/
disable/delete mapping **không đổi** ⇒ rule TASK-041 (nhiều mailbox dùng chung
group/topic) và TASK-044 (mỗi mailbox tối đa một active destination) giữ nguyên.

### Migration

Đã tạo `prisma/migrations/20260601000000_task045_staff_assignment/migration.sql`
(SQL sinh offline bằng `prisma migrate diff`, không kết nối DB). Migration **chưa
được apply** từ máy phát triển để tránh chạm vào DATABASE_URL có thể trỏ
production; ops cần chạy `prisma migrate deploy` ở môi trường dev/staging trước
khi code đọc `StaffAssignment` chạy runtime.

### Audit log assign/unassign

Hoãn sang task sau: audit log hiện là store in-memory (TASK-016) và chưa có
action cho staff assignment; thêm vào đây sẽ vượt phạm vi tối thiểu. Đề xuất bổ
sung khi có UI quản lý assignment (TASK-046).