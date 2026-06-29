# TASK-078 — RBAC / customer-scope hardening for Telegram mapping & destination operations

## Mục tiêu

Siết RBAC/customer-scope cho **toàn bộ** Telegram mapping và reusable destination
operations (get/list/update/disable/delete) đi qua UI, API, hoặc server action.
Đóng finding Medium **M1/M4** của TASK-077: service layer đã hỗ trợ `scope` nhưng
nhiều caller (edit page, server action, nhánh disable/delete của API) bỏ qua scope,
và một số hàm service mutation chưa có tham số scope → bỏ scope là **fail-open**.

Yêu cầu: mọi thao tác đọc/ghi mapping/destination từ UI/API/server action phải dùng
access scope của user hiện tại và **fail-closed** khi resource nằm ngoài scope.

## Bối cảnh

- TASK-065 đã enforce customer isolation ở đường **create/update mapping qua
  destination** (mailbox và destination phải cùng customer) và đã truyền scope ở
  `POST`/`PATCH-update` của API. Nhưng:
  - `disableTelegramMapping`, `deleteTelegramMapping`, `disableTelegramDestination`,
    `updateTelegramDestination`, `createTelegramDestination` **chưa có** tham số scope.
  - Edit page mapping/destination gọi `getTelegramMappingById` /
    `getTelegramDestinationById` **không truyền scope** → đọc fail-open.
  - Server action (mapping + destination) gọi service **không truyền scope**.
  - Nhánh `?action=disable` và `DELETE` của API mapping **không truyền scope**.
- Hiện chỉ OWNER/ADMIN (scope `all`) có `MANAGE_TELEGRAM_MAPPINGS`, nên gap là
  **latent** (chưa exploit được). Task này đóng gap trước khi có thể thêm bất kỳ
  role ghi bị giới hạn scope.

## Scope được làm

1. Tạo task file này.
2. Thêm `services/telegram/telegram-scope-error.ts` — `TelegramScopeError` dùng chung
   cho fail-closed scope (map về 404 ở API để không lộ tồn tại resource).
3. `telegram-mapping.service.ts`: thêm tham số `scope?` fail-closed cho
   `disableTelegramMapping`, `deleteTelegramMapping` (chỉ enforce khi scope
   `assigned`; `all`/không scope giữ behavior cũ).
4. `telegram-destination.service.ts`: thêm `scope?` fail-closed cho
   `createTelegramDestination`, `updateTelegramDestination`,
   `disableTelegramDestination` (enforce customer của destination — cả bản ghi hiện
   tại lẫn customer đích khi đổi customerId).
5. Wire scope ở mọi caller UI/API/action:
   - `mapping-actions.ts` (create/update/disable/delete) + `destination-actions.ts`
     (create/update/disable): resolve scope từ user của `requirePermission` và truyền
     vào service.
   - `app/api/telegram/mappings/[id]/route.ts`: truyền scope cho disable + delete;
     map `TelegramScopeError` → 404.
   - `app/admin/telegram/[id]/edit/page.tsx` &
     `app/admin/telegram/destinations/[id]/edit/page.tsx`: read-by-id truyền scope
     (out-of-scope → notFound) + scope cho dropdown list nơi đã hỗ trợ.
6. Thêm regression tests (xem mục Test).
7. Tạo report.

## Test bắt buộc

- Role scope-limited (`assigned` không chứa customer của resource) KHÔNG thể
  update/disable/delete mapping hoặc destination → throw, không mutate.
- Role scope-limited không thể read/edit-load mapping/destination của customer khác
  (get-by-id trả null/fail-closed).
- Cross-customer mailbox ↔ destination vẫn bị chặn (giữ TASK-065).
- OWNER/ADMIN (scope `all`) vẫn thao tác hợp lệ.
- STAFF_READ_ONLY vẫn bị chặn ở permission (403) — giữ nguyên.
- Rule **mỗi mailbox tối đa một active Telegram destination** vẫn giữ nguyên.
- API: disable/delete out-of-scope → 404 (không lộ tồn tại); admin/all → vẫn 200.

## Scope KHÔNG làm

- Không UI redesign; không multi-destination/broadcast; không đổi rule một-active.
- Không sửa queue/dedup/delta/renewal/webhook rate-limit.
- Không gọi Microsoft Graph thật, không gửi Telegram thật, không production DB.
- Không sửa schema/migration (không cần — chỉ thêm tham số + guard ở tầng service).
- Không sửa `customer.service`/staff service (chỉ dùng `resolveCustomerScope`).
- Không sửa `.env*`, GitHub Actions, hay package scripts.
- Không commit.

## Lệnh kiểm tra

```bash
npm run verify
git status --short
git diff --stat
```

## Tiêu chí nghiệm thu

- Mọi caller UI/API/action của mapping/destination truyền scope của user hiện tại.
- Hàm mutation service fail-closed khi scope `assigned` không chứa customer resource.
- Regression tests phủ các trường hợp ở mục Test, `npm run verify` PASS.
- Không đụng scope cấm; không ghi thông tin nhạy cảm vào docs.
- Không commit (chờ Antigravity CLI review).
