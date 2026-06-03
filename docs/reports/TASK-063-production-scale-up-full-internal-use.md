# TASK-063 — Production scale-up from beta to full internal use (report)

Status: **docs-only. No runtime code, migration, `.env*`, or CI workflow was
touched. No real secret, full verification code, or full email body is in the
diff.**

**Headline:** TASK-059 chuẩn bị production limited internal beta; TASK-060/061/062
thêm runbook, onboarding, và daily checklist. TASK-063 nối tiếp bằng **kế hoạch +
checklist scale-up theo từng giai đoạn** (Level 0 → 3), để OWNER/ADMIN biết khi
nào được tăng mailbox/staff/customer, theo dõi metric gì, và khi nào phải
**dừng / rollback** — mà **không** phá bất kỳ guardrail nào đã có.

## 1. Mục tiêu đã đạt

- Xác nhận task spec `docs/tasks/TASK-063-production-scale-up-full-internal-use.md`
  đã có sẵn trong working tree (untracked) và đầy đủ; **không sửa** file này.
- Tạo `docs/operations/PRODUCTION_SCALE_UP_CHECKLIST.md` — checklist vận hành
  scale-up theo từng giai đoạn cho người **không chuyên code**, bao phủ: nguyên
  tắc an toàn, các mức scale, điều kiện trước đợt, quy trình một đợt, điều kiện
  PASS lên mức tiếp theo, metric theo dõi, rollback criteria, bảo vệ các rule, và
  việc không làm.
- Tạo report này theo pattern `docs/reports/` của repo.
- Giữ đúng quan hệ tài liệu: checklist **dùng lại** daily checklist (TASK-062) và
  incident runbook (TASK-060), **không thay thế** chúng; tham chiếu onboarding
  guide (TASK-061) cho bước connect/mapping/test-send.

## 2. File đã thay đổi

- `docs/operations/PRODUCTION_SCALE_UP_CHECKLIST.md` (mới) — checklist scale-up.
- `docs/reports/TASK-063-production-scale-up-full-internal-use.md` (mới) — report
  này.
- `docs/tasks/TASK-063-production-scale-up-full-internal-use.md` — đã tồn tại sẵn
  trong working tree (untracked); là task spec nguồn. **Không sửa.**
- `docs/ROADMAP.md` — dự kiến thêm một dòng tóm tắt ngắn cho TASK-063 **sau khi**
  `npm run verify` PASS và Gemini review PASS (theo pattern các task trước).

Không sửa runtime code, không migration, không `.env*`, không GitHub Actions,
không database schema, không worker/concurrency/polling.

## 3. Bao phủ nội dung (đối chiếu scope task)

| Yêu cầu nội dung | Có trong artifact? |
|------------------|--------------------|
| Tình trạng hiện tại & mục tiêu TASK-063 | ✅ task spec §1–§2; report §intro |
| Các mức scale (beta → expanded → pilot → full) | ✅ checklist §2; task spec §7 |
| Điều kiện trước khi scale | ✅ checklist §3; task spec §8 |
| Metric cần theo dõi | ✅ checklist §6; task spec §9 |
| Dùng daily operations checklist TASK-062 | ✅ checklist §1/§4; task spec §10 |
| Dùng incident runbook TASK-060 | ✅ checklist §4.3/§7; task spec §11 |
| Bảo vệ one-mailbox-one-active-destination | ✅ checklist §8.1; task spec §12 |
| Bảo vệ reusable destinations dùng chung | ✅ checklist §8.2; task spec §13 |
| Bảo vệ STAFF_READ_ONLY scope | ✅ checklist §8.3; task spec §14 |
| Mailbox disconnected/unmapped/token issue | ✅ checklist §8.4; task spec §15 |
| Rollback criteria | ✅ checklist §7; task spec §16 |
| Việc không làm (login/signup/billing/multi-dest/broadcast) | ✅ checklist §10; task spec §4 |
| Tiêu chí PASS trước commit/push | ✅ task spec §21; report §6/§7 |

## 4. Tham chiếu UI / route (không bịa)

Checklist dùng đúng route/label đã có trong onboarding guide, daily checklist, và
health dashboard (TASK-056):

