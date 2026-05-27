# TASK-003: Setup environment config & secret safety

## Mục tiêu

Thiết lập nền bảo mật/config cho project trước khi làm Microsoft OAuth, Telegram, database thật hoặc xử lý verification code thật.

Sau task này, project phải có:

1. `.env.example`
2. Env validation an toàn
3. Secret masking utility
4. Verification code masking/hash utility
5. Safe logger không log token/code/password
6. Test cho các utility bảo mật
7. Tài liệu `docs/SECURITY_RULES.md`

## Yêu cầu chức năng

### 1. `.env.example`

Tạo hoặc cập nhật `.env.example` với các biến placeholder, không có giá trị thật:

```env
APP_ENV=development
APP_URL=http://localhost:3000

DATABASE_URL=postgresql://USER:PASSWORD@HOST:PORT/DATABASE

MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TENANT_ID=common
MICROSOFT_REDIRECT_URI=http://localhost:3000/api/microsoft/oauth/callback

TELEGRAM_BOT_TOKEN=
TELEGRAM_ADMIN_ALERT_CHAT_ID=

ENCRYPTION_KEY=
LOG_LEVEL=info

###2. Env validation

Tạo module env validation.

Yêu cầu:

Dùng TypeScript.
Có thể dùng Zod nếu phù hợp.
Không validate env theo kiểu làm npm run build fail ngay khi chưa có secret thật.
Chỉ validate biến bắt buộc khi module tương ứng thực sự cần dùng.
Có helper báo lỗi rõ ràng nếu thiếu biến môi trường.
Không in giá trị secret ra lỗi/log.

Gợi ý file:
src/lib/env.ts
src/lib/env.schema.ts
Nếu project không có src/, dùng:
lib/env.ts
lib/env.schema.ts

###3 Secret masking utility
Tạo utility để che dữ liệu nhạy cảm.

Gợi ý file:

src/lib/security/redact.ts

Yêu cầu có các hàm tương đương:

maskSecret(value: string): string
maskVerificationCode(code: string): string
hashSensitiveValue(value: string): string
redactSensitiveText(text: string): string

Yêu cầu:

Token/API key/password không được hiện full.
Verification code không được hiện full.
Hash dùng cho chống trùng, không dùng để khôi phục lại code.
Không tự tạo encryption service ở task này. Encryption service sẽ làm ở task sau.

###4. Safe logger
Tạo logger wrapper an toàn.

Gợi ý file:

src/lib/logger.ts

Yêu cầu:

Khi log object hoặc text, phải redact các field nhạy cảm như:
token
accessToken
refreshToken
password
secret
clientSecret
code
verificationCode
telegramBotToken
Không log full email body.
Không log full verification code.
Không log Microsoft/Telegram token.

###5. Test
Tạo test cho:

maskSecret()
maskVerificationCode()
hashSensitiveValue()
redactSensitiveText()
safe logger không để lộ secret
env helper không in giá trị secret trong error

###6. Tài liệu bảo mật
Tạo/cập nhật:

docs/SECURITY_RULES.md

Nội dung cần có:

Không hardcode secret/token/password.
Không commit .env.
Không log token.
Không log full verification code.
Không lưu full code lâu dài.
Chỉ dùng .env.example cho placeholder.
Refresh token sau này phải được encrypt trước khi lưu DB.
Telegram bot token chỉ nằm trong env/secret manager.
Khi nghi ngờ log có secret, phải xoá/rotate secret.

####Tiêu chí nghiệm thu

Task được coi là PASS khi:

.env.example tồn tại và không chứa secret thật.
.env vẫn nằm trong .gitignore.
Có utility mask/redact/hash.
Có safe logger.
Có test cho security utility.
npm run lint PASS.
npm run typecheck PASS.
npm run test PASS.
npm run build PASS.
npm run verify PASS.
Gemini review PASS.

### Không được làm
Không làm Microsoft OAuth.
Không làm Telegram sender thật.
Không làm database schema.
Không làm login.
Không tạo .env có secret thật.
Không in nội dung .env.
Không hardcode token/API key/password.
Không sửa scope ngoài TASK-003.


