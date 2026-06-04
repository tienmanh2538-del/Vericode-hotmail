# Report — TASK-070 Redis-backed Global Telegram Bot Pacer

Ngày: 2026-06-05 · Tác giả: Claude Code

## 1. Mục tiêu đã làm

Nâng global Telegram bot pacer (TASK-068B) từ **in-memory / per-process** lên một
**Redis-backed cross-process** implementation, để nhiều worker-email replica chia sẻ
MỘT quota pacing toàn cục (Telegram giới hạn ~30 msg/giây ở mức bot). Giữ nguyên
interface `GlobalSendThrottle`, cap thời gian chờ, default pacing an toàn của TASK-068B;
fail-safe khi Redis không sẵn sàng; KHÔNG đổi routing / số lần gửi / exactly-once.

## 2. Đã thay đổi gì

1. **Redis-backed pacer mới** (`services/queue/redis-global-send-throttle.ts`).
   - `reserve()` chạy MỘT Lua script atomic trên một Redis key chung
     (`telegram-bot::global-pace`). Script mô phỏng đúng logic spacing của
     `destination-throttle` (now / interval / cap) nhưng server-side, nên nhiều
     process serialize trên cùng một slot thay vì mỗi process tự tính.
   - Giữ **cap** `maxWaitMs` (default 2s) + interval default 40ms (≤ ~25 send/giây),
     đúng hằng số TASK-068B (tái dùng `DEFAULT_GLOBAL_SEND_*`).
   - Key có TTL (tự nâng để luôn dài hơn điểm xa nhất từng schedule) → giữ sống
     trong burst, tự dọn khi bot rảnh (pacing reset về "gửi ngay").
   - **Fail-safe:** resolve client lỗi/timeout, hoặc eval lỗi → degrade về in-process
     in-memory pacer (vẫn giãn nhịp trong process), KHÔNG block delivery, KHÔNG throw.
     Client chỉ resolve một lần (ioredis tự reconnect) → không reconnect storm trên
     hot path; có `connectTimeoutMs` (default 2s) để không bao giờ treo path gửi.

2. **Factory chọn backend** (`services/queue/global-send-throttle-factory.ts`).
   `createGlobalSendThrottle({ getRedisClient })`: không có provider → in-memory
   (behavior cũ không đổi); có → Redis-backed. Mirror `mailbox-lock-factory` (TASK-068A).

3. **Interface cho phép async** (`services/queue/global-send-throttle.ts`).
   `GlobalSendThrottle.reserve()` giờ trả `DestinationReservation | Promise<…>`. Thêm
   `SyncGlobalSendThrottle` cho in-memory (vẫn đồng bộ) → mọi caller/test đồng bộ cũ
   không đổi.

4. **Pipeline await** (`services/email/graph-message-pipeline.service.ts`).
   `const { waitMs } = await deps.globalSendThrottle.reserve();` — no-op cho in-memory.

5. **Wiring production** (`services/queue/workers/email-worker-runner.ts`).
   Singleton pacer build qua factory: gate trên `REDIS_URL` (đọc raw, không qua
   `loadQueueEnv` vốn default localhost). Production có `REDIS_URL` → Redis-backed,
   tái dùng client ioredis của BullMQ (như TASK-068C — không thêm dependency, không mở
   socket lúc import, provider lazy). Local/test không có `REDIS_URL` → in-memory.
   Export `isRedisConfiguredForPacer` + `buildGlobalSendThrottle` để unit-test wiring.

## 3. File đã sửa / tạo

### Tạo mới
| File | Vai trò |
|---|---|
| `services/queue/redis-global-send-throttle.ts` | Redis-backed global pacer (Lua atomic + fail-safe). |
| `services/queue/global-send-throttle-factory.ts` | Chọn in-memory vs Redis backend. |
| `tests/unit/queue/redis-global-send-throttle.test.ts` | Test pacer Redis-backed. |
| `docs/tasks/TASK-070-redis-backed-global-telegram-bot-pacer.md` | Task spec. |
| `docs/reports/TASK-070-redis-backed-global-telegram-bot-pacer.md` | Report này. |

### Sửa
| File | Thay đổi |
|---|---|
| `services/queue/global-send-throttle.ts` | `reserve()` cho phép Promise; thêm `SyncGlobalSendThrottle`; in-memory trả type sync. |
| `services/email/graph-message-pipeline.service.ts` | `await` global pacer reserve. |
| `services/queue/workers/email-worker-runner.ts` | Wire factory + gate `REDIS_URL` + provider lazy reuse BullMQ client; export helper. |
| `tests/unit/queue/email-worker-runner.test.ts` | Test gate + wiring (Redis vs in-memory). |
| `docs/ROADMAP.md` | Mục TASK-070. |

## 4. Test đã thêm / cập nhật

`tests/unit/queue/redis-global-send-throttle.test.ts`:
- **Serialize cùng key:** hai pacer độc lập (mô phỏng hai process) dùng chung một fake
  Redis → các send xen kẽ vẫn cách nhau đúng một interval; chỉ dùng đúng một key chung.
