# TASK-038: E2E test cho Microsoft test mailbox

## 1. Mục tiêu

Tạo bộ E2E test cho luồng Microsoft test mailbox để xác minh hệ thống xử lý đúng luồng:

Microsoft mailbox event / Graph message
→ webhook hoặc delta polling phát hiện message
→ worker/pipeline fetch message
→ detector nhận diện Facebook/Meta verification email
→ extractor lấy đúng verification code
→ dedup bằng ProcessedMessage
→ Telegram sender chỉ gửi đúng 1 lần
→ log an toàn, không lộ token/full code.

Yêu cầu đặc biệt từ TASK-031:

Webhook và delta polling có thể cùng phát hiện cùng một `graphMessageId`.
Trong trường hợp này, Telegram chỉ được nhận đúng 1 message, dựa vào unique key:

`ProcessedMessage unique [mailboxId, graphMessageId]`

## 2. Bối cảnh

Các task trước đã có:

- Microsoft OAuth connect flow.
- Mailbox đã lưu trong DB.
- Graph mail service đọc Inbox.
- Graph subscription/webhook.
- Queue/worker xử lý Graph message.
- Delta polling backup worker.
- Telegram sender/retry.
- Security hardening review.

TASK-038 không build lại các module trên.
TASK-038 chỉ bổ sung test E2E và tài liệu test thủ công/staging nếu cần.

## 3. Yêu cầu bắt buộc

### 3.1. E2E test chính

Tạo file test:

`tests/e2e/microsoft-test-mailbox.spec.ts`

Hoặc nếu project hiện dùng cấu trúc khác, đặt theo cấu trúc test hiện có, nhưng vẫn phải nằm trong nhóm `tests/e2e/`.

Test phải cover tối thiểu các case:

1. Microsoft test message đi qua pipeline và gửi Telegram thành công.
2. Email không phải Facebook/Meta verification thì không gửi Telegram.
3. Parser/extractor lấy đúng verification code từ email hợp lệ.
4. Không log full verification code.
5. Không log access token / refresh token / client secret / Telegram bot token.
6. Case quan trọng nhất:
   - webhook path nhận `graphMessageId = X`
   - delta polling path cũng nhận `graphMessageId = X`
   - hệ thống chỉ tạo/ghi nhận một ProcessedMessage hợp lệ
   - Telegram sender chỉ được gọi đúng 1 lần

### 3.2. Dedupe requirement

Bắt buộc kiểm tra hoặc xác nhận trong test rằng `ProcessedMessage` có unique constraint theo:

`mailboxId + graphMessageId`

Nếu schema hoặc service dùng tên field khác, Claude phải đọc code thực tế và dùng đúng tên hiện có.

Không được chỉ dedupe bằng code hoặc subject.
Graph message id phải là key chính cho case webhook + polling trùng nhau.

### 3.3. Real Microsoft mailbox test

Nếu test mailbox thật cần secret trong `.env.local`, không được đưa test này vào CI mặc định.

Có thể làm theo một trong hai hướng:

A. Automated E2E an toàn cho CI:
- Mock Microsoft Graph response.
- Mock Telegram sender.
- Mock webhook event.
- Mock delta polling result.
- Dùng DB test/local.
- Không cần secret thật.

B. Manual staging checklist:
- Tạo file `docs/reports/TASK-038-microsoft-test-mailbox-manual-checklist.md`
- Checklist này hướng dẫn người vận hành test với mailbox Microsoft thật.
- Không chứa token, secret, email body thật, full verification code thật.

Ưu tiên A cho CI.
B chỉ dùng để ghi lại cách kiểm tra thật ngoài CI.

## 4. File/thư mục dự kiến tạo hoặc sửa

Được phép tạo/sửa:

- `docs/tasks/TASK-038-e2e-microsoft-test-mailbox.md`
- `tests/e2e/microsoft-test-mailbox.spec.ts`
- `tests/e2e/helpers/*` nếu cần helper test
- `tests/fixtures/email-samples/*` nếu cần sample email giả
- `docs/reports/TASK-038-microsoft-test-mailbox-manual-checklist.md` nếu cần checklist test thật
- `package.json` chỉ khi cần thêm script test riêng, ví dụ `test:e2e:microsoft`
- config test hiện có, chỉ khi cần để test chạy đúng và không phá task khác

Chỉ được sửa service code khi test phát hiện bug thật và sửa trong phạm vi nhỏ, ví dụ:
- dedup chưa enforce đúng
- worker không dùng chung pipeline
- Telegram sender bị gọi 2 lần với cùng graphMessageId
- logger lộ full code/token

Nếu phải sửa service code, Claude phải báo rõ:
- lỗi nằm ở đâu
- vì sao TASK-038 cần sửa
- file nào sửa
- test nào chứng minh đã sửa

## 5. Không được làm

- Không làm staging deployment của TASK-039.
- Không làm MVP acceptance review của TASK-040.
- Không thêm Microsoft permission mới.
- Không hardcode token/API key/password/client secret.
- Không commit `.env`, `.env.local`, file log thật, ảnh chụp chứa secret.
- Không gửi email/code thật vào Telegram group khách hàng.
- Không đọc/in nội dung `.env.local`.
- Không log full verification code.
- Không log full email body nếu không cần.
- Không đổi kiến trúc lớn.
- Không bỏ qua case webhook + delta polling duplicate.

## 6. Tiêu chí nghiệm thu

TASK-038 chỉ được coi là PASS khi:

- Có file task TASK-038 trong `docs/tasks/`.
- Có E2E test cho Microsoft test mailbox hoặc pipeline Microsoft tương đương.
- Test cover webhook path.
- Test cover delta polling path.
- Test cover duplicate case:
  cùng `mailboxId + graphMessageId`
  nhưng Telegram sender chỉ gọi đúng 1 lần.
- Test không cần secret thật trong CI.
- Không có secret/token/full code trong test fixture/log/report.
- `npm run verify` PASS.
- Gemini review PASS, không còn Critical/High/Medium.
- GitHub Actions PASS sau khi push.

## 7. Lệnh kiểm tra

Chạy các lệnh sau:

```powershell
npm run verify
````

Nếu project có script e2e riêng:

```powershell
npm run test:e2e
```

Nếu Claude thêm script riêng cho Microsoft E2E:

```powershell
npm run test:e2e:microsoft
```

Kiểm tra git diff:

```powershell
git status
git diff --stat
git diff
```

## 8. Kết quả Claude phải báo lại

Claude phải kết luận theo format:

1. Đã làm gì
2. File nào thay đổi
3. Test case nào đã thêm
4. Đã cover duplicate webhook + delta polling chưa
5. Telegram sender được assert gọi mấy lần
6. Lệnh nào đã chạy
7. Kết quả PASS/FAIL
8. Có sửa service code ngoài test không
9. Có rủi ro bảo mật còn lại không

````

