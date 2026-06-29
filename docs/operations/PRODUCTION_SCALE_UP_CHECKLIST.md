# Production Scale-Up Checklist

Checklist **vận hành** để mở rộng **Verification Code Relay Tool** từ
*limited internal beta* lên *full internal use* **theo từng giai đoạn**.

> Tài liệu này viết cho **OWNER/ADMIN** điều phối scale-up, và cho người **không
> chuyên code** hiểu được từng bước. Mục tiêu: chỉ tăng tải khi đã PASS điều kiện
> rõ ràng, theo dõi đúng metric, và biết khi nào **dừng / rollback** thay vì cố
> tăng tiếp.

Tài liệu này là **artifact vận hành** đi kèm task spec
`docs/tasks/TASK-063-production-scale-up-full-internal-use.md`. Khi hai tài liệu
khác nhau về chi tiết, task spec là nguồn gốc; checklist này là cách áp dụng
hằng đợt.

## Tài liệu này KHÁC gì với các tài liệu khác

Đọc kỹ để dùng đúng tài liệu, tránh trùng lặp:

| Tình huống | Dùng tài liệu |
|------------|---------------|
| Nhân viên mới, lần đầu làm quen dashboard | `STAFF_ONBOARDING_GUIDE.md` (TASK-061) |
| Kiểm tra định kỳ mỗi ngày | `DAILY_OPERATIONS_CHECKLIST.md` (TASK-062) |
| Sự cố production: deploy/DB/Redis/worker/secret leak | `docs/tasks/TASK-060-backup-restore-incident-response.md` |
| **Mở rộng beta → full internal use theo từng giai đoạn** | **Tài liệu này (TASK-063)** |

- Checklist này **không thay thế** daily operations checklist (TASK-062) — nó
  **dùng lại** daily checklist làm nhịp kiểm tra trong mỗi đợt scale.
- Checklist này **không thay thế** incident runbook (TASK-060) — khi scale gây
  sự cố, checklist chỉ giúp **nhận ra và dừng**, rồi **chuyển sang runbook**.
- Scale-up do **OWNER/ADMIN** điều phối. STAFF_READ_ONLY tham gia ở mức **quan
  sát và báo cáo** trong phạm vi customer/mailbox được assign.

---

## 1. Nguyên tắc an toàn khi scale (đọc trước)

Các quy tắc này áp dụng cho **mọi** đợt scale:

1. **Scale theo cụm nhỏ, không nhảy mức.** Tăng dần số mailbox/staff/customer,
   kiểm tra lại health sau mỗi cụm. Không nhảy từ beta nhỏ thẳng lên full.
2. **Không tăng tiếp khi có blocker chưa xử lý.** Một dấu hiệu bất thường ở
   queue, Telegram, Graph, token/subscription, hoặc scope là lý do để **dừng**.
3. **Mỗi mailbox chỉ có tối đa một active Telegram destination.** Nhiều mailbox
   **dùng chung** một reusable destination là hợp lệ; **không broadcast** mã ra
   nhiều group/topic, và **không** tạo nhiều active destination cho một mailbox.
4. **Mailbox disconnected hoặc chưa mapping hợp lệ → KHÔNG Ready**, không dùng để
   tăng scale, không relay mã thật.
5. **STAFF_READ_ONLY chỉ thấy customer/mailbox được assign.** Scope được enforce
   ở service layer, không dựa vào UI hiding. Mỗi đợt thêm staff/customer phải
   kiểm tra lại bằng tài khoản STAFF_READ_ONLY mẫu.
6. **Không bao giờ** ghi mã xác minh đầy đủ, toàn bộ email body, hay giá trị bí
   mật (token, client secret, bot token, encryption key, connection string) vào
   ghi chú, chat, hay báo cáo scale. Dùng **mô tả bằng lời** và masked reference
   do UI cung cấp.
7. **Không đụng `.env` hay secret thật.** Cấu hình bí mật là việc OWNER/ADMIN làm
   qua secret manager của nền tảng deploy.
8. **Không** thay đổi worker concurrency / polling / queue bằng cách sửa code
   trong đợt scale. Nếu cần đổi tham số tải, mở **task riêng**.

---

## 2. Các mức scale

Tăng lần lượt; chỉ lên mức sau khi mức hiện tại đã PASS (mục 5). Con số là
**đề xuất**, OWNER/ADMIN điều chỉnh theo nhu cầu thật.

