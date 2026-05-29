
# TASK-026: Setup queue & worker foundation

## 1. Mục tiêu

Thiết lập nền móng queue và worker cho luồng xử lý Microsoft webhook notification.

Sau TASK-025, webhook receiver đã có thể nhận POST body dạng `{ value: [...] }`, validate `clientState`, và không xử lý nặng trong request webhook.

TASK-026 sẽ tạo lớp queue/worker để webhook có thể đẩy notification đã validate vào hàng đợi. Worker foundation được tạo ở mức nền móng, nhưng chưa xử lý email thật.

TASK-027 mới được phép triển khai pipeline thật:

```text
Graph message → Facebook detector → code extractor → dedupe → Telegram
````

---

## 2. Bối cảnh dự án

Dự án Verification Code Relay Tool cần xử lý email verification từ Hotmail/Outlook qua Microsoft Graph.

Nguyên tắc kiến trúc bắt buộc:

```text
Webhook nhận event nhanh
→ validate payload/clientState
→ push job vào queue
→ trả 2xx nhanh
→ worker xử lý nặng ở background
```

Không được xử lý nặng trực tiếp trong webhook endpoint.

---

## 3. Yêu cầu chính

### 3.1. Queue technology

Ưu tiên dùng:

```text
BullMQ + Redis
```

Lý do:

* Project dùng TypeScript/Node.js/Next.js.
* Roadmap định hướng queue thật bằng BullMQ + Redis.
* Queue cần support worker background, retry, backoff, dedupe jobId.

Nếu project đã có sẵn queue library khác, Claude phải báo trước và không tự đổi stack lớn nếu chưa được duyệt.

---

### 3.2. Environment variables

Cập nhật `.env.example` nếu chưa có:

```env
# Queue / Redis
REDIS_URL=redis://127.0.0.1:6379
EMAIL_QUEUE_NAME=email-processing
EMAIL_WORKER_CONCURRENCY=2
```

Yêu cầu quan trọng:

* Không đưa secret thật vào `.env.example`.
* Không đọc/in nội dung `.env.local`.
* Không làm build fail chỉ vì Redis chưa chạy.
* Không tự kết nối Redis ngay khi import module nếu không cần thiết.

---

### 3.3. Job type bắt buộc

Tạo type cho job xử lý Microsoft Graph message notification.

Tên gợi ý:

```ts
EmailWebhookJobData
EmailQueueJobName
```

Payload tối thiểu:

```ts
type EmailWebhookJobData = {
  mailboxId: string;
  graphMessageId: string;
  subscriptionId?: string;
  resource?: string;
  changeType?: string;
  tenantId?: string;
  clientStateValidated: true;
  queuedAt: string;
  source: "microsoft-webhook";
};
```

Không được đưa vào job payload:

```text
accessToken
refreshToken
clientSecret
telegramBotToken
full email body
full verification code
password
```

---

### 3.4. Job name

Tạo job name rõ ràng, ví dụ:

```ts
PROCESS_MICROSOFT_GRAPH_MESSAGE
```

Không dùng tên mơ hồ như:

```text
job
process
task
email
```

---

### 3.5. Queue name

Queue mặc định:

```text
email-processing
```

Queue name có thể đọc từ env:

```text
EMAIL_QUEUE_NAME
```

Nếu env chưa có, fallback an toàn sang:

```text
email-processing
```

---

### 3.6. Dedupe bằng jobId

Khi enqueue notification, phải tạo `jobId` ổn định để tránh notification trùng tạo nhiều job giống nhau.

Gợi ý:

```text
mailboxId:graphMessageId
```

Hoặc nếu cần an toàn hơn:

```text
microsoft-webhook:mailboxId:graphMessageId
```

Không dùng random UUID làm jobId cho cùng một email, vì như vậy không chống trùng queue-level.

---

### 3.7. Job options

Job options mặc định nên có:

```ts
{
  attempts: 3,
  backoff: {
    type: "exponential",
    delay: 5000
  },
  removeOnComplete: {
    age: 86400,
    count: 1000
  },
  removeOnFail: {
    age: 604800,
    count: 5000
  }
}
```

Giải thích:

* `attempts: 3`: thử lại tối đa 3 lần nếu lỗi.
* `backoff`: chờ lâu hơn sau mỗi lần fail.
* `removeOnComplete`: không giữ job thành công quá lâu.
* `removeOnFail`: giữ job lỗi một thời gian để debug, nhưng không giữ vĩnh viễn.

---

## 4. File/thư mục dự kiến tạo hoặc sửa

Claude phải đọc cấu trúc thực tế trước. Nếu project dùng `src/`, đặt file dưới `src/`. Nếu không dùng `src/`, dùng cấu trúc root hiện tại.

Dự kiến tạo/sửa:

```text
services/queue/
  redis-connection.ts
  email-job.types.ts
  email-job-options.ts
  email-queue.ts
  workers/
    email-worker.ts

