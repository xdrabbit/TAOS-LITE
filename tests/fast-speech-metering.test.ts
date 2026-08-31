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
import {
  AZURE_TOKEN_TTL_MS,
  FAST_MAX_DICTATION_MS,
  FAST_SPEECH_HOLD_MS
} from "@/lib/fast/dictation";
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

async function mint(token = "t", body?: Record<string, unknown>) {
  const { POST } = await import("@/app/api/fast/speech-token/route");
  return POST(
    new NextRequest("https://taoslite.com/api/fast/speech-token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      ...(body ? { body: JSON.stringify(body) } : {})
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

  it("KEEPS the token across utterances and drops only the reservation", () => {
    // This reverses what the first cut pinned here, and the old reasoning is
    // worth keeping because it is the instructive part: "a token kept across
    // utterances would be authority that covers ten minutes of them". True,
    // and it does not follow that dropping it helps — a JWT discarded in a
    // browser is not a JWT Azure stops honouring. Minting per press did not
    // replace the ten minutes of authority, it ADDED ten more, so a busy
    // visit left twenty live credentials where one would have done.
    //
    // The reservation is still per utterance. That is the half that was
    // right, and it is asserted above.
    const start = hook.indexOf("const teardown = useCallback");
    const end = hook.indexOf("}, [clearTimers", start);
    const body = hook.slice(start, end);
    expect(body).not.toContain("tokenRef.current = null");
    expect(body).toContain("tokenRef.current = { ...held, sessionId: null }");
  });

  it("re-authorises on EVERY press, token or no token", () => {
    // The reservation is what the ledger counts, so a press that skipped the
    // round trip would be a spoken quickie nothing metered. `reuse` changes
    // what comes back, never whether the server was asked.
    const start = hook.indexOf("const warm = useCallback");
    const end = hook.indexOf("const ensureWarm = useCallback", start);
    const body = hook.slice(start, end);
    expect(body).toContain("/api/fast/speech-token");
    expect(body).toContain("JSON.stringify({ reuse })");
    // The early return that used to skip the fetch on a live token is gone.
    expect(body).not.toMatch(/if \(held && Date\.now\(\) <[^)]*\) return;/);
  });

  it("does not cache a SETTLED warm-up, or the second press falls back forever", () => {
    // The bug this found: `warmRef` held a resolved promise for the life of
    // the page, so press two got an instant `ensureWarm()`, found no token,
    // threw, and went silently to the batch mic. Every press after the first
    // was the lumpy mic — invisible on desktop, where the first press is
    // usually the only one anybody makes.
    const start = hook.indexOf("const ensureWarm = useCallback");
    const end = hook.indexOf("}, [warm]);", start);
    const body = hook.slice(start, end);
    expect(body).toContain("warmRef.current = null");
    expect(body).toContain(".finally(");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The meter binds the people who can actually reach the screen
// ───────────────────────────────────────────────────────────────────────────

describe("a founder-gated screen does not exempt founders from its own meter", () => {
  beforeEach(() => {
    caller = { id: "u1", email: "xdrabbit@gmail.com" };
    // The state /fast is actually in: held back, so only founders are here.
    delete process.env.NEXT_PUBLIC_ENABLE_FAST;
  });

  it("spends a founder's presses against the ordinary hourly budget", async () => {
    // The paradox the review named. fastVisibleTo() says only founders can
    // reach /fast; an unconditional founder bypass would say founders do not
    // count. The meter would then run, and refuse, for nobody — and the first
    // day it applied to a real person would be the first day it was tested.
    process.env.TAOS_FAST_SPEECH_SECONDS_PER_HOUR = String(GRANT * 2);
    expect((await mint()).status).toBe(200);
    expect((await mint()).status).toBe(200);
    const third = await mint();
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({ error: "speech_budget_spent" });
  });

  it("gives the bypass back the moment the screen is public", async () => {
    // Not a person-shaped rule, a gate-shaped one. NEXT_PUBLIC_ENABLE_FAST=1
    // means strangers are the population being bounded, and founders stop
    // paying for their own product. One flag, both halves.
    process.env.NEXT_PUBLIC_ENABLE_FAST = "1";
    process.env.TAOS_FAST_SPEECH_SECONDS_PER_HOUR = String(GRANT * 2);
    expect((await mint()).status).toBe(200);
    expect((await mint()).status).toBe(200);
    expect((await mint()).status).toBe(200);
  });

  it("still bills a founder's seconds either way — logged, not ignored", async () => {
    process.env.NEXT_PUBLIC_ENABLE_FAST = "1";
    const body = (await (await mint()).json()) as { sessionId: string };
    await settle({ sessionId: body.sessionId, seconds: 7, reason: "user" });
    expect(db.speech.at(-1)).toMatchObject({ billed_seconds: 7, user_id: "u1" });
  });
});

// ───────────────────────────────────────────────────────────────────────────
// A reservation is not a credential
// ───────────────────────────────────────────────────────────────────────────

describe("reserving without issuing", () => {
  it("takes the hold and never reaches Azure when the caller has a token", async () => {
    const res = await mint("t", { reuse: true });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    // A reservation is real — this is the press that re-authorised.
    expect(body.sessionId).toEqual(expect.any(String));
    expect(body.grantedSeconds).toBe(GRANT);
    // And no credential came back, because none was minted.
    expect(body.token).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(db.speech).toHaveLength(1);
    expect(db.speech[0].token_expires_at).toBeNull();
  });

  it("a reuse-only press does not count toward the live-token ceiling", async () => {
    // It adds no credential to the world, so refusing it would push a
    // well-behaved client into the batch mic for being well-behaved.
    process.env.TAOS_FAST_SPEECH_LIVE_TOKENS = "1";
    expect((await mint()).status).toBe(200);
    for (let i = 0; i < 5; i += 1) {
      expect((await mint("t", { reuse: true })).status).toBe(200);
    }
    delete process.env.TAOS_FAST_SPEECH_LIVE_TOKENS;
  });

  it("treats a missing or unreadable body as 'I have no token'", async () => {
    // The safe reading of silence. It costs a credential, never a refusal.
    const res = await mint();
    expect(res.status).toBe(200);
    expect((await res.json()).token).toBe(AZURE_JWT);
  });
});

describe("the live-token ceiling — the only bound a fixed, unrevokable TTL leaves", () => {
  beforeEach(() => {
    process.env.TAOS_FAST_SPEECH_LIVE_TOKENS = "2";
    // Take the hourly budget out of the picture: this is about authority.
    process.env.TAOS_FAST_SPEECH_SECONDS_PER_HOUR = "100000";
  });
  afterEach(() => {
    delete process.env.TAOS_FAST_SPEECH_LIVE_TOKENS;
  });

  it("refuses the credential past the ceiling, before Azure is reached", async () => {
    expect((await mint()).status).toBe(200);
    expect((await mint()).status).toBe(200);
    fetchSpy.mockClear();
    const third = await mint();
    expect(third.status).toBe(429);
    expect(await third.json()).toMatchObject({ error: "speech_tokens_live" });
    // The refusal costs nothing: no token minted is no socket opened.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("counts tokens, not reservations — settling one does not free a slot", async () => {
    // This is the distinction that makes the ceiling mean anything. A JWT
    // Azure issued keeps working for its full ten minutes whatever this
    // server records about it, so a settled reservation must NOT be read as
    // a returned credential.
    const first = (await (await mint()).json()) as { sessionId: string };
    await settle({ sessionId: first.sessionId, seconds: 3, reason: "user" });
    expect((await mint()).status).toBe(200);
    expect((await mint()).status).toBe(429);
  });

  it("frees the slot when the token actually expires, and not before", async () => {
    expect((await mint()).status).toBe(200);
    expect((await mint()).status).toBe(200);
    expect((await mint()).status).toBe(429);
    db.now += AZURE_TOKEN_TTL_MS + 1;
    expect((await mint()).status).toBe(200);
  });

  it("applies to a founder too, because a stolen token spends the same money", async () => {
    // Deliberately not conditioned on p_unlimited. Every other number in the
    // meter is about a bill; this one is about how much recognition authority
    // is loose in the world under one account's name.
    process.env.NEXT_PUBLIC_ENABLE_FAST = "1";
    caller = { id: "u1", email: "xdrabbit@gmail.com" };
    expect((await mint()).status).toBe(200);
    expect((await mint()).status).toBe(200);
    expect((await mint()).status).toBe(429);
  });
});

describe("the reservation's clock is one utterance, not one token", () => {
  it("reaps an abandoned hold a minute after the utterance could have ended", async () => {
    // The first cut reaped at the token TTL, so a tab that died mid-sentence
    // kept thirty seconds of the hourly budget encumbered for ten minutes —
    // ten times longer than the utterance it was reserving could last.
    await mint();
    expect(db.speech[0].expires_at - db.speech[0].minted_at).toBe(FAST_SPEECH_HOLD_MS);
    expect(FAST_SPEECH_HOLD_MS).toBeLessThan(AZURE_TOKEN_TTL_MS);

    db.now += FAST_SPEECH_HOLD_MS + 1;
    await mint("t", { reuse: true });
    expect(db.speech[0]).toMatchObject({ end_reason: "lost", billed_seconds: GRANT });
  });

  it("still gives the JWT its full ten minutes, because Azure does", async () => {
    await mint();
    expect(db.speech[0].token_expires_at! - db.speech[0].minted_at).toBe(AZURE_TOKEN_TTL_MS);
  });
});
