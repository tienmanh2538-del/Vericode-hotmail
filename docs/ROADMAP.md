\# ROADMAP.md



\## Sprint 0 — Foundation \& quality gates



\- TASK-001: Khởi tạo project foundation

\- TASK-002: Setup lint/typecheck/test/build/verify

\- TASK-003: Setup environment config \& secret safety

\- TASK-004: Setup database ORM \& initial schema



\## Sprint 1 — Admin shell \& access control



\- TASK-005: Tạo admin layout cơ bản

\- TASK-006: Tạo authentication/admin role skeleton

\- TASK-007: Tạo customer management tối giản



\## Sprint 2 — Telegram validation



\- TASK-008: Setup Telegram bot config \& test-send service

\- TASK-009: Tạo Telegram mapping module



\## Sprint 3 — Parser \& mock flow



\- TASK-010: Tạo mock email input

\- TASK-011: Tạo Facebook/Meta verification detector

\- TASK-012: Tạo code extractor module

\- TASK-013: Tạo processed message \& deduplication service

\- TASK-014: Kết nối mock flow: mock email → detect → extract → dedupe → Telegram



\## Sprint 4 — Logs \& audit



\- TASK-015: Tạo code event log page

\- TASK-016: Tạo audit log service \& page



\## Sprint 5 — Microsoft OAuth validation



\- TASK-017: Tạo Microsoft App Registration checklist \& config

\- TASK-018: Tạo Microsoft OAuth connect URL

\- TASK-019: Tạo Microsoft OAuth callback

\- TASK-020: Tạo token encryption service

\- TASK-021: Lưu mailbox sau OAuth connect

\- TASK-022: Tạo Microsoft Graph mail service: read Inbox test



\## Sprint 6 — Microsoft webhook \& worker



\- TASK-023: Tạo Graph subscription service

\- TASK-024: Tạo Microsoft webhook verification endpoint

\- TASK-025: Tạo webhook receiver cho notification thật

\- TASK-026: Setup queue \& worker foundation

\- TASK-027: Worker xử lý Graph message → detector → extractor → Telegram



\## Sprint 7 — Mailbox dashboard



\- TASK-028: Tạo mailbox list page

\- TASK-029: Tạo mailbox detail page

\- TASK-030: Tạo connect mailbox UI ( (Đã làm sớm một phần ở TASK-026 để test luồng: Nút Connect & Banner lỗi
     tại Admin Dashboard). Khi tới Sprint 7 chỉ cần review và tinh chỉnh nếu cần.)



\## Sprint 8 — Reliability



\- TASK-031: Tạo delta polling backup worker

\- TASK-032: Tạo subscription renewal worker

\- TASK-033: Tạo Telegram retry \& failure handling

\- TASK-034: Tạo health dashboard
  - Note from TASK-031: verify production email-worker is wired to a real pipeline (createEmailWorker hiện default chỉ là type-only cast, không thực sự chạy production) và surface trạng thái qua dashboard / operational check.

\- TASK-035: Tạo alert service



\## Sprint 9 — Security \& staging readiness



\- TASK-036: Security hardening review
lưu ý:   - Tối ưu hóa Delta Polling: Hỗ trợ bootstrap mailbox cực lớn (dùng $filter thời gian hoặc tăng max pages cho
      lần chạy đầu).
    5   - Sửa lỗi Token Rotation: Đảm bảo service cấp mới Access Token (ví dụ `refresh-access-token.service.ts`) có
      lưu lại Refresh Token mới xuống database nếu Microsoft trả về (hiện tại có rủi ro mất token nếu bị cấp mới).

\- TASK-037: E2E test cho mock flow

\- TASK-038: E2E test cho Microsoft test mailbox
  - Note from TASK-031: cover trường hợp webhook + delta polling cùng thấy 1 graphMessageId — Telegram phải nhận đúng 1 lần (dựa vào ProcessedMessage unique [mailboxId, graphMessageId]).

\- TASK-039: Staging deployment setup
\- TASK-040 Preflight: Operational Readiness Before MVP Acceptance Review

\- TASK-040: MVP acceptance review
\- TASK-041-flexible-telegram-routing.md

## Nguyên tắc bắt buộc cho toàn bộ lộ trình internal production (Sprint 10 → 15)

Các nguyên tắc sau áp dụng cho **mọi** task từ TASK-042 đến TASK-061:

1. **Mỗi mailbox chỉ có một active Telegram group/topic destination.** Khi gửi verification
   code, mailbox resolve đúng **một** destination active của chính nó.
2. **KHÔNG làm 1 mailbox → nhiều Telegram destination.** Hướng này nằm ngoài scope toàn bộ
   lộ trình. (TASK-041 cho phép NHIỀU mailbox → CÙNG một group/topic một cách có chủ đích,
   nhưng một mailbox vẫn chỉ có một destination.)
3. **Microsoft publisher verification KHÔNG phải blocker hiện tại.** Chỉ theo dõi; chỉ xử lý
   nếu/khi consent thực tế bị chặn (ví dụ tenant yêu cầu admin consent, hoặc `AADSTS65001` /
   consent required). Tham chiếu `docs/MICROSOFT_SETUP.md`.

## Sprint 10 — Internal production readiness

- TASK-042: Internal production readiness plan
- TASK-043: Prisma Client generation hardening
- TASK-044: Confirm one-mailbox-one-destination routing rule

## Sprint 11 — Staff operation model

- TASK-045: Internal staff ownership & assignment model
- TASK-046: Staff dashboard UX for high mailbox volume
- TASK-047: Safe mailbox onboarding flow

## Sprint 12 — Staging deployment

- TASK-048: Choose deployment platform & staging architecture
- TASK-049: Staging infrastructure setup
- TASK-050: Microsoft App Registration staging validation
- TASK-051: Staging live mailbox E2E test

## Sprint 13 — Scale readiness

- TASK-052: Scale test plan for 100–200 mailboxes per staff
- TASK-053: Per-mailbox throttling & queue safety
- TASK-054: Operational health dashboard for staff workload

## Sprint 14 — Production security & internal launch

- TASK-055: Production auth hardening for internal staff
- TASK-056: Production environment & secret setup
- TASK-057: Production deployment limited internal beta
- TASK-058: Backup, restore & incident response

## Sprint 15 — Internal operations

- TASK-059: Staff onboarding guide
- TASK-060: Daily operations checklist
- TASK-061: Production scale-up from beta to full internal use