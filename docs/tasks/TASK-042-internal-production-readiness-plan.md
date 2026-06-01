# TASK-042: Internal production readiness plan

## 1. Mục tiêu

Lập **kế hoạch đưa Verification Code Relay Tool vào vận hành nội bộ thực tế**
(internal production readiness) cho nhân viên của agency, từ TASK-042 trở đi.

Đây là **task lập kế hoạch / tài liệu** — KHÔNG phải task code. Kết quả là:

- Một task spec mô tả mô hình vận hành nội bộ và lộ trình readiness.
- Một report ghi lại những gì đã tạo/sửa và kết quả kiểm tra.
- Roadmap mở rộng (TASK-042 → TASK-061) theo 6 hướng readiness.

Mục tiêu nghiệp vụ tổng thể (không làm trong TASK-042, chỉ định hướng cho các task sau):

- App dùng **nội bộ** cho nhân viên của agency, **không** public cho người lạ tự đăng ký.
- Nhân viên dùng dashboard để connect **nhiều** mailbox Hotmail/Outlook.
- Nhân viên map **từng mailbox** tới đúng **một** Telegram group/topic của khách hàng.
- Mỗi mailbox chỉ gửi tới đúng **một** active Telegram group/topic destination.
- Đưa app lên: staging → scale readiness (100–200 mailbox/nhân viên) → production
  internal launch → vận hành nội bộ.

## 2. Bối cảnh

Dự án đã hoàn thành tới TASK-041 (Sprint 0 → Sprint 9 + flexible Telegram routing).
Tham chiếu: `docs/PROJECT_HANDOFF_TASK_001_TO_041.md`. Trạng thái tại thời điểm bàn giao:
`npm run verify` PASS (lint + typecheck + 684 test + build), code/test xong; còn lại là
các bước **vận hành thật** (CI green quan sát được, Gemini review nhánh hiện tại, live
round-trip trên mailbox/Telegram thật).

Bối cảnh mới làm rõ định hướng vận hành:

- **Internal-only:** không có self-signup public; chỉ nhân viên agency đăng nhập và thao tác.
- **Staff connect nhiều mailbox:** một nhân viên quản lý nhiều mailbox khách hàng.
- **Routing 1–1:** mỗi mailbox map tới đúng một Telegram group/topic. TASK-041 đã cho phép
  **nhiều mailbox → cùng một** group/topic một cách có chủ đích, nhưng **một mailbox vẫn chỉ
  có một** active destination chính.
- **KHÔNG** phát triển hướng 1 mailbox → nhiều Telegram destination.

## 3. Scope được phép làm (trong TASK-042)

Chỉ làm phần **tài liệu / kế hoạch**:

- Tạo `docs/tasks/TASK-042-internal-production-readiness-plan.md` (file này).
- Tạo `docs/reports/TASK-042-internal-production-readiness-plan.md`.
- Cập nhật `docs/ROADMAP.md`: thêm/đảm bảo roadmap TASK-042 → TASK-061 theo 6 hướng và
  ghi rõ 3 nguyên tắc bắt buộc (xem §5).
- Chạy lệnh kiểm tra read-only / không phá hủy (`npm run verify`, `git status`, `git diff`).

## 4. Scope KHÔNG được làm

- KHÔNG sửa **runtime code** (`app/`, `services/`, `lib/`, `prisma/`, `scripts/`, tests).
- KHÔNG tạo/sửa Prisma migration trong task này.
- KHÔNG deploy production. KHÔNG thao tác production database.
- KHÔNG đọc/in `.env` hoặc `.env.local`.
- KHÔNG ghi secret thật, token thật, verification code thật, full email body. Chỉ ghi
  **tên** biến môi trường, không ghi giá trị.
- KHÔNG thêm tính năng **1 mailbox → nhiều Telegram destination**.
- KHÔNG thêm multi-platform ngoài Facebook/Meta.
- KHÔNG mở rộng scope ngoài tài liệu roadmap / readiness.

## 5. Yêu cầu nội dung (readiness plan)

### 5.1. Ba nguyên tắc bắt buộc phải ghi rõ trong roadmap

1. **Mỗi mailbox chỉ có một active Telegram group/topic destination.**
2. **KHÔNG làm 1 mailbox → nhiều destination** (ngoài scope toàn bộ lộ trình này).
3. **Microsoft publisher verification KHÔNG phải blocker hiện tại** — chỉ theo dõi; chỉ
   xử lý nếu/khi consent thực tế bị chặn (ví dụ tenant yêu cầu admin consent, hoặc
   `AADSTS65001` / consent required). Tham chiếu `docs/MICROSOFT_SETUP.md` §troubleshooting.

