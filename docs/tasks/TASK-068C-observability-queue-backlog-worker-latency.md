# TASK-068C — Observability for Queue Backlog, Worker Latency, Throttle/Defer Signals

## Mục tiêu

Thêm observability tối thiểu, **read-only** cho queue và worker để OWNER/ADMIN
đánh giá hệ thống đã sẵn sàng bước sang TASK-068D (validation ~100 mailboxes) hay
chưa. Không chạy validation thật; không đổi routing / exactly-once / throughput
đã chốt ở TASK-068A/068B.

## Phạm vi đã làm

1. **Queue backlog snapshot** — `services/observability/queue-observability.service.ts`
   - Đọc BullMQ job counts (waiting/active/delayed/failed/completed), backlog
     total, oldest waiting/delayed age, status OK/WARN/CRITICAL/UNKNOWN.
   - Có timeout; Redis/BullMQ lỗi → UNKNOWN, **không throw**, không in Redis URL.

2. **Worker latency instrumentation** — `services/queue/workers/email-worker.ts`
   - Đo `queueWaitMs` (từ `job.timestamp`) và `processingDurationMs`.
   - Ghi metrics aggregate khi job completed/failed/skipped/deferred. Chỉ ghi
     `{result, queueWaitMs, processingDurationMs}` — không payload/email/code/token.

3. **Throttle/defer signals** — `services/email/graph-message-pipeline.service.ts`
   - Ghi aggregate: mailbox-busy defer, destination throttle wait, global
     Telegram pacing wait. Best-effort; metrics lỗi không làm fail delivery.

4. **Cross-process store** — `services/observability/worker-metrics.ts` +
   `redis-worker-metrics.ts`
   - Worker (tiến trình riêng) ghi counter vào Redis hash bucket TTL ngắn
     (5 phút/bucket, giữ 60 phút) qua client BullMQ sẵn có; web/health đọc lại.
     Aggregate-only (count/sum/max → avg). `max` cập nhật atomic bằng Lua.

5. **Health dashboard visibility** — `services/observability/infra-observability.service.ts`,
   `services/health/health.service.ts`, `app/admin/health/page.tsx`
   - OWNER/ADMIN (`scope.kind === 'all'`) thấy queue + worker snapshot. STAFF
     (`assigned`) nhận `null` (không lấy được global infra theo scope customer).
   - UI read-only, không có nút scale/retry/purge. Unknown/Degraded hiển thị rõ.
   - Loader best-effort + timeout → page không crash khi metrics unavailable.

## Bảo mật

- Không đọc/in `.env*`, không hardcode secret.
- Không log/ghi token, refresh token, client secret, bot token, database/Redis
  URL, encryption key, session secret, full code, full email body.
- Metrics chỉ là field opaque + số nguyên (count/ms). Log dùng logger an toàn.

## Ngoài scope

- Không autoscaling, không alerting/notification tự động.
- Không chạy/seed validation 100 mailboxes thật, không mailbox/Telegram/code thật.
- Không đổi routing/exactly-once/dedup/active-mapping rule, không đổi throughput
  default TASK-068B (chỉ đọc nếu cần hiển thị).
- Không sửa `.env*`, GitHub Actions; không tạo DB migration.

## Tests

- `tests/unit/observability/queue-observability.service.test.ts`
- `tests/unit/observability/worker-metrics.test.ts`
- `tests/unit/observability/infra-observability.service.test.ts`
- `tests/unit/queue/email-worker.metrics.test.ts`
- `tests/unit/email/graph-message-pipeline.metrics.test.ts`

## Kết quả

- `npm run verify` PASS (944 tests; lint/typecheck/build sạch).
- Báo cáo: `docs/reports/TASK-068C-observability-queue-backlog-worker-latency.md`.
