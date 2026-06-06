# TASK-072 — Full project logic, security & live-beta readiness audit

## Mục tiêu

Audit tổng thể toàn project sau TASK-071 để tìm lỗi logic, lỗ hổng bảo mật,
khoảng trống readiness và test coverage **trước khi tiếp tục live beta / scale
vượt beta**. Task này chỉ tạo task file + audit report; **không** sửa runtime
code, không tạo migration, không đụng CI/CD.

## Bối cảnh

- Hệ thống relay verification code: Microsoft Graph (mailbox) → detect/extract →
  dedup → Telegram destination, chạy trên Next.js + Prisma + BullMQ + Redis.
- Đã trải qua chuỗi hardening gần đây: TASK-068A..D (exactly-once, scale queue,
  observability, 100-mailbox), TASK-069A..C (multilingual detect, reconnect UX,
  refresh-token classification), TASK-070 (global Telegram pacer), TASK-071
  (delta polling 403 vs reconnect loop).
- Cần một lần soát độc lập, đa góc nhìn, để chốt mức sẵn sàng live beta và lập
  danh sách task fix có ưu tiên.

## Scope được làm

- Đọc docs bắt buộc + các task/report liên quan.
- Đọc runtime/test ở chế độ **read-only** để phục vụ report.
- Tạo đúng 2 file: task file này và report tương ứng.
- Chạy `npm run verify` để xác lập baseline xanh.

## Scope KHÔNG làm

- Không sửa runtime code / test / schema / migration.
- Không sửa GitHub Actions, không nới lỏng package scripts.
- Không đọc/in nội dung `.env*`, không in giá trị biến môi trường.
- Không gọi Microsoft Graph thật, không redeem token, không gửi Telegram thật.
- Không thao tác production database, không dùng mailbox/Telegram nhóm khách thật.
- Không commit.

## Khu vực audit

1. Microsoft OAuth / refresh token / Graph request classification.
2. Webhook / delta polling / subscription renewal.
3. Reconnect loop / token issue / mailbox status transitions.
4. Dedup exactly-once / duplicate prevention.
5. Telegram routing / reusable destination / one active destination per mailbox.
6. Customer isolation / RBAC / staff assignment scope.
7. Disconnect / reconnect / mailbox readiness / mapping consistency.
8. Queue / BullMQ / Redis / locks / throttle / global pacer.
9. Prisma schema / migrations / unique constraints / schema drift.
10. Logging / secret hygiene / verification code masking.
11. Staging / production deployment docs & worker separation.
12. UI logic có thể gây hiểu nhầm cho operator khi live beta.
13. Test coverage gaps trước khi scale vượt beta.

## Bảo mật

- Không log/ghi vào docs: token, refresh token, client secret, Telegram bot
  token, database/Redis URL, encryption key, session secret, full verification
  code, full email body.
- Chỉ nhắc **tên** biến môi trường, không nhắc giá trị.
- Tránh wording dạng "tên-nhạy-cảm gán giá-trị" hoặc metadata ngắn cặp đôi cho các
  từ nhạy cảm (token, secret, key, password, auth, bearer, client secret, database
  url, connection string) để không gây secret-scan false positive.

## Output yêu cầu

- `docs/tasks/TASK-072-full-project-logic-security-live-beta-readiness-audit.md`
- `docs/reports/TASK-072-full-project-logic-security-live-beta-readiness-audit.md`

Report phải có: tóm tắt kết luận, phạm vi audit, baseline repo/test, bảng
findings theo severity, khu vực đã xác nhận ổn, test coverage gaps, live-beta
readiness checklist, rủi ro còn lại, đề xuất TASK-073+, lệnh đã chạy, phần cần
Gemini review.

## Lệnh kiểm tra

```bash
git branch --show-current
git status --short
git diff --stat
npm run verify
```

## Tiêu chí nghiệm thu

- Đã ở branch riêng `feature/task-072-full-project-audit`.
- Tạo đúng 2 file docs ở trên, không sửa file runtime/test/schema/migration/CI.
- Report phân loại findings rõ ràng theo Critical/High/Medium/Low kèm file, cách
  kiểm tra, đề xuất task fix.
- `npm run verify` PASS (baseline xanh, không bị task này làm hỏng).
- Diff sạch secret, không gây secret-scan false positive.
- Không commit.

## Cách chuyển findings thành task fix sau audit

- Mỗi finding High/Critical → một task fix riêng, scope nhỏ, có test trước (TDD).
- Gom các Medium cùng vùng (vd RBAC scope wiring) thành một task hardening.
- Low → backlog, gắn nhãn observability/UX, làm khi chạm vùng liên quan.
- Giữ nguyên ràng buộc isolation/secret hygiene khi fix; mọi thay đổi routing/
  dedup/RBAC bắt buộc kèm test regression.

## Severity rubric

- **Critical**: lộ secret/code/full email, gửi code sai khách/nhóm, bypass RBAC
  nghiêm trọng, mất dữ liệu, hoặc loop làm hỏng live beta diện rộng.
- **High**: ảnh hưởng chức năng chính live beta, reconnect sai hàng loạt, gửi
  trùng, bỏ sót code quan trọng, hoặc bypass isolation trong điều kiện thực tế.
- **Medium**: rủi ro concurrency/test coverage/edge case nên sửa trước khi scale.
- **Low**: wording/UI/docs/observability/test improvement, không chặn live beta
  nếu có workaround rõ.
