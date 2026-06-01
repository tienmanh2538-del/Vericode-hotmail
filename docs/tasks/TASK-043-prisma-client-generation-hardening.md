# TASK-043 — Prisma Client generation hardening

## Mục tiêu

Đảm bảo Prisma Client được generate ổn định khi cài đặt project trên PC mới, khi đổi máy làm việc, và khi chạy CI.

Task này nhằm tránh lỗi kiểu schema Prisma đã có field mới nhưng Prisma Client trong thư mục dependency vẫn là bản cũ.

Ví dụ lỗi cần phòng tránh là code TypeScript đã dùng field mới trong Prisma schema, nhưng Prisma Client chưa được generate lại nên typecheck hoặc build fail.

## Bối cảnh

Project dùng Prisma để làm ORM kết nối database.

Prisma Client là code được Prisma tự sinh ra dựa trên file `prisma/schema.prisma`. Khi schema thay đổi, Prisma Client cũng cần được generate lại.

Sau TASK-041, project có thêm field Telegram topic trong Prisma schema. Nếu một PC mới hoặc CI dùng Prisma Client cũ, TypeScript có thể không nhận ra field mới dù schema đã đúng.

Đây là vấn đề về generated client bị lệch với schema, không mặc định là lỗi database migration.

## Vấn đề cần giải quyết

Khi developer đổi PC, clone repo mới, pull code mới, hoặc CI chạy lại từ đầu, hệ thống cần tự đảm bảo Prisma Client được tạo đúng lúc.

Task này cần chọn cách ít rủi ro nhất để:

- Sau khi cài dependency, Prisma Client có thể được generate.
- Trước khi verify, typecheck hoặc build, Prisma Client không bị lệch schema.
- CI và local development dùng cùng một cách kiểm tra dễ hiểu.
- Không cần người dùng không chuyên code phải nhớ chạy lệnh thủ công mỗi lần.

## Scope được làm

Claude được phép kiểm tra và cân nhắc các thay đổi sau:

- Kiểm tra `package.json`.
- Đánh giá các npm script hiện tại.
- Cân nhắc thêm script riêng cho Prisma Client generation.
- Cân nhắc chạy Prisma Client generation trong quá trình cài dependency.
- Cân nhắc chạy Prisma Client generation trước verify hoặc build nếu phù hợp.
- Kiểm tra CI workflow hiện tại để đảm bảo CI không bị lệch Prisma Client.
- Cập nhật task file này nếu cần làm rõ kết quả thực tế.
- Thêm kiểm tra nhẹ nếu hợp lý và không mở rộng scope.

## Scope không làm

Task này không được làm các việc sau:

- Không sửa Prisma schema nếu không có bằng chứng bắt buộc.
- Không tạo migration mới nếu không có thay đổi schema thật sự.
- Không chạy migration trên production database.
- Không thao tác production database.
- Không đọc hoặc in nội dung file `.env` hoặc `.env.local`.
- Không yêu cầu người dùng paste secret thật.
- Không sửa workflow CI theo hướng bỏ qua hoặc nới lỏng secret scan.
- Không disable bất kỳ kiểm tra bảo mật nào.
- Không thay đổi logic routing Telegram.
- Không làm tính năng một mailbox gửi tới nhiều destination.
- Không mở rộng sang TASK-044 hoặc các task sau.

## Yêu cầu kỹ thuật

Claude cần chọn giải pháp tối thiểu, dễ hiểu và ít rủi ro.

Các yêu cầu kỹ thuật chính:

- Prisma Client phải được generate từ schema hiện tại.
- PC mới sau khi cài dependency cần có Prisma Client đúng.
- CI cần generate Prisma Client trước các bước typecheck, test hoặc build nếu cần.
- `npm run verify` phải PASS.
- Nếu thêm npm script mới, tên script cần rõ nghĩa.
- Nếu sửa CI workflow, phải giải thích rõ vì sao chỉ sửa `package.json` là chưa đủ.
- Không tạo migration mới cho task này nếu schema không đổi.
- Không yêu cầu kết nối database thật để chỉ generate Prisma Client.
- Không phụ thuộc vào production environment.

