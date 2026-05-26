\# TASK-001: Test ECC workflow



\## Mục tiêu



Kiểm tra xem Claude Code, Cursor, Gemini CLI có đọc đúng rule/project context không.



\## Yêu cầu



1\. Không sửa code production.

2\. Chỉ đọc cấu trúc project.

3\. Báo cáo các file rule đã tìm thấy.

4\. Đề xuất bước tiếp theo để bắt đầu project.



\## Tiêu chí nghiệm thu



\- Claude Code nhận ra AGENTS.md và CLAUDE.md.

\- Gemini CLI nhận ra GEMINI.md.

\- Cursor rule tồn tại trong .cursor/rules/.

\- Không có file .env bị đọc hoặc in ra.

