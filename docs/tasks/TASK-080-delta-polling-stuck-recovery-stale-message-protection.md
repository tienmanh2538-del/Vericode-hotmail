# TASK-080 — Delta Polling Stuck Recovery & Stale Message Relay Protection

> **Loại task:** fix runtime có kiểm soát (2 mục tiêu nhỏ, hẹp). Reviewer độc lập sau
> Claude là **Antigravity CLI**. **Không commit, không push.** Không đọc/in `.env*`.
> Không thao tác production DB/queue. Không gọi Microsoft Graph thật / gửi Telegram thật.

## 1. Bối cảnh (từ TASK-079)

TASK-079 đã xác nhận bằng runtime evidence + recovery:

- `worker-delta` vẫn **process active** nhưng một polling cycle **bị stuck**; các tick sau
  bị skip liên tục (`Delta polling skipping tick - previous tick still running`).
- Restart riêng `worker-delta` giải phóng stuck → polling + enqueue + email worker +
  Telegram hoạt động lại.
- **Cơ chế code:** `startDeltaPollingScheduler` chỉ clear cờ `inflight` trong `finally`;
  `runDeltaPollingOnce` gọi Microsoft qua native `fetch` **không có timeout/AbortController**
  ⇒ một request treo khoá scheduler vô hạn.
- Sau recovery: backlog lớn + một số **verification message cũ** bị relay ⇒ cần bảo vệ
  stale message.

`worker-email` không phải root cause; Redis mismatch bị loại; TASK-078/detector/routing
không phải nguyên nhân.

## 2. Mục tiêu

### A. Delta polling stuck-cycle recovery
Một Microsoft operation bị treo **không bao giờ** được phép khoá delta scheduler vô hạn.
Thêm finite timeout + **cancellation thật (AbortController)** tại seam HTTP hẹp nhất trên
delta path để underlying request **settle/reject thật sự**, cycle luôn kết thúc, tick sau
chạy lại được. Giữ nguyên non-overlap guard hiện có.

### B. Stale verification message relay protection
Sau downtime/recovery, verification email **quá cũ** không được gửi Telegram. Nguồn thời
gian là **Microsoft `receivedDateTime`** (KHÔNG dùng enqueue/job/processing time). Ngưỡng
tuổi tối đa: **30 phút** (single source-of-truth constant, không qua `.env`).

## 3. Scope ĐƯỢC làm

- Thêm helper timeout dùng `AbortController` cho fetch Microsoft trên delta path.
- Áp timeout cho: Graph delta request và token-refresh request **trên delta path**.
- Phân loại timeout là **controlled transient** (không giả 403, không tăng persistent-403
  counter, không flip `RECONNECT_REQUIRED`).
- Thêm stale guard trong graph message pipeline (áp cho cả webhook-origin lẫn delta-origin
  vì cùng pipeline), reuse cơ chế CodeEvent/skip hiện có.
- Thêm status skip mới (reuse hạ tầng CodeEvent hiện có — cột `status` là `String`, **không
  cần migration**).
- Thêm focused unit/regression tests deterministic (fake timers / fake fetch / DI).

## 4. Scope KHÔNG làm

- Graph subscription creation/reconciliation/onboarding wiring (finding TASK-079 để **task
  riêng** sau TASK-080).
- OAuth redesign; Telegram routing; reusable destination behavior; RBAC/customer scope;
  detector/extractor threshold; queue purge; production DB cleanup; multi-destination;
  broadcast; health dashboard redesign; observability redesign; unrelated refactor.
- Sửa `.env`/`.env.local`/`.env.staging`/`.env.production`; GitHub Actions; CI secret-scan.
- Thêm biến `.env` cho timeout hoặc cho stale threshold.
- Thêm schema/migration (nếu phát hiện bắt buộc → DỪNG và báo, không tự mở scope).

## 5. Security requirements

- Không đọc/in/sửa `.env*`. Không hardcode/log token/refresh token/client secret/bot
  token/DB-Redis URL/encryption-session secret/full verification code/full email body.
- Stale guard **không extract/log code** để quyết định stale.
- Dùng logger/sanitization hiện có; không interpolate dữ liệu nhạy cảm vào message string.
- Không đưa secret-like sample values vào task/report/test fixtures.

## 6. Acceptance criteria

- [ ] Delta path: mọi HTTP request Microsoft có finite timeout + cancellation thật.
- [ ] Timeout khiến request cũ settle/reject, `inflight` release đúng, tick sau chạy lại.
- [ ] Không có immediate/unbounded retry loop; non-overlap guard giữ nguyên.
- [ ] Timeout không bị phân loại thành 403; không tăng persistent-403; không flip reconnect.
- [ ] Real Graph 403 giữ nguyên semantics TASK-071/TASK-075; real 401/auth giữ hiện hành.
- [ ] Stale guard: message có `receivedDateTime` > 30 phút bị skip, **không** gọi Telegram.
- [ ] Freshness tính theo source timestamp; email cũ vừa enqueue hôm nay vẫn stale.
- [ ] `receivedDateTime` thiếu/invalid: **không** fallback enqueue time; behavior fail-safe
      rõ ràng + có test.
- [ ] Stale là terminal skip (không throw/retry như worker failure); dedup/exactly-once
      không bị phá.
- [ ] `npm run verify` PASS (lint + typecheck + test + build).

## 7. Test cases (tối thiểu)

Delta timeout/recovery: normal request hoàn thành; hanging Graph delta bị timeout hữu hạn;
hanging token bị timeout hữu hạn; scheduler không start cycle 2 khi cycle 1 còn active;
sau timeout+cleanup tick sau chạy được; không còn permanent "previous tick still running";
timeout không thành 403; timeout không kích hoạt persistent-403; real-403 tests cũ vẫn pass;
không unbounded retry.

Stale guard: fresh dưới ngưỡng xử lý bình thường; đúng ngưỡng vẫn fresh; trên ngưỡng stale
skip; Telegram sender KHÔNG được gọi khi stale; old `receivedDateTime` + job mới vẫn stale;
freshness dùng source timestamp; stale không throw/retry; duplicate/exactly-once cũ vẫn pass;
webhook + delta origin đều bị guard; missing/invalid source timestamp không fallback enqueue;
logs/status an toàn không chứa full code/full email body.

## 8. Lệnh verification

```bash
npm run verify
git status --short
git diff --stat
git diff
```

## 9. Không commit / không push

Không cập nhật `docs/ROADMAP.md` sang "TASK-080 completed" ở bước này — ROADMAP chỉ cập nhật
sau khi qua Antigravity review.
