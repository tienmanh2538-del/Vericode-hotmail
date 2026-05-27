\# TASK-009: Tạo Telegram mapping module



\## 1. Bối cảnh



Dự án Verification Code Relay Tool cần gửi mã xác minh Facebook/Meta vào đúng Telegram group tương ứng với từng khách hàng hoặc mailbox.



TASK-008 đã tạo Telegram bot config và test-send service. TASK-009 tiếp nối bằng cách tạo module quản lý mapping:



Customer/Mailbox → Telegram group → Telegram chat ID



Mapping này sẽ được các task sau dùng để gửi verification code vào đúng group.



\---



\## 2. Mục tiêu



Tạo module Telegram mapping cho admin dashboard, bao gồm:



1\. Service quản lý Telegram mapping.

2\. API nội bộ để list/create/update/delete hoặc disable mapping.

3\. Trang admin `/admin/telegram`.

4\. Form thêm/sửa Telegram mapping.

5\. Bảng danh sách Telegram mapping.

6\. Validation dữ liệu đầu vào.

7\. Không hardcode Telegram chat ID.

8\. Không expose Telegram bot token.

9\. Dùng lại Telegram test-send service từ TASK-008 nếu đã có.

10\. Chạy được `npm run verify`.



\---



\## 3. Giải thích thuật ngữ



\### Telegram mapping



Telegram mapping là bản ghi cho biết customer/mailbox nào sẽ dùng Telegram group nào.



Ví dụ:



```text

Customer: Client A

Mailbox: client-a@hotmail.com

Telegram group name: Client A - Verification Codes

Telegram chat ID: -1001234567890

Status: ACTIVE

**telegram\_chat\_id**



telegram\_chat\_id là ID của group Telegram mà bot sẽ gửi tin nhắn vào.



Yêu cầu:



Không hardcode trong source code.

Không để trong frontend constant.

Phải lưu trong database hoặc service layer phù hợp với schema hiện tại.

Có thể hiển thị cho admin nhưng không được nhầm với bot token.





**Telegram bot token**



Telegram bot token là secret.



Yêu cầu:



Không hiển thị trên UI.

Không log.

Không commit.

Chỉ đọc từ env hoặc service đã có từ TASK-008.



**###4. Phạm vi được làm**



Claude Code được phép làm các hạng mục sau:

**4.1. Service layer**



Tạo hoặc cập nhật:

services/telegram/telegram-mapping.service.ts

Nếu project đang dùng src/, tạo ở:



src/services/telegram/telegram-mapping.service.ts



Service nên có các hàm tương đương:

listTelegramMappings()

getTelegramMappingById(id)

createTelegramMapping(input)

updateTelegramMapping(id, input)

disableTelegramMapping(id)

deleteTelegramMapping(id) // nếu project dùng hard delete

findActiveMappingForMailbox(mailboxIdOrEmail)





Ưu tiên soft disable thay vì xóa cứng nếu schema hỗ trợ status.



**4.2. API routes**

Tạo hoặc cập nhật API:



GET    /api/telegram/mappings

POST   /api/telegram/mappings

PATCH  /api/telegram/mappings/:id

DELETE /api/telegram/mappings/:id



Trong Next.js App Router, có thể là:



app/api/telegram/mappings/route.ts

app/api/telegram/mappings/\[id]/route.ts



Nếu project dùng src/, dùng:



src/app/api/telegram/mappings/route.ts

src/app/api/telegram/mappings/\[id]/route.ts



API phải:



Validate input phía server.

Không nhận bot token từ client.

Không trả bot token ra response.

Không hardcode chat ID.

Trả lỗi rõ ràng khi thiếu telegramChatId, telegramGroupName, hoặc customer/mailbox liên quan.

Tôn trọng auth/role skeleton hiện có từ TASK-006 nếu đã có.



4.3. Admin UI



Tạo hoặc cập nhật trang:



app/admin/telegram/page.tsx



Nếu project dùng src/, dùng:



src/app/admin/telegram/page.tsx



Trang này cần có:



Tiêu đề: Telegram mappings

Mô tả ngắn: “Map customer/mailbox với Telegram group để hệ thống gửi verification code đúng nơi.”

Form thêm mapping.

Bảng danh sách mapping.

Nút sửa mapping.

Nút disable hoặc delete mapping.

Nếu TASK-008 có test-send endpoint, có thể thêm nút test-send cho mapping hiện tại.

Empty state khi chưa có mapping.





4.4. Components



Tùy cấu trúc project, có thể tạo:



components/forms/TelegramMappingForm.tsx

components/tables/TelegramMappingTable.tsx



Hoặc nếu project đã có pattern riêng, đặt theo pattern hiện tại.



Component UI không được:



Import Telegram bot token.

Gọi trực tiếp Telegram Bot API bằng token.

Chứa secret.

Hardcode chat ID thật.



4.5. Database / Prisma



Claude phải kiểm tra trước:



prisma/schema.prisma



Nếu đã có model TelegramMapping, dùng lại model đó.



Model kỳ vọng có các field tương đương:



id

mailboxId hoặc customerId

telegramChatId

telegramGroupName

status

createdBy

createdAt

updatedAt



Nếu schema hiện tại dùng tên khác, Claude phải bám theo schema hiện tại.



Không được tự ý đổi tên model lớn hoặc refactor schema.



Nếu chưa có TelegramMapping, Claude phải báo rõ trong output. Chỉ thêm model tối thiểu nếu điều đó phù hợp với TASK-004 database schema và không phá migration hiện có.





4.6. Audit log



Nếu project đã có audit log service hoặc AuditLog model, mapping create/update/delete/disable nên ghi audit event tối thiểu:



TELEGRAM\_MAPPING\_CREATED

TELEGRAM\_MAPPING\_UPDATED

TELEGRAM\_MAPPING\_DISABLED

TELEGRAM\_MAPPING\_DELETED



Nếu audit service chưa có vì TASK-016 chưa làm, không tạo audit log page trong TASK-009. Có thể để TODO rõ ràng:



// TODO(TASK-016): record audit log for Telegram mapping changes



Không được log token, full verification code, hoặc dữ liệu nhạy cảm.



5\. Validation bắt buộc

5.1. telegramChatId



Yêu cầu:



Required.

Kiểu string.

Trim khoảng trắng.

Không được rỗng.

Cho phép số âm dạng string vì Telegram supergroup thường có chat ID âm, ví dụ -1001234567890.

Không chứa chữ bot, token, hoặc định dạng giống Telegram bot token.



Không bắt buộc validate quá chặt bằng regex nếu có nguy cơ chặn nhầm chat ID hợp lệ.



5.2. telegramGroupName



Yêu cầu:



Required.

Kiểu string.

Trim khoảng trắng.

Không quá dài.

Không chứa token/secret.

5.3. customer/mailbox



Yêu cầu:



Nếu đã có Customer model từ TASK-007, mapping nên chọn customer.

Nếu đã có Mailbox model, mapping nên liên kết mailbox.

Nếu mailbox thật chưa có vì Microsoft OAuth chưa tới TASK-021, không tạo Microsoft logic.

Không fake Microsoft connection.



5.4. status



Dùng enum hoặc string rõ ràng:



ACTIVE

DISABLED



Chỉ mapping ACTIVE mới được dùng bởi future flow gửi code.





6\. API response đề xuất



List response:



{

&#x20; "data": \[

&#x20;   {

&#x20;     "id": "mapping\_id",

&#x20;     "customerId": "customer\_id",

&#x20;     "mailboxId": "mailbox\_id",

&#x20;     "mailboxEmail": "client-a@hotmail.com",

&#x20;     "telegramChatId": "-1001234567890",

&#x20;     "telegramGroupName": "Client A Verification",

&#x20;     "status": "ACTIVE",

&#x20;     "createdAt": "2026-05-27T00:00:00.000Z",

&#x20;     "updatedAt": "2026-05-27T00:00:00.000Z"

&#x20;   }

&#x20; ]

}



Create input:



{

&#x20; "customerId": "customer\_id",

&#x20; "mailboxId": "mailbox\_id",

&#x20; "telegramChatId": "-1001234567890",

&#x20; "telegramGroupName": "Client A Verification",

&#x20; "status": "ACTIVE"

}



Nếu project chưa có mailbox thật, input có thể dùng field theo schema hiện tại, nhưng không được tạo Microsoft logic trong TASK-009.



**7. UI acceptance criteria**



Trang /admin/telegram đạt yêu cầu khi:



Admin nhìn thấy danh sách Telegram mappings.

Admin tạo được mapping mới.

Admin sửa được group name/chat ID/status.

Admin disable hoặc delete được mapping.

Form có validation lỗi rõ ràng.

Không có bot token trên UI.

Không có chat ID hardcode trong source code.

Nếu có test-send button, nó phải dùng lại endpoint/service từ TASK-008.

Trang không phá layout admin đã có từ TASK-005.

Nếu route admin đang được auth bảo vệ từ TASK-006, phải giữ nguyên bảo vệ đó.



**8. Service acceptance criteria**



Service đạt yêu cầu khi:



Có function list mapping.

Có function create mapping.

Có function update mapping.

Có function disable/delete mapping.

Có function tìm active mapping cho mailbox/customer để dùng ở task sau.

Validate input trước khi ghi DB.

Không log token.

Không hardcode chat ID.

Không phụ thuộc Microsoft OAuth.

Có test unit tối thiểu cho create/update/validation nếu project đã có test setup.



**9. Test yêu cầu**



Tạo hoặc cập nhật test phù hợp, ví dụ:



tests/unit/telegram/telegram-mapping.service.test.ts



Hoặc theo cấu trúc test hiện tại.



Test nên kiểm tra:



Tạo mapping hợp lệ.

Reject mapping thiếu telegramChatId.

Reject mapping thiếu telegramGroupName.

Update mapping.

Disable mapping.

Không cho duplicate active mapping nếu service có rule chống trùng.

Không dùng secret thật.



Nếu test DB phức tạp, có thể mock Prisma/service theo pattern hiện có.



**10. Không được làm**



Trong TASK-009, Claude không được:



Làm Microsoft OAuth.

Làm Graph API.

Làm webhook.

Làm queue/worker.

Làm parser Facebook/Meta email.

Làm code extractor.

Làm deduplication.

Làm code event log page.

Làm audit log page đầy đủ.

Gửi verification code thật.

Lưu hoặc log bot token.

Hardcode Telegram chat ID thật.

Tạo .env thật hoặc in nội dung .env.

Đổi stack kỹ thuật.

Refactor lớn ngoài scope.



**11. File/thư mục dự kiến tạo hoặc sửa**



Claude phải kiểm tra cấu trúc thực tế trước. Nếu project không dùng src/, dự kiến:



docs/tasks/TASK-009-telegram-mapping-module.md

services/telegram/telegram-mapping.service.ts

app/api/telegram/mappings/route.ts

app/api/telegram/mappings/\[id]/route.ts

app/admin/telegram/page.tsx

components/forms/TelegramMappingForm.tsx

components/tables/TelegramMappingTable.tsx

tests/unit/telegram/telegram-mapping.service.test.ts



Nếu project dùng src/, dùng đường dẫn tương ứng:



src/services/telegram/telegram-mapping.service.ts

src/app/api/telegram/mappings/route.ts

src/app/api/telegram/mappings/\[id]/route.ts

src/app/admin/telegram/page.tsx

src/components/forms/TelegramMappingForm.tsx

src/components/tables/TelegramMappingTable.tsx

src/tests/unit/telegram/telegram-mapping.service.test.ts



Không tạo song song cả src/ và non-src/.



**12. Lệnh kiểm tr**a



Sau khi sửa code, bắt buộc chạy:



npm run verify



Nếu có test riêng:



npm test



Hoặc lệnh test đang được project dùng.



Ngoài ra kiểm tra:



git status

git diff --stat



**13. Definition of Done**



TASK-009 chỉ được coi là hoàn thành khi:



Có file task này trong docs/tasks/.

Có Telegram mapping service.

Có API CRUD hoặc API quản lý mapping tương đương.

Có trang admin /admin/telegram.

Có form thêm/sửa mapping.

Có bảng danh sách mapping.

Có validation server-side.

Không hardcode bot token.

Không hardcode chat ID.

Không expose token ra frontend.

Không làm vượt scope sang Microsoft/parser/webhook.

npm run verify PASS.

Gemini review PASS.

User kiểm tra UI trong Cursor thấy trang hoạt động.

14. Những lỗi Claude/Gemini phải tránh trong TASK-009
Lỗi 1: Gửi nhầm group

Đây là lỗi nghiêm trọng nhất. Spec dự án nhấn mạnh mapping mailbox → telegram_chat_id phải cố định, thay đổi mapping phải có audit log, và nên test-send trước khi activate.

Lỗi 2: Hardcode chat ID

Sai:

const TELEGRAM_CHAT_ID = "-1001234567890";

Đúng:

Chat ID phải đến từ database/config mapping, không nằm cứng trong code.
Lỗi 3: Lộ bot token ra frontend

Sai:

const botToken = process.env.TELEGRAM_BOT_TOKEN;

trong component UI.

Đúng:

Frontend chỉ gọi API nội bộ.
Backend/service layer mới dùng sender service đã có từ TASK-008.
Lỗi 4: Làm vượt sang TASK-010 đến TASK-014

Không làm:

mock email input
Facebook detector
code extractor
dedupe
mock flow integration

Các task này thuộc Sprint 3, chưa phải TASK-009.

Lỗi 5: Làm vượt sang Microsoft

Không làm:

Microsoft OAuth
Graph API
Graph subscription
webhook
delta polling
worker

Các phần này nằm ở Sprint 5, Sprint 6 và Sprint 8, chưa thuộc TASK-009.