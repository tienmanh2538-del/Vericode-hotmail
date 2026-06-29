\# PRODUCT\_SPEC.md



\## Tên sản phẩm



Verification Code Relay Tool



\## Mục tiêu



Xây dựng tool giúp agency tự động nhận email chứa mã xác minh, trích xuất mã, sau đó gửi mã vào Telegram group tương ứng của từng khách hàng.



\## Người dùng chính



\- Admin nội bộ của agency

\- Nhân sự vận hành

\- Khách hàng nhận mã qua Telegram group



\## MVP cần có



1\. Admin có thể đăng nhập.

2\. Admin có thể tạo khách hàng.

3\. Admin có thể cấu hình email source cho từng khách hàng.

4\. Admin có thể cấu hình Telegram group cho từng khách hàng.

5\. Hệ thống có thể đọc email mẫu/mock.

6\. Hệ thống có thể nhận diện email chứa verification code.

7\. Hệ thống có thể trích xuất mã xác minh.

8\. Hệ thống có thể gửi mã vào Telegram group tương ứng.

9\. Hệ thống có trang log để xem:

&#x20;  - Email nào đã xử lý

&#x20;  - Mã nào đã gửi

&#x20;  - Gửi thành công hay thất bại

&#x20;  - Lỗi nếu có



\## Những việc chưa làm ở MVP



1\. Chưa kết nối Hotmail thật.

2\. Chưa xử lý nhiều nhà cung cấp email.

3\. Chưa làm billing/payment.

4\. Chưa làm phân quyền phức tạp.

5\. Chưa deploy production.

6\. Chưa tự động retry nâng cao.



\## Yêu cầu bảo mật



1\. Không hardcode token/password/API key.

2\. Không log password/token/email secret.

3\. Không hiển thị toàn bộ nội dung email nếu không cần.

4\. Verification code chỉ lưu khi cần debug và phải có thời gian hết hạn.

5\. Telegram bot token phải lưu trong biến môi trường.

6\. Mỗi khách hàng chỉ được map với Telegram group của chính họ.



\## Tiêu chí nghiệm thu MVP



MVP được coi là đạt khi:



1\. Admin tạo được một khách hàng test.

2\. Admin cấu hình được Telegram group test.

3\. Hệ thống xử lý được một email mẫu.

4\. Hệ thống trích xuất đúng verification code.

5\. Hệ thống gửi đúng code vào đúng Telegram group.

6\. Log hiển thị trạng thái xử lý rõ ràng.

7\. Antigravity CLI review không còn lỗi Critical/High.

8\. GitHub Actions pass.

