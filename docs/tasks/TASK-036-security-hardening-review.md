
# TASK-036: Security Hardening Review

## 1. Mục tiêu

Thực hiện security hardening review cho toàn bộ luồng nhạy cảm của Verification Code Relay Tool sau khi đã hoàn thành các phần reliability ở Sprint 8.

Task này tập trung vào việc rà soát, bổ sung test và sửa các rủi ro bảo mật / vận hành quan trọng trước khi chuyển sang E2E test và staging readiness.

## 2. Bối cảnh

Dự án đã có các module chính:

- Microsoft OAuth connect mailbox.
- Lưu refresh token đã mã hóa.
- Microsoft Graph mail fetch.
- Graph subscription / webhook.
- Delta polling backup worker.
- Subscription renewal worker.
- Telegram retry / failure handling.
- Health dashboard.
- Alert service.

TASK-036 thuộc Sprint 9 — Security & staging readiness.

Roadmap ghi rõ 2 rủi ro cần xử lý trong task này:

1. Delta Polling cần hỗ trợ bootstrap mailbox cực lớn.
   - Không được fetch vô hạn toàn bộ mailbox.
   - Cần có giới hạn an toàn hoặc filter theo thời gian.
   - Có thể dùng `$filter` theo receivedDateTime hoặc tăng max pages có kiểm soát cho lần chạy đầu.

2. Token Rotation cần đảm bảo khi Microsoft trả về refresh_token mới thì hệ thống lưu refresh token mới xuống database.
   - Nếu không lưu refresh token mới, mailbox có rủi ro mất quyền truy cập ở các lần refresh sau.
   - Refresh token mới vẫn phải được encrypt trước khi lưu.
   - Không được log token cũ hoặc token mới.

## 3. Phạm vi bắt buộc

Claude chỉ được làm trong phạm vi sau:

### 3.1. Security review report

Tạo hoặc cập nhật:

- `docs/reports/security-review.md`

Report phải rà soát tối thiểu các nhóm rủi ro:

- Secret / env safety.
- Microsoft OAuth token handling.
- Refresh token encryption.
- Refresh token rotation.
- Telegram bot token safety.
- Telegram chat mapping isolation.
- Verification code masking / hashing.
- Logging / error message sanitization.
- Webhook clientState validation.
- Delta polling bootstrap safety.
- Deduplication giữa webhook và polling.
- Database field nhạy cảm.
- UI không expose token / secret / full code.
- Test data không dùng dữ liệu thật.

Report phải có kết luận:

- PASS / FAIL tổng thể.
- Danh sách issue theo mức: Critical / High / Medium / Low.
- Issue nào đã sửa trong TASK-036.
- Issue nào chỉ ghi nhận để task sau xử lý.
- Lệnh kiểm tra đã chạy.
- Kết quả kiểm tra.

### 3.2. Delta polling bootstrap hardening

Rà soát và sửa nếu cần:

- `services/microsoft/delta-polling.service.ts`
- Các file worker/scheduler liên quan nếu service đang gọi trực tiếp ở đó.
- Test liên quan trong `tests/unit/microsoft/` hoặc vị trí test thực tế của project.

Yêu cầu:

- Lần bootstrap đầu tiên không được đọc vô hạn toàn bộ mailbox.
- Phải có giới hạn an toàn cho số page hoặc số message.
- Nếu project đã có config max pages thì phải validate default hợp lý.
- Nếu project dùng Graph delta query lần đầu, cần có cơ chế giới hạn theo thời gian hoặc giới hạn page.
- Nếu đã có deltaLink thì tiếp tục dùng deltaLink như bình thường.
- Không làm thay đổi behavior deduplication.
- Không gửi Telegram trực tiếp từ delta polling.
- Không log full email body.
- Không log verification code plaintext.

Gợi ý kỹ thuật:

- Dùng option kiểu:
  - `bootstrapFromDate`
  - `bootstrapLookbackHours`
  - `maxBootstrapPages`
  - `maxDeltaPages`
- Hoặc nếu project đã có tên config khác, giữ theo convention hiện có.
- Có test chứng minh:
  - Khi mailbox chưa có deltaLink, service không fetch vô hạn.
  - Khi số page vượt limit, service dừng an toàn.
  - Khi đã có deltaLink, service tiếp tục polling incremental.
  - Không làm mất trạng thái cursor nếu Graph trả deltaLink hợp lệ.

### 3.3. Token rotation hardening

Rà soát và sửa nếu cần:

- `services/microsoft/refresh-access-token.service.ts`
- Hoặc file tương đương đang refresh access token.
- `services/microsoft/oauth.service.ts` nếu token refresh logic nằm ở đó.
- `services/microsoft/mailbox-connect.service.ts` nếu lưu token nằm ở đó.
- `lib/security/encryption.ts`
- Test liên quan trong `tests/unit/microsoft/` hoặc `tests/unit/security/`.

Yêu cầu:

- Khi Microsoft token endpoint trả về `refresh_token` mới:
  - Phải encrypt refresh token mới.
  - Phải update database field `encryptedRefreshToken`.
  - Có thể update `tokenLastRefreshedAt` nếu schema đang có field này.
