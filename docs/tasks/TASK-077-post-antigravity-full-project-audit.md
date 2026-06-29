# TASK-077 — Post-Antigravity full project logic, security & readiness audit

## Mục tiêu

Audit tổng thể **read-only** toàn project sau khi TASK-076 hoàn tất migration
reviewer/tester độc lập từ Gemini CLI sang Antigravity CLI. Mục tiêu: xác định còn
lỗ hổng bảo mật, lỗi logic, rủi ro vận hành, thiếu test coverage, hoặc điểm cần cải
thiện nào trước live beta / scale tiếp theo. Đây **không** phải task fix runtime —
chỉ tạo 2 file docs (task + report) ghi nhận findings theo severity và đề xuất task
fix.

Đây là vòng audit kế tiếp sau TASK-072 (full audit lần trước). TASK-073/074/075 đã
đóng một số finding của TASK-072; TASK-077 xác minh lại trạng thái **code hiện tại**
của các finding còn mở và soát thêm vùng mới.

## Phạm vi audit (read-only)

- Microsoft OAuth / refresh token / Graph request classification.
- Webhook / delta polling / subscription renewal.
- Reconnect loop / token issue / mailbox status transitions.
- Dedup exactly-once / duplicate prevention (graphMessageId, internetMessageId,
  code + time-bucket).
- Telegram routing / reusable destination / one active destination per mailbox.
- Customer isolation / RBAC / staff assignment scope — đặc biệt mapping/destination
  create / update / disable / delete.
- Disconnect / reconnect / mailbox readiness / mapping consistency.
- Queue / BullMQ / Redis / locks / throttle / global pacer.
- Prisma schema / migrations / unique constraints / schema drift.
- Logging / secret hygiene / verification code masking / encryption-at-rest.
- Staging / production deployment docs & worker separation.
- UI logic dễ gây hiểu nhầm cho operator.
- Test coverage gaps trước live beta / scale.
- Tính đúng đắn của Antigravity migration (TASK-076).

## File bắt buộc đọc trước

AGENTS.md, CLAUDE.md, ANTIGRAVITY.md, docs/SECURITY_RULES.md, docs/PRODUCT_SPEC.md,
docs/ARCHITECTURE.md, docs/ROADMAP.md, và cặp task+report của TASK-072, TASK-073,
TASK-074, TASK-075, TASK-076.

## Scope KHÔNG làm (audit-only)

- KHÔNG sửa runtime code.
- KHÔNG sửa test.
- KHÔNG sửa schema / migration.
- KHÔNG sửa GitHub Actions.
- KHÔNG sửa package scripts.
- KHÔNG đọc / in / sửa `.env`, `.env.local`, `.env.staging`, `.env.production`.
- KHÔNG gọi Microsoft Graph thật.
- KHÔNG gửi Telegram thật.
- KHÔNG thao tác production database.
- KHÔNG dùng mailbox / Telegram group khách hàng thật.
- KHÔNG commit.

## Phương pháp

- Đọc trực tiếp các file source-of-truth + cặp task/report bắt buộc.
- Soát code hiện tại bằng nhiều luồng đọc song song (read-only) cho từng khu vực:
  RBAC scope mapping/destination, dedup code-bucket, renewal concurrency, webhook
  hardening, Redis pacer/locks, secret hygiene/encryption.
- Mỗi finding ghi rõ: mô tả, file liên quan (file:line), cách xác minh, rủi ro thực
  tế, đề xuất task fix.

## Lệnh kiểm tra

```bash
npm run verify
git status --short
git diff --stat
```

## Tiêu chí nghiệm thu

- Chỉ tạo đúng 2 file docs (task này + report), không đụng scope cấm.
- Report có: tóm tắt, baseline git/verify, bảng findings theo severity
  (Critical/High/Medium/Low/Info), khu vực đã xác nhận ổn, test coverage gaps,
  live-beta readiness checklist, đề xuất thứ tự task tiếp theo, và phần "Cần
  Antigravity CLI review gì".
- Không ghi secret thật / token / refresh token / client secret / Telegram bot
  token / database-Redis URL / encryption key / session secret / full verification
  code / full email body.
- `npm run verify` PASS.
- Không commit.
