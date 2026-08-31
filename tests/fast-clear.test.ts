// The Clear button on /fast — the four things it has to do, and the one thing
// it must never do.
//
// Tom asked for it from the field: a quiet button above the mic that puts the
// quickie box back to the state the screen opens in. Small feature, and three
// of its four requirements are the obvious ones (it shows only when there is
// something to clear, it resets the whole screen, it hands the caret back).
//
// The fourth is the reason this file exists. Clearing the box must not become
// a way to be charged twice for one lookup: /fast meters into the normal
// monthly allowance, and a double-billed phrase looks identical on screen, so
// it is invisible when it breaks.
//
// That guard used to be a `billedRef` set in FastShell, held for the life of
// the visit. #51 moved billing to the server and keyed it on a BURST of
// previews, which silently lost it — two bursts of the same words were two
// rows, so clear-and-retype started costing money it never used to. The set is
// back, durably, as the repeat window in `public.fast_begin`
// (lib/fast/settle.ts, FAST_REPEAT_MS), and it is pinned below against the
// real route rather than against a copy of the rule.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { hasSomethingToClear } from "@/lib/fast/clear";
import { FAST_REPEAT_MS, FAST_SETTLE_MS } from "@/lib/fast/settle";
import { FastMeterDb } from "./helpers/fastMeterDb";

// ── The meter, driven for real ──────────────────────────────────────────────
// Billing left the browser in #51, so the money test cannot be a pure function
// any more — it has to go through POST /api/fast, which is where the decision
// now lives.

const USER = "u-clear";
const db = new FastMeterDb();

vi.mock("@/lib/supabaseAdmin", () => ({
  hasServiceRoleKey: true,
  supabaseAdmin: { rpc: (name: string, args: Record<string, unknown>) => db.rpc(name, args) }
}));

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) =>
    req.headers.get("authorization")?.startsWith("Bearer ")
      ? { id: USER, email: "someone@example.com" }
      : null
}));

const fetchSpy = vi.fn(async (_url: string, init?: RequestInit) => {
  const sent = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
  const json = (sent.response_format as { type?: string } | undefined)?.type === "json_object";
  const content = json ? JSON.stringify({ sourceLang: "en", translation: "hola" }) : "hola";
  return new Response(JSON.stringify({ choices: [{ message: { content } }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" }
  });
});

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(async () => {
  db.reset();
  db.profiles.set(USER, { subscription_status: "active", tier: "basic" }); // no quota noise
  fetchSpy.mockClear();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  process.env.OPENAI_API_KEY = "sk-test";
  process.env.NEXT_PUBLIC_ENABLE_FAST = "1";
  delete process.env.VERCEL_ENV;
  delete process.env.AZURE_TRANSLATOR_KEY;
  const { resetFastRateLimits } = await import("@/lib/fast/rateLimit");
  resetFastRateLimits();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  delete process.env.NEXT_PUBLIC_ENABLE_FAST;
  vi.resetModules();
});

/** Type a phrase — a few previews — and let the burst end. */
async function settleQuickie(text: string): Promise<void> {
  const { POST } = await import("@/app/api/fast/route");
  const previews = [text.slice(0, Math.max(1, Math.floor(text.length / 2))), text];
  for (const body of previews) {
    db.now += 320;
    await POST(
      new NextRequest("https://taoslite.com/api/fast", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
        body: JSON.stringify({
          text: body,
          sourceLanguage: "en",
          targetLanguage: "es",
          direction: "auto"
        })
      })
    );
  }
  // The typing stops. Past this the burst is over and the next request is a
  // new one — which is exactly what makes the repeat window load-bearing.
  db.now += FAST_SETTLE_MS + 1;
}

/** One preview and then a pause — somebody who started retyping and stopped. */
async function previewOnce(text: string): Promise<void> {
  const { POST } = await import("@/app/api/fast/route");
  db.now += 320;
  await POST(
    new NextRequest("https://taoslite.com/api/fast", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify({
        text,
        sourceLanguage: "en",
        targetLanguage: "es",
        direction: "auto"
      })
    })
  );
  db.now += FAST_SETTLE_MS + 1;
}

/** Tapping Clear does nothing to the server; it just ends the sitting. */
function clearTheBox(): void {
  db.now += FAST_SETTLE_MS + 1;
}


const source = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

/** The body of FastShell's `clear` callback, which is what most of this pins. */
function clearHandler(): string {
  const shell = source("components/FastShell.tsx");
  const start = shell.indexOf("const clear = useCallback(");
  expect(start).toBeGreaterThan(-1);
  const end = shell.indexOf("const copy = useCallback(", start);
  expect(end).toBeGreaterThan(start);
  return shell.slice(start, end);
}

