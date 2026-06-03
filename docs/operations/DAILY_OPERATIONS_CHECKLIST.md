# Daily Operations Checklist

Checklist **vận hành hằng ngày** cho **Verification Code Relay Tool** trong giai
đoạn *production limited internal beta*.

> Tài liệu này viết cho người **không chuyên code**. Mục tiêu là chạy một vòng
> kiểm tra ngắn mỗi ngày để phát hiện sớm mailbox không Ready, Telegram gửi
> thất bại, hoặc dấu hiệu bất thường — rồi **báo đúng người** thay vì tự đoán.

Tài liệu này nằm ở `docs/operations/` cùng nhóm với
`docs/operations/STAFF_ONBOARDING_GUIDE.md`.

## Tài liệu này KHÁC gì với các tài liệu khác

Đọc kỹ để dùng đúng tài liệu, tránh trùng lặp:

| Tình huống | Dùng tài liệu |
|------------|---------------|
| Nhân viên mới, lần đầu làm quen dashboard | `STAFF_ONBOARDING_GUIDE.md` (TASK-061) |
| **Kiểm tra định kỳ mỗi ngày** | **Tài liệu này (TASK-062)** |
| Sự cố production: deploy/DB/Redis/worker/secret leak | `docs/tasks/TASK-060-backup-restore-incident-response.md` |
| Mở rộng beta lên dùng nội bộ đầy đủ | TASK-063 (do OWNER/ADMIN điều phối) |

- **Onboarding (TASK-061)** dạy *cách dùng* từng tính năng một lần. Checklist
  này giả định bạn đã onboard xong và chỉ tập trung vào **nhịp kiểm tra hằng ngày**.
- **Incident runbook (TASK-060)** là nơi xử lý sự cố. Checklist này **không thay
  thế** runbook — khi phát hiện incident, checklist chỉ giúp bạn nhận ra và
  **chuyển sang runbook**, không tự khắc phục sự cố nặng.
- Checklist này **không** đụng tới scale-up (TASK-063).

---

## 1. Trước khi bắt đầu: nguyên tắc an toàn

Các quy tắc này áp dụng cho **mọi** thao tác trong checklist:

1. **Quan sát, đừng phá.** Vòng kiểm tra hằng ngày chủ yếu là **đọc** dashboard
   và logs. STAFF_READ_ONLY không tự đổi mapping, destination, assignment hay
   cấu hình production.
2. **Mỗi mailbox chỉ có tối đa một active Telegram destination.** Nhiều mailbox
   có thể **dùng chung** một reusable destination — điều này hợp lệ. Nhưng không
   bao giờ để một mailbox gửi tới nhiều group/topic, và **không broadcast** mã.
3. **Mailbox disconnected hoặc chưa mapping hợp lệ → KHÔNG Ready**, không relay
   mã thật.
4. **Không bao giờ** copy/ghi mã xác minh đầy đủ, toàn bộ nội dung email, hay bất
   kỳ giá trị bí mật nào (token, client secret, bot token, encryption key,
   connection string) vào ghi chú, chat, hay báo cáo. Khi mô tả lỗi, dùng **lời
   văn** và **masked reference** nếu UI đã cung cấp.
5. **Không đụng `.env` hay secret thật.** Cấu hình bí mật là việc của OWNER/ADMIN
   qua secret manager của nền tảng deploy.
6. Khi không chắc, hoặc khi gặp dấu hiệu incident → **dừng và escalate** (mục 9,
   mục 10).

---

## 2. Ai chạy checklist nào

Checklist có hai phạm vi. Cùng một bước, nhưng **phạm vi dữ liệu khác nhau**.

| Vai trò | Phạm vi kiểm tra hằng ngày | Quyền xử lý |
|---------|----------------------------|-------------|
| **OWNER / ADMIN** | Toàn bộ customer, mailbox, destination, logs, health, và các check hạ tầng/vận hành toàn hệ thống | Có thể sửa mapping/assignment/destination; quyết định khi nào dùng runbook TASK-060 |
| **STAFF_READ_ONLY** | **Chỉ** customer/mailbox được assign cho mình | Chủ yếu **phát hiện và báo cáo**; không tự đổi cấu hình |

