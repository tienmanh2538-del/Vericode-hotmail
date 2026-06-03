# TASK-060 — Backup, restore & incident response (report)

Status: **runbook documentation prepared; no production resource was touched.**
This task is **docs-only**. No real production database, Redis, mailbox, or
customer Telegram group was created, restored, or used. No `.env*` content was
read or printed. No real secret, full verification code, or full email body is
in the diff. No restore was executed against any live environment.

**Headline:** TASK-059 left production deploy/infra-verifiable but
**staff-facing beta still blocked** (no real production sign-in provider).
TASK-060 does not change that — it adds the operational runbook so that an
internal operator knows how to react safely when production has an incident.

## 1. Mục tiêu đã đạt

- Tài liệu hóa runbook vận hành sự cố cho limited internal beta trong task spec
  `docs/tasks/TASK-060-backup-restore-incident-response.md`, gồm: backup
  strategy tối thiểu, restore drill an toàn vào môi trường tách biệt, và
  incident response cho mọi nhóm lỗi production quan trọng.
- Bao phủ đủ các nhóm incident được yêu cầu (xem §3).
- Thêm hướng dẫn emergency worker shutdown **không xóa dữ liệu**, đúng thứ tự ưu
  tiên (email → delta → renewal), giữ database/Redis nguyên trạng để điều tra.
- Liên kết runbook từ `deployment/production/README.md` bằng một link ngắn,
  thay cho ghi chú "out of scope — lands in TASK-060" trước đó.
- Xác minh bằng diff rằng task chỉ thêm/sửa docs, không chạm runtime code,
  không phá invariant nào.

## 2. File đã thay đổi

- `docs/tasks/TASK-060-backup-restore-incident-response.md` — task spec +
  runbook (đã tồn tại trong working tree dưới dạng untracked; là nguồn runbook
  chính cho task này).
- `deployment/production/README.md` — đổi đoạn "detailed backup/restore/incident
  procedures out of scope here" thành **link ngắn** trỏ tới runbook TASK-060.
  Không thêm nội dung dài; README vẫn là quick reference.
- `docs/reports/TASK-060-backup-restore-incident-response.md` (mới) — báo cáo này.

Không sửa `.env*`, không sửa runtime code, không sửa GitHub Actions, không sửa
`docs/ROADMAP.md` cho tới khi verify/review xong (xem §8).

## 3. Bao phủ runbook (đối chiếu yêu cầu task)

| Nhóm bắt buộc | Có trong runbook? |
|---------------|-------------------|
| Backup strategy tối thiểu | ✅ |
| Restore drill an toàn vào môi trường tách biệt | ✅ |
| Deploy / build / migration incident | ✅ |
| Database incident | ✅ |
| Redis / queue incident | ✅ |
| Worker crash hoặc worker chạy sai môi trường | ✅ |
| Microsoft OAuth / Graph / subscription incident | ✅ |
| Telegram gửi thất bại hoặc gửi nhầm destination | ✅ |
| Secret nghi bị lộ | ✅ |
| Verification code hoặc email body bị log nhầm | ✅ |
| Auth / session incident | ✅ |
| Emergency worker shutdown không xóa dữ liệu | ✅ |

## 4. Nguyên tắc an toàn được nhấn mạnh trong runbook

- Restore drill chỉ vào **môi trường tách biệt**; không trỏ production web/worker
  vào database restore-test; không bật worker, không dùng bot production, không
  connect mailbox thật, không gửi verification code thật trong drill.
- Không chạy `prisma migrate dev` trên production; chỉ dùng `prisma migrate
  deploy` + `prisma migrate status` (khớp `deployment/production/README.md` và
  `docs/STAGING_DEPLOYMENT.md`).
- Không thao tác production database bằng AI agent; không restore đè production
  khi chưa drill, chưa xác minh backup, và chưa có human approval.
- Redis/queue **không** là nguồn dữ liệu chính: phục hồi luồng email dựa trên
  database state + delta polling sau khi Redis ổn định.
- Emergency shutdown chỉ **dừng xử lý**, không xóa queue/database.

## 5. Xác minh invariant không bị phá (chỉ thêm docs)

Task không sửa runtime code nên các invariant được giữ **by construction**. Các
điểm enforce vẫn nằm nguyên ở service/API layer (như đã liệt kê trong report
TASK-059 §5): RBAC OWNER/ADMIN vs STAFF_READ_ONLY + assignment scope, reusable
destination với rule mỗi mailbox tối đa một active destination, disconnect guard
(TASK-052), throttling/queue safety (TASK-055), health dashboard (TASK-056),
production auth hardening fail-closed (TASK-057), production env/secret setup
(TASK-058), và limited beta guardrails (TASK-059). Runbook **mô tả lại** các
guardrail đó để vận hành sự cố, không nới lỏng chúng.

## 6. Kết quả kiểm tra

- `npm run verify`, `git status --short`, `git diff --stat`: kết quả PASS/FAIL
  được ghi trong tin nhắn của Claude kèm log.
- Diff **không** chứa secret thật, full verification code, hay full email body.
- Runbook và report chỉ liệt kê **tên biến/tên nhóm secret**, không kèm giá trị.

## 7. Secret-scan false-positive risk

- Toàn bộ tài liệu tránh dòng ngắn dạng `keyword: value` cho các từ nhạy cảm
  (branch, token, secret, key, password, auth, bearer, client secret, database
  URL, connection string). Khi cần nhắc tới một secret, chỉ ghi **tên biến**
  trong văn xuôi hoặc bảng.
- Không thêm placeholder mới giống token/key thật; không sửa
  `deployment/production/env.production.example`.
- Rủi ro false-positive: **thấp**. Cần Gemini xác nhận thêm.

## 8. ROADMAP

Theo yêu cầu task, `docs/ROADMAP.md` **chưa** được cập nhật trong diff này. Dòng
tóm tắt ngắn cho TASK-060 sẽ được thêm sau khi `npm run verify` PASS và Gemini
review PASS, theo đúng pattern các task trước (mỗi task done có một dòng tóm tắt
ngắn). Nếu reviewer muốn cập nhật cùng lúc, có thể thêm ngay một dòng ngắn.

## 9. Còn lại / blocker / việc tiếp theo

- **Blocker kế thừa từ TASK-059:** chưa có production sign-in provider thật →
  staff beta chưa usable qua admin UI. Runbook giả định production mới ở mức
  deploy/infra-verifiable.
- Restore drill là **hướng dẫn**, chưa chạy thật (cần môi trường tách biệt +
  một backup gần đây + human approval khi tới lúc thực thi).
- Backup do deploy/database provider quản lý; runbook không tự cấu hình backup
  của provider (ngoài scope docs).
- Task tiếp theo: staff onboarding (TASK-061), daily operations checklist
  (TASK-062), production scale-up (TASK-063) — **không** thuộc scope TASK-060.

## 10. Phần cần Gemini review kỹ

- Xác nhận runbook bao phủ đủ các nhóm incident và không gợi ý thao tác nguy
  hiểm (restore đè production không drill, sửa DB tay, bypass auth, retry vô hạn).
- Xác nhận không có secret thật, full verification code, hay full email body.
- Xác nhận không có wording dễ gây secret-scan false positive (không có dòng
  `keyword: value` nhạy cảm).
- Xác nhận task chỉ thêm/sửa docs, không phá invariant nào ở §5, không mở rộng
  sang TASK-061/062/063.
- Kết luận PASS/FAIL theo `GEMINI.md`.
