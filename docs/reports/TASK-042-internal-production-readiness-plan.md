# TASK-042 Report — Internal Production Readiness Plan

- **Report date:** 2026-06-01
- **Branch:** `feature/task-041-flexible-telegram-routing`
- **Base commit:** `7cf5253`
- **Author:** Claude Code
- **Scope:** Planning / documentation only. **No runtime code, tests, configs, Prisma
  schema/migrations, or `.env*` files were modified.** Không deploy production, không thao
  tác production database. Chỉ ghi **tên** biến môi trường, không ghi giá trị thật.

---

## 1. Tôi đã hiểu TASK-042 là gì

TASK-042 là task **lập kế hoạch (docs-only)** đưa app vào vận hành **nội bộ** thực tế cho
nhân viên agency. Nhân viên connect nhiều mailbox Hotmail/Outlook và map từng mailbox tới
đúng **một** Telegram group/topic của khách. Mỗi mailbox chỉ có **một** active destination;
**không** làm 1 mailbox → nhiều destination. Lộ trình kéo dài qua staging → scale (100–200
mailbox/nhân viên) → production internal launch → vận hành nội bộ.

## 2. File đã tạo/sửa

| File | Loại | Hành động |
|---|---|---|
| `docs/tasks/TASK-042-internal-production-readiness-plan.md` | Tạo mới | Task spec readiness |
| `docs/reports/TASK-042-internal-production-readiness-plan.md` | Tạo mới | Report này |
| `docs/ROADMAP.md` | Sửa | Thêm Sprint 10–15 (TASK-042 → 061) + 3 nguyên tắc bắt buộc |

Không có file runtime / test / schema / migration nào bị đổi.

## 3. Những thay đổi đã làm

- **Task spec:** mô tả mục tiêu, bối cảnh internal-only, scope được làm / KHÔNG làm, 6 hướng
  readiness, 3 nguyên tắc bắt buộc, yêu cầu bảo mật, DB/Prisma (không migration), service,
  tests, lệnh kiểm tra, tiêu chí nghiệm thu, format báo cáo.
- **ROADMAP:** Sprint 10–15 (TASK-042 → TASK-061) theo 6 hướng:
  Internal production readiness · Staff operation model · Staging deployment · Scale readiness ·
  Production security & internal launch · Internal operations. Bổ sung block **"Nguyên tắc bắt
  buộc cho toàn bộ lộ trình"** ghi rõ:
  1. Mỗi mailbox chỉ có **một** active Telegram group/topic destination.
  2. **KHÔNG** làm 1 mailbox → nhiều destination.
  3. Microsoft publisher verification **không phải blocker** hiện tại — chỉ theo dõi nếu
     consent bị chặn.

## 4. Có Prisma migration không

Không. TASK-042 không tạo/sửa schema hay migration. (Hardening Prisma Client generation được
tách riêng sang TASK-043 trong roadmap.)

## 5. Tests đã thêm/cập nhật

Không. Đây là task docs-only; không thêm/sửa test. `npm run verify` vẫn được chạy để xác nhận
thay đổi tài liệu không làm hỏng pipeline.

## 6. Lệnh đã chạy

| Lệnh | Mục đích |
|---|---|
| `npm run verify` | lint + typecheck + test + build (xác nhận docs-only không phá pipeline) |
| `git status --short` | Liệt kê file thay đổi |
| `git diff --stat` | Tóm tắt thay đổi |

> Kết quả cụ thể (PASS/FAIL + số test) được điền ở §7 sau khi chạy.

## 7. Kết quả PASS/FAIL

- `npm run verify`: **PASS** — exit code 0. lint OK · typecheck OK · **test 684/684 pass
  (56 test files)** · `next build` thành công (27 routes).
- `git status --short`:
  ```text
   M docs/ROADMAP.md
  ?? docs/reports/TASK-042-internal-production-readiness-plan.md
  ?? docs/tasks/TASK-042-internal-production-readiness-plan.md
  ```
- `git diff --stat`: `docs/ROADMAP.md | 51 +++…` (1 file changed, 51 insertions). Hai file mới
  là untracked nên không xuất hiện trong diff stat. Không có file runtime/test/schema nào thay đổi.

## 8. Rủi ro còn lại

- Các bước vận hành thật vẫn treo từ handoff §10: quan sát CI green trên nhánh, Gemini review
  nhánh hiện tại, live round-trip mailbox/Telegram thật (duplicate-once case). Đây là điều kiện
  để MVP từ CONDITIONAL PASS → PASS, và là input cho TASK-048 → 051.
- Roadmap TASK-042 → 061 mới là **định hướng**; mỗi task vẫn cần task spec chi tiết riêng trước
  khi code.
- Production secret/`ENCRYPTION_KEY` phải tạo riêng trong secret manager (không tái dùng giá
  trị mẫu trong `.env.example`) — sẽ enforce ở TASK-056.

## 9. Có làm vượt scope không

Không. Chỉ tạo/sửa tài liệu trong `docs/`. Không sửa runtime code, không migration, không
deploy, không thao tác production DB, không thêm multi-destination, không đọc/in `.env`, không
ghi secret/token/code thật (chỉ tên biến môi trường).

## 10. Cần Gemini review phần nào

- `docs/tasks/TASK-042-internal-production-readiness-plan.md`: scope/nguyên tắc có rõ ràng và
  nhất quán với `docs/PRODUCT_SPEC.md` + `docs/SECURITY_RULES.md` không.
- `docs/ROADMAP.md`: 3 nguyên tắc bắt buộc đã ghi rõ và đúng vị trí; các task 042 → 061 mạch lạc.
- Xác nhận không có secret/token/chat ID/verification code thật rò rỉ trong tài liệu (chỉ tên
  biến môi trường).
- Kết luận PASS/FAIL theo format `GEMINI.md`.
