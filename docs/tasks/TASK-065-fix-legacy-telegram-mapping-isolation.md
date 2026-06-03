# TASK-065 — Fix legacy Telegram mapping API customer isolation (H1)

## Mục tiêu

Xử lý finding **H1** từ TASK-064 (audit phase 1): legacy REST API
`POST /api/telegram/mappings` và `PATCH /api/telegram/mappings/[id]` nhận **raw
`telegramChatId`** và **không** enforce customer isolation. Sửa tối thiểu để mọi
create/update mapping đi qua service-layer validation đã enforce isolation, đảm
bảo mailbox và destination thuộc đúng customer scope.

## Bối cảnh (H1)

- Route legacy gọi `createTelegramMapping`/`updateTelegramMapping` — ghi raw
  chat/group/thread vào DB, chỉ check trùng `(mailbox, chatId)` + rule
  one-active-per-mailbox. Không so sánh customer của mailbox với chủ của chat id.
- Vì raw chat id không gắn với customer nào, OWNER/ADMIN gọi route trực tiếp có
  thể route mailbox của customer A sang chat của customer B → lệch
  `docs/SECURITY_RULES.md` §5 (customer isolation).
- Đường an toàn đã tồn tại: `createTelegramMappingFromDestination` /
  `updateTelegramMappingFromDestination` — operator chọn `destinationId` (reusable
  destination thuộc một customer), chat/thread được derive server-side, và mailbox
  + destination **bắt buộc cùng customer**.

## Hướng xử lý

Chọn phương án **route legacy REST API qua đường destination-based** (đã enforce
isolation), thay vì retire route hay vá riêng từng check trên raw chat id.

1. Route REST nhận `mailboxId` + `destinationId` + `status` và gọi đường
   destination-based. Raw `telegramChatId`/group/thread không còn được trust.
2. Thêm tham số `scope?` (fail-closed) vào đường destination-based để route truyền
   customer scope của người gọi → kể cả role tương lai có scope hạn chế cũng không
   tạo/sửa mapping cho mailbox ngoài phạm vi.

## Scope

Trong scope:

- `services/telegram/telegram-mapping.service.ts` — thêm `scope?` cho
  `resolveDestinationMapping` / `createTelegramMappingFromDestination` /
  `updateTelegramMappingFromDestination`.
- `app/api/telegram/mappings/route.ts` — POST đi qua đường destination-based +
  truyền scope.
- `app/api/telegram/mappings/[id]/route.ts` — PATCH đi qua đường destination-based
  + truyền scope.
- Tests: route-level (POST/PATCH) cross-customer + service-level scope guard.

Ngoài scope (KHÔNG làm):

- Không multi-destination / broadcast.
- Không tối ưu UI.
- Không sửa M1 (dedup race), M2 (TOCTOU one-active), M3 (scope optional), L1
  (Telegram `description` log) — vẫn là backlog phase 2.
- Không sửa GitHub Actions / secret-scan, không động `.env*`.
- Giữ nguyên rule: nhiều mailbox dùng chung một reusable destination; mỗi mailbox
  tối đa một active destination.

## Tiêu chí nghiệm thu

- Route POST/PATCH không cho map mailbox của customer A sang destination của
  customer B (kể cả OWNER/ADMIN) → 409, không ghi DB.
- Raw `telegramChatId` không kèm `destinationId` → 400, không ghi DB.
- Mapping hợp lệ cùng customer vẫn pass (201 / 200).
- STAFF_READ_ONLY vẫn 403 (không có `MANAGE_TELEGRAM_MAPPINGS`).
- Giữ reusable destination sharing và one-active-destination rule.
- `npm run verify` PASS.

## Kết quả

Xem `docs/reports/TASK-065-fix-legacy-telegram-mapping-isolation.md`.
