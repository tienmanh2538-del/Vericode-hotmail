
# TASK-047 Safe mailbox onboarding flow

## 1. Mục tiêu

TASK-047 làm quy trình onboarding mailbox an toàn hơn cho app vận hành nội bộ.

Sau khi một mailbox được connect, người vận hành phải thấy rõ mailbox đó đã sẵn sàng nhận và relay verification code hay chưa.

Mailbox chỉ được coi là Ready khi có đủ điều kiện tối thiểu sau:

- Mailbox đã connect thành công.
- Mailbox được gắn đúng customer.
- Mailbox có đúng một active Telegram destination hợp lệ.
- Telegram destination hiển thị rõ group và topic nếu có.
- UI không tạo cảm giác mailbox đã an toàn khi còn thiếu mapping.

## 2. Bối cảnh

App này là internal staff app cho agency.

Khách hàng không login vào hệ thống. Khách hàng chỉ nhận verification code qua Telegram group hoặc topic đã được cấu hình.

OWNER và ADMIN quản lý toàn bộ. STAFF_READ_ONLY chỉ thấy dữ liệu được gán và không được có action onboarding nếu không có quyền.

Các rule đã chốt từ task trước phải được giữ nguyên:

- Nhiều mailbox có thể cùng dùng chung một Telegram group hoặc cùng một topic trong group.
- Mỗi mailbox chỉ có tối đa một active Telegram destination.
- Không làm customer portal.
- Không làm customer login.
- Không làm billing hoặc payment.
- Không làm public SaaS.

## 3. Vấn đề cần giải quyết

Hiện tại sau khi connect mailbox, người vận hành có thể chưa đủ thông tin để biết mailbox đó đã an toàn để chạy automation hay chưa.

Các rủi ro cần giảm:

- Mailbox connect xong nhưng chưa gắn đúng customer.
- Mailbox chưa có active Telegram mapping.
- Người vận hành không nhìn rõ group hoặc topic đích.
- Test-send nếu có nhưng không hiển thị rõ đích gửi.
- STAFF_READ_ONLY thấy hoặc dùng được action không phù hợp.
- UI tạo cảm giác mailbox đã Ready trong khi thực tế chưa Ready.

## 4. Rule sản phẩm chính thức

Mailbox chưa có active Telegram destination hợp lệ thì không được coi là Ready.

Ready nghĩa là mailbox đã connect, đã thuộc đúng customer, và có đúng một active Telegram destination.

Telegram destination có thể là group thường hoặc topic trong group.

Nhiều mailbox vẫn có thể dùng chung một Telegram group hoặc cùng một topic. TASK-047 không được phá rule này.

Mỗi mailbox chỉ có tối đa một active Telegram destination. TASK-047 không được tạo hoặc gợi ý multi-destination.

## 5. Scope được làm

Claude được phép rà soát và sửa tối thiểu các phần sau nếu cần:

- Flow connect mailbox hiện tại.
- Mailbox list hoặc mailbox detail để hiển thị onboarding status.
- Wording hoặc CTA sau khi connect mailbox.
- Hiển thị trạng thái Connected, Needs Mapping, Ready, Error nếu dữ liệu hiện có hỗ trợ.
- Hiển thị cảnh báo mailbox chưa có active mapping.
- Hiển thị rõ customer, mailbox, Telegram group và topic nếu có.
- Cải thiện nhẹ test-send destination nếu hệ thống hiện tại đã có test-send.
- Ẩn hoặc disable onboarding action cho STAFF_READ_ONLY nếu không có quyền.
- Thêm hoặc chỉnh test liên quan readiness status, permission visibility, và mapping clarity.
- Tạo file task này.
- Cập nhật Product Spec hoặc Roadmap nếu cần chốt wording safe onboarding.

## 6. Scope không làm

Không làm các phần sau trong TASK-047:

- Không làm customer login.
- Không làm customer portal.
- Không làm public SaaS.
- Không làm billing hoặc payment.
- Không làm bulk onboarding lớn.
- Không làm multi-destination.
- Không tạo role/RBAC mới.
- Không viết lại StaffAssignment nếu task trước đã ổn.
- Không sửa dashboard search/filter từ TASK-046 trừ link nhỏ phục vụ onboarding.
- Không sửa Microsoft OAuth/Graph nếu không liên quan.
- Không sửa Telegram sender core nếu không liên quan.
- Không sửa email detector/extractor.
- Không sửa queue hoặc worker nếu không có bằng chứng cần thiết.
- Không đổi rule nhiều mailbox dùng chung group/topic.
- Không đổi rule mỗi mailbox chỉ có một active destination.
- Không thao tác production database.
- Không đọc hoặc in nội dung env file.
- Không tạo migration mới nếu chưa chứng minh thật sự cần.
- Không sửa GitHub Actions để nới lỏng secret scan.
- Không mở rộng sang TASK-048 staging deployment.
- Không deploy production.

## 7. UX đề xuất

Flow đề xuất tối thiểu:

1. OWNER hoặc ADMIN vào trang Mailboxes.
2. Người dùng connect mailbox.
3. Sau khi connect, mailbox xuất hiện với trạng thái setup rõ ràng.
4. Nếu mailbox chưa gắn customer, UI yêu cầu chọn hoặc kiểm tra customer trước.
5. Nếu mailbox chưa có active Telegram mapping, UI hiển thị Needs Mapping.
6. UI dẫn người dùng sang nơi tạo hoặc chỉnh Telegram mapping.
7. Khi mapping tồn tại, UI hiển thị rõ group và topic nếu có.
8. Nếu hệ thống có test-send, UI hiển thị rõ test message sẽ gửi tới group/topic nào.
9. Chỉ khi customer và active Telegram destination hợp lệ, mailbox mới hiển thị Ready.

STAFF_READ_ONLY chỉ thấy trạng thái và thông tin read-only. Không có action connect, edit mapping, assign customer, hoặc test-send nếu action đó thay đổi dữ liệu hoặc gây gửi message.

## 8. Yêu cầu chức năng

- Mailbox list hoặc mailbox detail phải hiển thị trạng thái readiness rõ ràng.
- Mailbox chưa có active Telegram mapping không được hiển thị như Ready.
- Mailbox có active mapping phải hiển thị rõ Telegram group và topic nếu có.
- Nếu mailbox có lỗi token, subscription, disabled, hoặc trạng thái lỗi hiện có, UI phải hiển thị Error hoặc wording tương đương.
- Nếu có test-send destination, test-send phải hiển thị rõ đích gửi trước khi chạy.
- Nếu STAFF_READ_ONLY không có quyền onboarding, UI phải ẩn hoặc disable action liên quan.
- Backend guard hiện có vẫn phải chặn hành động không đủ quyền.
- OWNER và ADMIN vẫn có thể quản lý toàn bộ mailbox và mapping theo quyền hiện tại.

## 9. Yêu cầu kỹ thuật

- Ưu tiên computed readiness status từ dữ liệu hiện có.
- Không tạo cột DB mới nếu không cần.
- Không tạo migration nếu chưa chứng minh thật sự cần.
- Không đổi schema Prisma nếu chỉ cần UI/status.
- Không đổi routing rule.
- Không đổi worker/queue nếu logic hiện tại đã fail-safe khi không có mapping.
- Nếu cần expose field mới từ service, chỉ expose field đã có trong DB hoặc relation hiện có.
- Code mới phải nhỏ, dễ test, không viết lại kiến trúc lớn.
- Phải giữ TypeScript type-safe.
- Phải chạy npm run verify sau khi sửa.

## 10. Yêu cầu bảo mật

- Không đọc hoặc in nội dung env file.
- Không hardcode secret, token, password, client secret, connection string, hoặc Telegram bot token.
- Không log access token, refresh token, client secret, Telegram bot token, verification code đầy đủ, hoặc full email body.
- Không đưa secret thật vào docs, test, comment, commit message, hoặc log.
- Không hiển thị raw secret trong UI error.
- Nếu cần debug env, chỉ kiểm tra tên biến có tồn tại hay không, không in giá trị.
- Không sửa security rules để làm task dễ hơn.
- Tài liệu task không được chứa chuỗi giả lập dễ bị secret scan hiểu nhầm là secret thật.

