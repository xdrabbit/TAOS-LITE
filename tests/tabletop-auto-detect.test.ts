// /tabletop auto-detect (Liz and Tom, 2026-10-27): one phone between two
// people, each phrase routed by the language tag the model opens its response
// with. Pins the tag reader (whole and streamed), the miss rule (no guessing),
// the founders + TAOS_TABLETOP_AUTO_ENABLED gate on both the shell and the
// mint route, the brain fallback, and the two new fields on [taos-tabletop].
import { readFileSync } from "node:fs";
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTagStream, parseTag } from "@/lib/tabletop/autoDetect";
import { autoBrain } from "@/lib/tabletop/brain";
import { buildAutoInstructions, buildTurnInstructions } from "@/lib/tabletop/instructions";
import { buildTabletopSession } from "@/lib/tabletop/session";
import { emptyTally, parseSummary, summarize, tabletopLogLine } from "@/lib/tabletop/metrics";
import { tabletopAutoEnabled, tabletopAutoVisibleTo } from "@/lib/release";

const mocks = vi.hoisted(() => ({ user: vi.fn() }));
vi.mock("@/lib/authServer", () => ({ getUserFromRequest: mocks.user }));

const FOUNDER = { id: "tom", email: "xdrabbit@gmail.com" };
const CUSTOMER = { id: "ana", email: "ana@test.invalid" };
const ES_EN = ["es", "en"] as const;
const ES_ZH = ["es", "zh"] as const;

/** Feed deltas through one stream; return what rendered and the verdict. */
function stream(pair: readonly [string, string], deltas: string[]) {
  const s = createTagStream(pair);
  let text = "";
  const verdicts: unknown[] = [];
  for (const d of deltas) {
    const r = s.push(d);
    text += r.text;
    if (r.verdict) verdicts.push(r.verdict);
  }
  const e = s.end();
  text += e.text;
  if (e.verdict) verdicts.push(e.verdict);
  return { text, verdicts };
}

describe("parseTag — a whole response", () => {
  it("[es] hola → the es pane, text 'hola'", () => {
    expect(parseTag("[es] hola", ES_EN)).toEqual({ verdict: { kind: "hit", code: "es" }, text: "hola" });
  });

  it("[en] with pair es/zh → miss; the text is left as it came", () => {
    expect(parseTag("[en] hello", ES_ZH)).toEqual({ verdict: { kind: "miss" }, text: "[en] hello" });
  });

  it("no tag → miss, never a guess from the words", () => {
    // Plainly Spanish, and still a miss: the direction comes from the tag or
    // from the last one known — never from guessing at the text.
    expect(parseTag("¿Dónde está la farmacia?", ES_EN)).toEqual({
      verdict: { kind: "miss" },
      text: "¿Dónde está la farmacia?"
    });
  });

  it("reads a tag case-insensitively and tolerates leading space", () => {
    expect(parseTag("  [ZH] 你好", ES_ZH)).toEqual({ verdict: { kind: "hit", code: "zh" }, text: "你好" });
  });

  it("a tag that is not at the front is not a tag", () => {
    expect(parseTag("hola [es]", ES_EN).verdict).toEqual({ kind: "miss" });
  });
});