tests/unit/queue/
  email-job-options.test.ts
  email-queue.test.ts
  email-job.types.test.ts

.env.example
package.json
```

Có thể sửa thêm file webhook từ TASK-025 nếu cần nối enqueue:

```text
app/api/webhooks/microsoft/mail/route.ts
```

hoặc vị trí route thực tế đang dùng trong project.

---

## 5. Yêu cầu implementation chi tiết

### 5.1. `services/queue/redis-connection.ts`

Tạo helper tạo Redis connection cho BullMQ.

Yêu cầu:

* Không connect Redis ngay khi import file.
* Chỉ tạo connection khi queue/worker được gọi.
* Đọc `REDIS_URL` từ env hoặc fallback local.
* Không log URL nếu URL có password.
* Nếu có logger thì logger phải redact secret.

---

### 5.2. `services/queue/email-job.types.ts`

Tạo type rõ ràng:

```ts
export const EMAIL_QUEUE_NAME = "email-processing";

export const EMAIL_QUEUE_JOB_NAMES = {
  PROCESS_MICROSOFT_GRAPH_MESSAGE: "PROCESS_MICROSOFT_GRAPH_MESSAGE",
} as const;

export type EmailQueueJobName =
  typeof EMAIL_QUEUE_JOB_NAMES[keyof typeof EMAIL_QUEUE_JOB_NAMES];

