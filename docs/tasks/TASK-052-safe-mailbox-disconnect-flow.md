
# TASK-052 — Safe mailbox disconnect flow

## Mục tiêu

Tạo flow an toàn để OWNER hoặc ADMIN có thể ngắt kết nối mailbox khỏi hệ thống mà không hard delete mailbox và không mất dữ liệu lịch sử cần cho audit/debug.

Sau khi disconnect, mailbox không còn được poll, không còn được renew subscription, không còn relay verification code, và connection credential không còn được dùng bởi worker hoặc pipeline.

## Bối cảnh

TASK-051 đã đạt pre-live staging validation pass ở các phần staging quan trọng như login/logout, OAuth callback, mailbox TEST connect, customer assignment UI, Telegram mapping UI, Telegram test-send, Mock Email process/send, và API scope check cho mock email process.

Phần live Microsoft email thật vẫn deferred sang internal beta hoặc product trial vì hiện chưa có email thật phù hợp.

TASK-052 tập trung vào vận hành an toàn: khi một mailbox không còn cần dùng, admin phải có cách disconnect mà không xóa lịch sử xử lý.

## Scope được làm

- Thêm action disconnect mailbox trong mailbox detail.
- Chỉ OWNER hoặc ADMIN được disconnect mailbox.
- STAFF_READ_ONLY không được disconnect qua UI, API hoặc service.
- Không hard delete mailbox.
- Không xóa audit log, code event log hoặc processed message history.
- Sau khi disconnect, mailbox phải hiển thị rõ trạng thái disconnected/inactive trên UI.
- Mailbox disconnected không được poll bởi delta polling worker.
- Mailbox disconnected không được renew subscription bởi subscription renewal worker.
- Mailbox disconnected không được xử lý relay bởi email worker/pipeline.
- Active Telegram mapping của mailbox phải được disable hoặc chuyển sang trạng thái inactive.
- Graph subscription liên quan phải được mark inactive/deleted/disabled ở local.
- Nếu có thể, hệ thống thử delete Graph subscription remote.
- Nếu delete Graph subscription remote fail, hệ thống vẫn phải fail-safe: mailbox đã disconnected ở local và không relay.
- Ghi audit log an toàn cho hành động disconnect.

## Scope không làm

- Không hard delete mailbox.
- Không xóa logs/history.
- Không xóa processed message history.
- Không làm reusable Telegram destinations.
- Không làm multi-destination.
- Không làm customer portal.
- Không làm scale test.
- Không deploy production.
- Không dùng production database hoặc Redis.
- Không dùng mailbox khách hàng thật.
- Không dùng Telegram group khách hàng thật.
- Không sửa file môi trường chứa giá trị thật.
- Không sửa GitHub Actions để nới lỏng secret scan.

## Yêu cầu chức năng

### Mailbox detail UI

- Mailbox detail phải có action “Disconnect mailbox” cho OWNER/ADMIN.
- UI phải giải thích rõ hậu quả trước khi xác nhận:
  - mailbox sẽ ngừng polling;
  - mailbox sẽ ngừng subscription renewal;
  - mailbox sẽ không relay code;
  - active Telegram mapping sẽ bị disable;
  - lịch sử logs và processed messages vẫn được giữ.
- Mailbox đã disconnected phải có badge/trạng thái rõ ràng.
- Mailbox đã disconnected không được hiển thị như Ready.
- STAFF_READ_ONLY không được thấy hoặc không được dùng action disconnect.

### API hoặc server action

- Endpoint/action disconnect phải enforce permission ở server side.
- Không được chỉ dựa vào việc ẩn button ở UI.
- Nếu mailbox không tồn tại hoặc ngoài scope, không được leak dữ liệu.
- Nếu mailbox đã disconnected, action nên idempotent và trả kết quả an toàn.
- Không trả về credential, token, full verification code, hoặc full email body.

### Service layer

- Tạo hoặc cập nhật service disconnect mailbox.
- Service phải xử lý theo hướng local disable first, remote cleanup second.
- Database update chính phải đảm bảo:
  - mailbox inactive/disconnected;
  - active mapping liên quan bị disable;
  - subscription liên quan bị mark inactive/deleted/disabled ở local;
  - audit log được ghi an toàn.
- Remote Graph subscription cleanup là best-effort.
- Nếu remote cleanup fail, không rollback trạng thái disconnected.

### Worker và pipeline

Các path sau phải bỏ qua mailbox disconnected:

