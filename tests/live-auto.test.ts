// /live two-way Auto (Tom and Liz, 2026-11-17): the prompt, the session, the
// route, and the two echo fences — the pure half. The screen and the wire are
// in tests/live-auto-screen.test.ts.
//
// What is pinned here, and why:
//
//   · Auto reuses the TABLE's tag rule, sentence for sentence, so
//     lib/tabletop/autoDetect.ts reads /live's output with the parser it has;
//   · an Auto session WRITES (a speaking model would say "[es]" aloud), which
//     is also why it cannot hear itself by default;
//   · Auto is word for word only, and asks the way word for word asks — so
//     the 90-second skip-ahead and the 8,000-token cap from #133 are the same
//     numbers, untouched;
//   · a request without `auto` mints exactly the session it always did.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { LITERAL_RULE, TRANSLATE_ONLY_RULE } from "@/lib/fast/prompt";
import { buildAutoVerbatimInstructions, buildVerbatimInstructions } from "@/lib/live/instructions";
import {
  buildLiveAutoPatch,
  buildLiveSession,
  LIVE_AUTO_MAX_OUTPUT_TOKENS,
  LIVE_VERBATIM_CONTEXT_TOKEN_LIMIT
} from "@/lib/live/session";
import { LIVE_VERBATIM_MAX_LAG_MS, nextResponse } from "@/lib/live/respond";
import {
  createEchoGuard,
  createLiveEchoGate,
  echoUnits,
  effectiveLiveStyle,
  LIVE_ECHO_WINDOW_MS,
  otherOfPair,
  resolveLiveAuto
} from "@/lib/live/auto";
import { HALF_DUPLEX_TAIL_MS } from "@/lib/interpreter/halfDuplex";
import { autoTagFormatRule, autoTagReminder, buildAutoInstructions } from "@/lib/tabletop/instructions";
import { parseTag } from "@/lib/tabletop/autoDetect";
import { MEANING_FIRST_RULE } from "@/lib/translate/prompts";

describe("Auto's prompt is the table's tag around word-for-word's body", () => {
  const prompt = buildAutoVerbatimInstructions("en", "es");

  it("opens and closes with the tabletop's own tag sentences", () => {
    const pair = { a: "en", b: "es" };
    expect(prompt.startsWith(autoTagFormatRule(pair))).toBe(true);
    expect(prompt.endsWith(autoTagReminder(pair))).toBe(true);
    // …and the table still says exactly what it said: the extraction moved no words.
    const table = buildAutoInstructions(pair);
    expect(table.startsWith(autoTagFormatRule(pair))).toBe(true);
    expect(table.endsWith(autoTagReminder(pair))).toBe(true);
    expect(table).toContain("[en] for English or [es] for Spanish");
  });

  it("is word for word: /fast's literal rules, every sentence, nothing summarized", () => {
    expect(prompt).toContain(LITERAL_RULE);
    expect(prompt).toContain(TRANSLATE_ONLY_RULE);
    expect(prompt).toContain("Every sentence, in the order it was said");
    expect(prompt).toContain("Do NOT summarize");
    expect(prompt).not.toContain(MEANING_FIRST_RULE());
    expect(prompt).not.toMatch(/micro-summary|compress/i);
  });

  it("names both directions and keeps the two fences every /live prompt has", () => {
    expect(prompt).toContain("English into Spanish, Spanish into English");
    const verbatim = buildVerbatimInstructions("en", "es");
    const neverConverse = /NEVER converse\.[^.]*\.[^.]*\./.exec(verbatim)![0];
    expect(prompt).toContain(neverConverse);
    expect(prompt).toContain("NEVER invent content.");
  });

  it("has no single output language to drift to", () => {
    expect(prompt).not.toContain("OUTPUT LANGUAGE:");
    expect(prompt).not.toContain("you NEVER output");
  });
});

