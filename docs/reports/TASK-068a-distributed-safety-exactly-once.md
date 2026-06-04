# Report — TASK-068A Distributed Safety & Exactly-Once Guarantees

Ngày: 2026-06-04 · Tác giả: Claude Code

## 1. Vấn đề đã xử lý

Đóng hai backlog blocker concurrency từ TASK-064 trước khi cho phép test 100 mailboxes:

- **M1 — Dedup race (exactly-once).** `claimMessageForProcessing` trước đây là
  read-then-write và không bắt unique-constraint. Khi webhook + delta polling (hoặc
  nhiều worker replica) cùng thấy một `graphMessageId`, lần insert thứ hai ném lỗi →
  BullMQ retry nhiễu. Giờ một va chạm unique (Prisma P2002) được coi là **duplicate
  clean skip**.
- **Distributed mailbox lock.** Lock cũ chỉ in-memory (serialize trong một tiến trình).
  Thêm lock Redis-backed cross-process sau cùng interface, có TTL/lease, release
  compare-and-delete, fail-safe khi Redis lỗi. Production giữ in-memory cho tới khi
  inject Redis client → không đổi behavior hiện tại.
- **M2 — One-active Telegram mapping (TOCTOU).** Thêm partial unique index ở DB cho
  rule "mỗi mailbox tối đa một ACTIVE mapping"; service bắt P2002 → conflict thân thiện.

## 2. File đã thay đổi

### Sửa
| File | Thay đổi |
|---|---|
| `services/email/deduplication.service.ts` | Thêm `ProcessedMessageDuplicateError` + `isProcessedMessageDuplicateError`; `claimMessageForProcessing` bắt duplicate khi create → duplicate clean skip; in-memory store mô phỏng unique constraint. |
| `services/email/prisma-processed-message-store.ts` | `create` bắt P2002 → ném `ProcessedMessageDuplicateError`; lỗi khác propagate. |
| `services/queue/mailbox-processing-lock.ts` | Nới interface `MailboxProcessingLock`/`MailboxLockHandle` cho async; thêm `SyncMailboxProcessingLock` cho in-memory (giữ sync). |
| `services/email/graph-message-pipeline.service.ts` | `await` acquire/release để hỗ trợ cả lock async (Redis) lẫn sync (in-memory). |
| `services/telegram/telegram-mapping.service.ts` | Bọc create/update-from-destination với backstop P2002 → `TelegramDestinationMappingConflictError`. |
| `services/queue/workers/email-worker-runner.ts` | Tạo lock qua factory (mặc định in-memory; seam để bật Redis). |
| `prisma/schema.prisma` | Comment giải thích partial unique index sống ở migration raw. |

### Tạo mới
| File | Vai trò |
|---|---|
| `lib/db/prisma-error.ts` | Helper nhận diện P2002 + đọc `meta.target` (không import Prisma runtime). |
| `services/queue/redis-mailbox-lock.ts` | Lock Redis cross-process (SET NX PX + Lua compare-and-delete, fail-open). |
| `services/queue/mailbox-lock-factory.ts` | Chọn Redis-backed (khi có client) hoặc in-memory. |
| `prisma/migrations/20260604000000_task068a_one_active_telegram_mapping/migration.sql` | Partial unique index `(mailboxId) WHERE status='ACTIVE'`. |
| `docs/tasks/TASK-068a-...md`, `docs/reports/TASK-068a-...md` | Task + report. |

## 3. Test đã thêm

- `tests/unit/email/deduplication.exactly-once.test.ts` — hai luồng song song cùng
  `graphMessageId` chỉ claim một lần; va chạm khi create → duplicate clean skip; lỗi
  không-phải-duplicate vẫn propagate; in-memory store ném đúng error; Prisma store map
  P2002 → duplicate, lỗi khác propagate. Kết quả duplicate không chứa plaintext code.
- `tests/unit/queue/redis-mailbox-lock.test.ts` — acquire/refuse/release; mailbox khác
  không chặn nhau; tự hết hạn theo TTL; release compare-and-delete không xóa nhầm lease
  của holder mới; từ chối id rỗng; fail-open khi Redis lỗi; default TTL hợp lệ.
