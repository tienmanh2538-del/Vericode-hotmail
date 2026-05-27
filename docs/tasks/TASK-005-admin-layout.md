# TASK-005: Tạo admin layout cơ bản

## 1. Mục tiêu

Tạo khung giao diện admin dashboard cơ bản cho dự án Verification Code Relay Tool.

Task này chỉ dựng layout nền cho các module sau này, bao gồm:

- Admin shell
- Sidebar navigation
- Topbar
- Trang `/admin` tạm thời
- Khu vực content để các task sau gắn Customers, Mailboxes, Telegram, Logs, Health

## 2. Phạm vi

Chỉ làm UI layout tĩnh. Không làm business logic thật.

## 3. File/thư mục dự kiến tạo hoặc sửa

Claude Code phải kiểm tra cấu trúc project thực tế trước.

Nếu project dùng root `app/`:

- `app/admin/layout.tsx`
- `app/admin/page.tsx`
- `components/layout/AdminShell.tsx`
- `components/layout/AdminSidebar.tsx`
- `components/layout/AdminTopbar.tsx`

Nếu project dùng `src/`:

- `src/app/admin/layout.tsx`
- `src/app/admin/page.tsx`
- `src/components/layout/AdminShell.tsx`
- `src/components/layout/AdminSidebar.tsx`
- `src/components/layout/AdminTopbar.tsx`

Có thể sửa nhẹ file CSS global hiện có nếu cần cho layout hiển thị ổn, nhưng không refactor lớn.

## 4. Yêu cầu chi tiết

### 4.1. Admin layout

Tạo route `/admin`.

Layout cần có:

- Sidebar bên trái
- Topbar phía trên
- Main content area
- Responsive cơ bản, không vỡ layout trên desktop
- Không cần mobile menu phức tạp

### 4.2. Sidebar

Sidebar hiển thị tên app:

`Verification Tool`

Menu placeholder gồm:

- Dashboard → `/admin`
- Customers → `/admin/customers`
- Mailboxes → `/admin/mailboxes`
- Telegram → `/admin/telegram`
- Logs → `/admin/logs`
- Health → `/admin/health`

Các route chưa tồn tại vẫn có thể để link placeholder, nhưng không được tạo page cho các module task tương lai trừ khi cần tránh lỗi build. Nếu cần tạo page placeholder, phải giải thích rõ và giữ nội dung tối thiểu.

### 4.3. Topbar

Topbar hiển thị:

- Tiêu đề: `Admin Dashboard`
- Mô tả ngắn: `Internal tool for verification code relay`
- Badge trạng thái tĩnh: `MVP Setup`

Không hiển thị thông tin user thật vì auth sẽ làm ở TASK-006.

### 4.4. Trang `/admin`

Trang `/admin` hiển thị dashboard tĩnh gồm một số card placeholder:

- Connected mailboxes: `Coming soon`
- Telegram mappings: `Coming soon`
- Recent code events: `Coming soon`
- System health: `Coming soon`

Có thể có section “Next setup steps” nhưng chỉ là text tĩnh.

## 5. Không được làm

- Không làm authentication thật.
- Không làm role/permission thật.
- Không tạo middleware bảo vệ route.
- Không tạo customer CRUD.
- Không tạo mailbox CRUD.
- Không tạo Telegram API.
- Không tạo Microsoft OAuth.
- Không tạo database query.
- Không đọc hoặc in nội dung `.env`.
- Không hardcode secret/token/password/chat ID.
- Không thêm package mới nếu không thật sự cần.
- Không refactor cấu trúc lớn của project.

## 6. Tiêu chí nghiệm thu

Task đạt khi:

- Mở `/admin` thấy admin dashboard layout cơ bản.
- Có sidebar, topbar, main content.
- Code nằm đúng thư mục theo cấu trúc thực tế của project.
- Không có logic auth/database/API thật.
- Không có secret/token/password/chat ID trong code.
- `npm run verify` PASS.
- Gemini review PASS.

## 7. Lệnh kiểm tra

Chạy:

```powershell
npm run verify
npm run dev

Sau đó mở:

http://localhost:3000/admin

##8. Báo cáo cuối task

Claude phải báo lại:

Đã làm gì
File nào đã tạo/sửa
Lệnh nào đã chạy
Kết quả npm run verify
Có làm vượt scope không
Rủi ro còn lại