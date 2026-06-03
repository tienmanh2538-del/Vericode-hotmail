# Report — TASK-064 Final technical audit & phase 1 test review

> Test phase 1 = technical audit + automated test/review. Chưa test UI thực tế
> sâu, chưa tối ưu UI. Không sửa runtime code trong phase này.

## 1. Tình trạng Git ban đầu

- Branch: đúng nhánh feature của TASK-064 (`git branch --show-current` khớp branch task này).
- `git status --short`: trống (working tree sạch trước khi tạo tài liệu task/report).
- `git diff --stat`: trống.

## 2. Lệnh đã chạy

| Lệnh | Mục đích | Kết quả |
|---|---|---|
| `git branch --show-current` / `git status --short` / `git diff --stat` | Trạng thái Git | Clean, đúng branch |
| `npm run verify` | db:generate + lint + typecheck + test + build | **PASS** (exit 0) |
| Grep `console.*`, `.env` reads, secret patterns | Security scan tĩnh | Không có vi phạm trong production path |
| Đọc `services/`, `lib/`, `app/`, `prisma/schema.prisma` | Audit business logic | Xem mục 5 |

## 3. Kết quả `npm run verify`

**PASS** (exit code 0).

- `db:generate` (prisma generate): OK.
- `lint` (eslint): OK, không lỗi.
- `typecheck` (tsc --noEmit): OK.
- `test` (vitest run): **857 tests passed / 75 test files**, 0 fail.
- `build` (next build): OK, 28 route biên dịch thành công.

Ghi chú: các dòng `stderr` xuất hiện khi chạy test là **log có chủ đích trong
test secret-hygiene** (ví dụ `errorName`, `httpStatus`, `chatId: '-100'` là chat id
giả) — chúng chứng minh việc mask hoạt động, không phải lỗi.

## 4. Khu vực đã kiểm tra

- [x] Secret hygiene: hardcode secret, log token/refresh token/client secret/full
      code/full email body, đọc `.env`.
- [x] Logger masking (`lib/logger.ts`) + masking verification code (`lib/mask.ts`,
      `code-extractor.service.ts`).
- [x] Token encryption at rest (`lib/security/encryption.ts`, refresh-token rotation).
- [x] RBAC: OWNER/ADMIN vs STAFF_READ_ONLY, scope theo assigned customer, fail-closed.
- [x] Production auth fail-closed (TASK-057), customer không login/portal.
- [x] Routing: one-mailbox-one-active-destination + reusable destination dùng chung.
- [x] Customer isolation khi map mailbox → destination.
- [x] Pipeline detector → extractor → dedup.
- [x] Dedup webhook + delta polling (unique `[mailboxId, graphMessageId]`).
- [x] Disconnect safety (skip trước Graph fetch và trước Telegram send, re-check tại
      thời điểm xử lý).
- [x] Queue: per-mailbox lock, shared-destination throttle, retry/backoff hữu hạn.
- [x] Health dashboard scope (TASK-056).
- [x] Operations docs khớp ROADMAP (onboarding, daily ops, incident runbook,
      limited beta, scale-up).
- [x] Production/staging safety trong test & docs phase 1.
- [x] CI secret-scan pattern (`.github/workflows/ci.yml`) — self-check report này.

## 5. Bảng findings

### Critical

Không có.

### High

| ID | Vấn đề | File liên quan | Đánh giá |
|---|---|---|---|
| H1 | **REST API mapping legacy bỏ qua customer isolation.** `POST /api/telegram/mappings` và `PATCH /api/telegram/mappings/[id]` gọi `createTelegramMapping`/`updateTelegramMapping`, nhận **raw `telegramChatId`** và **không** so sánh `mailbox.customerId` với chủ của chat id. `assertNoConflict` chỉ kiểm tra trùng target + rule one-active-per-mailbox, không có check customer. Điều này lệch với SECURITY_RULES §5 (customer isolation). | `app/api/telegram/mappings/route.ts:50-74`, `app/api/telegram/mappings/[id]/route.ts`, `services/telegram/telegram-mapping.service.ts:225-280`, `:184-223` (so với đường an toàn `resolveDestinationMapping` `:335-341`) | Có giảm nhẹ rủi ro: (a) chỉ OWNER/ADMIN có `MANAGE_TELEGRAM_MAPPINGS` (STAFF_READ_ONLY **không** có → không phải staff escalation); (b) UI hiện dùng đường destination-based có enforce isolation (`mapping-actions.ts`), route raw này **không** gắn vào UI. Nhưng route vẫn live, OWNER/ADMIN có thể gọi trực tiếp và route nhầm code của customer A sang chat của customer B. → **Phải xử lý trước production**: retire route, hoặc route qua đường destination, hoặc thêm validation isolation + customer-scope. |

