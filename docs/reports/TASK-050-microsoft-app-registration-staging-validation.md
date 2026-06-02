# TASK-050 Report — Microsoft App Registration Staging Validation

Báo cáo ngày: 2026-06-02
Tác giả: Claude Code

Platform staging (chốt ở TASK-048/049): Railway (chính), Render (dự phòng tương đương).
Phạm vi: Xác minh checklist Microsoft App Registration riêng cho staging
(Redirect URI, webhook URL, permission tối thiểu, an toàn client secret). Không
chạy live mailbox E2E (TASK-051), không deploy production, không dùng
database/Redis production, không dùng mailbox / Telegram group khách hàng thật,
không tạo migration, không sửa runtime code, không ghi secret thật. Chỉ
ghi tên biến môi trường và placeholder, không ghi giá trị thật.

---

## 1. Kết luận xác minh (tóm tắt)

| Mục cần có cho TASK-050 | Trạng thái | Nguồn đã xác minh trong repo |
|---|---|---|
| Task file đúng scope | ✅ Đã có | `docs/tasks/TASK-050-microsoft-app-registration-staging-validation.md` |
| Checklist App Registration staging riêng | ✅ Đã đủ | `docs/MICROSOFT_SETUP.md` §3.1, §3.4, §9 |
| Redirect URI staging placeholder | ✅ Đã đủ | `docs/MICROSOFT_SETUP.md` §3.4; `docs/STAGING_DEPLOYMENT.md` §5.4, §5.5 |
| Webhook URL staging placeholder | ✅ Đã đủ | `docs/MICROSOFT_SETUP.md` §3.4; `docs/STAGING_DEPLOYMENT.md` §5.2, §5.5 |
| Permission tối thiểu (Mail.Read, offline_access, User.Read) | ✅ Đã đủ | `docs/MICROSOFT_SETUP.md` §5; `docs/STAGING_DEPLOYMENT.md` §5.5 |
| Cấm permission ngoài scope | ✅ Đã đủ | `docs/MICROSOFT_SETUP.md` §5.1 |
| An toàn client secret (chỉ secret manager) | ✅ Đã đủ | `docs/MICROSOFT_SETUP.md` §4.1, §9; `docs/SECURITY_RULES.md` §1, §3 |
| Cross-reference Staging ↔ Microsoft setup | ✅ Đã đủ | `docs/STAGING_DEPLOYMENT.md` header "Liên quan", §5.5, §5.12 |

→ Hai tài liệu nguồn (`MICROSOFT_SETUP.md`, `STAGING_DEPLOYMENT.md`) **đã đủ** checklist
staging tối thiểu, nên TASK-050 **không sửa** chúng. TASK-050 chỉ bổ sung report này
để xác minh và gom checklist thao tác thủ công.

---

## 2. Redirect URI & Webhook URL staging (placeholder)

Chỉ dùng placeholder; thay `<STAGING_DOMAIN>` bằng domain Railway staging thật khi
triển khai (ví dụ domain mặc định `.railway.app` đã chốt ở TASK-049).

```text
Redirect URI (staging):
https://<STAGING_DOMAIN>.railway.app/api/microsoft/oauth/callback

Webhook URL (staging):
https://<STAGING_DOMAIN>.railway.app/api/webhooks/microsoft/mail
```

Quy tắc khớp tuyệt đối:

- Redirect URI trong Microsoft Entra **phải khớp tuyệt đối** với env name
  `MICROSOFT_REDIRECT_URI` (sai protocol/port/path/dấu `/` → `AADSTS50011`).
- Webhook URL phải khớp env name `MICROSOFT_GRAPH_NOTIFICATION_URL` và là **public HTTPS**.
- Staging **bắt buộc HTTPS**, **không** dùng `http://localhost`.

> Ghi chú: `docs/MICROSOFT_SETUP.md` §3.4 và `docs/STAGING_DEPLOYMENT.md` dùng placeholder
> trung tính `https://YOUR_STAGING_DOMAIN/...` (không gắn cứng platform). Report này dùng
> dạng `.railway.app` theo platform đã chốt ở TASK-048/049. Cả hai đều là placeholder, đều
> hợp lệ; không có domain thật nào được ghi. Không cần sửa docs nguồn.