Lưu ý quan trọng cho STAFF_READ_ONLY:

- **Không thấy một customer/mailbox KHÔNG có nghĩa là nó biến mất** — rất có thể
  nó chưa được assign cho bạn. Nếu thiếu thứ bạn cần vận hành → báo OWNER/ADMIN
  kiểm tra assignment, **đừng tìm cách lách phạm vi**.
- Dashboard đã lọc sẵn theo phạm vi của bạn ở phía server. Không dùng dashboard
  để cố xem ngoài phạm vi.

---

## 3. Vòng kiểm tra đầu ngày (mọi vai trò)

Chạy theo thứ tự. Mỗi bước chỉ mất vài phút.

- [ ] **Đăng nhập** dashboard bằng tài khoản nội bộ hợp lệ.
- [ ] Mở trang **Health** (`/admin/health`).
- [ ] Xác nhận **không có** lỗi đỏ (Error) hoặc Degraded bất thường.
- [ ] Đọc **mailbox overview** và ghi nhanh các con số:
  - Ready
  - Needs mapping
  - Needs customer (nếu UI hiển thị)
  - Disconnected
  - Error
- [ ] Mở **Mailboxes** (`/admin/mailboxes`) và để ý các mailbox **không Ready**.
- [ ] Xem **Telegram send failure** gần đây trên Health hoặc Logs (`/admin/logs`).
- [ ] Xem **worker / queue / subscription / token** *nếu* dashboard có hiển thị
      (xem mục 8 — nếu chỉ thấy Unknown, ghi nhận là Unknown, đừng suy diễn).
- [ ] Ghi nhận mọi bất thường bằng **mô tả ngắn** (không mã thật, không email
      đầy đủ, không secret).
- [ ] Nếu có bất thường vượt khả năng của bạn → **escalate** (mục 9 / mục 10).

> Nếu mọi mục đều OK và không có mailbox không-Ready mới, ngày hôm đó coi như
> sạch — không cần thao tác gì thêm.

---

## 4. Health dashboard check

Trang **Health** (`/admin/health`) là điểm bắt đầu mỗi ngày.

- **OWNER/ADMIN** thấy toàn hệ thống, kèm các check hạ tầng/vận hành.
- **STAFF_READ_ONLY** chỉ thấy health **trong phạm vi** mailbox của customer được
  assign.

Cách đọc trạng thái:

| Trạng thái | Nghĩa | Hành động hằng ngày |
|------------|-------|---------------------|
| **OK / Ready** | Bình thường | Tiếp tục checklist |
| **Unknown** | Dashboard chưa đủ tín hiệu để kết luận | Chưa coi là incident; kiểm tra thêm Logs. Nếu Unknown kéo dài hoặc đi kèm failure thật → báo OWNER/ADMIN |
| **Degraded** | Có dấu hiệu suy giảm | Ghi nhận và báo OWNER/ADMIN |
| **Error** | Có lỗi rõ ràng | OWNER/ADMIN kiểm tra ngay; nếu ảnh hưởng relay mã hoặc an toàn dữ liệu → chuyển runbook TASK-060 |

Không dùng dashboard để bypass scope ở service layer. Nếu STAFF_READ_ONLY không
thấy customer/mailbox cần vận hành → báo OWNER/ADMIN kiểm tra assignment.

---

## 5. Mailbox readiness check

Nhắc lại định nghĩa **Ready** (giống onboarding guide, để vận hành cần thuộc):
một mailbox chỉ Ready khi **tất cả** đúng:

- mailbox **connected / active**;
- thuộc **đúng customer**;
- **không bị disconnected**;
- có **đúng một** active Telegram destination hợp lệ;
- không có lỗi token/subscription/Telegram rõ ràng trên dashboard.

Việc cần làm hằng ngày:

- [ ] Lọc mailbox **Needs mapping**.
- [ ] Lọc mailbox **Needs customer** (nếu UI có).
- [ ] Lọc mailbox **Error**.
- [ ] Lọc mailbox **Disconnected**.
- [ ] Với mỗi mailbox không Ready, xác định **customer** và **vấn đề chính**
      (thiếu mapping? sai customer? disconnected? lỗi token?).