### Medium

| ID | Vấn đề | File liên quan | Đánh giá |
|---|---|---|---|
| M1 | **Dedup là read-then-write, chưa bắt P2002.** `claimMessageForProcessing` đọc (`checkProcessedMessageDuplicate`) rồi `store.create` nhưng không trong transaction và không catch lỗi unique-constraint (P2002). "Exactly-once" hiện dựa vào **in-process per-mailbox lock** (chỉ serialize trong 1 tiến trình worker). Với ≥2 worker replica, cửa sổ gửi trùng / lỗi ném mở lại (P2002 ném lên → BullMQ retry, không phải duplicate-skip sạch). | `services/email/deduplication.service.ts:287-300`, `services/email/prisma-processed-message-store.ts:103-118`, `services/queue/mailbox-processing-lock.ts:9-14` | Khớp đúng rủi ro đã ghi nhận ở TASK-055 (lock chỉ trong một tiến trình). An toàn cho deployment single-worker hiện tại. **Phase 2 / trước khi scale ngang**: thêm catch P2002 → coi như duplicate, và lock chia sẻ (Redis) trước khi chạy nhiều worker. |
| M2 | **One-active-mapping guard không transactional (TOCTOU).** `assertNoConflict` `findFirst` rồi `create`/`update` riêng, không transaction và không partial unique index trên `(mailboxId, status=ACTIVE)`. Hai request tạo đồng thời cho cùng mailbox có thể cùng vượt qua check. | `services/telegram/telegram-mapping.service.ts:184-223`, `prisma/schema.prisma:168-172` | Single-worker / thao tác admin tuần tự → rủi ro thấp thực tế. Phase 2: thêm test concurrency, cân nhắc partial unique index. |
| M3 | **Scope là tham số optional ở read services.** `customer.service`, `telegram-mapping.service`, `telegram-destination.service`, `mailbox-list.service` nhận `scope` optional; bỏ qua → trả full data (chủ ý cho worker/system). Mọi caller admin đã audit đều truyền scope, nhưng không có bảo đảm ở mức type → rủi ro drift về sau. | `services/customers/customer.service.ts:19`, `services/telegram/telegram-mapping.service.ts:157`, `services/telegram/telegram-destination.service.ts:88`, `lib/auth/access-scope.ts` | Phase 2: thêm regression test / lint guard rằng route user-facing luôn truyền scope. |

### Low

| ID | Vấn đề | File liên quan | Đánh giá |
|---|---|---|---|
| L1 | **Field `description` từ Telegram API được log không mask.** Key `description` không nằm trong `SENSITIVE_KEYS`, là text lỗi tự do do bên ngoài (Telegram) trả về, lọt vào log nguyên văn. Không chứa credential (`redactSensitiveText` vẫn chặn chuỗi dạng token), nhưng là external text chưa lọc. | `services/telegram/telegram-sender.service.ts:189-193`, `lib/logger.ts:11-24` | Phase 2: thêm `description` vào sanitizer hoặc đổi tên key (vd `telegramErrorCategory`). |
| L2 | **Route mutation mapping legacy `[id]` (PATCH/DELETE/disable) không resolve customer-scope** — chỉ check permission global, giống H1 nhưng cho update/disable. | `app/api/telegram/mappings/[id]/route.ts` | Cùng caveat admin-only như H1; xử lý chung với H1. |

## 6. Khu vực sạch (không phát hiện vấn đề)

- **Hardcode secret**: Không có secret thật trong `services/`, `lib/`, `app/`,
  `scripts/`. Mọi giá trị đọc từ `process.env` qua `lib/env.ts`. Giá trị fake trong
  test có nhãn rõ ("fake", "TEST").
- **Đọc `.env`**: Không có code đọc/in `.env*`. Các comment trong service chỉ khẳng
  định "never read .env".
- **`console.log` trong production path**: Không. Chỉ có trong `lib/logger.ts` (wrapper
  hợp lệ) và trong docs/skill examples.
- **Masking verification code**: Code luôn mask trước khi log (`maskedCode`);
  `code-event-log.service.ts` chủ động reject chuỗi dạng `^\d{4,}$`.
