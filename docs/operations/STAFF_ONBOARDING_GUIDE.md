# Staff Onboarding Guide

Hướng dẫn dành cho **nhân viên nội bộ** mới được giao sử dụng dashboard của
**Verification Code Relay Tool** trong giai đoạn *limited internal beta*.

> Tài liệu này viết cho người **không chuyên code**. Bạn không cần biết lập
> trình để làm theo. Khi nào gặp bước không chắc chắn, **dừng lại và báo
> OWNER/ADMIN** thay vì tự đoán.

Vị trí tài liệu: đặt ở `docs/operations/` vì đây là tài liệu **vận hành** cho
con người, tách khỏi `docs/tasks/` (mô tả task) và `docs/reports/` (báo cáo
kết quả). Repo chưa có thư mục `docs/operations/`, nên thư mục này được tạo
mới để chứa các guide vận hành về sau (ví dụ daily operations checklist của
TASK-062).

---

## 1. Mục đích tài liệu

Sau khi đọc xong guide này, một nhân viên mới sẽ:

- Hiểu công cụ này dùng để làm gì và **không** dùng để làm gì.
- Biết mình có vai trò nào và **thấy được dữ liệu gì**.
- Biết cách đăng nhập dashboard khi môi trường đã sẵn sàng.
- Hiểu thế nào là một mailbox **Ready** (sẵn sàng nhận và chuyển mã).
- Biết cách connect mailbox và map mailbox tới một Telegram destination dùng chung.
- Biết cách **test-send an toàn** trước khi cho chạy thật.
- Biết xem logs và health ở mức cơ bản.
- Biết **khi nào phải báo OWNER/ADMIN** thay vì tự xử lý.

Guide này **không** phải daily operations checklist (việc đó ở TASK-062) và
**không** phải backup/incident runbook (việc đó ở TASK-060). Khi cần xử lý sự
cố production, xem `docs/tasks/TASK-060-backup-restore-incident-response.md`.

---

## 2. Công cụ này là gì (và không là gì)

Verification Code Relay Tool là **internal staff app** của agency. Nó tự động
nhận email chứa mã xác minh, trích xuất mã, rồi chuyển mã vào đúng Telegram
group/topic của từng khách hàng.

**Đây KHÔNG phải:**

- **Không** có khách hàng đăng nhập. Khách hàng **không bao giờ** login vào
  dashboard này. Họ chỉ **nhận mã qua Telegram**.
- **Không** có đăng ký công khai (public signup).
- **Không** có billing/payment.
- **Không** phải public SaaS.

Chỉ **nhân viên nội bộ** được cấp tài khoản mới dùng được dashboard.

---

## 3. Nguyên tắc an toàn bắt buộc

Đọc kỹ phần này trước khi làm bất kỳ thao tác nào. Đây là các quy tắc **không
được phá**:

1. **Mỗi mailbox chỉ chuyển mã tới đúng một Telegram destination active của
   chính nó.** Không bao giờ để một mailbox gửi tới nhiều group/topic.
2. **Không broadcast** mã xác minh ra nhiều group/topic.
3. **Nhiều mailbox có thể dùng chung một destination** (reusable destination) —
   điều này là hợp lệ và có chủ đích. Nhưng **một mailbox vẫn chỉ có tối đa một
   destination active**.
4. **Không bao giờ** copy/dán mã xác minh thật, token, client secret, bot token,
   encryption key, connection string, hay toàn bộ nội dung email vào chat, ghi
   chú, hay tin nhắn cho ai.
5. **Không đụng vào `.env` hoặc secret thật.** Nếu cần thay đổi cấu hình bí mật,
   đó là việc của OWNER/ADMIN qua secret manager của nền tảng deploy.
6. **Mailbox chưa Ready thì không cho chạy relay thật.** Xem mục 7.
7. Khi không chắc chắn → **dừng và báo OWNER/ADMIN**.

---

## 4. Vai trò và giới hạn quyền

Hệ thống có hai nhóm vai trò chính:

| Vai trò | Thấy được gì | Làm được gì |
|---------|--------------|-------------|
| **OWNER / ADMIN** | Toàn bộ customer, mailbox, destination, logs, health | Cấu hình quản trị: tạo customer, gán assignment, connect/disconnect mailbox, tạo/sửa destination, đổi quyền |
| **STAFF_READ_ONLY** | **Chỉ** customer được assign cho mình, cùng mailbox/mapping của các customer đó | Chủ yếu **xem**; các thao tác quản trị thường bị giới hạn theo cấu hình thực tế |

Những điều quan trọng cần nhớ:

- **Không thấy một customer/mailbox KHÔNG có nghĩa là nó không tồn tại.** Rất có
  thể nó chỉ chưa được assign cho bạn. Đừng kết luận "dữ liệu bị mất".
