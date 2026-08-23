# TASK-085 — Multi-Worker Credential Rotation Concurrency Guard

## Trạng thái phase

**PHASE 2 — IMPLEMENTATION (đã hoàn tất, chờ Antigravity Implementation Review).**
Antigravity CLI đã hoàn tất **Final Architecture Review = PASS** (kèm một finding Medium
BẮT BUỘC: CAS phải thêm `status != DISABLED`). Kiến trúc chốt = **Option A (DB CAS trên
`Mailbox.encryptedRefreshToken` có sẵn)** đã được **implement** cùng finding DISABLED; runtime
+ tests đã viết; `npm run verify` PASS. Blocker external trước đây (CAS-loser provider
semantics) đã **RESOLVED** nhờ Human/ChatGPT verify từ Microsoft Identity Platform docs.
Chi tiết implementation ở **PHẦN IMPLEMENTATION (§I1–§I6)** cuối tài liệu. KHÔNG schema/
migration/Redis/lock/transaction/env/CI/UI; KHÔNG commit/push/ROADMAP.

> **Ownership:** artifact do **Claude Code** (coder chính) maintain và implement. Phần external
> Microsoft Identity Platform semantics (mục 4) do **Human/ChatGPT** cung cấp/verify, KHÔNG phải
> Claude tự xác minh. History investigation/architecture (mục 1–18) được giữ nguyên bên dưới.

Nguồn gốc: risk được TASK-084 xác nhận và **cố ý DEFER** (TASK-084 A6 / quyết định D4):
"broader multi-worker credential-rotation last-writer-wins race". TASK-084 chỉ giải quyết
**GraphSubscription claim ownership** và **mailbox status guard** (RECONNECT_REQUIRED đọc
credential generation như một *marker* để không overwrite mailbox vừa reconnect) — TASK-084
**KHÔNG** thêm ownership/CAS cho chính *việc ghi* `Mailbox.encryptedRefreshToken`.

> Bảo mật: tài liệu này KHÔNG chứa access token, refresh token, ciphertext credential thật,
> client secret, Telegram bot token, verification code đầy đủ, full email body, hay
> DB/Redis URL. Mọi generation credential được nhắc tới đều là **opaque marker** (không giá
> trị thật). Không đọc/in `.env*`.

---

# 1. Context từ TASK-084

- TASK-084 đóng renewal concurrency bằng atomic claim + CAS trên `GraphSubscription.updatedAt`.
- TASK-084 correction B thêm **credential-generation guard cho RECONNECT_REQUIRED writer**:
  chỉ flip mailbox → RECONNECT_REQUIRED khi `encryptedRefreshToken` hiện tại còn khớp giá
  trị operation đã dùng. Đây là guard cho **mailbox STATUS write**, KHÔNG phải guard cho
  **credential WRITE**. Nó ngăn stale renewal *đổi status* mailbox vừa reconnect, nhưng
  KHÔNG ngăn một worker *ghi đè credential* của worker/OAuth khác.
- TASK-084 A6/D4: credential-rotation LWW race CONFIRMED nhưng DEFERRED sang task riêng →
  chính là TASK-085. TASK-084 report §12 ghi rõ residual bounded của reconnect guard là
  "cùng deferred item" này.

---

# 2. Exact current credential writers (đã trace toàn repo)

Chỉ có **HAI câu ghi vật lý** vào `Mailbox.encryptedRefreshToken`, cả hai là
**unconditional `prisma.mailbox.update/create` theo `id`** (không CAS, không transaction):

## W1 — OAuth connect/reconnect
- File/func: `services/microsoft/mailbox-connect.service.ts` → `saveConnectedMailbox`
  (update existing row ~dòng 157–167; create ~dòng 170–180).
- Đọc generation cũ: KHÔNG so sánh credential cũ. Có resolve identity qua `findFirst`
  (provider+microsoftUserId) / `findUnique` (emailAddress). TASK-069B guard: nếu
  `expectedMailboxId` set thì account phải resolve đúng row đó (chống nhầm account), nhưng
  đây KHÔNG phải credential-generation CAS.