describe("an Auto session", () => {
  const base = { target: "en", source: "es", model: "gpt-realtime", voice: "marin", transcribeModel: "t" };
  const session = buildLiveSession({ ...base, auto: true });

  it("writes instead of speaking, under word-for-word's cap", () => {
    expect(session.output_modalities).toEqual(["text"]);
    expect(session.instructions).toBe(buildAutoVerbatimInstructions("en", "es"));
    expect(session.max_output_tokens).toBe(LIVE_AUTO_MAX_OUTPUT_TOKENS);
    expect(session.truncation).toEqual({
      type: "retention_ratio",
      retention_ratio: 0.8,
      token_limits: { post_instructions: LIVE_VERBATIM_CONTEXT_TOKEN_LIMIT }
    });
    expect(LIVE_VERBATIM_CONTEXT_TOKEN_LIMIT).toBe(8000);
  });

  it("changes nothing else: same VAD, same client-created responses, same transcription", () => {
    const plain = buildLiveSession({ ...base, style: "verbatim" });
    expect(session.audio).toEqual(plain.audio);
    expect(session.model).toBe(plain.model);
  });

  it("ignores the style it is handed — Auto is word for word only", () => {
    expect(buildLiveSession({ ...base, auto: true, style: "summary" })).toEqual(session);
    expect(effectiveLiveStyle("summary", true)).toBe("verbatim");
    expect(effectiveLiveStyle("summary", false)).toBe("summary");
  });

  it("without auto, the session still speaks — the field is absent, not false-ish", () => {
    for (const style of ["summary", "verbatim"] as const) {
      expect(buildLiveSession({ ...base, style }).output_modalities).toEqual(["audio"]);
    }
    expect(buildLiveAutoPatch({ pair: ["en", "es"] }).output_modalities).toEqual(["text"]);
  });

  it("asks the way word for word asks: one segment per response, and the 90-second skip is unchanged", () => {
    const NOW = 1_000_000;
    const style = effectiveLiveStyle("summary", true);
    const next = nextResponse(
      style,
      [
        { itemId: "old", seq: 1, at: NOW - LIVE_VERBATIM_MAX_LAG_MS - 1 },
        { itemId: "a", seq: 2, at: NOW - 1000 },
        { itemId: "b", seq: 3, at: NOW }
      ],
      NOW
    );
    expect(LIVE_VERBATIM_MAX_LAG_MS).toBe(90_000);
    expect(next.skipped).toBe(1);
    expect(next.event).toEqual({
      type: "response.create",
      response: { input: [{ type: "item_reference", id: "a" }] }
    });
    expect(next.remaining.map((t) => t.itemId)).toEqual(["b"]);
  });
});

describe("the tag decides both languages, or neither", () => {
  it("names what was written; what was heard is the other end of the pair", () => {
    const pair = ["en", "es"] as const;
    const { verdict, text } = parseTag("[es] ¿Dónde está el baño?", pair);
    expect(verdict).toEqual({ kind: "hit", code: "es" });
    expect(text).toBe("¿Dónde está el baño?");
    expect(otherOfPair(pair, "es")).toBe("en");
    expect(otherOfPair(pair, "en")).toBe("es");
    expect(otherOfPair(pair, "fr")).toBeNull();
  });

  it("only a stored '1' turns Auto on", () => {
    expect(resolveLiveAuto("1")).toBe(true);
    for (const v of [null, undefined, "", "0", "true", "on", 1]) expect(resolveLiveAuto(v)).toBe(false);
  });
});