- Nếu bạn **thiếu quyền** để làm một việc, hoặc **thiếu customer/mailbox** mà
  bạn được giao phải xử lý → **báo OWNER/ADMIN**. Đừng tìm cách lách quyền.
- Vai trò và phạm vi dữ liệu được kiểm soát ở phía server. Giao diện chỉ hiển
  thị đúng phần bạn được phép xem.

---

## 5. Đăng nhập dashboard

> Trong giai đoạn beta hiện tại, đăng nhập production có thể **chưa khả dụng**.
> Production đang ở chế độ khóa an toàn (fail-closed) cho tới khi một cơ chế
> đăng nhập production chính thức được thêm vào (một task riêng). Nếu bạn thấy
> trang "access locked", **đó không phải lỗi của bạn** — hãy báo OWNER/ADMIN để
> biết môi trường đã sẵn sàng chưa.

Khi môi trường đã sẵn sàng:

1. Mở đường link dashboard mà OWNER/ADMIN cung cấp.
2. Bạn sẽ được đưa tới trang đăng nhập (`/login`).
3. Đăng nhập bằng tài khoản nội bộ mà OWNER/ADMIN cấp cho bạn.
4. Sau khi vào, bạn sẽ thấy menu bên trái với các mục:
   **Dashboard, Customers, Mailboxes, Telegram, Mock Email, Logs, Health.**
   (Một số mục có thể bị ẩn hoặc chỉ-đọc tùy vai trò của bạn.)

Lưu ý an toàn khi đăng nhập:

- **Không** dùng tài khoản dùng-thử (dev demo) hay mật khẩu staging để cố mở
  production. Chúng bị bỏ qua ở production một cách có chủ đích.
- **Không** chia sẻ tài khoản của bạn cho người khác.
- Nếu gặp lỗi đăng nhập hoặc lỗi quyền truy cập → **báo OWNER/ADMIN** (mục 13).

---

## 6. Hiểu customer assignment

"Assignment" nghĩa là OWNER/ADMIN gán một số customer cho bạn phụ trách.

- Nếu bạn là **STAFF_READ_ONLY**, danh sách Customers/Mailboxes/Telegram bạn
  thấy đã được **lọc sẵn** theo các customer được assign cho bạn.
- Bạn chỉ nên thao tác trong phạm vi customer của mình.
- **Cross-customer bị cấm:** dữ liệu của khách hàng A không bao giờ được trộn
  với khách hàng B. Hệ thống tự chặn việc này, và bạn cũng không được tìm cách
  vượt qua.
- Cần thêm/bớt customer trong phạm vi của bạn → đó là thay đổi assignment, phải
  do **OWNER/ADMIN** thực hiện. Hãy yêu cầu họ.

---

## 7. Hiểu mailbox readiness

Một mailbox chỉ được coi là **Ready** (sẵn sàng nhận và chuyển mã thật) khi
**tất cả** các điều kiện sau đúng:

- Mailbox đã **connect hợp lệ**.
- Mailbox thuộc **đúng customer**.
- Mailbox **không bị disconnected**.
- Mailbox có **đúng một** Telegram destination **active** hợp lệ.
- Destination đó trỏ tới **đúng group/topic** cần nhận mã.
- **Không** có lỗi token, subscription, hay Telegram hiển thị rõ trên dashboard.

Trên trang **Health** (`/admin/health`), trạng thái thường hiển thị dạng:

- **Ready** — đủ điều kiện ở trên.
- **Needs mapping** — mailbox đã connect nhưng **chưa có** destination → **chưa
  Ready**.
- **Needs customer** — mailbox chưa gán đúng customer.

Quy tắc cần thuộc:

- **Mailbox disconnected → KHÔNG Ready.** Nó sẽ không được poll, không renew
  subscription, và không chuyển mã.
- **Mailbox thiếu mapping → KHÔNG Ready.**
- **Mailbox có mapping nhưng không rõ destination trỏ tới đâu → báo
  OWNER/ADMIN**, đừng đoán.
- **Mailbox chưa Ready thì KHÔNG dùng cho relay thật.**

---

## 8. Connect mailbox

Connect mailbox là bước cấp quyền cho hệ thống đọc hộp thư (qua Microsoft
OAuth). Tùy vai trò, bạn có thể chỉ xem chứ không tự connect được — khi đó hãy
nhờ OWNER/ADMIN.

Ở mức người dùng dashboard:

1. Vào **Mailboxes** (`/admin/mailboxes`).
2. Bấm nút **Connect** (ví dụ "Connect Hotmail") nếu nút hiển thị cho vai trò
   của bạn.
