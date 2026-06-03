# TASK-057 — Production auth hardening for internal staff (report)

Status: done (code + tests). Not a production deploy; no real production
environment, secret, mailbox, or Telegram group was created or used.

## Mục tiêu đã đạt

Harden auth/session/RBAC cho nhân viên nội bộ trước production, tập trung vào
fail-closed cho production và làm rõ ranh giới dev/staging login. Không mở rộng
scope, không phá routing Telegram hay worker safety.

## Đã thay đổi gì

1. **Production fail-closed tường minh (`lib/auth/session.ts`).**
   `getCurrentUser` được viết lại thành một `switch` theo runtime environment:
   - `development`: chỉ trả demo user khi cờ dev được bật.
   - `staging`: chỉ chấp nhận session cookie đã ký (HMAC) còn hạn.
   - `production` / `test` / mặc định: luôn trả `null`.
   Trước đây production fail-closed chỉ do "rơi xuống" `return null` ngầm; nay
   denial là một nhánh tường minh có chú thích, nên không thể vô tình mở khi sửa
   sau này. Role/userId không bao giờ lấy từ request body/query/cookie chưa
   verify.

2. **Login page không lộ cơ chế ở production (`app/login/page.tsx`).**
   Nhánh production hiển thị thông báo khóa truy cập chung chung, không nhắc tên
   biến môi trường, không nhắc staging passphrase. Development vẫn có gợi ý dev.

3. **Audit tối thiểu cho auth (`lib/auth/auth-audit.ts` mới + 2 route).**
   Tận dụng hạ tầng audit sẵn có (các action ADMIN_LOGIN / ADMIN_LOGOUT vốn đã
   khai báo nhưng chưa được phát ở đâu). Thêm helper best-effort phát sự kiện cho
   login thành công, login bị từ chối (access denied), và logout. Helper nuốt lỗi
   của chính nó nên một lần ghi audit hỏng không bao giờ làm hỏng hoặc chậm luồng
   auth. Metadata chỉ gồm outcome và nhãn environment; không có passphrase, token,
   session secret, cookie value, verification code hay email body. Đã wire vào
   `app/api/auth/staging-login/route.ts` và `app/api/auth/staging-logout/route.ts`.

## Những thứ đã xác nhận vẫn đúng (không sửa, có test bao phủ)

- Session cookie staging: httpOnly, secure, sameSite Lax, path `/`, có max-age,
  token ký/verify server-side, logout xóa cookie với cùng thuộc tính.
- Guard server-side: `requireAdminAccess` / `requirePermission` chặn người chưa
  đăng nhập và STAFF_READ_ONLY khỏi các surface MANAGE_*.
- RBAC: OWNER/ADMIN có toàn quyền; STAFF_READ_ONLY chỉ VIEW_ADMIN/VIEW_LOGS.
- Customer scope: STAFF_READ_ONLY chỉ thấy customer được assign; signed-out và
  staff không assignment fail-closed (thấy rỗng). Enforce ở service/API layer,
  không chỉ ẩn UI.
- Inbox-test API vẫn bị disable hẳn ở production.

## File đã thay đổi

- `lib/auth/session.ts` (sửa)
- `lib/auth/auth-audit.ts` (mới)
- `app/login/page.tsx` (sửa)
- `app/api/auth/staging-login/route.ts` (sửa)
- `app/api/auth/staging-logout/route.ts` (sửa)
- `tests/unit/auth/session.test.ts` (mới)
- `tests/api/auth/staging-login.route.test.ts` (mới)
- `tests/api/auth/staging-logout.route.test.ts` (mới)
- `docs/tasks/TASK-057-production-auth-hardening-internal-staff.md` (task spec)
- `docs/reports/TASK-057-production-auth-hardening-internal-staff.md` (báo cáo này)

## Test đã thêm

- `session.test.ts`: production không bao giờ trả demo user dù cờ dev bật;
  production không bao giờ chấp nhận staging token hợp lệ; production thiếu config
  vẫn fail-closed; dev có/không cờ; staging token hợp lệ/giả/không có; test
  runtime fail-closed.
- `staging-login.route.test.ts`: ngoài staging (production) không chạy passphrase
  gate kể cả khi nhập đúng; staging chưa cấu hình fail-closed; sai passphrase
  không cấp cookie; đúng passphrase cấp cookie có đủ flag an toàn.
- `staging-logout.route.test.ts`: logout xóa cookie (rỗng, max-age 0) với cùng bộ
  flag an toàn.

## Rủi ro còn lại / deferred

- Chưa có production auth provider thật. Đây là chủ ý: production fail-closed cho
  tới khi provider thật được thêm (đề xuất xử lý ở TASK-058). Cho tới lúc đó admin
  access ở production bị khóa an toàn.
- Audit DB write là best-effort; nếu DB không sẵn sàng, sự kiện auth có thể không
  được ghi nhưng luồng auth vẫn an toàn.
- Lock/scope đa-tiến-trình vẫn theo baseline TASK-055 (ngoài scope task này).

## Ghi chú bảo mật

Không có secret thật trong diff. Không sửa `.env*`. Không sửa GitHub Actions.
Không có dòng metadata dạng keyword/value nhạy cảm. Khóa ví dụ dùng trong test là
placeholder đã có sẵn trong `.env.example`, không phải giá trị thật.
