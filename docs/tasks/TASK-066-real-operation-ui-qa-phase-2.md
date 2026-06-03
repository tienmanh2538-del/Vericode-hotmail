# TASK-066 — Real operation UI QA & phase 2 test

## Mục tiêu

Đây là **test phase 2** sau khi technical audit phase 1 (TASK-064) đã CONDITIONAL
PASS và backlog H1 đã đóng ở TASK-065. Phase 2 tập trung vào **thao tác UI thực
tế**: chạy dashboard, đi qua các luồng vận hành an toàn (mock / live-safe), và
**ghi nhận** mọi vấn đề UX/UI. Đây là task **chuẩn bị checklist + report
template**, không phải task sửa UI.

> Phase 1 (TASK-064) = technical audit + automated test/review (chưa test UI sâu).
> Phase 2 (TASK-066) = real-operation UI QA thủ công + ghi nhận issue, vẫn an toàn
> (không dùng mailbox/Telegram group khách hàng thật ở bước đầu).

## Phạm vi (scope)

Trong scope:

- Tạo tài liệu task này (`docs/tasks/TASK-066-real-operation-ui-qa-phase-2.md`).
- Tạo checklist + report template
  (`docs/reports/TASK-066-real-operation-ui-qa-phase-2.md`) để ghi kết quả test
  UI thực tế.
- Định nghĩa quy trình safety precheck, UI smoke test, các luồng E2E an toàn, và
  format ghi nhận issue UX/UI.
- Cập nhật `docs/ROADMAP.md` ngắn gọn (TASK-066 là phase 2 real-operation UI QA).
- Chạy `npm run verify`.

Ngoài scope (KHÔNG làm trong task này):

- **Không sửa runtime code.**
- **Không sửa UI code** trong task chuẩn bị checklist này. Nếu phát hiện UI/UX
  issue, **mở task fix riêng** sau khi review — không tự tối ưu UI ở đây.
- Không mở rộng scope sang production scale-up (TASK-063).
- Không dùng **mailbox khách hàng thật** hoặc **Telegram group khách hàng thật**
  ở bước đầu. Chỉ dùng mock / dữ liệu test / destination an toàn.
- Không chạy live Microsoft email path với email thật ở bước đầu.
- Không sửa `.env*`, không đọc/in secret.
- Không sửa GitHub Actions / secret-scan.

## Tài liệu đã đọc để đối chiếu

- `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`
- `docs/SECURITY_RULES.md`, `docs/ROADMAP.md`
- `docs/tasks/TASK-064-final-technical-audit-phase-1.md` +
  `docs/reports/TASK-064-final-technical-audit-phase-1.md`
- `docs/tasks/TASK-065-fix-legacy-telegram-mapping-isolation.md` +
  `docs/reports/TASK-065-fix-legacy-telegram-mapping-isolation.md`
- `docs/operations/STAFF_ONBOARDING_GUIDE.md`
- `docs/operations/DAILY_OPERATIONS_CHECKLIST.md`
- `docs/reports/TASK-060-backup-restore-incident-response.md` (đối chiếu runbook
  khi cần)

## Các màn hình UI trong scope test (đường dẫn thực tế)

| Khu vực | Route |
|---|---|
| Login | `/login` |
| Dashboard | `/admin` |
| Customers | `/admin/customers`, `/admin/customers/new`, `/admin/customers/[id]/edit` |
| Mailboxes | `/admin/mailboxes` |
| Mailbox detail | `/admin/mailboxes/[id]` |
| Telegram destinations + mappings | `/admin/telegram`, `/admin/telegram/[id]/edit`, `/admin/telegram/destinations/[id]/edit` |
| Mock email | `/admin/mock-email` |
| Logs | `/admin/logs`, `/admin/logs/code-events`, `/admin/logs/audit` |
| Health | `/admin/health` |

## Nguyên tắc an toàn bắt buộc khi test (live-safe)

1. **Không dùng mailbox khách hàng thật, không dùng Telegram group khách hàng
   thật** ở bước đầu. Ưu tiên mock email + destination test riêng.
2. **Không gửi verification code thật** ra Telegram. Test-send chỉ dùng nội dung
   vô hại.
3. **Không ghi full verification code, full email body** vào report.
4. **Không ghi token, client secret, database URL, Redis URL, Telegram bot token,
   session secret** vào report — kể cả khi nhìn thấy trên màn hình.
5. Khi chụp screenshot/video, **che (mask)** mọi giá trị nhạy cảm trước khi lưu
   vào repo.
6. Giữ nguyên các guardrail đã chốt: một mailbox tối đa một active destination;
   nhiều mailbox dùng chung một reusable destination là hợp lệ; không broadcast;
   mailbox disconnected / chưa mapping hợp lệ → không Ready, không relay.
7. Khi nghi lộ secret/code/email body → dừng và xử lý theo runbook TASK-060.

## Tiêu chí nghiệm thu

- Có file checklist/report template
  (`docs/reports/TASK-066-real-operation-ui-qa-phase-2.md`) bao gồm: safety
  precheck, UI smoke test đủ các màn hình, mock email E2E, reusable destination
  test, one-mailbox-one-active-destination test, customer isolation / role scope
  test, disconnect mailbox safety test, health/logs/operations review, và format
  ghi nhận issue UX/UI.
- Format ghi issue đủ trường: ID, Screen, Severity, Steps to reproduce, Expected,
  Actual, Screenshot/video filename (nếu có), Suggested next task (nếu cần fix).
- `docs/ROADMAP.md` được cập nhật ngắn gọn (không nhồi report dài vào roadmap),
  ghi rõ nếu phát hiện UI/UX issues thì mở task fix riêng sau khi review.
- `npm run verify` PASS.
- Không sửa runtime/UI code, không sửa `.env*`, không sửa GitHub Actions, không
  in secret.

## Bàn giao / bước tiếp theo

- Khi chạy checklist thực tế và phát hiện issue → ghi vào report theo format, rồi
  **mở task fix riêng** (đề xuất TASK-067+) sau khi OWNER/ADMIN review danh sách
  issue. Task này **không** sửa UI.
- Backlog kỹ thuật còn lại từ phase 1 (M1 dedup race, M2 TOCTOU one-active, M3
  scope optional, L1 Telegram `description` log) vẫn theo dõi độc lập; phase 2
  UI QA không thay thế các fix kỹ thuật đó.

## Kết quả

Xem `docs/reports/TASK-066-real-operation-ui-qa-phase-2.md`.