describe("createTagStream — the tag arrives in pieces", () => {
  it("split across two chunks ([e + s] …) parses exactly like one", () => {
    const r = stream(ES_EN, ["[e", "s] hola", " amigo"]);
    expect(r.verdicts).toEqual([{ kind: "hit", code: "es" }]);
    expect(r.text).toBe("hola amigo");
  });

  it("never renders a half tag while it waits", () => {
    const s = createTagStream(ES_EN);
    expect(s.push("[")).toEqual({ text: "" });
    expect(s.push("e")).toEqual({ text: "" });
    expect(s.push("n]")).toEqual({ text: "" });
    expect(s.push(" ")).toEqual({ text: "" });
    expect(s.push("Where")).toEqual({ verdict: { kind: "hit", code: "en" }, text: "Where" });
    expect(s.push(" is it?")).toEqual({ text: " is it?" });
  });

  it("the separator space live.ts sends between responses is swallowed", () => {
    expect(stream(ES_EN, [" ", "[en]", " Thank you."]).text).toBe("Thank you.");
  });

  it("an off-pair tag in pieces is a miss and keeps its text", () => {
    const r = stream(ES_ZH, ["[e", "n] hello"]);
    expect(r.verdicts).toEqual([{ kind: "miss" }]);
    expect(r.text).toBe("[en] hello");
  });

  it("no tag is a miss decided on the first character, with nothing held back", () => {
    const s = createTagStream(ES_EN);
    expect(s.push("Hola")).toEqual({ verdict: { kind: "miss" }, text: "Hola" });
    expect(s.push(", ¿qué tal?")).toEqual({ text: ", ¿qué tal?" });
  });

  it("a bracket that never closes is a miss, not a hang", () => {
    const r = stream(ES_EN, ["[hola que tal"]);
    expect(r.verdicts).toEqual([{ kind: "miss" }]);
    expect(r.text).toBe("[hola que tal");
  });

  it("a response that stops mid-tag decides on end()", () => {
    expect(stream(ES_EN, ["[es"]).verdicts).toEqual([{ kind: "miss" }]);
    expect(stream(ES_EN, ["[es]"])).toEqual({ text: "", verdicts: [{ kind: "hit", code: "es" }] });
  });

  it("an empty response is neither a hit nor a miss", () => {
    expect(stream(ES_EN, [" "])).toEqual({ text: "", verdicts: [] });
    expect(stream(ES_EN, [])).toEqual({ text: "", verdicts: [] });
  });
});

describe("the gate: founders AND TAOS_TABLETOP_AUTO_ENABLED=1", () => {
  it("the flag is exactly '1'", () => {
    expect(tabletopAutoEnabled("1")).toBe(true);
    expect(tabletopAutoEnabled(" 1 ")).toBe(true);
    for (const v of [undefined, "", "0", "true", "yes"]) expect(tabletopAutoEnabled(v)).toBe(false);
  });

  it("both halves, or nobody", () => {
    expect(tabletopAutoVisibleTo(FOUNDER.email, true)).toBe(true);
    expect(tabletopAutoVisibleTo(FOUNDER.email, false)).toBe(false);
    expect(tabletopAutoVisibleTo(CUSTOMER.email, true)).toBe(false);
    expect(tabletopAutoVisibleTo(null, true)).toBe(false);
  });
});

describe("auto-detect always runs on openai", () => {
  it("falls back from gemini, and says it did", () => {
    expect(autoBrain("gemini", true)).toEqual({ brain: "openai", autoFellBack: true });
    expect(autoBrain("openai", true)).toEqual({ brain: "openai", autoFellBack: false });
  });

  it("leaves the brain A/B alone when auto is off", () => {
    expect(autoBrain("gemini", false)).toEqual({ brain: "gemini", autoFellBack: false });
    expect(autoBrain("openai", false)).toEqual({ brain: "openai", autoFellBack: false });
  });
});

describe("the session: only the instructions move", () => {
  const base = { direction: { source: "es", target: "en" }, model: "gpt-realtime", transcribeModel: "t" };

  it("auto swaps in the two-language prompt and nothing else", () => {
    const plain = buildTabletopSession(base);
    const auto = buildTabletopSession({ ...base, auto: { a: "es", b: "en" } });
    expect(auto.instructions).toBe(buildAutoInstructions({ a: "es", b: "en" }));
    expect(plain.instructions).toBe(buildTurnInstructions(base.direction));
    expect({ ...auto, instructions: null }).toEqual({ ...plain, instructions: null });
    expect(auto.output_modalities).toEqual(["text"]);
  });
});

describe("[taos-tabletop] gains auto= and detect_miss=, keeps every field", () => {
  it("appends the two fields after est_usd", () => {
    const t = { ...emptyTally("openai", 0), auto: true, detectMiss: 3 };
    const line = tabletopLogLine(summarize(t, 60_000));
    expect(line).toBe(
      "[taos-tabletop] brain=openai seconds=60 segments=0 first_partial_ms_p50=0 first_partial_ms_p95=0 " +
        "segment_done_ms_p50=0 segment_done_ms_p95=0 errors=0 reconnects=0 est_usd=0.0000 auto=1 detect_miss=3"
    );
  });

  it("a phone on the previous build (no auto fields) still logs, as 0", () => {
    const s = summarize(emptyTally("openai", 0), 60_000);
    const { auto: _a, detect_miss: _d, ...old } = s;
    void _a;
    void _d;
    expect(parseSummary(old)).toEqual({ ...s, auto: 0, detect_miss: 0 });
  });

  it("present but not a number is refused — no text reaches the log", () => {
    const s = summarize(emptyTally("openai", 0), 60_000);
    expect(parseSummary({ ...s, detect_miss: "hola" })).toBeNull();
    expect(parseSummary({ ...s, auto: 2 })).toBeNull();
    expect(parseSummary({ ...s, detect_miss: -1 })).toBeNull();
  });
});

