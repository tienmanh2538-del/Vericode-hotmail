# TASK-064 — Final technical audit & phase 1 test review

## Mục tiêu

Tổng kiểm tra kỹ thuật toàn repo sau khi hoàn thành 63 task trong `docs/ROADMAP.md`.
Đây là **test phase 1**: technical audit + automated test/review. Phase này **chưa**
test UI thực tế sâu và **chưa** tối ưu UI.

## Phạm vi (scope)

Trong scope:

- Kiểm tra trạng thái Git.
- Chạy `npm run verify` (db:generate + lint + typecheck + test + build).
- Audit thủ công bằng cách đọc code/docs theo các nhóm: security, secret scan
  false positive, business rules, routing, pipeline/dedup, disconnect safety,
  queue/throttling, health/operations docs, production/staging safety.
- Tạo tài liệu task + report cho phase này.

Ngoài scope (KHÔNG làm trong task này):

- Không mở rộng scope, không thêm feature mới.
- Không sửa runtime code (chỉ sửa khi người dùng yêu cầu riêng sau khi thấy FAIL).
- Không test UI thủ công sâu, không tối ưu UI (để phase 2).
- Không chạy live Microsoft email / Telegram thật.
- Không sửa GitHub Actions để nới lỏng secret scan.

## Tài liệu đã đọc để đối chiếu

- `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`
- `docs/PRODUCT_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY_RULES.md`
- `docs/ROADMAP.md`
- `package.json`, `.github/workflows/ci.yml`
- Source: `services/`, `lib/`, `app/`, `prisma/schema.prisma`
- Tham chiếu task/report TASK-050 → TASK-063 qua ROADMAP.

## Nhóm kiểm tra

1. Security: không hardcode secret; không log token/refresh token/client secret/
   full verification code/full email body; không đọc/in `.env`.
2. Secret scan false positive trong docs/task/report/roadmap diff.
3. Business rules: internal staff app; customer không login; OWNER/ADMIN xem toàn
   bộ; STAFF_READ_ONLY chỉ thấy customer/mailbox được assign.
4. Routing: nhiều mailbox dùng chung reusable destination; mỗi mailbox tối đa một
   active destination.
5. Pipeline: detector → extractor → dedup; webhook + delta không gửi trùng.
6. Disconnect safety: mailbox disconnected hoặc chưa mapping hợp lệ không relay.
7. Queue/throttling: per-mailbox lock; shared-destination throttle; retry/backoff
   hữu hạn.
8. Health/operations docs khớp ROADMAP.
9. Production/staging safety: không dùng production DB / mailbox / Telegram group
   khách hàng thật trong test phase 1.

## Tiêu chí nghiệm thu

- `npm run verify` PASS.
- Có report đầy đủ findings theo Critical/High/Medium/Low.
- Kết luận rõ PASS (sang phase 2) hoặc FAIL (sửa trước).

## Yêu cầu bảo mật cho task

- Không đọc/in nội dung `.env`, `.env.local`, `.env.staging`, `.env.production`.
- Không ghi secret thật, token, client secret, database URL, Redis URL, session
  secret, Telegram bot token vào tài liệu.
- Không ghi full verification code hoặc full email body.
- Tự kiểm tra diff trước khi kết thúc để tránh secret scan false positive.

## Kết quả

Xem `docs/reports/TASK-064-final-technical-audit-phase-1.md`.
