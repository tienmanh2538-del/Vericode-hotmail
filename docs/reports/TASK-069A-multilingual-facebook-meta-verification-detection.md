# Report — TASK-069A Multilingual Facebook/Meta Verification Detection Readiness

## 1. Tóm tắt

Trước task này, detection chỉ phủ English + Vietnamese: cổng quyết định của
detector (`hasCodeWithContext`) và ngưỡng điểm của extractor đều phụ thuộc keyword
EN/VI hard-code trong từng service. Email Facebook/Meta ở locale khác bị skip im
lặng (code không tới Telegram). Task này:

- Tách toàn bộ từ vựng vào **một module dùng chung** để detector và extractor
  không thể lệch nhau.
- Mở rộng từ vựng "code"/intent/negative sang **15 locale** tối thiểu trước beta.
- Thêm test mỗi locale (positive + negative) cho cả hai tầng.

Không đổi pipeline/dedup/throttle/routing; không live; không gọi service ngoài;
không secret/code/email thật.

## 2. Thay đổi

| File | Loại | Nội dung |
|------|------|----------|
| `services/email/verification-keywords.ts` | mới | Nguồn keyword đa ngôn ngữ duy nhất (brand, code-noun, strong phrases, context, negative, marketing, phrase patterns + list dẫn xuất cho từng consumer). |
| `services/email/facebook-detector.service.ts` | sửa | Bỏ keyword nội bộ EN/VI; import list chung. Giữ nguyên thiết kế cổng code-context (không hạ thành brand-near-digit). |
| `services/email/code-extractor.service.ts` | sửa | Bỏ keyword nội bộ EN/VI; map sang STRONG/WEAK/BRAND_CONTEXT/NEGATIVE/PHRASE chung; gộp nhánh EN/VI thành một list. |
| `tests/unit/email/verification-keywords.multilingual.test.ts` | mới | 15 locale × (positive + negative) × (detector + extractor) + 2 test cross-cutting. |
| `docs/tasks/TASK-069A-*.md`, `docs/reports/TASK-069A-*.md` | mới | Task + report. |

## 3. Locale được hỗ trợ tối thiểu

English, Vietnamese, Spanish, Portuguese, French, German, Indonesian, Thai,
Chinese Simplified, Chinese Traditional, Japanese, Korean, Arabic, Russian,
Ukrainian.

## 4. Quyết định thiết kế

1. **Một nguồn keyword.** Detector và extractor import cùng `verification-keywords.ts`.
   Một email mà detector chấp nhận sẽ dùng đúng từ vựng "code" mà extractor cần →
   không còn rủi ro lệch tầng (email pass detector nhưng extractor không lấy được).

2. **Giữ cổng code-context, chỉ đa ngôn ngữ hóa từ vựng.** Cổng vẫn yêu cầu một
   "code cue" (phrase "<intent> code" hoặc danh từ "code" địa phương) nằm gần dãy
   số. **Cố ý không** nới thành "brand gần dãy số" vì sẽ tăng false-positive
   (số hóa đơn/đơn hàng cạnh chữ "Facebook"). Brand/intent chỉ là tín hiệu phụ
   (+15) trong extractor, không đủ tự vượt ngưỡng 70 — có test chứng minh.

3. **Token an toàn cho script không-Latin.** Với CJK dùng dạng nhiều ký tự
   (`验证码`/`驗證碼`/`確認コード`/`확인 코드`…) thay vì ký tự "码" đơn lẻ (vốn xuất
   hiện trong `号码` = số điện thoại), tránh nhiễu.

4. **Negative đa ngôn ngữ.** invoice/ticket/IP/phone/order/reference/tracking/
   address được dịch sang các locale thêm vào để giữ tỉ lệ false-positive thấp khi
   mở rộng từ vựng dương.

## 5. Kết quả test

- `tests/unit/email/facebook-detector.service.test.ts`: **29 passed** (không regression).
- `tests/unit/email/code-extractor.service.test.ts`: **30 passed** (không regression).
- `tests/unit/email/verification-keywords.multilingual.test.ts`: **62 passed**
  (15 locale × 4 + 2 cross-cutting).
- `npm run verify`: xem mục 7.

Mỗi positive: detector trả `isFacebookVerification=true` + `code_pattern_context_match`,
extractor trả đúng code synthetic + masked `38****`. Mỗi negative: detector reject,
extractor `success=false`.

## 6. Bảo mật

- Không log/echo full code; detector result không chứa code; extractor chỉ masked.
- Module keyword không chứa secret/token/code/email thật.
- Test dùng code synthetic `385729` + sender synthetic; assertion kiểm không leak.
- Không đọc/in `.env*`; không sửa `.env*`/GitHub Actions; không gọi Graph/Telegram.

## 7. Lệnh kiểm tra

- `npx vitest run` (targeted detector/extractor/multilingual) — PASS.
- `npm run verify` (db:generate + lint + typecheck + test + build) — cập nhật kết
  quả khi chạy đầy đủ.

## 8. Rủi ro còn lại / việc tiếp theo

- Đây là **synthetic readiness**, chưa phải email thật. Cần xác nhận shape thực tế
  của email Facebook/Meta theo từng locale trong internal beta (Facebook gửi theo
  locale tài khoản người nhận).
- Từ vựng theo locale là tối thiểu; có thể cần tinh chỉnh thêm biến thể (vd dạng
  có/không dấu, viết tắt) khi quan sát email beta thật.
- Không bao phủ phát hiện ngôn ngữ tự động; dựa trên substring đa ngôn ngữ. Nếu
  cần độ chính xác cao hơn, cân nhắc thư viện nhận diện ngôn ngữ ở task sau.
- Cần Gemini review: (a) thiết kế giữ cổng code-context thay vì brand-near-digit;
  (b) rủi ro false-positive của các token ngắn không-Latin.
</content>