| Mức | Tên | Quy mô đề xuất |
|-----|-----|----------------|
| **Level 0** | Limited internal beta | 1–2 OWNER/ADMIN, 0–2 staff, ~5–10 mailbox đã xác minh |
| **Level 1** | Expanded beta | ~20–50 mailbox, 2–3 staff, vài customer thật đã xác minh |
| **Level 2** | Internal scale pilot | ~50–100 mailbox, 3–5 staff, có shared destination dùng chung |
| **Level 3** | Full internal use | ~100–200+ mailbox theo nhu cầu, staff/customer tăng theo đợt |

Định nghĩa đầy đủ từng mức và điều kiện PASS chi tiết: xem task spec TASK-063
mục 7.

---

## 3. Điều kiện trước khi bắt đầu một đợt scale

Đánh dấu **tất cả** trước khi tăng tải:

- [ ] GitHub Actions đang xanh ở thay đổi gần nhất.
- [ ] `npm run verify` đã PASS ở thay đổi gần nhất.
- [ ] Antigravity CLI review đã PASS cho task liên quan (nếu có thay đổi).
- [ ] **Daily operations checklist** (TASK-062) gần nhất **không có blocker**.
- [ ] Health dashboard (`/admin/health`) không có Error/Degraded bất thường.
- [ ] Worker/queue không có backlog bất thường (nếu dashboard hiển thị).
- [ ] Token refresh và subscription renewal không có lỗi lan rộng (nếu hiển thị).
- [ ] Telegram send failure không tăng bất thường.
- [ ] Không có dấu hiệu gửi nhầm group/topic.
- [ ] Không có mailbox disconnected đang bị xử lý.
- [ ] Không có mailbox chưa mapping hợp lệ bị coi là Ready.
- [ ] Staff assignment đã được kiểm tra bằng tài khoản STAFF_READ_ONLY mẫu.
- [ ] Incident runbook (TASK-060) sẵn sàng nếu cần rollback.
- [ ] OWNER/ADMIN đã ghi nhận quyết định bắt đầu đợt scale.

---

## 4. Quy trình một đợt scale

### 4.1 Trước đợt scale

- [ ] Chạy daily operations checklist đầu ngày (TASK-062).
- [ ] Xác nhận đủ điều kiện ở mục 3.
- [ ] Xác định **cụm mailbox/customer** sẽ thêm trong đợt này (nhỏ, có chủ đích).
- [ ] Xác nhận mỗi mailbox mới thuộc **đúng customer** và sẽ map vào **đúng**
      reusable destination trong phạm vi customer đó.

### 4.2 Trong đợt scale

- [ ] Thêm mailbox/customer **theo cụm nhỏ**, không thêm hàng loạt một lần.
- [ ] Với mỗi mailbox mới: xác nhận Ready đúng rule (connected, đúng customer,
      đúng một active destination hợp lệ).
- [ ] Dùng **test-send an toàn** (tin nhắn thử vô hại, **không chứa mã thật**) để
      xác nhận đúng group/topic trước khi cho relay thật. Chi tiết bước test-send:
      onboarding guide TASK-061.
- [ ] Sau mỗi cụm, kiểm tra lại health dashboard và các metric ở mục 6.
- [ ] **Dừng ngay** nếu queue, Telegram, Graph, hoặc token/subscription có dấu
      hiệu bất thường (mục 7 — rollback criteria).

### 4.3 Sau đợt scale

- [ ] Chạy daily operations checklist cuối ngày (TASK-062).
- [ ] Ghi lại: cụm đã thêm, lỗi/warning gặp phải, quyết định tiếp tục hay dừng.
- [ ] Nếu có incident → chuyển sang runbook TASK-060, **không** tự khắc phục sự
      cố nặng.
- [ ] Tạo báo cáo ngắn cho đợt (mục 9).

---

## 5. Điều kiện PASS trước khi lên mức tiếp theo

Chỉ lên mức scale kế tiếp khi **tất cả** đúng:

- [ ] Daily operations checklist gần nhất **PASS** trong các ngày vận hành liên
      tiếp.
- [ ] Health dashboard **không có blocker**.
- [ ] Queue backlog ổn định, không tăng liên tục (nếu hiển thị).
- [ ] Telegram failure trong ngưỡng chấp nhận được, không tập trung bất thường.
- [ ] Graph throttling **không lặp lại** ở nhiều mailbox.
- [ ] Token/subscription issue đã xử lý, không còn lan rộng.
- [ ] **Không có duplicate relay** cho cùng một message.
- [ ] **Không có** dấu hiệu gửi nhầm group/topic.
- [ ] STAFF_READ_ONLY scope đã kiểm tra lại, chỉ thấy đúng phần được assign.
- [ ] Không có mailbox disconnected/unmapped bị coi là Ready.
- [ ] Mapping của mailbox mới đã được OWNER/ADMIN xác nhận.
- [ ] Không có incident đang mở.
- [ ] OWNER/ADMIN đã ghi nhận quyết định tăng mức.