describe("echo fence one: the mic is shut while this phone speaks", () => {
  function gate() {
    let now = 0;
    const timers: Array<{ at: number; fn: () => void }> = [];
    const held: boolean[] = [];
    const g = createLiveEchoGate({
      setMicHeld: (h) => held.push(h),
      now: () => now,
      setTimer: (fn, ms) => {
        const t = { at: now + ms, fn };
        timers.push(t);
        return t;
      },
      clearTimer: (h) => {
        const i = timers.indexOf(h as { at: number; fn: () => void });
        if (i >= 0) timers.splice(i, 1);
      }
    });
    const advance = (ms: number) => {
      now += ms;
      for (const t of [...timers]) {
        if (t.at <= now) {
          timers.splice(timers.indexOf(t), 1);
          t.fn();
        }
      }
    };
    return { g, held, advance };
  }

  it("holds from the first sample to the interpreter's 300 ms tail after the last", () => {
    const { g, held, advance } = gate();
    g.speakStart();
    expect(held).toEqual([true]);
    advance(4000);
    g.speakEnd();
    // Still shut through the tail: the room is ringing and a mic chunk is mid-fill.
    expect(g.held()).toBe(true);
    advance(HALF_DUPLEX_TAIL_MS - 1);
    expect(g.held()).toBe(true);
    advance(2);
    expect(held).toEqual([true, false]);
    expect(HALF_DUPLEX_TAIL_MS).toBe(300);
  });

  it("back-to-back readouts keep it shut across the gap", () => {
    const { g, held, advance } = gate();
    g.speakStart();
    advance(1000);
    g.speakEnd();
    advance(100);
    g.speakStart();
    advance(1000);
    expect(held).toEqual([true]);
    g.speakEnd();
    advance(HALF_DUPLEX_TAIL_MS + 1);
    expect(held).toEqual([true, false]);
  });

  it("gives the mic back if the player never says it finished, and on dispose", () => {
    const a = gate();
    a.g.speakStart();
    a.advance(10 * 60_000);
    expect(a.g.held()).toBe(false);

    const b = gate();
    b.g.speakStart();
    b.g.dispose();
    expect(b.held).toEqual([true, false]);
  });

  // Copilot on #137: a readout that outlives its session (a slow /api/tts
  // answer, a late "ended") was reaching the mic of the session after it.
  it("is dead once disposed: a late readout can neither shut nor open the next session's mic", () => {
    const { g, held, advance } = gate();
    g.dispose();
    g.speakStart();
    expect(g.held()).toBe(false);
    g.speakEnd();
    advance(10 * 60_000);
    expect(held).toEqual([]);
  });
});