- **Token encryption at rest**: AES-256-GCM, IV random/lần; refresh token mới được
  lưu lại khi Microsoft rotate (`refresh-token-rotation.service.ts`).
- **Error messages**: Không lộ secret/code/full body (chỉ enum kind + httpStatus).
- **RBAC fail-closed**: STAFF không assignment → scope rỗng → 0 row (Prisma `in: []`).
  Role/userId chỉ lấy từ session verify server-side; không đọc từ header/cookie chưa
  verify.
- **Production auth fail-closed**: production/test/default → `getCurrentUser` trả null;
  staging passphrase login không dùng được ở production. Không có route customer
  login/signup/portal.
- **Routing**: reusable destination dùng chung bởi nhiều mailbox = hợp lệ; mỗi mailbox
  vẫn tối đa một active destination (guard service-layer).
- **Disconnect safety**: mailbox không ACTIVE bị skip **trước** khi lấy token/gọi Graph;
  mailbox không có active mapping hợp lệ bị skip **trước** khi gửi Telegram; status được
  re-check tại thời điểm xử lý (job chỉ mang `mailboxId`, đọc DB tươi).
- **Queue safety**: per-mailbox lock có TTL (hết hạn, release trong `finally`); busy →
  defer có giới hạn (BullMQ `attempts: 3` + backoff). Shared-destination throttle có cận
  (`maxWaitMs`). Telegram retry hữu hạn (4 lần, `retry_after` cap 60s). Không retry vô hạn.
- **Health dashboard scope**: count mailbox scope theo assigned customer; operational/
  infra checks chỉ hiện cho OWNER/ADMIN.
- **Production/staging safety**: CI dùng `DATABASE_URL` placeholder
  (`postgresql://user:password@localhost:5432/verification_tool` — không phải production);
  test dùng key sinh tại chỗ + token fake; docs dùng placeholder. Không có production DB /
  mailbox thật / Telegram group khách hàng thật trong test & docs phase 1.
- **Operations docs**: onboarding (TASK-061), daily ops (TASK-062), incident runbook
  (TASK-060), limited beta (TASK-059), scale-up (TASK-063) — khớp ROADMAP, docs-only,
  giữ nguyên các guardrail.

## 7. Rủi ro còn lại — chuyển sang test phase 2

1. **H1 — Isolation trên REST API mapping legacy**: quyết định retire / route qua
   destination / thêm validation; viết test cross-customer cho mọi route mutation mapping
   (POST/PATCH/DELETE/disable).
2. **M1 — Exactly-once khi scale ngang**: thêm catch P2002 + lock chia sẻ (Redis); test
   webhook + delta cùng `graphMessageId` chỉ gửi Telegram đúng 1 lần; test đặc tả giới
   hạn multi-process.
3. **M2 — TOCTOU one-active-mapping**: test concurrency; cân nhắc partial unique index.
4. **M3 — Scope optional**: guard/lint + integration test fail-closed cho STAFF không
   assignment.
5. **L1 — Telegram `description` unmasked**: thêm vào sanitizer hoặc đổi tên key.
6. **Live Microsoft email path** (webhook / delta / duplicate bằng email thật): chưa chạy
   (defer từ TASK-051) — cần internal beta / product trial.
7. **Production sign-in provider thật**: chưa có → admin UI production fail-closed; staff
   beta chưa usable qua UI cho tới khi thêm provider (TASK-057/059).
8. **Scale thật theo giai đoạn** với mailbox/Telegram thật (TASK-054/063): chưa chạy.
9. **UI**: chưa test thủ công sâu, chưa tối ưu — toàn bộ thuộc phase 2 (ngoài scope phase 1).

## 8. Kết luận

**CONDITIONAL PASS — test phase 1 (technical audit + automated review) HOÀN TẤT vai trò
audit, nghiệm thu có điều kiện.**

> Cập nhật sau Gemini review: Gemini kết luận **CONDITIONAL PASS** — `npm run verify`
> PASS, có thể nghiệm thu TASK-064 và chuyển sang test phase 2, **với điều kiện** ghi nhận
> rõ backlog/risk H1 (High), M1 (Medium), M2 (Medium) và mở task fix H1 trước khi đưa vào
> production / staff real use.

Căn cứ:

