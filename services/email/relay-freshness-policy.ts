// TASK-089 (HD-3) — shared relay-freshness policy.
//
// Single source of truth for "how old may a verification email be and still be
// relayed to Telegram". The value was introduced by TASK-080 (stale-message
// relay protection) and originally lived as a private constant inside
// `graph-message-pipeline.service.ts`. TASK-089's delta 410 sync-state
// recovery needs the SAME window to bound its Graph recovery enumeration
// (anything older would be terminally skipped by the pipeline's stale guard
// anyway), so the constants moved to this LEAF module:
//
//   graph-message-pipeline.service.ts  → imports the threshold (stale guard)
//   delta-polling.service.ts           → imports the threshold (recovery lookback)
//
// This module must stay a pure leaf: constants only — no I/O, no side effects,
// no env reads, no imports of higher-level runtime services. Do NOT duplicate
// these values anywhere else.
//
// Intentionally NOT env-tunable (locked decision from TASK-080).

export const MAX_RELAY_MESSAGE_AGE_MINUTES = 30;
export const MAX_RELAY_MESSAGE_AGE_MS = MAX_RELAY_MESSAGE_AGE_MINUTES * 60 * 1000;