- [ ] **Không** gửi test verification thật khi destination chưa rõ.
- [ ] **STAFF_READ_ONLY:** báo OWNER/ADMIN nếu cần sửa mapping hoặc assignment.
- [ ] **OWNER/ADMIN:** xử lý theo mục 6 / mục 7 nếu cần.

---

## 6. Disconnected mailbox check

Với mailbox **disconnected**:

- **Không** coi là Ready.
- Hệ thống **không poll**, **không renew subscription**, **không relay mã** từ
  mailbox đó — đây là hành vi an toàn có chủ đích (TASK-052), không phải lỗi.
- Nếu mailbox bị disconnected **ngoài ý muốn** → STAFF_READ_ONLY báo OWNER/ADMIN.
- **OWNER/ADMIN chỉ reconnect** sau khi xác nhận **đúng customer** và **đúng
  destination**. Việc connect/disconnect mang tính quản trị.

---

## 7. Unmapped mailbox check

Với mailbox **chưa mapping hợp lệ**:

- **Không** coi là Ready.
- **Không** relay verification code.
- **OWNER/ADMIN:** kiểm tra reusable Telegram destination phù hợp trong phạm vi
  **đúng customer**, rồi tạo/sửa mapping qua UI/service hiện có
  (`/admin/telegram`).
- Sau khi mapping xong, dùng **test-send an toàn** (tin nhắn thử vô hại, **không
  chứa mã thật**) để xác nhận đúng group/topic trước khi cho relay thật.
- **Không** tạo nhiều active destination cho cùng một mailbox.
- **Không** broadcast mã ra nhiều group/topic.

> Chi tiết từng bước mapping/test-send nằm ở onboarding guide (TASK-061). Ở đây
> chỉ là nhịp kiểm tra: phát hiện mailbox chưa mapping và đưa nó về Ready.

---

## 8. Telegram send failure & logs check

### Telegram send failure

Xem các failure gần đây trên Health hoặc Logs (`/admin/logs`) nếu vai trò bạn
được phép. Cần chú ý:

- Failure có **tăng bất thường** so với mọi ngày không?
- Failure có **tập trung** vào một customer, mailbox, hoặc destination không?
- Có dấu hiệu **bot mất quyền** gửi vào group/topic không?
- Có dấu hiệu **gửi nhầm** group/topic không?

Nếu **nghi gửi nhầm destination** → đây là vấn đề định tuyến nghiêm trọng:
OWNER/ADMIN chuyển ngay sang runbook TASK-060 và cân nhắc dừng worker theo quy
trình an toàn. **Không** tự retry hàng loạt.

### Logs cơ bản

Khi xem Logs, chỉ dùng đủ thông tin để hiểu trạng thái:

- Xem **status thành công / thất bại**, thời điểm, và khu vực chức năng.
- **Không** copy toàn bộ nội dung email.
- **Không** copy mã xác minh đầy đủ. Logs được thiết kế để **che (mask)** mã —
  đừng tìm cách lấy mã đầy đủ.
- **Không** copy token, refresh token, bot token, client secret, hay connection
  string.
- Nếu thấy log đang **hiển thị dữ liệu nhạy cảm** (mã đầy đủ, email body, giá trị
  bí mật) → báo OWNER/ADMIN ngay và xử lý theo runbook TASK-060.

---

## 9. Worker, queue, subscription & token signals

Chỉ kiểm tra những tín hiệu mà **dashboard hoặc logs hiện có hỗ trợ**. Không tự
probe hạ tầng, không chạy lệnh production.

Nếu dashboard hiển thị **worker status**:

- Email worker nên đang chạy.
- Delta polling worker nên chạy nếu được bật.
- Subscription renewal worker nên chạy nếu được bật.

Nếu dashboard hiển thị **queue status**:

- Queue backlog không nên tăng bất thường.
- Job failure không nên tăng bất thường.

Nếu dashboard hiển thị **subscription issue**:

- Subscription expired hoặc renewal failed → OWNER/ADMIN kiểm tra.

Nếu dashboard hiển thị **token issue**:

- Token refresh failed, hoặc mailbox cần reconnect → OWNER/ADMIN xử lý (không
  bypass OAuth, không dán giá trị token vào đâu).

