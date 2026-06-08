# TASK-075 — Report: Delta persistent 403 backoff/alert

## 1. Đã làm gì

Đóng finding **Medium** của TASK-072: delta polling khi gặp Graph 403 mức
account/endpoint lặp lại (sau self-heal cursor TASK-071 vẫn 403 mỗi cycle) trước đây retry
full-speed vô hạn, không backoff, không alert. TASK-075 thêm persistent backoff/cooldown
theo mailbox (lưu DB, sống qua restart), skip mailbox khi đang cooldown, alert an toàn cho
OWNER/ADMIN khi 403 vượt ngưỡng, và clear state khi poll thành công (gộp luôn finding
"stale error metadata sau self-heal" — audit gọi TASK-080).

**Kết quả chính:**
1. **Self-heal TASK-071 được giữ:** 403 có cursor → reset cursor (bootstrap lại cycle sau);
   403 lúc bootstrap (cursor null) → không reset, chỉ retry.
2. **403 không reconnect:** 403 account/endpoint-level lặp lại **không** flip mailbox sang
   `RECONNECT_REQUIRED`. Chỉ 401/auth mới reconnect (giữ nguyên).
3. **Persistent backoff:** mỗi 403 liên tiếp tăng `deltaForbiddenCount`. Tại/quá ngưỡng
   (mặc định 3) đặt cooldown luỹ thừa có cap (5 phút × 2^(count−threshold), tối đa 60 phút),
   lưu `deltaForbiddenCooldownUntil`. Mailbox đang cooldown bị **skip hoàn toàn** ở cycle kế
   (không fetch token, không gọi Graph), không tính failure → không phá cycle.
4. **Alert an toàn:** khi vào cooldown, raise một alert WARNING qua kênh admin (TASK-035)
   chỉ với trường đã mask (mailbox id, email đã mask, số lần forbidden, mốc hết cooldown,
   diagnostics enum-code). Best-effort: lỗi alert không bao giờ throw vào poll cycle, không
   đệ quy alert.
5. **Clear-on-success:** poll thành công sau streak → reset count + cooldown + clear stale
   `deltaLastErrorAt`/`deltaLastErrorMessage`.
6. **Bất biến giữ nguyên:** delta polling backup, refresh-token classification (TASK-069C),
   email pipeline 403 (TASK-074), dedup exactly-once, routing/reusable destinations.

## 2. File đã thay đổi

| File | Thay đổi |
|------|----------|
| `prisma/schema.prisma` | Thêm `deltaForbiddenCount Int @default(0)`, `deltaForbiddenCooldownUntil DateTime?` vào `Mailbox`. |
| `prisma/migrations/20260608000000_task075_delta_forbidden_backoff/migration.sql` | Migration `ALTER TABLE "Mailbox" ADD COLUMN` cho 2 cột trên (default an toàn). |
| `services/microsoft/delta-polling.service.ts` | Cooldown skip trước token fetch; `handlePersistentForbidden` (self-heal + count + cooldown + alert); clear-on-success; alert port + repo methods mới; result thêm `cooldownSkippedMailboxCount`; helper `forbiddenBackoffMs`. |
| `services/queue/workers/delta-polling-runner.ts` | Prisma repo: select 2 cột mới + `recordForbiddenBackoff`/`clearForbiddenBackoff`; `adminAlertDeltaPollingAlertPort` qua `sendAdminAlert`; wire alert vào deps; cập nhật scheduler fallback result. |
| `tests/unit/microsoft/delta-polling.service.test.ts` | Fake repo + alert + threshold; cập nhật 3 assert TASK-071 (403 nay ghi qua forbidden-backoff path); thêm describe TASK-075 (7 test). |
| `docs/tasks/TASK-075-...md`, `docs/reports/TASK-075-...md` | Task + report. |

## 3. Logic đã thay đổi

- **Vòng lặp per-mailbox:** thêm bước đầu — nếu `deltaForbiddenCooldownUntil > now` thì skip
  mailbox (đếm `cooldownSkippedMailboxCount`, không token, không Graph, không failure).
- **Nhánh catch 403 (`forbidden`):** thay vì chỉ `resetDeltaCursor` + `recordDeltaError`,
  giờ gọi `handlePersistentForbidden`: (a) reset cursor nếu có (self-heal); (b) tăng count;
  (c) đặt cooldown nếu count ≥ threshold; (d) `recordForbiddenBackoff` (ghi count+cooldown+
  error metadata một lần); (e) alert nếu vào cooldown.
- **Nhánh success:** nếu mailbox từng có forbidden state → `clearForbiddenBackoff`.
- **Nhánh 401 (`auth`):** không đổi — reconnect + record error.

## 4. Test đã thêm/điều chỉnh

Describe mới `runDeltaPollingOnce — persistent 403 backoff (TASK-075)`:
- Escalate sang cooldown khi vượt ngưỡng, không reconnect.
- Skip mailbox đang cooldown (không Graph/token, không failure).
- Poll lại bình thường khi cooldown đã hết.
- Alert an toàn khi vượt ngưỡng — assert không lộ access token/full Graph message/UPN/email thô.
- Không alert khi dưới ngưỡng.
- Clear backoff state sau poll thành công.
- `forbiddenBackoffMs` luỹ thừa + cap.

Điều chỉnh 3 test TASK-071 hiện có để assert trên forbidden-backoff record (vì 403 nay đi
đường ghi chuyên biệt) + thêm assert 401 không tạo forbidden-backoff.

## 5. Kết quả kiểm tra

- Unit delta polling: **24 passed**.
- `npm run verify`: xem mục cập nhật cuối (chạy db:generate + lint + typecheck + test + build).

## 6. Bảo mật

- Không log/ghi access token, refresh token, client secret, bot token, DB/Redis URL,
  encryption key, session secret, full verification code, full email body, hay raw Graph
  error message/body.
- Diagnostics chỉ enum-code + request-id (`code=… inner=… reqId=…`); email luôn mask.
- Test khẳng định alert payload không chứa token mẫu/Graph message thô/UPN/email thô.
- Docs/report không chứa secret thật, không dòng `keyword nhạy cảm: value`.

## 7. Rủi ro còn lại

- **Synthetic** — chưa xác minh live Microsoft Graph thật; `error.code` mức tài khoản thật
  sẽ xuất hiện ở `deltaLastErrorMessage`/alert ở lần fail kế tiếp nhờ logging mới.
- Backoff dựa trên state DB đọc mỗi cycle nên đa-replica nhất quán qua DB; số nhịp/ngưỡng
  thật cần quan sát ở controlled live beta (có thể tinh chỉnh hằng số sau).
- Lỗi giải mã credential vẫn xếp reconnect (đồng nhất TASK-069C) — ngoài phạm vi 403.
- Migration thêm cột → lưu ý schema drift nếu dùng `prisma migrate dev` (production dùng
  `migrate deploy`).

## 8. Cần Gemini review phần nào

- Chính sách backoff/cap và ngưỡng có hợp lý cho live beta không (5 phút → 60 phút, ngưỡng 3).
- Xác nhận 403 tuyệt đối không còn đường nào flip mailbox sang `RECONNECT_REQUIRED`.
- Xác nhận alert payload + log không lộ secret/PII và alert không thể thành storm.
- Xác nhận clear-on-success không vô tình xóa state cần giữ và không phá dedup/routing.

## 9. Task tiếp theo đề xuất

- **TASK-076** — bắt buộc `scope` (không optional) ở mọi caller mapping/destination + test
  cross-customer (finding Medium RBAC-scope của TASK-072), hoặc task kế tiếp theo thứ tự
  ROADMAP hiện hành.
