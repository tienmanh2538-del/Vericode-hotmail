
## 11. Nội dung file `docs/tasks/TASK-055-per-mailbox-throttling-queue-safety.md`

Bạn có thể copy nội dung dưới đây để tạo file thủ công.

````md
# TASK-055 — Per-mailbox throttling & queue safety

## Mục tiêu

Triển khai tối thiểu cơ chế per-mailbox throttling và queue safety để tránh một mailbox, một reusable Telegram destination, hoặc một workload lớn tạo quá nhiều request gây nghẽn queue, spam Microsoft Graph/Telegram, hoặc ảnh hưởng toàn hệ thống.

TASK này dựa trên kết quả TASK-054 scale test plan. Đây là implementation tối thiểu cho queue safety, chưa phải production scale-up đầy đủ.

## Bối cảnh

Dự án là internal staff app. Khách hàng không login, chỉ nhận verification code qua Telegram group/topic.

Các rule bắt buộc vẫn giữ nguyên:

- Nhiều mailbox có thể dùng chung một reusable Telegram destination.
- Mỗi mailbox chỉ có tối đa một active Telegram destination.
- Không làm một mailbox gửi tới nhiều Telegram destinations.
- Không broadcast code tới nhiều group/topic.
- Mailbox disconnected không được poll, renew subscription hoặc relay code.
- Mailbox chưa mapping hợp lệ không được coi là Ready.

Sau TASK-054, rủi ro chính là một mailbox hoặc một shared destination có thể tạo burst job/request, làm queue bị nghẽn hoặc gây rate limit từ Microsoft Graph/Telegram.

## Scope được làm

- Thêm cơ chế giới hạn xử lý đồng thời theo từng mailbox.
- Thêm guard để một mailbox lỗi hoặc burst không làm nghẽn toàn bộ queue.
- Re-check mailbox status/readiness trong worker hoặc pipeline trước khi gọi Graph/Telegram.
- Skip an toàn nếu mailbox disconnected, không active, hoặc chưa có active mapping hợp lệ.
- Thêm retry/backoff có giới hạn cho lỗi transient liên quan tới Graph/Telegram nếu code hiện tại chưa đủ.
- Thêm safety tối thiểu cho shared Telegram destination để tránh gửi quá dày vào cùng một group/topic.
- Thêm test cho mailbox lock, throttling, retry/backoff, skip disconnected/no mapping, và one-mailbox-one-destination.
- Cập nhật tài liệu task/report liên quan.

## Scope không làm

- Không deploy production.
- Không dùng production DB hoặc production Redis.
- Không dùng mailbox khách hàng thật.
- Không dùng Telegram group khách hàng thật.
- Không gửi verification code thật.
- Không spam Microsoft Graph hoặc Telegram.
- Không làm live scale test 100–200 mailbox thật.
- Không làm dashboard vận hành mới; phần đó để TASK-056.
- Không làm daily operations checklist.
- Không làm customer portal.
- Không làm một mailbox gửi tới nhiều Telegram destinations.
- Không làm broadcast.
- Không sửa các file môi trường chứa giá trị thật.
- Không sửa GitHub Actions để nới lỏng secret scan.

## Yêu cầu thiết kế

### Per-mailbox throttling

Worker hoặc pipeline cần đảm bảo cùng một thời điểm không có nhiều job cùng mailbox xử lý song song theo cách gây gọi Graph/Telegram đồng thời.

Thiết kế nên ưu tiên:

- Lock theo mailboxId.
- Lock có thời hạn tự hết hạn để tránh kẹt khi worker crash.
- Lock được release trong finally.
- Nếu mailbox đang bận, job phải delay/retry an toàn và có giới hạn.
- Không gọi Graph hoặc Telegram khi chưa lấy được lock.

### Queue safety

Queue safety cần đảm bảo:

- Job payload thiếu dữ liệu bắt buộc thì fail non-retryable.
- Một mailbox lỗi không giữ worker mãi.
- Retry có giới hạn, không retry vô hạn.
- Backoff cho lỗi transient.
- Job cũ của mailbox đã disconnected phải skip an toàn.
- Mailbox chưa có active mapping hợp lệ phải skip an toàn.
- Worker không gửi Telegram nếu mailbox không Ready.