> Nếu các tín hiệu trên hiển thị **Unknown**, ghi nhận là Unknown. Unknown một
> mình **không** phải incident. Unknown **kéo dài** hoặc **đi kèm failure thật**
> mới cần escalate.

---

## 10. Escalation

### Khi STAFF_READ_ONLY phải báo OWNER/ADMIN

Báo **ngay**, đừng tự xử lý, khi:

- Không thấy customer/mailbox mình cần vận hành.
- Mailbox bị **disconnected** ngoài ý muốn.
- Mailbox **Needs mapping** hoặc mapping có vẻ sai.
- **Telegram send failure** lặp lại hoặc tăng bất thường.
- Health có **Error / Degraded** hoặc cảnh báo không hiểu.
- Khách báo **không nhận được mã** nhưng bạn không xác định được nguyên nhân.
- Nghi mã xác minh **gửi nhầm** group/topic.
- Nghi **lộ** mã đầy đủ, email body, hoặc secret trong UI/log.
- Cần thay đổi **customer assignment, mailbox mapping, hoặc reusable destination**.

Khi báo: mô tả hiện tượng bằng lời (ví dụ "mailbox của customer X báo Needs
mapping từ sáng nay"). **Không** dán mã thật, email đầy đủ, token, hay secret.

### Khi OWNER/ADMIN phải chuyển sang runbook TASK-060

Dùng `docs/tasks/TASK-060-backup-restore-incident-response.md` khi có dấu hiệu
**incident**:

- Deploy, build, hoặc migration lỗi.
- Database lỗi hoặc nghi mất dữ liệu.
- Redis hoặc queue lỗi kéo dài.
- Worker crash, hoặc worker chạy **sai môi trường**.
- Microsoft OAuth / Graph / subscription lỗi diện rộng.
- Telegram send failure **hàng loạt**.
- Telegram **gửi nhầm** destination.
- Nghi **lộ secret**.
- Nghi **mã xác minh đầy đủ** hoặc **email body** bị log nhầm.
- Auth/session bất thường.
- Cần **emergency worker shutdown**.

Checklist hằng ngày dừng ở chỗ **nhận diện** incident; cách xử lý nằm trong
runbook.

---

## 11. Những việc KHÔNG làm trong vòng kiểm tra hằng ngày

- Không tạo customer login, customer portal, public signup, hay billing.
- Không làm một mailbox gửi tới nhiều Telegram destination.
- Không broadcast mã ra nhiều group/topic.
- Không cho mailbox **chưa Ready** chạy relay thật.
- Không đọc, in, hay sửa `.env` / secret thật.
- Không copy mã xác minh đầy đủ, email body đầy đủ, hay giá trị bí mật ra ngoài.
- Không thao tác trực tiếp lên production database.
- Không tự khắc phục sự cố nặng — đó là việc của runbook TASK-060.
- Không scale-up từ beta lên dùng nội bộ đầy đủ — đó là TASK-063.
- STAFF_READ_ONLY không vượt phạm vi customer được assign.

---

## 12. Daily log ngắn (tùy chọn)

Nếu nhóm muốn lưu vết, ghi một dòng ngắn mỗi ngày — **chỉ mô tả an toàn**:

- Ngày và người kiểm tra.
- Health tổng quát: OK / có vấn đề.
- Số mailbox không Ready (và lý do ngắn gọn).
- Có Telegram failure bất thường không.
- Đã escalate gì cho ai (nếu có).

**Không** ghi mã thật, email body, hay secret vào nhật ký này. Một masked
reference do UI cung cấp là đủ để truy vết.

---

## Tài liệu liên quan

- `docs/operations/STAFF_ONBOARDING_GUIDE.md` — onboarding cho nhân viên mới
  (TASK-061).
- `docs/tasks/TASK-060-backup-restore-incident-response.md` — backup, restore
  drill, và incident response.
- `deployment/production/README.md` — tổng quan production limited internal beta
  và emergency worker kill switch.
- `docs/SECURITY_RULES.md` — nguyên tắc bảo mật nền tảng.
- `docs/ROADMAP.md` — bối cảnh các sprint vận hành nội bộ.
