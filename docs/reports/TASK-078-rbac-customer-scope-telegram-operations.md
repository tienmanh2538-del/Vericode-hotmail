# TASK-078 — Report: RBAC / customer-scope hardening for Telegram operations

## 1. Tóm tắt đã thay đổi gì

Đóng finding Medium **M1/M4** của TASK-077: customer-scope giờ được enforce
**fail-closed** trên toàn bộ Telegram mapping & reusable destination operations đi
qua UI, API, và server action. Trước đây service layer hỗ trợ `scope` nhưng nhiều
caller bỏ qua (fail-open) và một số hàm mutation chưa có tham số scope.

Nguyên tắc áp dụng (nhất quán với pattern TASK-045/TASK-065 sẵn có):

- Mọi caller UI/API/action **resolve scope của user hiện tại** qua
  `resolveCustomerScope(user)` và truyền vào service.
- Hàm service mutation nhận `scope?` và **fail-closed** khi scope thuộc loại
  `assigned` mà customer của resource nằm ngoài scope (hoặc resource không tồn tại).
- Scope `all` (OWNER/ADMIN) là no-op, **không** tốn thêm query — giữ behavior cũ và
  test cũ xanh. Caller worker/system bỏ scope vẫn unscoped như hợp đồng cũ.
- Out-of-scope ở API được trả **404** (không lộ tồn tại resource), không phải 403.

Không đụng rule "mỗi mailbox tối đa một active destination", không đổi
routing/dedup/queue/delta/renewal/webhook, không sửa schema/migration, không UI
redesign.

## 2. File đã thay đổi

### Thêm mới

- `services/telegram/telegram-scope-error.ts` — `TelegramScopeError` dùng chung cho
  fail-closed scope; API map về 404.
- `docs/tasks/TASK-078-rbac-customer-scope-telegram-operations.md` (task).
- `docs/reports/TASK-078-rbac-customer-scope-telegram-operations.md` (report này).

### Service (thêm `scope?` + guard fail-closed)

- `services/telegram/telegram-mapping.service.ts`: thêm `scope?` cho
  `disableTelegramMapping`, `deleteTelegramMapping`; helper `assertMappingInScope`
  (chỉ lookup khi scope `assigned`; row thiếu hoặc ngoài scope → `TelegramScopeError`).
- `services/telegram/telegram-destination.service.ts`: thêm `scope?` cho
  `createTelegramDestination` (chặn customer ngoài scope),
  `updateTelegramDestination` (chặn cả destination hiện tại lẫn customer đích khi
  đổi `customerId`), `disableTelegramDestination`; helper `assertDestinationInScope`.

### Caller (truyền scope)

- `services/telegram/mapping-actions.ts`: create/update/disable/delete đều resolve
  scope từ user của `requirePermission` và truyền vào service.
- `services/telegram/destination-actions.ts`: create/update/disable tương tự.
- `app/api/telegram/mappings/[id]/route.ts`: nhánh `?action=disable` và `DELETE`
  truyền scope; map `TelegramScopeError` → 404 ở cả PATCH catch và DELETE catch.
  (PATCH update đã truyền scope từ TASK-065 — gộp về một lần resolve scope.)
- `app/admin/telegram/[id]/edit/page.tsx`: read-by-id truyền scope (out-of-scope →
  `notFound`); dropdown mailbox + destination scope theo `assigned`.
- `app/admin/telegram/destinations/[id]/edit/page.tsx`: read-by-id truyền scope
  (out-of-scope → `notFound`).

### Test (regression)

- `tests/unit/telegram/telegram-mapping.service.test.ts`: +6 test cho disable/delete
  scope (assigned exclude → throw + no mutation; assigned include → mutate; `all` →
  skip lookup; row not found → fail-closed).
- `tests/unit/telegram/telegram-destination.service.test.ts`: +7 test cho
  create/update/disable scope (customer ngoài scope, đổi customer ra ngoài scope,
  edit destination ngoài scope, in-scope hợp lệ, `all` skip lookup).
- `tests/api/telegram-mappings.route.test.ts`: +4 test (STAFF_READ_ONLY disable/delete
  → 403 không mutate; ADMIN disable/delete → 200, không cần lookup scope).

