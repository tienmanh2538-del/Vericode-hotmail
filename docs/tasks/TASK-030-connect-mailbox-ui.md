# TASK-030: Connect Mailbox UI

## 1. Mục tiêu

Tạo và hoàn thiện giao diện kết nối mailbox Hotmail/Outlook trong admin dashboard.

Task này thuộc Sprint 7 — Mailbox dashboard.

Mục tiêu chính là nâng cấp trải nghiệm người dùng cho luồng connect mailbox đã có sẵn, không viết lại logic OAuth/API.

Hiện project đã có sẵn:

- `components/admin/ConnectMailboxButton.tsx`
- `app/admin/page.tsx`
- API `/api/mailboxes/connect-url`

Trong đó nút Connect Hotmail đã gọi API connect-url và dashboard đã có banner success/error sau OAuth callback.

TASK-030 phải tái sử dụng hoặc nâng cấp component hiện tại, không tạo logic connect mới trùng lặp.

---

## 2. Bối cảnh hiện tại

Các task trước đã làm:

- TASK-018: Tạo Microsoft OAuth connect URL
- TASK-019: Tạo Microsoft OAuth callback
- TASK-021: Lưu mailbox sau OAuth connect
- TASK-023: Tạo Graph subscription service
- TASK-028: Tạo mailbox list page
- TASK-029: Tạo mailbox detail page

TASK-030 chỉ làm phần UI/UX kết nối mailbox.

Luồng hiện tại cần được giữ:

```text
Admin bấm Connect Hotmail
→ frontend gọi /api/mailboxes/connect-url
→ backend trả về Microsoft OAuth URL
→ browser redirect sang Microsoft
→ user consent
→ Microsoft callback về backend
→ backend xử lý OAuth
→ redirect về dashboard kèm oauth success/error
→ dashboard hiển thị banner
````

---

## 3. File cần đọc trước khi sửa

Claude bắt buộc đọc các file sau trước khi code:

```text
PROJECT_CONTEXT.md
PROJECT_STRUCTURE.md
docs/ROADMAP.md
docs/tasks/TASK-030-connect-mailbox-ui.md
components/admin/ConnectMailboxButton.tsx
app/admin/page.tsx
app/admin/mailboxes/page.tsx
app/admin/mailboxes/[id]/page.tsx
app/admin/mailboxes/mailboxes.css nếu có
services/microsoft/oauth.service.ts nếu cần hiểu connect-url
app/api/mailboxes/connect-url/route.ts nếu cần hiểu API
```

Không được tự đoán cấu trúc project. Phải kiểm tra project đang dùng `src/` hay không trước khi tạo/sửa file.

---

## 4. Yêu cầu chức năng

### 4.1. Connect button

Nâng cấp hoặc tái sử dụng component hiện có:

```text
components/admin/ConnectMailboxButton.tsx
```

Yêu cầu:

* Vẫn gọi đúng endpoint `/api/mailboxes/connect-url`.
* Vẫn dùng `fetch`.
* Bắt buộc giữ:

```ts
credentials: "same-origin"
```

* Khi đang gọi API, button phải disabled.
* Khi đang gọi API, button hiển thị loading rõ ràng, ví dụ:

```text
Đang tạo liên kết Microsoft...
```

hoặc:

```text
Connecting...
```

* Khi API trả về `{ ok: true, url: "..." }`, redirect browser sang URL đó.
* Khi API trả lỗi, hiển thị lỗi an toàn trên UI.
* Không log token/secret/response nhạy cảm ra console.
* Không expose Microsoft client secret, access token, refresh token, encrypted refresh token, clientStateHash trên frontend.

---

### 4.2. Vị trí UI

Nút connect phải xuất hiện ở vị trí hợp lý trong admin mailbox dashboard.

Ưu tiên:

```text
/admin/mailboxes
```

Cụ thể:

* Ở phần header của mailbox list page nên có CTA rõ ràng:

```text
Connect Hotmail / Outlook
```

* Khi mailbox list đang empty, empty state nên có nút connect.
* Dashboard `/admin` có thể tiếp tục giữ nút connect hiện tại nếu đã hợp lý.
* Không được làm mất banner success/error hiện tại ở `app/admin/page.tsx`.

---

### 4.3. UX copy

UI nên giải thích ngắn gọn cho admin:

```text
Kết nối mailbox Hotmail/Outlook để hệ thống đọc email xác minh Facebook/Meta thông qua Microsoft OAuth.
Bạn sẽ được chuyển sang Microsoft để đăng nhập và cấp quyền.
Hệ thống không lưu mật khẩu email.
```

Không viết nội dung gây hiểu nhầm như:

```text
Nhập mật khẩu Hotmail
Lưu mật khẩu email
Bypass xác minh
Hack code
```

---

### 4.4. Error state

Khi connect-url API lỗi, UI phải hiển thị message thân thiện.

Ví dụ:

```text
Không thể tạo liên kết kết nối Microsoft. Vui lòng kiểm tra cấu hình Microsoft OAuth trong .env.local.
```

Không hiển thị raw stack trace.

Không hiển thị env secret.

Không hiển thị token.

---

### 4.5. Accessibility cơ bản

Component nên có:

* `disabled` khi loading.
* `aria-busy` nếu phù hợp.
* Error message có thể đọc được, ví dụ `role="alert"`.
* Text button rõ nghĩa, không chỉ dùng icon.

---

## 5. File dự kiến tạo/sửa

Claude được phép sửa các file sau nếu cần:

```text
components/admin/ConnectMailboxButton.tsx
app/admin/page.tsx
app/admin/mailboxes/page.tsx
app/admin/mailboxes/mailboxes.css
```

Claude được phép tạo file UI wrapper nếu thật sự cần, ví dụ:

```text
components/admin/ConnectMailboxPanel.tsx
```

Nhưng nếu tạo wrapper mới thì wrapper phải dùng lại `ConnectMailboxButton`, không được tạo logic connect thứ hai.

Không nên tạo:

```text
components/mailboxes/ConnectButton.tsx
components/mailboxes/ConnectMailboxButton.tsx
components/admin/NewConnectButton.tsx
```

nếu chỉ để duplicate logic.

---

## 6. Không được làm

Không được:

* Viết lại OAuth service.
* Viết lại `/api/mailboxes/connect-url`.
* Viết lại Microsoft callback.
* Sửa database schema.
* Sửa Prisma migration.
* Sửa token encryption.
* Sửa Graph subscription logic.
* Sửa webhook/worker/queue.
* Làm TASK-031/TASK-032/TASK-033/TASK-034/TASK-035.
* Xóa banner success/error hiện tại.
* Bỏ `credentials: "same-origin"`.
* Log token/secret/full email body/full verification code.
* Commit `.env` hoặc `.env.local`.
* Tạo UI yêu cầu nhập password Hotmail.

---

## 7. Tiêu chí nghiệm thu

Task PASS khi đạt đủ:

* `/admin/mailboxes` có UI connect mailbox rõ ràng.
* Empty state của mailbox list có CTA connect nếu chưa có mailbox.
* Component cũ `components/admin/ConnectMailboxButton.tsx` được tái sử dụng hoặc nâng cấp, không bị bỏ quên.
* Không có component connect logic trùng lặp.
* Fetch vẫn gọi `/api/mailboxes/connect-url`.
* Fetch vẫn có `credentials: "same-origin"`.
* Button có loading state.
* Button disabled khi loading.
* API lỗi thì hiện error an toàn.
* Không lộ token/secret/clientStateHash/encryptedRefreshToken ra frontend.
* Banner success/error ở `app/admin/page.tsx` vẫn hoạt động.
* `npm run verify` PASS.
* Gemini review PASS.

---

## 8. Lệnh kiểm tra

Chạy:

```powershell
npm run verify
```

Kiểm tra code có giữ endpoint không:

```powershell
Select-String -Path .\components\admin\ConnectMailboxButton.tsx -Pattern "/api/mailboxes/connect-url"
```

Kiểm tra code có giữ credentials không:

```powershell
Select-String -Path .\components\admin\ConnectMailboxButton.tsx -Pattern "same-origin"
```

Kiểm tra không tạo component connect trùng lặp:

```powershell
Get-ChildItem -Recurse -File -Include *.tsx,*.ts | Select-String -Pattern "connect-url","ConnectMailboxButton"
```

Kiểm tra Git không có env secret:

```powershell
git status --short
```

Kiểm tra diff:

```powershell
git diff
```

---

## 9. Báo cáo cuối task Claude phải trả về

Claude phải báo cáo theo format:

```text
1. Đã làm gì
2. File nào đã sửa/tạo
3. Có giữ /api/mailboxes/connect-url không
4. Có giữ credentials: "same-origin" không
5. Có tạo component connect trùng lặp không
6. Có đụng OAuth/API/callback/database/worker không
7. Lệnh đã chạy
8. Kết quả npm run verify PASS/FAIL
9. Rủi ro còn lại
10. Đề xuất bước kiểm tra thủ công cho user
```