- Microsoft call: refresh token đến từ **OAuth authorization-code exchange** ở callback
  (ngoài hàm này); `saveConnectedMailbox` chỉ nhận `refreshToken` plaintext rồi encrypt.
- Persist mới: `update`/`create` set `encryptedRefreshToken` (freshly encrypted),
  `status = 'ACTIVE'`, `tokenLastRefreshedAt = now`, `microsoftUserId`, `emailAddress`.
- Re-read trước persist: KHÔNG.
- CAS predicate: KHÔNG (`where: { id }`).
- Status cùng lúc: `status → ACTIVE` (đây là điểm khác biệt lớn — chỉ OAuth path đổi status
  khi ghi credential; là authoritative human action).

## W2 — persistRotatedRefreshToken (helper chung cho mọi worker)
- File/func: `services/microsoft/refresh-token-rotation.service.ts` →
  `persistRotatedRefreshToken` (~dòng 63–108). Write ở ~dòng 85–97.
- Chỉ ghi khi Microsoft trả **refresh token MỚI** (`isNonEmptyString(newRefreshToken)`);
  nếu không rotate → **no-op** (`{ rotated: false }`, không DB write).
- Persist: `prisma.mailbox.update({ where: { id }, data: { encryptedRefreshToken (mới,
  đã encrypt), tokenLastRefreshedAt: now } })`. KHÔNG đổi status.
- Re-read trước persist: KHÔNG. CAS predicate: KHÔNG. Transaction: KHÔNG.
- TASK-084 thêm việc **trả về** ciphertext đã ghi (`encryptedRefreshToken?`) để caller
  capture generation cho *status guard* — KHÔNG thêm CAS cho *write* này.
- Persistence failure là **non-fatal** (log masked, `{ rotated: false }`): access token
  cycle này vẫn dùng được, cycle sau retry.

`persistRotatedRefreshToken` được gọi từ **4 logical caller** (mỗi caller đọc credential cũ
ở đầu port → decrypt → `refreshMicrosoftAccessToken` → persist, KHÔNG re-read/CAS giữa read và write):

| # | Caller | File / func | Ghi chú |
|---|---|---|---|
| C1 | Subscription renewal token port | `subscription-renewal-runner.ts` → `acquireRenewalCredential` (~343–388) | Đọc `encryptedRefreshToken` (initialGeneration) → refresh → persist (~380). TASK-084 dùng post-rotation generation cho reconnect *status* guard. |
| C2 | Delta polling token port | `delta-polling-runner.ts` → `createPrismaAccessTokenPort` (~184–240), persist ~234 | Timeout TASK-080 cho refresh. Cùng pattern. |
| C3 | Email worker token port | `email-worker-runner.ts` → `createPrismaEmailAccessTokenPort` (~219–270), persist ~264 | Cùng pattern. |
| C4 | Reconciliation / recovery | `subscription-reconciliation-runner.ts` (~203–210) reuse **renewal string port** `createPrismaRenewalAccessTokenPort` → cùng `acquireRenewalCredential` → W2 | TASK-082/083 reuse nguyên trạng token path. |

**Reader-only (KHÔNG ghi credential):**
`mailbox-disconnect-remote-cleanup.ts` (đọc để gọi remote delete),
`subscription-reconciliation-runner.ts:70` (`where: { encryptedRefreshToken: { not: null } }` — filter),
các whitelisted select ở list/detail/health service.

**Kết luận A:** danh sách writer đầy đủ = **W1 (OAuth) + W2 (rotation helper qua C1–C4)**.
Tất cả hiện là last-writer-wins theo `id`, không có expected-generation predicate.

---

# 3. Race matrix & Corrected Risk Wording

Ký hiệu: `G0` = credential đang lưu ban đầu; `G_x` = credential mới do Microsoft trả cho
operation x. "persist" = W2 update.

### Corrected Risk Wording:
TASK-085 **KHÔNG** tiếp tục mô tả risk như thể "race chỉ nguy hiểm nếu Microsoft invalidate
token cũ khi rotate". External evidence chính thức đã xác nhận Microsoft không tự động
revoke token cũ chỉ vì một refresh bình thường.