- email worker hoặc graph message pipeline;
- delta polling worker;
- subscription renewal worker;
- mock/live processing path nếu path đó có thể relay theo mailbox.

Yêu cầu quan trọng: worker phải re-check trạng thái mailbox tại thời điểm xử lý job, vì job có thể đã được enqueue trước khi mailbox bị disconnect.

## Telegram mapping behavior

Khi disconnect mailbox, active Telegram mapping của mailbox nên bị disable/inactive thay vì giữ active.

Lý do: giảm rủi ro reconnect nhầm rồi relay vào destination cũ mà admin không kiểm tra lại. Mapping row vẫn được giữ để audit/debug; không hard delete.

Reusable Telegram destinations không nằm trong TASK-052 và sẽ được xử lý ở TASK-053.

## Graph subscription behavior

Khi disconnect mailbox:

- Local subscription record phải được mark inactive/deleted/disabled trước để renewal worker bỏ qua.
- Sau đó hệ thống có thể thử delete subscription remote.
- Nếu remote delete thành công, ghi nhận trạng thái cleanup thành công.
- Nếu remote delete fail, ghi warning/audit an toàn và vẫn giữ mailbox disconnected.
- Không được tiếp tục relay chỉ vì remote delete fail.

## Bảo mật

- Không đọc hoặc in nội dung file môi trường chứa giá trị thật.
- Không log token, refresh credential, bot credential, verification code đầy đủ, hoặc full email body.
- Không đưa credential vào UI error message.
- Audit metadata chỉ chứa thông tin an toàn như mailbox id, customer id, action result, và trạng thái cleanup.
- Không hardcode secret hoặc credential trong code, docs, tests, commit message.
- Tránh wording trong docs/report dễ gây secret scan false positive, đặc biệt các dòng metadata ngắn dạng keyword/value liên quan credential hoặc auth.

## Database

Claude phải rà soát schema hiện tại trước khi quyết định có cần migration hay không.

Ưu tiên dùng field/status hiện có nếu đã đủ biểu diễn disconnected/inactive.

Nếu schema hiện tại chưa có cách an toàn để biểu diễn disconnected, Claude được phép đề xuất migration tối thiểu, ví dụ thêm trạng thái hoặc timestamp phù hợp. Không tạo migration nếu không cần.

Không xóa historical rows.

## Tests cần có

Tối thiểu cần test các nhóm sau:

- OWNER/ADMIN disconnect được mailbox.
- STAFF_READ_ONLY không disconnect được mailbox.
- Disconnect không hard delete mailbox.
- Disconnect giữ processed message history.
- Disconnect disable active Telegram mapping.
- Disconnect mark subscription local inactive/deleted/disabled.
- Nếu remote subscription delete fail, mailbox vẫn disconnected và không relay.
- Delta polling bỏ qua mailbox disconnected.
- Subscription renewal bỏ qua mailbox disconnected.
- Email worker hoặc pipeline bỏ qua mailbox disconnected, kể cả job đã enqueue trước đó.
- Mailbox disconnected không được coi là Ready trên UI/status logic.
- Không trả về credential/code/email body trong response hoặc log test fixtures.

## Lệnh kiểm tra bắt buộc

Claude phải chạy:

```bash
npm run verify
````

Nếu có test targeted phù hợp, Claude có thể chạy thêm trước khi chạy verify đầy đủ.

## Tiêu chí nghiệm thu

* Disconnect action hoạt động cho OWNER/ADMIN.
* STAFF_READ_ONLY bị chặn ở server side.
* Mailbox disconnected không còn được poll, renew, hoặc relay.
* Active Telegram mapping của mailbox bị disable/inactive.
* Historical logs và processed messages được giữ.
* Graph subscription cleanup fail vẫn fail-safe.
* UI hiển thị trạng thái disconnected/inactive rõ ràng.
* Không có secret, credential, full verification code, hoặc full email body trong diff/log.
* Không sửa ngoài scope TASK-052.
* `npm run verify` PASS.
* Gemini review PASS.
* GitHub Actions PASS sau khi push.

## Báo cáo sau khi làm xong

Claude cần báo cáo:

* Đã thay đổi gì.
* File nào đã sửa.
* Có tạo migration hay không và vì sao.
* Test nào đã chạy.
* `npm run verify` PASS hay FAIL.
* `git status --short`.
* `git diff --stat`.
* Rủi ro còn lại nếu có.

````

