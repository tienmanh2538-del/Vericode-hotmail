// TASK-035 — Alert message formatter.
//
// Turns a structured Alert into a single plain-text Telegram message. Plain
// text (no HTML/MarkdownV2 parse mode) is intentional: it removes any markup
// injection surface from sanitized-but-attacker-influenced fields, and Telegram
// renders it fine.
//
// Safety layering:
//   1. title    → sanitizeAlertText
//   2. context  → sanitizeAlertContext (per-key masking)
//   3. whole    → sanitizeAlertText backstop over the assembled message
//   4. length   → capped at TELEGRAM_TEXT_MAX so the send never 400s on length

import { TELEGRAM_TEXT_MAX } from '@/services/telegram/telegram-sender.service';
import type { Alert, AlertSeverity } from './alert.types';
import { sanitizeAlertContext, sanitizeAlertText } from './alert-sanitizer';

const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  INFO: 'ℹ️ INFO',
  WARNING: '⚠️ WARNING',
  CRITICAL: '🚨 CRITICAL',
};

/** Cap on rendered context rows so a huge context can't blow the message up. */
const MAX_CONTEXT_LINES = 20;
/** Per-value truncation so one giant field can't dominate the message. */
const MAX_VALUE_LENGTH = 200;

function formatValue(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return '[unserializable]';
    }
  }
  const str = String(value);
  return str.length > MAX_VALUE_LENGTH
    ? `${str.slice(0, MAX_VALUE_LENGTH - 1)}…`
    : str;
}

/**
 * Render an alert as a safe, bounded plain-text Telegram message.
 * Pure and side-effect free, so it is trivially unit-testable.
 */
export function formatAlertMessage(alert: Alert): string {
  const severityLabel = SEVERITY_LABEL[alert.severity] ?? alert.severity;
  const header = `${severityLabel} — ${sanitizeAlertText(alert.title)}`;
  const typeLine = `type: ${alert.type}`;

  const safeContext = sanitizeAlertContext(alert.context);
  const contextLines = Object.entries(safeContext)
    .slice(0, MAX_CONTEXT_LINES)
    .map(([key, value]) => `${key}: ${formatValue(value)}`);

  const assembled = [header, typeLine, ...contextLines].join('\n');

  // Final backstop: scrub any secret-shaped text that slipped through, then cap.
  const safe = sanitizeAlertText(assembled);
  return safe.length > TELEGRAM_TEXT_MAX ? safe.slice(0, TELEGRAM_TEXT_MAX) : safe;
}