Thay vào đó, rủi ro cốt lõi của TASK-085 là **LOCAL STATE OWNERSHIP / FRESHNESS CONCURRENCY BUG**:
1. Stale worker có thể last-writer-wins overwrite generation mới hơn do worker khác ghi.
2. **Nguy hiểm nhất (R5):** Worker đọc G0 → Human OAuth reconnect thành công ghi generation B
   (mới và hợp lệ) → Worker sau đó nhận rotated G_a từ refresh cũ và unconditional persist
   G_a đè lên B → **OAuth reconnect bị nuốt/clobber**.
3. Điều này vi phạm nghiêm trọng tính ưu tiên và tính đúng đắn của credential lưu trữ cục bộ,
   dù trên thực tế về phía Microsoft các token có thể vẫn còn hiệu lực.

### Chi tiết các race code-level:

### R1 — renewal vs delta polling
1. Renewal đọc G0. 2. Delta đọc G0. 3. Cả hai refresh. 4. MS trả G1 (renewal), G2 (delta).
5. Renewal persist G1. 6. Delta persist G2 (LWW) → DB giữ **G2**.
- Local state: G2 đè G1 không qua version check. Cả G1 và G2 đều là valid tokens (theo Microsoft semantics), nhưng DB cần đảm bảo trật tự nối tiếp generation nhất quán (Option A: G1 thắng thì G2 bị discard có kiểm soát).

### R2 — renewal vs email worker
Tương tự R1. LWW overwrite giữa 2 tiến trình worker.

### R3 — delta vs email worker
Tương tự R1. Hai worker non-renewal cùng mailbox ghi đè lẫn nhau.

### R4 — reconciliation vs worker khác
Reconciliation (C4) chạy đồng thời với scheduler renewal/delta/email → LWW race R1–R3.

### R5 — worker refresh rotation vs OAuth reconnect  ⟵ CRITICAL INVARIANT
1. Worker đọc G0.
2. Human OAuth reconnect thành công → W1 ghi **B** (freshly consented credential) + `status = ACTIVE` + `tokenLastRefreshedAt`.
3. Worker nhận rotated G_a từ Microsoft (dựa trên G0 cũ).
4. Worker W2 persist G_a (unconditional `where: { id }`) → **đè B bằng G_a (stale credential so với reconnect)**.
- **Hệ quả:** Credential B của human reconnect bị mất.
- **TASK-084:** Chỉ bảo vệ *status* (không đổi mailbox sang RECONNECT_REQUIRED nếu generation đã đổi), nhưng **KHÔNG** ngăn W2 ghi đè cột `encryptedRefreshToken`.
- **Yêu cầu:** W2 bắt buộc phải fail nếu DB đã là B ≠ G0.

### R6 — cùng generation G0, nhận rotated generations khác nhau (CAS-loser)
1. A đọc G0. 2. B đọc G0. 3. A refresh → MS trả G1. 4. B refresh → MS trả G2.
5. Với CAS `where encryptedRefreshToken = G0`: A ghi G1 thành công (`count = 1`). B cố ghi G2 (`expected G0`) nhưng DB đã là G1 → `count = 0`.
6. B **không overwrite G2 vào DB**. B discard G2 an toàn (vì G1 vẫn là valid credential trên Microsoft).

---

# 4. External Evidence từ Microsoft Identity Platform (RESOLVED)

Human/ChatGPT đã thực hiện external verification từ tài liệu chính thức của Microsoft:
- **Nguồn:** Microsoft Learn — *"Refresh tokens in the Microsoft identity platform"* (cập nhật 2025-11-05) & *"OAuth 2.0 authorization code flow"*.
- **Kết quả xác minh:**
  1. **Non-destructive rotation:** Microsoft Identity Platform **KHÔNG** revoke refresh token cũ chỉ vì token đó vừa được dùng để lấy access token/token pair mới.
  2. **No automatic sibling revocation:** Việc exchange token bình thường không có semantics "one-time-use on refresh" làm vô hiệu hóa token cũ hoặc sibling token cùng phát hành.
  3. **Multiple valid tokens:** Nhiều refresh token cho cùng session/grant có thể đồng thời hợp lệ cho đến khi hết hạn (lifetime) hoặc có explicit revocation event (user/admin revoke, password change, account event).
  4. **Recommended behavior:** Ứng dụng được khuyến nghị lưu token mới nhất nhận được và discard token cũ để duy trì lifetime tốt nhất.

