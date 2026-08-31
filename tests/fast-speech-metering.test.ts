// The streaming mic's meter, pinned.
//
// #49 shipped /fast's live mic with two holes, and both were about a
// credential rather than about audio:
//
//   1. `useLiveDictation` minted an Azure Speech token ON MOUNT. Opening
//      /fast — not pressing anything — bought a ten-minute JWT. Roughly nine
//      minutes of recognition authority handed to somebody who came to type.
//   2. Nothing counted the streamed audio at all. The mint took one chip from
//      the 60/min TYPING bucket, and the 30-second utterance cap was a
//      `setTimeout` in a browser.
//
// The audio itself never touches this server (the phone streams straight to
// Azure — lib/fast/speechMeter.ts says why that is the deal), so what is
// pinned here is everything the server CAN see: that a page view mints
// nothing, that a mint reserves against a ledger before Azure is reached,
// that the hour's budget refuses, that a stream which ends settles for what
// it used, and that one which never ends is reaped at its full reservation.
//
// The thing NOT claimed anywhere below: that a client cannot under-report. It
// can. The bound does not rest on the report — it rests on the reservation,
// which is taken before a single byte is streamed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { AZURE_TOKEN_TTL_MS, FAST_MAX_DICTATION_MS } from "@/lib/fast/dictation";
import { FastMeterDb } from "./helpers/fastMeterDb";

const db = new FastMeterDb();

vi.mock("@/lib/supabaseAdmin", () => ({
  hasServiceRoleKey: true,
  supabaseAdmin: { rpc: (name: string, args: Record<string, unknown>) => db.rpc(name, args) }
}));

let caller: { id: string; email: string } | null = null;

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) =>
    req.headers.get("authorization")?.startsWith("Bearer ") && caller ? caller : null
}));

const AZURE_JWT = "eyJ-a-speech-token";

/** Stands in for Azure's issueToken. If it is reached on a refusal, we leaked. */
const fetchSpy = vi.fn(async () => new Response(AZURE_JWT, { status: 200 }));

const ORIGINAL_FETCH = globalThis.fetch;
const GRANT = Math.ceil(FAST_MAX_DICTATION_MS / 1000);

beforeEach(async () => {
  db.reset();
  caller = { id: "u1", email: "someone@example.com" };
  db.profiles.set("u1", { subscription_status: "trialing", tier: null });
  fetchSpy.mockClear();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  process.env.AZURE_SPEECH_KEY = "azure-key";
  process.env.AZURE_SPEECH_REGION = "eastus";
  process.env.NEXT_PUBLIC_ENABLE_FAST = "1";
  delete process.env.VERCEL_ENV;
  delete process.env.TAOS_FAST_SPEECH_SECONDS_PER_HOUR;
  const { resetFastRateLimits } = await import("@/lib/fast/rateLimit");
  resetFastRateLimits();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.AZURE_SPEECH_KEY;
  delete process.env.AZURE_SPEECH_REGION;
  delete process.env.NEXT_PUBLIC_ENABLE_FAST;
  delete process.env.TAOS_FAST_SPEECH_SECONDS_PER_HOUR;
  vi.resetModules();
});