---

## 3. Permission tối thiểu (Microsoft Graph delegated)

Chỉ thêm đúng 3 delegated permission:

```text
Mail.Read         -> đọc mailbox để nhận verification email
offline_access    -> cấp refresh_token để duy trì quyền đọc khi user offline
User.Read         -> đọc display name/email để gắn mailbox vào account
```

**Không** thêm bất kỳ permission ngoài scope nào:

```text
Mail.Send                  (hệ thống không gửi email)
Mail.ReadWrite             (hệ thống không sửa email)
MailboxSettings.ReadWrite  (không sửa mailbox settings)
Files.Read                 (không đọc file)
Calendars.Read             (không đọc calendar)
Contacts.Read              (không đọc contact)
```

Nếu sau này cần scope mới → phải tạo task riêng + security review riêng (theo
`docs/MICROSOFT_SETUP.md` §5.1 và nguyên tắc Sprint 10→15 trong `docs/ROADMAP.md`).

---

## 4. An toàn client secret (CRITICAL)

```text
[ ] Dùng secret "Value" (không dùng "Secret ID").
[ ] Secret Value chỉ nhập vào Railway secret manager (Variables).
[ ] KHÔNG paste secret vào ChatGPT/Claude/Gemini/Cursor/docs/code/log/commit message.
[ ] KHÔNG tái dùng client secret của local dev cho staging (App Registration riêng).
[ ] KHÔNG commit nội dung .env / .env.local / .env.staging / .env.production.
[ ] Nếu nghi secret lộ -> rotate ngay trên Microsoft Entra, cập nhật lại Railway.
```

Cơ sở: `docs/SECURITY_RULES.md` §1 (secrets), §3 (tokens); `docs/MICROSOFT_SETUP.md`
§4.1, §9.

---

## 5. Phần A — việc đã xác minh TRONG repo (Claude)

```text
[x] Task file TASK-050 tồn tại, đúng scope (validation-only, không E2E).
[x] MICROSOFT_SETUP.md có checklist staging: App Registration riêng (§3.1),
    Redirect URI + Webhook URL staging (§3.4), permission tối thiểu (§5),
    cấm permission ngoài scope (§5.1), security rules secret (§9).
[x] STAGING_DEPLOYMENT.md cross-reference Microsoft setup (header "Liên quan",
    §5.5) và nhắc TASK-050 = App Registration staging, TASK-051 = live E2E (§5.12).
[x] Bảng env names staging chỉ ghi TÊN biến (STAGING_DEPLOYMENT §5.4) — không giá trị thật.
[x] Report này gom checklist thao tác thủ công cho user (mục 6).
[x] Không sửa MICROSOFT_SETUP.md / STAGING_DEPLOYMENT.md vì đã đủ.
[x] Không sửa runtime code, không tạo migration, không đụng worker/Telegram routing.
```

Env names liên quan Microsoft (chỉ TÊN, giá trị thật chỉ sống trong Railway secret manager):

```text
MICROSOFT_CLIENT_ID
MICROSOFT_CLIENT_SECRET
MICROSOFT_TENANT_ID
MICROSOFT_REDIRECT_URI
MICROSOFT_GRAPH_NOTIFICATION_URL
MICROSOFT_GRAPH_LIFECYCLE_NOTIFICATION_URL
```

---

## 6. Phần B — việc USER phải thao tác THỦ CÔNG

Nằm ngoài repo. User tự làm trên Microsoft Entra + Railway. **Không paste secret thật
vào bất kỳ AI nào.**

### 6.1. Trên Microsoft Entra admin center