**Hệ quả kiến trúc:**
- Blocker về CAS-loser semantics được coi là **RESOLVED**.
- Không có lý do nào buộc phải dùng Redis/distributed locking để serialize trước khi refresh.
- Worker CAS thua (`count = 0`) hoàn toàn có thể **discard token mới** một cách an toàn mà không làm hỏng token G1 đang lưu trong DB.

---

# 5. Existing concurrency seams

| Seam | Chứng minh credential generation? | Cross-process safe | Bị unrelated write bump? | Dùng cho expected-old → write-new CAS? | Lộ ciphertext ra log? |
|---|---|---|---|---|---|
| `encryptedRefreshToken` (value) | **CÓ** — chính là credential generation marker | CÓ (DB predicate) | Không (chỉ W1/W2 đổi) | **CÓ** (`where encryptedRefreshToken = expectedOld`) | KHÔNG (chỉ trong WHERE clause, không log) |
| `tokenLastRefreshedAt` | Gần đúng (đổi khi W1/W2 ghi) | CÓ | Không | Có rủi ro alias cùng-ms | Không |
| `updatedAt` (@updatedAt) | **KHÔNG** — bump bởi mọi write | CÓ | **CÓ, rất nhiều** | KHÔNG dùng được (false-negative) | — |
| Redis mailbox lock (TASK-068A) | Không (mutual exclusion) | CÓ (nhưng fail-open) | — | Không phải CAS | Không |

**Kết luận:** Seam tối ưu và chính xác nhất cho CAS là **`Mailbox.encryptedRefreshToken` value (Option A)**.

---

# 6. Architecture Options đã đánh giá

## Option A — DB CAS trên exact old `Mailbox.encryptedRefreshToken` (RECOMMENDED)
`updateMany where { id: mailboxId, encryptedRefreshToken: expectedGenerationG0 } data { encryptedRefreshToken: newGenerationG1, tokenLastRefreshedAt: now }`.
- **Safety:** Chỉ operation nắm giữ đúng generation nó đã đọc mới được persist generation mới.
- **Affected count:**
  - `count = 1`: Thành công, G1 trở thành stored current credential.
  - `count = 0`: Generation trong DB đã đổi (do worker khác đã rotate hoặc do OAuth reconnect ghi B) → discard G1, không overwrite DB, không raise reconnect, không blind retry.
- **Hạ tầng:** Không schema migration, không Redis lock, không transaction.

## Option B — CAS bằng `tokenLastRefreshedAt` (Alternative)
- Nhược điểm: Rủi ro alias nếu 2 write cùng millisecond; so sánh DateTime round-trip phức tạp hơn string equality.

## Option C — Thêm explicit version column `credentialVersion` (Alternative)
- Nhược điểm: Bắt buộc schema migration và sửa đổi model Prisma trong khi existing field đã hoàn toàn đáp ứng.

## Option D — Serialize refresh bằng distributed lock (Alternative)
- Nhược điểm: Không cần thiết theo Microsoft semantics đã verify; tăng độ phức tạp hạ tầng và phát sinh failure modes mới khi Redis gặp sự cố.

---

# 7. CAS-loser semantics cuối cùng

- Khi worker B gặp CAS conflict (`count = 0`):
  1. Worker B **KHÔNG** ghi đè DB.
  2. Token mới G2 mà B nhận từ Microsoft được **discard an toàn**.
  3. Access token mà B vừa mint trong memory vẫn **hợp lệ và được dùng bình thường** cho cycle hiện tại của B.
  4. Worker B **KHÔNG** coi CAS conflict là lỗi auth/reconnect_required.
  5. Worker B **KHÔNG** blind retry persistence hay re-read để adopt generation mới.
  6. Cycle tiếp theo của B sẽ tự động đọc current generation mới từ DB.

---

# 8. OAuth Reconnect Priority & Interleaving Protection