---

## 6. Metric cần theo dõi trong scale

Chỉ theo dõi tín hiệu mà **dashboard hoặc logs hiện có hỗ trợ**. Không tự probe
hạ tầng, không chạy lệnh production.

| Nhóm | Theo dõi gì | Dấu hiệu cần chú ý |
|------|-------------|--------------------|
| **Health dashboard** | Tổng mailbox theo trạng thái: Ready / Needs mapping / Needs customer / Disconnected / Error | Error/Degraded tăng, Ready giảm bất thường |
| **Mailbox readiness** | Mailbox chỉ Ready khi connected, đúng customer, đúng một active destination hợp lệ | Mailbox disconnected/unmapped bị coi là Ready |
| **Telegram failures** | Lỗi gửi, lỗi bot permission, lỗi group/topic, retry, destination fail lặp lại | Failure tăng đột biến hoặc dồn vào một destination |
| **Worker & queue** | Backlog, job age, retry count, delayed jobs, heartbeat, restart (nếu hiển thị) | Backlog tăng liên tục, worker restart lặp lại |
| **Graph throttling** | 429 / 5xx / retry-after, mailbox bị throttle lặp lại | Throttling lặp lại ở nhiều mailbox |
| **Token & subscription** | Token refresh failed, subscription expired/renew failed, mailbox cần reconnect | Lỗi lan rộng nhiều mailbox |
| **Latency** | Thời gian từ khi email đến tới khi mã vào Telegram | Latency tăng dần khi thêm mailbox |
| **Duplicate prevention** | Cùng một Graph message không relay nhiều lần (webhook + delta polling) | Khách nhận trùng mã |
| **Staff scope** | STAFF_READ_ONLY chỉ thấy customer/mailbox được assign (table, detail, dashboard count, log view nếu có) | Thấy dữ liệu ngoài assignment |

---

## 7. Rollback criteria — khi nào dừng / giảm tải

**Dừng tăng scale ngay** nếu có **một** trong các dấu hiệu sau:

- Có mã gửi **nhầm** group/topic.
- Có **duplicate relay** cho cùng một message.
- Nghi **lộ** mã xác minh đầy đủ, token, secret, hay full email body trong log/UI.
- Queue backlog **tăng liên tục** và không tự giảm.
- Worker **crash hoặc restart lặp lại**.
- Graph throttling **lặp lại** ở nhiều mailbox.
- Telegram failure **tăng bất thường**.
- Token refresh hoặc subscription renewal **lỗi lan rộng**.
- STAFF_READ_ONLY **thấy dữ liệu ngoài assignment**.
- Mailbox disconnected **vẫn bị xử lý**.
- Mailbox unmapped **vẫn được coi là Ready**.
- OWNER/ADMIN **chưa xác minh** mapping của mailbox mới.

Hành động rollback có thể gồm (theo mức độ, do OWNER/ADMIN quyết định phạm vi):

- [ ] Dừng onboarding mailbox mới.
- [ ] Tạm disable nhóm mailbox vừa thêm trong đợt.
- [ ] Tạm dừng worker email nếu **nghi routing sai** (theo thứ tự an toàn trong
      runbook TASK-060, **không** xóa dữ liệu).
- [ ] Giảm tải qua **task riêng** nếu cần đổi concurrency/polling (không sửa code
      ad-hoc trong đợt scale).
- [ ] Dùng runbook TASK-060 để xử lý incident.

> Quan trọng: khi nghi gửi nhầm Telegram hoặc nghi lộ dữ liệu nhạy cảm, đây là
> **incident**, không phải bước scale bình thường. Chuyển ngay sang runbook
> TASK-060, **không** tự retry hàng loạt, **không** xóa dữ liệu thủ công khi chưa
> xác định nguyên nhân.

---

## 8. Bảo vệ các rule khi scale

### 8.1 One-mailbox-one-active-destination

- [ ] Không tạo nhiều active mapping cho cùng một mailbox.
- [ ] Không gửi cùng một mã tới nhiều group/topic.
- [ ] Không tự động fallback sang destination khác khi gửi lỗi.
- [ ] Khi đổi destination, đảm bảo mapping cũ **không còn active**.
- [ ] Mọi thay đổi mapping đi qua **service-layer validation**, không bypass.