- Health `/admin/health`, Mailboxes `/admin/mailboxes`, Telegram `/admin/telegram`,
  Logs `/admin/logs`.
- Trạng thái readiness "Ready / Needs mapping / Needs customer / Disconnected /
  Error" khớp định nghĩa health dashboard.
- Các tín hiệu worker/queue/subscription/token mô tả **có điều kiện** ("nếu
  dashboard có hiển thị"), khớp ghi chú TASK-056 (một số tín hiệu có thể Unknown,
  không tự probe external).

## 5. Xác minh invariant không bị phá (chỉ thêm docs)

Task không sửa runtime code nên các invariant được giữ **by construction**.
Checklist chỉ **mô tả lại** cách vận hành an toàn khi tăng tải:

- RBAC OWNER/ADMIN xem toàn bộ vs STAFF_READ_ONLY chỉ phạm vi assign + scope ở
  service layer (TASK-045/056/057).
- Reusable destinations với rule mỗi mailbox tối đa một active destination
  (TASK-053), không broadcast.
- Disconnect guard (TASK-052): disconnected không poll/renew/relay.
- Throttling/queue safety (TASK-055) không bị đổi (không sửa code).
- Health dashboard (TASK-056) không bị đổi.
- Production auth fail-closed (TASK-057), env/secret setup (TASK-058), limited
  beta guardrails (TASK-059) không bị nới lỏng.
- Runbook TASK-060, onboarding TASK-061, daily checklist TASK-062: chỉ tham chiếu
  và dùng lại, **không thay thế**.

## 6. Kết quả kiểm tra

- `npm run verify`, `git branch --show-current`, `git status --short`,
  `git diff --stat`: kết quả ghi trong tin nhắn của Claude kèm log.
- Diff **không** chứa secret thật, full verification code, hay full email body.
- Khi nhắc thông tin nhạy cảm, chỉ dùng **tên loại** trong prose (token, client
  secret, bot token, encryption key, connection string…), không kèm giá trị.

## 7. Secret-scan false-positive risk

- Toàn bộ tài liệu tránh dòng ngắn dạng `keyword: value` cho các từ nhạy cảm.
  Khi cần nhắc, dùng câu prose hoặc bảng vai trò/trạng thái/metric.
- Không thêm placeholder giống token/key thật; không sửa env example nào.
- Không sửa GitHub Actions secret scan.
- Rủi ro false-positive: **thấp**. Cần Gemini xác nhận thêm.

## 8. ROADMAP

Theo pattern các task trước, dòng tóm tắt ngắn cho TASK-063 trong
`docs/ROADMAP.md` được thêm **sau khi** `npm run verify` PASS và Gemini review
PASS (hiện ROADMAP đã có dòng placeholder "TASK-063: Production scale-up from beta
to full internal use" ở cuối Sprint 15).

## 9. Còn lại / blocker / việc tiếp theo

- **Blocker kế thừa:** chưa có production sign-in provider thật (TASK-057/059) →
  staff-facing beta chưa usable qua admin UI; mọi mức scale giả định môi trường
  production đã sẵn sàng khi thực sự chạy.
- Đây là **planning/checklist task**: chưa thực hiện full rollout, chưa onboarding
  mailbox thật hàng loạt, chưa chạy thử qua chu kỳ scale thật với email/Telegram
  thật.
- Việc đổi tham số tải (worker concurrency / polling / queue) nếu cần khi scale
  thật phải mở **task riêng**, không nằm trong TASK-063.

## 10. Phần cần Gemini review kỹ

- Xác nhận checklist đúng mức "scale-up theo từng giai đoạn", **không** thay thế
  daily checklist (TASK-062) hay incident runbook (TASK-060), và tham chiếu đúng
  onboarding guide (TASK-061).
- Xác nhận các mức scale, điều kiện PASS, metric, và rollback criteria nhất quán
  với task spec TASK-063.
- Xác nhận giữ đúng rule: nhiều mailbox dùng chung reusable destination, mỗi
  mailbox một active destination, không broadcast, disconnected/unmapped → không
  Ready, STAFF_READ_ONLY scope.
- Xác nhận không có secret thật, full verification code, hay full email body;
  không có wording dễ gây secret-scan false positive.
- Kết luận PASS/FAIL theo `GEMINI.md`.
