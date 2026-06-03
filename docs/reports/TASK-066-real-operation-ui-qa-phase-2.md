# Report / Checklist — TASK-066 Real operation UI QA & phase 2 test

> **Đây là checklist + report template** để chạy test UI thực tế (phase 2). Người
> test đánh dấu từng mục `[ ]` → `[x]`, ghi kết quả (PASS/FAIL/N/A) và ghi nhận
> issue ở mục 12 theo đúng format. **Không** sửa runtime/UI code khi điền
> checklist này; issue cần fix → mở task riêng sau review.

- **Người test:** _____________________
- **Vai trò dùng để test:** OWNER / ADMIN / STAFF_READ_ONLY (ghi rõ từng phiên)
- **Ngày test:** _____________________
- **Môi trường:** local / staging (ghi rõ — **không** dùng production khách hàng thật)
- **Build/commit test trên:** _____________________

---

## 0. Quy ước điền checklist

- Mỗi mục có cột kết quả: **PASS** (đúng kỳ vọng) / **FAIL** (sai → ghi issue ở
  mục 12) / **N/A** (không áp dụng cho vai trò/môi trường này).
- Mọi FAIL **phải** có một issue tương ứng ở mục 12 (tham chiếu bằng ID).
- Không ghi mã thật / email body / secret vào bất kỳ ô nào. Dùng mô tả + masked
  reference.

---

## 1. Safety precheck (làm TRƯỚC khi thao tác)

Mục tiêu: đảm bảo phiên test an toàn, không chạm dữ liệu khách hàng thật.

- [ ] Xác nhận đang test trên **local hoặc staging**, KHÔNG phải production có dữ
      liệu khách hàng thật. → _____
- [ ] Xác nhận **không** dùng mailbox khách hàng thật ở bước đầu (dùng mock /
      mailbox test). → _____
- [ ] Xác nhận **không** dùng Telegram group/topic của khách hàng thật (dùng
      destination test riêng / group nội bộ test). → _____
- [ ] Xác nhận **không** gửi verification code thật ra Telegram. → _____
- [ ] Chuẩn bị nơi lưu screenshot/video có thể **mask** giá trị nhạy cảm. → _____
- [ ] Đọc lại nguyên tắc an toàn (mục an toàn của task TASK-066 + SECURITY_RULES
      §1–§6). → _____
- [ ] Biết đường escalate khi nghi lộ secret/code/email body (runbook TASK-060). → _____

**Kết luận precheck:** PASS / FAIL — ghi chú: _____________________

---

## 2. UI smoke test (mọi màn hình load được & không vỡ)

Mục tiêu: mỗi màn hình mở được, không lỗi runtime, không lộ dữ liệu nhạy cảm,
hiển thị đúng theo vai trò.

| # | Màn hình | Route | Kỳ vọng cơ bản | Kết quả | Issue ID |
|---|---|---|---|---|---|
| 2.1 | Login | `/login` | Trang login hiển thị; production fail-closed báo "access locked" hợp lý; không lộ tên biến môi trường / cơ chế | | |
| 2.2 | Dashboard | `/admin` | Menu trái đủ mục theo vai trò; không lỗi; số liệu tổng quan hợp lý | | |
| 2.3 | Customers list | `/admin/customers` | Danh sách customer đúng scope vai trò; phân trang/empty state ổn | | |
| 2.4 | Customer create | `/admin/customers/new` | Form tạo customer hiển thị; validate input; chỉ role có quyền thấy | | |
| 2.5 | Customer edit | `/admin/customers/[id]/edit` | Form edit load đúng dữ liệu; lưu/hủy rõ ràng | | |
| 2.6 | Mailboxes list | `/admin/mailboxes` | Danh sách mailbox đúng scope; trạng thái (Ready / Needs mapping / Needs customer / Disconnected) rõ | | |
| 2.7 | Mailbox detail | `/admin/mailboxes/[id]` | Chi tiết mailbox: customer, trạng thái, mapping, nút Connect/Disconnect theo quyền | | |
| 2.8 | Telegram destinations + mappings | `/admin/telegram` | Danh sách reusable destinations + mappings; rõ mailbox nào dùng destination nào | | |
| 2.9 | Telegram mapping edit | `/admin/telegram/[id]/edit` | Form edit mapping; chọn destination trong đúng customer | | |
| 2.10 | Telegram destination edit | `/admin/telegram/destinations/[id]/edit` | Form edit destination; không lộ bot token | | |
| 2.11 | Mock email | `/admin/mock-email` | Dropdown/sample mock email; nút Process & send | | |
| 2.12 | Logs | `/admin/logs` | Danh sách event; mã được **mask**, không hiện full code/email body | | |
| 2.13 | Code-event logs | `/admin/logs/code-events` | Trạng thái extract/gửi; mã masked | | |
| 2.14 | Audit logs | `/admin/logs/audit` | Audit login/logout/access-denied; metadata an toàn | | |
| 2.15 | Health | `/admin/health` | Overview cards; workload by customer; operational checks chỉ cho OWNER/ADMIN | | |