export type EmailWebhookJobData = {
  mailboxId: string;
  graphMessageId: string;
  subscriptionId?: string;
  resource?: string;
  changeType?: string;
  tenantId?: string;
  clientStateValidated: true;
  queuedAt: string;
  source: "microsoft-webhook";
};
```

Có thể điều chỉnh syntax theo style codebase, nhưng phải giữ tinh thần trên.

---

### 5.3. `services/queue/email-job-options.ts`

Tạo hàm pure function:

```ts
export function buildEmailJobId(data: EmailWebhookJobData): string
export function getDefaultEmailJobOptions(data: EmailWebhookJobData): JobsOptions
```

Yêu cầu:

* `buildEmailJobId` không dùng random.
* `getDefaultEmailJobOptions` dùng `jobId`.
* Có unit test cho hai hàm này.

---

### 5.4. `services/queue/email-queue.ts`

Tạo hàm:

```ts
export function getEmailQueue(): Queue<EmailWebhookJobData>
export async function enqueueMicrosoftGraphMessageJob(data: EmailWebhookJobData): Promise<...>
```

Yêu cầu:

* Validate payload tối thiểu trước khi enqueue.
* Nếu thiếu `mailboxId` hoặc `graphMessageId`, throw error rõ ràng.
* Không chứa token/secret/code/body trong payload.
* Không gọi Graph API.
* Không gửi Telegram.
* Không gọi detector/extractor.

---

### 5.5. `services/queue/workers/email-worker.ts`

Tạo worker foundation.

Yêu cầu:

* Có hàm tạo worker, ví dụ:

```ts
export function createEmailWorker()
```

* Worker nhận job `PROCESS_MICROSOFT_GRAPH_MESSAGE`.
* Trong TASK-026, worker chỉ log metadata an toàn hoặc gọi placeholder.
* Không fetch email thật.
* Không gửi Telegram.
* Không gọi detector/extractor.
* Không log full payload nếu payload có dữ liệu nhạy cảm.
* Không tự động start worker khi import file.
* Nếu có script chạy worker, chỉ start khi chạy trực tiếp script đó.

Placeholder nên ghi rõ:

```text
TASK-027 will implement real email processing pipeline.
```

---

### 5.6. Tích hợp với webhook TASK-025 nếu phù hợp

Nếu route webhook TASK-025 đã tồn tại, sau khi validate `clientState` thành công, route có thể transform từng notification thành `EmailWebhookJobData` và gọi:

```ts
enqueueMicrosoftGraphMessageJob(...)
```

Yêu cầu:

* Không enqueue notification chưa validate clientState.
* Không assume mỗi request chỉ có 1 notification.
* Phải xử lý `value: [...]`.
* Nếu một notification lỗi payload, không làm lộ token/secret trong response/log.
* Response vẫn phải nhanh.
* Không gọi Graph API trong webhook route.

Nếu việc nối webhook làm phát sinh quá nhiều sửa đổi, Claude phải báo lại và chỉ tạo queue foundation, không refactor lớn.

---

## 6. Test bắt buộc

Tạo unit test cho:

```text
- buildEmailJobId tạo cùng jobId cho cùng mailboxId + graphMessageId.
- buildEmailJobId tạo jobId khác cho message khác.
- getDefaultEmailJobOptions có attempts/backoff/removeOnComplete/removeOnFail.
- validate payload fail khi thiếu mailboxId.
- validate payload fail khi thiếu graphMessageId.
- payload không được chứa field nhạy cảm như accessToken, refreshToken, telegramBotToken, verificationCode, body.
```

Không yêu cầu test phải connect Redis thật.

Ưu tiên test pure function để `npm run verify` pass ngay cả khi Redis chưa chạy.

---

## 7. Lệnh kiểm tra

Claude phải chạy:

```powershell
npm run verify
```

Nếu project có test riêng:

```powershell
npm test
```

Nếu có lint/typecheck riêng:

```powershell
npm run lint
npm run typecheck
npm run build
```

---

## 8. Tiêu chí nghiệm thu

TASK-026 chỉ được coi là hoàn thành khi:

```text
[ ] Có module services/queue hoặc src/services/queue đúng cấu trúc project.
[ ] Có type job rõ ràng cho Microsoft webhook notification.
[ ] Có function enqueue job.
[ ] Có worker foundation.
[ ] Có jobId ổn định để chống queue duplicate.
[ ] Có retry/backoff config.
[ ] Không connect Redis ngay khi import module.
[ ] Không cần Redis running để npm run verify pass.
[ ] Không fetch email từ Graph trong task này.
[ ] Không gọi detector/extractor trong task này.
[ ] Không gửi Telegram trong task này.
[ ] Không log token/secret/full code/full email body.
[ ] Nếu webhook được nối queue, chỉ enqueue sau khi clientState đã validate.
[ ] Webhook vẫn không xử lý nặng trực tiếp.
[ ] Unit test pass.
[ ] npm run verify pass.
```

---

## 9. Không được làm trong TASK-026

Claude không được:

```text
- Không tạo pipeline xử lý email thật.
- Không gọi Microsoft Graph để fetch message detail.
- Không gọi Facebook detector.
- Không gọi code extractor.
- Không gọi Telegram sender.
- Không tạo delta polling worker.
- Không tạo subscription renewal worker.
- Không tạo health dashboard.
- Không thêm UI mới.
- Không đổi schema database nếu task không bắt buộc.
- Không refactor lớn webhook/OAuth/mailbox code.
- Không hardcode Redis password, Telegram token, Microsoft secret.
- Không đọc hoặc in nội dung .env.local.
```

---

## 10. Báo cáo cuối task Claude phải trả về

Claude phải báo cáo theo format:

```text
1. Đã làm gì
2. File nào thay đổi
3. Dependency nào đã thêm
4. Lệnh nào đã chạy
5. Kết quả PASS/FAIL
6. Những gì cố ý chưa làm vì thuộc TASK-027+
7. Rủi ro còn lại
8. Đề xuất bước kiểm tra Gemini
```

````

---

