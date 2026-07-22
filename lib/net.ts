// Shared fetch hardening for the API calls the phones make over flaky
// cellular. Safari reports ANY network-layer fetch failure as the opaque
// "Load failed" (Chrome: "Failed to fetch") — the request never reached us,
// or the connection died mid-flight. Those are worth an automatic retry
// before the person sees an error, and when they DO see one it should say
// "connection problem", not "Load failed".

const RETRYABLE_STATUS = new Set([502, 503, 504]);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Network-layer failure or timeout — the request didn't complete at all. */
export function isConnectionError(e: unknown): boolean {
  return (
    e instanceof TypeError ||
    (e instanceof DOMException && (e.name === "TimeoutError" || e.name === "AbortError"))
  );
}

export interface FetchRetryOptions {
  /** Extra attempts after the first (default 2). */
  retries?: number;
  /** Per-attempt timeout; omitted = browser default. */
  timeoutMs?: number;
}

// Retries connection failures, timeouts, and gateway errors (502/503/504)
// with a short backoff. Bodies passed as FormData/Blob/string re-serialize
// cleanly on each attempt, so callers can hand the same init object over.
export async function fetchWithRetry(
  input: string,
  init: RequestInit,
  opts: FetchRetryOptions = {}
): Promise<Response> {
  const { retries = 2, timeoutMs } = opts;
  for (let attempt = 0; ; attempt += 1) {
    const canTimeout =
      typeof timeoutMs === "number" &&
      typeof AbortSignal !== "undefined" &&
      typeof AbortSignal.timeout === "function";
    try {
      const res = await fetch(
        input,
        canTimeout ? { ...init, signal: AbortSignal.timeout(timeoutMs) } : init
      );
      if (!RETRYABLE_STATUS.has(res.status) || attempt >= retries) return res;
    } catch (e) {
      if (!isConnectionError(e) || attempt >= retries) throw e;
    }
    await delay(800 * (attempt + 1));
  }
}
