# TASK-032: Subscription renewal worker

## 1. Mục tiêu

Tạo cơ chế tự động gia hạn Microsoft Graph subscriptions cho mailbox đã kết nối, để webhook email mới không bị ngừng do subscription hết hạn.

TASK này thuộc Sprint 8 — Reliability.

Mục tiêu chính:

```text
Active mailbox + active Graph subscription
→ worker kiểm tra định kỳ
→ nếu subscription còn <= 24 giờ thì renew
→ cập nhật DB
→ ghi log/audit an toàn
→ xử lý lỗi token/subscription rõ ràng
````

Microsoft Graph subscription cho Outlook message có thời hạn giới hạn, nên hệ thống phải renew trước khi hết hạn. Worker này giúp đảm bảo webhook vẫn hoạt động ổn định.

---

## 2. Bối cảnh trong roadmap

Các task trước đã có:

* TASK-023: Graph subscription service.
* TASK-024: Microsoft webhook verification endpoint.
* TASK-025: Webhook receiver cho notification thật.
* TASK-026: Queue & worker foundation.
* TASK-027: Worker xử lý Graph message → detector → extractor → Telegram.
* TASK-031: Delta polling backup worker.

TASK-032 chỉ làm renewal worker.

Không làm:

* TASK-033: Telegram retry & failure handling.
* TASK-034: Health dashboard.
* TASK-035: Alert service.
* TASK-036: Security hardening review.

---

## 3. Phạm vi bắt buộc

### 3.1. Subscription renewal service

Tạo hoặc hoàn thiện:

```text
services/microsoft/subscription-renewal.service.ts
```

Service cần có các chức năng tối thiểu:

1. Tìm GraphSubscription cần renew:

   * status đang active/usable.
   * expirationDateTime còn <= 24 giờ.
   * mailbox tương ứng chưa DISABLED.
   * có subscriptionId hợp lệ.

2. Renew từng subscription bằng Microsoft Graph:

   * gọi `PATCH https://graph.microsoft.com/v1.0/subscriptions/{subscriptionId}`.
   * request body chỉ cần:

     ```json
     {
       "expirationDateTime": "<UTC ISO datetime>"
     }
     ```
   * thời gian mới nên là `now + 6 days` để không chạm giới hạn gần 7 ngày của Outlook subscription.

3. Cập nhật database khi renew thành công:

   * `expirationDateTime` = giá trị Microsoft trả về nếu có.
   * `lastRenewedAt` = now.
   * `status` = ACTIVE.
   * clear/reset last error nếu schema hiện có field tương ứng.
   * không thay đổi clientState/clientStateHash.

4. Ghi audit/log nếu project đã có service:

   * action gợi ý: `SUBSCRIPTION_RENEWED`.
   * metadata không chứa token/secret.
   * metadata chỉ nên có mailboxId, graphSubscriptionId, oldExpirationDateTime, newExpirationDateTime.

5. Xử lý lỗi:

   * Nếu refresh/access token fail do bị revoke/invalid_grant:

     * mark mailbox `RECONNECT_REQUIRED`.
     * mark subscription lỗi nếu có status phù hợp.
     * ghi log an toàn.
   * Nếu Microsoft trả 404/410 hoặc lỗi thể hiện subscription không còn tồn tại:

     * nếu existing `graph-subscription.service.ts` đã có hàm create/recreate subscription thì có thể gọi để recover.
     * nếu không có sẵn, mark `SUBSCRIPTION_EXPIRED` và không tự viết lại toàn bộ module create subscription.
   * Nếu lỗi transient như 429/500/502/503/504:

     * retry giới hạn trong phạm vi worker/service.
     * không để 1 mailbox lỗi làm crash toàn bộ batch.
   * Không bao giờ log accessToken, refreshToken, clientSecret, encryptedRefreshToken.

---

## 4. Worker/scheduler

Nếu project đã có worker foundation từ TASK-026/TASK-031, tích hợp worker mới theo pattern hiện có.

Tên file gợi ý, tùy cấu trúc thực tế:

```text
services/queue/workers/subscription-renewal.worker.ts
```

Worker cần:

1. Chạy định kỳ mỗi 15–30 phút.
2. Gọi `subscription-renewal.service`.
3. Có summary kết quả:

   * checked
   * renewed
   * skipped
   * failed
4. Không gửi Telegram.
5. Không làm health dashboard.
6. Không tạo alert service thật.

Nếu project chưa có scheduler chung nhưng TASK-031 đã tạo pattern polling scheduler, hãy reuse pattern đó. Không tạo kiến trúc scheduler mới hoàn toàn nếu có thể tránh.

---

## 5. Yêu cầu về Microsoft Graph

Renew bằng endpoint:

```text
PATCH /subscriptions/{id}
```

Body:

```json
{
  "expirationDateTime": "2026-06-04T10:00:00.000Z"
}
```

Lưu ý:

* Không update notificationUrl trong task này trừ khi service hiện có bắt buộc.
* Không update resource/changeType/clientState.
* Không tạo quyền Microsoft mới.
* Không xin `Mail.Send`, `Mail.ReadWrite`, `MailboxSettings.ReadWrite`.

---

## 6. Yêu cầu bảo mật