async function mint(token = "t") {
  const { POST } = await import("@/app/api/fast/speech-token/route");
  return POST(
    new NextRequest("https://taoslite.com/api/fast/speech-token", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` }
    })
  );
}

async function settle(body: Record<string, unknown>, token = "t") {
  const { POST } = await import("@/app/api/fast/speech-settle/route");
  return POST(
    new NextRequest("https://taoslite.com/api/fast/speech-settle", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body)
    })
  );
}

// ── A page view is not a press ──────────────────────────────────────────────

describe("nothing is minted until the mic is pressed", () => {
  const hook = readFileSync(new URL("../lib/fast/useLiveDictation.ts", import.meta.url), "utf8");

  it("warms the SDK on mount and stops there", () => {
    // The mount effect must reach `preload`, which imports the recogniser and
    // asks for no credential. Reaching `ensureWarm` there is the bug: it is
    // what bought ten minutes of Azure authority per page view.
    const start = hook.indexOf("useEffect(() => {\n    if (!candidatesRef.current) return");
    expect(start).toBeGreaterThan(-1);
    const effect = hook.slice(start, hook.indexOf("}, [", start));
    expect(effect).toContain("preload()");
    expect(effect).not.toContain("ensureWarm");
  });

  it("keeps the credential out of preload entirely", () => {
    const start = hook.indexOf("const preload = useCallback");
    const end = hook.indexOf("const warm = useCallback", start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(hook.slice(start, end)).not.toContain("/api/fast/speech-token");
  });

  it("mints from the press instead", () => {
    // beginStream awaits the warm-up, and the warm-up is what fetches. This is
    // the one place a token may now come from.
    expect(hook).toContain("await ensureWarm()");
    const start = hook.indexOf("const warm = useCallback");
    const end = hook.indexOf("const ensureWarm", start);
    expect(hook.slice(start, end)).toContain("/api/fast/speech-token");
  });
});

// ── The mint reserves before it reaches Azure ───────────────────────────────

describe("POST /api/fast/speech-token reserves audio seconds", () => {
  it("opens a ledger row holding one utterance", async () => {
    const res = await mint();
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId?: string; grantedSeconds?: number };
    expect(body.sessionId).toBeTruthy();
    expect(body.grantedSeconds).toBe(GRANT);
    expect(db.speech).toHaveLength(1);
    expect(db.speech[0].granted_seconds).toBe(GRANT);
    expect(db.speech[0].settled_at).toBeNull();
    // The whole reservation is held while the session is open, which is what
    // stops several tabs minting past the budget in the same second.
    expect(db.speechSecondsHeld("u1")).toBe(GRANT);
  });

  it("refuses when the hour's audio budget is spent, without reaching Azure", async () => {
    // Two utterances' worth of budget, then a third press.
    process.env.TAOS_FAST_SPEECH_SECONDS_PER_HOUR = String(GRANT * 2);
    expect((await mint()).status).toBe(200);
    expect((await mint()).status).toBe(200);

    const res = await mint();
    expect(res.status).toBe(429);
    const body = (await res.json()) as { error?: string; budgetSeconds?: number };
    expect(body.error).toBe("speech_budget_spent");
    expect(body.budgetSeconds).toBe(GRANT * 2);
    // THE assertion: a refusal that had already asked Microsoft for a token is
    // a refusal that already opened the door.
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(db.speech).toHaveLength(2);
  });

  it("does not hold a reservation for a token Azure never issued", async () => {
    fetchSpy.mockImplementationOnce(async () => new Response("nope", { status: 401 }));
    const res = await mint();
    expect(res.status).toBe(503);
    // Reserved, then given straight back: nothing was streamed, so charging
    // for it would be billing somebody for an outage at Microsoft.
    expect(db.speech[0].settled_at).not.toBeNull();
    expect(db.speech[0].billed_seconds).toBe(0);
    expect(db.speechSecondsHeld("u1")).toBe(0);
  });

  it("does not meter a founder out of their own screen", async () => {
    process.env.TAOS_FAST_SPEECH_SECONDS_PER_HOUR = String(GRANT);
    caller = { id: "founder", email: "xdrabbit@gmail.com" };
    expect((await mint()).status).toBe(200);
    expect((await mint()).status).toBe(200);
    expect((await mint()).status).toBe(200);
    // Logged, not ledgered — the same call lib/tutor/meter.ts makes. The rows
    // exist so the Azure bill is still greppable.
    expect(db.speech).toHaveLength(3);
  });

  it("404s a stranger and mints nothing", async () => {
    delete process.env.NEXT_PUBLIC_ENABLE_FAST;
    caller = { id: "u9", email: "stranger@example.com" };
    const res = await mint();
    expect(res.status).toBe(404);
    expect(db.speech).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("401s a signed-out caller once /fast is public", async () => {
    caller = null;
    const res = await mint();
    expect(res.status).toBe(401);
    expect(db.speech).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ── The settle ─────────────────────────────────────────────────────────────

describe("POST /api/fast/speech-settle bills what was streamed", () => {
  it("bills the seconds reported, and frees the rest of the reservation", async () => {
    const { sessionId } = (await (await mint()).json()) as { sessionId: string };
    const res = await settle({ sessionId, seconds: 4, reason: "user" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ billedSeconds: 4, settled: true });
    expect(db.speechSecondsHeld("u1")).toBe(4); // not the whole 30
  });

  it("caps a client that claims more than it reserved", async () => {
    const { sessionId } = (await (await mint()).json()) as { sessionId: string };
    await settle({ sessionId, seconds: 9999, reason: "user" });
    expect(db.speech[0].billed_seconds).toBe(GRANT);
    // What it CLAIMED is kept beside what it was billed, so drift is greppable.
    expect(db.speech[0].reported_seconds).toBe(9999);
  });

  it("settles once however many times the beacon arrives", async () => {
    const { sessionId } = (await (await mint()).json()) as { sessionId: string };
    await settle({ sessionId, seconds: 4, reason: "user" });
    const again = await settle({ sessionId, seconds: 4, reason: "user" });
    // 200 and honest about it: a retried beacon is normal, not an error.
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ billedSeconds: null, settled: false });
    expect(db.speechSecondsHeld("u1")).toBe(4);
  });

  it("cannot close somebody else's session", async () => {
    const { sessionId } = (await (await mint()).json()) as { sessionId: string };
    caller = { id: "u2", email: "other@example.com" };
    const res = await settle({ sessionId, seconds: 30, reason: "user" });
    expect((await res.json()).settled).toBe(false);
    expect(db.speech[0].settled_at).toBeNull();
  });
});

// ── Disappearing is not cheaper than finishing ─────────────────────────────

describe("a stream that never settles", () => {
  it("is reaped at its full reservation on the next press", async () => {
    await mint(); // pressed, streamed, then the tab was killed
    expect(db.speech[0].settled_at).toBeNull();

    // The token has expired by the time they come back.
    db.now += AZURE_TOKEN_TTL_MS + 1000;
    await mint();

    expect(db.speech[0].settled_at).not.toBeNull();
    expect(db.speech[0].billed_seconds).toBe(GRANT);
    expect(db.speech[0].end_reason).toBe("lost");
  });

  it("still counts against the budget while it is open", async () => {
    process.env.TAOS_FAST_SPEECH_SECONDS_PER_HOUR = String(GRANT);
    await mint();
    // Never settled, not yet expired — so the hold is real and the next press
    // is refused. Otherwise two tabs would each spend the whole budget.
    const res = await mint();
    expect(res.status).toBe(429);
  });
});

// ── The client hands the reservation back ──────────────────────────────────

describe("the browser closes what it opened", () => {
  const hook = readFileSync(new URL("../lib/fast/useLiveDictation.ts", import.meta.url), "utf8");

  it("settles when the recogniser is torn down", () => {
    const start = hook.indexOf("const teardown = useCallback");
    const end = hook.indexOf("}, [clearTimers", start);
    expect(hook.slice(start, end)).toContain("settleToken(held, spokenMs");
  });

  it("uses keepalive, because the commonest moment to settle is a tab closing", () => {
    // Without it the fetch is cancelled on unload and the row is reaped at its
    // full thirty seconds for a sentence that was four.
    const start = hook.indexOf("const settleToken = useCallback");
    const end = hook.indexOf("const preload = useCallback", start);
    const body = hook.slice(start, end);
    expect(body).toContain("/api/fast/speech-settle");
    expect(body).toContain("keepalive: true");
  });

  it("drops the token with the reservation, so the next press mints its own", () => {
    // One reservation outstanding at a time. A token kept across utterances
    // would be a hold that covers one of them and authority that covers ten
    // minutes of them.
    const start = hook.indexOf("const teardown = useCallback");
    const end = hook.indexOf("}, [clearTimers", start);
    expect(hook.slice(start, end)).toContain("tokenRef.current = null");
  });
});
