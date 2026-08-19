// TASK-080 — Finite-timeout wrapper around fetch using AbortController.
//
// Motivation (from TASK-079): the delta polling scheduler wedged because a
// Microsoft HTTP request (Graph delta or the token endpoint) never settled, so
// `runDeltaPollingOnce` never resolved and the scheduler's non-overlap guard
// skipped every subsequent tick forever. Native `fetch` has no timeout, so a
// hung TCP connection keeps the promise pending indefinitely.
//
// This helper enforces a finite ceiling with a REAL cancellation: on timeout it
// calls `controller.abort()`, which tears down the underlying request (the
// socket), so the operation genuinely settles/rejects — it is NOT left running
// in the background while a `Promise.race` frees the caller. That distinction is
// the whole point: the caller can safely release its in-flight guard because the
// request has actually been cancelled.
//
// When no positive `timeoutMs` is given the call is a pass-through to the
// provided fetch (identical behaviour to today), so existing callers that do not
// opt in are unaffected.

/**
 * Thrown when a `fetchWithTimeout` call exceeds its timeout and the request is
 * aborted. Callers map this onto their own transient/network error type — a
 * timeout is a transient failure, never an auth/permission (401/403) signal.
 */
export class HttpTimeoutError extends Error {
  readonly timeoutMs: number;
  constructor(timeoutMs: number) {
    super('HTTP_REQUEST_TIMEOUT');
    this.name = 'HttpTimeoutError';
    this.timeoutMs = timeoutMs;
  }
}

export interface FetchWithTimeoutOptions {
  /**
   * Finite timeout in milliseconds. When omitted / non-finite / <= 0 the call is
   * a plain pass-through to `fetchImpl` (no AbortController, unchanged behaviour).
   */
  timeoutMs?: number;
}

function isPositiveFinite(value: number | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * Call `fetchImpl(url, init)` but abort it after `timeoutMs`. On timeout the
 * underlying request is truly aborted and this rejects with {@link HttpTimeoutError}.
 * Any other rejection from `fetchImpl` is re-thrown unchanged. The timer is always
 * cleared, so a fast success never leaves a dangling timer.
 */
export async function fetchWithTimeout(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  options: FetchWithTimeoutOptions = {},
): Promise<Response> {
  const { timeoutMs } = options;
  if (!isPositiveFinite(timeoutMs)) {
    // No finite ceiling requested — behave exactly like a direct fetch call.
    return fetchImpl(url, init);
  }

  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    // Distinguish "we aborted due to timeout" from any other fetch rejection so
    // the caller can classify a timeout as transient rather than a real error.
    if (timedOut) {
      throw new HttpTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}
