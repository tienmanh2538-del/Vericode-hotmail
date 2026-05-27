\# TASK-004: Setup database ORM \& initial schema



\## Mục tiêu



Thiết lập Prisma ORM và database schema ban đầu cho hệ thống.



Task này chỉ tạo nền database/schema, chưa làm UI, chưa làm Microsoft OAuth thật, chưa làm Telegram thật.



\## Stack mong muốn



\- ORM: Prisma

\- Database production target: PostgreSQL

\- Local task này: không bắt buộc chạy database thật

\- Không chạy migration nếu chưa có DATABASE\_URL thật



\## Yêu cầu



\### 1. Cài Prisma



Nếu project chưa có Prisma:



\- Cài `prisma` cho dev dependency

\- Cài `@prisma/client`

\- Tạo thư mục/file Prisma cần thiết



\### 2. Tạo schema ban đầu



Tạo/cập nhật:



```text

prisma/schema.prisma

Schema phải có các model chính:



User

Customer

Mailbox

TelegramMapping

GraphSubscription

ProcessedMessage

AuditLog



3\. Enum cần có



Tạo enum tương đương:



UserRole

CustomerStatus

MailboxProvider

MailboxStatus

TelegramMappingStatus

GraphSubscriptionStatus

ProcessedMessageStatus

AuditAction

4\. Model yêu cầu chi tiết

User



Các field tối thiểu:

id

email unique

name optional

role

passwordHash optional

authProvider optional

createdAt

updatedAt



Role tối thiểu:

OWNER

ADMIN

STAFF\_READ\_ONLY



Customer



Thêm bảng Customer để quản lý khách hàng agency.



**#Field tối thiểu:**

id

name

status

notes optional

createdAt

updatedAt





**#Mailbox**



Field tối thiểu:

id

emailAddress

provider

ownerCustomerName optional

customerId optional

status

microsoftUserId optional

encryptedRefreshToken optional

tokenLastRefreshedAt optional

lastSuccessfulSyncAt optional

createdById optional

createdAt

updatedAt

Status tối thiểu:

ACTIVE

RECONNECT\_REQUIRED

SUBSCRIPTION\_EXPIRED

WEBHOOK\_FAILED

DISABLED

ERROR



**#TelegramMapping**



Field tối thiểu:

id

mailboxId

telegramChatId

telegramGroupName optional

status

createdById optional

createdAt

updatedAt



**#GraphSubscription**



Field tối thiểu:



id

mailboxId

subscriptionId

resource

clientStateHash

expirationDateTime

status

lastRenewedAt optional

createdAt

updatedAt



Yêu cầu:



Không lưu clientState plaintext.

Chỉ lưu hash.



**#ProcessedMessage**



Field tối thiểu:



id

mailboxId

graphMessageId

internetMessageId optional

receivedAt

senderEmail

subjectHash optional

codeHash optional

status

sentToTelegramAt optional

createdAt



Yêu cầu:



Không lưu full code.

Chỉ lưu codeHash.

Có unique/index để chống xử lý trùng.



**#AuditLog**



Field tối thiểu:



id

actorUserId optional

action

entityType

entityId optional

metadataJson optional

ipAddress optional

createdAt



AuditAction nên có:



MAILBOX\_CONNECTED

MAILBOX\_DISCONNECTED

TELEGRAM\_MAPPING\_CREATED

TELEGRAM\_MAPPING\_UPDATED

CODE\_DETECTED

CODE\_SENT

CODE\_SKIPPED\_LOW\_CONFIDENCE

SUBSCRIPTION\_RENEWED

TOKEN\_REFRESH\_FAILED





**###5. Prisma client helper**



Tạo Prisma client singleton.



Gợi ý file:



src/lib/prisma.ts



Nếu project không có src/, dùng:



lib/prisma.ts



Yêu cầu:



Tránh tạo nhiều PrismaClient trong dev hot reload.

Không query database thật trong task này.



**###6. Scripts package.json**



Thêm scripts phù hợp:



{

&#x20; "db:validate": "prisma validate",

&#x20; "db:generate": "prisma generate",

&#x20; "db:migrate": "prisma migrate dev",

&#x20; "db:studio": "prisma studio"

}



Nếu đưa db:validate vào verify, phải đảm bảo CI/local không fail vì thiếu DATABASE\_URL thật. Có thể set DATABASE\_URL dummy trong GitHub Actions cho bước validate nếu cần.



**###7. GitHub Actions**



Nếu npm run verify có chạy db validation, cập nhật GitHub Actions để có DATABASE\_URL dummy hợp lệ cho Prisma validate.



Ví dụ:



DATABASE\_URL=postgresql://user:password@localhost:5432/verification\_tool



Task này không được yêu cầu connect database thật.

**###8. Test**



Tạo test tối thiểu để kiểm tra:



Prisma schema file tồn tại

Enum/status quan trọng tồn tại

Không có field lưu full verification code

Không có field lưu plaintext refresh token

Audit actions quan trọng tồn tại





**######Tiêu chí nghiệm thu**



**###Task được coi là PASS khi:**



Prisma được setup.

prisma/schema.prisma tồn tại.

Có đủ model chính.

Có đủ enum/status chính.

Không có field lưu full code plaintext.

Không có field lưu refresh token plaintext.

Có encryptedRefreshToken.

Có codeHash.

Có clientStateHash.

Có audit log model.

Có Prisma client helper.

npm run lint PASS.

npm run typecheck PASS.

npm run test PASS.

npm run build PASS.

npm run verify PASS.

Gemini review PASS.

**###** 

**Không được làm**

Không làm Microsoft OAuth.

Không tạo Graph subscription thật.

Không kết nối Telegram thật.

Không tạo dashboard UI mới.

Không chạy migration vào database production.

Không tạo .env chứa secret thật.

Không log token/code/password.

Không lưu full verification code.

Không lưu refresh token plaintext.

Không sửa scope ngoài TASK-004.

