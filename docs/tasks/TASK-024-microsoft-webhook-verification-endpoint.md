# TASK-024: Tạo Microsoft webhook verification endpoint

## 1. Mục tiêu

Tạo endpoint webhook verification cho Microsoft Graph change notifications.

Khi Microsoft Graph tạo subscription, Microsoft sẽ gọi `notificationUrl` với query parameter `validationToken`.

Endpoint của hệ thống phải đọc `validationToken`, URL-decode đúng cách, rồi trả lại chính token đó ở dạng plain text với HTTP 200.

Mục tiêu của task này là giúp TASK-023 Graph subscription service có thể tạo subscription thành công với Microsoft Graph.

---

## 2. Bối cảnh trong roadmap

TASK-024 thuộc Sprint 6 — Microsoft webhook & worker.

Thứ tự liên quan:

```text
TASK-023: Tạo Graph subscription service
TASK-024: Tạo Microsoft webhook verification endpoint
TASK-025: Tạo webhook receiver cho notification thật
TASK-026: Setup queue & worker foundation
TASK-027: Worker xử lý Graph message → detector → extractor → Telegram
````

TASK-024 chỉ làm phần verification endpoint.

Không được làm nhầm sang TASK-025/TASK-026/TASK-027.

---

## 3. Yêu cầu chức năng

### 3.1. Endpoint chính

Tạo route:

```text
POST /api/webhooks/microsoft/mail
```

Vị trí đề xuất với Next.js App Router:

```text
app/api/webhooks/microsoft/mail/route.ts
```

Nếu project đang dùng `src/`, dùng:

```text
src/app/api/webhooks/microsoft/mail/route.ts
```

Claude phải kiểm tra cấu trúc thực tế trước khi tạo file, không được tạo song song cả `app/` và `src/app/`.

---

### 3.2. Xử lý validationToken

Khi request có query:

```text
?validationToken=some-token
```

Endpoint phải trả:

```text
HTTP 200
Content-Type: text/plain; charset=utf-8
Body: some-token
```

Ví dụ:

Request:

```text
POST /api/webhooks/microsoft/mail?validationToken=abc%20123
```

Response body phải là:

```text
abc 123
```

Lưu ý:

* `validationToken` phải được URL-decode.
* Nếu dùng `new URL(request.url).searchParams.get("validationToken")`, URLSearchParams đã decode sẵn.
* Không double-decode nếu không cần, để tránh lỗi với ký tự `%`.
* Không trả JSON cho case validationToken.
* Không bọc token trong object.
* Không trả thêm dấu ngoặc kép.
* Không thêm text thừa.

Sai:

```json
{ "validationToken": "abc 123" }
```

Sai:

```text
"abc 123"
```

Đúng:

```text
abc 123
```

---

### 3.3. Method cần hỗ trợ

Bắt buộc hỗ trợ:

```text
POST
```

Có thể hỗ trợ thêm:

```text
GET
```

GET chỉ dùng cho local/manual smoke test, không thay thế POST.

Microsoft Graph validation chính thức gửi request tới notification URL và yêu cầu endpoint trả token plain text trong 10 giây.

---

### 3.4. Khi không có validationToken

Trong TASK-024, nếu POST không có `validationToken`, route không được xử lý notification thật.

Có thể trả một trong hai cách sau, ưu tiên cách A:

Cách A — placeholder an toàn cho TASK-025:

```json
{
  "ok": true,
  "received": true,
  "message": "Notification handling will be implemented in TASK-025"
}
```

với status:

```text
202 Accepted
```

Cách B — báo thiếu token:

```json
{
  "ok": false,
  "error": "Missing validationToken"
}
```

với status:

```text
400 Bad Request
```

Nếu chọn cách A, cần comment rõ đây chỉ là placeholder, không parse body, không Graph fetch, không queue, không Telegram.

---

## 4. Yêu cầu bảo mật

Endpoint này không được:

* Log access token.
* Log refresh token.
* Log client secret.
* Log Telegram bot token.
* Log full email body.
* Log verification code.
* Gửi Telegram.
* Gọi Microsoft Graph để fetch email.
* Tin tưởng notification payload thật ở TASK-024.

Nếu có log, chỉ log metadata tối thiểu, ví dụ:

```text
Microsoft webhook validation request received
```

Không log nội dung `validationToken` nếu không cần.

---

## 5. File/thư mục dự kiến tạo hoặc sửa

Claude phải kiểm tra cấu trúc thực tế trước.

Nếu project không dùng `src/`:

```text
app/api/webhooks/microsoft/mail/route.ts
tests/unit/microsoft/webhook-verification.test.ts
```

Nếu project dùng `src/`:

```text
src/app/api/webhooks/microsoft/mail/route.ts
src/tests/unit/microsoft/webhook-verification.test.ts
```

Nếu project đã có thư mục test khác, ví dụ `__tests__/`, thì đặt test theo cấu trúc hiện có.

Có thể tạo helper nhỏ nếu cần:

```text
services/microsoft/webhook-verification.service.ts
```

hoặc:

```text
src/services/microsoft/webhook-verification.service.ts
```

Nhưng không bắt buộc. Nếu logic route đơn giản, có thể giữ trực tiếp trong route.

---

## 6. Hướng implement đề xuất

### 6.1. Route behavior

Pseudo logic:

```text
POST request đến /api/webhooks/microsoft/mail

