# TASK-034: Health Dashboard

## 1. Mục tiêu

Tạo trang Health Dashboard tại `/admin/health` để admin có thể kiểm tra nhanh tình trạng vận hành của hệ thống Verification Code Relay Tool.

Dashboard này phải giúp phát hiện sớm các vấn đề vận hành như:

- Mailbox mất quyền hoặc cần reconnect.
- Microsoft Graph subscription sắp hết hạn hoặc đã hết hạn.
- Delta polling không chạy gần đây.
- Email worker / production pipeline chưa được wire đúng.
- Telegram mapping thiếu hoặc Telegram send retry/failure gần đây.
- Không có email/code nào được xử lý gần đây.
- Có lỗi gần nhất cần admin biết.

TASK này thuộc Sprint 8 — Reliability.

## 2. Bối cảnh từ ROADMAP

TASK-034: Tạo health dashboard.

Ghi chú quan trọng từ TASK-031:

- Phải verify production email-worker có được wire vào real pipeline hay chưa.
- Nếu `createEmailWorker` hiện chỉ là type-only cast/default placeholder và không thật sự chạy production pipeline, dashboard hoặc operational check phải surface rõ trạng thái này.

## 3. Phạm vi được làm

Claude Code được phép:

1. Tạo trang admin health tại:

   ```text
   app/admin/health/page.tsx
````

2. Tạo style riêng nếu project đang dùng CSS riêng theo page:

   ```text
   app/admin/health/health.css
   ```

   hoặc dùng CSS/module pattern đang có sẵn trong project.

3. Tạo health service:

   ```text
   services/health/health.service.ts
   ```

4. Tạo type/helper nhỏ nếu cần:

   ```text
   services/health/health.types.ts
   ```

5. Tạo test unit cho health service:

   ```text
   tests/unit/health/health.service.test.ts
   ```

   hoặc vị trí test tương ứng với cấu trúc thực tế của project.

6. Nếu sidebar/admin navigation chưa có link Health, được phép sửa component layout/sidebar tương ứng để thêm link:

   ```text
   /admin/health
   ```

7. Được phép đọc các service/model hiện có để lấy trạng thái:

   * Mailbox
   * TelegramMapping
   * GraphSubscription
   * ProcessedMessage
   * AuditLog
   * Code event log nếu project có
   * Queue/worker metadata nếu project có
   * Delta polling service state nếu project có
   * Subscription renewal service state nếu project có
   * Telegram retry/failure log nếu project có

8. Được phép tạo API read-only nếu project pattern hiện tại yêu cầu dashboard gọi API thay vì Server Component, ví dụ:

   ```text
   app/api/health/route.ts
   ```

   Tuy nhiên ưu tiên Server Component gọi service trực tiếp nếu project đang dùng pattern đó.

## 4. Phạm vi không được làm

Claude Code không được:

1. Không tạo alert service thật. Alert service là TASK-035.
2. Không gửi Telegram alert thật.
3. Không sửa OAuth flow.
4. Không sửa Microsoft token refresh flow, trừ khi chỉ đọc trạng thái để hiển thị.
5. Không sửa webhook receiver.
6. Không sửa delta polling logic, trừ khi chỉ expose trạng thái đọc-only.
7. Không sửa subscription renewal logic, trừ khi chỉ expose trạng thái đọc-only.
8. Không sửa Telegram retry/backoff logic của TASK-033, trừ khi chỉ đọc trạng thái/failure log để hiển thị.
9. Không tạo migration DB mới nếu không có yêu cầu bắt buộc.
10. Không thêm field nhạy cảm vào response/UI.
11. Không đọc hoặc in `.env`, `.env.local`.
12. Không log token, refresh token, access token, client secret, Telegram bot token, clientState, encryptedRefreshToken, full verification code, full email body.
13. Không hardcode Telegram chat ID hoặc token.
14. Không làm TASK-035, TASK-036, TASK-037, TASK-038.

## 5. Yêu cầu chức năng

Trang `/admin/health` phải có các phần sau.

### 5.1. Overview cards

Hiển thị các card tổng quan:

* Total mailboxes.
* Active mailboxes.
* Mailboxes cần reconnect.
* Mailboxes disabled/error.
* Subscription expired.
* Subscription expiring soon, ví dụ còn dưới 24 giờ.
* Mailboxes thiếu Telegram mapping.
* Mailboxes polling stale, ví dụ không được poll trong hơn 2 phút hoặc theo threshold hợp lý.
* Telegram failures gần đây, nếu có dữ liệu.
* Last code sent time, nếu có dữ liệu.
* Overall health status:

  ```text
  OK
  WARNING
  CRITICAL
  UNKNOWN
  ```

### 5.2. Mailbox health table

Hiển thị bảng theo từng mailbox với các cột an toàn:

* Email address.
* Owner/customer name nếu có.
* Mailbox status.
* Token/reconnect status.
* Telegram mapping status.
* Graph subscription status.
* Subscription expiration datetime.
* Last successful sync.
* Last delta polling time hoặc last checked time nếu có.
* Last code sent time nếu có.
* Last error dạng ngắn, đã sanitize.
* Health level:

  ```text
  OK
  WARNING
  CRITICAL
  UNKNOWN
  ```

Không hiển thị:

* Access token.
* Refresh token.
* Encrypted refresh token.
* Client secret.
* clientState raw.
* clientStateHash nếu không cần.
* Telegram bot token.
* Full code.
* Full email body.

### 5.3. Operational checks

Dashboard phải có section “Operational checks” hoặc tương đương.

Phải kiểm tra và hiển thị ít nhất:

1. Email worker pipeline:

   * PASS nếu worker thật đang dùng real email processing pipeline.
   * WARNING/CRITICAL nếu phát hiện vẫn là placeholder/type-only cast/no-op.

2. Delta polling:

   * PASS nếu có dấu hiệu polling chạy gần đây hoặc có field last polling cập nhật.
   * WARNING nếu không có dữ liệu hoặc quá lâu chưa poll.
   * UNKNOWN nếu project chưa đủ dữ liệu để kết luận.

3. Subscription renewal:

   * PASS nếu subscription còn hạn an toàn.
   * WARNING nếu còn dưới 24 giờ.
   * CRITICAL nếu đã hết hạn.

4. Telegram send reliability:

   * PASS nếu không có failure gần đây.
   * WARNING/CRITICAL nếu có retry exhausted hoặc TELEGRAM_SEND_FAILED gần đây.

5. Webhook health:

   * PASS/UNKNOWN dựa trên dữ liệu hiện có.
   * Không được fake kết quả “PASS” nếu code không có dữ liệu thật.

### 5.4. Empty state

Nếu database chưa có mailbox, trang phải hiển thị empty state thân thiện:

```text
Chưa có mailbox nào để kiểm tra health.
Hãy connect mailbox trước, sau đó quay lại trang Health.
```

Không được crash.

### 5.5. Error state

Nếu service đọc DB lỗi, UI phải hiển thị lỗi an toàn:

```text
Không thể tải health dashboard lúc này.
```

Có thể hiển thị message ngắn đã sanitize, nhưng không được in secret/token/raw env.

## 6. Yêu cầu kỹ thuật

1. Dùng TypeScript strict, không dùng `any` nếu tránh được.
2. Health service phải là server-side/service layer.
3. UI không được tự query Prisma trực tiếp nếu project đã có service pattern rõ ràng.
4. Service chỉ select field cần thiết, không select token/secret.
5. Nếu cần hiển thị last error, phải sanitize/redact.
6. Không dùng client component nếu không cần interaction.
7. Không thêm dependency mới nếu không cần.
8. Không đổi stack.
9. Không refactor lớn layout/admin shell.
10. Không phá route `/admin/mailboxes`, `/admin/logs`, `/admin/telegram`.

## 7. Gợi ý health status logic

Claude có thể dùng logic tham khảo sau, nhưng phải điều chỉnh theo schema thực tế:

### OK

* Mailbox ACTIVE.
* Có Telegram mapping active.
* Subscription active và còn hơn 24 giờ.
* Polling/check gần đây.
* Không có last error nghiêm trọng.
* Không có Telegram failure gần đây.

### WARNING

* Subscription còn dưới 24 giờ.
* Polling quá lâu chưa chạy nhưng chưa chắc chắn chết.
* Mailbox thiếu mapping.
* Có lỗi gần đây nhưng chưa làm mailbox mất chức năng.
* Không đủ dữ liệu để xác nhận worker/pipeline.

### CRITICAL

* Mailbox RECONNECT_REQUIRED.
* Subscription expired.
* Mailbox ERROR hoặc WEBHOOK_FAILED.
* Telegram retry exhausted/TELEGRAM_SEND_FAILED gần đây.
* Email worker production pipeline không được wire thật.
* Token refresh failure gần đây.

### UNKNOWN

* Database chưa có dữ liệu.
* Project chưa có field/log để kết luận.
* Service chưa thể xác định trạng thái mà không gọi external API.

## 8. File dự kiến tạo/sửa

Tạo mới hoặc sửa:

```text
docs/tasks/TASK-034-health-dashboard.md
app/admin/health/page.tsx
app/admin/health/health.css
services/health/health.service.ts
services/health/health.types.ts
tests/unit/health/health.service.test.ts
```

Có thể sửa nếu cần:

```text
components/layout/AdminSidebar.tsx
components/layout/AdminShell.tsx
app/admin/layout.tsx
```

Chỉ sửa để thêm link `/admin/health` nếu chưa có.

Có thể thêm API read-only nếu project pattern yêu cầu:

```text
app/api/health/route.ts
```

Nhưng không bắt buộc.

## 9. Tiêu chí nghiệm thu

TASK-034 chỉ đạt khi:

1. Truy cập được `/admin/health`.
2. Trang không crash khi database trống.
3. Trang hiển thị overview cards.
4. Trang hiển thị mailbox health table nếu có mailbox.
5. Trang hiển thị operational checks.
6. Có check hoặc hiển thị rõ trạng thái email worker / real pipeline, theo note từ TASK-031.
7. Có subscription expiry health.
8. Có polling health.
9. Có Telegram mapping/failure health nếu dữ liệu hiện có cho phép.
10. Không hiển thị token/secret/full code/full email body.
11. Không đọc/in `.env` hoặc `.env.local`.
12. Không tạo alert service thật.
13. Không tự sửa pipeline/job/worker logic ngoài phạm vi read-only health.
14. Có unit test cho health service hoặc ít nhất test logic classify status.
15. `npm run verify` PASS.
16. Gemini review PASS, không còn Critical/High/Medium issue.

## 10. Lệnh kiểm tra bắt buộc

Chạy:

```powershell
npm run verify
```

Nếu project có test riêng:

```powershell
npm test
npm run typecheck
npm run lint
npm run build
```

Chỉ cần chạy lệnh tồn tại trong `package.json`.

## 11. Manual test cho user

Sau khi Claude code xong:

1. Chạy dev server:

   ```powershell
   npm run dev
   ```

2. Mở browser:

   ```text
   http://localhost:3000/admin/health
   ```

3. Kiểm tra bằng mắt:

   * Có tiêu đề Health Dashboard.
   * Có overview cards.
   * Có bảng mailbox health hoặc empty state.
   * Có operational checks.
   * Không thấy token/secret/code/email body.
   * Nếu có mailbox lỗi, UI không crash.
   * Nếu chưa có mailbox, UI hiển thị empty state rõ ràng.

## 12. Báo cáo cuối task Claude phải trả về

Claude phải báo cáo theo format:

```text
1. Đã làm gì
2. File nào đã tạo/sửa
3. Có sửa ngoài scope không
4. Lệnh đã chạy
5. Kết quả npm run verify
6. Cách test thủ công /admin/health
7. Rủi ro còn lại
8. Có cần Gemini review không
```