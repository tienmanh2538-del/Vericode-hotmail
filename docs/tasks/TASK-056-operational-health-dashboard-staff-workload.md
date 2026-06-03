# TASK-056 — Operational health dashboard for staff workload

## 1. Mục tiêu

Thiết kế và triển khai dashboard vận hành tối thiểu tại `/admin/health` để OWNER/ADMIN và STAFF_READ_ONLY nhìn nhanh tình trạng workload nội bộ.

Dashboard phải giúp trả lời:

- Có bao nhiêu mailbox đang active, error, disconnected.
- Mailbox nào chưa Ready vì thiếu mapping hợp lệ.
- Có dấu hiệu lỗi token refresh, subscription renewal, Telegram send, queue backlog hoặc worker heartbeat hay không.
- Workload theo customer/staff đang ổn hay cần xử lý.

TASK-056 là operational visibility/dashboard. Đây không phải production deploy, không phải production environment setup, không phải daily operations checklist.

## 2. Bối cảnh

Các task trước đã chốt:

- App là internal staff app, không phải public SaaS.
- Khách hàng không login; khách chỉ nhận verification code qua Telegram group/topic.
- OWNER/ADMIN xem toàn bộ dữ liệu.
- STAFF_READ_ONLY chỉ thấy customer/mailbox được assigned.
- Nhiều mailbox có thể dùng chung một reusable Telegram destination.
- Mỗi mailbox chỉ có tối đa một active Telegram destination.
- Mailbox chưa mapping hợp lệ không được coi là Ready.
- Mailbox disconnected không được poll, renew subscription hoặc relay code.
- TASK-055 đã có baseline throttling/queue safety; TASK-056 không được phá baseline đó.

## 3. Scope được làm

Trong task này, Claude Code được làm:

- Tạo hoặc nâng cấp `/admin/health` thành operational health dashboard tối thiểu.
- Tổng hợp số liệu health/workload từ dữ liệu nội bộ hiện có.
- Hiển thị summary cards cho mailbox readiness, mapping, subscription, Telegram, queue và worker.
- Hiển thị bảng mailbox/customer có vấn đề.
- OWNER/ADMIN thấy toàn bộ dữ liệu trong scope hệ thống.
- STAFF_READ_ONLY chỉ thấy dữ liệu của customer được assigned.
- Thêm service/type/helper nếu cần để giữ code dễ test.
- Thêm unit test hoặc service test cho logic aggregation/scope.
- Cập nhật tài liệu task/report liên quan nếu cần.

## 4. Scope không làm

Task này không làm:

- Không deploy production.
- Không setup production environment.
- Không dùng production database hoặc production Redis.
- Không dùng mailbox khách hàng thật.
- Không dùng Telegram group khách hàng thật.
- Không gửi verification code thật.
- Không gọi Microsoft Graph chỉ để render dashboard.
- Không gọi Telegram test-send chỉ để render dashboard.
- Không làm daily operations checklist.
- Không làm production auth hardening.
- Không làm internal beta launch.
- Không làm backup/restore runbook.
- Không thêm 1 mailbox → nhiều Telegram destinations.
- Không broadcast code tới nhiều group/topic.
- Không sửa `.env`, `.env.local`, `.env.staging`, `.env.production`.
- Không sửa GitHub Actions để nới lỏng secret scan.

## 5. Yêu cầu chức năng

Dashboard tối thiểu cần có các phần sau.

### 5.1. Overview cards

Hiển thị trong scope hiện tại:

- Tổng số mailbox.
- Số mailbox active.
- Số mailbox error hoặc disconnected.
- Số mailbox chưa Ready vì thiếu mapping hợp lệ.
- Số mailbox có subscription issue nếu dữ liệu hiện có hỗ trợ.
- Số Telegram send failure gần đây nếu dữ liệu hiện có hỗ trợ.
- Queue backlog hoặc worker issue nếu dữ liệu hiện có hỗ trợ.

### 5.2. Workload by customer

Hiển thị theo từng customer trong scope:

- Customer name.
- Total mailboxes.
- Ready mailboxes.
- Needs mapping.
- Error/disconnected.
- Recent issue count nếu có dữ liệu.

STAFF_READ_ONLY chỉ được thấy customer được assigned.

### 5.3. Mailbox issues table

Hiển thị mailbox cần chú ý:

- Customer.
- Mailbox.
- Readiness status.
- Mapping status.
- Subscription status nếu có.
- Last safe error message nếu có.
- Last activity hoặc last checked timestamp nếu có.

Không hiển thị secret, token, verification code đầy đủ hoặc full email body.

