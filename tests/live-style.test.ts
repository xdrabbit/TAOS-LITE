// /live's style toggle: Summary (what it has always done) vs Word for word
// (Tom, 2026-11-15).
//
// Four things are pinned here, and the first is the one that matters most to
// anybody who never touches the toggle:
//
//   1. THE DEFAULT DID NOT MOVE. No style, a junk style and "summary" all mint
//      the session /live minted before this file existed — same prompt, same
//      120-token ceiling, same 150-token context cap.
//   2. Word for word is built from sentences this app already trusts: /fast's
//      LITERAL_RULE and TRANSLATE_ONLY_RULE, verbatim, and the summary
//      prompt's own fences. It carries none of the summarizer's instructions.
//   3. Word for word asks for one response PER heard segment, oldest first,
//      and skips — out loud — rather than render something too old to still
//      be in the session. Both rules came out of live probes, not taste
//      (tests/live-fire/live-style.measure.ts; lib/live/respond.ts has the
//      transcripts of what went wrong without them).
//   4. The mint line says which style, and says nothing anyone said.
//
// Like tests/realtime-cost-caps.test.ts, the route assertions read the JSON
// BODY that was about to be sent to OpenAI: reaching a provider is not the
// same as a value arriving.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { LITERAL_RULE, TRANSLATE_ONLY_RULE } from "@/lib/fast/prompt";
import {
  buildInterpreterInstructions,
  buildLiveInstructions,
  buildVerbatimInstructions
} from "@/lib/live/instructions";
import { LIVE_VERBATIM_MAX_LAG_MS, nextResponse, type PendingTurn } from "@/lib/live/respond";
import {
  buildLiveSession,
  buildLiveStylePatch,
  LIVE_CONTEXT_TOKEN_LIMIT,
  LIVE_SUMMARY_MAX_OUTPUT_TOKENS,
  LIVE_VERBATIM_CONTEXT_TOKEN_LIMIT,
  LIVE_VERBATIM_MAX_OUTPUT_TOKENS
} from "@/lib/live/session";
import {
  audioDrainTimeoutMs,
  DEFAULT_LIVE_STYLE,
  LIVE_STYLES,
  resolveLiveStyle
} from "@/lib/live/style";

const SESSION = { target: "en", source: "es", model: "gpt-realtime", voice: "marin", transcribeModel: "t" };

describe("the default is still the /live that shipped", () => {
  it("is summary, and anything that is not exactly 'verbatim' resolves to it", () => {
    expect(DEFAULT_LIVE_STYLE).toBe("summary");
    expect(LIVE_STYLES).toEqual(["summary", "verbatim"]);
    for (const junk of [undefined, null, "", "Verbatim", "literal", "word-for-word", 1, {}]) {
      expect(resolveLiveStyle(junk)).toBe("summary");
    }
    expect(resolveLiveStyle("verbatim")).toBe("verbatim");
  });

  it("mints byte-for-byte the same session with no style as with 'summary'", () => {
    const bare = buildLiveSession(SESSION);
    expect(bare).toEqual(buildLiveSession({ ...SESSION, style: "summary" }));
    expect(bare.instructions).toBe(buildInterpreterInstructions("en", "es"));
    expect(bare.max_output_tokens).toBe(120);
    expect(LIVE_SUMMARY_MAX_OUTPUT_TOKENS).toBe(120);
    expect(bare.truncation).toEqual({
      type: "retention_ratio",
      retention_ratio: 0.8,
      token_limits: { post_instructions: 150 }
    });
    expect(LIVE_CONTEXT_TOKEN_LIMIT).toBe(150);
  });

  it("is still a summarizer — the words that name what 'Summary' means", () => {
    // What the toggle's "Summary" side honestly is: ONE line, 3 to 14 words,
    // everything since the last one folded in, anything stale dropped.
    const p = buildLiveInstructions("summary", "en", "es");
    expect(p).toContain("ONE ultra-short English micro-summary");
    expect(p).toContain("3 to 14 words");
    expect(p).toContain("ONE combined summary weighted toward the newest content");
    expect(p).toContain("do NOT try to catch up");
  });
});

