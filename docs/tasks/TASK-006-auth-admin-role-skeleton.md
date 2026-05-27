# TASK-006: Tạo authentication/admin role skeleton

## 1. Mục tiêu

Tạo khung authentication và role-based access control tối thiểu cho admin dashboard.

Sau task này, project phải có:
- Khái niệm user hiện tại.
- Khái niệm role: OWNER, ADMIN, STAFF_READ_ONLY.
- Helper kiểm tra quyền.
- Route protection cơ bản cho khu vực /admin.
- Trang /login placeholder để redirect khi chưa authenticated.
- Test tối thiểu cho role/permission helper.

Đây chỉ là skeleton, chưa làm auth production hoàn chỉnh.

## 2. Yêu cầu

### Role tối thiểu

Tạo các role:

```text
OWNER
ADMIN
STAFF_READ_ONLY
#Permission tối thiểu

Tạo các permission định hướng cho các task sau:

VIEW_ADMIN
MANAGE_MAILBOXES
MANAGE_TELEGRAM_MAPPINGS
VIEW_HEALTH
VIEW_LOGS
MANAGE_CUSTOMERS

#Role mapping
OWNER:
VIEW_ADMIN
MANAGE_MAILBOXES
MANAGE_TELEGRAM_MAPPINGS
VIEW_HEALTH
VIEW_LOGS
MANAGE_CUSTOMERS

#ADMIN:
VIEW_ADMIN
MANAGE_MAILBOXES
MANAGE_TELEGRAM_MAPPINGS
VIEW_HEALTH
VIEW_LOGS
MANAGE_CUSTOMERS
#STAFF_READ_ONLY:
VIEW_ADMIN
VIEW_LOGS
#Auth skeleton

Tạo helper giả lập user hiện tại để phục vụ development/test.

Yêu cầu:

Không dùng secret thật.
Không lưu password.
Không log token.
Production mặc định không auto-login.
Development có thể bật demo user bằng env placeholder nếu cần.
Code phải dễ thay bằng auth thật ở task sau.
#Route protection
Khu vực /admin phải gọi auth guard.
Nếu chưa authenticated hoặc không có quyền VIEW_ADMIN, redirect về /login.
Trang /login chỉ là placeholder, chưa cần login thật.
3. File/thư mục dự kiến tạo/sửa

Claude phải đọc cấu trúc thực tế trước. Nếu project dùng src/, tạo trong src/. Nếu không dùng src/, tạo theo root structure.

Dự kiến:

lib/auth/roles.ts
lib/auth/permissions.ts
lib/auth/session.ts
lib/auth/guards.ts
app/login/page.tsx
app/admin/layout.tsx
tests/unit/auth/roles.test.ts
tests/unit/auth/guards.test.ts

Nếu project đã có cấu trúc khác, dùng cấu trúc hiện tại, không tạo song song src/ và non-src/.

4. Tiêu chí nghiệm thu
Có role constants rõ ràng.
Có permission constants rõ ràng.
Có helper hasPermission.
Có helper isAdminRole hoặc tương đương.
/admin được bảo vệ bởi auth guard.
Chưa đăng nhập thì redirect /login.
Có test cho role/permission.
npm run verify PASS.
Không có secret thật.
Không có token/password/code trong log.
5. Không được làm
Không làm Microsoft OAuth.
Không làm connect mailbox.
Không làm customer management.
Không làm Telegram mapping.
Không thêm database auth phức tạp nếu chưa cần.
Không hardcode secret.
Không đọc/in nội dung .env.
Không tạo route của task tương lai.
6. Lệnh kiểm tra
npm run verify
git diff --stat
git diff