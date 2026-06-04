# TASK-068A — Distributed Safety & Exactly-Once Guarantees

> Scale-readiness, bước 1. Đóng các blocker concurrency trước khi test 100 mailboxes.
> Nguồn gốc: backlog M1 (dedup race) và M2 (one-active TOCTOU) trong
> `docs/reports/TASK-064-final-technical-audit-phase-1.md`.

## 1. Mục tiêu

Trước khi nghĩ tới việc kết nối ~100 mailboxes (rồi tương lai 300–500), hệ thống phải
an toàn khi NHIỀU luồng cùng chạm vào một message hoặc một mailbox:

1. **Dedup exactly-once** — webhook và delta polling (hoặc nhiều worker replica) có thể
   cùng thấy một `graphMessageId`. Chỉ được claim/relay đúng một lần.
2. **Mailbox processing lock** — có phương án lock chia sẻ qua Redis (không chỉ
   in-memory) để nhiều tiến trình worker không cùng xử lý một mailbox song song.
3. **One-active Telegram mapping** — rule "mỗi mailbox tối đa một active destination"
   phải chống được race khi tạo/cập nhật gần đồng thời.

## 2. Business rules giữ nguyên (không đổi)

- App là internal staff app, không public SaaS. Khách hàng không login.
- Nhiều mailbox có thể dùng chung một reusable Telegram destination.
- Mỗi mailbox chỉ có tối đa một active destination.
- Mailbox DISABLED hoặc chưa mapping hợp lệ không được relay code.
- Không multi-destination / không broadcast. Không đổi routing.

## 3. Phạm vi được làm

### 3.1 Dedup exactly-once
- `claimMessageForProcessing`: nếu store reject insert vì unique-constraint
  (Prisma P2002) thì coi như **duplicate clean skip**, không ném lỗi để worker retry
  nhiễu.
- Prisma store map P2002 → `ProcessedMessageDuplicateError`; in-memory store mô phỏng
  cùng ràng buộc để test được race.
- Không lưu raw verification code, không log full code / full email body.

### 3.2 Distributed mailbox lock
- Giữ in-memory lock cho local/test và baseline single-worker hiện tại.
- Thêm lock Redis-backed (cross-process) sau cùng interface `MailboxProcessingLock`:
  acquire = `SET key token PX ttl NX`; release = Lua compare-and-delete (chỉ xóa nếu
  còn đúng token của mình).
- Lease có TTL → worker crash không kẹt mailbox vĩnh viễn.
- Fail-safe: Redis lỗi → acquire trả handle no-op (job vẫn chạy). Exactly-once vẫn được
  bảo đảm bởi unique-constraint của ProcessedMessage, không phụ thuộc lock.
- Production behavior không đổi khi chưa wire Redis client (factory mặc định in-memory).

### 3.3 One-active Telegram mapping
- Thêm DB-level protection: PARTIAL unique index trên `(mailboxId)` WHERE
  `status = 'ACTIVE'` (migration raw — Prisma schema không biểu diễn được partial
  index). DISABLED mapping không bị ràng buộc → không phá reusable destination dùng
  chung.
- Service bắt P2002 từ index này → trả conflict thân thiện thay vì 500.

## 4. Ngoài scope (không làm)
- Không sửa UI throughput / health dashboard.
- Không lấn TASK-068B / TASK-068C.
- Không retire legacy `createTelegramMapping`/`updateTelegramMapping` primitives
  (để task dọn dẹp riêng — đã ghi nhận từ TASK-065).
- Không tự mở socket Redis production (ioredis chỉ là nested dep của bullmq); việc wire
  client thật để bật distributed lock là một thay đổi inject có chủ đích sau này.

## 5. Tiêu chí nghiệm thu
- `npm run verify` PASS (lint + typecheck + test + build).
- Test chứng minh: hai luồng cùng `graphMessageId` chỉ claim một lần; lock Redis
  acquire/release/TTL/fail-safe; không thể tạo hai ACTIVE mapping cho cùng mailbox kể
  cả khi race.
- Không log/lưu token, refresh token, client secret, bot token, full verification code,
  full email body. Không động `.env*` / GitHub Actions.

## 6. Vì sao là điều kiện trước khi test 100 mailboxes
Ở 100 mailboxes, webhook + delta polling chạy song song thường xuyên hơn, và việc tăng
worker (hoặc replica) trở nên hấp dẫn. Nếu chưa đóng M1/M2, rủi ro là gửi trùng code
hoặc tạo trạng thái mapping mâu thuẫn — đúng những thứ phải loại bỏ trước khi cho phép
tải thật tăng lên.