describe("the mint route builds the auto prompt only for the gate", () => {
  const fetchSpy = vi.fn(
    async (_input: unknown, _init?: unknown) =>
      new Response(JSON.stringify({ value: "ek_test" }), {
        status: 200,
        headers: { "Content-Type": "application/json" }
      })
  );
  const ORIGINAL_FETCH = globalThis.fetch;
  const saved = {
    key: process.env.OPENAI_API_KEY,
    flag: process.env.TAOS_TABLETOP_AUTO_ENABLED
  };

  beforeEach(() => {
    fetchSpy.mockClear();
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    process.env.OPENAI_API_KEY = "sk-test";
    vi.spyOn(console, "info").mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    vi.restoreAllMocks();
    for (const [k, v] of [
      ["OPENAI_API_KEY", saved.key],
      ["TAOS_TABLETOP_AUTO_ENABLED", saved.flag]
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function mintedInstructions(user: unknown, flag: string | undefined): Promise<string> {
    mocks.user.mockResolvedValue(user);
    if (flag === undefined) delete process.env.TAOS_TABLETOP_AUTO_ENABLED;
    else process.env.TAOS_TABLETOP_AUTO_ENABLED = flag;
    const { POST } = await import("@/app/api/tabletop/realtime/route");
    const res = await POST(
      new NextRequest("http://localhost/api/tabletop/realtime", {
        method: "POST",
        headers: { authorization: "Bearer t", "content-type": "application/json" },
        body: JSON.stringify({ source: "es", target: "en", auto: true })
      })
    );
    expect(res.status).toBe(200);
    const init = fetchSpy.mock.calls[0][1] as { body?: string };
    return JSON.parse(String(init.body)).session.instructions;
  }

  it("founder + flag → the auto prompt", async () => {
    expect(await mintedInstructions(FOUNDER, "1")).toBe(buildAutoInstructions({ a: "es", b: "en" }));
  });

  it("customer asking for auto → today's tapped-turn prompt", async () => {
    expect(await mintedInstructions(CUSTOMER, "1")).toBe(
      buildTurnInstructions({ source: "es", target: "en" })
    );
  });

  it("founder without the flag → today's tapped-turn prompt", async () => {
    expect(await mintedInstructions(FOUNDER, undefined)).toBe(
      buildTurnInstructions({ source: "es", target: "en" })
    );
  });
});

describe("the shell wiring", () => {
  const shell = readFileSync("components/TabletopShell.tsx", "utf8");
  const page = readFileSync("app/tabletop/page.tsx", "utf8");

  it("the page hands the server flag to the shell as a boolean", () => {
    expect(page).toContain("autoEnabled={tabletopAutoEnabled()}");
  });

  it("the toggle shows only behind the gate, ON by default", () => {
    expect(shell).toContain("setAutoAllowed(tabletopAutoVisibleTo(data.session?.user?.email, autoEnabled))");
    expect(shell).toContain("{autoAllowed && engine === \"live\" ? (");
    expect(shell).toMatch(/const \[autoOn, setAutoOn\] = useState\(true\)/);
  });

  it("reuses the home screen's copy key — no new strings", () => {
    expect(shell).toContain("{words.autoDetectLanguage}");
    expect(shell).not.toMatch(/Detectar idioma/);
  });

  it("a miss lands on the last known direction and is counted", () => {
    expect(shell).toContain("detectMiss: m.tally.detectMiss + 1");
    expect(shell).toContain('detect: run.miss ? "miss" : "hit"');
  });

  it("the readout follows the tag: the speaker is the OTHER end of what was written", () => {
    expect(shell).toContain("source = otherInPair(a.pair, verdict.code as Lang)");
    expect(shell).toContain("targetLanguage: ex.to ?? otherInPair(pairNow, ex.from)");
  });
});
