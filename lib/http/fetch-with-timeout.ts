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
 * TASK-093 — the single internal deadline core shared by both exported
 * functions. ONE timer is armed BEFORE `run` starts and cleared only in the
 * `finally` after `run` settles, so whatever `run` awaits (headers only, or
 * headers + body consumption) sits under the same absolute deadline. On expiry
 * the controller aborts (real cancellation — the signal is handed to `run`)
 * and the rejection is normalized to {@link HttpTimeoutError}; any rejection
 * while the deadline has NOT fired is re-thrown unchanged.
 */
async function runWithDeadline<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    return await run(controller.signal);
  } catch (error) {
    // Distinguish "we aborted due to timeout" from any other rejection so the
    // caller can classify a timeout as transient rather than a real error.
    if (timedOut) {
      throw new HttpTimeoutError(timeoutMs);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Call `fetchImpl(url, init)` but abort it after `timeoutMs`. On timeout the
 * underlying request is truly aborted and this rejects with {@link HttpTimeoutError}.
 * Any other rejection from `fetchImpl` is re-thrown unchanged. The timer is always
 * cleared, so a fast success never leaves a dangling timer.
 *
 * NOTE (TASK-093): the deadline here covers the wait for response HEADERS only —
 * the timer clears when the fetch promise settles. Callers that must bound the
 * response BODY read under the same deadline opt into
 * {@link fetchAndConsumeWithTimeout} instead; this function's behaviour is
 * intentionally unchanged for every existing caller.
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
  return runWithDeadline(timeoutMs, (signal) =>
    fetchImpl(url, { ...init, signal }),
  );
}

/**
 * TASK-093 — fetch AND consume the response under ONE absolute deadline.
 *
 * The single timer starts BEFORE the fetch and is cleared only after `consume`
 * settles, so the same `timeoutMs` bounds: waiting for headers, reading the
 * whole response body, and the async parse inside `consume`. There is no
 * second/body-specific timer and no additive budget. On expiry the controller
 * aborts — the in-flight request or body stream is torn down for real (never a
 * `Promise.race` that leaves the stream running) — and the rejection is
 * normalized to {@link HttpTimeoutError}. A `consume` rejection while the
 * deadline has NOT fired (e.g. malformed JSON) is re-thrown unchanged so the
 * caller's existing classification applies.
 *
 * `consume` receives the deadline's AbortSignal so a caller that deliberately
 * swallows body-parse failures (the refresh service) can rethrow ONLY the
 * deadline-abort rejection. The signal is undefined in pass-through mode.
 *
 * Without a positive finite `timeoutMs` the call is a plain pass-through
 * (direct fetch, then `consume` with no deadline and no signal) — callers that
 * do not opt in keep today's behaviour exactly.
 */
export async function fetchAndConsumeWithTimeout<T>(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  consume: (response: Response, signal?: AbortSignal) => Promise<T>,
  options: FetchWithTimeoutOptions = {},
): Promise<T> {
  const { timeoutMs } = options;
  if (!isPositiveFinite(timeoutMs)) {
    const response = await fetchImpl(url, init);
    return consume(response, undefined);
  }
  return runWithDeadline(timeoutMs, async (signal) => {
    const response = await fetchImpl(url, { ...init, signal });
    return consume(response, signal);
  });
}
