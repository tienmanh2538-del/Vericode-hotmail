# TASK-085 — Multi-Worker Credential Rotation Concurrency Guard (Investigation Report)

> **Phase 1 — INVESTIGATION / ARCHITECTURE ONLY.** Report này tóm tắt investigation và cập nhật
> kiến trúc sau khi nhận được **external verification chính thức từ tài liệu Microsoft Identity Platform**.
> KHÔNG có implementation nào xảy ra (không runtime/test/schema/Redis/env/CI/UI change, không commit/push).
> Sanitized: không token/refresh token/ciphertext credential thật/client secret/Telegram bot token/
> verification code đầy đủ/full email body/DB-Redis URL.
>
> **Ownership:** artifact do **Claude Code** (coder chính) maintain và đã review/consolidate để phản
> ánh architecture đã chốt (Option A). External Microsoft semantics (mục 3) do **Human/ChatGPT** cung
> cấp/verify — không phải Claude tự xác minh.

---

## 1. Mục tiêu

Điều tra và thiết kế concurrency guard cho "broader multi-worker credential-rotation last-writer-wins race"
mà TASK-084 đã xác nhận và cố ý DEFER (A6/D4), nhằm bảo vệ tính toàn vẹn và trật tự kế thừa của
`Mailbox.encryptedRefreshToken` giữa 4 tiến trình worker và luồng OAuth reconnect của con người.

---

## 2. Kết quả điều tra Codebase (Writers & Readers)

- **Danh sách Writer vật lý vào `Mailbox.encryptedRefreshToken` (toàn repo):**
  - **W1 — OAuth connect/reconnect:** `mailbox-connect.service.ts → saveConnectedMailbox` (cập nhật credential mới + `status=ACTIVE` + `tokenLastRefreshedAt`). Đây là luồng authoritative của con người.
  - **W2 — Rotation helper:** `refresh-token-rotation.service.ts → persistRotatedRefreshToken` (chỉ ghi khi Microsoft trả token mới; cập nhật credential + `tokenLastRefreshedAt`; KHÔNG đổi status), được gọi từ 4 callers:
    1. `C1`: Subscription renewal token port (`acquireRenewalCredential`);
    2. `C2`: Delta polling token port (`createPrismaAccessTokenPort`);
    3. `C3`: Email worker token port (`createPrismaEmailAccessTokenPort`);
    4. `C4`: Reconciliation / recovery runner (reuse renewal token port).
- Hiện tại cả W1 và W2 đều là **unconditional update/create theo `id` (last-writer-wins)**, không có expected-generation predicate hay CAS.
- **TASK-084:** Chỉ bảo vệ *mailbox status* (ngăn stale renewal đổi status sang RECONNECT_REQUIRED nếu generation đã đổi), KHÔNG bảo vệ việc W2 *ghi đè credential*.

---

## 3. External Verification từ Microsoft Identity Platform & Blocker Resolution

- **External Evidence (Human/ChatGPT đã xác minh từ Microsoft Learn):**
  - Microsoft Learn: *"Refresh tokens in the Microsoft identity platform"* (cập nhật 2025-11-05) & *"OAuth 2.0 authorization code flow"*.
  - Microsoft Identity Platform **KHÔNG** tự động revoke refresh token cũ khi token đó được dùng để lấy access token mới.
  - Không có semantics "one-time-use on refresh" mặc định làm vô hiệu hóa sibling/previous tokens trong cùng grant khi redemption bình thường.
  - Nhiều refresh token có thể cùng còn hiệu lực; ứng dụng được khuyến nghị lưu token mới nhất nhận được và discard token cũ.
- **Hệ quả:**
  - Blocker về CAS-loser provider semantics được **RESOLVED**.
  - Worker CAS-thua (`count = 0`) hoàn toàn có thể **discard token mới** an toàn mà không làm hỏng token đang lưu trong DB.
  - Không cần Redis/distributed lock để serialize trước khi refresh.

---

## 4. Corrected Risk Wording

- TASK-085 **KHÔNG** mô tả rủi ro phụ thuộc vào giả định "Microsoft invalidate token cũ khi rotate".
- TASK-085 xác định rủi ro cốt lõi là **LOCAL STATE OWNERSHIP / FRESHNESS CONCURRENCY BUG**:
  1. Stale worker có thể LWW overwrite generation mới hơn do worker khác ghi.
  2. **Nguy hiểm nhất (R5):** Worker đọc G0 → Human OAuth reconnect thành công ghi generation B → Worker nhận G_a từ refresh cũ và unconditional persist đè lên B → **OAuth reconnect bị nuốt/clobber**.
  3. Vi phạm nghiêm trọng trật tự ưu tiên của local credential storage.