- **W1 (`saveConnectedMailbox`)** tiếp tục là authoritative path ghi credential mới do human thực hiện.
- **Interleaving R5 được bảo vệ tuyệt đối:**
  ```text
  1. Worker đọc G0.
  2. Human OAuth reconnect ghi B (unconditional W1) + status = ACTIVE.
  3. Worker nhận G_a từ refresh G0.
  4. Worker gọi W2 với predicate: where id = mb_id AND encryptedRefreshToken = G0.
  5. DB hiện tại là B ≠ G0 → updateMany trả count = 0.
  6. Worker dừng, G_a bị discard, KHÔNG ghi đè B.
  ```
- Credential B của human reconnect được bảo toàn nguyên vẹn 100%.

---

# 9. Tương tác với TASK-084

- **Case A (Token failure trước rotation):** Token port bắt đầu đọc G0, nếu fail auth thì mang G0 xuống status guard. Status guard so sánh `encryptedRefreshToken = G0`, nếu DB đã là B (reconnect) thì `count = 0` → không mark RECONNECT_REQUIRED.
- **Case B (Graph 401 sau rotation):**
  - Nếu rotation CAS thành công (`count = 1`), generation commit là G1. Nếu sau đó Graph PATCH trả 401 và DB vẫn là G1 → mark RECONNECT_REQUIRED. Nếu DB đã bị OAuth reconnect ghi B → count = 0 → không mark.
  - Nếu rotation CAS thất bại (`count = 0`, generation đã đổi sang B), operation **không còn là current credential owner** → generation mismatch → status guard fail-closed → không mark RECONNECT_REQUIRED.
- **Đề xuất Return Contract (Planning Phase):**
  Helper `persistRotatedRefreshToken` trong implementation phase có thể mở rộng return type tối thiểu:
  ```ts
  export interface PersistRotatedRefreshTokenResult {
    rotated: boolean;
    persisted: boolean; // true nếu count = 1, false nếu count = 0 (CAS lost)
    casLost?: boolean;  // true khi có new token nhưng count = 0
    encryptedRefreshToken?: string; // ciphertext nếu persisted thành công
  }
  ```
  *(Chỉ là proposal cho phase 2, KHÔNG implement bây giờ).*

---

# 10. Shared Seam cho 4 Callers

Shared helper `persistRotatedRefreshToken` tại `services/microsoft/refresh-token-rotation.service.ts` sẽ là nơi duy nhất thực thi CAS write:
- Cả 4 callers (Renewal C1, Delta C2, Email C3, Reconciliation C4) đều đã đọc `encryptedRefreshToken` ban đầu ở đầu port.
- Plumbing duy nhất cần thiết là truyền `expectedEncryptedRefreshToken: string | null` vào `persistRotatedRefreshToken(mailboxId, newRefreshToken, { expectedEncryptedRefreshToken, ... })`.
- Không viết CAS riêng rẽ ở 4 nơi; tập trung hóa invariant tại W2.

---

# 11. Schema / Redis / Transaction Verdicts

| Hạng mục | Kết luận | Lý do |
|---|---|---|
| **Schema / migration** | **NOT REQUIRED** | Option A sử dụng exact opaque string trên cột `Mailbox.encryptedRefreshToken` có sẵn. |
| **Redis / distributed lock** | **NOT REQUIRED** | Microsoft semantics xác nhận token song song không tự động revoke lẫn nhau; DB CAS là đủ. |
| **Database Transaction** | **NOT REQUIRED** | Câu lệnh `prisma.mailbox.updateMany({ where: { id, encryptedRefreshToken }, data: ... })` tự nguyên tử ở cấp DB statement. |

---

# 12. Locked Architecture Recommendation

### **OPTION A — DB CAS TRÊN `Mailbox.encryptedRefreshToken` LÀ KIẾN TRÚC DUY NHẤT ĐƯỢC ĐỀ XUẤT ĐỂ ĐƯA SANG ANTIGRAVITY REVIEW.**

---

# 13. Chronology & Decisions