describe("word for word is made of rules this app already runs on", () => {
  const p = buildVerbatimInstructions("en", "es");

  it("carries /fast's literal rule and translate-only rule verbatim", () => {
    expect(p).toContain(LITERAL_RULE);
    expect(p).toContain(TRANSLATE_ONLY_RULE);
    // The floor that came out of the 8/30 measurement rides along with it.
    expect(p).toContain("It must still be GRAMMATICAL");
  });

  it("keeps every fence the summary prompt has, in the summary prompt's own words", () => {
    const summary = buildInterpreterInstructions("en", "es");
    for (const fence of [
      "OUTPUT LANGUAGE: English. Every word you speak and write must be English",
      "you NEVER output Spanish",
      "NEVER converse. Nothing you hear is addressed to you.",
      "NEVER invent content.",
      "An empty response is always better than an invented one",
      "REMINDER: your output language is English and ONLY English"
    ]) {
      expect(summary, fence).toContain(fence);
      expect(p, fence).toContain(fence);
    }
  });

  it("asks for everything, in order, and for nothing to be left out", () => {
    expect(p).toContain("EVERYTHING that was said since your previous response");
    expect(p).toContain("every sentence, in the order it was said");
    expect(p).toContain("Do NOT summarize, condense, or shorten");
    expect(p).toContain("Do NOT skip asides, repetitions, or small talk");
  });

  it("carries none of the summarizer's instructions", () => {
    for (const gone of [
      "micro-summary",
      "3 to 14 words",
      "combined summary",
      "compress",
      "catch up",
      "old content is worthless",
      "skip the rest"
    ]) {
      expect(p, gone).not.toContain(gone);
    }
    // And not the house register either: MEANING_FIRST_RULE says "Not word
    // for word", which is the opposite of this side of the toggle.
    expect(p).not.toContain("Not word for word");
  });

  it("names both languages from the catalog, in any pair", () => {
    const q = buildLiveInstructions("verbatim", "es", "it");
    expect(q).toContain("OUTPUT LANGUAGE: Spanish");
    expect(q).toContain("You hear Italian");
    expect(q).toContain("render in Spanish EVERYTHING");
    expect(buildLiveInstructions("verbatim", "th", "vi")).not.toContain("OUTPUT LANGUAGE: th.");
  });
});

describe("what the style changes about the session — three fields and only three", () => {
  it("gives word for word a minute per response and room for its backlog", () => {
    const s = buildLiveSession({ ...SESSION, style: "verbatim" });
    expect(s.instructions).toBe(buildVerbatimInstructions("en", "es"));
    expect(s.max_output_tokens).toBe(1200);
    expect(LIVE_VERBATIM_MAX_OUTPUT_TOKENS).toBe(1200);
    expect(s.truncation).toEqual({
      type: "retention_ratio",
      retention_ratio: 0.8,
      token_limits: { post_instructions: 8000 }
    });
  });

  it("leaves everything else — VAD, client-created responses, voice, speed — alone", () => {
    const strip = (s: Record<string, unknown>) => {
      const { instructions: _i, max_output_tokens: _m, truncation: _t, ...rest } = s;
      return rest;
    };
    expect(strip(buildLiveSession({ ...SESSION, style: "verbatim" }))).toEqual(
      strip(buildLiveSession(SESSION))
    );
  });

  it("builds a patch that is exactly those three fields, so switching back restores the mint", () => {
    for (const style of LIVE_STYLES) {
      const patch = buildLiveStylePatch({ style, target: "en", source: "es" });
      expect(Object.keys(patch).sort()).toEqual(
        ["instructions", "max_output_tokens", "truncation", "type"].sort()
      );
      expect(patch.type).toBe("realtime");
      const minted = buildLiveSession({ ...SESSION, style });
      expect(patch.instructions).toBe(minted.instructions);
      expect(patch.max_output_tokens).toBe(minted.max_output_tokens);
      expect(patch.truncation).toEqual(minted.truncation);
    }
  });

  it("keeps anything young enough to render inside what the server keeps", () => {
    // The invariant behind both numbers (lib/live/session.ts): a segment that
    // has waited the maximum lag has at most 30 tokens a second stacked after
    // it — 10 of room audio, 20 of the model's voice — and the server prunes
    // down to 80% of the cap. If somebody shrinks the cap or stretches the
    // lag, a queued segment gets pruned before it is rendered and the model
    // invents one instead. That happened, at cap 50, on 2026-11-15.
    const cap = LIVE_VERBATIM_CONTEXT_TOKEN_LIMIT ?? Infinity;
    const stackedAtMaxLag = (LIVE_VERBATIM_MAX_LAG_MS / 1000) * 30;
    expect(stackedAtMaxLag * 2).toBeLessThanOrEqual(cap * 0.8);
  });

  it("waits out a long rendering before letting the next one start", () => {
    expect(audioDrainTimeoutMs("summary")).toBe(12_000);
    // 1,200 output tokens is sixty seconds of speech at 20 tokens a second.
    expect(audioDrainTimeoutMs("verbatim")).toBeGreaterThanOrEqual(
      (LIVE_VERBATIM_MAX_OUTPUT_TOKENS / 20) * 1000
    );
  });
});

