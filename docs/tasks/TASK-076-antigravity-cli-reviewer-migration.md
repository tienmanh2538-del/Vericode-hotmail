# TASK-076 — Antigravity CLI reviewer migration

## Mục tiêu

Chuyển vai trò **reviewer/tester độc lập** của project từ **Gemini CLI** sang
**Antigravity CLI**. Google đã chuyển terminal workflow sang Antigravity CLI, nên
từ task này trở đi reviewer/tester độc lập phải là Antigravity CLI.

Giữ nguyên các vai trò còn lại:

- ChatGPT: planner / product manager.
- Claude Code: coder chính.
- Cursor: môi trường xem project + chỉnh sửa nhỏ khi người dùng duyệt.
- GitHub Actions: CI gate.

Đặc tả Antigravity CLI:

- Mặc định CHỈ review/test, KHÔNG sửa file.
- Chỉ sửa file nếu prompt có dòng `ALLOW_ANTIGRAVITY_EDIT=true`.
- Luôn kết luận PASS hoặc FAIL.
- Phải đọc task file hiện tại, git diff hiện tại, docs bảo mật, và chạy/kiểm tra
  `npm run verify` nếu phù hợp.
- Không đọc/in `.env*`.
- Không log token, refresh token, client secret, Telegram bot token, verification
  code đầy đủ, hoặc full email body.

## Bối cảnh

Trước đây project dùng Gemini CLI làm reviewer/tester độc lập (xem `GEMINI.md`,
`scripts/gemini-ecc-review.ps1`, và các mention trong `AGENTS.md`,
`docs/SECURITY_RULES.md`, `CLAUDE.md`, `.cursor/rules/ecc-project-rules.mdc`,
`docs/PRODUCT_SPEC.md`, `docs/operations/PRODUCTION_SCALE_UP_CHECKLIST.md`).

Đây là task docs/workflow, **không** sửa runtime code, test, schema, migration
hay GitHub Actions.

## Scope được làm

1. Tạo task file này.
2. `git mv GEMINI.md ANTIGRAVITY.md` và viết lại nội dung thành instruction mới cho
   Antigravity CLI (không giữ lại GEMINI.md vì không cần backward-compat thật).
3. `git mv scripts/gemini-ecc-review.ps1 scripts/antigravity-ecc-review.ps1` và cập
   nhật prompt + lệnh gọi (`antigravity -p ...`) + output file
   (`docs/reports/antigravity-ecc-review.md`).
4. Cập nhật các file source-of-truth / workflow hiện hành:
   - `AGENTS.md` — vai trò reviewer/tester độc lập.
   - `docs/SECURITY_RULES.md` — danh sách agent + mục §9.
   - `CLAUDE.md` — mục "cần ai review".
   - `.cursor/rules/ecc-project-rules.mdc` — danh sách AI.
   - `docs/PRODUCT_SPEC.md` — tiêu chí nghiệm thu MVP #7.
   - `docs/operations/PRODUCTION_SCALE_UP_CHECKLIST.md` — điều kiện trước scale.
   - `docs/MICROSOFT_SETUP.md` — danh sách AI không được paste secret.
5. Cập nhật `docs/ROADMAP.md`: thêm note "từ TASK-076 reviewer/tester độc lập là
   Antigravity CLI; mention Gemini ở task cũ là lịch sử" + entry TASK-076.
6. Tạo report `docs/reports/TASK-076-antigravity-cli-reviewer-migration.md`.

## Scope KHÔNG làm

- KHÔNG viết lại lịch sử: các báo cáo task cũ (`docs/reports/TASK-0xx-*.md`,
  `docs/PROJECT_HANDOFF_*.md`, `docs/reports/gemini-ecc-review.md`,
  `docs/reports/mvp-acceptance-review.md`, `docs/reports/security-review.md`) ghi
  "Gemini review PASS" cho task được Gemini review thật → giữ nguyên.
- KHÔNG sửa runtime code, test, schema, migration, GitHub Actions.
- KHÔNG đọc/in/sửa `.env*`.
- KHÔNG ghi secret thật, database/Redis URL, token, client secret, bot token,
  encryption key, session secret, hay full verification code vào docs.
- KHÔNG nới lỏng secret scan trong CI.

## Lệnh kiểm tra

```bash
npm run verify
git status --short
git diff --stat
```

## Tiêu chí nghiệm thu

- `GEMINI.md` đã rename thành `ANTIGRAVITY.md` với nội dung instruction mới; không
  còn file `GEMINI.md` ở root.
- Script review đã rename + cập nhật để gọi Antigravity CLI.
- Mọi file source-of-truth / workflow hiện hành mô tả reviewer/tester là
  Antigravity CLI (không còn nói Gemini là reviewer hiện tại).
- Các mention Gemini còn lại chỉ là lịch sử (report task cũ, handoff) và được liệt
  kê rõ trong report.
- `npm run verify` PASS.
- Không commit (chờ Antigravity CLI review).