## Yêu cầu bảo mật

Claude phải tuân thủ các luật bảo mật của project:

- Không đọc hoặc in nội dung `.env` và `.env.local`.
- Không ghi secret thật vào docs, code, log, commit message hoặc report.
- Không log token, refresh token, client secret, Telegram bot token, verification code đầy đủ, hoặc full email body.
- Không thao tác production database.
- Không sửa luật bảo mật để né lỗi.
- Không nới lỏng secret scan trong CI.
- Nếu có sửa docs, phải tránh wording dễ gây secret scan false positive.

## Các phương án cần Claude đánh giá

Claude cần đánh giá tối thiểu các phương án sau trước khi chọn:

### Phương án một

Thêm hoặc chuẩn hóa npm script riêng để chạy Prisma Client generation.

Ví dụ mục tiêu là có một lệnh rõ ràng để generate Prisma Client khi cần, thay vì để người dùng nhớ lệnh Prisma trực tiếp.

### Phương án hai

Chạy Prisma Client generation sau khi cài dependency.

Mục tiêu là PC mới hoặc môi trường fresh install tự có Prisma Client đúng sau khi cài package.

Claude cần kiểm tra rủi ro của phương án này với local và CI.

### Phương án ba

Chạy Prisma Client generation trước verify hoặc trước build.

Mục tiêu là trước khi typecheck hoặc build, Prisma Client không bị lệch schema.

Claude cần kiểm tra xem cách này có trùng lặp quá nhiều hoặc làm verify chậm không.

### Phương án bốn

Sửa CI workflow nếu package scripts chưa đủ.

Chỉ chọn phương án này nếu CI hiện tại không đảm bảo Prisma Client được generate đúng thời điểm.

Không được sửa CI theo hướng bỏ qua secret scan hoặc bỏ qua verify.

## Lệnh kiểm tra

Sau khi sửa, Claude cần chạy các lệnh kiểm tra phù hợp.

Tối thiểu cần chạy:

```powershell
npm run verify
````

Nếu có thêm script Prisma riêng, cần chạy script đó trực tiếp một lần.

Nếu Claude muốn mô phỏng PC mới, có thể đề xuất cách kiểm tra an toàn, nhưng không được tự xóa dữ liệu quan trọng nếu chưa nói rõ rủi ro. Không cần chạy thao tác nặng nếu không cần thiết.

Claude cần báo lại rõ lệnh nào đã chạy và kết quả PASS hoặc FAIL.

## Tiêu chí nghiệm thu

Task được coi là PASS khi:

* Có file task này trong `docs/tasks/`.
* Giải pháp generate Prisma Client rõ ràng trong npm scripts hoặc CI.
* PC mới hoặc môi trường fresh install có đường chạy rõ ràng để generate Prisma Client.
* CI không bị phụ thuộc vào Prisma Client cũ trong cache hoặc node_modules cũ.
* Không sửa schema Prisma nếu không cần.
* Không tạo migration mới nếu không cần.
* Không đọc hoặc in `.env` / `.env.local`.
* Không có secret thật trong diff.
* Không có wording docs dễ gây secret scan false positive.
* `npm run verify` PASS.
* Gemini review PASS.
* Sau khi push, GitHub Actions PASS.

## Format báo cáo sau khi Claude làm xong

Sau khi hoàn tất, Claude cần báo cáo bằng tiếng Việt theo format sau:

```text
Tôi đã hoàn thành TASK-043.

Tôi đã thay đổi những gì
- ...

File đã thay đổi
- ...

Lý do chọn giải pháp
- ...

Các phương án đã cân nhắc
- ...

Lệnh đã chạy để kiểm tra
- ...

Kết quả kiểm tra
- ...

Git status hiện tại
- Dán kết quả `git status --short`

Diff stat hiện tại
- Dán kết quả `git diff --stat`

Rủi ro còn lại nếu có
- ...

Cần Gemini review kỹ phần nào
- ...
```

Claude không được commit trong task này.

````

---