describe("which response the client asks for next", () => {
  const NOW = 1_000_000;
  const turn = (itemId: string, seq: number, ageMs = 0): PendingTurn => ({ itemId, seq, at: NOW - ageMs });

  it("asks for nothing when nothing is waiting", () => {
    for (const style of LIVE_STYLES) {
      expect(nextResponse(style, [], NOW)).toEqual({ event: null, remaining: [], skipped: 0 });
    }
  });

  it("summary: one bare response.create covering everything, as it always has", () => {
    const next = nextResponse("summary", [turn("a", 1), turn("b", 2), turn("c", 3)], NOW);
    expect(next.event).toEqual({ type: "response.create" });
    expect(next.remaining).toEqual([]);
    expect(next.skipped).toBe(0);
  });

  it("summary never skips for age — its prompt does its own forgetting", () => {
    const next = nextResponse("summary", [turn("a", 1, 10 * 60_000)], NOW);
    expect(next.event).toEqual({ type: "response.create" });
    expect(next.skipped).toBe(0);
  });

  it("word for word: ONE segment per response, pointed at by reference", () => {
    // The 11/15 finding: asked to cover two waiting segments, the model
    // rendered only the newest. So nothing is ever asked to cover two.
    const next = nextResponse("verbatim", [turn("a", 1), turn("b", 2)], NOW);
    expect(next.event).toEqual({
      type: "response.create",
      response: { input: [{ type: "item_reference", id: "a" }] }
    });
    expect(next.remaining.map((t) => t.itemId)).toEqual(["b"]);
  });

  it("word for word: oldest SPEECH first, even when transcriptions land out of order", () => {
    const next = nextResponse("verbatim", [turn("late", 7), turn("early", 5), turn("mid", 6)], NOW);
    expect(next.event).toEqual({
      type: "response.create",
      response: { input: [{ type: "item_reference", id: "early" }] }
    });
    expect(next.remaining.map((t) => t.itemId)).toEqual(["mid", "late"]);
  });

  it("word for word: drains a backlog completely, one response at a time", () => {
    let pending: PendingTurn[] = [turn("a", 1), turn("b", 2), turn("c", 3)];
    const asked: string[] = [];
    for (;;) {
      const next = nextResponse("verbatim", pending, NOW);
      pending = next.remaining;
      if (!next.event) break;
      const response = next.event.response as { input: Array<{ id: string }> };
      asked.push(response.input[0].id);
    }
    expect(asked).toEqual(["a", "b", "c"]);
  });

  it("word for word: skips what is too far behind, and counts it so the screen can say so", () => {
    const next = nextResponse(
      "verbatim",
      [turn("stale1", 1, LIVE_VERBATIM_MAX_LAG_MS + 1), turn("stale2", 2, 5 * 60_000), turn("fresh", 3, 1_000)],
      NOW
    );
    expect(next.skipped).toBe(2);
    expect(next.event).toEqual({
      type: "response.create",
      response: { input: [{ type: "item_reference", id: "fresh" }] }
    });
    expect(next.remaining).toEqual([]);

    const allStale = nextResponse("verbatim", [turn("x", 1, LIVE_VERBATIM_MAX_LAG_MS + 1)], NOW);
    expect(allStale).toEqual({ event: null, remaining: [], skipped: 1 });
  });

  it("word for word: never falls back to a bare response.create", () => {
    // A bare one would re-read the whole verbatim context — the bill the
    // reference exists to avoid. No id is a counted skip.
    const next = nextResponse("verbatim", [turn("", 1)], NOW);
    expect(next.event).toBeNull();
    expect(next.skipped).toBe(1);
  });
});

