# TASK-079 — Relay Silence Incident Diagnosis (investigation-only)

> **Trạng thái: COMPLETED — ROOT CAUSE CONFIRMED** (đã có runtime evidence do human
> operator xác nhận + recovery thành công). Xem `docs/reports/TASK-079-…md` mục 0A.
>
> **Loại task:** ĐIỀU TRA (diagnosis-only). KHÔNG sửa runtime code, KHÔNG sửa
> deployment config, KHÔNG restart production, KHÔNG chạy worker local trỏ
> production/staging, KHÔNG thao tác production DB, KHÔNG đọc/in `.env*` hay bất
> kỳ secret nào. Nếu phát hiện bug rõ ràng: chỉ **mô tả** minimal fix cho một task
> sau, KHÔNG fix trong TASK-079.

## 0. Kết luận cuối cùng (ROOT CAUSE CONFIRMED)

**Root cause vận hành trực tiếp:** **delta polling runner bị stuck trong một cycle.**
Tiến trình `worker-delta` vẫn *sống* (process active) nhưng một cycle poll không bao
giờ kết thúc → scheduler coi "previous tick still running" và **skip mọi tick sau**
(log lặp `Delta polling skipping tick - previous tick still running`). Polling ngừng
enqueue fleet-wide từ ~cuối tháng 7. **Restart RIÊNG `worker-delta`** (không đổi
variables) giải phóng state stuck → delta poll trở lại → Graph jobs enqueue trở lại →
`worker-email` xử lý trở lại → Telegram nhận verification messages trở lại.

- **KHÔNG** phải regression TASK-078 (RBAC). **KHÔNG** phải detector/extractor.
  **KHÔNG** phải Telegram routing. **`worker-email` KHÔNG phải root cause chính**
  (nó vẫn tiêu thụ được job khi có job). **Redis queue mismatch KHÔNG được runtime
  evidence hỗ trợ** (đã kiểm tra: cấu hình đồng nhất; recovery không cần đổi variable).
- Recovery đã chứng minh producer path **delta → queue → worker-email → Telegram**
  hoạt động trở lại end-to-end.

Cơ chế code (đã đọc, không sửa): trong `startDeltaPollingScheduler`
(`services/queue/workers/delta-polling-runner.ts`), biến `inflight` chỉ được clear
trong `finally`. Nếu `runDeltaPollingOnce` không bao giờ resolve — do một HTTP request
tới Graph/token endpoint treo (native `fetch` **không có timeout/AbortController**) —
thì `inflight` giữ non-null vĩnh viễn và scheduler tự khoá. Đây là **finding cần fix ở
TASK-080**, KHÔNG sửa trong TASK-079.

**Finding follow-up (không sửa trong task này):** sau recovery, queue backlog lớn và
Telegram nhận cả một số **message cũ** từ thời gian downtime → rủi ro **stale
verification message** vẫn được relay.

## 1. Hiện tượng (do người vận hành báo)

- ~3 tuần gần đây **không có verification code nào** được relay tới Telegram.
- Nhiều mailbox cũ vẫn hiển thị **connected**.
- Mailbox Hotmail/Outlook **mới connect** cũng không nhận được code.
- Trang **Code Event Logs** không ghi nhận sự kiện mới.
- Hệ thống không được theo dõi khoảng một tháng.

Ràng buộc chẩn đoán từ người vận hành:
- KHÔNG giả định mailbox/token là nguyên nhân.
- KHÔNG đề xuất reconnect hàng loạt mailbox.

## 2. Mục tiêu

1. Trace toàn bộ production path và xác định **ở đâu** dòng chảy đứt.
2. Đưa ra danh sách giả thuyết root-cause có xếp hạng confidence + cách xác minh.
3. Soạn checklist Railway cụ thể để người vận hành tự kiểm tra runtime (không cần
   paste secret).
4. KHÔNG thay đổi hệ thống trong task này.

## 3. Phạm vi điều tra (đọc-only)

Production path chính:

```
Microsoft Graph → webhook /api/webhooks/microsoft/mail → enqueue (BullMQ/Redis)
  → email worker (consumer) → Graph message fetch → detector → extractor
  → dedup → Telegram mapping → Telegram sender → CodeEvent/ProcessedMessage/Audit
```

Backup path:

```
delta polling worker → Graph delta → enqueue → email worker (cùng queue)
```

Subscription path:

```
subscription renewal worker → Graph subscription renewal (PATCH)
```

Các khu vực soát: worker wiring, webhook, delta polling, Microsoft auth/Graph,
detector/extractor, Telegram/routing, git history quanh thời điểm im lặng.

## 4. Tiêu chí hoàn thành (acceptance)

- [x] Có `docs/reports/TASK-079-relay-silence-incident-diagnosis.md` chứa: bảng
      candidate root cause (evidence for/against/confidence/cách xác minh),
      primary + secondary hypothesis, giả thuyết đã loại trừ.
- [x] Có checklist Railway per-service (web, worker-email, worker-delta,
      worker-renewal, PostgreSQL, Redis) cho người vận hành.
- [x] Báo cáo chỉ chứa dữ liệu đã sanitize (không secret/URL/token/code/full body).
- [x] `npm run verify` được chạy và ghi lại kết quả.
- [x] KHÔNG commit, KHÔNG push, KHÔNG sửa runtime.

## 4b. Remaining findings / handoff (KHÔNG sửa trong TASK-079)

1. **Delta polling cần timeout/self-recovery:** một cycle không được phép block
   scheduler vô hạn (thêm timeout/AbortController cho Graph/token fetch, hoặc
   watchdog reset `inflight` sau ngưỡng, hoặc thay guard skip bằng cơ chế phát hiện
   stuck). → **TASK-080**.
2. **Stale message protection:** sau downtime dài, backlog có thể chứa message cũ;
   hiện có rủi ro relay verification message đã hết hạn (drop/skip theo tuổi message).
   → **TASK-080** (gộp cùng stuck-cycle recovery).
3. **Graph subscription wiring (finding kiến trúc riêng):** production path chưa có
   đường tạo Graph subscription thực tế cho mailbox mới; subscription renewal không có
   candidate. → **task riêng sau TASK-080**, không sửa ở đây.

## 5. Không làm trong task này

- Không sửa/khởi động/​restart worker hay service.
- Không tạo/xoá/gia hạn Graph subscription.
- Không đổi env, schema, migration, threshold detector, config delta/renewal.
- Không reconnect mailbox, không đụng DB.
- Mọi fix (nếu có) được mô tả dưới dạng đề xuất task kế tiếp trong report.