Smoke test bổ sung (mọi màn hình):

- [ ] Không có console error nghiêm trọng / runtime crash khi điều hướng. → _____
- [ ] Không có giá trị nhạy cảm (token, secret, full code, full email body) lộ
      trên UI. → _____
- [ ] Responsive cơ bản OK (desktop; thu nhỏ cửa sổ không vỡ layout chính). → _____
- [ ] Loading / empty / error state hiển thị có nghĩa, không trắng trang. → _____

**Kết luận smoke test:** PASS / FAIL — ghi chú: _____________________

---

## 3. Mock email E2E (luồng an toàn, không email thật)

Mục tiêu: chạy luồng mock email → detect → extract → dedupe → Telegram bằng dữ
liệu mock và **destination test**, xác nhận code chạy đúng một lần tới đúng nơi.

- [ ] Mở `/admin/mock-email`, chọn một mock sample. → _____
- [ ] Bấm **Process** → quan sát kết quả (detect Facebook/Meta verification,
      extract code). → _____
- [ ] Code được route tới **đúng destination test** của mailbox/customer test. → _____
- [ ] Tin nhắn tới Telegram **chỉ một lần** (không trùng) — kiểm tra dedupe. → _____
- [ ] Trên `/admin/logs/code-events`: trạng thái success; mã hiển thị **masked**,
      KHÔNG full code. → _____
- [ ] Chạy lại cùng một mock sample → **không gửi trùng** (dedup theo
      `[mailboxId, graphMessageId]`). → _____
- [ ] Trường hợp email không phải verification → không gửi gì, không lỗi. → _____

**Kết luận mock email E2E:** PASS / FAIL — ghi chú: _____________________

---

## 4. Reusable Telegram destination test

Mục tiêu: xác nhận reusable destination dùng chung được bởi nhiều mailbox **cùng
customer**, và customer isolation được enforce.

- [ ] Tạo/chọn một reusable destination test thuộc **customer test A**. → _____
- [ ] Map **mailbox 1** (customer A) tới destination đó → thành công. → _____
- [ ] Map **mailbox 2** (customer A) tới **cùng** destination → thành công (chia
      sẻ hợp lệ). → _____
- [ ] Thử map mailbox của **customer B** tới destination của **customer A** →
      **bị chặn** (cross-customer isolation). → _____
- [ ] Trên UI, destination hiển thị rõ thuộc customer nào (không mơ hồ). → _____
- [ ] Bot token của destination **không** hiển thị trên UI. → _____

**Kết luận reusable destination:** PASS / FAIL — ghi chú: _____________________

---

## 5. One-mailbox-one-active-destination test

Mục tiêu: xác nhận mỗi mailbox tối đa một active destination; không multi-destination,
không broadcast.

- [ ] Mailbox test đã có **một** active destination. → _____
- [ ] Thử thêm **destination active thứ hai** cho cùng mailbox → **bị chặn**
      (one-active rule). → _____
- [ ] Đổi (re-point) mailbox sang destination khác → destination cũ không còn
      active; vẫn chỉ một active. → _____
