# TASK-069A — Multilingual Facebook/Meta Verification Detection Readiness

## Mục tiêu

Bổ sung hỗ trợ nhận diện (detector) và extract (extractor) Facebook/Meta
verification code **đa ngôn ngữ** ở mức tối thiểu, an toàn, **trước** khi test
live beta 5–10 mailboxes. Trước task này hệ thống chỉ hỗ trợ có chủ đích English
+ Vietnamese; email xác minh ở các locale khác (Spanish/Portuguese/Indonesian/
Thai/CJK/Arabic/Russian/Ukrainian…) bị detector chặn ở cổng "code-context" và bị
extractor cho điểm dưới ngưỡng → code không bao giờ tới Telegram (skip im lặng).

## Bối cảnh

- TASK-011 / TASK-012: detector + extractor gốc, keyword hard-code EN/VI ngay
  trong từng service → hai tầng có thể lệch nhau và không phủ ngôn ngữ khác.
- Review trước task này xác nhận: cổng quyết định của detector là
  `hasCodeWithContext` (một "code cue" phải nằm gần dãy số trong 40 ký tự) dùng
  danh sách EN/VI; extractor cũng phụ thuộc strong-keyword EN/VI để vượt ngưỡng
  70. Người vận hành **không** đảm bảo 5–10 mailbox beta chỉ nhận email EN/VI.

## Phạm vi đã làm

1. **Module keyword dùng chung** `services/email/verification-keywords.ts` là
   **nguồn duy nhất** cho cả detector và extractor (chống lệch logic giữa 2 tầng).
   Gồm: `BRAND_KEYWORDS`, `CODE_NOUN_KEYWORDS`, `STRONG_VERIFICATION_KEYWORDS`,
   `VERIFICATION_CONTEXT_KEYWORDS`, `NEGATIVE_KEYWORDS`, `MARKETING_KEYWORDS`,
   `CODE_PHRASE_PATTERNS`, và các list dẫn xuất cho từng consumer
   (`DETECTOR_SUBJECT_KEYWORDS`, `DETECTOR_BODY_KEYWORDS`, `CODE_CONTEXT_KEYWORDS`).

2. **Detector** (`facebook-detector.service.ts`): bỏ keyword nội bộ EN/VI, import
   từ module chung. Hành vi EN/VI giữ nguyên (list mới là superset); thêm độ phủ
   cho các locale mới. Cổng "code-context" giữ nguyên thiết kế (yêu cầu một cue
   "code" gần dãy số) — **cố ý không** hạ thành "brand gần dãy số" để tránh
   false-positive; chỉ mở rộng từ vựng "code" sang đa ngôn ngữ.

3. **Extractor** (`code-extractor.service.ts`): bỏ keyword nội bộ EN/VI, dùng list
   chung. `STRONG` = phrase "<intent> code" đa ngôn ngữ (+strong); `WEAK` = danh
   từ "code" địa phương; `BRAND_CONTEXT` = brand/intent đa ngôn ngữ (chỉ là tín
   hiệu phụ +15, **không** đủ tự đẩy nhiễu vượt ngưỡng 70).

4. **Locale tối thiểu được thêm**: English, Vietnamese, Spanish, Portuguese,
   French, German, Indonesian, Thai, Chinese (Simplified + Traditional), Japanese,
   Korean, Arabic, Russian, Ukrainian.

5. **Negative keywords đa ngôn ngữ**: mở rộng invoice/ticket/IP/phone/order/
   reference/tracking/address sang các locale được thêm để không tăng false
   positive.

6. **Test** `tests/unit/email/verification-keywords.multilingual.test.ts`: mỗi
   locale 1 positive (code synthetic được nhận diện + extract đúng, masked) và 1
   negative (nhiễu invoice/order/phone không bị nhận nhầm), kiểm cả detector lẫn
   extractor, cộng 2 test cross-cutting chứng minh brand-context đơn lẻ không vượt
   cổng/ngưỡng.

## Ngoài scope

- Không live beta; không connect mailbox thật; không Telegram group khách hàng
  thật; không gọi Microsoft Graph/Telegram thật; không gửi verification code thật.
- Không đổi pipeline/dedup/throttle/queue/routing; không multi-destination/
  broadcast; giữ rule reusable destination + mỗi mailbox tối đa một active
  destination; mailbox DISABLED/unmapped không relay.
- Không sửa `.env*`; không sửa GitHub Actions.

## Bảo mật

- Module keyword chỉ chứa hằng ngôn ngữ; không secret/token/code/email thật.
- Không log token, refresh token, client secret, Telegram bot token, database URL,
  Redis URL, encryption key, session secret, full verification code, full email
  body. Detector không echo code; extractor chỉ trả masked code.
- Test dùng code synthetic rõ ràng (`385729`) và sender synthetic; assertion kiểm
  không leak full code trong result/snippet.

## Tiêu chí nghiệm thu

- [x] Module keyword dùng chung; detector + extractor cùng nguồn.
- [x] Hỗ trợ tối thiểu các locale liệt kê ở mục Phạm vi.
- [x] Mỗi locale có 1 positive + 1 negative test (detector + extractor).
- [x] Negative keywords mở rộng theo locale.
- [x] EN/VI test cũ không regression.
- [ ] `npm run verify` PASS.
- [ ] Gemini review PASS, không Critical/High.
- [x] Không secret/code/body thật trong diff.
- [x] Không sửa `.env*` / GitHub Actions.
- [x] Không gọi Microsoft Graph/Telegram thật.

## File liên quan

- `services/email/verification-keywords.ts` (mới)
- `services/email/facebook-detector.service.ts`
- `services/email/code-extractor.service.ts`
- `tests/unit/email/verification-keywords.multilingual.test.ts` (mới)
- `docs/reports/TASK-069A-multilingual-facebook-meta-verification-detection.md`
</content>