---

## 5. Kiến trúc đề xuất: OPTION A (DB CAS trên `Mailbox.encryptedRefreshToken`)

- **Cơ chế CAS:**
  ```text
  updateMany where:
    id = mailboxId
    AND encryptedRefreshToken = expectedGenerationG0
  data:
    encryptedRefreshToken = newGenerationG1
    tokenLastRefreshedAt  = currentTimestamp
  ```
- **Xử lý kết quả:**
  - `count = 1`: Hoàn tất chuyển giao generation, G1 trở thành current stored credential.
  - `count = 0`: Generation trong DB đã thay đổi (OAuth reconnect hoặc worker khác đã rotate) → discard G1, không ghi đè DB, không raise reconnect_required, không blind retry, access token hiện tại vẫn dùng bình thường.
- **OAuth Reconnect Priority:** W1 tiếp tục là authoritative path. Worker (expected G0) khi gặp DB đã là B sẽ nhận `count = 0` → không bao giờ ghi đè B.
- **Tương tác TASK-084:** Rotation CAS count = 0 đồng nghĩa operation mất ownership generation → downstream TASK-084 status guard fail-closed → không mark nhầm mailbox vừa reconnect.

---

## 6. Kết luận Hạ tầng (Verdicts)

- **Schema / Migration:** **NOT REQUIRED** (Sử dụng exact opaque string trên cột `Mailbox.encryptedRefreshToken` có sẵn).
- **Redis / Distributed Lock:** **NOT REQUIRED** (DB CAS là đủ; không cần distributed locking).
- **Database Transaction:** **NOT REQUIRED** (Một câu lệnh `updateMany` conditional là atomic ở cấp DB engine).

---

## 7. Chronology

- Initial investigation (BLOCKED) → External Microsoft verification supplied → Blocker resolved
  → Option A recommended → **Antigravity Final Architecture Review PASS** (finding Medium: thêm
  `status != DISABLED`) → **Implementation (Phase 2) hoàn tất**.

---

## 8. Implementation (Phase 2 — đã thực hiện)

- **Seam CAS (một nơi):** `persistRotatedRefreshToken` đổi `mailbox.update` → conditional
  `mailbox.updateMany` với predicate: `id AND status != DISABLED AND encryptedRefreshToken =
  expectedGeneration(G0)`; data ghi `encryptedRefreshToken=G1 + tokenLastRefreshedAt`. Thêm tham
  số `expectedGeneration`. Finding Medium DISABLED đã khóa trong predicate.
- **Return contract:** `{ rotated, persisted, casLost?, encryptedRefreshToken? }`. count=1 →
  persisted + trả ciphertext; count=0 → casLost, KHÔNG trả ciphertext, KHÔNG reconnect/retry;
  DB throw (infrastructure error, KHÁC CAS conflict) → helper KHÔNG swallow: log masked rồi
  **propagate error đã sanitize** (không ciphertext, không raw Prisma error), KHÔNG set casLost,
  KHÔNG biến thành reconnect; caller classify = transient → fail an toàn, retry tick sau.
- **4 caller plumbing:** renewal (`acquireRenewalCredential`, phủ luôn reconciliation), delta,
  email — mỗi caller truyền exact G0 đã đọc; interface Prisma đổi sang `updateMany`. TASK-084
  Case B: committed generation = ciphertext khi persisted, fallback G0 khi CAS-lost (status guard
  fail-closed).
- **Races (test):** worker-vs-worker (winner persist / loser discard), worker-vs-OAuth reconnect
  (DB giữ B), disconnect (DISABLED → count 0, không ghi), no-rotation (không DB write),
  CAS-lost non-fatal không mark reconnect, DB-throw propagate sanitized (không swallow, không
  casLost, không leak, caller classify transient không reconnect), secret hygiene. TASK-069C
  giữ nguyên.
- **Files runtime:** `refresh-token-rotation.service.ts`, `subscription-renewal-runner.ts`,
  `delta-polling-runner.ts`, `email-worker-runner.ts`. **Tests:** rotation service test +
  renewal/delta/email/reconciliation(×2) test.
- **Verify:** `npm run verify` PASS (exit 0, 102 test files / 1244 tests, lint + typecheck +
  build sạch).
- **Không:** schema/migration, Redis/distributed lock, transaction, OAuth redesign, TASK-069C/
  TASK-084 redesign, env/CI/UI. Chưa commit/push/ROADMAP.

**Trạng thái:** implementation hoàn tất, chờ **Antigravity Implementation Review**.