### Destination safety

Vì nhiều mailbox có thể dùng chung reusable Telegram destination, cần có safety tối thiểu để không gửi quá dày vào cùng một group/topic.

Yêu cầu:

- Không thay đổi rule routing.
- Không thêm multi-destination.
- Không broadcast.
- Không log raw verification code.
- Nếu destination đang bị throttle, job phải retry/delay có giới hạn hoặc fail an toàn tùy loại lỗi.

## Bảo mật

- Không hardcode token, password, client secret, connection string, Telegram bot token, hoặc giá trị môi trường thật.
- Không đọc hoặc in nội dung `.env`, `.env.local`, `.env.staging`, `.env.production`.
- Không log access token, refresh token, Telegram bot token, verification code đầy đủ, hoặc full email body.
- Chỉ dùng logger an toàn hiện có.
- Nếu cần log code, chỉ log dạng masked/hash theo helper hiện có.
- Error message hiển thị ra UI hoặc report không được chứa secret, full code, hoặc full email body.
- Không sửa GitHub Actions để nới lỏng secret scan.

## Customer isolation

- Worker chỉ được resolve destination thông qua service layer hiện có.
- Mailbox chỉ được gửi tới active destination hợp lệ của chính mailbox đó.
- Mapping/destination phải thuộc đúng customer hợp lệ.
- Nếu không xác minh được destination an toàn, không gửi Telegram.
- Retry không được đổi sang destination khác.
- Không fallback sang Telegram group/topic khác.

## Gợi ý vùng code cần kiểm tra

Claude cần tự kiểm tra repo trước khi sửa, nhưng có thể bắt đầu từ các vùng sau:

- Queue foundation và email worker.
- Email graph-message pipeline.
- Delta polling enqueue path.
- Telegram sender/retry service.
- Telegram mapping/reusable destination service.
- Mailbox status/readiness logic.
- Tests liên quan tới queue, email worker, Telegram mapping, mailbox disconnect.

Không được sửa lan man ngoài các vùng cần thiết.

## Test bắt buộc

Cần bổ sung hoặc cập nhật test cho các case sau:

1. Hai job cùng mailbox không được xử lý Graph/Telegram song song.
2. Nếu mailbox lock đang bận, job sau bị delay/retry an toàn và không gọi Graph/Telegram ngay.
3. Lock được release kể cả khi pipeline lỗi.
4. Mailbox disconnected thì job bị skip trước khi gọi Graph/Telegram.
5. Mailbox chưa có active mapping hợp lệ thì job bị skip và không gửi Telegram.
6. Một mailbox lỗi transient không retry vô hạn.
7. Graph 429/5xx được backoff/retry có giới hạn nếu flow hiện tại hỗ trợ.
8. Telegram 429/5xx được backoff/retry có giới hạn nếu flow hiện tại hỗ trợ.
9. Shared Telegram destination không bị gửi quá dày trong cùng một khoảng thời gian ngắn.
10. Rule one-mailbox-one-active-destination vẫn giữ nguyên.
11. Không có log chứa token, verification code đầy đủ, hoặc full email body.

## Lệnh kiểm tra

Sau khi sửa xong, phải chạy:

```bash
npm run verify
````

Nếu repo có test riêng phù hợp, có thể chạy thêm test hẹp trước khi chạy verify đầy đủ.

## Tiêu chí nghiệm thu

TASK-055 chỉ được coi là PASS khi:

* Có file task này trong `docs/tasks/`.
* Có implementation tối thiểu cho per-mailbox throttling và queue safety.
* Worker/pipeline skip an toàn mailbox disconnected hoặc chưa mapping hợp lệ.
* Một mailbox không thể gây nghẽn toàn bộ queue bằng retry vô hạn.
* Shared Telegram destination có safety tối thiểu chống burst.
* Không phá rule nhiều mailbox dùng chung destination.
* Không phá rule mỗi mailbox chỉ có tối đa một active destination.
* Không thêm broadcast.
* Không log token, secret, full verification code, hoặc full email body.
* `npm run verify` PASS.
* Gemini CLI review PASS.
* Diff không chứa secret thật và không có wording dễ gây secret-scan false positive.