- Khi Microsoft không trả về `refresh_token` mới:
  - Giữ refresh token cũ.
  - Không ghi đè thành null / empty.
- Không log access token.
- Không log refresh token.
- Không log client secret.
- Nếu refresh fail do revoked/invalid_grant:
  - Mark mailbox `RECONNECT_REQUIRED` nếu service hiện có logic đó.
  - Nếu logic đó đã ở task trước, không refactor lớn.
- Có test chứng minh:
  - Có refresh_token mới thì DB được update bằng token đã encrypt.
  - Không có refresh_token mới thì DB không xóa token cũ.
  - Lỗi refresh không làm lộ token trong log/error.
  - Token plaintext không xuất hiện trong response service.

### 3.4. Security tests

Bổ sung test phù hợp với cấu trúc hiện tại của project.

Ưu tiên test các điểm sau:

- Logger/redactor không in token/secret/code.
- Token refresh service lưu rotated refresh token.
- Token refresh service không xóa token cũ nếu Microsoft không trả token mới.
- Delta polling bootstrap có giới hạn.
- Security report không chứa secret thật, token thật, full code thật.

Nếu project đã có test tương ứng, cập nhật test đó thay vì tạo file trùng.

## 4. File/thư mục dự kiến được phép tạo/sửa

Claude được phép tạo/sửa trong phạm vi sau, nếu cần:

- `docs/reports/security-review.md`
- `services/microsoft/delta-polling.service.ts`
- `services/microsoft/refresh-access-token.service.ts`
- `services/microsoft/oauth.service.ts`
- `services/microsoft/mailbox-connect.service.ts`
- `lib/security/encryption.ts`
- `lib/logger.ts`
- `lib/security/redact.ts`
- `tests/unit/microsoft/*`
- `tests/unit/security/*`
- `tests/unit/queue/*` nếu delta polling worker có test ở đó
- `tests/fixtures/*` chỉ dùng dữ liệu giả
- File type/interface liên quan nếu cần để compile

Claude phải đọc cấu trúc thực tế trước khi tạo file. Nếu project dùng `src/`, tạo/sửa trong `src/` tương ứng. Không tạo song song cả `src/services` và `services` nếu project chỉ dùng một kiểu.

## 5. Không được làm

Không được làm các việc sau trong TASK-036:

- Không làm TASK-037 E2E mock flow.
- Không làm TASK-038 Microsoft test mailbox E2E.
- Không làm TASK-039 staging deployment.
- Không làm TASK-040 MVP acceptance review.
- Không thêm provider ngoài Microsoft.
- Không xin thêm Microsoft scope mới.
- Không thêm `Mail.Send`, `Mail.ReadWrite`, `MailboxSettings.ReadWrite`.
- Không đọc, in, sửa hoặc commit `.env`, `.env.local`.
- Không hardcode token, client secret, encryption key, Telegram bot token.
- Không log access token / refresh token / client secret.
- Không log full verification code.
- Không log full email body.
- Không gửi Telegram trực tiếp trong polling/webhook.
- Không refactor lớn toàn bộ kiến trúc.
- Không đổi schema database nếu không thật sự bắt buộc.
- Không tạo route UI mới nếu không liên quan trực tiếp security hardening.
- Không sửa file task cũ trừ khi cần cập nhật cross-reference rất nhỏ.

## 6. Tiêu chí nghiệm thu

Task được coi là đạt khi:

- Có `docs/reports/security-review.md`.
- Report có checklist security rõ ràng và kết luận PASS/FAIL.
- Delta polling bootstrap có giới hạn an toàn hoặc filter thời gian.
- Token rotation lưu refresh token mới nếu Microsoft trả về.
- Refresh token mới được encrypt trước khi lưu.
- Không có token/code/secret plaintext trong log hoặc test snapshot.
- Có test cho token rotation.
- Có test cho delta polling bootstrap limit.
- `npm run verify` PASS.
- Gemini review PASS, không còn Critical/High/Medium.
- GitHub Actions PASS sau khi push.

## 7. Lệnh kiểm tra

Chạy các lệnh sau:

```powershell
npm run verify
````

Nếu cần chạy test riêng:

```powershell
npm test -- --run
```

Nếu project có test file cụ thể, có thể chạy thêm:

```powershell
npm test -- --run tests/unit/microsoft
npm test -- --run tests/unit/security
```

Kiểm tra file thay đổi:

```powershell
git status
git diff --stat
git diff
```

Kiểm tra không có env/secret bị stage nhầm:

```powershell
git status --short
git diff --cached --stat
```

## 8. Kết quả Claude phải báo lại

Claude phải báo lại theo format:

```text
1. Đã đọc file nào
2. File dự kiến sửa trước khi sửa
3. Đã làm gì
4. File nào đã thay đổi
5. Test nào đã thêm/sửa
6. Lệnh nào đã chạy
7. Kết quả PASS/FAIL
8. Có phát hiện secret/token/code plaintext không
9. Rủi ro còn lại
10. Có sẵn sàng gửi Gemini review không
```