## 11. Các điểm Claude cần kiểm tra

Trước khi sửa code, Claude cần kiểm tra:

- Flow connect mailbox hiện tại bắt đầu từ đâu.
- Sau OAuth callback, người dùng được redirect đi đâu.
- Mailbox hiện có field hoặc relation nào để xác định customer.
- Mailbox hiện có field nào để xác định status hoặc lỗi.
- Telegram mapping hiện đang xác định active destination như thế nào.
- Khi mailbox không có active mapping, pipeline hiện xử lý thế nào.
- UI hiện đang hiển thị mapping group/topic ở đâu.
- Test-send hiện có API/UI nào và có hỗ trợ topic hay không.
- STAFF_READ_ONLY hiện bị guard ở UI và backend như thế nào.
- Có component status/badge nào từ TASK-046 có thể tái dùng không.
- Có cần sửa docs Product Spec hoặc Roadmap không.

## 12. Các tình huống test cần có

Tối thiểu cần test hoặc xác minh các tình huống sau:

- Mailbox đã connect nhưng chưa có mapping thì hiển thị Needs Mapping hoặc wording tương đương.
- Mailbox có customer và active mapping thì hiển thị Ready.
- Mailbox có lỗi hiện có thì hiển thị Error hoặc wording tương đương.
- Telegram destination hiển thị rõ group và topic nếu có.
- Test-send nếu có phải cho thấy rõ đích gửi trước khi chạy.
- STAFF_READ_ONLY không thấy hoặc không dùng được onboarding action.
- OWNER hoặc ADMIN vẫn dùng được action cần thiết.
- Không tạo cảm giác mailbox chưa mapping là an toàn.
- Không làm mất khả năng nhiều mailbox dùng chung group/topic.
- Không cho một mailbox có nhiều active destination.
- Không có secret thật hoặc wording dễ gây false positive trong docs.

## 13. Lệnh kiểm tra

Sau khi sửa, Claude phải chạy:

```bash
npm run verify
````

Claude cũng phải báo kết quả:

```bash
git status --short
git diff --stat
```

Không commit trong task này. Chỉ báo cáo để người dùng đưa sang Gemini review.

## 14. Tiêu chí nghiệm thu

TASK-047 chỉ được coi là PASS khi:

* Có file task này trong docs/tasks.
* Onboarding status rõ ràng.
* Mailbox chưa mapping không bị coi là Ready.
* Mailbox Ready phải có customer và active Telegram destination hợp lệ.
* Telegram group/topic đích hiển thị rõ nếu dữ liệu hiện có hỗ trợ.
* Test-send destination nếu có phải rõ group/topic đích.
* STAFF_READ_ONLY không có action onboarding nếu không có quyền.
* OWNER và ADMIN vẫn quản lý được toàn bộ theo quyền hiện tại.
* Không phá rule nhiều mailbox dùng chung group/topic.
* Không phá rule mỗi mailbox chỉ có một active destination.
* Không làm customer login, customer portal, public SaaS, billing/payment.
* Không mở rộng sang TASK-048 staging deployment.
* Không đọc hoặc commit env file.
* Không có secret thật trong diff.
* Không tạo migration nếu không cần.
* npm run verify PASS.
* Gemini review PASS.

## 15. Format báo cáo sau khi Claude làm xong

Claude cần báo cáo bằng tiếng Việt theo cấu trúc:

### Tôi đã thay đổi gì

Mô tả ngắn các thay đổi chính.

### File đã thay đổi

Liệt kê file đã sửa hoặc tạo.

### Những gì tôi cố ý không sửa

Xác nhận không sửa ngoài scope.

### Kết quả kiểm tra

Ghi rõ npm run verify PASS hoặc FAIL.

### Git status và diff

Dán kết quả git status --short và git diff --stat.

### Rủi ro còn lại

Nêu rõ còn điểm nào cần Gemini review kỹ.

### Đề xuất cho Gemini review

Nêu các khu vực Gemini cần kiểm tra.

````

---