// ───────────────────────────────────────────────────────────────────────────
// 1. It is only there when there is something to clear
// ───────────────────────────────────────────────────────────────────────────

describe("hasSomethingToClear — the visibility toggle", () => {
  it("is absent on an empty box", () => {
    // The screen opens with two controls on the box and it should still be
    // two. /fast's whole virtue is that nothing is between somebody and the
    // word they wanted.
    expect(hasSomethingToClear("", "")).toBe(false);
  });

  it("appears as soon as a letter is typed", () => {
    expect(hasSomethingToClear("h", "")).toBe(true);
  });

  it("counts a tentative tail as content", () => {
    // The streaming mic draws hypotheses OUTSIDE `input` so they cannot start
    // a translation (lib/fast/liveTranscript.ts). For the first second of a
    // latched dictation that tail is the only thing on the box — and it is
    // plainly something a thumb would want to clear.
    expect(hasSomethingToClear("", "where is the phar")).toBe(true);
  });

  it("treats whitespace as content rather than as an empty box", () => {
    // Untrimmed on purpose: the caret is sitting after those spaces, and a
    // button that vanished while the box still held them would be lying.
    expect(hasSomethingToClear("   ", "")).toBe(true);
  });
});

describe("the button is rendered from that predicate, in a reserved slot", () => {
  const shell = source("components/FastShell.tsx");

  it("gates on hasSomethingToClear rather than on a hand-rolled check", () => {
    // Two arguments still, and the second one is now always "" — the mic was
    // parked on 8/31 (lib/release.ts) and `micPartial` is the wire that would
    // carry a tentative tail back if somebody flipped it on. The predicate did
    // not change, because the reason for it did not.
    expect(shell).toContain("hasSomethingToClear(input, micPartial)");
    expect(shell).toMatch(/\{clearable \? \(/);
  });

  it("carries the bilingual label Tom asked for", () => {
    expect(shell).toContain('aria-label="Borrar · Clear"');
  });

  it("is the only control beside the box now that the mic is gone", () => {
    // It shipped as the quiet one in a column under a 56px mic. The mic came
    // off on 8/31 and Clear kept its size and its side: still h-8, still
    // beside the field rather than under the answer, because it acts on the
    // FIELD. What it must NOT have inherited is the mic's job — no dictate
    // control, and no mic-sized button, survives on this screen.
    expect(shell).toContain('aria-label="Borrar · Clear"');
    expect(shell).toContain("h-8 w-8");
    expect(shell).not.toContain('aria-label="Dictar · Dictate"');
    expect(shell).not.toContain("h-14 w-14");
  });

  it("reserves the slot so appearing costs no layout shift", () => {
    // The button comes and goes; the box it lives in does not. BOTH dimensions
    // now: the slot used to take its width from the 56px mic under it, and
    // with the mic gone an empty h-8 wrapper collapses to zero width and hands
    // it back to the textarea — the box would resize under the caret on the
    // first keystroke, which is the exact jump this slot exists to prevent.
    expect(shell).toMatch(
      /<div className="flex h-8 w-8 shrink-0 items-center justify-center">\s*\{clearable \?/
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 2. It resets the screen
// ───────────────────────────────────────────────────────────────────────────

describe("clear resets every piece of the answer on screen", () => {
  const handler = clearHandler();

  it.each([
    ['setInput("")', "the box itself"],
    ['setTranslation("")', "the rendered translation"],
    ["setDetected(null)", "the detected source the caption reads"],
    ["setTarget(null)", "the target the caption reads"],
    ["setEngine(null)", "the engine line under the answer"],
    ["setFallback(null)", "why the engine fell back"],
    ["setError(null)", "any error banner"],
    ["setBusy(false)", "the dimming that says a request is out"],
    ["setCopied(false)", "a stale Copied ✓ from the last quickie"]
  ])("clears %s — %s", (call) => {
    expect(handler).toContain(call);
  });

  it("orphans anything in flight so a late reply cannot repaint the box", () => {
    // Typing outruns the network constantly here. Without the bump, a request
    // issued a moment before the tap lands afterwards and paints a translation
    // into a box somebody just emptied.
    expect(handler).toContain("seqRef.current += 1");
  });

  it("still cancels the parked mic, because a tail would be text on its way in", () => {
    // The mic is off (lib/release.ts) and this line costs one setState when
    // nothing is listening. It stays because the drawer is meant to reopen:
    // the dock watches this counter, and a clear during dictation is the one
    // gesture on this screen that means "not that, start again".
    expect(handler).toContain("setMicCancel((n) => n + 1)");
    expect(source("components/fast/FastMicDock.tsx")).toContain("cancel();");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. It hands the caret back
// ───────────────────────────────────────────────────────────────────────────

describe("clear returns focus to the input", () => {
  it("focuses the textarea", () => {
    // Keyboard users must not have to reach for the box to carry on, and it
    // is also what makes the field flow work: clear, then type the next word.
    expect(clearHandler()).toContain("inputRef.current?.focus()");
  });

  it("hands the caret back after a parked-mic dictation too", () => {
    // The textarea is always mounted now, so `inputRef.current?.focus()` above
    // covers every clear on the shipped screen. The dock keeps its own end-of-
    // dictation refocus for the flagged-on case — once, at the end, because
    // focusing on every finalized segment would pop the keyboard up over
    // somebody who is still talking.
    const dock = source("components/fast/FastMicDock.tsx");
    expect(dock).toContain("wasDictatingRef");
    expect(dock).toMatch(/if \(wasDictatingRef\.current && !dictating\) onIdle\(\)/);
    expect(source("components/FastShell.tsx")).toMatch(
      /const focusInput = useCallback\([\s\S]{0,200}el\.focus\(\)/
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. THE MONEY ONE: it does not reset what has already been billed
// ───────────────────────────────────────────────────────────────────────────

describe("clear is a screen gesture, not a payment", () => {
  it("does not touch the billed set", () => {
    // The one assertion in this file that costs real money when it fails, and
    // the one that is invisible on screen: a cleared-and-retyped phrase that
    // billed twice looks exactly like one that billed once.
    const handler = clearHandler();
    expect(handler).not.toContain("billedRef");
  });

  it("does not hand the direction back to Auto either", () => {
    // Pinning is a decision about the conversation, not about the phrase.
    // Somebody who pinned ES→EN to read a menu is about to read the next line
    // of the same menu.
    expect(clearHandler()).not.toContain("setPinned");
  });

  it("re-entering the same words after a clear bills nothing more", async () => {
    // The promise the Clear button was built on, walked through the real
    // route: type a phrase, let it settle, tap Clear, type the same phrase
    // again. The second time adopts the row the first one bought.
    await settleQuickie("where is the pharmacy");
    expect(db.monthRows(USER)).toHaveLength(1);

    clearTheBox();
    await settleQuickie("where is the pharmacy");
    expect(db.monthRows(USER)).toHaveLength(1);
  });

  it("a genuinely new quickie after a clear bills exactly one fresh row", async () => {
    // The other half of the ask: clearing must not make the NEXT lookup free
    // either. New words settle and count, once — and the previews that got
    // there still add up to the one row the phrase is worth.
    await settleQuickie("where is the pharmacy");
    clearTheBox();
    await settleQuickie("how much is this");
    expect(db.monthRows(USER)).toHaveLength(2);

    clearTheBox();
    await settleQuickie("how much is this");
    expect(db.monthRows(USER)).toHaveLength(2);
  });

  it("does not overwrite the answer it just saved somebody from re-buying", async () => {
    // The trap in adopting a row instead of buying one: the route still has a
    // translation in hand, and recording it writes over the finished phrase
    // the earlier lookup paid for. It shows up when the retype is PARTIAL —
    // start typing the phrase again, then stop — because then the prefix is
    // the last thing written. The History entry would quietly become
    // "where is the", with a translation of that fragment attached, which is
    // worse than the double charge the repeat window exists to prevent.
    await settleQuickie("where is the pharmacy");
    expect(db.rows).toHaveLength(1);
    const before = { ...db.rows[0] };

    clearTheBox();
    await previewOnce("where is the");

    expect(db.rows).toHaveLength(1); // still not re-bought
    expect(db.rows[0].original_text).toBe("where is the pharmacy");
    expect(db.rows[0].translation_text).toBe(before.translation_text);
  });

  it("bills a phrase again once it is no longer the same sitting", async () => {
    // The window is not forever, and it should not be: six hours later this is
    // somebody looking a word up again on a different day, and it is a lookup.
    await settleQuickie("where is the pharmacy");
    db.now += FAST_REPEAT_MS + 1000;
    await settleQuickie("where is the pharmacy");
    expect(db.monthRows(USER)).toHaveLength(2);
  });
});
