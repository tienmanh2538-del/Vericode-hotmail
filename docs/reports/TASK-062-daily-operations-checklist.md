# TASK-062 — Daily operations checklist (report)

Status: **docs-only. No runtime code, migration, `.env*`, or CI workflow was
touched. No real secret, full verification code, or full email body is in the
diff.**

**Headline:** TASK-061 added a one-time staff onboarding guide. TASK-062 adds the
**recurring daily check** layer on top: a short, human-readable routine for
OWNER/ADMIN and STAFF_READ_ONLY to catch not-Ready mailboxes, Telegram send
failures, and other anomalies early — and to escalate correctly instead of
self-fixing serious incidents (which stay in the TASK-060 runbook).

## 1. Mục tiêu đã đạt

- Tạo `docs/operations/DAILY_OPERATIONS_CHECKLIST.md` — checklist vận hành hằng
  ngày cho người **không chuyên code**, bao phủ: vòng kiểm tra đầu ngày, health
  dashboard, mailbox readiness, disconnected mailbox, unmapped mailbox, Telegram
  send failure, logs cơ bản, worker/queue/subscription/token signals (chỉ khi
  dashboard có hiển thị), và escalation.
- Phân biệt rõ **phạm vi theo vai trò**: OWNER/ADMIN xem toàn hệ thống;
  STAFF_READ_ONLY chỉ phạm vi customer/mailbox được assign, chủ yếu phát hiện và
  báo cáo.
- Phân biệt rõ tài liệu này với onboarding guide (TASK-061) và incident runbook
  (TASK-060) bằng một bảng "dùng tài liệu nào", và không lấn sang scale-up
  (TASK-063).
- Giữ đúng các invariant: internal staff app (không customer login/signup/
  billing), nhiều mailbox dùng chung reusable destination nhưng mỗi mailbox chỉ
  một active destination, không broadcast, mailbox disconnected/chưa mapping →
  không Ready.
- Tạo report này theo pattern `docs/reports/` của repo.

## 2. File đã thay đổi

- `docs/operations/DAILY_OPERATIONS_CHECKLIST.md` (mới) — checklist chính.
- `docs/reports/TASK-062-daily-operations-checklist.md` (mới) — report này.
- `docs/tasks/TASK-062-daily-operations-checklist.md` — đã tồn tại sẵn trong
  working tree (untracked); là task spec nguồn. **Không sửa.**
- `docs/ROADMAP.md` — dự kiến thêm một dòng tóm tắt ngắn cho TASK-062 **sau khi**
  `npm run verify` PASS và Gemini review PASS (theo pattern các task trước).

Không sửa runtime code, không migration, không `.env*`, không GitHub Actions.

## 3. Bao phủ checklist (đối chiếu scope task)

| Yêu cầu scope | Có trong checklist? |
|---------------|---------------------|
| Checklist cho OWNER/ADMIN | ✅ §2, §3, và các bước OWNER/ADMIN xuyên suốt |
| Checklist cho STAFF_READ_ONLY | ✅ §2, §3, §10 (escalation) |
| Health dashboard check | ✅ §4 |
| Mailbox readiness check | ✅ §5 |
| Disconnected mailbox check | ✅ §6 |
| Unmapped mailbox check | ✅ §7 |
| Telegram send failure + logs cơ bản | ✅ §8 |
| Worker/queue/subscription/token (nếu dashboard có) | ✅ §9 |
| Khi STAFF_READ_ONLY báo OWNER/ADMIN | ✅ §10 |
| Khi OWNER/ADMIN dùng runbook TASK-060 | ✅ §10 |
| Phân biệt với onboarding TASK-061 | ✅ bảng đầu tài liệu + §7 |
| Phân biệt với incident runbook TASK-060 | ✅ bảng đầu tài liệu + §10 |
| Không lấn scale-up TASK-063 | ✅ §11 ghi rõ |

## 4. Tham chiếu UI thật (không bịa route)

Checklist dùng đúng route/label đã có trong onboarding guide và code:

- Trang Health `/admin/health`, Mailboxes `/admin/mailboxes`, Logs
  `/admin/logs`, Telegram `/admin/telegram`, và `/login`.
- Trạng thái readiness "Ready / Needs mapping / Needs customer / Disconnected /
  Error" khớp định nghĩa health dashboard (TASK-056).
- Các tín hiệu worker/queue/subscription/token được mô tả **có điều kiện** ("nếu
  dashboard có hiển thị"), khớp ghi chú TASK-056 về việc một số tín hiệu hiển thị
  Unknown/Degraded an toàn và không tự probe external.

## 5. Xác minh invariant không bị phá (chỉ thêm docs)

Task không sửa runtime code nên các invariant được giữ **by construction**.
Checklist chỉ **mô tả lại** để vận hành: RBAC OWNER/ADMIN vs STAFF_READ_ONLY +
assignment scope, reusable destination với rule mỗi mailbox tối đa một active
destination, disconnect guard (TASK-052), throttling/queue safety (TASK-055),
health dashboard (TASK-056), production auth fail-closed (TASK-057). Không nới
lỏng bất kỳ guardrail nào.

## 6. Kết quả kiểm tra

- `npm run verify`, `git status --short`, `git diff --stat`: kết quả được ghi
  trong tin nhắn của Claude kèm log.
- Diff **không** chứa secret thật, full verification code, hay full email body.
- Checklist chỉ nhắc **tên loại** thông tin nhạy cảm trong prose (token, client
  secret, bot token, encryption key, connection string…), không kèm giá trị.

## 7. Secret-scan false-positive risk

- Toàn bộ tài liệu tránh dòng ngắn dạng `keyword: value` cho các từ nhạy cảm.
  Khi cần nhắc, chỉ dùng câu prose hoặc bảng vai trò/trạng thái.
- Không thêm placeholder giống token/key thật; không sửa env example nào.
- Rủi ro false-positive: **thấp**. Cần Gemini xác nhận thêm.

## 8. ROADMAP

Theo pattern các task trước, dòng tóm tắt ngắn cho TASK-062 trong
`docs/ROADMAP.md` được thêm sau khi `npm run verify` PASS và Gemini review PASS.

## 9. Còn lại / blocker / việc tiếp theo

- **Blocker kế thừa:** chưa có production sign-in provider thật → staff chưa đăng
  nhập production được; checklist mặc định môi trường đã sẵn sàng khi chạy.
- Checklist chưa được chạy thử qua một chu kỳ vận hành thật (cần thử khi môi
  trường beta thực sự hoạt động với email/Telegram thật).
- Production scale-up (TASK-063) **không** thuộc scope task này.

## 10. Phần cần Gemini review kỹ

- Xác nhận checklist đúng mức "vận hành hằng ngày", không trùng onboarding
  (TASK-061), không thay thế incident runbook (TASK-060), không lấn scale-up
  (TASK-063).
- Xác nhận phân biệt phạm vi OWNER/ADMIN vs STAFF_READ_ONLY chính xác.
- Xác nhận giữ đúng rule: nhiều mailbox dùng chung reusable destination, mỗi
  mailbox một active destination, không broadcast, disconnected/chưa mapping →
  không Ready.
- Xác nhận không có secret thật, full verification code, hay full email body;
  không có wording dễ gây secret-scan false positive.
- Kết luận PASS/FAIL theo `GEMINI.md`.
