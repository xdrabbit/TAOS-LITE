// Fences in the "Load failed" hardening: which failures fetchWithRetry
// retries, which it surfaces, and how connection errors are classified.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithRetry, isConnectionError } from "@/lib/net";

function res(status: number): Response {
  return new Response(null, { status: status === 204 ? 204 : status });
}

describe("fetchWithRetry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("retries a network-layer failure (Safari's 'Load failed') and succeeds", async () => {
    const mock = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Load failed"))
      .mockResolvedValueOnce(res(200));
    vi.stubGlobal("fetch", mock);

    const promise = fetchWithRetry("/api/x", { method: "POST" }, { retries: 2 });
    await vi.advanceTimersByTimeAsync(5000);
    const r = await promise;

    expect(r.status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("retries gateway errors (502/503/504)", async () => {
    const mock = vi.fn().mockResolvedValueOnce(res(502)).mockResolvedValueOnce(res(200));
    vi.stubGlobal("fetch", mock);

    const promise = fetchWithRetry("/api/x", {}, { retries: 2 });
    await vi.advanceTimersByTimeAsync(5000);
    const r = await promise;

    expect(r.status).toBe(200);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry ordinary client/server errors like 400", async () => {
    const mock = vi.fn().mockResolvedValue(res(400));
    vi.stubGlobal("fetch", mock);

    const r = await fetchWithRetry("/api/x", {}, { retries: 2 });

    expect(r.status).toBe(400);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry budget and rethrows the connection error", async () => {
    const mock = vi.fn().mockRejectedValue(new TypeError("Load failed"));
    vi.stubGlobal("fetch", mock);

    const promise = fetchWithRetry("/api/x", {}, { retries: 1 });
    const outcome = promise.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(5000);
    const err = await outcome;

    expect(err).toBeInstanceOf(TypeError);
    expect(mock).toHaveBeenCalledTimes(2); // first try + 1 retry
  });
});

describe("isConnectionError", () => {
  it("classifies network failures and timeouts as connection errors", () => {
    expect(isConnectionError(new TypeError("Load failed"))).toBe(true);
    expect(isConnectionError(new DOMException("timed out", "TimeoutError"))).toBe(true);
    expect(isConnectionError(new DOMException("aborted", "AbortError"))).toBe(true);
  });

  it("does not classify ordinary errors as connection errors", () => {
    expect(isConnectionError(new Error("Translation failed."))).toBe(false);
    expect(isConnectionError("Load failed")).toBe(false);
  });
});