```text
[ ] Tạo App Registration RIÊNG cho staging (ví dụ "Verification Code Relay Tool - Staging").
[ ] Không dùng chung App Registration với local dev / production.
[ ] Supported account types phù hợp nhu cầu test (multitenant + personal, hoặc tenant cụ thể).
[ ] Platform = Web.
[ ] Thêm Redirect URI staging:
        https://<STAGING_DOMAIN>.railway.app/api/microsoft/oauth/callback
[ ] Redirect URI dùng HTTPS, không dùng localhost, đúng path/dấu slash.
[ ] Tạo client secret staging MỚI; copy đúng "Value" ngay khi tạo.
[ ] Thêm delegated permissions: Mail.Read, offline_access, User.Read.
[ ] Xác nhận KHÔNG có permission ngoài scope (mục 3).
[ ] Publisher verification: theo dõi, non-blocker trừ khi consent thực tế bị chặn.
```

### 6.2. Trên Railway (secret manager / Variables)

```text
[ ] Xác định staging domain (.railway.app) từ service web (TASK-049).
[ ] MICROSOFT_CLIENT_ID = client ID của App Registration staging.
[ ] MICROSOFT_CLIENT_SECRET = secret Value staging (chỉ trong Railway, không nơi khác).
[ ] MICROSOFT_TENANT_ID = phù hợp account type (vd "common").
[ ] MICROSOFT_REDIRECT_URI khớp tuyệt đối Redirect URI trong App Registration.
[ ] MICROSOFT_GRAPH_NOTIFICATION_URL = public HTTPS webhook staging.
[ ] MICROSOFT_GRAPH_LIFECYCLE_NOTIFICATION_URL = để trống nếu chưa có endpoint lifecycle.
[ ] DATABASE_URL / REDIS_URL trỏ staging (không production).
[ ] ENCRYPTION_KEY tạo mới cho staging.
[ ] Telegram TEST bot + TEST chat; không dùng của khách hàng thật.
```

---

## 7. Ranh giới với TASK-051 (không vượt scope)

```text
TASK-050 (task này)          -> xác minh CẤU HÌNH App Registration staging (docs/checklist).
TASK-051 (KHÔNG làm ở đây)   -> live mailbox E2E: connect mailbox thật, nhận code,
                                webhook + delta dedupe live, gửi Telegram test group.
```

TASK-050 **không** connect mailbox, **không** gửi email test, **không** kiểm tra dedupe
live, **không** chạy `npm run test:e2e` với mailbox thật.

---

## 8. Những việc tôi KHÔNG làm

- Không đọc/in `.env`, `.env.local`, `.env.staging`, `.env.production`.
- Không ghi secret thật / token thật / connection string thật / encryption key thật /
  session secret thật / bot token thật / verification code / email body vào docs/log/chat.
- Không deploy production; không dùng database/Redis production.
- Không dùng mailbox khách hàng thật; không dùng Telegram group khách hàng thật.
- Không chạy live mailbox E2E (thuộc TASK-051); không mở rộng sang TASK-051.
- Không tạo migration; không sửa `prisma/schema.prisma`.
- Không sửa runtime OAuth/Graph code, worker/queue code, Telegram routing code.
- Không sửa GitHub Actions workflow / không nới lỏng secret scan.
- Không sửa `MICROSOFT_SETUP.md` / `STAGING_DEPLOYMENT.md` (đã đủ checklist staging).

---

## 9. Phần cần Gemini review kỹ

```text
[ ] Task file + report đúng scope TASK-050 (validation-only).
[ ] Không mở rộng / không chạy TASK-051 live mailbox E2E.
[ ] Redirect URI staging placeholder đúng dạng .../api/microsoft/oauth/callback.
[ ] Webhook URL staging placeholder đúng dạng .../api/webhooks/microsoft/mail.
[ ] Permission Microsoft tối thiểu đúng: Mail.Read, offline_access, User.Read.
[ ] Không thêm Mail.Send / Mail.ReadWrite / permission ngoài scope.
[ ] App Registration staging tách biệt local/prod; secret không tái dùng.
[ ] Không có secret thật / không có .env* / không có URL DB-Redis production trong diff.
[ ] Không có wording dễ gây secret-scan false positive (không có KEY=value).
[ ] Không sửa runtime code; không tạo migration; không sửa GitHub Actions.
[ ] npm run verify PASS.
[ ] Kết luận PASS/FAIL theo GEMINI.md.
```