3. Làm theo luồng đăng nhập/đồng ý của Microsoft trong cửa sổ được mở.
4. Sau khi quay lại dashboard, mở trang chi tiết mailbox
   (`/admin/mailboxes/<id>`) và kiểm tra:
   - Mailbox đã gán **đúng customer** chưa.
   - Trạng thái **không** phải disconnected.

Lưu ý an toàn:

- **Không** dán token, mã code OAuth, hay client secret vào bất kỳ đâu. Luồng
  connect tự xử lý phần đó; bạn không cần nhìn thấy giá trị bí mật.
- Nếu luồng connect báo lỗi (ví dụ "connect thất bại", phiên kết nối hết hạn),
  bấm Connect lại từ đầu. Nếu vẫn lỗi → **báo OWNER/ADMIN**.
- Một mailbox **disconnected** sẽ ngừng được poll/renew/relay cho tới khi
  reconnect. Việc reconnect/disconnect mang tính quản trị — nếu không chắc, hỏi
  OWNER/ADMIN.

---

## 9. Map mailbox tới reusable Telegram destination

**Reusable Telegram destination** là một group/topic Telegram được OWNER/ADMIN
cấu hình **một lần** và lưu lại để **nhiều mailbox dùng chung**. Bạn chọn một
destination đã có sẵn thay vì nhập lại chat ID mỗi lần.

Cách hiểu nhanh:

- **Nhiều mailbox → cùng một destination:** hợp lệ, có chủ đích.
- **Một mailbox → nhiều destination:** **KHÔNG được phép.** Mỗi mailbox chỉ có
  **một** destination active.
- **Broadcast một mã ra nhiều group/topic:** **KHÔNG được phép.**

Các bước (ở mức dashboard, trang **Telegram** — `/admin/telegram`):

1. Mở trang **Telegram**. Bạn sẽ thấy danh sách **Destinations** (group/topic
   đã cấu hình sẵn) và danh sách **mappings** (mailbox nào dùng destination nào).
2. Khi map một mailbox, chọn **đúng customer**, **đúng mailbox**, và **đúng
   destination** trong phạm vi customer đó.
3. Trước khi để mailbox chạy thật, **luôn xác nhận lại ba thông tin trên** rồi
   mới test-send (mục 10).

Nếu bạn thấy một destination không rõ thuộc customer nào, hoặc nghi map sai →
**dừng và báo OWNER/ADMIN**.

---

## 10. Test-send an toàn

Test-send gửi một **tin nhắn thử vô hại** vào group/topic để xác nhận
destination/mapping đã đúng — **trước khi** cho relay mã thật.

Quy tắc bắt buộc:

- **Chỉ test-send sau khi đã xác nhận đúng customer, đúng mailbox, đúng
  destination.**
- Nội dung test **không chứa mã xác minh thật**.
- Nội dung test **không chứa** token, secret, toàn bộ nội dung email, hay dữ
  liệu nhạy cảm của khách hàng. Một câu vô hại như "tin nhắn thử của Verification
  Tool" là đủ.
- Kiểm tra tin nhắn thử **xuất hiện đúng group/topic** mong đợi.
- Nếu tin nhắn thử **vào nhầm** group/topic → **dừng ngay**, không tiếp tục
  relay, và **báo OWNER/ADMIN** (đây là lỗi định tuyến nghiêm trọng).

Chỉ khi test-send vào đúng nơi thì mailbox mới nên được dùng cho relay thật.

---

## 11. Kiểm tra logs cơ bản

Trang **Logs** (`/admin/logs`) giúp bạn xem hệ thống đã xử lý gì. Ở mức cơ bản:

- Bạn có thể xem **trạng thái thành công / thất bại** của việc xử lý và gửi
  (nếu vai trò của bạn được phép).
- Bạn **không cần** xem toàn bộ nội dung email.
- Bạn **không cần và không được** copy mã xác minh đầy đủ ra ngoài. Logs được
  thiết kế để **che (mask)** mã, không hiển thị mã thật ở dạng đầy đủ — đừng
  tìm cách lấy mã đầy đủ.
- Nếu thấy nhiều lần **gửi thất bại** bất thường, hoặc thấy nghi ngờ mã/nội dung
  email bị lộ ra log → **báo OWNER/ADMIN** ngay.

> Việc theo dõi logs theo lịch hằng ngày (đọc gì, tần suất nào) thuộc **daily
> operations checklist** ở TASK-062, không nằm trong guide onboarding này.

---

## 12. Kiểm tra health cơ bản

Trang **Health** (`/admin/health`) cho bạn cái nhìn nhanh về tình trạng vận hành
trong phạm vi bạn được phép xem:

- **STAFF_READ_ONLY** thấy health **theo phạm vi** mailbox của customer được
  assign cho mình.
- **OWNER/ADMIN** thấy thêm các check hạ tầng/vận hành toàn hệ thống.

