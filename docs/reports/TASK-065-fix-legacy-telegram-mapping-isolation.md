# Report — TASK-065 Fix legacy Telegram mapping API customer isolation (H1)

## 1. Root cause

Finding **H1** (TASK-064): the legacy REST routes

- `POST /api/telegram/mappings`
- `PATCH /api/telegram/mappings/[id]`

called `createTelegramMapping` / `updateTelegramMapping`, which accept a **raw
`telegramChatId`** (+ group / thread / topic) from the request body and persist it
directly. The only invariants enforced were the duplicate `(mailbox, chatId)` check
and the one-active-mapping-per-mailbox rule (`assertNoConflict`). Neither the route
nor those service functions compared the mailbox's customer against the owner of the
chat id.

Because a raw chat id is just a number with no customer attached, there was no way
for that path to enforce isolation — an OWNER/ADMIN calling the route directly could
map a customer-A mailbox onto a customer-B chat id, violating
`docs/SECURITY_RULES.md` §5 (customer isolation). Mitigating factors at the time:
only OWNER/ADMIN hold `MANAGE_TELEGRAM_MAPPINGS` (STAFF_READ_ONLY cannot reach the
route), and the admin UI uses server actions that already go through the safe
destination-based path — but the route was still live and exploitable directly.

## 2. Cách fix

Routed the legacy REST API **through the existing destination-based service path**,
which already enforces customer isolation, instead of trusting raw chat data.

- The routes now accept `mailboxId` + `destinationId` + `status`. The chat / group /
  thread / topic are derived **server-side** from the chosen reusable destination.
  A raw `telegramChatId` in the body is ignored (and, without a `destinationId`, the
  request fails validation with 400).
- Isolation is enforced in `resolveDestinationMapping`: the mailbox and the
  destination must belong to the **same customer**, the mailbox must have a customer,
  and an ACTIVE mapping cannot point at a DISABLED destination. This is unchanged
  TASK-053 logic — the fix is reusing it from the REST surface.
- Added a fail-closed `scope?` parameter to `resolveDestinationMapping`,
  `createTelegramMappingFromDestination`, and `updateTelegramMappingFromDestination`.
  The routes resolve the caller's `CustomerScope` (`resolveCustomerScope(user)`) and
  pass it in. OWNER/ADMIN resolve to the unrestricted `all` scope (no behavior
  change), but any future caller with a restricted scope — or a signed-out viewer —
  can never create or move a mapping onto a mailbox outside their assigned customers.
  This mirrors the existing optional-scope pattern on `getTelegramMappingById`.

Preserved invariants (verified by tests): many mailboxes may still share one reusable
destination; each mailbox still has at most one active destination. No
multi-destination / broadcast behavior was added; no UI changes.

The lower-level `createTelegramMapping` / `updateTelegramMapping` primitives still
exist (used by unit tests) but are **no longer reachable from any HTTP route**, so
the H1 REST surface is closed. Retiring those primitives entirely is left as a
follow-up (see remaining risk).

## 3. File đã sửa

| File | Thay đổi |
|---|---|
| `services/telegram/telegram-mapping.service.ts` | Thêm `scope?: CustomerScope` (fail-closed) vào `resolveDestinationMapping` + hai hàm create/update destination-based. |
| `app/api/telegram/mappings/route.ts` | POST đi qua `createTelegramMappingFromDestination(body, scope)`; đổi sang error class destination-based; trả thêm `destinationId`. |
| `app/api/telegram/mappings/[id]/route.ts` | PATCH đi qua `updateTelegramMappingFromDestination(id, body, scope)`; thêm `resolveCustomerScope`; serialize thêm `destinationId`. |
| `tests/api/telegram-mappings.route.test.ts` | **Mới** — route-level POST/PATCH end-to-end (real service, mocked Prisma). |
| `tests/unit/telegram/telegram-mapping.service.test.ts` | Thêm describe cho `scope` guard (create/update). |
| `docs/tasks/TASK-065-*.md`, `docs/reports/TASK-065-*.md`, `docs/ROADMAP.md` | Tài liệu task/report + cập nhật roadmap. |

## 4. Test đã thêm/chạy

Route-level (`tests/api/telegram-mappings.route.test.ts`, 9 tests):

