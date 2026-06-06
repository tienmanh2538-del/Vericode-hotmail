# TASK-074 — Sync email pipeline Graph 403 classification with TASK-071

## Mục tiêu

Fix Medium finding của TASK-072: email pipeline đang map Graph **403/permission**
thành `FAILED_RECONNECT_REQUIRED`, chưa đồng bộ với TASK-071 (delta polling đã tách
403 → `forbidden`, KHÔNG reconnect). Cần:

- 401/`auth`/invalid token → vẫn reconnect-required nếu đúng loại lỗi.
- 403/`permission`/forbidden → KHÔNG gắn nhãn reconnect-required.
- 403 → KHÔNG flip mailbox sang `RECONNECT_REQUIRED`.
- Giữ refresh-token failure classification từ TASK-069C.
- Giữ dedup exactly-once, delta polling backup, webhook behavior TASK-073, routing,
  queue, Telegram sender.

## Bối cảnh / root cause

`services/email/graph-message-pipeline.service.ts` → `mapGraphErrorToResult` gom
`err.kind === 'auth' || err.kind === 'permission'` cùng trả status
`FAILED_RECONNECT_REQUIRED`. Trong khi:

- `services/microsoft/graph-mail.service.ts` đã phân loại đúng: HTTP 401 → `auth`,
  HTTP 403 → `permission`.
- Nhánh side-effect khi fetch lỗi (`processActiveMailboxJob`) **đã** chỉ gọi
  `markReconnectRequired` khi `err.kind === 'auth'` (401) → 403 vốn KHÔNG flip
  mailbox. Vấn đề chỉ là **nhãn status** của 403 bị gắn reconnect (gây hiểu nhầm +
  là regression tiềm ẩn nếu ai đó nối `result.status` vào việc flip mailbox).

→ TASK-071 đã tách 403 cho delta polling; TASK-074 đồng bộ tinh thần đó cho email
pipeline.

## Scope được làm

1. Tạo task file này.
2. Sửa tối thiểu `mapGraphErrorToResult`: chỉ `auth` (401) →
   `FAILED_RECONNECT_REQUIRED`; `permission` (403) rơi xuống status trung tính
   `FAILED_GRAPH_FETCH` (đã tồn tại, vẫn retryable, không flip mailbox).
3. Thêm regression test trong
   `tests/unit/email/graph-message-pipeline.service.test.ts`.
4. Tạo report.

Không thêm status mới: `FAILED_GRAPH_FETCH` là lựa chọn trung tính an toàn sẵn có,
cũng được worker xử lý retry (xem `email-worker.ts`). Không tạo migration/schema.

## Scope KHÔNG làm

- Không sửa webhook enqueue failure (TASK-073 đã xong).
- Không thêm webhook rate-limit/origin guard.
- Không sửa delta persistent-403 backoff/alert.
- Không sửa delta cursor metadata cleanup.
- Không sửa RBAC/customer-scope mapping/destination.
- Không sửa dedup receivedAtBucket.
- Không sửa subscription renewal concurrency.
- Không sửa UI.
- Không sửa `graph-mail.service.ts` classification (đã đúng).
- Không gọi Microsoft Graph thật, không gửi Telegram thật, không đụng production
  database, không đọc/in/sửa `.env*`, không sửa GitHub Actions.

## Test bắt buộc

- Graph 403/permission trong email pipeline → status KHÔNG phải
  `FAILED_RECONNECT_REQUIRED` (cụ thể `FAILED_GRAPH_FETCH`, reason `permission`).
- Graph 403 → KHÔNG gọi `markReconnectRequired`, KHÔNG ghi audit
  `MAILBOX_RECONNECT_REQUIRED`.
- Graph 401/auth → giữ behavior reconnect-required (test cũ Case 6b).
- Refresh-token `reconnect_required` / transient → giữ classification TASK-069C
  (test cũ giữ nguyên).
- Transient 429/5xx → vẫn `FAILED_GRAPH_FETCH`, không reconnect.
- Không phá dedup exactly-once / routing / delta backup.
- Không log/return token, secret, full verification code, full email body.

## Lệnh kiểm tra

```bash
npm run verify
git status --short
git diff --stat
```

## Tiêu chí nghiệm thu

- 403/permission email pipeline không còn `FAILED_RECONNECT_REQUIRED` và không flip
  mailbox.
- 401/auth + token classification (TASK-069C) giữ nguyên.
- `npm run verify` PASS.
- Chỉ sửa runtime tối thiểu + test + 2 file docs; không đụng scope cấm.
- Không commit (chờ Gemini review).
