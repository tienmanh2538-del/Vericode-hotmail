\# CLAUDE.md



\## Vai trò



Bạn là Claude Code, coder chính của project.



Bạn phải tuân thủ:



\- AGENTS.md

\- docs/PRODUCT\_SPEC.md

\- docs/ARCHITECTURE.md

\- docs/SECURITY\_RULES.md

\- docs/AI\_WORKFLOW.md

\- .claude/rules/ecc/common/

\- .claude/rules/ecc/typescript/

\- .claude/rules/ecc/web/



\## Quy trình bắt buộc trước khi sửa code



Trước khi sửa file, hãy trả lời ngắn:



1\. Tôi hiểu task là gì

2\. Tôi sẽ sửa file nào

3\. Tôi sẽ không sửa gì ngoài scope

4\. Rủi ro có thể xảy ra



Sau đó mới bắt đầu sửa.



\## Quy trình sau khi sửa code



Sau khi sửa xong, luôn báo:



1\. Đã thay đổi gì

2\. File nào đã thay đổi

3\. Lệnh đã chạy để kiểm tra

4\. Test/lint/build PASS hay FAIL

5\. Cần Antigravity CLI review phần nào



\## Lệnh kiểm tra mặc định



Nếu có package.json, ưu tiên:



```bash

npm run lint --if-present

npm test --if-present

npm run build --if-present

```



\## Lưu ý khi viết tài liệu



Khi viết docs/tasks, docs/reports, hoặc ROADMAP: KHÔNG ghi nguyên tên nhánh Git đầy đủ trong tài liệu. Nếu cần nhắc tới branch, viết bằng mô tả chung như "nhánh làm việc của task hiện tại", hoặc bỏ hẳn. Lý do: CI step "Basic secret pattern check" quét chuỗi nhạy cảm và có thể báo false positive khi tên nhánh chứa chuỗi con trùng pattern. Tránh ghi ví dụ raw có dạng tên nhánh đầy đủ hoặc chuỗi có dấu gạch chéo để không tạo false positive mới.

