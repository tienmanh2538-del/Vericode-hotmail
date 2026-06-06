# TASK-074 — Report: Sync email pipeline Graph 403 classification with TASK-071

## 1. Mục tiêu

Fix Medium finding của TASK-072: email pipeline map Graph **403/permission** thành
`FAILED_RECONNECT_REQUIRED`, chưa đồng bộ với TASK-071 (delta polling đã tách 403 →
`forbidden`, không reconnect). Sau fix: 401/`auth` vẫn reconnect-required; 403/
`permission` KHÔNG gắn nhãn reconnect và KHÔNG flip mailbox.

## 2. Root cause

Trong `services/email/graph-message-pipeline.service.ts`, hàm `mapGraphErrorToResult`
gom `err.kind === 'auth' || err.kind === 'permission'` → cùng trả status
`FAILED_RECONNECT_REQUIRED`. Trong khi:

- `graph-mail.service.ts` đã phân loại đúng: HTTP 401 → `auth`, HTTP 403 →
  `permission`.
- Nhánh side-effect khi fetch lỗi đã chỉ gọi `markReconnectRequired` cho
  `err.kind === 'auth'` (401). Tức **mailbox vốn KHÔNG bị flip trên 403** từ trước;
  chỉ có **nhãn status** của 403 bị gắn reconnect → gây hiểu nhầm và là regression
  tiềm ẩn nếu sau này `result.status` được nối vào việc flip mailbox.

## 3. File đã thay đổi

- `services/email/graph-message-pipeline.service.ts` — `mapGraphErrorToResult`:
  điều kiện đổi từ `auth || permission` thành **chỉ `auth`**. `permission` (403)
  rơi xuống status trung tính sẵn có `FAILED_GRAPH_FETCH` (vẫn retryable, không flip
  mailbox), `reason` giữ `permission`. Thêm comment giải thích đồng bộ TASK-071.
  Không thêm status mới, không đổi type/schema.
- `tests/unit/email/graph-message-pipeline.service.test.ts` — thêm 2 test regression.
- `docs/tasks/TASK-074-...md`, `docs/reports/TASK-074-...md` — mới.

**Không** đổi: `graph-mail.service.ts` (classification đã đúng), nhánh side-effect
fetch (đã chỉ flip trên 401), worker runner, refresh-token-failure (TASK-069C),
delta polling, webhook (TASK-073), routing, queue, Telegram sender, dedup.

### Vì sao `FAILED_GRAPH_FETCH` an toàn

`services/queue/workers/email-worker.ts` (khoảng dòng 208–218) coi cả
`FAILED_GRAPH_FETCH` lẫn `FAILED_RECONNECT_REQUIRED` là **retryable** (throw để
BullMQ retry). Nên đổi nhãn 403 sang `FAILED_GRAPH_FETCH` **không đổi** retry
behavior (job vẫn được retry — đúng tinh thần TASK-071 coi 403 là transient), chỉ
loại bỏ nhãn reconnect sai. Mailbox flip không đổi vì vốn chỉ xảy ra ở 401.

## 4. Test đã thêm/cập nhật

Thêm vào `tests/unit/email/graph-message-pipeline.service.test.ts`:

1. **Case 6c — 403/permission**: status = `FAILED_GRAPH_FETCH` (KHÔNG phải
   `FAILED_RECONNECT_REQUIRED`), `reason = 'permission'`, `markReconnectRequired`
   KHÔNG được gọi, KHÔNG có audit `MAILBOX_RECONNECT_REQUIRED`, không gửi Telegram,
   không lộ verification code / access token trong envelope.
2. **Case 6d — 429/5xx**: vẫn `FAILED_GRAPH_FETCH`, không reconnect (khẳng định lỗi
   transient không bị đổi thành reconnect-required).

Test cũ giữ nguyên và vẫn PASS:
- Case 6b — 401/auth → `FAILED_RECONNECT_REQUIRED` + flip mailbox.
- TASK-069C — token `reconnect_required` → reconnect; token transient →
  `FAILED_TOKEN_TRANSIENT`, không flip.

## 5. Kết quả npm run verify

**PASS**: db:generate ✓, lint sạch, typecheck sạch, **91 test files / 1074 tests
passed** (+2 so với 1072), build production "Compiled successfully".

## 6. Bảo mật / secret hygiene

- Không log/return token, refresh token, client secret, Telegram bot token,
  database/Redis URL, encryption key, session secret, full verification code, full
  email body. Thay đổi chỉ chạm nhánh phân loại lỗi; `reason` là enum kind
  (`permission`/`rate_limited`/…), không phải nội dung nhạy cảm.
- Test có assert envelope 403 không chứa verification code và access token.
- Không gọi Graph thật, không gửi Telegram thật, không đụng production DB, không
  đọc/in/sửa `.env*`, không sửa GitHub Actions/package scripts.

## 7. Rủi ro còn lại

- 403 ở mức account/endpoint thật (không phải blip) trong email pipeline sẽ liên tục
  `FAILED_GRAPH_FETCH` → retry theo `attempts` rồi dừng; **không** có backoff/alert
  riêng — phần này thuộc TASK-075 (out of scope TASK-074), giống ghi nhận của
  TASK-071 cho delta.
- Hành vi 403 thật của Graph chưa kiểm chứng live (ràng buộc không chạm production);
  logic phân loại phía ta đã đồng bộ với TASK-071.

## 8. Cần Gemini review phần nào

- Xác nhận tách `permission` (403) khỏi `auth` (401) trong `mapGraphErrorToResult`
  không gây regression cho luồng reconnect 401 hợp lệ (Case 6b vẫn xanh).
- Xác nhận chọn `FAILED_GRAPH_FETCH` (retryable, non-reconnect) là đúng tinh thần
  TASK-071 cho 403 ở email pipeline.
- Xác nhận không có đường nào khác trong pipeline còn map 403 → reconnect.
