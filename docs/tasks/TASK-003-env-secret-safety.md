\# TASK-003: Setup environment config \& secret safety



\## Mục tiêu



Thiết lập nền bảo mật/config cho project trước khi làm Microsoft OAuth, Telegram, database thật hoặc xử lý verification code thật.



Sau task này, project phải có:



1\. `.env.example`

2\. Env validation an toàn

3\. Secret masking utility

4\. Verification code masking/hash utility

5\. Safe logger không log token/code/password

6\. Test cho các utility bảo mật

7\. Tài liệu `docs/SECURITY\_RULES.md`



\## Yêu cầu chức năng



\### 1. `.env.example`



Tạo hoặc cập nhật `.env.example` với các biến placeholder, không có giá trị thật:



```env

APP\_ENV=development

APP\_URL=http://localhost:3000



DATABASE\_URL=postgresql://USER:PASSWORD@HOST:PORT/DATABASE



MICROSOFT\_CLIENT\_ID=

MICROSOFT\_CLIENT\_SECRET=

MICROSOFT\_TENANT\_ID=common

MICROSOFT\_REDIRECT\_URI=http://localhost:3000/api/microsoft/oauth/callback



TELEGRAM\_BOT\_TOKEN=

TELEGRAM\_ADMIN\_ALERT\_CHAT\_ID=



ENCRYPTION\_KEY=

LOG\_LEVEL=info