- `npm run verify` **PASS** (857 tests, lint/typecheck/build sạch).
- **Không có finding Critical.**
- Các business rule cốt lõi (RBAC + scope, routing one-active + reusable destination,
  pipeline dedup, disconnect safety, queue/throttle/retry hữu hạn, secret/token/code
  masking, production auth fail-closed) đều **CONFIRMED** ở mức service layer.

→ **TASK-064 đã hoàn tất vai trò audit phase 1 và được nghiệm thu (conditional pass).
Có thể chuyển sang test phase 2.** Đây **không** phải PASS tuyệt đối: việc chuyển phase
kèm các điều kiện backlog bắt buộc bên dưới.

### Blocker / risk chuyển backlog

| ID | Mức | Điều kiện bắt buộc |
|---|---|---|
| H1 | High | Legacy Telegram mapping API `POST/PATCH /api/telegram/mappings[/id]` có thể bypass customer isolation khi dùng raw `telegramChatId`. **Phải fix trước production / staff real use.** Mở task riêng (đề xuất **TASK-065**). Hiện giảm nhẹ: chỉ OWNER/ADMIN, không lộ qua UI — nhưng không được coi là đã đóng. |
| M1 | Medium | Dedup race condition (read-then-write, chưa bắt P2002). **Phải xử lý trước khi chạy nhiều worker replica.** Single-worker hiện tại an toàn. |
| M2 | Medium | One-active-mapping guard có TOCTOU risk (chưa transaction / partial unique index). Nên xử lý trong phase 1 hoặc **đầu phase 2**. |

M3 (scope optional) và L1 (Telegram `description` log) giữ làm đầu việc cải thiện phase 2
(không chặn nghiệm thu).

### Đề xuất task tiếp theo

- **TASK-065 — Fix legacy Telegram mapping API customer isolation (H1).** Quyết định
  hướng: retire route legacy, hoặc route qua đường destination-based (đã enforce
  isolation), hoặc thêm validation isolation + customer-scope vào service legacy. Kèm
  test cross-customer cho mọi route mutation mapping (POST/PATCH/DELETE/disable). Đây là
  điều kiện cho phép đưa hệ thống tới production / staff real use.
- Sau TASK-065: xử lý M1 trước khi scale ngang nhiều worker; xử lý M2 ở đầu phase 2.

Lưu ý quy trình: phase này **không** sửa runtime code (theo yêu cầu task). H1/M1/M2/M3/L1
được ghi lại làm backlog; sửa H1 sẽ thực hiện trong TASK-065 (thay đổi code riêng +
Gemini review).

## 9. Self-check secret-scan (tránh false positive)

- Report này **không** viết bất kỳ token/secret/connection string/Telegram bot token
  thật nào.
- Tránh các pattern mà CI secret-scan bắt: không viết tên biến nhạy cảm liền sau dấu `=`
  với giá trị; chỉ dùng tên biến trần khi cần.
- `DATABASE_URL` placeholder nêu trong mục 6 trùng đúng giá trị placeholder đã có sẵn
  trong `.github/workflows/ci.yml` (user/password mẫu localhost), không phải secret thật.
- **Quan sát về CRLF & secret-scan (informational, không phải lỗi):** chạy `git grep`
  CI pattern trên **working tree Windows** (repo có `core.autocrlf=true`) có vẻ khớp vài
  dòng placeholder rỗng dạng `VARNAME=` trong `deployment/staging/env.staging.example`,
  `docs/tasks/TASK-017`, `docs/tasks/TASK-039`. Nguyên nhân: working tree có CRLF nên ký
  tự `\r` sau `=` bị `.+` bắt. Nhưng **blob đã commit là LF-only** — chạy
  `git grep <PATTERN> HEAD` (đúng cái CI Linux thấy) cho kết quả **CLEAN**, nên CI
  secret-scan vẫn PASS. Docs TASK-064 không chứa bất kỳ pattern `VARNAME=` nhạy cảm nào
  → clean ở cả working tree lẫn committed. Đây là điểm fragile nhỏ của secret-scan (nhạy
  với line-ending); ghi nhận để phase 2 cân nhắc, không cần sửa cho phase 1.

## 10. Sẵn sàng Gemini review

Có. Report đã cập nhật theo Gemini review (kết luận **CONDITIONAL PASS**, ghi rõ backlog
H1/M1/M2 và đề xuất TASK-065). Bản cập nhật này chỉ sửa docs, không đổi runtime/test/
`.env*`/GitHub Actions, sẵn sàng để Gemini review lại lần cuối nếu cần.
