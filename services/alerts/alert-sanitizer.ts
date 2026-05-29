// TASK-035 — Alert sanitizer.
//
// The single chokepoint that guarantees an alert (its title + context) carries
// NO secret material before it is formatted into a Telegram message or written
// to a log. It deliberately reuses the existing, already-tested primitives so
// the masking rules never drift from the rest of the app:
//
//   - `sanitize` (lib/logger): structured object scrub — masks values under
//     sensitive keys (token/secret/password/code/...) and truncates email
//     bodies; recurses into nested objects/arrays.
//   - `redactSensitiveText` (lib/security/redact): free-text scrub — redacts
//     `key=value` secret pairs and any long token-shaped run.
//
// Everything an alert emits passes through here, so callers may include
// operational context (mailboxId, attempts, failureReason, ...) freely.

import { sanitize } from '@/lib/logger';
import { redactSensitiveText } from '@/lib/security/redact';

/**
 * Body-shaped keys are dropped entirely (not previewed) before sanitizing.
 * Alerts are operational summaries — the admin never needs the raw email body,
 * and a body preview could carry a short verification code that is impossible
 * to distinguish from a chat id / counter by shape alone. Omitting it removes
 * that leak vector outright.
 */
const OMITTED_BODY_KEYS = new Set([
  'body',
  'emailbody',
  'rawbody',
  'html',
  'emailhtml',
]);

const OMITTED_PLACEHOLDER = '[omitted]';

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[_\-]/g, '');
}

/** Scrub a free-text string (alert title or a final whole-message backstop). */
export function sanitizeAlertText(text: string): string {
  return redactSensitiveText(String(text ?? ''));
}

/**
 * Scrub a structured context object. Returns a new object (immutable) whose
 * sensitive values are masked/redacted and whose body-shaped fields are
 * omitted. Non-object input collapses to `{}` so the formatter always has a
 * safe map to iterate.
 */
export function sanitizeAlertContext(
  context: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (!context) return {};

  // Drop body-shaped fields before delegating, so they are never previewed.
  const prepared: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    prepared[key] = OMITTED_BODY_KEYS.has(normalizeKey(key))
      ? OMITTED_PLACEHOLDER
      : value;
  }

  const scrubbed = sanitize(prepared);
  if (scrubbed && typeof scrubbed === 'object' && !Array.isArray(scrubbed)) {
    return scrubbed as Record<string, unknown>;
  }
  return {};
}