Ở mức cơ bản, hãy để ý:

- Số mailbox **Ready / Needs mapping / Needs customer**.
- Mailbox đang có **lỗi hoặc bị disconnected**.
- Dấu hiệu **Telegram failed**, lỗi **token/subscription**, hoặc trạng thái
  worker/queue/service (nếu vai trò bạn được phép xem).

Khi health báo có vấn đề mà bạn không tự xử lý được (worker lỗi, queue bất
thường, subscription/Telegram lỗi) → **báo OWNER/ADMIN** (mục 13).

---

## 13. Khi nào báo OWNER/ADMIN

Hãy báo OWNER/ADMIN **ngay** trong các tình huống sau, **đừng tự xử lý**:

- Không thấy customer/mailbox mà bạn được giao phải làm.
- Mailbox **không Ready** (và bạn không rõ vì sao).
- Mailbox bị **disconnected**.
- Destination **thiếu, sai, hoặc nghi ngờ sai**.
- Test-send (hoặc một mã thật) vào **nhầm** group/topic.
- Số lần **Telegram gửi thất bại tăng bất thường**.
- Nghi ngờ **lộ secret**, lộ **mã xác minh**, hoặc lộ **nội dung email**.
- Gặp **lỗi đăng nhập** hoặc **lỗi quyền truy cập**.
- Health báo **lỗi worker, queue, subscription, hoặc service**.
- Cần thay đổi **assignment, destination, hoặc quyền**.

Khi báo, mô tả hiện tượng bằng lời (ví dụ "test-send vào nhầm group của customer
X"). **Không** dán mã thật, token, secret, hay toàn bộ email vào tin nhắn báo cáo.

---

## 14. Những việc staff KHÔNG được làm

- Không tạo customer login, customer portal, public signup, hay billing.
- Không làm một mailbox gửi tới nhiều Telegram destination.
- Không broadcast mã ra nhiều group/topic.
- Không dùng tài khoản dev/staging để mở production.
- Không đọc, in, hay chỉnh sửa `.env` / secret thật.
- Không copy mã xác minh đầy đủ, token, secret, bot token, encryption key,
  connection string, hay toàn bộ nội dung email ra ngoài hệ thống.
- Không thao tác trực tiếp lên production database.
- Không vượt phạm vi customer được assign cho mình.
- Không cho mailbox **chưa Ready** chạy relay thật.

---

## 15. Checklist onboarding cho staff mới

Đánh dấu từng mục khi đã làm xong:

- [ ] Đã đọc hết guide này, đặc biệt mục 3 (nguyên tắc an toàn).
- [ ] Biết vai trò của mình (OWNER/ADMIN hay STAFF_READ_ONLY) và phạm vi dữ liệu.
- [ ] Đã đăng nhập được dashboard (khi môi trường sẵn sàng), hoặc đã được
      OWNER/ADMIN xác nhận production còn đang khóa.
- [ ] Biết các customer/mailbox mình được assign.
- [ ] Hiểu một mailbox **Ready** cần những điều kiện gì.
- [ ] Biết phân biệt Ready / Needs mapping / Needs customer / disconnected.
- [ ] Hiểu reusable destination: nhiều mailbox dùng chung được, nhưng mỗi
      mailbox chỉ một destination active.
- [ ] Biết quy trình test-send an toàn (không dùng mã thật, xác nhận đúng nơi).
- [ ] Biết xem logs và health ở mức cơ bản.
- [ ] Thuộc danh sách tình huống phải báo OWNER/ADMIN (mục 13).
- [ ] Thuộc danh sách việc không được làm (mục 14).

---

## 16. Handoff sau onboarding

Sau khi hoàn tất checklist:

- Báo OWNER/ADMIN rằng bạn đã onboard xong và xác nhận phạm vi customer của mình.
- Việc vận hành **hằng ngày** (thứ tự kiểm tra, tần suất, ngưỡng cảnh báo) sẽ
  theo **daily operations checklist** — sẽ có ở TASK-062.
- Khi production gặp **sự cố**, dùng runbook
  `docs/tasks/TASK-060-backup-restore-incident-response.md`; không tự xử lý
  vượt quyền.
- Việc **mở rộng** từ beta lên dùng nội bộ đầy đủ thuộc TASK-063, do OWNER/ADMIN
  điều phối.

---

## Tài liệu liên quan

- `deployment/production/README.md` — tổng quan production limited internal beta
  và emergency worker kill switch.
- `docs/tasks/TASK-060-backup-restore-incident-response.md` — backup, restore
  drill, và incident response.
- `docs/SECURITY_RULES.md` — nguyên tắc bảo mật nền tảng.
- `docs/ROADMAP.md` — bối cảnh các sprint vận hành nội bộ.