### 5.2. Sáu hướng roadmap (TASK-042 → TASK-061)

| Sprint | Hướng | Task |
|---|---|---|
| 10 | Internal production readiness | TASK-042, 043, 044 |
| 11 | Staff operation model | TASK-045, 046, 047 |
| 12 | Staging deployment | TASK-048, 049, 050, 051 |
| 13 | Scale readiness (100–200 mailbox/nhân viên) | TASK-052, 053, 054 |
| 14 | Production security & internal launch | TASK-055, 056, 057, 058 |
| 15 | Internal operations | TASK-059, 060, 061 |

### 5.3. Định hướng từng hướng (không code trong TASK-042)

- **Internal production readiness:** chốt rule routing 1 mailbox → 1 destination; hardening
  Prisma Client generation cho môi trường thật; xác nhận lại quy tắc one-mailbox-one-destination.
- **Staff operation model:** mô hình ownership/assignment mailbox cho nhân viên; UX dashboard
  khi số mailbox lớn; luồng onboarding mailbox an toàn.
- **Staging deployment:** chọn platform + kiến trúc staging; dựng hạ tầng staging; validate
  Microsoft App Registration staging; chạy live E2E trên mailbox/Telegram test.
- **Scale readiness:** kế hoạch test scale 100–200 mailbox/nhân viên; throttling/queue safety
  theo từng mailbox; health dashboard theo workload nhân viên.
- **Production security & internal launch:** hardening auth cho nhân viên nội bộ; setup
  production env + secret (chỉ tên biến); deploy internal beta giới hạn; backup/restore +
  incident response.
- **Internal operations:** hướng dẫn onboarding nhân viên; checklist vận hành hàng ngày;
  scale-up từ beta lên dùng nội bộ đầy đủ.

## 6. Yêu cầu bảo mật

- Tuân thủ `docs/SECURITY_RULES.md` (source of truth) ở mọi task sau.
- Trong TASK-042: chỉ ghi **tên** biến môi trường, không ghi giá trị thật.
- Không hardcode secret/token/chat ID; không log token/secret/verification code.
- Không đọc/in `.env` / `.env.local`.
- Mọi tài liệu production phải nhắc lại: secret thật chỉ sống trong secret manager của
  platform; staging/production phải tạo `ENCRYPTION_KEY` riêng (không tái dùng giá trị mẫu).

## 7. Database / Prisma

- TASK-042 **không** thay đổi schema và **không** tạo migration.
- Hardening Prisma Client generation (cho môi trường thật) được tách riêng sang **TASK-043**.
- Bất kỳ thao tác DB nào ở các task sau dùng `prisma migrate deploy` (không `migrate dev`)
  trên staging/production, và **không** thao tác production DB trong giai đoạn lập kế hoạch.

## 8. Service

- TASK-042 không thêm/sửa service.
- Nguyên tắc routing giữ nguyên: `getActiveTelegramDestinationForMailbox(mailboxId)` trả về
  đúng **một** destination active theo mailbox; mailbox không có mapping active thì không gửi.

## 9. Tests

- TASK-042 không thêm test mới (docs-only).
- `npm run verify` vẫn phải PASS (đảm bảo thay đổi docs không làm hỏng gì).

## 10. Lệnh kiểm tra

```powershell
npm run verify
git status --short
git diff --stat
```

## 11. Tiêu chí nghiệm thu

TASK-042 PASS khi:

- `docs/tasks/TASK-042-internal-production-readiness-plan.md` tồn tại và đúng cấu trúc.
- `docs/reports/TASK-042-internal-production-readiness-plan.md` tồn tại.
- `docs/ROADMAP.md` có roadmap TASK-042 → TASK-061 theo 6 hướng và ghi rõ 3 nguyên tắc §5.1.
- Không có thay đổi runtime code, không có migration mới.
- Không ghi secret/token/code thật; chỉ tên biến môi trường.
- `npm run verify` PASS.
- Gemini review PASS, không còn Critical/High.

## 12. Báo cáo sau khi làm

Claude trả lời theo format:

1. Đã hiểu TASK-042 là gì.
2. File đã tạo/sửa.
3. Những thay đổi đã làm.
4. Có Prisma migration không.
5. Tests đã thêm/cập nhật.
6. Lệnh đã chạy.
7. Kết quả PASS/FAIL.
8. Rủi ro còn lại.
9. Có làm vượt scope không.
10. Cần Gemini review phần nào.