- **Chronology:**
  1. *Initial repo investigation:* Phát hiện LWW race giữa 4 workers và OAuth reconnect. Đánh dấu external blocker do chưa rõ Microsoft token revocation semantics.
  2. *External verification supplied:* Human/ChatGPT cung cấp bằng chứng chính thức từ Microsoft Learn: Microsoft Identity Platform không có one-time-use revocation on refresh.
  3. *Blocker resolved:* Option A được chọn làm locked architecture.
- **Decisions:**
  - **D1:** Áp dụng Option A cho W2 `persistRotatedRefreshToken` với expected-generation CAS.
  - **D2:** Giữ W1 `saveConnectedMailbox` là authoritative human path.
  - **D3:** CAS conflict là non-fatal outcome, access token vẫn được dùng cho tick hiện tại, discard token mới.
  - **D4:** Không thêm schema migration, không thêm Redis lock, không transaction.

---

# 14. Scope implementation đề xuất (Phase 2 — sau khi approved)

1. Cập nhật `persistRotatedRefreshToken` nhận thêm `expectedEncryptedRefreshToken` và thực hiện `updateMany` có điều kiện.
2. Cập nhật 4 callers (C1–C4) truyền `initialGeneration` vào `persistRotatedRefreshToken`.
3. Bổ sung unit tests kiểm tra toàn diện CAS win/lose, reconnect priority, và caller compatibility.

---

# 15. Scope KHÔNG làm

- KHÔNG đổi classification TASK-069C / 403 TASK-071/075.
- KHÔNG redesign OAuth flow hay token encryption.
- KHÔNG sửa TASK-084 subscription claim / CAS.
- KHÔNG thêm schema/migration hay Redis lock.
- KHÔNG đụng file `.env*`, GitHub Actions, UI, hay production DB.

---

# 16. Proposed Test Matrix (Implementation Phase)

1. **Normal rotation:** Expected G0 + DB G0 → `count = 1` → G1 persisted thành công.
2. **Worker-vs-worker race:** Worker A & B cùng đọc G0; A persist G1 thắng (`count = 1`); B persist G2 với expected G0 nhận `count = 0` → DB giữ G1, G2 bị discard an toàn.
3. **Worker-vs-OAuth reconnect (R5):** Worker đọc G0; OAuth reconnect ghi B; Worker CAS A' với expected G0 nhận `count = 0` → DB giữ nguyên B.
4. **CAS lost semantics:** CAS lost không throw lỗi auth, không raise `RECONNECT_REQUIRED`, access token cycle hiện tại vẫn trả về bình thường.
5. **No rotation returned:** Microsoft không trả refresh token mới → W2 là no-op (không DB write).
6. **Renewal TASK-084 Case B interaction:** Rotation persistence lost do generation đã đổi → later Graph 401 không overwrite mailbox generation mới.
7. **Delta caller compatibility:** Delta polling token port hoạt động đúng với CAS seam.
8. **Email worker caller compatibility:** Email worker token port hoạt động đúng với CAS seam.
9. **Reconciliation/recovery compatibility:** Reconciliation token port hoạt động đúng với CAS seam.
10. **TASK-069C regression:** Genuine `invalid_grant` / `interaction_required` vẫn trigger reconnect; `transient` và 403 giữ nguyên.
11. **DISABLED safety:** Mailbox DISABLED không bị resurrect hay thay đổi status.
12. **Secret hygiene:** Không log expected/current/new encrypted token; không log ciphertext; không có plaintext trong error/docs.

---

# 17. STOP Conditions

- Nếu implementation phát hiện Prisma `updateMany` với `encryptedRefreshToken` không hoạt động ổn định trên PostgreSQL → **STOP**, báo human/ChatGPT.
- Bất kỳ thay đổi nào làm phá vỡ TASK-069C hoặc TASK-084 -> **STOP**.

---

# 18. Antigravity Review Focus

- Tính đầy đủ của danh sách writer (W1 + W2 qua C1–C4).
- Race matrix và tính an toàn của R5 (OAuth reconnect priority).
- External evidence Microsoft và tính đúng đắn khi resolve blocker.
- Option A CAS contract và CAS-loser non-fatal semantics.
- Tính chính xác của các verdict: Schema (NOT REQUIRED), Redis (NOT REQUIRED), Transaction (NOT REQUIRED).
- Bảo mật và secret hygiene.

