
# TASK-040: MVP Acceptance Review

## 1. Mục tiêu

TASK-040 là bước review nghiệm thu cuối cho MVP của dự án Verification Code Relay Tool.

Mục tiêu của task này là xác định MVP hiện tại có đủ điều kiện được coi là hoàn thành hay chưa, dựa trên:

- Product spec.
- Project context.
- Roadmap TASK-001 đến TASK-039.
- Security rules.
- Kết quả test, verify, E2E, staging/preflight.
- Git diff hiện tại.
- Các report trong `docs/reports/`.

Task này KHÔNG phải task thêm feature mới.

Kết quả chính cần tạo là:

```text
docs/reports/mvp-acceptance-review.md
````

Report phải kết luận rõ:

```text
PASS
FAIL
CONDITIONAL PASS
```

Không được kết luận PASS nếu thiếu bằng chứng quan trọng.

---

## 2. Bối cảnh MVP cần nghiệm thu

MVP của dự án cần chứng minh được luồng chính:

```text
Connect mailbox
→ detect Facebook/Meta verification email
→ extract code
→ dedupe
→ send Telegram đúng group
→ log an toàn
→ health/alert đủ để vận hành
```

Các nhóm năng lực cần kiểm tra:

1. Admin dashboard cơ bản.
2. Customer/mailbox management.
3. Telegram mapping và test-send.
4. Parser nhận diện Facebook/Meta verification email.
5. Code extractor.
6. Deduplication.
7. Code event log.
8. Audit log.
9. Microsoft OAuth connect flow.
10. Token encryption / token refresh / token rotation.
11. Microsoft Graph mail fetch.
12. Graph subscription/webhook.
13. Queue/worker processing.
14. Delta polling backup.
15. Subscription renewal.
16. Telegram retry/failure handling.
17. Health dashboard.
18. Alert service.
19. Security hardening.
20. Mock E2E.
21. Microsoft test mailbox E2E.
22. Staging deployment readiness.
23. Operational preflight readiness.

---

## 3. File/thư mục được phép đọc

Claude Code được phép đọc:

```text
PROJECT_CONTEXT.md
PROJECT_STRUCTURE.md
AGENTS.md
CLAUDE.md
GEMINI.md
README.md
package.json
package-lock.json
tsconfig.json
next.config.*
eslint.config.*
vitest.config.*
.env.example
docs/
docs/tasks/
docs/reports/
app/
components/
lib/
services/
prisma/
tests/
.github/
deployment/
scripts/
```

Nếu file/thư mục không tồn tại trong repo thực tế, chỉ ghi nhận là `NOT FOUND`, không tự tạo thay thế trừ khi task yêu cầu.

---

## 4. File được phép tạo/sửa

Được phép tạo mới hoặc sửa:

```text
docs/reports/mvp-acceptance-review.md
```

Được phép đọc nhưng không nên sửa:

```text
docs/tasks/TASK-040-mvp-acceptance-review.md
docs/ROADMAP.md
PROJECT_CONTEXT.md
PRODUCT_SPEC.md
ARCHITECTURE.md
SECURITY_RULES.md
MICROSOFT_SETUP.md
```

Chỉ sửa các file context/roadmap nếu user yêu cầu rõ sau khi review xong.

---

## 5. File/thư mục KHÔNG được sửa trong task này

Không được sửa các file/thư mục sau trong TASK-040, vì đây là task review/nghiệm thu, không phải task fix code:

```text
app/
components/
lib/
services/
prisma/
tests/
.github/
package.json
package-lock.json
.env
.env.local
.env.*
```

Ngoại lệ duy nhất:

* Nếu chỉ cần chạy lệnh sinh file cache tạm thời thì không commit file đó.
* Nếu phát hiện lỗi code, ghi vào report là blocker/finding. Không tự sửa trong TASK-040.

---

## 6. Quy tắc bảo mật bắt buộc

Trong task này, Claude/Gemini không được:

* Đọc hoặc in nội dung `.env`, `.env.local`.
* In token, client secret, refresh token, access token.
* In Telegram bot token.
* In full verification code thật.
* In full email body thật.
* Commit secret.
* Nới lỏng security rule để pass.

Nếu cần kiểm tra env, chỉ được kiểm tra tên biến có tồn tại hay không, không in giá trị.

---

## 7. Các lệnh kiểm tra bắt buộc

Claude phải chạy ít nhất:

```powershell
git status --short
npm run verify
```

Nếu repo có script E2E/staging rõ ràng trong `package.json`, Claude có thể đề xuất hoặc chạy thêm các lệnh phù hợp, nhưng không được tự ý gửi code vào Telegram group khách thật.

Các test liên quan Microsoft thật hoặc Telegram thật chỉ được xem là evidence nếu:

* Dùng mailbox test.
* Dùng Telegram test group/admin group.
* Không in secret/token/code thật.
* Không đụng khách hàng thật.

---

## 8. Nội dung bắt buộc của report

File `docs/reports/mvp-acceptance-review.md` phải có các phần sau:

### 8.1. Executive Summary

Bao gồm:

* Final result: PASS / FAIL / CONDITIONAL PASS.
* Review date.
* Branch.
* Commit hash hiện tại.
* Người/AI thực hiện.
* Kết luận ngắn gọn.

### 8.2. Source Documents Reviewed

Liệt kê các file đã đọc, tối thiểu:

```text
PROJECT_CONTEXT.md
PROJECT_STRUCTURE.md
PRODUCT_SPEC.md
ARCHITECTURE.md
SECURITY_RULES.md
MICROSOFT_SETUP.md
docs/ROADMAP.md hoặc ROADMAP.md
docs/tasks/
docs/reports/
```

### 8.3. Commands Run

Ghi rõ lệnh đã chạy và kết quả:

```text
git status --short
npm run verify
```

Nếu có lệnh khác, liệt kê thêm.

### 8.4. MVP Acceptance Matrix

Bảng bắt buộc gồm các cột:

```text
Area | Expected | Evidence | Status | Notes
```

Các area tối thiểu:

1. Admin dashboard.
2. Customer management.
3. Telegram mapping.
4. Telegram test-send.
5. Facebook/Meta detector.
6. Code extractor.
7. Deduplication.
8. Mock flow.
9. Code event log.
10. Audit log.
11. Microsoft OAuth connect URL.
12. Microsoft OAuth callback.
13. Token encryption.
14. Mailbox persistence.
15. Graph mail read.
16. Graph subscription.
17. Webhook verification.
18. Webhook receiver.
19. Queue/worker.
20. Real Graph message processing pipeline.
21. Delta polling backup.
22. Subscription renewal.
23. Telegram retry/failure handling.
24. Health dashboard.
25. Alert service.
26. Security hardening.
27. Mock E2E.
28. Microsoft mailbox E2E.
29. Staging deployment setup.
30. Operational preflight readiness.

Mỗi dòng phải có status:

```text
PASS
FAIL
PARTIAL
NOT VERIFIED
NOT APPLICABLE
```

### 8.5. Security Acceptance

Kiểm tra tối thiểu:

* Không hardcode secret/token/password.
* `.env` / `.env.local` không bị commit.
* `.env.example` chỉ có placeholder.
* Không log full verification code.
* Không log token.
* Refresh token được encrypt.
* Telegram bot token chỉ nằm trong env/secret manager.
* Không gửi full email body vào Telegram.
* Webhook validate clientState.
* Không gửi code vào group chưa map.
* Customer isolation không bị phá.
* Audit log cho thao tác nhạy cảm.

### 8.6. Reliability Acceptance

Kiểm tra tối thiểu:

* Webhook là primary path.
* Delta polling là backup path.
* Dedup chống trùng khi webhook + polling cùng thấy một message.
* Subscription renewal hoạt động.
* Telegram retry/backoff hoạt động.
* Alert service hoạt động.
* Health dashboard surface trạng thái vận hành.
* Pipeline production worker không chỉ là type-only/mock.

### 8.7. Staging / Operational Acceptance

Kiểm tra tối thiểu:

* Có staging setup docs/config.
* Không dùng production secret trong repo.
* Có checklist env/staging.
* Có Microsoft test mailbox evidence.
* Có Telegram test group/admin alert evidence.
* Có preflight operational readiness evidence.

### 8.8. Known Gaps / Risks

Ghi rõ mọi điểm chưa đạt hoặc chưa xác minh.

Không được giấu rủi ro để kết luận PASS.

### 8.9. Final Decision

Kết luận theo luật:

```text
PASS
```

Chỉ dùng khi mọi tiêu chí quan trọng đều có bằng chứng PASS.

```text
CONDITIONAL PASS
```

Dùng khi core MVP đạt, nhưng còn một số điểm vận hành nhỏ cần theo dõi, không chặn MVP review.

```text
FAIL
```

Dùng khi có lỗi Critical/High, thiếu evidence quan trọng, verify fail, security fail, E2E fail, hoặc staging/preflight chưa đạt.

---

## 9. Tiêu chí nghiệm thu TASK-040

TASK-040 được coi là đạt khi:

* Có file `docs/reports/mvp-acceptance-review.md`.
* Report có kết luận rõ PASS / FAIL / CONDITIONAL PASS.
* Report có acceptance matrix đầy đủ.
* Report có evidence cụ thể, không chỉ nói chung chung.
* `npm run verify` PASS hoặc nếu FAIL thì report phải ghi rõ FAIL/blocker.
* Không sửa code feature trong task này.
* Không làm lộ secret/token/code/email body.
* Gemini review report + git diff và kết luận PASS.
* GitHub Actions PASS sau khi push, nếu có push.

---

## 10. Không được làm

Không được:

* Thêm feature mới.
* Sửa code để “làm cho MVP pass” trong cùng task.
* Sửa test để che lỗi.
* Xóa/né security rule.
* Tự ý thay đổi roadmap lớn.
* Tự ý deploy production.
* Dùng mailbox/group khách thật để test.
* In `.env.local`.
* Commit secret.
* Kết luận PASS khi evidence không đủ.

---

## 11. Kết quả mong muốn cuối task

Sau khi hoàn thành, Claude phải báo:

1. Đã đọc file nào.
2. Đã chạy lệnh nào.
3. Kết quả `npm run verify`.
4. File nào đã tạo/sửa.
5. Kết luận acceptance review: PASS / FAIL / CONDITIONAL PASS.
6. Các blocker/risk còn lại.
7. Có an toàn để gửi Gemini review chưa.

````

---

