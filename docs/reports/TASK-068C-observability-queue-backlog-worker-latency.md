# Report — TASK-068C: Observability for Queue Backlog, Worker Latency, Throttle/Defer Signals

Status: **DONE** — `npm run verify` PASS (944 tests; lint/typecheck/build sạch).
Gemini review: pending.

## 1. Bối cảnh & mục tiêu

TASK-068A đóng distributed safety/exactly-once, TASK-068B đóng scale-ready
throughput. Trước khi chạy validation ~100 mailboxes ở TASK-068D, hệ thống cần
nhìn thấy tối thiểu: queue backlog, worker latency/queue wait, và throttle/defer
đang xảy ra nhiều hay không. TASK-068C chỉ làm **observability read-only**, không
chạy validation thật, không đổi behavior đã chốt.

## 2. Thay đổi chính

### 2.1 Module observability mới (`services/observability/`)

| File | Vai trò |
|------|---------|
| `observability.types.ts` | Shape UI-safe: snapshots + aggregates + status enums (aggregate-only). |
| `worker-metrics.ts` | Recorder interface + no-op + Redis key/field schema + bucket helpers + aggregation + status classification (pure). |
| `redis-worker-metrics.ts` | Redis-backed writer (fire-and-forget, atomic incr/max bằng Lua) + reader, dùng client BullMQ sẵn có. |
| `queue-observability.service.ts` | Queue backlog snapshot từ BullMQ job counts + oldest age, có timeout, degrade UNKNOWN. |
| `infra-observability.service.ts` | Gộp queue + worker, **gate theo scope** (chỉ `all`), best-effort, không crash. |

### 2.2 Instrumentation

- `services/queue/workers/email-worker.ts`: đo `queueWaitMs` (`job.timestamp` →
  processing start) + `processingDurationMs`, ghi `recordJobResult` aggregate
  (best-effort). `createEmailWorker` inject production recorder.
- `services/email/graph-message-pipeline.service.ts`: thêm `metrics?` vào deps;
  ghi mailbox-busy defer, destination throttle wait, global pacing wait — mỗi
  call bọc `recordWorkerMetricSafely` nên metrics lỗi **không** phá delivery.
- `services/queue/workers/email-worker-runner.ts`: wire cùng một recorder vào
  pipeline deps (cross-process visibility qua Redis).

### 2.3 Health dashboard

- `health.types.ts`: thêm `infra: InfraObservability | null` vào dashboard data.
- `health.service.ts`: `loadHealthDashboard` nhận optional `loadInfra` loader
  (default null-loader → unit test DB không chạm Redis). Infra load bọc try/catch.
- `app/admin/health/page.tsx`: inject `loadInfraObservability`; render section
  "Queue & worker observability" read-only (không nút scale/retry/purge); hiển
  thị Unknown/Degraded rõ ràng khi không đọc được.

## 3. Cross-process metrics store

Worker và web là hai tiến trình khác nhau nên counter in-memory không nhìn thấy
nhau. Giải pháp: ghi aggregate vào Redis hash bucket TTL ngắn (5 phút/bucket,
giữ 60 phút) dùng client ioredis sẵn có của BullMQ queue (không thêm dependency
ioredis top-level — đúng pattern `redis-connection.ts`). `max` cập nhật atomic
bằng Lua nên nhiều worker ghi đồng thời vẫn hội tụ đúng. Reader cộng các bucket
trong cửa sổ 60 phút.

## 4. An toàn (security)

- Không đọc/in `.env*`; không hardcode secret; không log token/secret/bot token/
  database URL/Redis URL/encryption key/session secret/full code/full email body.
- Metrics chỉ gồm field opaque + số nguyên (count/ms). Queue snapshot không trả/
  log Redis URL (test khẳng định `JSON.stringify(snapshot)` không chứa `redis://`).
- Worker metrics input chỉ `{result, queueWaitMs, processingDurationMs}` (test
  khẳng định không có key payload/body/code/token).

## 5. Tests (28 mới)

1. `queue-observability.service.test.ts` — counts khi available; UNKNOWN khi
   lỗi (không throw); giữ counts khi oldest-age fail; không lộ Redis URL.
2. `worker-metrics.test.ts` — mutation builders/rounding; bucket keys;
   classifyWorkerStatus; round-trip writer↔reader qua fake Redis; recorder
   không throw khi client lỗi; idle window → UNKNOWN.
3. `infra-observability.service.test.ts` — STAFF (`assigned`) → null, không I/O;
   OWNER (`all`) → snapshot; worker read lỗi → UNKNOWN, không crash.
4. `email-worker.metrics.test.ts` — đo queueWait/processing đúng; chỉ key an
   toàn; deferred vẫn throw; null queueWait khi thiếu timestamp; classifier.
5. `graph-message-pipeline.metrics.test.ts` — defer/destination/global throttle
   ghi nhận aggregate; recorder throw vẫn gửi code.

## 6. Tiêu chí nghiệm thu

- [x] Task file `docs/tasks/TASK-068C-...md`, report này trong `docs/reports/`.
- [x] `/admin/health` có visibility queue backlog, worker latency, throttle/defer.
- [x] Metrics/log không chứa secret/token/full code/full email body.
- [x] Không đổi routing, exactly-once, dedup, active mapping rule, throughput default.
- [x] Không chạy validation 100 mailboxes thật.
- [x] Không sửa `.env*` / GitHub Actions.
- [x] `npm run verify` PASS.
- [ ] Gemini review PASS (pending).

## 7. Rủi ro / deferred

- **Production wiring của infra loader phụ thuộc page inject.** Default
  `loadHealthDashboard` dùng null-loader (để unit test DB không chạm Redis);
  trang `/admin/health` inject `loadInfraObservability`. Nếu thêm caller mới của
  dashboard cần infra thì phải inject loader tương tự.
- **Metrics là best-effort.** Redis lỗi → snapshot UNKNOWN/DEGRADED, không có số
  liệu; đây là chủ đích (không được làm crash/blocking).
- **Status thresholds là heuristic hiển thị** (backlog 50/200, queue wait
  30s/120s, oldest 5m/15m) — cần tinh chỉnh theo số liệu thật ở TASK-068D, không
  ảnh hưởng delivery.
- **Chưa có số liệu tải thật.** TASK-068D mới chạy validation ~100 mailboxes.

## 8. Bàn giao cho TASK-068D

- Đọc dashboard `/admin/health` mục "Queue & worker observability" để theo dõi
  backlog, queue wait/processing latency, mailbox-busy defer, destination/global
  throttle trong lúc validation.
- Cửa sổ worker metrics là 60 phút gần nhất (bucket 5 phút, TTL 60 phút) — số
  liệu sẽ trống nếu worker chưa chạy trong cửa sổ đó.
- Điều chỉnh threshold WARN/CRITICAL trong `worker-metrics.ts` /
  `queue-observability.service.ts` nếu thực tế cần, không đổi logic delivery.