## 3. Test/lint/build PASS hay FAIL

**PASS.** `npm run verify` exit code 0:
- Lint + typecheck: sạch.
- Test: **1098 tests passed / 91 test files** (baseline 1081 → +17 test mới).
- Build: `Compiled successfully`.

## 4. Kết quả npm run verify

`npm run verify` (db:generate + lint + typecheck + test + build) → **PASS (exit 0)**.
Các dòng `[error]`/`[warn]` trong log là log của test negative-path (mong đợi), không
phải lỗi.

## 5. git status --short

```
 M app/admin/telegram/[id]/edit/page.tsx
 M app/admin/telegram/destinations/[id]/edit/page.tsx
 M app/api/telegram/mappings/[id]/route.ts
 M services/telegram/destination-actions.ts
 M services/telegram/mapping-actions.ts
 M services/telegram/telegram-destination.service.ts
 M services/telegram/telegram-mapping.service.ts
 M tests/api/telegram-mappings.route.test.ts
 M tests/unit/telegram/telegram-destination.service.test.ts
 M tests/unit/telegram/telegram-mapping.service.test.ts
?? docs/tasks/TASK-078-rbac-customer-scope-telegram-operations.md
?? services/telegram/telegram-scope-error.ts
```
(`docs/reports/TASK-078-...md` cũng là file mới, thêm sau khi viết report này.)

## 6. git diff --stat

```
 app/admin/telegram/[id]/edit/page.tsx              | 21 +++--
 app/admin/telegram/destinations/[id]/edit/page.tsx |  7 +-
 app/api/telegram/mappings/[id]/route.ts            | 38 +++++++--
 services/telegram/destination-actions.ts           | 16 ++--
 services/telegram/mapping-actions.ts               | 21 +++--
 services/telegram/telegram-destination.service.ts  | 42 ++++++++++
 services/telegram/telegram-mapping.service.ts      | 28 ++++++-
 tests/api/telegram-mappings.route.test.ts          | 67 +++++++++++++++-
 tests/unit/telegram/telegram-destination.service.test.ts | 90 +++++++++++++
 tests/unit/telegram/telegram-mapping.service.test.ts     | 60 +++++++++++
 10 files changed, 361 insertions(+), 29 deletions(-)
```
(Hai file mới `telegram-scope-error.ts` + task/report là untracked nên không nằm
trong diff --stat.)

## 7. Phần cần Antigravity CLI review kỹ

- **Bao phủ caller:** xác nhận đã wire scope cho **mọi** đường UI/API/action của
  mapping/destination (không còn caller fail-open). Đặc biệt nhánh disable/delete API
  và 4 server action.
- **Fail-closed semantics:** `assertMappingInScope`/`assertDestinationInScope` coi
  "row không tồn tại" cũng là `TelegramScopeError` (404) khi scope `assigned` — xác
  nhận đây là hành vi mong muốn (không lộ tồn tại) và không phá luồng OWNER/ADMIN.
- **updateTelegramDestination:** kiểm tra cả customer hiện tại lẫn customer đích khi
  đổi `customerId` — xác nhận không có đường "di chuyển destination ra/vào ngoài
  scope".
- **Tương thích worker/system:** bỏ scope (`undefined`) giữ unscoped — xác nhận không
  caller production nào vô tình mất enforcement.
- **Giới hạn còn lại (defense-in-depth, ngoài scope task):** dropdown customer ở trang
  edit destination (`listCustomers()`) chưa scope; action vẫn fail-closed nên không
  phải lỗ ghi, chỉ là rò danh sách tên customer cho role scope-limited (hiện chỉ
  OWNER/ADMIN chạm tới). Đề xuất theo dõi ở task dọn dẹp.
- **Bất biến giữ nguyên:** customer isolation cross-customer (TASK-065),
  one-active-destination, không multi-destination/broadcast — xác nhận không
  regression.

## 8. Không commit

Đã giữ nguyên, không commit (chờ Antigravity CLI review). Đã tự kiểm tra diff với
pattern secret-scan của CI — sạch, không lộ thông tin nhạy cảm, không ghi nguyên tên
nhánh Git đầy đủ trong docs.
