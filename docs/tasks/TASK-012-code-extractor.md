# TASK-012: Tạo code extractor module

## 1. Mục tiêu

Tạo module `Code Extractor` để trích xuất mã xác minh Facebook/Meta từ nội dung email đã được detector ở TASK-011 đánh giá là verification email.

Module này chỉ chịu trách nhiệm:
- Chuẩn hóa nội dung email.
- Tìm các candidate code hợp lệ.
- Chọn candidate có confidence cao nhất.
- Trả về kết quả extract có cấu trúc rõ ràng.
- Cung cấp maskedCode để dùng cho log/UI an toàn.
- Viết unit test cho các case positive/negative.

Module này KHÔNG chịu trách nhiệm:
- Không xác thực sender/domain.
- Không quyết định email có phải Facebook/Meta verification hay không.
- Không gửi Telegram.
- Không chống trùng.
- Không lưu database.
- Không tạo UI.
- Không gọi Microsoft Graph.

## 2. Bối cảnh từ roadmap

TASK-012 nằm trong Sprint 3 — Parser & mock flow.

Luồng Sprint 3:
- TASK-010: Tạo mock email input.
- TASK-011: Tạo Facebook/Meta verification detector.
- TASK-012: Tạo code extractor module.
- TASK-013: Tạo processed message & deduplication service.
- TASK-014: Kết nối mock flow: mock email → detect → extract → dedupe → Telegram.

Do đó TASK-012 phải độc lập, có thể test unit riêng, và chuẩn bị tốt cho TASK-014.

## 3. File/thư mục dự kiến tạo hoặc sửa

Claude phải kiểm tra cấu trúc thực tế trước.

Nếu project không dùng `src/`, ưu tiên:
- `services/email/code-extractor.service.ts`
- `tests/unit/email/code-extractor.service.test.ts`

Nếu project dùng `src/`, dùng:
- `src/services/email/code-extractor.service.ts`
- `src/tests/unit/email/code-extractor.service.test.ts`
hoặc vị trí test tương ứng với cấu trúc hiện có.

Có thể sửa nhẹ file index/export nếu project đã có pattern export service, nhưng không được refactor lớn.

## 4. Interface đề xuất

Tạo type input:

```ts
export type CodeExtractorInput = {
  subject?: string;
  bodyText?: string;
  bodyHtml?: string;
  bodyPreview?: string;
};
````

Tạo type candidate:

```ts
export type CodeCandidate = {
  code: string;
  maskedCode: string;
  source: "subject" | "bodyText" | "bodyHtml" | "bodyPreview" | "combined";
  confidence: number;
  reason: string;
  contextSnippet?: string;
};
```

Tạo type result:

```ts
export type CodeExtractionResult =
  | {
      success: true;
      code: string;
      maskedCode: string;
      confidence: number;
      candidates: CodeCandidate[];
      warnings: string[];
    }
  | {
      success: false;
      code: null;
      maskedCode: null;
      confidence: 0;
      candidates: CodeCandidate[];
      warnings: string[];
      reason: string;
    };
