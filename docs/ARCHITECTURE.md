\# ARCHITECTURE.md



\## Kiến trúc MVP



Hệ thống gồm các phần:



1\. Web Admin

&#x20;  - Giao diện để admin đăng nhập, quản lý khách hàng, xem log.



2\. Backend API

&#x20;  - Xử lý logic chính.

&#x20;  - Nhận yêu cầu từ giao diện.

&#x20;  - Lưu dữ liệu vào database.



3\. Database

&#x20;  - Lưu khách hàng, cấu hình Telegram, email đã xử lý, log.



4\. Email Processor

&#x20;  - Đọc email mẫu/mock ở MVP.

&#x20;  - Sau này mới nâng cấp sang đọc Hotmail thật.



5\. Code Extractor

&#x20;  - Trích xuất verification code từ nội dung email.



6\. Telegram Sender

&#x20;  - Gửi mã vào Telegram group tương ứng.



7\. Audit Log

&#x20;  - Ghi lại trạng thái xử lý.



\## Công nghệ đề xuất cho MVP



\- Next.js: làm web app full-stack.

\- TypeScript: giúp giảm lỗi khi code.

\- Prisma: kết nối database dễ hơn.

\- PostgreSQL hoặc SQLite ở local.

\- Playwright: test giao diện sau này.

\- GitHub Actions: chạy test/build tự động.



\## Nguyên tắc



1\. Làm local trước.

2\. Dùng mock email trước.

3\. Không kết nối email thật khi chưa xong MVP.

4\. Không lưu secret trong code.

5\. Mỗi module phải nhỏ, dễ test.

