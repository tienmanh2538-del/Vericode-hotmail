# TASK-057 — Production auth hardening for internal staff

## Mục tiêu

Harden đăng nhập, session, role guard và access scope cho nhân viên nội bộ trước production.

Task này không phải production deploy. Task này cũng không setup production environment hoặc secret thật. Mục tiêu là đảm bảo code auth/session không cho cơ chế dev/staging login chạy nhầm production, session cookie an toàn hơn, role không bị spoof, và OWNER/ADMIN/STAFF_READ_ONLY tiếp tục được enforce đúng ở server/service layer.

## Bối cảnh

Dự án là internal staff app cho agency. Khách hàng không login, không có portal, không có signup. Khách hàng chỉ nhận verification code qua Telegram group/topic.

Các rule routing và vận hành đã chốt phải giữ nguyên:

- Nhiều mailbox có thể dùng chung một reusable Telegram destination.
- Mỗi mailbox chỉ có tối đa một active Telegram destination.
- Không làm một mailbox gửi tới nhiều Telegram destinations.
- Không broadcast verification code.
- Mailbox disconnected không được poll, renew subscription hoặc relay code.
- Mailbox chưa mapping hợp lệ không được coi là Ready.
- OWNER/ADMIN xem toàn bộ.
- STAFF_READ_ONLY chỉ xem customer/mailbox/mapping được assigned.
- Retry, throttling và queue safety từ TASK-055 không được phá.
- Operational dashboard từ TASK-056 không được phá.

## Scope được làm

- Audit auth/session hiện tại trong repo.
- Tách rõ dev/staging login khỏi production behavior.
- Đảm bảo production không dùng staging passphrase login hoặc demo user.
- Nếu production auth provider thật chưa tồn tại, production admin access phải fail closed thay vì mở bằng cơ chế tạm.
- Harden session cookie:
  - httpOnly.
  - secure ngoài local development.
  - sameSite hợp lý.
  - có thời hạn.
  - logout clear cookie đúng.
- Đảm bảo session được ký/verify server-side.
- Đảm bảo role/userId không lấy từ request body/query/cookie không verify.
- Đảm bảo admin page và admin API đều yêu cầu auth đúng.
- Đảm bảo permission guard cho OWNER/ADMIN/STAFF_READ_ONLY vẫn đúng.
- Đảm bảo STAFF_READ_ONLY không bypass staff assignment scope.
- Thêm hoặc cập nhật audit log cho sự kiện auth/action quan trọng ở mức tối thiểu nếu phù hợp với hạ tầng audit hiện có.
- Thêm unit/API tests cho auth policy, session behavior, route guard, RBAC và staff scope.
- Cập nhật tài liệu task/report nếu cần.

## Scope không làm

- Không deploy production.
- Không tạo production database.
- Không tạo production Redis.
- Không setup production secret thật.
- Không sửa `.env`, `.env.local`, `.env.staging`, `.env.production`.
- Không đọc hoặc in nội dung `.env*`.
- Không dùng mailbox khách hàng thật.
- Không dùng Telegram group khách hàng thật.
- Không gửi verification code thật.
- Không tạo customer login.
- Không tạo customer portal.
- Không tạo public signup.
- Không làm billing/payment.
- Không thay đổi routing rule Telegram.
- Không làm một mailbox gửi nhiều Telegram destinations.
- Không broadcast code.
- Không sửa GitHub Actions để nới lỏng secret scan.
- Không thêm provider auth lớn nếu repo chưa có nền sẵn; nếu cần, ghi deferred task.

## Rủi ro cần kiểm tra trước khi sửa

Claude phải kiểm tra và báo ngắn trước khi sửa:

- Dev/staging login có thể chạy nhầm production hay không.
- Demo user hoặc passphrase auth có bị bật ở production hay không.
- Session cookie hiện có đủ httpOnly/secure/sameSite/expiry hay không.
- Production có dùng fallback session secret yếu hay không.
- Role có thể bị spoof từ client request hay không.
- Admin API có guard server-side đầy đủ hay chỉ dựa vào UI.
- STAFF_READ_ONLY có thể đọc/sửa dữ liệu ngoài assignment scope hay không.
- Logout có clear session đúng không.
- Error message có lộ thông tin nhạy cảm không.
- Audit log có ghi secret/token/code/full email body không.

## Yêu cầu thiết kế tối thiểu

### Production fail-closed

Nếu app chạy ở production mà chưa có production auth provider hợp lệ, admin access phải bị chặn an toàn. Không được fallback sang staging login, demo user, hoặc passphrase đơn giản.

### Dev/staging login isolation

Mọi cơ chế login tạm cho development hoặc staging phải được giới hạn rõ theo runtime environment. Production không được dùng các cơ chế này.

