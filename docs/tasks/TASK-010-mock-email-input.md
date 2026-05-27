\# TASK-010: Tạo mock email input



\## 1. Mục tiêu



Tạo một mock email input để admin/dev có thể nhập hoặc xem email giả lập phục vụ các task parser sau này.



Mock email input dùng để mô phỏng dữ liệu email nhận từ Microsoft Graph trong tương lai, nhưng ở task này chưa kết nối Microsoft Graph thật, chưa detector, chưa extractor, chưa dedupe và chưa gửi Telegram.



Mục tiêu chính:



```text

Admin/dev nhập email giả lập

→ hệ thống validate dữ liệu cơ bản

→ hiển thị preview/mock JSON

→ lưu hoặc giữ mock email ở mức dev/local

→ chuẩn bị dữ liệu cho TASK-011/TASK-012

2\. Bối cảnh



TASK-010 thuộc Sprint 3 — Parser \& mock flow.



Roadmap liên quan:



TASK-010: Tạo mock email input

TASK-011: Tạo Facebook/Meta verification detector

TASK-012: Tạo code extractor module

TASK-013: Tạo processed message \& deduplication service

TASK-014: Kết nối mock flow: mock email → detect → extract → dedupe → Telegram



Vì vậy TASK-010 chỉ làm phần input/mock data. Không làm logic của các task sau.



3\. Yêu cầu chức năng

3.1. Mock email data shape



Tạo data shape tối thiểu cho mock email:



type MockEmailInput = {

&#x20; mailboxEmail: string;

&#x20; fromEmail: string;

&#x20; fromName?: string;

&#x20; subject: string;

&#x20; receivedAt: string;

&#x20; bodyPreview?: string;

&#x20; body: string;

};



Có thể bổ sung field nếu phù hợp với codebase hiện tại:



id?: string;

createdAt?: string;



Nhưng không thêm field nhạy cảm không cần thiết.



3.2. Admin mock email page



Tạo trang admin để nhập mock email.



Route đề xuất:



app/admin/mock-email/page.tsx



Nếu project đang dùng src/, dùng:



src/app/admin/mock-email/page.tsx



Trang cần có:



\- Tiêu đề: Mock Email Input

\- Form nhập mailboxEmail

\- Form nhập fromEmail

\- Form nhập fromName

\- Form nhập subject

\- Form nhập receivedAt

\- Form nhập bodyPreview

\- Form nhập body

\- Nút submit/save

\- Nút reset

\- Khu vực preview JSON an toàn

3.3. API mock email, nếu phù hợp



Có thể tạo API route nội bộ:



app/api/mock-email/route.ts



Hoặc nếu project dùng src/:



src/app/api/mock-email/route.ts



API tối thiểu:



GET /api/mock-email

POST /api/mock-email



Yêu cầu:



\- Validate field bắt buộc

\- Không gọi Microsoft Graph

\- Không gọi Telegram

\- Không ghi dữ liệu nhạy cảm thật

\- Không log full body nếu không cần



Nếu codebase hiện tại chưa phù hợp để tạo API, có thể chỉ tạo UI + fixture/test helper, nhưng phải giải thích rõ trong kết quả cuối.



3.4. Email sample fixtures



Tạo thư mục fixture nếu chưa có:



tests/fixtures/email-samples/



Tạo một số sample email giả:



facebook-verification-basic.json

facebook-security-code-vi.json

non-facebook-newsletter.json

non-code-security-alert.json



Yêu cầu fixture:



\- Không dùng email khách hàng thật

\- Không dùng code thật

\- Không dùng token/password/secret

\- Code mẫu chỉ là dữ liệu giả, ví dụ 123456 hoặc 654321

\- Nội dung đủ giống email thật để task detector/extractor sau này có dữ liệu test

4\. File/thư mục dự kiến tạo hoặc sửa



Claude phải kiểm tra cấu trúc thực tế trước khi tạo file.



Có thể tạo/sửa các file sau, tùy repo thực tế:



docs/tasks/TASK-010-mock-email-input.md

app/admin/mock-email/page.tsx

app/api/mock-email/route.ts

tests/fixtures/email-samples/facebook-verification-basic.json

tests/fixtures/email-samples/facebook-security-code-vi.json

tests/fixtures/email-samples/non-facebook-newsletter.json

tests/fixtures/email-samples/non-code-security-alert.json



Nếu project dùng src/, dùng vị trí tương ứng:



src/app/admin/mock-email/page.tsx

src/app/api/mock-email/route.ts

src/tests/fixtures/email-samples/\*



Không được tạo song song cả app/ và src/app/ nếu repo chỉ dùng một kiểu.



5\. Tiêu chí nghiệm thu



TASK-010 được coi là đạt khi:



\- Có file task docs/tasks/TASK-010-mock-email-input.md

\- Có mock email input page hoặc mock email input API phù hợp với cấu trúc repo

\- Có data shape rõ ràng cho mock email

\- Có fixture email sample giả để dùng cho task sau

\- Form/API validate field bắt buộc ở mức cơ bản

\- Preview/mock JSON không chứa secret thật

\- Không có Microsoft Graph thật

\- Không có Telegram send thật

\- Không có detector/extractor/dedupe thật

\- npm run verify PASS

6\. Không được làm trong task này



Không làm các phần sau:



\- Không tạo Facebook/Meta detector service

\- Không tạo code extractor service

\- Không tạo deduplication service

\- Không tạo processed message service

\- Không kết nối Telegram sender vào mock flow

\- Không gọi Telegram API

\- Không gọi Microsoft Graph API

\- Không tạo OAuth callback/connect URL

\- Không tạo webhook/queue/worker

\- Không sửa schema database nếu không cần thiết

\- Không lưu hoặc log full code thật

\- Không dùng dữ liệu khách hàng thật trong fixture

7\. Lệnh kiểm tra



Chạy các lệnh sau sau khi hoàn thành:



npm run verify



Nếu project có test riêng:



npm test



Nếu có UI:



npm run dev



Sau đó mở trang admin mock email trong browser và kiểm tra form hiển thị đúng.



8\. Kết quả Claude phải báo lại



Claude phải kết luận theo format:



1\. Đã làm gì

2\. File nào đã tạo/sửa

3\. Có làm vượt scope không

4\. Lệnh nào đã chạy

5\. npm run verify PASS/FAIL

6\. Rủi ro còn lại

7\. Gợi ý cho TASK-011

