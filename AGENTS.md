\# AGENTS.md



\## Mục tiêu



Project này dùng nhiều AI cùng phối hợp theo dây chuyền:



\- ChatGPT: planner, product manager, giải thích cho người không chuyên code.

\- Claude Code: coder chính, được phép sửa code khi task đã rõ.

\- Antigravity CLI: tester và reviewer độc lập, mặc định không sửa code.

\- Cursor: môi trường xem project, hỗ trợ sửa nhỏ khi người dùng duyệt.



\## Luật chung bắt buộc



1\. Không tự ý mở rộng scope.

2\. Không tự ý đổi kiến trúc lớn nếu chưa được duyệt.

3\. Không hardcode API key, token, password, client secret.

4\. Không ghi verification code, token, password vào log.

5\. Không đọc hoặc hiển thị nội dung file `.env` trừ khi người dùng yêu cầu rõ ràng và có lý do hợp lệ.

6\. Không thao tác với production database.

7\. Mỗi thay đổi phải có cách kiểm tra.

8\. Mỗi task phải có tiêu chí nghiệm thu.

9\. Nếu test/lint/build fail, phải báo rõ lỗi trước khi sửa.

10\. Ưu tiên code đơn giản, dễ bảo trì.



\## Quy trình chuẩn



1\. Đọc task trong `docs/tasks/`.

2\. Đọc `docs/PRODUCT\_SPEC.md`, `docs/ARCHITECTURE.md`, `docs/SECURITY\_RULES.md`.

3\. Coder AI thực hiện task.

4\. Reviewer AI kiểm tra `git diff`.

5\. Tester AI chạy test/lint/build.

6\. Chỉ commit khi review PASS.



\## Quy tắc vai trò



\### Claude Code



\- Là coder chính.

\- Được sửa code khi task rõ.

\- Trước khi sửa phải nói file nào sẽ sửa.

\- Sau khi sửa phải ghi file đã đổi và lệnh test.



\### Antigravity CLI



\- Là reviewer/tester độc lập (từ TASK-076 thay cho Gemini CLI).

\- Mặc định không sửa file.

\- Chỉ sửa khi prompt có dòng: `ALLOW\_ANTIGRAVITY\_EDIT=true`.

\- Luôn kết luận PASS hoặc FAIL.



\### Cursor



\- Dùng để xem thay đổi, duyệt giao diện, chỉnh sửa nhỏ.

\- Không để Cursor agent và Claude cùng sửa một lúc.



\### ChatGPT



\- Không trực tiếp sửa code local.

\- Dùng để viết spec, chia task, giải thích, review báo cáo.

