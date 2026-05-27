# TASK-011: Facebook/Meta Verification Detector

## 1. Bối cảnh

Dự án Verification Code Relay Tool đang ở Sprint 3 — Parser & mock flow.

Các task liên quan:

- TASK-010: Mock email input — đã có hoặc đang có dữ liệu email giả lập để test flow.
- TASK-011: Facebook/Meta verification detector — task hiện tại.
- TASK-012: Code extractor module — task sau, chưa làm ở task này.
- TASK-013: Processed message & deduplication service — task sau, chưa làm ở task này.
- TASK-014: Kết nối mock flow end-to-end — task sau, chưa làm ở task này.

TASK-011 chỉ chịu trách nhiệm xác định một email có khả năng là email verification code từ Facebook/Meta hay không.

Detector không được gửi Telegram.
Detector không được ghi log thật.
Detector không được gọi Microsoft Graph.
Detector không được kết nối database.
Detector không được làm deduplication.
Detector không được extract code chính thức thay cho TASK-012.

---

## 2. Mục tiêu

Tạo module `facebook-detector.service.ts` để nhận vào dữ liệu email giả lập và trả về kết quả đánh giá:

- Email có phải Facebook/Meta verification email không.
- Confidence score là bao nhiêu.
- Những signal nào đã match.
- Những warning nào xuất hiện.
- Lý do vì sao detector chấp nhận hoặc từ chối email.

Detector phải tránh lỗi nguy hiểm:

- Không chỉ lấy số đầu tiên trong email.
- Không tin email chỉ vì subject có chữ Facebook.
- Không tin email chỉ vì có mã 6 số.
- Không tin sender giả như `faceb00kmail.com`.
- Không gửi hoặc đánh dấu pass nếu confidence thấp.
- Không lưu hoặc log full verification code trong module này.

---

## 3. File/thư mục dự kiến tạo hoặc sửa

Claude phải kiểm tra cấu trúc thực tế của project trước.

Nếu project dùng cấu trúc root:

```text
services/email/facebook-detector.service.ts
tests/unit/email/facebook-detector.service.test.ts
````

Nếu project dùng `src/`:

```text
src/services/email/facebook-detector.service.ts
src/tests/unit/email/facebook-detector.service.test.ts
```

Hoặc nếu test hiện tại đang nằm trong `tests/`, `__tests__/`, hoặc cấu trúc khác, hãy đặt test theo convention thực tế đang có.

Không được tạo song song cả `src/services` và `services` nếu project chỉ dùng một kiểu.

---

## 4. Input đề xuất

Tạo type input tương tự:

```ts
export type DetectorEmailInput = {
  from?: string;
  sender?: string;
  subject?: string;
  bodyPreview?: string;
  bodyText?: string;
  receivedAt?: string | Date;
};
```

Giải thích:

* `from`: địa chỉ email người gửi hiển thị trên email.
* `sender`: địa chỉ sender thực tế nếu có.
* `subject`: tiêu đề email.
* `bodyPreview`: phần preview ngắn.
* `bodyText`: nội dung text của email.
* `receivedAt`: thời gian nhận email, dùng để check email quá cũ nếu có.

---

## 5. Output đề xuất

Tạo type output tương tự:

```ts
export type FacebookVerificationDetectionResult = {
  isFacebookVerification: boolean;
  platform: "facebook_meta" | "unknown";
  confidenceScore: number;
  matchedSignals: string[];
  warnings: string[];
  normalizedSenderDomain?: string;
};
```

Yêu cầu:

* `confidenceScore` nằm trong khoảng 0–100.
* `isFacebookVerification = true` chỉ khi score >= 70 và không có warning nghiêm trọng.
* `platform = "facebook_meta"` nếu pass.
* `platform = "unknown"` nếu fail.
* Không return full code ở TASK-011.
* Không log full code.

---

## 6. Trusted sender/domain logic

Detector cần có allowlist domain cấu hình trong code ở mức module, ví dụ:

```ts
const TRUSTED_META_DOMAINS = [
  "fb.com",
  "facebook.com",
  "facebookmail.com",
  "instagram.com",
  "meta.com",
  "metamail.com",
];
```

Yêu cầu match domain an toàn:

* Cho phép exact domain, ví dụ `facebookmail.com`.
* Cho phép subdomain hợp lệ, ví dụ `mail.facebookmail.com`.
* Không được match bằng kiểu `includes("facebookmail.com")` vì sẽ nhận nhầm:

  * `facebookmail.com.attacker.com`
  * `fake-facebookmail.com`
  * `faceb00kmail.com`
* Nên viết helper:

```ts
function isDomainOrSubdomain(domain: string, allowedDomain: string): boolean
```

Logic đúng:

```text
domain === allowedDomain
hoặc domain.endsWith("." + allowedDomain)
```

---

## 7. Keyword detection

Detector phải kiểm tra keyword trong subject/body.

Keyword tiếng Anh gợi ý:

```text
facebook
meta
confirmation code
security code
login code
verification code
confirm your account
account confirmation
two-factor authentication
2fa
```

Keyword tiếng Việt gợi ý:

```text
mã xác nhận
mã bảo mật
mã xác minh
mã đăng nhập
xác minh tài khoản
mã xác thực
```

Yêu cầu:

* Normalize text về lowercase.
* Có thể bỏ dấu tiếng Việt nếu project đã có helper; nếu chưa có, chỉ cần lowercase ở task này.
* Không cần AI parser phức tạp.
* Không phụ thuộc vào một keyword duy nhất.

---

## 8. Code pattern context detection

TASK-011 chưa extract code chính thức, nhưng detector được phép kiểm tra có tồn tại pattern giống verification code để tăng confidence.

Pattern tham khảo:

```ts
/\b\d{5,8}\b/g
```

Nhưng không được chỉ vì có số 5–8 chữ số là pass.

Detector nên chỉ cộng điểm cao nếu số xuất hiện gần keyword context như:

```text
code
security code
confirmation code
verification code
mã xác minh
mã bảo mật
mã xác nhận
```

Yêu cầu:

* Nếu có nhiều mã số 5–8 chữ số không rõ ngữ cảnh, thêm warning `MULTIPLE_CODE_CANDIDATES`.
* Nếu số giống case number, invoice number, phone number, date/time thì không được tự động pass.
* Không return code thật ở output task này.

---

## 9. Confidence score

Implement scoring theo hướng sau:

```text
trusted_sender_match: +40
subject_keyword_match: +20
body_keyword_match: +20
code_pattern_context_match: +20
suspicious_sender: -100
multiple_code_candidates: -20
marketing_or_invoice_like: -30
stale_email: -10
```

Rule pass:

```text
score >= 70
và không có suspicious sender
và có ít nhất:
- trusted sender
- subject/body keyword
- code pattern có context
```

Nếu score thấp:

```text
isFacebookVerification = false
platform = "unknown"
```

---

## 10. Suspicious sender detection

Detector phải fail mạnh nếu sender có dấu hiệu giả mạo.

Ví dụ fail:

```text
security@faceb00kmail.com
security@facebookmail.com.attacker.com
facebook-security@gmail.com
meta-verification@outlook.com
noreply@facebook-support.example.com
```

Các case này phải có warning:

```text
SUSPICIOUS_SENDER
```

Và score không được pass.

---

## 11. Marketing/invoice/non-verification detection

Không phải email nào từ Facebook/Meta cũng là verification code.

Detector nên reject hoặc giảm điểm với các email kiểu:

```text
receipt
invoice
ads summary
weekly report
marketing
newsletter
policy update
new login alert without code
```

Yêu cầu test các case:

* Email từ domain hợp lệ nhưng chỉ là newsletter → fail.
* Email từ domain hợp lệ nhưng là invoice/receipt → fail.
* Email có subject Facebook nhưng không có code context → fail.

---

## 12. Unit tests bắt buộc

Tạo test cho các nhóm sau.

### 12.1. Positive cases

1. Email tiếng Anh từ trusted sender, subject có `confirmation code`, body có mã 6 số gần chữ `code` → pass.
2. Email tiếng Anh từ trusted sender, subject có `security code`, body có mã 6 số → pass.
3. Email tiếng Việt từ trusted sender, subject/body có `mã xác minh`, body có mã 6 số → pass.
4. Email có sender là subdomain hợp lệ của allowed domain → pass nếu các signal khác đủ.

### 12.2. Negative sender cases

1. `security@faceb00kmail.com` → fail.
2. `security@facebookmail.com.attacker.com` → fail.
3. `facebook-security@gmail.com` → fail.
4. `meta-verification@outlook.com` → fail.
5. Sender rỗng hoặc invalid → fail.

### 12.3. Negative content cases

1. Subject có Facebook nhưng không có code context → fail.
2. Body có số 6 chữ số nhưng không có keyword context → fail.
3. Email invoice/receipt/ads summary có nhiều số → fail.
4. Email marketing/newsletter từ domain hợp lệ → fail.
5. Email có nhiều code candidate mơ hồ → fail hoặc score thấp, có warning.

### 12.4. Boundary cases

1. Body rỗng nhưng subject đủ mạnh vẫn chưa được pass nếu không có code context.
2. Subject rỗng nhưng body có đủ signal và sender trusted có thể pass.
3. ReceivedAt quá cũ nếu implement stale check thì phải giảm điểm.
4. Score phải clamp trong khoảng 0–100.

---

## 13. Export API của module

Module nên export tối thiểu:

```ts
export function detectFacebookVerificationEmail(
  email: DetectorEmailInput
): FacebookVerificationDetectionResult
```

Có thể export thêm helper nếu cần test:

```ts
export function normalizeSenderDomain(sender?: string): string | undefined
export function isDomainOrSubdomain(domain: string, allowedDomain: string): boolean
```

Nếu không muốn expose helper public, có thể test qua function chính.

---

## 14. Không được làm trong TASK-011

Claude tuyệt đối không được làm các phần sau:

* Không làm TASK-012 code extractor chính thức.
* Không tạo `code-extractor.service.ts`.
* Không làm TASK-013 deduplication.
* Không sửa Telegram sender trừ khi test import bị lỗi bắt buộc.
* Không gửi message Telegram.
* Không tạo log page.
* Không tạo code event log service.
* Không tạo audit log service.
* Không gọi Microsoft Graph.
* Không tạo OAuth route.
* Không tạo webhook route.
* Không tạo database model mới nếu task trước chưa yêu cầu.
* Không thêm secret thật vào `.env`, `.env.example`, test hoặc code.
* Không hardcode Telegram bot token.
* Không log full verification code.

---

## 15. Lệnh kiểm tra

Claude phải chạy:

```powershell
npm run verify
```

Nếu project có script test riêng, có thể chạy thêm:

```powershell
npm test
```

Hoặc:

```powershell
npm run test
```

Nhưng bắt buộc cuối cùng vẫn phải chạy:

```powershell
npm run verify
```

---

## 16. Tiêu chí nghiệm thu

TASK-011 chỉ được coi là hoàn thành khi:

* Có module Facebook/Meta verification detector.
* Detector trả về score, matched signals, warnings rõ ràng.
* Detector không return full code.
* Detector không log full code.
* Có unit test positive/negative/boundary.
* Test chứng minh không match domain giả.
* Test chứng minh không lấy số đầu tiên làm code.
* Test chứng minh email marketing/invoice không pass.
* Không làm vượt sang TASK-012/013/014/015.
* `npm run verify` PASS.
* Gemini review PASS.

---

## 17. Báo cáo cuối task Claude phải trả lời theo format

Claude phải kết luận:

```text
1. Đã làm gì
2. File nào đã tạo/sửa
3. Lệnh nào đã chạy
4. Kết quả npm run verify: PASS/FAIL
5. Có làm vượt scope không: Có/Không
6. Rủi ro còn lại
7. Đề xuất task tiếp theo
```