1. Đọc validationToken từ query string.
2. Nếu có validationToken:
   - Trả HTTP 200.
   - Header Content-Type = text/plain; charset=utf-8.
   - Body = validationToken đã decode.
3. Nếu không có validationToken:
   - Không xử lý notification thật trong TASK-024.
   - Trả 202 placeholder hoặc 400 missing token.
```

### 6.2. Không dùng JSON cho validation response

Với case có validationToken, phải dùng:

```ts
return new Response(validationToken, {
  status: 200,
  headers: {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store",
  },
});
```

Không dùng:

```ts
return NextResponse.json(...)
```

cho case validationToken.

---

## 7. Test bắt buộc

Cần có test tự động cho ít nhất các case:

### Case 1 — POST có validationToken đơn giản

Input:

```text
/api/webhooks/microsoft/mail?validationToken=abc123
```

Kỳ vọng:

```text
Status: 200
Content-Type: text/plain
Body: abc123
```

### Case 2 — POST có validationToken đã URL-encoded

Input:

```text
/api/webhooks/microsoft/mail?validationToken=abc%20123
```

Kỳ vọng body:

```text
abc 123
```

### Case 3 — validationToken chứa ký tự đặc biệt đã encode

Input ví dụ:

```text
/api/webhooks/microsoft/mail?validationToken=token%2Bwith%2Fsymbols%3D
```

Kỳ vọng body:

```text
token+with/symbols=
```

### Case 4 — POST không có validationToken

Kỳ vọng:

* Không throw 500.
* Không gọi Graph API.
* Không gửi Telegram.
* Trả 202 placeholder hoặc 400 missing token, tùy implementation đã chọn.

### Case 5 — GET có validationToken, nếu có implement GET

Nếu implement GET cho manual test:

```text
GET /api/webhooks/microsoft/mail?validationToken=abc123
```

Kỳ vọng:

```text
Status: 200
Content-Type: text/plain
Body: abc123
```

---

## 8. Lệnh kiểm tra

Sau khi code xong, Claude phải chạy:

```powershell
npm run verify
```

Nếu project có test command riêng:

```powershell
npm test
```

hoặc:

```powershell
npm run test
```

Nhưng cuối cùng vẫn phải chạy:

```powershell
npm run verify
```

---

## 9. Manual smoke test bằng PowerShell/curl

Chạy dev server:

```powershell
npm run dev
```

Mở PowerShell khác, đứng ở bất kỳ thư mục nào cũng được, chạy:

```powershell
curl.exe -i -X POST "http://localhost:3000/api/webhooks/microsoft/mail?validationToken=abc123"
```

Kỳ vọng thấy:

```text
HTTP/1.1 200 OK
Content-Type: text/plain; charset=utf-8

abc123
```

Test token có khoảng trắng:

```powershell
curl.exe -i -X POST "http://localhost:3000/api/webhooks/microsoft/mail?validationToken=abc%20123"
```

Kỳ vọng body:

```text
abc 123
```

Nếu có implement GET:

```powershell
curl.exe -i "http://localhost:3000/api/webhooks/microsoft/mail?validationToken=abc123"
```

Kỳ vọng body:

```text
abc123
```

---

## 10. Tiêu chí nghiệm thu

Task được coi là PASS khi:

* Có route Microsoft webhook verification endpoint.
* POST với `validationToken` trả HTTP 200.
* Response là plain text, không phải JSON.
* Response body là token đã URL-decode.
* Content-Type là `text/plain`.
* Không xử lý notification thật trong TASK-024.
* Không gọi Graph API trong webhook route.
* Không gửi Telegram.
* Không tạo queue/worker.
* Không log token/secret/code/email body.
* Có test tự động cho validationToken.
* `npm run verify` PASS.
* Gemini review PASS.

---

## 11. Những lỗi cần tránh

* Trả JSON thay vì plain text.
* Quên set `Content-Type: text/plain`.
* Trả token còn URL-encoded.
* Double-decode token gây lỗi.
* Dùng GET nhưng quên POST.
* Xử lý notification thật trong TASK-024.
* Gửi Telegram trong webhook endpoint.
* Gọi Graph API trong webhook endpoint.
* Tạo queue/worker trước TASK-026.
* Làm lan sang TASK-025/TASK-027.
* Tạo file sai cấu trúc `src/` và non-`src/`.
* Làm `npm run verify` fail.