- [ ] Không có cách nào trên UI tạo broadcast (một code → nhiều group/topic). → _____
- [ ] Mailbox sau khi đổi destination: relay (mock) đi tới **đúng** destination
      mới. → _____

**Kết luận one-active-destination:** PASS / FAIL — ghi chú: _____________________

---

## 6. Customer isolation / role scope test

Mục tiêu: xác nhận RBAC + assignment scope hoạt động đúng trên UI.

Phiên **OWNER/ADMIN**:

- [ ] Thấy **toàn bộ** customer / mailbox / destination / logs / health. → _____
- [ ] Thấy operational/infra checks trên `/admin/health`. → _____

Phiên **STAFF_READ_ONLY**:

- [ ] Chỉ thấy customer/mailbox được **assign** cho mình. → _____
- [ ] **Không** thấy customer/mailbox của customer chưa được assign. → _____
- [ ] Các thao tác quản trị (tạo customer, đổi mapping, connect/disconnect…) bị
      ẩn hoặc bị chặn theo cấu hình. → _____
- [ ] Health chỉ hiển thị **trong phạm vi** mailbox của customer được assign;
      không thấy infra checks toàn hệ thống. → _____
- [ ] Thử truy cập trực tiếp route/dữ liệu ngoài phạm vi (gõ URL id của customer
      khác) → **bị chặn / không lộ dữ liệu** (fail-closed). → _____

**Kết luận isolation / role scope:** PASS / FAIL — ghi chú: _____________________

---

## 7. Disconnect mailbox safety test

Mục tiêu: xác nhận disconnect là an toàn (TASK-052): không hard delete, dừng
poll/renew/relay, mapping active liên quan rời trạng thái active.

- [ ] Disconnect một mailbox test (vai trò OWNER/ADMIN). → _____
- [ ] Mailbox chuyển trạng thái **disconnected**, **không** bị xóa cứng; lịch sử
      xử lý còn nguyên. → _____
- [ ] Mailbox disconnected hiển thị **không Ready** trên `/admin/mailboxes` và
      `/admin/health`. → _____
- [ ] Active mapping liên quan **không còn active** (tránh relay nhầm). → _____
- [ ] Mock relay tới mailbox disconnected → **không gửi** (skip an toàn). → _____
- [ ] Reconnect lại (nếu test) → mailbox về trạng thái hợp lệ; xác nhận đúng
      customer/destination trước khi cho Ready. → _____

**Kết luận disconnect safety:** PASS / FAIL — ghi chú: _____________________

---

## 8. Health / logs / operations review

Mục tiêu: đối chiếu UI thực tế với onboarding guide + daily operations checklist.

- [ ] `/admin/health`: overview cards (Ready / Needs mapping / Needs customer /
      Disconnected / Error) khớp với trạng thái mailbox thực tế. → _____
- [ ] Workload by customer hiển thị đúng scope. → _____
- [ ] Telegram send failure (nếu có) hiển thị rõ; không lộ dữ liệu nhạy cảm. → _____
- [ ] Worker/queue/subscription/token signals: hiển thị OK / Unknown / Degraded /
      Error hợp lý (Unknown một mình không phải lỗi). → _____
- [ ] `/admin/logs` + `/admin/logs/audit`: mã masked; audit ghi login/logout/
      access-denied với metadata an toàn. → _____
- [ ] Luồng vận hành trên UI khớp với `STAFF_ONBOARDING_GUIDE.md` và
      `DAILY_OPERATIONS_CHECKLIST.md` (nếu lệch → ghi issue). → _____

**Kết luận health/logs/operations:** PASS / FAIL — ghi chú: _____________________

---

## 9. Tổng hợp kết quả từng khu vực

| Khu vực | PASS / FAIL / N/A | Số issue | Ghi chú |
|---|---|---|---|
| 1. Safety precheck | | | |
| 2. UI smoke test | | | |
| 3. Mock email E2E | | | |
| 4. Reusable destination | | | |
| 5. One-active-destination | | | |
| 6. Isolation / role scope | | | |
| 7. Disconnect safety | | | |
| 8. Health / logs / operations | | | |

---

## 10. Kết luận tổng thể phase 2 UI QA

