# TASK-061 — Staff onboarding guide (report)

Status: **docs-only. No runtime code, migration, `.env*`, or CI workflow was
touched. No real secret, full verification code, or full email body is in the
diff.**

**Headline:** TASK-060 left production with an operational incident runbook but
staff-facing beta still blocked (no real production sign-in provider, inherited
from TASK-059). TASK-061 does not change that — it adds a human-facing
onboarding guide so a non-technical internal staff member knows how to use the
dashboard safely once the environment is ready.

## 1. Mục tiêu đã đạt

- Tạo `docs/operations/STAFF_ONBOARDING_GUIDE.md` — guide onboarding cho nhân
  viên nội bộ **không chuyên code**, bao phủ đủ 16 phần theo task spec.
- Phân biệt rõ **OWNER/ADMIN** (xem toàn bộ, làm cấu hình quản trị) và
  **STAFF_READ_ONLY** (chỉ xem customer/mailbox được assign), kèm cảnh báo
  "không thấy ≠ không tồn tại" và yêu cầu báo OWNER/ADMIN khi thiếu quyền/dữ liệu.
- Hướng dẫn ở mức người dùng dashboard: đăng nhập, customer assignment, mailbox
  readiness, connect mailbox, map tới reusable Telegram destination, test-send
  an toàn, logs cơ bản, health cơ bản, khi nào báo OWNER/ADMIN.
- Giữ đúng các invariant: internal staff app (không customer login/signup/
  billing), nhiều mailbox dùng chung một reusable destination nhưng mỗi mailbox
  chỉ một active destination, không broadcast, mailbox disconnected/chưa mapping
  → không Ready.
- Tạo report này theo pattern `docs/reports/` của repo.

## 2. File đã thay đổi

- `docs/operations/STAFF_ONBOARDING_GUIDE.md` (mới) — guide chính. Thư mục
  `docs/operations/` được tạo mới cho tài liệu vận hành con người (giải thích
  vị trí ngay trong guide).
- `docs/reports/TASK-061-staff-onboarding-guide.md` (mới) — report này.
- `docs/tasks/TASK-061-staff-onboarding-guide.md` — đã tồn tại sẵn trong working
  tree (untracked); là task spec nguồn. **Không sửa.**
- `docs/ROADMAP.md` — thêm một dòng tóm tắt ngắn cho TASK-061 **sau khi**
  `npm run verify` PASS và Gemini review PASS (theo pattern các task trước). Nếu
  reviewer muốn cập nhật cùng lúc, có thể thêm ngay một dòng ngắn.

Không sửa runtime code, không migration, không `.env*`, không GitHub Actions.

## 3. Bao phủ guide (đối chiếu yêu cầu task)

| Phần bắt buộc | Có trong guide? |
|---------------|-----------------|
| Mục đích tài liệu | ✅ §1 |
| Ai được dùng dashboard / không phải customer login | ✅ §2 |
| Nguyên tắc an toàn bắt buộc | ✅ §3 |
| Vai trò và giới hạn quyền (OWNER/ADMIN vs STAFF_READ_ONLY) | ✅ §4 |
| Đăng nhập dashboard (kèm trạng thái fail-closed hiện tại) | ✅ §5 |
| Hiểu customer assignment | ✅ §6 |
| Hiểu mailbox readiness | ✅ §7 |
| Connect mailbox | ✅ §8 |
| Map mailbox tới reusable Telegram destination | ✅ §9 |
| Test-send an toàn | ✅ §10 |
| Kiểm tra logs cơ bản | ✅ §11 |
| Kiểm tra health cơ bản | ✅ §12 |
| Khi nào báo OWNER/ADMIN | ✅ §13 |
| Những việc staff không được làm | ✅ §14 |
| Checklist onboarding cho staff mới | ✅ §15 |
| Handoff sau onboarding | ✅ §16 |

## 4. Tham chiếu UI thật (không bịa route)

Guide dùng đúng route/label có thật trong code:

- Sidebar: Dashboard, Customers, Mailboxes, Telegram, Mock Email, Logs, Health
  (`components/layout/AdminSidebar.tsx`).
- `/login`, `/admin`, `/admin/mailboxes`, `/admin/mailboxes/<id>`,
  `/admin/telegram`, `/admin/logs`, `/admin/health` đều tồn tại trong `app/`.
- Trạng thái readiness "Ready / Needs mapping / Needs customer" khớp
  `app/admin/health/page.tsx`.
- Reusable destination + mapping khớp `app/admin/telegram/page.tsx`.
- Test-send mô tả ở mức an toàn, khớp với hành vi route
  `app/api/telegram/test-send/route.ts` (tin nhắn thử mặc định vô hại, không
  chứa mã thật).

## 5. Xác minh invariant không bị phá (chỉ thêm docs)

Task không sửa runtime code nên các invariant được giữ **by construction**.
Guide chỉ **mô tả lại** để vận hành: RBAC OWNER/ADMIN vs STAFF_READ_ONLY +
assignment scope, reusable destination với rule mỗi mailbox tối đa một active
destination, disconnect guard (TASK-052), throttling/queue safety (TASK-055),
health dashboard (TASK-056), production auth fail-closed (TASK-057). Không nới
lỏng bất kỳ guardrail nào.

## 6. Kết quả kiểm tra

- `npm run verify`, `git status --short`, `git diff --stat`: kết quả PASS/FAIL
  được ghi trong tin nhắn của Claude kèm log.
- Diff **không** chứa secret thật, full verification code, hay full email body.
- Guide chỉ nhắc **tên loại** thông tin nhạy cảm trong prose (token, client
  secret, bot token, encryption key, connection string…), không kèm giá trị.

## 7. Secret-scan false-positive risk

- Toàn bộ tài liệu tránh dòng ngắn dạng `keyword: value` cho các từ nhạy cảm
  (branch, token, secret, key, password, auth, bearer, client secret, database
  URL, connection string). Khi cần nhắc, chỉ dùng câu prose hoặc bảng vai trò.
- Không thêm placeholder giống token/key thật; không sửa env example nào.
- Rủi ro false-positive: **thấp**. Cần Gemini xác nhận thêm.

## 8. ROADMAP

Theo pattern các task trước, dòng tóm tắt ngắn cho TASK-061 trong
`docs/ROADMAP.md` được thêm sau khi `npm run verify` PASS và Gemini review PASS.

## 9. Còn lại / blocker / việc tiếp theo

- **Blocker kế thừa:** chưa có production sign-in provider thật → staff chưa
  đăng nhập production được; guide đã nói rõ điều này ở §5.
- Guide chưa được nghiệm thu thực tế bởi một nhân viên mới (cần thử onboard thật
  khi môi trường sẵn sàng).
- Daily operations checklist (TASK-062) và production scale-up (TASK-063) **không**
  thuộc scope task này.

## 10. Phần cần Gemini review kỹ

- Xác nhận guide đúng mức "người không chuyên code", không lấn sang daily ops
  (TASK-062), scale-up (TASK-063), hay backup/incident runbook (TASK-060).
- Xác nhận phân biệt OWNER/ADMIN vs STAFF_READ_ONLY chính xác.
- Xác nhận giữ đúng rule: nhiều mailbox dùng chung reusable destination, mỗi
  mailbox một active destination, không broadcast, disconnected/chưa mapping →
  không Ready.
- Xác nhận không có secret thật, full verification code, hay full email body;
  không có wording dễ gây secret-scan false positive.
- Kết luận PASS/FAIL theo `GEMINI.md`.
