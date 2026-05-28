# TASK-020: Tạo token encryption service

## 1. Mục tiêu

Tạo service mã hóa/giải mã dữ liệu nhạy cảm để dùng cho Microsoft OAuth token, đặc biệt là refresh token.

Sau TASK này, project phải có một module bảo mật dùng để:

- Encrypt refresh token trước khi lưu database.
- Decrypt refresh token khi backend cần dùng để refresh access token.
- Không log plaintext token.
- Không hardcode encryption key.
- Không expose token qua frontend/API response.

TASK này là bước chuẩn bị cho TASK-021: lưu mailbox sau OAuth connect.

---

## 2. Bối cảnh

Trong các task trước:

- TASK-017 đã chuẩn bị Microsoft App Registration checklist/config.
- TASK-018 đã tạo Microsoft OAuth connect URL.
- TASK-019 đã tạo Microsoft OAuth callback và có thể nhận token response từ Microsoft.

Tuy nhiên, trước khi lưu refresh token vào database, hệ thống bắt buộc phải có encryption service.

Không được lưu refresh token plaintext.

---

## 3. Phạm vi của TASK này

Chỉ làm:

1. Tạo token encryption service.
2. Đọc encryption key từ environment variable.
3. Validate encryption key an toàn.
4. Tạo hàm encrypt/decrypt.
5. Tạo unit test cho encryption service.
6. Cập nhật `.env.example` nếu thiếu `ENCRYPTION_KEY`.

---

## 4. Không được làm trong TASK này

Không được làm các phần sau:

- Không lưu mailbox vào database.
- Không sửa schema Prisma để lưu token nếu chưa cần.
- Không tạo mailbox-connect service.
- Không gọi Microsoft Graph read Inbox.
- Không tạo Graph subscription.
- Không tạo webhook.
- Không tạo queue/worker.
- Không đưa secret thật vào `.env.example`.
- Không hardcode encryption key trong source code.
- Không log access token hoặc refresh token.
- Không hiển thị token plaintext ở frontend/API response.
- Không làm vượt sang TASK-021 hoặc TASK-022.

---

## 5. File/thư mục dự kiến tạo hoặc sửa

Claude phải kiểm tra project đang dùng `src/` hay không trước khi tạo file.

Nếu project KHÔNG dùng `src/`:

