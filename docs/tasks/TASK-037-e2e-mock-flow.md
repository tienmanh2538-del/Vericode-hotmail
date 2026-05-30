
# TASK-037: E2E test cho mock flow

## 1. Mục tiêu

Tạo E2E test cho luồng mock email verification đã được xây dựng ở các task trước.

Luồng cần được test:

```text
Mock email input
→ Facebook/Meta verification detector
→ Code extractor
→ Deduplication
→ Telegram sender mock/test path
→ Code event log / audit log
````

TASK này nhằm đảm bảo hệ thống xử lý được email mẫu/mock từ đầu đến cuối mà không cần kết nối Hotmail thật, Microsoft Graph thật hoặc Telegram thật.

---

## 2. Bối cảnh

Dự án Verification Code Relay Tool cần tự động nhận email chứa mã xác minh Facebook/Meta, extract code và gửi vào đúng Telegram group.

Trước khi test mailbox Microsoft thật ở TASK-038, cần có E2E test ổn định cho mock flow để đảm bảo các module nội bộ hoạt động đúng:

* Mock email input
* Facebook/Meta detector
* Code extractor
* Deduplication
* Telegram sender mock/test mode
* Code event log / audit log

---

## 3. Phạm vi được làm

Claude được phép:

1. Kiểm tra project hiện có đã có Playwright hay E2E setup chưa.
2. Nếu đã có Playwright:

   * Dùng setup hiện có.
   * Tạo hoặc cập nhật test trong `tests/e2e/`.
3. Nếu chưa có Playwright:

   * Thêm dependency/test config tối thiểu cần thiết.
   * Thêm script test e2e tối thiểu trong `package.json`.
   * Không thay đổi stack lớn.
4. Tạo file test chính:

```text
tests/e2e/mock-flow.spec.ts
```

hoặc nếu project đang dùng cấu trúc khác thì đặt trong thư mục E2E hiện có.

5. Tạo fixture email giả nếu cần:

```text
tests/fixtures/email-samples/facebook-verification-e2e.json
```

hoặc `.ts` / `.json` theo convention hiện có.

6. Thêm test helper/test seed/reset nếu thật sự cần cho E2E, nhưng phải tối thiểu và không ảnh hưởng production.

7. Thêm `data-testid` vào UI nếu cần để E2E test ổn định, nhưng chỉ thêm vào các component liên quan mock flow/log.

---

## 4. Phạm vi không được làm

Claude không được:

1. Không gọi Microsoft Graph thật.
2. Không gọi Telegram Bot API thật.
3. Không đọc hoặc in nội dung `.env`, `.env.local`.
4. Không thêm secret thật.
5. Không dùng email thật của khách hàng trong test.
6. Không dùng Telegram chat ID thật.
7. Không sửa schema database/migration nếu không có lý do cực kỳ rõ ràng.
8. Không làm TASK-038 Microsoft test mailbox.
9. Không làm TASK-039 staging deployment.
10. Không làm TASK-040 MVP acceptance review.
11. Không refactor lớn mock flow/service cũ nếu chỉ cần test.
12. Không làm yếu security rule để test pass.

---

## 5. Test case bắt buộc

### Test case 1 — Happy path: email Facebook hợp lệ được xử lý thành công

Mô phỏng người dùng nhập hoặc gửi một email mock hợp lệ có nội dung giống Facebook/Meta verification email.

Kỳ vọng:

* Detector nhận diện đúng là Facebook/Meta verification email.
* Extractor lấy đúng code.
* Hệ thống xử lý thành công.
* Telegram sender ở chế độ mock/test path được gọi hoặc trạng thái gửi được ghi nhận.
* UI/log hiển thị trạng thái thành công.
* Không hiển thị full email body nếu không cần.
* Không lộ token/secret.

Ví dụ dữ liệu giả:

```text
from: security@facebookmail.com
subject: Facebook confirmation code
body: Your Facebook confirmation code is 123456.
receivedAt: 2026-05-30T10:00:00.000Z
```

---

### Test case 2 — Không gửi trùng khi submit cùng email/code hai lần

Mô phỏng submit cùng một email mock hai lần.

Kỳ vọng:

* Lần đầu xử lý thành công.
* Lần hai bị dedupe/skip.
* Telegram mock không ghi nhận gửi trùng.
* Log có trạng thái kiểu `DUPLICATE`, `SKIPPED_DUPLICATE`, hoặc trạng thái tương đương trong project.
* Không tạo hai bản ghi gửi code thành công cho cùng một message/code.

---

### Test case 3 — Email không phải Facebook/Meta không được gửi Telegram

Mô phỏng email không hợp lệ:

```text
from: newsletter@example.com
subject: Your weekly update
body: Your invoice number is 123456.
```

Kỳ vọng:

* Detector không coi đây là verification email hợp lệ.
* Không extract/send code bừa.
* Không gửi Telegram mock.
* Log thể hiện skip/low confidence/not verification.
* Không coi số đầu tiên trong email là code nếu thiếu context.

---

### Test case 4 — Không lộ secret/full code trong log nội bộ

Kiểm tra output UI/log/test result.

Kỳ vọng:

* Không có token giả như `test-token`, `refresh-token`, `telegram-bot-token`.
* Không có full email body nếu log không cần.
* Nếu log code, phải masked/hash theo rule hiện có.
* Không có `.env` hoặc secret thật.

Lưu ý: Telegram message mock có thể chứa full code vì mục tiêu sản phẩm là gửi code cho group đúng. Nhưng application log/code event log không được lưu full code nếu rule hiện tại yêu cầu masked/hash.

---

## 6. File/thư mục dự kiến tạo hoặc sửa

Ưu tiên tạo/sửa:

```text
docs/tasks/TASK-037-e2e-mock-flow.md
tests/e2e/mock-flow.spec.ts
tests/fixtures/email-samples/*
```

Chỉ sửa nếu cần:

```text
package.json
package-lock.json
playwright.config.ts
app/admin/mock-email/*
app/api/mock-email/*
app/admin/logs/*
services/email/*
services/telegram/*
tests/helpers/*
```

Không sửa nếu không cần:

```text
.env
.env.local
prisma/schema.prisma
prisma/migrations/*
services/microsoft/*
services/microsoft/refresh-access-token.service.ts
services/microsoft/delta-polling.service.ts
services/microsoft/subscription-renewal.service.ts
docs/SECURITY_RULES.md
docs/ROADMAP.md
docs/reports/security-review.md
```

---

## 7. Yêu cầu kỹ thuật

1. E2E test phải chạy được bằng lệnh rõ ràng.
2. Nếu dùng Playwright, ưu tiên Chromium/headless để phù hợp CI.
3. Test phải tự setup dữ liệu giả hoặc dùng test mode ổn định.
4. Test không phụ thuộc Telegram thật.
5. Test không phụ thuộc Microsoft thật.
6. Test không phụ thuộc internet.
7. Test không dùng dữ liệu khách hàng thật.
8. Test phải ổn định, không phụ thuộc timeout dài.
9. Nếu cần reset state trước/sau test, làm bằng helper an toàn trong test environment.
10. Không làm build fail chỉ vì thiếu secret thật.

---

## 8. Lệnh kiểm tra

Claude phải chạy tối thiểu:

```powershell
npm run verify
```

Nếu project có script E2E:

```powershell
npm run test:e2e
```

Nếu chưa có script nhưng có Playwright:

```powershell
npx playwright test tests/e2e/mock-flow.spec.ts
```

Nếu Playwright mới được thêm lần đầu, Claude phải kiểm tra command phù hợp và báo rõ đã chạy lệnh nào.

---

## 9. Tiêu chí nghiệm thu

TASK-037 được coi là PASS khi:

```text
[ ] Có file docs/tasks/TASK-037-e2e-mock-flow.md
[ ] Có E2E test cho mock flow
[ ] Test happy path pass
[ ] Test dedupe pass
[ ] Test email không hợp lệ không gửi Telegram pass
[ ] Test không lộ secret/full code trong log pass
[ ] Không gọi Microsoft Graph thật
[ ] Không gọi Telegram thật
[ ] Không đọc/in .env hoặc .env.local
[ ] Không dùng dữ liệu thật
[ ] npm run verify PASS
[ ] E2E command PASS
[ ] Gemini review PASS, không còn Critical/High/Medium
```

---

## 10. Báo cáo sau khi làm xong

Claude phải báo lại theo format:

```text
1. Đã làm gì
2. File nào đã tạo/sửa
3. Có cài thêm package nào không
4. Lệnh nào đã chạy
5. Kết quả từng lệnh: PASS/FAIL
6. E2E test bao phủ những case nào
7. Có gọi Microsoft/Telegram thật không
8. Có rủi ro bảo mật còn lại không
9. Có đề xuất gì cho TASK-038 không
```

