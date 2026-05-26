param(
    [string]$TaskFile = "docs/tasks/TASK-001.md"
)

[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

New-Item -ItemType Directory -Force docs/reports | Out-Null

$Prompt = @"
Bạn là Gemini CLI, reviewer/tester độc lập.

Quan trọng:
- Luôn trả lời bằng tiếng Việt.
- Không dịch nội dung file tiếng Việt sang tiếng Anh.
- Không sửa file.
- Không đọc hoặc in nội dung .env.
- Không tự gọi shell command.
- Không dùng tool run_shell_command.
- Không dùng invoke_agent.
- Nếu cần test/lint/build, chỉ liệt kê lệnh cần chạy.

Hãy đọc:
- GEMINI.md
- AGENTS.md
- $TaskFile
- git diff hiện tại
- package.json nếu có

Nhiệm vụ:
1. Kiểm tra code có đúng task không.
2. Tìm bug logic.
3. Tìm lỗi bảo mật.
4. Kiểm tra thiếu test.
5. Nếu có package.json, chỉ đề xuất các lệnh cần chạy:
   - npm run lint --if-present
   - npm test --if-present
   - npm run build --if-present

Luật:
- Không sửa file.
- Không khen chung chung.
- Viết tiếng Việt dễ hiểu.
- Trả kết quả dạng bảng.
- Cuối cùng ghi PASS hoặc FAIL.

Nếu FAIL, ghi rõ những lỗi Claude Code cần sửa.
"@

gemini -p $Prompt | Tee-Object -FilePath "docs\reports\gemini-ecc-review.md"