\# TASK-002: Setup lint, typecheck, test, build, verify



\## Mục tiêu



Thiết lập hệ thống kiểm tra chất lượng code cho toàn bộ project.



Sau task này, project phải có các lệnh:



1\. `npm run lint`

2\. `npm run typecheck`

3\. `npm run test`

4\. `npm run build`

5\. `npm run verify`



\## Yêu cầu



1\. Thiết lập ESLint nếu project chưa có.

2\. Không dùng `next lint`.

3\. Lệnh lint phải dùng `eslint .`.

4\. Thiết lập TypeScript typecheck bằng `tsc --noEmit`.

5\. Thiết lập Vitest cho unit test.

6\. Tạo ít nhất 1 test mẫu đơn giản để chứng minh test chạy được.

7\. Cập nhật `package.json` scripts.

8\. Cập nhật GitHub Actions để chạy `npm run verify`.

9\. Không thêm chức năng sản phẩm mới.

10\. Không thêm Microsoft OAuth.

11\. Không thêm Telegram thật.

12\. Không thêm database thật.

13\. Không đọc hoặc in nội dung `.env`.



\## Scripts mong muốn



```json

{

&#x20; "scripts": {

&#x20;   "lint": "eslint .",

&#x20;   "typecheck": "tsc --noEmit",

&#x20;   "test": "vitest run",

&#x20;   "test:watch": "vitest",

&#x20;   "build": "next build",

&#x20;   "verify": "npm run lint \&\& npm run typecheck \&\& npm run test \&\& npm run build"

&#x20; }

}





https://github.com/tienmanh2538-del/Vericode-hotmail.git





cd C:\\Projects\\verification-tool



git remote remove origin

git remote add origin https://github.com/tienmanh2538-del/Vericode-hotmail.git



git remote -v