### 5.4. Queue and worker status

Nếu project đã có queue/worker health signal, hiển thị:

- Email worker heartbeat.
- Delta polling worker heartbeat.
- Renewal worker heartbeat.
- Queue waiting/delayed/failed counts nếu có adapter an toàn.
- Warning khi backlog/failed jobs vượt ngưỡng tối thiểu.

Nếu chưa có dữ liệu heartbeat thật, hiển thị degraded/unknown state rõ ràng, không gọi external service để tự tạo signal.

## 6. Yêu cầu bảo mật

- Không log token, refresh token, client credential, Telegram bot credential, verification code đầy đủ hoặc full email body.
- UI error message phải an toàn, chỉ mô tả lỗi ở mức vận hành.
- Không đọc hoặc in nội dung `.env*`.
- Không ghi giá trị nhạy cảm vào docs/report/roadmap.
- Không tạo metadata ngắn dạng `keyword: value` liên quan tới credential hoặc connection string trong docs/report.
- Nếu cần nhắc tới biến môi trường, chỉ nhắc tên biến khi thật sự cần, không ghi giá trị.
- Dashboard không được làm lộ số liệu global cho STAFF_READ_ONLY.

## 7. Customer isolation và staff scope

- OWNER/ADMIN được xem toàn bộ operational health.
- STAFF_READ_ONLY chỉ được xem customer/mailbox/mapping thuộc assignment của họ.
- Scope phải enforce ở service layer, không chỉ ẩn UI.
- Không trả count global cho STAFF_READ_ONLY nếu count đó bao gồm dữ liệu ngoài scope.
- Staff không có assignment nào phải thấy empty state an toàn.

## 8. Routing rules phải giữ nguyên

- Nhiều mailbox có thể dùng chung một reusable Telegram destination.
- Mỗi mailbox chỉ có tối đa một active Telegram destination.
- Mailbox chưa có active destination hợp lệ không được coi là Ready.
- Mailbox disconnected không được poll, renew subscription hoặc relay code.
- Dashboard chỉ hiển thị tình trạng; không tự sửa mapping hoặc tự gửi lại code.

## 9. Thiết kế kỹ thuật đề xuất

Ưu tiên tận dụng file hiện có trước khi tạo file mới.

Các file có thể cần xem/sửa:

- `app/admin/health/page.tsx`
- `services/health/health.service.ts`
- `services/health/health.types.ts`
- `lib/auth/access-scope.ts`
- `services/microsoft/mailbox-list.service.ts`
- `services/telegram/telegram-mapping.service.ts`
- `components/status/MailboxReadinessBadge.tsx`
- `components/health/*` nếu cần tách component
- `tests/unit/health/*` hoặc test tương ứng hiện có

Chỉ tạo migration/schema mới nếu thật sự bắt buộc. Mặc định ưu tiên computed status từ dữ liệu hiện có.

## 10. Test cần có

Tối thiểu cần kiểm tra:

- OWNER/ADMIN thấy toàn bộ health summary.
- STAFF_READ_ONLY chỉ thấy mailbox/customer trong assignment.
- Staff không có assignment thấy empty state an toàn.
- Mailbox active nhưng thiếu mapping được tính là Needs Mapping.
- Mailbox disconnected không được tính là Ready.
- Nhiều mailbox dùng chung reusable destination vẫn hợp lệ.
- Một mailbox có dữ liệu mapping bất thường không làm dashboard crash.
- Health service không gọi Microsoft Graph/Telegram trong test render/aggregation.
- Không có raw verification code/token/full email body trong output test data.

## 11. Lệnh kiểm tra

Claude phải chạy:

```powershell
npm run verify
````

Nếu có test target nhỏ hơn phù hợp, có thể chạy thêm trước khi chạy verify đầy đủ, ví dụ:

```powershell
npm test -- --run tests/unit/health
```

## 12. Tiêu chí nghiệm thu

Task chỉ PASS khi:

* Có file task này trong `docs/tasks/`.
* `/admin/health` hiển thị dashboard vận hành tối thiểu.
* OWNER/ADMIN và STAFF_READ_ONLY được scope đúng.
* Mailbox chưa mapping hợp lệ không được coi là Ready.
* Mailbox disconnected không được coi là Ready.
* Không gọi Microsoft Graph/Telegram chỉ để render dashboard.
* Không phá reusable destination.
* Không phá rule one-mailbox-one-active-destination.
* Không có secret, token, verification code đầy đủ hoặc full email body trong UI/log/docs.
* `npm run verify` PASS.
* Gemini CLI review PASS.

````

---