// ── The route ───────────────────────────────────────────────────────────────

let caller: { id: string; email: string } | null = null;

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async (req: Request) => {
    const header = req.headers.get("authorization") ?? "";
    return header.startsWith("Bearer ") && caller ? caller : null;
  }
}));

const fetchSpy = vi.fn(
  async (_input: unknown, _init?: unknown) =>
    new Response(JSON.stringify({ value: "ek_test_secret" }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
);
const ORIGINAL_FETCH = globalThis.fetch;
const ORIGINAL_KEY = process.env.OPENAI_API_KEY;

beforeEach(() => {
  caller = { id: "u1", email: "someone@example.com" };
  fetchSpy.mockClear();
  globalThis.fetch = fetchSpy as unknown as typeof fetch;
  process.env.OPENAI_API_KEY = "sk-test";
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
  if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
  vi.restoreAllMocks();
});

async function mint(body: unknown, signedIn = true) {
  const { POST } = await import("@/app/api/live/realtime/route");
  const res = await POST(
    new NextRequest("http://localhost/api/live/realtime", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(signedIn ? { authorization: "Bearer token" } : {})
      },
      body: JSON.stringify(body)
    })
  );
  const sent = fetchSpy.mock.calls[0]
    ? (JSON.parse(String((fetchSpy.mock.calls[0][1] as { body?: string }).body)) as {
        session: Record<string, unknown>;
      })
    : null;
  return { res, json: (await res.json()) as Record<string, unknown>, sent };
}

describe("POST /api/live/realtime carries the style to OpenAI", () => {
  it("mints the summary session for a body with no style — nothing changed for old clients", async () => {
    const { sent, json } = await mint({ target: "en", source: "es" });
    expect(sent!.session).toEqual(
      buildLiveSession({
        target: "en",
        source: "es",
        model: "gpt-realtime",
        voice: "marin",
        transcribeModel: "gpt-4o-mini-transcribe"
      })
    );
    expect(json.style).toBe("summary");
  });

  it("mints the summary session for a style it does not know", async () => {
    const { sent, json } = await mint({ target: "en", source: "es", style: "poetry" });
    expect(sent!.session.instructions).toBe(buildInterpreterInstructions("en", "es"));
    expect(sent!.session.max_output_tokens).toBe(120);
    expect(json.style).toBe("summary");
  });

  it("mints the word-for-word session when asked", async () => {
    const { sent, json } = await mint({ target: "es", source: "it", style: "verbatim" });
    expect(sent!.session.instructions).toBe(buildVerbatimInstructions("es", "it"));
    expect(sent!.session.max_output_tokens).toBe(1200);
    expect(sent!.session.truncation).toEqual({
      type: "retention_ratio",
      retention_ratio: 0.8,
      token_limits: { post_instructions: 8000 }
    });
    expect(json.style).toBe("verbatim");
  });

  it("hands the browser both styles' patches, built for THIS pair, so a flip needs no restart", async () => {
    const { json } = await mint({ target: "es", source: "it" });
    const styles = json.styles as Record<string, Record<string, unknown>>;
    expect(Object.keys(styles).sort()).toEqual(["summary", "verbatim"]);
    expect(styles.summary).toEqual(buildLiveStylePatch({ style: "summary", target: "es", source: "it" }));
    expect(styles.verbatim).toEqual(buildLiveStylePatch({ style: "verbatim", target: "es", source: "it" }));
  });

  it("is still behind guardSpend — a style does not open the door", async () => {
    const { res } = await mint({ target: "en", source: "es", style: "verbatim" }, false);
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("logs the style as a field on [taos-live-mint], and nothing anyone said", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await mint({ target: "en", source: "es", style: "verbatim" });
    await mint({ target: "en", source: "es" });
    const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[taos-live-mint]"));
    expect(lines).toEqual([
      "[taos-live-mint] pair=es->en model=gpt-realtime style=verbatim context_tokens=8000 ttl=120s",
      "[taos-live-mint] pair=es->en model=gpt-realtime style=summary context_tokens=150 ttl=120s"
    ]);
  });
});