### 8.2 Reusable Telegram destinations (nhiều mailbox dùng chung)

- [ ] Destination thuộc **đúng customer/scope**.
- [ ] Mapping mailbox → destination luôn qua validation.
- [ ] Theo dõi failure và burst của shared destination khi nhiều mailbox dùng
      chung.
- [ ] Nếu destination fail → **không** tự broadcast sang nơi khác.
- [ ] OWNER/ADMIN **xác minh group/topic** trước khi tăng nhiều mailbox vào cùng
      một destination.

### 8.3 STAFF_READ_ONLY scope (khi thêm staff/customer)

- [ ] OWNER/ADMIN quản lý assignment.
- [ ] STAFF_READ_ONLY chỉ thấy customer/mailbox được assign.
- [ ] Không dựa vào UI hiding làm lớp bảo mật duy nhất.
- [ ] Service / API / dashboard / log đều scope đúng.
- [ ] Staff chưa được assign customer nào thì không thấy dữ liệu (fail-closed).
- [ ] Trước mỗi mức scale, kiểm tra bằng tài khoản STAFF_READ_ONLY mẫu.

### 8.4 Mailbox disconnected / unmapped / token issue

- [ ] Mailbox disconnected không poll, không renew subscription, không relay mã.
- [ ] Mailbox chưa mapping hợp lệ **không** coi là Ready.
- [ ] Mailbox token issue → reconnect hoặc điều tra theo runbook; **không** dán
      giá trị token vào đâu.
- [ ] Mailbox subscription issue → báo trong health/dashboard nếu có.
- [ ] **Không** dùng mailbox lỗi để tăng scale.
- [ ] **Không** retry vô hạn với mailbox lỗi.

---

## 9. Báo cáo ngắn sau mỗi đợt scale

Ghi một bản ngắn — **chỉ mô tả an toàn**:

- Mức scale hiện tại và mức mục tiêu của đợt.
- Cụm mailbox/customer/staff đã thêm (số lượng, không kèm dữ liệu nhạy cảm).
- Kết quả daily checklist đầu/cuối ngày.
- Metric đáng chú ý (queue, Telegram failure, Graph throttling, token/subscription,
  latency, duplicate, scope).
- Có incident không; nếu có, đã xử lý theo runbook nào.
- Quyết định: tiếp tục, giữ nguyên mức, hay rollback.

**Không** ghi mã thật, email body, token, hay secret vào báo cáo. Masked
reference do UI cung cấp là đủ để truy vết.

---

## 10. Những việc KHÔNG làm trong scale-up

- Không deploy production mới trong task planning này.
- Không onboarding hàng loạt mailbox thật một lần.
- Không tạo customer login, customer portal, public signup.
- Không thêm billing/payment.
- Không làm một mailbox gửi tới nhiều Telegram destination.
- Không broadcast mã ra nhiều group/topic.
- Không thay đổi production auth hardening (TASK-057).
- Không thay đổi secret setup (TASK-058).
- Không đọc, in, hay sửa `.env` / secret thật.
- Không sửa GitHub Actions để nới lỏng secret scan.
- Không thay đổi database schema nếu không có task riêng.
- Không đổi worker concurrency/polling/queue bằng code nếu chưa có task riêng.
- Không tự khắc phục sự cố nặng — đó là việc của runbook TASK-060.

---

## Tài liệu liên quan

- `docs/tasks/TASK-063-production-scale-up-full-internal-use.md` — task spec đầy
  đủ (định nghĩa mức scale, điều kiện PASS, metric, rollback).
- `docs/operations/DAILY_OPERATIONS_CHECKLIST.md` — nhịp kiểm tra hằng ngày
  (TASK-062), dùng trong mỗi đợt scale.
- `docs/operations/STAFF_ONBOARDING_GUIDE.md` — onboarding nhân viên mới
  (TASK-061), gồm bước connect mailbox, mapping, test-send an toàn.
- `docs/tasks/TASK-060-backup-restore-incident-response.md` — runbook backup,
  restore drill, và incident response.
- `deployment/production/README.md` — tổng quan production limited internal beta
  và emergency worker kill switch.
- `docs/SECURITY_RULES.md` — nguyên tắc bảo mật nền tảng.
- `docs/ROADMAP.md` — bối cảnh các sprint vận hành nội bộ.