describe("echo fence two: a heard line that is what this phone just said", () => {
  const NOW = 50_000;

  it("drops its own readout coming back, even mangled by the room", () => {
    const guard = createEchoGuard();
    guard.spoke("Where is the bathroom, please?", NOW);
    expect(guard.isEcho("where is the bathroom please", NOW + 3000)).toBe(true);
    expect(guard.isEcho("Where's the bathroom, please", NOW + 3000)).toBe(true);
  });

  it("lets the answer through — a reply shares a word or two, not most of them", () => {
    const guard = createEchoGuard();
    guard.spoke("Where is the bathroom, please?", NOW);
    expect(guard.isEcho("The bathroom is down the hall on the left", NOW + 3000)).toBe(false);
    expect(guard.isEcho("Al fondo a la izquierda, junto a la cocina", NOW + 3000)).toBe(false);
  });

  it("never drops anything when nothing was spoken — voice off cannot lose a line", () => {
    const guard = createEchoGuard();
    expect(guard.isEcho("Where is the bathroom, please?", NOW)).toBe(false);
  });

  it("forgets after the window, measured from when the readout finished", () => {
    const guard = createEchoGuard();
    guard.spoke("Where is the bathroom, please?", NOW);
    guard.finished("Where is the bathroom, please?", NOW + 8000);
    expect(guard.isEcho("Where is the bathroom please", NOW + 8000 + LIVE_ECHO_WINDOW_MS - 1)).toBe(true);
    expect(guard.isEcho("Where is the bathroom please", NOW + 8000 + LIVE_ECHO_WINDOW_MS + 1)).toBe(false);
  });

  it("does not judge two words — 'Sí, claro' matches too much by accident", () => {
    const guard = createEchoGuard();
    guard.spoke("Sí, claro, vamos el domingo", NOW);
    expect(guard.isEcho("Sí, claro", NOW + 1000)).toBe(false);
  });

  // Copilot on #137: a sentence in a script without spaces is ONE run of
  // letters, so "fewer than three words" switched the fence off for Chinese,
  // Japanese and Thai — an exact repeat of the readout was translated again.
  describe("a script that does not put spaces between words", () => {
    it("is measured in character pairs, and its length in word-equivalents", () => {
      expect(echoUnits("请问洗手间在哪里")).toEqual({
        tokens: ["请问", "问洗", "洗手", "手间", "间在", "在哪", "哪里"],
        words: 4
      });
      // Punctuation ends a run; it is never part of a pair.
      expect(echoUnits("好的，谢谢。").tokens).toEqual(["好的", "谢谢"]);
      // Words with spaces are what they always were: lower case, accents off.
      expect(echoUnits("¿Dónde está el baño?")).toEqual({ tokens: ["donde", "esta", "el", "bano"], words: 4 });
      // Mixed: each script by its own rule.
      expect(echoUnits("iPhone很好用")).toEqual({ tokens: ["iphone", "很好", "好用"], words: 3 });
      // Thai keeps its vowel marks — they are not accents.
      expect(echoUnits("ห้องน้ำ").tokens.join("")).toContain("้");
    });

    it.each([
      ["Chinese", "请问洗手间在哪里", "请问洗手间在哪里？", "在走廊尽头的左边"],
      ["Cantonese", "請問洗手間喺邊度", "請問洗手間喺邊度呀", "喺走廊盡頭左手邊"],
      ["Japanese", "トイレはどこですか", "トイレはどこですか？", "廊下の突き当たりを左です"],
      ["Thai", "ห้องน้ำอยู่ที่ไหนครับ", "ห้องน้ำอยู่ที่ไหนครับ", "เดินตรงไปแล้วเลี้ยวซ้าย"]
    ])("%s: the readout coming back is dropped, the answer is not", (_name, spoken, echo, reply) => {
      const guard = createEchoGuard();
      guard.spoke(spoken, NOW);
      expect(guard.isEcho(echo, NOW + 3000)).toBe(true);
      expect(guard.isEcho(reply, NOW + 3000)).toBe(false);
    });

    it("survives the room changing a character or two", () => {
      const guard = createEchoGuard();
      guard.spoke("请问洗手间在哪里", NOW);
      expect(guard.isEcho("请问，洗手间在哪", NOW + 3000)).toBe(true);
    });

    it("still does not judge a couple of words — '好的谢谢' matches too much by accident", () => {
      const guard = createEchoGuard();
      guard.spoke("好的，谢谢，我们星期天去", NOW);
      expect(guard.isEcho("好的谢谢", NOW + 1000)).toBe(false);
    });
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
      headers: { "content-type": "application/json", ...(signedIn ? { authorization: "Bearer token" } : {}) },
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

describe("POST /api/live/realtime with auto", () => {
  const SESSION = { model: "gpt-realtime", voice: "marin", transcribeModel: "gpt-4o-mini-transcribe" };

  it("mints the two-way text session for auto:true, whatever style rides along", async () => {
    const { sent, json } = await mint({ target: "en", source: "es", style: "summary", auto: true });
    expect(sent!.session).toEqual(buildLiveSession({ target: "en", source: "es", ...SESSION, auto: true }));
    expect(sent!.session.output_modalities).toEqual(["text"]);
    expect(json.auto).toBe(true);
    expect(json.style).toBe("verbatim");
  });

  it("only the boolean true is Auto — a hand-typed truthy value is today's /live", async () => {
    for (const auto of ["true", 1, "1", {}, null]) {
      fetchSpy.mockClear();
      const { sent, json } = await mint({ target: "en", source: "es", auto });
      expect(sent!.session).toEqual(buildLiveSession({ target: "en", source: "es", ...SESSION }));
      expect(json.auto).toBe(false);
    }
  });

  it("is still behind guardSpend", async () => {
    const { res } = await mint({ target: "en", source: "es", auto: true }, false);
    expect(res.status).toBe(401);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("logs auto=1 on the mint line when on, and the line it always logged when off", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    await mint({ target: "en", source: "es", auto: true });
    await mint({ target: "en", source: "es" });
    const lines = info.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[taos-live-mint]"));
    expect(lines).toEqual([
      "[taos-live-mint] pair=es->en model=gpt-realtime style=verbatim auto=1 context_tokens=8000 ttl=120s",
      "[taos-live-mint] pair=es->en model=gpt-realtime style=summary context_tokens=150 ttl=120s"
    ]);
  });
});
