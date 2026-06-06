# TASK-073 — Webhook enqueue failure handling

## Mục tiêu

Fix High finding của TASK-072: Microsoft webhook route hiện luôn trả **202** kể cả
khi một notification hợp lệ **enqueue thất bại**, khiến Microsoft Graph coi như đã
giao thành công và **không gửi lại** → nguy cơ **âm thầm bỏ sót verification email**.

Sửa tối thiểu để: khi có bất kỳ enqueue thất bại thật sự nào trong request, route
**không** trả 2xx mà trả **503** để Microsoft retry; dựa vào deterministic jobId +
dedup sẵn có để retry không gây gửi trùng.

## Bối cảnh

- Đường relay chính là webhook (delta polling chỉ là backup, nhạy về thời gian).
- `app/api/webhooks/microsoft/mail/route.ts` gọi `enqueueAcceptedNotifications`,
  bắt lỗi từng notification và đếm `failed`, nhưng vẫn luôn trả `202`.
- Mỗi job dùng jobId deterministic `microsoft-webhook:{mailboxId}:{graphMessageId}`
  (`services/queue/email-job-options.ts`) → BullMQ tự khử trùng khi retry; pipeline
  còn có unique `(mailboxId, graphMessageId)` ở `ProcessedMessage` chặn gửi trùng.

## Scope được làm

- Tạo task file này.
- Sửa tối thiểu webhook route: trả 503 khi có enqueue failure, giữ 202 khi không.
- Thêm test cho enqueue failure path.
- Tạo report khi xong.
- Chạy `npm run verify`.

## Scope KHÔNG làm

- Không rate-limit webhook endpoint (để TASK-078).
- Không sửa Graph 403 classification (để TASK-074).
- Không sửa RBAC/scope mapping/destination.
- Không sửa dedup received-time bucket.
- Không sửa subscription renewal concurrency.
- Không sửa UI.
- Không dùng 207 (vẫn thuộc nhóm 2xx, dễ bị hiểu là success).
- Không thêm retry loop thủ công trong route (chỉ enqueue một lần mỗi notification).
- Không đổi `enqueueMicrosoftGraphMessageJob`, job options, hay logic jobId.
- Không chạy scale test, không gọi Graph thật, không gửi Telegram thật, không đụng
  production database, không đọc/in/sửa `.env*`, không sửa GitHub Actions.

## Yêu cầu implementation

1. validationToken verification: vẫn trả 200 text/plain như cũ, không phụ thuộc
   queue/Redis.
2. clientState validation: notification sai clientState bị **skip** trước khi
   enqueue; skip **không** được tính là enqueue failure (không ép 503). Không log
   raw clientState.
3. Notification hợp lệ cần enqueue:
   - Enqueue thành công toàn bộ → giữ behavior `202` hiện có.
   - Có enqueue thất bại thật → trả **503** cho toàn request (kể cả partial).
4. Response/log chỉ chứa count/trạng thái tổng hợp an toàn; không chứa payload nhạy
   cảm, full email body, full code, token, secret, clientState.

## Test bắt buộc

- validationToken flow vẫn trả 200 text/plain, không enqueue.
- clientState mismatch vẫn skip an toàn, không enqueue, không thành failure (202).
- enqueue throw với 1 notification hợp lệ → route trả 503, không trả 202.
- batch có ≥1 enqueue fail (kèm 1 success) → 503.
- enqueue mỗi accepted notification đúng một lần (không retry loop trong route).
- response 503 không lộ clientState/secret/full code/full email body.

## Lệnh kiểm tra

```bash
npm run verify
git status --short
git diff --stat
```

## Tiêu chí nghiệm thu

- Route trả 503 khi có enqueue failure (kể cả partial), 202 khi không có.
- validationToken + clientState skip behavior giữ nguyên.
- Không phá deterministic jobId / dedup hiện có.
- `npm run verify` PASS.
- Chỉ sửa runtime tối thiểu + test + 2 file docs; không đụng scope cấm.
- Không commit.

## Cách chuyển findings thành task fix sau (liên quan)

- Rate-limit webhook endpoint: TASK-078.
- Graph 403 classification consistency: TASK-074.
- Các Medium/Low khác từ TASK-072: theo task riêng đã liệt kê trong report TASK-072.
