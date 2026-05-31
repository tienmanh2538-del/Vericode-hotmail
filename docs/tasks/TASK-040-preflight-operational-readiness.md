# TASK-040 Preflight: Operational Readiness Before MVP Acceptance Review

## 1. Mục tiêu

TASK-040-preflight-operational-readiness là task phụ được tạo trước TASK-040 chính thức.

Mục tiêu của task này là xử lý các blocker vận hành quan trọng trước khi thực hiện MVP Acceptance Review trên staging.

Task này không thay thế TASK-040.  
Task này chỉ đảm bảo hệ thống đủ điều kiện để bước vào TASK-040.

---

## 2. Lý do phát sinh task

Sau khi hoàn thành TASK-039 và chuẩn bị bước sang TASK-040, quá trình review phát hiện một số khoảng cách vận hành có thể khiến MVP Acceptance Review bị fail trên staging:

1. Staging chưa có cơ chế đăng nhập admin thực tế.
2. Email worker chưa có script runner thật để consume queue.
3. Token rotation chưa được đảm bảo đồng nhất cho email-worker.
4. Audit log và code event log vẫn phụ thuộc in-memory store.
5. Health dashboard chưa hiển thị đủ tín hiệu runtime của các worker.

Các vấn đề này không chỉ là lỗi UI/test, mà là blocker vận hành khi chạy staging đa tiến trình.

---

## 3. Phạm vi thực hiện

### 3.1. Staging admin authentication

Yêu cầu:

- Cho phép `APP_ENV=staging` là môi trường hợp lệ.
- Tạo cơ chế đăng nhập staging bằng passphrase.
- Passphrase lấy từ env, không hardcode.
- Session dùng signed cookie.
- Cookie phải có các thuộc tính an toàn:
  - `httpOnly`
  - `secure`
  - `sameSite=strict`
- Nếu thiếu cấu hình staging auth thì phải fail-closed, không cho truy cập admin.
- Không mở admin public.
- Không làm auth production phức tạp trong task này.

Env liên quan:

```env
STAGING_ADMIN_PASSWORD=
STAGING_ADMIN_SESSION_SECRET=
````

---

### 3.2. Real email worker runner

Yêu cầu:

* Tạo entrypoint/script thật để chạy email worker.
* Thêm npm script để khởi động email worker.
* Không được để email worker là no-op hoặc type-only cast.
* Worker phải consume queue thật.
* Worker phải chạy pipeline thực tế:

```text
Mailbox lookup
→ Access token refresh
→ Microsoft Graph fetch message
→ Detect Facebook/Meta verification email
→ Extract code
→ Deduplicate
→ Resolve Telegram mapping
→ Send Telegram
→ Write audit/code event log
```

---

### 3.3. Token rotation consistency

Yêu cầu:

* Email worker phải dùng cùng logic token rotation an toàn như delta polling và subscription renewal.
* Nếu Microsoft trả về refresh token mới:

  * Encrypt refresh token mới.
  * Lưu lại vào database.
* Nếu Microsoft không trả refresh token mới:

  * Giữ refresh token cũ.
  * Không ghi đè bằng `null`, empty string hoặc undefined.
* Không log access token, refresh token hoặc client secret.
* Không thêm Microsoft scope mới.

---

### 3.4. Database-backed logs

Yêu cầu:

* Runtime thật của audit log và code event log phải dùng database.
* Web UI và worker process phải đọc/ghi chung một nguồn dữ liệu.
* Có thể giữ in-memory store cho test/mock nếu cần.
* Không lưu full verification code.
* Không lưu token, client secret, Telegram bot token hoặc full email body.
* Metadata/log phải được sanitize hoặc redact trước khi ghi DB.

Các log cần hỗ trợ:

* Audit log
* Code event log

---

### 3.5. Health dashboard runtime signals

Yêu cầu:

Health dashboard cần hiển thị rõ trạng thái vận hành tối thiểu:

* Email worker
* Delta polling worker
* Subscription renewal worker
* Queue/Redis status
* Last processed email
* Last polling run
* Last renewal run
* Last error nếu có

Không được expose secret, token, Redis URL hoặc env value lên UI.

---

## 4. File/thư mục dự kiến liên quan

Các nhóm file có thể được tạo/sửa:

```text
lib/env.schema.ts
lib/env.ts
lib/auth/*
app/login/page.tsx
app/api/auth/*
components/layout/AdminTopbar.tsx

services/queue/workers/*
scripts/run-email-worker.ts
package.json

prisma/schema.prisma
prisma/migrations/*

services/logs/*
app/admin/logs/*

services/health/*
app/admin/health/*
tests/unit/*
```

---

## 5. Không được làm

Trong task này không được:

* Làm lại toàn bộ production authentication system.
* Mở `/admin` public trên staging.
* Dùng staging bypass kiểu ai có URL cũng vào được.
* Đọc hoặc in nội dung `.env`, `.env.local`.
* Hardcode password, token, client secret, Telegram bot token.
* Log raw verification code.
* Log access token hoặc refresh token.
* Thêm Microsoft permission ngoài scope đã duyệt:

  * `Mail.Read`
  * `offline_access`
  * `User.Read`
* Refactor lớn ngoài phạm vi operational readiness.
* Sửa unrelated UI.
* Tự ý đổi stack kỹ thuật.

---

## 6. Tiêu chí nghiệm thu

Task này được coi là đạt khi:

1. `APP_ENV=staging` hoạt động đúng.
2. Staging admin login dùng passphrase + signed cookie.
3. Nếu thiếu staging password/session secret thì admin bị khóa an toàn.
4. Có script thật để chạy email worker.
5. `package.json` có npm script để chạy email worker.
6. Email worker dùng pipeline thật, không còn no-op/type-only cast.
7. Email worker có token rotation an toàn.
8. Audit log và code event log runtime thật dùng database.
9. Web UI đọc được log do worker ghi.
10. Health dashboard hiển thị trạng thái worker/runtime.
11. Không lộ secret/token/code trong log, UI, test hoặc report.
12. `npm run verify` pass.
13. Gemini review không còn Critical/High.

---

## 7. Kết quả triển khai

Claude Code đã triển khai các nhóm thay đổi chính:

### 7.1. Staging auth

* Thêm `APP_ENV=staging`.
* Thêm `STAGING_ADMIN_PASSWORD`.
* Thêm `STAGING_ADMIN_SESSION_SECRET`.
* Tạo staging session bằng HMAC-SHA256.
* Tạo staging login/logout route.
* Cookie dùng `httpOnly`, `secure`, `sameSite=strict`.
* Thiết kế fail-closed khi chưa cấu hình.

### 7.2. Email worker

* Tạo real email worker runner.
* Thêm script `worker:email`.
* Bỏ default pipeline giả.
* Wire pipeline thật từ queue đến Graph, parser, Telegram và DB audit.

### 7.3. Token rotation

* Email worker dùng logic refresh token đồng nhất với delta polling và subscription renewal.
* Refresh token mới được encrypt và lưu DB nếu Microsoft trả về.
* Không ghi đè refresh token cũ nếu Microsoft không trả token mới.

### 7.4. Log persistence

* Thêm database-backed store cho audit log.
* Thêm database-backed store cho code event log.
* Thêm model `CodeEvent`.
* Mở rộng `AuditLog`.
* UI log đọc từ DB.
* Worker ghi log vào DB.

### 7.5. Health dashboard

* Bổ sung trạng thái email worker, polling worker, renewal worker.
* Bổ sung queue/Redis presence check.
* Bổ sung runtime signals:

  * Last processed email
  * Last polling run
  * Last renewal run
  * Last error

---

## 8. Lệnh kiểm tra đã chạy

```powershell
npm run verify
```

Kết quả:

```text
PASS
670/670 tests passed
Build passed
```

Các kiểm tra bổ sung:

```powershell
npx prisma validate
npx prisma generate
```

Kết quả:

```text
PASS
```

---

## 9. Gemini review

Gemini review kết luận:

```text
TASK-040-preflight-operational-readiness: PASS
Sẵn sàng cho TASK-040 MVP Acceptance Review: CÓ
npm run verify: PASS
Không phát hiện lộ secret/token
Không phát hiện regression nghiêm trọng
```

Các issue còn lại chỉ ở mức Low:

1. Khi deploy staging phải đặt `STAGING_ADMIN_PASSWORD` đủ mạnh.
2. Khi deploy staging phải chạy:

```powershell
npx prisma migrate deploy
```

---

## 10. Rủi ro vận hành còn lại

Các rủi ro còn lại không chặn TASK-040, nhưng cần nhớ khi deploy staging:

1. Staging bắt buộc dùng HTTPS vì cookie có `secure=true`.
2. Phải cấu hình đầy đủ:

   * `STAGING_ADMIN_PASSWORD`
   * `STAGING_ADMIN_SESSION_SECRET`
   * `DATABASE_URL`
   * Redis/queue env nếu worker cần
   * Microsoft env
   * Telegram env
3. Phải chạy migration DB trước khi nghiệm thu staging:

```powershell
npx prisma migrate deploy
```

4. Queue/Redis health hiện là presence-check, chưa phải deep connection check.
5. Nếu DB lỗi khi worker ghi log, delivery không bị chặn nhưng log có thể bị thiếu.

---

## 11. Kết luận

TASK-040-preflight-operational-readiness đã hoàn thành.

Task này đủ điều kiện commit và đủ điều kiện để chuyển sang:

```text
TASK-040: MVP acceptance review
```

TASK-040 chính thức nên tập trung vào nghiệm thu/report, không nên tiếp tục sửa code lớn trừ khi phát hiện lỗi Critical hoặc High.

```
```