### Session hardening

Session phải được tạo, đọc, verify và hủy qua helper server-side. Không đặt logic session rải rác ở nhiều nơi nếu có thể tránh.

Cookie session phải có cấu hình an toàn và test được.

### RBAC và access scope

OWNER/ADMIN giữ quyền toàn hệ thống.

STAFF_READ_ONLY chỉ được đọc dữ liệu trong assigned customer scope và không có quyền write.

Service layer vẫn là lớp bảo vệ chính. UI hiding chỉ là UX, không phải security boundary.

### Audit log

Nếu thêm audit event, chỉ ghi metadata an toàn. Không ghi secret thật, token, refresh token, client secret, Telegram bot token, verification code đầy đủ, hoặc full email body.

## File Claude cần đọc trước

- `AGENTS.md`
- `CLAUDE.md`
- `GEMINI.md`
- `docs/PRODUCT_SPEC.md`
- `docs/ARCHITECTURE.md`
- `docs/SECURITY_RULES.md`
- `docs/ROADMAP.md`
- `docs/tasks/TASK-057-production-auth-hardening-internal-staff.md`
- Các file auth/session/guard hiện có trong `lib/auth/`
- Các route login/logout hiện có trong `app/login/` và `app/api/auth/`
- Các service/page/API có sử dụng role, permission hoặc customer scope
- Tests hiện có liên quan auth, guards, staff assignment, mailbox list/detail, Telegram mapping, health dashboard

## File có thể sửa

Claude phải tự audit trước rồi báo file dự kiến sửa. Các nhóm file có thể liên quan:

- `lib/auth/*`
- `app/login/*`
- `app/api/auth/*`
- `app/admin/*` nếu cần chỉnh guard nhỏ
- `app/api/*` nếu route admin thiếu guard
- `services/*` nếu service thiếu permission/scope guard
- `tests/unit/auth/*`
- `tests/api/auth/*`
- tests liên quan staff assignment, mailbox, telegram, health
- `docs/tasks/TASK-057-production-auth-hardening-internal-staff.md`
- `docs/reports/TASK-057-production-auth-hardening-internal-staff.md` nếu repo đang dùng report cho từng task

## Không được sửa nếu không có lý do rõ

- Không sửa schema/migration nếu không thật sự cần.
- Không sửa worker pipeline nếu không liên quan auth.
- Không sửa Telegram routing logic nếu không liên quan auth.
- Không sửa queue/throttling nếu không liên quan auth.
- Không sửa GitHub Actions để giảm kiểm tra bảo mật.
- Không sửa `.env*`.

## Test bắt buộc

Claude phải thêm/cập nhật test để cover tối thiểu:

- Production không cho dùng staging/dev login.
- Production thiếu production auth config hợp lệ thì admin access fail closed.
- Session cookie có flag an toàn theo environment.
- Logout clear session.
- Invalid/tampered session bị reject.
- Unauthenticated request không vào được admin route/API.
- STAFF_READ_ONLY không xem dữ liệu ngoài assigned customer scope.
- STAFF_READ_ONLY không thực hiện write actions.
- OWNER/ADMIN vẫn xem và thao tác đúng quyền.
- Existing mailbox readiness, reusable destination, one-mailbox-one-destination, disconnect guard, throttling/queue safety, operational health dashboard không bị phá.

## Lệnh kiểm tra bắt buộc

Chạy:

```bash
npm run verify
````

Nếu có test auth riêng, chạy thêm test liên quan trước hoặc sau `npm run verify`.

## Tiêu chí nghiệm thu

Task chỉ PASS khi:

* Có file task này trong `docs/tasks/`.
* Production không dùng staging login hoặc demo login.
* Session cookie được harden và có test.
* Role/session không thể spoof từ client.
* OWNER/ADMIN/STAFF_READ_ONLY vẫn đúng quyền.
* STAFF_READ_ONLY vẫn bị giới hạn theo assignment scope.
* Customer không có login/portal/signup.
* Không có secret thật trong diff.
* Không sửa `.env*`.
* Không phá routing Telegram hoặc worker safety.
* `npm run verify` PASS.
* Gemini review PASS.
* Trước commit, diff đã được kiểm tra để tránh GitHub Actions secret-scan false positive.

## Ghi chú bảo mật khi viết docs/report

Không ghi secret thật.

Không ghi database URL, Redis URL, token, client secret, Telegram bot token, encryption key, session secret, hoặc verification code đầy đủ.

Tránh các dòng metadata ngắn dạng keyword/value liên quan tới branch, token, secret, key, password, auth, bearer, client secret, database URL, connection string.

Nếu cần nhắc tới branch hoặc secret, viết bằng câu thường, không ghi dạng `keyword: value`.