Bắt buộc:

* Không log token.
* Không log refresh token.
* Không log encryptedRefreshToken.
* Không log client secret.
* Không đọc/in `.env` hoặc `.env.local`.
* Không expose token ra API/frontend.
* Không tạo UI mới hiển thị token.
* Không lưu secret mới trong source code.
* Nếu cần env mới, chỉ thêm placeholder vào `.env.example`, không thêm secret thật.

---

## 7. Database/schema

Ưu tiên dùng schema hiện có.

Chỉ tạo migration nếu thật sự thiếu field bắt buộc cho renewal, ví dụ:

* `GraphSubscription.lastRenewedAt`
* `GraphSubscription.status`
* `GraphSubscription.expirationDateTime`
* `GraphSubscription.subscriptionId`
* field lưu last error nếu project đã có convention

Không tự ý refactor lớn Prisma schema.

Không tạo field lưu token plaintext.

Không tạo field lưu full verification code.

---

## 8. File dự kiến tạo/sửa

Claude phải kiểm tra cấu trúc thực tế trước, sau đó báo trước file dự kiến tạo/sửa.

Dự kiến có thể liên quan:

```text
services/microsoft/subscription-renewal.service.ts
services/microsoft/graph-subscription.service.ts
services/queue/workers/subscription-renewal.worker.ts
services/queue/workers/index.ts
tests/unit/microsoft/subscription-renewal.service.test.ts
tests/unit/queue/subscription-renewal.worker.test.ts
```

Có thể sửa thêm file export/index nếu project đang dùng barrel export.

Không sửa UI/admin page trong task này.

Không sửa Telegram sender trong task này.

Không sửa parser/email-processing pipeline trong task này.

---

## 9. Test bắt buộc

Cần có unit test cho các case sau:

### 9.1. Chọn subscription cần renew

* Subscription còn hơn 24 giờ → skip.
* Subscription còn <= 24 giờ → renew.
* Subscription đã expired → xử lý expired/recreate/mark status theo khả năng hiện có.
* Mailbox DISABLED → skip.
* Subscription thiếu subscriptionId → fail/skip an toàn, không crash.

### 9.2. Renew thành công

* Gọi đúng Microsoft Graph PATCH.
* Body có `expirationDateTime`.
* Update DB đúng:

  * expirationDateTime mới.
  * lastRenewedAt.
  * status ACTIVE.
* Audit log `SUBSCRIPTION_RENEWED` nếu audit service hiện có.

### 9.3. Token/reconnect error

* Nếu token refresh fail do revoke/invalid_grant:

  * mailbox chuyển `RECONNECT_REQUIRED`.
  * không retry vô hạn.
  * không log token.

### 9.4. Graph transient error

* 429/500/502/503/504:

  * retry giới hạn.
  * ghi nhận failed nếu hết retry.
  * batch vẫn xử lý mailbox khác.

### 9.5. Không vượt scope

* Không gửi Telegram.
* Không gọi email parser.
* Không gọi email-processing pipeline.
* Không tạo health dashboard.
* Không tạo alert service thật.

---

## 10. Lệnh kiểm tra

Claude phải chạy tối thiểu:

```powershell
npm run verify
```

Nếu có test riêng, chạy thêm lệnh tương ứng, ví dụ:

```powershell
npm test -- --run tests/unit/microsoft/subscription-renewal.service.test.ts
```

Nếu project dùng Vitest pattern khác, dùng đúng command hiện có trong `package.json`.

---

## 11. Tiêu chí nghiệm thu

TASK-032 chỉ PASS khi:

```text
[ ] Có service renewal rõ ràng.
[ ] Worker/scheduler chạy định kỳ 15–30 phút hoặc được wire theo pattern hiện có.
[ ] Chỉ renew subscription còn <= 24 giờ.
[ ] Renew dùng PATCH /subscriptions/{id}.
[ ] expirationDateTime mới nằm trong giới hạn an toàn, ví dụ now + 6 days.
[ ] DB cập nhật expirationDateTime/lastRenewedAt/status sau khi renew.
[ ] Token revoked được map sang RECONNECT_REQUIRED.
[ ] Subscription missing/expired được mark SUBSCRIPTION_EXPIRED hoặc recover bằng service sẵn có.
[ ] Lỗi transient không crash toàn bộ batch.
[ ] Không log token/secret.
[ ] Không tạo UI health dashboard.
[ ] Không làm Telegram retry.
[ ] Có unit test cho success/skip/fail/token revoked.
[ ] npm run verify PASS.
```

---

## 12. Những lỗi cần tránh

* Renew quá sát hạn, ví dụ chỉ còn vài phút mới renew.
* Renew với expirationDateTime vượt quá giới hạn Microsoft Graph.
* Dùng `setInterval` lung tung tạo nhiều worker song song trong dev/serverless nếu project đã có scheduler pattern.
* Làm crash toàn bộ worker vì 1 mailbox lỗi.
* Ghi access token/refresh token vào log.
* Tự ý tạo alert Telegram admin trong TASK-032.
* Tự ý sửa dashboard health trong TASK-032.
* Tự ý refactor lớn graph-subscription service.
* Tạo migration không cần thiết.

````