```

Hàm chính:

```ts
export function extractVerificationCode(
  input: CodeExtractorInput
): CodeExtractionResult
```

Có thể tạo thêm helper:

* `normalizeEmailText`
* `stripHtmlToText`
* `maskVerificationCode`
* `findCodeCandidates`
* `scoreCodeCandidate`

## 5. Quy tắc extract bắt buộc

### 5.1. Không lấy số đầu tiên trong email

Không được code kiểu:

```ts
text.match(/\d+/)
```

Sai vì email có thể chứa ngày tháng, IP, ID, số điện thoại, case number.

### 5.2. Code hợp lệ ban đầu

Mã hợp lệ cho MVP:

* Chỉ lấy mã số.
* Độ dài 5–8 chữ số.
* Ưu tiên 6 chữ số vì Facebook/Meta thường dùng dạng này.
* Không lấy chuỗi quá dài.
* Không lấy số có ký tự chữ dính liền.
* Không lấy số trong URL.
* Không lấy năm, ngày tháng, giờ, IP, số điện thoại, case number.

Pattern nền có thể dùng:

```regex
\b\d{5,8}\b
```

Nhưng chỉ được chấp nhận khi có context phù hợp.

### 5.3. Context keyword tiếng Anh

Ưu tiên candidate gần các keyword:

```text
code
security code
confirmation code
verification code
login code
one-time code
two-factor code
2FA code
Facebook code
Meta code
```

### 5.4. Context keyword tiếng Việt

Ưu tiên candidate gần các keyword:

```text
mã
mã xác minh
mã xác nhận
mã bảo mật
mã đăng nhập
mã một lần
mã Facebook
mã Meta
```

### 5.5. Scoring đề xuất

Điểm nền:

* Candidate 6 chữ số: +30
* Candidate 5 hoặc 7–8 chữ số: +15
* Gần keyword mạnh trong vòng 80 ký tự: +40
* Nằm trong subject có keyword: +20
* Nằm trong body có keyword: +20
* Có cụm "is your code" hoặc "your code is": +20
* Có cụm tiếng Việt "mã của bạn là": +20

Trừ điểm:

* Candidate nằm trong URL: -50
* Candidate giống năm/ngày/tháng/giờ: -30
* Candidate gần keyword `case`, `ticket`, `invoice`, `phone`, `IP`, `address`: -30
* Có nhiều candidate điểm gần nhau: thêm warning `MULTIPLE_SIMILAR_CANDIDATES`

Chỉ trả `success: true` nếu confidence >= 70.

### 5.6. Multiple candidates

Nếu có nhiều candidate:

* Chọn candidate có confidence cao nhất.
* Nếu top 2 candidate chênh lệch nhỏ, ví dụ dưới 15 điểm, vẫn có thể chọn top 1 nhưng phải thêm warning.
* Nếu không đủ tự tin, trả `success: false`.

### 5.7. Mask code

Tạo hàm mask:

```text
123456 → 12****
98765 → 98***
12345678 → 12******
```

Không log full code trong test output/report.

## 6. Test cases bắt buộc

### Positive cases

1. Subject có code:

```text
Subject: 123456 is your Facebook confirmation code
Expected: 123456
```

2. Body tiếng Anh:

```text
Your Facebook security code is 654321.
Expected: 654321
```

3. Body tiếng Việt:

```text
Mã xác minh Facebook của bạn là 778899.
Expected: 778899
```

4. HTML body:

```html
<div>Your Meta verification code is <b>112233</b></div>
Expected: 112233
```

5. Có nhiều số nhưng code có context:

```text
IP: 192.168.1.1
Case: 20260527
Your login code is 445566.
Expected: 445566
```

### Negative cases

1. Không có code:

```text
Your Facebook account was accessed.
Expected: success false
```

2. Chỉ có ngày tháng:

```text
Login attempt on 2026-05-27 at 14:30.
Expected: success false
```

3. Chỉ có số điện thoại:

```text
Contact support at 1800123456.
Expected: success false
```

4. Chỉ có case number:

```text
Your support case 123456 is updated.
Expected: success false
```

5. Code không có context:

```text
Random number 123456 in a marketing email.
Expected: success false hoặc confidence thấp
```

6. Nhiều code mơ hồ:

```text
Code 111111 and code 222222 are both shown without clear context.
Expected: warning hoặc success false nếu confidence không rõ
```

## 7. Không được làm trong TASK-012

* Không tạo Telegram send mới.
* Không sửa Telegram mapping.
* Không tạo processed message/deduplication.
* Không tạo log page.
* Không tạo Microsoft OAuth/Graph.
* Không tạo webhook.
* Không tạo database migration mới trừ khi cực kỳ cần, mặc định không cần.
* Không thay đổi detector TASK-011 trừ khi cần chỉnh type import nhỏ và phải giải thích rõ.
* Không log full verification code.
* Không dùng secret thật.
* Không đưa email thật của khách hàng vào fixture/test.

## 8. Lệnh kiểm tra

Sau khi code xong, chạy:

```powershell
npm run verify
```

Nếu project có lệnh test riêng:

```powershell
npm test
```

hoặc:

```powershell
npm run test
```

## 9. Tiêu chí nghiệm thu

Task chỉ đạt khi:

* Có module code extractor độc lập.
* Có type rõ ràng cho input/result/candidate.
* Có helper mask code.
* Có unit test positive/negative.
* Không lấy bừa số đầu tiên trong email.
* Có xử lý HTML cơ bản.
* Có xử lý nhiều candidate.
* Có confidence/warnings/reason rõ ràng.
* Không log full code.
* Không làm vượt scope sang TASK-013/TASK-014.
* `npm run verify` PASS.
* Gemini review PASS.

````