---

# PHẦN IMPLEMENTATION (Phase 2 — đã thực hiện, `npm run verify` PASS)

Ghi lại implementation thực tế của Option A + finding Medium DISABLED. History §1–§18 giữ
nguyên. Không secret/ciphertext thật.

## I1. Architecture đã PASS Antigravity + finding Medium đã khóa

- Antigravity **Final Architecture Review = PASS** → đủ điều kiện implementation.
- Finding Medium BẮT BUỘC: CAS phải thêm `status != DISABLED` để worker bắt đầu trước lúc
  operator disconnect KHÔNG ghi rotated credential vào mailbox đã DISABLED. **Đã khóa vào
  implementation** (predicate CAS cuối bên dưới).

## I2. Exact final CAS predicate (đã implement)

`persistRotatedRefreshToken` (`services/microsoft/refresh-token-rotation.service.ts`) đổi seam
từ `mailbox.update` (unconditional) sang `mailbox.updateMany` (conditional CAS):

```text
updateMany where:
  id = mailboxId
  AND status != DISABLED          ← finding Medium (disconnect race)
  AND encryptedRefreshToken = expectedGeneration (G0, opaque marker)
data:
  encryptedRefreshToken = <G1 đã encrypt>
  tokenLastRefreshedAt  = now()
```

- `expectedGeneration` = giá trị `encryptedRefreshToken` mà operation đã đọc ở đầu token port
  (G0). KHÔNG dùng `updatedAt`, KHÔNG dùng `tokenLastRefreshedAt` làm marker, KHÔNG re-read DB
  để adopt generation khác, KHÔNG so plaintext. Prisma `equals: null` → `IS NULL` (Case
  defensive; thực tế caller luôn truyền ciphertext đã đọc).

## I3. Return contract (đã implement)

```ts
interface PersistRotatedRefreshTokenResult {
  rotated: boolean;                 // Microsoft trả token mới cycle này
  persisted: boolean;               // committed dưới CAS (count === 1)
  casLost?: boolean;                // rotation có nhưng count === 0 (generation đổi / DISABLED)
  encryptedRefreshToken?: string;   // CHỈ khi persisted (committed generation)
}
```

Phân biệt 3 nhánh bắt buộc:
- **A. No rotation** (MS không trả token mới / rỗng / encrypt fail): `{ rotated:false, persisted:false }`, KHÔNG DB write.
- **B. Rotation persisted** (count 1): `{ rotated:true, persisted:true, encryptedRefreshToken:G1 }`.
- **C. Rotation nhưng CAS lost** (count 0): `{ rotated:true, persisted:false, casLost:true }` — KHÔNG trả `encryptedRefreshToken` (downstream không hiểu nhầm CAS-lost là committed).
- **DB throw thật (updateMany THROWS = infrastructure error, KHÁC CAS conflict):** helper
  **KHÔNG swallow** — log masked warn (chỉ mailboxId) rồi **PROPAGATE một error đã sanitize**
  (`'failed to persist rotated refresh token'`, không chứa ciphertext / không raw Prisma error).
  KHÔNG set `casLost`, KHÔNG trả result, KHÔNG biến thành reconnect_required. Caller classify
  error lạ = **transient** (C1/C4 qua `classifyRefreshTokenError`; C2/C3 qua `shouldMarkReconnectRequired`
  = false) → operation fail an toàn, retry tick sau, KHÔNG bao giờ mark reconnect. **casLost chỉ
  set khi count=0** nên không bao giờ lẫn với infra error.

## I4. Four-caller plumbing (đã implement)

Enforcement tập trung một nơi (W2). Không duplicate CAS ở 4 worker. Mỗi caller truyền exact
G0 nó đã đọc:
- **C1 renewal + C4 reconciliation**: `acquireRenewalCredential` (renewal runner) — truyền
  `initialGeneration`; committed generation cho TASK-084 Case B = `persistResult.encryptedRefreshToken
  ?? initialGeneration` (persisted → G1; CAS-lost/no-rotation → fallback G0 → status guard
  fail-closed). Reconciliation reuse renewal string port nên tự động được phủ.