```text
lib/security/encryption.ts
tests/unit/security/encryption.test.ts
.env.example
````

Nếu project CÓ dùng `src/`:

```text
src/lib/security/encryption.ts
tests/unit/security/encryption.test.ts
.env.example
```

Nếu project hiện đã có cấu trúc test khác, ví dụ `__tests__/`, thì tạo test theo cấu trúc thực tế.

---

## 6. Yêu cầu kỹ thuật

### 6.1. Thuật toán mã hóa

Dùng authenticated encryption.

Khuyến nghị:

```text
AES-256-GCM
```

Lý do:

* AES-256 dùng key 32 bytes.
* GCM có authentication tag để phát hiện dữ liệu bị sửa.
* Phù hợp để encrypt/decrypt secret dạng token.

Không dùng:

```text
AES-CBC không kèm MAC
base64 encode đơn thuần
hash thay cho encryption
crypto.createCipher / crypto.createDecipher legacy API
```

---

### 6.2. Encryption key

Encryption key phải đọc từ env:

```env
ENCRYPTION_KEY=
```

Yêu cầu:

* Key phải là base64 string.
* Decode ra đúng 32 bytes.
* Không hardcode key.
* Không tự generate key mới mỗi lần app chạy.
* Nếu key thiếu hoặc sai format, phải throw lỗi cấu hình rõ ràng.
* Error message không được chứa giá trị key.

Ví dụ generate key local bằng Node:

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Sau đó user tự copy giá trị sinh ra vào `.env.local`:

```env
ENCRYPTION_KEY=paste_key_here
```

Không commit `.env.local`.

---

### 6.3. Output format

Encrypted payload nên có version để sau này dễ rotate/migrate.

Format đề xuất:

```text
v1:<ivBase64>:<authTagBase64>:<ciphertextBase64>
```

Trong đó:

* `v1`: version format hiện tại.
* `iv`: random IV/nonce cho mỗi lần encrypt.
* `authTag`: authentication tag của AES-GCM.
* `ciphertext`: dữ liệu đã mã hóa.

Ví dụ:

```text
v1:abc...:def...:ghi...
```

Không yêu cầu encrypted output deterministic. Cùng một plaintext encrypt nhiều lần phải tạo output khác nhau do IV random.

---

## 7. API/hàm cần export

Module nên export tối thiểu:

```ts
export function encryptSecret(plaintext: string): string;
export function decryptSecret(encryptedPayload: string): string;
export function validateEncryptionKey(rawKey: string | undefined): Buffer;
```

Có thể thêm type nếu cần:

```ts
export class EncryptionError extends Error {}
```

Yêu cầu hành vi:

### encryptSecret

Input:

```ts
plaintext: string
```

Output:

```ts
string
```

Yêu cầu:

* Reject input rỗng hoặc không phải string nếu phù hợp với style project.
* Dùng random IV mỗi lần encrypt.
* Không log plaintext.
* Không log ciphertext nếu không cần.
* Trả về format `v1:<iv>:<tag>:<ciphertext>`.

### decryptSecret

Input:

```ts
encryptedPayload: string
```

Output:

```ts
string
```

Yêu cầu:

* Parse đúng format version.
* Chỉ hỗ trợ version `v1`.
* Nếu payload malformed, throw `EncryptionError` hoặc error rõ ràng.
* Nếu auth tag sai hoặc key sai, decrypt phải fail.
* Error không được chứa plaintext token, ciphertext đầy đủ hoặc key.

### validateEncryptionKey

Input:

```ts
rawKey: string | undefined
```

Output:

```ts
Buffer
```

Yêu cầu:

* Nếu thiếu key: throw lỗi cấu hình.
* Nếu key không phải base64 hợp lệ: throw lỗi.
* Nếu decode không đúng 32 bytes: throw lỗi.
* Không in giá trị key vào error.

---

## 8. Unit test bắt buộc

Tạo test cho các case sau:

### 8.1. Encrypt/decrypt round-trip

Input:

```text
refresh-token-test-value
```

Kỳ vọng:

* `encryptSecret` trả về chuỗi khác plaintext.
* `decryptSecret(encrypted)` trả lại đúng plaintext ban đầu.

---

### 8.2. Encrypt cùng plaintext 2 lần phải ra output khác nhau

Input:

```text
same-refresh-token
```

Kỳ vọng:

* encrypted1 khác encrypted2.
* decrypt cả 2 đều ra plaintext ban đầu.

---

### 8.3. Malformed payload phải fail an toàn

Ví dụ:

```text
not-a-valid-payload
v1:missing:parts
v2:abc:def:ghi
```

Kỳ vọng:

* decrypt throw error.
* error message không chứa token thật.

---

### 8.4. Sai key phải decrypt fail

Cách test:

* Encrypt bằng key A.
* Đổi env sang key B hoặc mock validate key.
* Decrypt payload cũ phải fail.

Kỳ vọng:

* Không trả plaintext.
* Throw error an toàn.

---

### 8.5. Validate key

Test các trường hợp:

* Missing key.
* Key không phải base64.
* Key base64 nhưng decode không đủ 32 bytes.
* Key đúng 32 bytes.

---

## 9. Cập nhật `.env.example`

Nếu `.env.example` chưa có, thêm:

```env
# Encryption key for stored OAuth tokens (filled in Sprint 5 / TASK-020)
# Generate locally with:
# node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
ENCRYPTION_KEY=
```

Không thêm secret thật.

---

## 10. Tiêu chí nghiệm thu

TASK-020 chỉ PASS khi đạt đủ:

* Có `lib/security/encryption.ts` hoặc `src/lib/security/encryption.ts`.
* Có hàm encrypt/decrypt dùng AES-256-GCM hoặc authenticated encryption tương đương.
* Key đọc từ `ENCRYPTION_KEY`.
* Key decode ra đúng 32 bytes.
* Không hardcode key.
* Không generate key mới mỗi lần runtime.
* Encrypted payload có IV/tag/ciphertext.
* Cùng plaintext encrypt 2 lần ra output khác nhau.
* Decrypt đúng plaintext khi key đúng.
* Decrypt fail khi key sai hoặc payload bị sửa.
* Error không leak token/key.
* `.env.example` chỉ có placeholder.
* Unit test đầy đủ.
* `npm run verify` PASS.

---

## 11. Lệnh kiểm tra

Chạy trong PowerShell tại root project:

```powershell
cd C:\Projects\verification-tool
npm run verify
```

Nếu muốn chạy riêng test encryption và project có hỗ trợ vitest:

```powershell
npm run test -- encryption
```

Hoặc:

```powershell
npx vitest run tests/unit/security/encryption.test.ts
```

Tùy cấu trúc test thực tế của project.

---

## 12. Checklist bảo mật cho reviewer

Gemini cần kiểm tra:

* Có hardcode encryption key không.
* Có log token/key không.
* Có đưa secret thật vào `.env.example` không.
* Có dùng base64 encode giả làm encryption không.
* Có dùng deprecated `crypto.createCipher` không.
* Có dùng IV random cho mỗi lần encrypt không.
* Có auth tag và verify auth tag khi decrypt không.
* Có test sai key/sai payload không.
* Có làm vượt scope sang TASK-021/TASK-022 không.

````


