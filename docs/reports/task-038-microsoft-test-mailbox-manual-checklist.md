# TASK-038 — Manual staging checklist: Microsoft test mailbox

> This checklist covers the **real** Microsoft mailbox verification that cannot
> run in CI because it needs live secrets in `.env.local` (Microsoft OAuth app,
> a real mailbox, a real Telegram group). The automated E2E coverage lives in
> `tests/e2e/microsoft-test-mailbox.spec.ts` and runs in CI with everything
> mocked — see that file for the webhook + delta-polling duplicate case.
>
> **Security (docs/SECURITY_RULES.md):** do NOT paste tokens, client secrets,
> real mailbox addresses, real chat ids, full email bodies, or full
> verification codes into this file, into chat AI, or into commit messages.
> When recording a run, mask codes (`73****`) and use placeholders for ids.

## 0. Preconditions

- [ ] `.env.local` is populated with real Microsoft + Telegram values and is
      gitignored (never committed). See `docs/MICROSOFT_SETUP.md` §6.
- [ ] A dedicated **test** mailbox is connected (not a customer's production
      mailbox).
- [ ] A dedicated **test** Telegram group is mapped to that mailbox (not a real
      customer group) — Telegram customer isolation rule (SECURITY_RULES §5).
- [ ] Redis is reachable for the queue/worker, or you are running the pipeline
      via the single-shot worker scripts.

## 1. Webhook (primary) path

1. [ ] Ensure a Graph subscription exists and is `ACTIVE` for the test mailbox.
2. [ ] Trigger a Facebook/Meta verification email into the test mailbox (use a
       real Facebook security-code flow against an account you control).
3. [ ] Confirm the webhook endpoint receives the `created` notification and the
       job is enqueued (check structured logs — they must show only
       `mailboxId` / `graphMessageId`, never tokens or code).
4. [ ] Confirm the worker processes the job and the test Telegram group receives
       **one** message containing the code.
5. [ ] Confirm a `ProcessedMessage` row exists for the mailbox with the
       expected `graphMessageId` and `status = SENT`.

## 2. Delta polling (backup) path

1. [ ] Temporarily disable / let the webhook subscription lapse (or simply send
       a second test email and let polling pick it up).
2. [ ] Run one delta polling cycle: `npm run worker:delta:once`.
3. [ ] Confirm a NEW message is enqueued and delivered to the test Telegram
       group exactly once.
4. [ ] Confirm the mailbox `microsoftDeltaCursor` advanced (a new `@odata.deltaLink`
       was saved) and `deltaLastErrorAt` is null.

## 3. Duplicate case (THE important one — TASK-031)

Goal: the same `graphMessageId` seen by BOTH webhook and delta polling must
deliver to Telegram **exactly once**.

1. [ ] Allow both the webhook subscription AND delta polling to be active for
       the test mailbox at the same time.
2. [ ] Trigger one Facebook/Meta verification email.
3. [ ] Let the webhook deliver it (Telegram receives one message).
4. [ ] Run `npm run worker:delta:once` so polling also discovers the same
       message id.
5. [ ] Confirm the test Telegram group received the code **only once** (no
       duplicate message).
6. [ ] Confirm there is exactly **one** `ProcessedMessage` row for that
       `(mailboxId, graphMessageId)` pair — the `@@unique([mailboxId, graphMessageId])`
       constraint is what guarantees this under the webhook/polling race.

## 4. Security spot-checks

- [ ] Application logs for the run contain NO full verification code (only
      masked `xx****` forms).
- [ ] Logs contain NO access token, refresh token, client secret, or Telegram
      bot token.
- [ ] No secret or full code was written to the database (codes are stored only
      as `codeHash`).
- [ ] Nothing in this checklist or any attached screenshot exposes a real
      secret, mailbox, chat id, or full code.

## 5. Result (fill in when run)

| Field | Value |
|-------|-------|
| Date (UTC) | |
| Operator | |
| Webhook path | PASS / FAIL |
| Delta polling path | PASS / FAIL |
| Duplicate → single Telegram send | PASS / FAIL |
| Security spot-checks | PASS / FAIL |
| Notes (masked only) | |