- **Cap:** interval lớn → wait bị cap đúng `maxWaitMs`; reply Lua khổng lồ vẫn bị cap;
  reply phi số → clamp về 0.
- **Fail-safe + không lộ secret:** eval ném lỗi có nhúng connection string giả → reserve
  không throw, trả nhịp fallback, log KHÔNG chứa `redis://` / host / pass / error gốc;
  resolve client lỗi → fallback + log an toàn; provider treo → timeout rồi fallback
  (không block delivery).
- **Resolve một lần:** nhiều send chỉ resolve client một lần.

`tests/unit/queue/email-worker-runner.test.ts` (group mới "global send pacer wiring"):
- `isRedisConfiguredForPacer`: có/không/blank `REDIS_URL`.
- `buildGlobalSendThrottle(null)` → in-memory (reserve không gọi Redis).
- `buildGlobalSendThrottle(provider)` → Redis-backed (gọi `eval`, numKeys=1).

In-memory pacer cũ (`tests/unit/queue/global-send-throttle.test.ts`) và toàn bộ test
pipeline/throttle/metrics/scale-readiness cũ vẫn pass — tương thích ngược.

## 5. Lệnh đã chạy & kết quả

- `npm run verify` → **PASS**:
  - `db:generate` OK
  - `lint` (eslint) 0 lỗi
  - `typecheck` (tsc --noEmit) 0 lỗi
  - `test` (vitest) **1060 tests / 91 files passed, 0 fail** (TASK-069C: 1049 → +11)
  - `build` (next build) compiled OK
- Các dòng `stderr` khi chạy test là log có chủ đích (mailbox/chat id giả, mã đã mask),
  không phải lỗi.

## 6. An toàn (secret hygiene)

- Không đọc/in `.env*`. Không sửa `.env*`, GitHub Actions, hay package scripts.
- Không thêm env var mới (gate trên `REDIS_URL` đã có) → không phát sinh nợ tài liệu env.
- Pacer chỉ ghi/đọc một key hằng số + timestamp nguyên (epoch ms) trên Redis; không chạm
  verification code, email body, chat id, token, hay Redis URL.
- Log lỗi Redis chỉ là **message tĩnh + context rỗng**; không log error object (tránh
  connection string/password đi kèm). Có test khẳng định không lộ `redis://`/host/pass.
- Không log token, client secret, bot token, database/Redis URL, encryption key,
  session secret, full code, full email body.

## 7. Bất biến được giữ

- **Exactly-once (TASK-068A):** pacer chỉ giãn **thời điểm** gửi; không claim/dedup,
  không retry, không đổi số lần gửi. Test pipeline 2-job cùng `graphMessageId` cũ vẫn pass.
- **Routing / reusable destination:** mọi send vẫn tới đúng một chat từ mapping DB;
  không broadcast, không multi-destination; pacer chỉ thao tác một key hằng số.
- **Không chờ vô hạn:** cap `maxWaitMs` mỗi send; resolve client có timeout; eval lỗi →
  fallback ngay.
- **Không đổi behavior local/test:** không có `REDIS_URL` → vẫn in-memory như TASK-068B.

## 8. Rủi ro còn lại

- **Clock skew giữa replica.** Pacer truyền `now` của từng process vào Lua; slot
  (`nextAvailableAt`) là chung trên Redis nên serialization vẫn giữ, chỉ lệch nhẹ theo
  skew. Pacing là smoother xấp xỉ (không phải hard guarantee). Có thể chuyển sang
  `redis TIME` ở task sau nếu cần chính xác tuyệt đối.
- **Fail-safe degrade về per-process.** Khi Redis lỗi, pacing chỉ còn trong từng process
  (giống baseline TASK-068B) — an toàn cho delivery, nhưng tạm mất tính toàn cục cho tới
  khi Redis hồi phục (client ioredis tự reconnect cho các eval sau).
- **Chưa chạy tải thật.** Đây là cross-process pacer đã có test đơn vị + wiring; số nhịp
  thật cần xác minh trong controlled live beta / test-mailbox trial.
- **Default (40ms/slot, cap 2s, connect timeout 2s, TTL 10s)** là phỏng đoán thận trọng
  kế thừa TASK-068B; tinh chỉnh theo số liệu observability (TASK-068C) khi có tải thật.

## 9. Cần Gemini review phần nào

1. Lua `RESERVE_LUA`: tính atomic của reserve-next-slot và khẳng định nó tương đương
   logic in-memory (now / interval / cap) — có tạo race/double-send không (không, chỉ
   set `nextAvailableAt`, không đụng dedup/claim).
2. Fail-safe: resolve-once + timeout + cache `clientUnavailable` + eval-catch → có bao giờ
   block hoặc throw vào delivery path không; log có lộ Redis URL/secret không.
3. Wiring runner: gate `REDIS_URL`, provider lazy reuse client BullMQ (không mở socket
   lúc import, không thêm ioredis top-level) — đúng pattern TASK-068C chưa.
4. Interface change `reserve(): DestinationReservation | Promise<…>` + `SyncGlobalSendThrottle`:
   có giữ tương thích ngược cho mọi caller/test đồng bộ cũ không.