- `tests/unit/telegram/telegram-mapping.one-active-race.test.ts` — P2002 từ partial
  index → conflict trên `mailboxId`; P2002 từ unique (mailbox,chat) → conflict
  `destinationId`; happy path vẫn tạo được; lỗi khác propagate; backstop cả trên update.

Các suite hiện có (dedup, lock, pipeline throttling, telegram mapping, worker-runner)
vẫn pass — tương thích ngược.

## 4. Kiểm tra

- `npm run verify` → **PASS**: `db:generate`, `lint` (0 lỗi), `typecheck` (0 lỗi),
  `test` (**894 tests / 79 files passed**, 0 fail), `build` (OK, tất cả route biên dịch).
- Targeted: 103/103 pass cho nhóm dedup/lock/mapping/pipeline/worker-runner.

Ghi chú: các dòng `stderr` khi chạy test là log có chủ đích trong test (mailboxId giả,
`maskedCode: '82****'`, chat id giả) — chứng minh masking hoạt động, không phải lỗi.

## 5. An toàn (secret hygiene)

- Không đọc/in `.env*`. Không log token, refresh token, client secret, bot token, full
  verification code, full email body, database/Redis URL, encryption key.
- Lock Redis chỉ ghi `mailboxId` + token ngẫu nhiên vào Redis; log chỉ có `mailboxId`.
- Kết quả dedup không mang plaintext code (test khẳng định).
- Không sửa GitHub Actions / không nới lỏng secret-scan. Không động `.env*`.

## 6. Rủi ro còn lại

- **Partial unique index không nằm trong schema.prisma** (Prisma không biểu diễn được
  partial index) → một `prisma migrate dev` về sau có thể coi là drift. Đã ghi rõ trong
  migration + comment schema; production dùng `migrate deploy` nên không bị ảnh hưởng;
  `npm run verify` chỉ `db:generate` nên không áp migration.
- **Nếu tồn tại dữ liệu legacy** có hai ACTIVE mapping cho cùng mailbox (tạo trước guard
  TASK-067), việc tạo index sẽ fail lúc `migrate deploy` và cần dọn dữ liệu vận hành
  trước — cố ý fail loud thay vì im lặng.
- **Distributed lock chưa bật ở production**: factory mặc định in-memory; cần inject
  shared Redis client (qua `getRedisConnectionOptions`) để serialize cross-process khi
  chạy nhiều worker replica. ioredis chỉ là nested dep của bullmq nên client thật chưa
  được tự tạo trong task này (tránh đổi behavior production khi chưa kiểm chứng).
- **Exactly-once dựa trên unique constraint của ProcessedMessage**: đúng cho đường
  Graph (có `graphMessageId`) và các đường có internet message id / code+bucket
  (synthetic key). Lock chỉ là lớp giảm burst, không phải nguồn đảm bảo exactly-once.
- Chưa xác minh với mailbox Microsoft thật + Telegram group thật ở tải cao.

## 7. Vì sao là điều kiện trước khi test 100 mailboxes

Ở quy mô 100 mailboxes, webhook và delta polling chồng nhau thường xuyên, và việc tăng
worker/replica trở nên cần thiết. Khi đó, nếu dedup chưa exactly-once và one-active chưa
có DB-level guard, hệ thống có thể gửi trùng verification code hoặc tạo trạng thái
mapping mâu thuẫn. Task này đóng đúng hai cửa đó và mở sẵn phương án lock chia sẻ, nên là
tiền đề an toàn cho bước test 100 mailboxes và lộ trình mở rộng 300–500 sau này.

## 8. Cần Gemini review phần nào

1. Logic `claimMessageForProcessing` khi bắt duplicate: re-check rồi fallback
   `DUPLICATE_GRAPH_MESSAGE_ID` — có bỏ sót nhánh nào không.
2. Redis lock: ngữ nghĩa SET NX PX + Lua compare-and-delete; quyết định **fail-open**
   khi Redis lỗi (dựa vào unique constraint để giữ exactly-once) có chấp nhận được.
3. Partial unique index + cách map P2002 (`meta.target` chứa `active`) sang conflict
   field; tradeoff schema-drift của partial index.
4. Quyết định KHÔNG dùng interactive transaction cho one-active (lý do: ở READ COMMITTED,
   check+insert trong transaction vẫn race; unique index mới là điểm serialize thật).