- **C2 delta polling**: `createPrismaAccessTokenPort` — capture `expectedGeneration =
  row.encryptedRefreshToken`, truyền xuống; kết quả bị ignore (chỉ trả access token) → CAS-lost
  = discard im lặng.
- **C3 email worker**: `createPrismaEmailAccessTokenPort` — tương tự C2.
- Interface Prisma của 3 worker đổi `mailbox.update` → `mailbox.updateMany` (cho helper CAS).

## I5. Kết quả các race (đã có test)

- **Worker-vs-worker (R1/R2/R3/R6):** winner CAS count=1 persist G1; loser CAS count=0 discard
  G2, KHÔNG retry, KHÔNG reconnect_required. DB giữ G1.
- **Worker-vs-OAuth reconnect (R5):** OAuth W1 ghi B; worker (expected G0) count=0 → DB giữ B,
  không bị đè. OAuth reconnect được bảo toàn.
- **Disconnect (finding Medium):** worker read G0 → DISABLED (credential vẫn G0) → late rotation
  → `status != DISABLED` fail → count=0 → không ghi credential, không resurrect, DISABLED giữ nguyên.
- **TASK-084 Case A:** không đổi — status guard dùng initial generation; nếu OAuth/disconnect đã
  đổi state → mailbox lifecycle writer fail-closed.
- **TASK-084 Case B:** persisted → committed G1 (genuine 401 mark reconnect nếu DB vẫn G1; nếu
  OAuth ghi B → status writer count=0); CAS-lost → committed generation fallback G0 → status
  writer count=0 (fail-closed), KHÔNG dùng CAS-lost generation để mark.
- **TASK-069C:** classification KHÔNG đổi. CAS loss ≠ invalid_grant ≠ auth failure.

## I6. Files & tests

**Runtime changed:**
- `services/microsoft/refresh-token-rotation.service.ts` — CAS `updateMany` + `expectedGeneration`
  param + return contract + `status != DISABLED`.
- `services/queue/workers/subscription-renewal-runner.ts` — C1/C4: truyền `initialGeneration`; interface `updateMany`.
- `services/queue/workers/delta-polling-runner.ts` — C2: capture + truyền `expectedGeneration`; interface `updateMany`.
- `services/queue/workers/email-worker-runner.ts` — C3: capture + truyền `expectedGeneration`; interface `updateMany`.

**Tests changed (focused):**
- `tests/unit/microsoft/refresh-token-rotation.service.test.ts` — CAS win, `status != DISABLED`,
  CAS-lost/casLost, worker-vs-worker, no-rotation, encrypt-fail, **DB-throw propagate sanitized
  (không swallow, không casLost, không leak ciphertext)**, secret hygiene; caller-level: DB persist
  throw → token error `transient` (KHÔNG reconnect).
- `tests/unit/queue/subscription-renewal-runner.test.ts` — CAS where predicate (G0 + not DISABLED),
  Case B CAS-lost fallback G0, no-rotation no write.
- `tests/unit/queue/delta-polling-runner.test.ts`, `email-worker-runner.test.ts`,
  `subscription-reconciliation-runner.test.ts`, `subscription-reconciliation-token-timeout.test.ts`
  — mock seam `update` → `updateMany`, assert CAS predicate + caller plumbing.

**Verify:** `npm run verify` = `db:generate && lint && typecheck && test && build` → PASS
(exit 0, 102 test files / 1244 tests, lint + typecheck + build sạch).

## I7. Remaining risk

- Không còn LWW blind-overwrite giữa 4 worker + OAuth reconnect ở tầng credential write.
- Residual chấp nhận (theo external Microsoft semantics đã verify): nhiều refresh token có thể
  đồng thời hợp lệ; một CAS-lost worker discard token mới của nó — an toàn vì token đang lưu (G1)
  vẫn hợp lệ. Không có blocker mới.
- CAS predicate dựa trên exact-string equality của ciphertext trên PostgreSQL (đã dùng cho
  reconnect writer TASK-084); nếu integration/live phát hiện lệch → theo STOP condition.
