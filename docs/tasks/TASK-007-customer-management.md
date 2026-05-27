TASK-007: Tạo customer management tối giản
1. Mục tiêu
Tạo màn hình quản lý customer tối giản trong admin dashboard.
Trong dự án Verification Code Relay Tool, customer là khách hàng của agency. Sau này mỗi customer có thể được liên kết với mailbox Hotmail/Outlook, Telegram group, logs, health status và các cấu hình vận hành khác.
Trong TASK-007, chỉ cần xây dựng nền móng quản lý customer ở mức tối giản:
```text
Admin dashboard → Customers → List / Create / Edit customer
```
Task này thuộc Sprint 1 — Admin shell & access control.
---
2. Bối cảnh trong roadmap
Theo roadmap hiện tại:
```text
Sprint 1 — Admin shell & access control
- TASK-005: Tạo admin layout cơ bản
- TASK-006: Tạo authentication/admin role skeleton
- TASK-007: Tạo customer management tối giản
```
Vì vậy TASK-007 chỉ tập trung vào phần customer management trong admin dashboard.
Không làm mock email input trong task này. Mock email input là TASK-010.
Không làm Telegram trong task này. Telegram bắt đầu từ TASK-008 và TASK-009.
Không làm Microsoft OAuth trong task này. Microsoft OAuth bắt đầu từ TASK-017 trở đi.
---
3. Phạm vi được làm
TASK-007 được phép làm các phần sau:
```text
1. Tạo trang /admin/customers
2. Hiển thị danh sách customer
3. Tạo form thêm customer mới
4. Tạo form sửa customer cơ bản
5. Có validation cơ bản
6. Có service/API hoặc server action để xử lý customer
7. Có trạng thái customer nếu schema hiện tại đã hỗ trợ
8. Có loading/error state tối thiểu nếu phù hợp
9. Có test tối thiểu nếu project đã có test setup
```
Nếu database/Prisma schema đã có model `Customer`, hãy dùng model đó.
Nếu model `Customer` chưa tồn tại hoặc schema hiện tại khác dự kiến, Claude phải báo lại trước khi tự ý thay đổi lớn schema database.
---
4. Phạm vi không được làm
Không được làm các phần sau trong TASK-007:
```text
Không làm Telegram bot
Không làm Telegram mapping
Không làm Telegram test-send
Không làm Microsoft OAuth
Không làm mailbox connect
Không làm webhook
Không làm parser/extractor code
Không làm mock email input
Không làm log page
Không làm audit log page
Không làm health dashboard
Không làm queue/worker
Không làm delta polling
Không làm subscription renewal
Không refactor lớn ngoài scope customer management
```
Nếu phát hiện cần làm thêm phần nào ngoài scope, phải ghi chú lại thành đề xuất cho task sau, không tự ý code trong TASK-007.
---
5. Yêu cầu chức năng chi tiết
5.1. Trang danh sách customer
Tạo route:
```text
/admin/customers
```
Trang này cần có:
```text
- Tiêu đề: Customers
- Mô tả ngắn: Manage agency customers
- Nút Add customer hoặc New customer
- Bảng danh sách customer
```
Bảng danh sách customer nên có các cột tối thiểu:
```text
- Customer name
- Contact email
- Status nếu schema có
- Created at nếu schema có
- Actions
```
Actions tối thiểu:
```text
- Edit
```
Không cần làm delete cứng nếu chưa có yêu cầu rõ ràng. Nếu cần thao tác vô hiệu hóa customer, ưu tiên dùng status `DISABLED` thay vì xóa dữ liệu.
---
5.2. Trang tạo customer
Tạo route đề xuất:
```text
/admin/customers/new
```
Form tạo customer nên có:
```text
- Name / Customer name
- Contact email
- Notes / Description nếu schema có
- Status nếu schema có
```
Validation tối thiểu:
```text
- Name không được rỗng
- Contact email nếu nhập thì phải đúng dạng email
- Status chỉ nhận giá trị hợp lệ nếu có status
```
Sau khi tạo thành công:
```text
- Redirect về /admin/customers
hoặc
- Hiển thị thông báo thành công rồi quay về danh sách
```
---
5.3. Trang sửa customer
Tạo route đề xuất:
```text
/admin/customers/[id]/edit
```
Form sửa customer dùng lại component với form tạo customer nếu hợp lý.
Yêu cầu:
```text
- Load được dữ liệu customer hiện tại
- Cho phép sửa thông tin cơ bản
- Validate giống form tạo mới
- Lưu thành công thì quay về /admin/customers
```
Nếu không tìm thấy customer:
```text
- Hiển thị not found state
hoặc
- Redirect về /admin/customers kèm thông báo lỗi
```
---
6. Yêu cầu dữ liệu
Nếu Prisma schema hiện tại đã có model Customer, dùng đúng model hiện có.
Model customer định hướng có thể gồm:
```text
id
name
contactEmail
status
notes
createdAt
updatedAt
```
Status định hướng:
```text
ACTIVE
DISABLED
```
Nếu schema hiện tại dùng tên field khác, không tự ý đổi tên toàn bộ. Hãy bám theo schema hiện tại để tránh phá task trước.
Nếu chưa có `Customer` model nhưng TASK-004 đã hoàn thành, Claude cần kiểm tra lại `prisma/schema.prisma` và báo rõ tình trạng trước khi sửa.
---
7. File/thư mục dự kiến tạo hoặc sửa
Claude phải kiểm tra cấu trúc repo thực tế trước khi tạo file.
Nếu project dùng `app/` ở root, dự kiến:
```text
app/admin/customers/page.tsx
app/admin/customers/new/page.tsx
app/admin/customers/[id]/edit/page.tsx
app/api/customers/route.ts
app/api/customers/[id]/route.ts
components/forms/CustomerForm.tsx
components/tables/CustomersTable.tsx
services/customers/customer.service.ts
lib/validation/customer.ts
```
Nếu project dùng `src/`, tạo tương ứng dưới `src/`:
```text
src/app/admin/customers/page.tsx
src/app/admin/customers/new/page.tsx
src/app/admin/customers/[id]/edit/page.tsx
src/app/api/customers/route.ts
src/app/api/customers/[id]/route.ts
src/components/forms/CustomerForm.tsx
src/components/tables/CustomersTable.tsx
src/services/customers/customer.service.ts
src/lib/validation/customer.ts
```
Có thể điều chỉnh theo cấu trúc thực tế, nhưng không được tạo song song cả `src/` và non-`src/` nếu project đã chọn một hướng.
---
8. Yêu cầu kỹ thuật
8.1. UI
UI chỉ cần tối giản, rõ ràng, đồng bộ với admin layout đã có từ TASK-005.
Không cần dùng UI library mới nếu project chưa dùng.
Không cần thiết kế phức tạp.
Ưu tiên:
```text
- Dễ đọc
- Dễ thao tác
- Ít logic phức tạp
- Không phá layout admin hiện có
```
---
8.2. Service layer
Nếu project đã có convention service layer, tạo service cho customer.
Ví dụ:
```text
services/customers/customer.service.ts
```
Service nên có các hàm tối thiểu:
```text
listCustomers()
getCustomerById(id)
createCustomer(input)
updateCustomer(id, input)
```
Nếu có status:
```text
disableCustomer(id)
```
Nhưng chỉ tạo `disableCustomer` nếu UI hoặc schema thật sự cần.
---
8.3. API route hoặc server action
Claude cần bám theo kiến trúc hiện tại của project.
Nếu project đang dùng API route:
```text
GET /api/customers
POST /api/customers
GET /api/customers/:id
PATCH /api/customers/:id
```
Nếu project đang ưu tiên server actions, có thể dùng server actions thay vì API route.
Không được trộn nhiều pattern nếu project đã có quy ước rõ ràng.
---
8.4. Validation
Tạo validation riêng nếu phù hợp:
```text
lib/validation/customer.ts
```
Validation tối thiểu:
```text
name: required, string, trim, min length 1
contactEmail: optional hoặc required tùy schema, nếu có thì phải đúng email format
notes: optional string
status: chỉ ACTIVE hoặc DISABLED nếu có
```
Nếu project đã dùng Zod, ưu tiên dùng Zod.
Nếu chưa dùng Zod, không thêm dependency mới nếu không cần thiết. Có thể viết validation đơn giản bằng TypeScript.
---
9. Yêu cầu bảo mật
TASK-007 không xử lý secret, token hoặc verification code.
Tuy nhiên vẫn phải tuân thủ các nguyên tắc bảo mật của dự án:
```text
Không hardcode secret/token/password
Không đọc/in nội dung .env
Không log dữ liệu nhạy cảm
Không tạo field lưu token/code trong customer
Không hiển thị thông tin nhạy cảm không cần thiết trên frontend
```
Customer data trong task này chỉ nên là dữ liệu quản trị cơ bản:
```text
name
contactEmail
notes/status nếu cần
```
Không lưu:
```text
Hotmail password
Microsoft access token
Microsoft refresh token
Telegram bot token
Telegram chat secret
Verification code
Full email body
```
---
10. Yêu cầu test/verify
Sau khi code xong, bắt buộc chạy:
```powershell
npm run verify
```
Nếu project có test setup, nên có test tối thiểu cho:
```text
- Customer validation
- Customer service nếu dễ test
- Render customer form/table nếu project đã có React Testing Library
```
Không cần viết E2E test trong TASK-007 nếu roadmap chưa tới phần E2E.
---
11. Kiểm tra thủ công
Sau khi chạy app:
```powershell
npm run dev
```
Mở:
```text
http://localhost:3000/admin/customers
```
Checklist kiểm tra thủ công:
```text
[ ] Trang /admin/customers mở được
[ ] Giao diện nằm trong admin layout
[ ] Có tiêu đề Customers
[ ] Có nút Add/New customer
[ ] Có bảng danh sách customer
[ ] Tạo customer mới được
[ ] Form báo lỗi khi thiếu name
[ ] Email sai format bị báo lỗi nếu có field email
[ ] Sửa customer được
[ ] Refresh trang không lỗi
[ ] Không bị lỗi đỏ trong terminal
[ ] Không bị lỗi đỏ trong browser console
```
Nếu `/admin/customers` tự redirect về login, cần xác định:
```text
- Nếu chưa login mà bị redirect: có thể là đúng do TASK-006 route protection
- Nếu đã login mà vẫn bị redirect: cần kiểm tra lại auth skeleton của TASK-006
```
Không sửa rộng TASK-006 trong TASK-007 trừ khi lỗi rất nhỏ và trực tiếp chặn việc truy cập trang customers.
---
14. Definition of Done
TASK-007 chỉ được coi là hoàn thành khi đạt đủ:
```text
[ ] Đã tạo docs/tasks/TASK-007-customer-management.md
[ ] Đang làm trên branch riêng `feature/TASK-007-customer-management`
[ ] /admin/customers mở được
[ ] Trang customers nằm trong admin layout
[ ] Có danh sách customer
[ ] Có form tạo customer
[ ] Có form sửa customer
[ ] Validation cơ bản hoạt động
[ ] Không làm Telegram/Microsoft/webhook/parser/mock email
[ ] Không hardcode secret/token/password
[ ] Không đọc/in nội dung .env
[ ] npm run verify PASS
[ ] Gemini review PASS
[ ] GitHub Actions PASS nếu đã push
```
---
16. Rủi ro cần chú ý
16.1. Làm nhầm sang TASK-010
TASK-007 không phải mock email input.
Nếu Claude tạo `/admin/mock-email` hoặc parser/extractor, đó là vượt scope.
---
16.2. Làm nhầm sang TASK-008/TASK-009
TASK-007 không làm Telegram.
Nếu Claude tạo Telegram sender, Telegram mapping hoặc test-send API, đó là vượt scope.
---
16.3. Làm nhầm sang TASK-017+
TASK-007 không làm Microsoft OAuth.
Nếu Claude tạo Microsoft connect URL, OAuth callback, Graph mail service hoặc webhook, đó là vượt scope.
---
16.4. Phá auth skeleton từ TASK-006
Nếu `/admin/customers` bị redirect login khi chưa login, điều đó có thể đúng.
Nếu đã login mà vẫn redirect sai, chỉ sửa phần nhỏ trực tiếp liên quan. Không refactor toàn bộ auth trong task này.
---
16.5. Tạo trùng cấu trúc thư mục
Không được vừa tạo:
```text
app/admin/customers
```
vừa tạo:
```text
src/app/admin/customers
```
Claude phải kiểm tra project đang dùng cấu trúc nào rồi bám theo cấu trúc đó.
---
17. Kết luận
TASK-007 là task xây nền customer management cho admin dashboard.
Mục tiêu là làm đủ nhỏ, đúng scope, dễ kiểm tra:
```text
/admin/customers → list/create/edit customer
```
Không làm Telegram, Microsoft OAuth, webhook, parser hoặc mock email trong task này.
Sau task này, hệ thống sẽ có nền customer để các task sau tiếp tục gắn Telegram mapping, mailbox, logs và health status.