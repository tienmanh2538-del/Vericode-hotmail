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

\- TASK-030: Tạo connect mailbox UI



\## Sprint 8 — Reliability



\- TASK-031: Tạo delta polling backup worker

\- TASK-032: Tạo subscription renewal worker

\- TASK-033: Tạo Telegram retry \& failure handling

\- TASK-034: Tạo health dashboard

\- TASK-035: Tạo alert service



\## Sprint 9 — Security \& staging readiness



\- TASK-036: Security hardening review

\- TASK-037: E2E test cho mock flow

\- TASK-038: E2E test cho Microsoft test mailbox

\- TASK-039: Staging deployment setup

\- TASK-040: MVP acceptance review