- POST: STAFF_READ_ONLY → 403, không ghi DB.
- POST: mailbox customer A → destination customer B → **409**, `create` không gọi.
- POST: **OWNER** cũng bị chặn cross-customer → 409 (admin không bypass).
- POST: raw `telegramChatId` không kèm `destinationId` → **400**, không chạm DB.
- POST: cùng customer hợp lệ → 201; chat/thread derive từ destination, không từ request.
- POST: one-active-destination-per-mailbox vẫn enforce → 409 khi đã có active.
- PATCH: re-point sang destination khác customer → 409, `update` không gọi.
- PATCH: cùng customer hợp lệ → 200.
- PATCH: STAFF_READ_ONLY → 403.

Service-level (`telegram-mapping.service.test.ts`, +4 tests):

- Create với scope loại trừ customer của mailbox → reject (fail trước cả khi load destination).
- Create với assigned scope chứa customer → pass.
- Create với scope `all` (OWNER/ADMIN) → pass.
- Update onto out-of-scope mailbox → reject.

Test giữ nguyên (regression): reusable destination sharing
("allows a second mailbox of the same customer to share the destination") và
one-active-destination ("rejects a second ACTIVE mapping for the same mailbox") vẫn pass.

Lệnh đã chạy:

- `npx vitest run tests/api/telegram-mappings.route.test.ts tests/unit/telegram/telegram-mapping.service.test.ts` → **43 passed**.
- `npm run verify` (db:generate + lint + typecheck + test + build) → **PASS**:
  lint/typecheck sạch, **870 tests / 76 files passed** (0 fail), build 28 routes OK.

Ghi chú: các dòng `stderr` khi chạy test là log có chủ đích trong test secret-hygiene
(chat id giả `-100`, `httpStatus`, `microsoftErrorCode`) — chứng minh masking hoạt
động, không phải lỗi.

## 5. Rủi ro còn lại

- **disable / delete by id** (`PATCH ?action=disable`, `DELETE`) vẫn chỉ check
  permission global, chưa resolve customer-scope (finding L2 của TASK-064). Rủi ro
  thấp: chúng thao tác trên mapping đã tồn tại theo id, **không** nhận raw chat data;
  OWNER/ADMIN đã có toàn quyền nhìn mọi customer, STAFF bị chặn bởi permission. Để
  lại làm follow-up (thêm scope guard qua `getTelegramMappingById(id, scope)`).
- **Primitive raw** `createTelegramMapping`/`updateTelegramMapping` vẫn export (còn
  test dùng). Không còn route nào gọi → H1 đóng, nhưng nên retire hẳn ở task dọn dẹp
  sau để loại bỏ rủi ro tái sử dụng nhầm.
- **M2 (TOCTOU one-active-mapping)** chưa transactional — vẫn là backlog phase 2;
  task này không làm xấu đi (dùng lại đúng `assertNoConflictForDestination`).
- **API contract đổi**: route giờ yêu cầu `destinationId` thay vì raw `telegramChatId`.
  Đây là hardening có chủ đích; UI dùng server actions nên không ảnh hưởng. Caller
  ngoài (nếu có) gửi shape cũ sẽ nhận 400 — cần biết khi tích hợp.
- M1 (dedup race), M3 (scope optional ở read services), L1 (Telegram `description`
  log) ngoài scope task này — giữ nguyên backlog phase 2.

## 6. Kết luận

**PASS.** H1 (REST mapping legacy bỏ qua customer isolation) đã được xử lý: cả POST
và PATCH đi qua đường destination-based enforce isolation; cross-customer bị chặn kể
cả với OWNER/ADMIN; raw `telegramChatId` không còn được trust; STAFF_READ_ONLY vẫn
403; reusable destination sharing và one-active-destination rule được giữ nguyên.
`npm run verify` PASS (870 tests, lint/typecheck/build sạch). Không log/ghi secret,
token, full code, hay full email body; không sửa GitHub Actions/secret-scan;
không động `.env*`.

## 7. Self-check secret-scan

- Báo cáo không chứa token/secret/connection string/Telegram bot token thật.
- Các chat id trong test (`-100…`) là giá trị giả, không phải dữ liệu khách hàng thật.
- Không viết tên biến nhạy cảm liền sau dấu `=` kèm giá trị.

## 8. Sẵn sàng Gemini review

Có. Thay đổi gồm: runtime (1 service + 2 route), 2 file test, 3 tài liệu. Không sửa
`.env*`, không sửa GitHub Actions, không nới lỏng secret-scan.