- **Kết luận:** PASS / CONDITIONAL PASS / FAIL — _____________________
- **Số issue theo severity:** Critical ___ / High ___ / Medium ___ / Low ___
- **Có issue chặn (Critical/High) không:** Có / Không
- **Đề xuất bước tiếp:** _____________________

> Nếu có issue UI/UX → **mở task fix riêng** (đề xuất TASK-067+) sau khi
> OWNER/ADMIN review danh sách issue ở mục 12. Task TASK-066 **không** sửa UI.

---

## 11. Format ghi nhận issue UX/UI (bắt buộc dùng cho mỗi issue)

Mỗi issue ghi đầy đủ các trường sau (copy block dưới cho mỗi issue ở mục 12):

```
- ID: UI-066-001
- Screen: <route hoặc tên màn hình, vd /admin/telegram>
- Severity: Critical | High | Medium | Low
- Steps to reproduce:
    1.
    2.
    3.
- Expected:
- Actual:
- Screenshot/video: <tên file đã mask, vd ui-066-001-telegram.png — để trống nếu không có>
- Suggested next task: <vd "mở TASK-067 fix ..." — để trống nếu chưa cần fix>
```

Quy ước severity (đồng bộ với GEMINI.md / code-review.md):

| Severity | Nghĩa |
|---|---|
| **Critical** | Lỗi bảo mật / mất dữ liệu / route code sai customer / lộ secret-code-email |
| **High** | Hỏng chức năng vận hành chính (không map được, không relay được, scope sai) |
| **Medium** | Maintainability / UX gây nhầm lẫn, có workaround |
| **Low** | Style / góp ý nhỏ |

**Lưu ý an toàn khi ghi issue:** không dán full verification code, full email
body, token, secret vào Steps/Expected/Actual. Screenshot phải **mask** giá trị
nhạy cảm trước khi lưu vào repo.

---

## 12. Danh sách issue UX/UI ghi nhận được

> Điền theo format ở mục 11. Nếu không có issue, ghi rõ "Không phát hiện issue".

_(chưa có issue — điền khi chạy test)_

<!--
Ví dụ minh họa format (xóa khi điền thật):

- ID: UI-066-001
- Screen: /admin/telegram
- Severity: Medium
- Steps to reproduce:
    1. Mở /admin/telegram với vai trò ADMIN
    2. Map mailbox test customer A tới destination test customer A
    3. Quan sát nhãn destination trong danh sách mappings
- Expected: Destination hiển thị rõ thuộc customer A
- Actual: Danh sách không hiển thị customer của destination → dễ map nhầm
- Screenshot/video: ui-066-001-telegram-mapping.png
- Suggested next task: mở TASK-067 thêm nhãn customer cho destination trong mapping list
-->

---

## 13. Self-check secret-scan (trước khi commit report đã điền)

- [ ] Report **không** chứa token / secret / connection string / Telegram bot
      token thật.
- [ ] Report **không** chứa full verification code hoặc full email body.
- [ ] Không viết tên biến nhạy cảm liền sau dấu `=` kèm giá trị thật.
- [ ] Mọi screenshot/video đính kèm đã **mask** giá trị nhạy cảm.
- [ ] Chat id / dữ liệu test là giá trị **giả/test**, không phải khách hàng thật.

---

## Tài liệu liên quan

- `docs/tasks/TASK-066-real-operation-ui-qa-phase-2.md` — mô tả task phase 2.
- `docs/reports/TASK-064-final-technical-audit-phase-1.md` — audit phase 1 + backlog.
- `docs/reports/TASK-065-fix-legacy-telegram-mapping-isolation.md` — fix H1.
- `docs/operations/STAFF_ONBOARDING_GUIDE.md` — onboarding (luồng dùng từng feature).
- `docs/operations/DAILY_OPERATIONS_CHECKLIST.md` — nhịp kiểm tra hằng ngày.
- `docs/tasks/TASK-060-backup-restore-incident-response.md` — runbook khi nghi incident.
- `docs/SECURITY_RULES.md` — nguyên tắc bảo mật nền tảng.
