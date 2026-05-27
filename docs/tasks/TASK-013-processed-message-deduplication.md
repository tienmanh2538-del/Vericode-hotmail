# TASK-013: Processed message & deduplication service

## 1. Mục tiêu

Tạo service chống xử lý/gửi trùng verification email/code.

Service này nằm sau:
- TASK-011: Facebook/Meta verification detector
- TASK-012: Code extractor

Và nằm trước:
- TASK-014: Mock flow integration detect → extract → dedupe → Telegram

Mục tiêu chính:
- Nhận input từ email đã detect/extract.
- Kiểm tra email/code đã từng xử lý chưa.
- Tạo/lưu processed message record an toàn.
- Không lưu full verification code.
- Chỉ dùng codeHash/dedupeKey để chống trùng.
- Trả về kết quả rõ ràng để TASK-014 biết nên gửi Telegram hay skip.

## 2. Phạm vi được làm

Được phép:
- Tạo `services/email/deduplication.service.ts` hoặc `src/services/email/deduplication.service.ts` tùy cấu trúc thực tế.
- Tạo/cập nhật unit test cho deduplication service.
- Dùng Prisma `ProcessedMessage` model nếu đã có.
- Nếu `ProcessedMessage` model thiếu field tối thiểu, báo rõ trước khi sửa schema.
- Tạo helper nhỏ cho hash/dedupeKey nếu project chưa có, nhưng không duplicate helper đã tồn tại.
- Chạy `npm run verify`.

## 3. Không được làm

Không được:
- Gửi Telegram thật.
- Tích hợp full mock flow, vì đó là TASK-014.
- Tạo Microsoft OAuth.
- Tạo Microsoft Graph webhook.
- Tạo queue/worker.
- Tạo UI log page.
- Đọc email thật từ Hotmail/Outlook.
- Lưu full verification code vào database/log/test snapshot.
- Hardcode token, password, secret, Telegram chat ID.
- Tự ý refactor lớn ngoài phạm vi task.

## 4. Yêu cầu chức năng

Service cần hỗ trợ các khóa chống trùng:

1. `mailboxId + graphMessageId`
2. `mailboxId + internetMessageId`
3. `mailboxId + codeHash + receivedAtRounded`

Trong đó:
- `verificationCode` chỉ được dùng tạm thời để tạo `codeHash`.
- Không lưu `verificationCode` plaintext.
- Không return `verificationCode` trong result.
- Không log `verificationCode`.

## 5. Types đề xuất

```ts
export type DeduplicationInput = {
  mailboxId: string;
  graphMessageId?: string | null;
  internetMessageId?: string | null;
  receivedAt?: Date | string | null;
  senderEmail?: string | null;
  subject?: string | null;
  verificationCode?: string | null;
};

export type DeduplicationReason =
  | "NEW_MESSAGE"
  | "DUPLICATE_GRAPH_MESSAGE_ID"
  | "DUPLICATE_INTERNET_MESSAGE_ID"
  | "DUPLICATE_CODE_TIME_BUCKET"
  | "INVALID_INPUT";

export type DeduplicationResult = {
  shouldProcess: boolean;
  isDuplicate: boolean;
  reason: DeduplicationReason;
  processedMessageId?: string;
  dedupeKey?: string;
};
````

## 6. Functions đề xuất

```ts
export function normalizeMessageId(value: unknown): string | null;

export function roundReceivedAtToBucket(
  receivedAt: Date | string | null | undefined,
): string | null;

export function buildProcessedMessageDedupeKey(
  input: DeduplicationInput,
): string;

export async function checkProcessedMessageDuplicate(
  input: DeduplicationInput,
): Promise<DeduplicationResult>;

export async function claimMessageForProcessing(
  input: DeduplicationInput,
): Promise<DeduplicationResult>;

export async function markMessageAsSent(
  processedMessageId: string,
  sentAt?: Date,
): Promise<void>;
```

Tên function có thể điều chỉnh theo style code hiện tại, nhưng phải giữ đúng ý nghĩa.

## 7. Yêu cầu bảo mật

* Không lưu full code.
* Không log full code.
* Chỉ lưu `codeHash`.
* Nếu lưu subject, ưu tiên `subjectHash`, không cần lưu full subject nếu không cần.
* Không lưu full email body.
* Không dùng dữ liệu khách hàng thật trong test.
* Không đọc/in file `.env`.

## 8. Unit test bắt buộc

Test cần cover:

1. First-time message returns `shouldProcess: true`.
2. Same `mailboxId + graphMessageId` returns duplicate.
3. Same `mailboxId + internetMessageId` returns duplicate.
4. Same `mailboxId + codeHash + receivedAtRounded` returns duplicate.
5. Same code in different mailbox is not duplicate.
6. Same code in same mailbox but different time bucket is not duplicate.
7. Missing mailboxId returns `INVALID_INPUT`.
8. Missing all dedupe identifiers returns `INVALID_INPUT`.
9. Result does not expose plaintext verification code.
10. No test fixture contains real token/secret/customer email.

## 9. File/thư mục dự kiến

Claude phải kiểm tra cấu trúc thực tế trước.

Có thể liên quan:

```text
services/email/deduplication.service.ts
tests/unit/email/deduplication.service.test.ts
prisma/schema.prisma
lib/security/hash.ts
lib/prisma.ts
```

Nếu project dùng `src/`, dùng:

```text
src/services/email/deduplication.service.ts
src/tests/unit/email/deduplication.service.test.ts
src/lib/security/hash.ts
src/lib/prisma.ts
```

Không tạo song song cả `src/` và non-`src/`.

## 10. Lệnh kiểm tra

```powershell
npm run verify
```

Nếu project có lệnh test riêng:

```powershell
npm test
npm run test
npm run typecheck
npm run lint
```

Nhưng bắt buộc cuối cùng phải chạy:

```powershell
npm run verify
```

## 11. Acceptance criteria

Task chỉ được coi là PASS khi:

* Có deduplication service.
* Có unit test.
* Không lưu full verification code.
* Không return full verification code từ dedupe result.
* Có logic chống trùng theo message ID/internet message ID/codeHash + receivedAt bucket.
* Không gửi Telegram thật.
* Không làm TASK-014.
* `npm run verify` PASS.
* Gemini review PASS.

````
