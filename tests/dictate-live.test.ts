// Live notes (lib/dictate/live.ts). Tom, 2026-11-27: "let people listen and it
// will hear it, translate it and keep it for them like notes". Pinned: a piece
// comes back heard + translated into the OTHER side of the pair; one language
// on both sides is plain note-taking; silence is 422; the summary is written
// for the reader; the log line never carries text.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import {
  buildLiveInstructions,
  buildSummaryInstructions,
  liveTranscribeHint,
  liveUserMessage,
  LIVE_MAX_CONTEXT_CHARS,
  parseLivePiece,
  parseLiveSummary
} from "@/lib/dictate/live";

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async () => ({ id: "u-tom", email: "xdrabbit@gmail.com" })
}));

const ES = { code: "es", label: "Spanish", dialect: "Venezuelan Spanish" };
const EN = { code: "en", label: "English", dialect: null };

describe("live prompts", () => {
  it("two languages: translate into the other side, with dialects and idioms", () => {
    const p = buildLiveInstructions(EN, ES, ["Lu"]);
    expect(p).toContain(`"en" if the new piece is mostly English, "es" if it is mostly Spanish`);
    expect(p).toContain("Spanish is Venezuelan Spanish");
    expect(p).toContain("Idioms and sayings travel by their meaning");
    expect(p).toContain("Lu");
  });
  it("one language: note-taking, no translation", () => {
    const p = buildLiveInstructions(EN, EN);
    expect(p).toContain(`"text" — the same as "heard"`);
    expect(p).not.toContain("translation");
  });
  it("the transcription hint names both languages, then our words", () => {
    expect(liveTranscribeHint(EN, ES, "Names and words: Lu.")).toBe(
      "The speech is in English or Spanish, sometimes both. Names and words: Lu."
    );
    expect(liveTranscribeHint(EN, EN, undefined)).toBe("The speech is in English.");
  });
  it("context rides in the user message, clipped to its tail", () => {
    expect(liveUserMessage("hola", "")).toBe("hola");
    const long = "x".repeat(LIVE_MAX_CONTEXT_CHARS + 50) + "END";
    const msg = liveUserMessage("hola", long);
    expect(msg).toContain("END");
    expect(msg.endsWith("New piece:\nhola")).toBe(true);
    expect(msg.length).toBeLessThan(LIVE_MAX_CONTEXT_CHARS + 60);
  });
  it("the summary is written in the reader's language", () => {
    expect(buildSummaryInstructions("Spanish")).toContain("Write the notes in Spanish");
  });
});

describe("parsing", () => {
  it("a Spanish piece translates into English", () => {
    expect(parseLivePiece('{"lang":"es","heard":"Hola.","text":"Hello."}', "en", "es")).toEqual({
      heardLang: "es",
      heard: "Hola.",
      textLang: "en",
      text: "Hello."
    });
  });
  it("an unknown lang is read as the other side; empty text falls back to heard", () => {
    expect(parseLivePiece('{"lang":"fr","heard":"Salut."}', "en", "es")).toEqual({
      heardLang: "es",
      heard: "Salut.",
      textLang: "en",
      text: "Salut."
    });
  });
  it("no heard text is an error", () => {
    expect(() => parseLivePiece('{"lang":"en","text":"x"}', "en", "es")).toThrow();
    expect(() => parseLivePiece("not json", "en", "es")).toThrow();
  });
  it("summary: points trimmed and capped, summary required", () => {
    const s = parseLiveSummary(JSON.stringify({ title: "Dinner", summary: "We ate.", points: [" a ", "", ...Array(12).fill("p")] }));
    expect(s.title).toBe("Dinner");
    expect(s.points[0]).toBe("a");
    expect(s.points.length).toBe(8);
    expect(() => parseLiveSummary('{"title":"x"}')).toThrow();
  });
});

describe("/api/dictate live + summarize", () => {
  const CHAT = "https://api.openai.com/v1/chat/completions";
  let bodies: string[] = [];
  let stt: string[] = [];
  let heardText = "hola como estas";
  let content = "";
  const ORIGINAL_FETCH = globalThis.fetch;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    bodies = [];
    stt = [];
    heardText = "hola como estas";
    content = JSON.stringify({ lang: "es", heard: "Hola, ¿cómo estás?", text: "Hi, how are you?" });
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === CHAT) {
        bodies.push(String(init?.body));
        return Response.json({ choices: [{ message: { content } }] });
      }
      const f = init?.body as FormData;
      stt.push(String(f.get("prompt") ?? ""));
      return Response.json({ text: heardText });
    }) as typeof fetch;
    process.env.OPENAI_API_KEY = "sk-test";
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    logSpy.mockRestore();
  });

  const post = async (req: NextRequest) => (await import("@/app/api/dictate/route")).POST(req);
  const livePost = (fields: Record<string, string>) => {
    const form = new FormData();
    form.append("audio", new File([new Uint8Array(2048)], "piece.m4a", { type: "audio/mp4" }));
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    return post(new NextRequest("http://localhost/api/dictate", { method: "POST", headers: { Authorization: "Bearer t" }, body: form }));
  };
  const logLine = () =>
    String(logSpy.mock.calls.map((a: unknown[]) => String(a[0])).find((l: string) => l.startsWith("[taos-dictate-timing]")));

  it("a piece comes back heard and translated", async () => {
    const res = await livePost({ mode: "live", mine: "en", theirs: "es", dialects: '{"es":"VE"}', context: "Earlier line." });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      mode: "live",
      heardLang: "es",
      heard: "Hola, ¿cómo estás?",
      textLang: "en",
      text: "Hi, how are you?"
    });
    const user = (JSON.parse(bodies[0]) as { messages: { content: string }[] }).messages[1].content;
    expect(user).toContain("Earlier line.");
    const line = logLine();
    expect(line).toContain("mode=live");
    expect(line).not.toContain("Hola");
    expect(line).not.toContain("Earlier");
  });

  it("silence is 422 and no model call is made", async () => {
    heardText = "";
    const res = await livePost({ mode: "live", mine: "en", theirs: "es" });
    expect(res.status).toBe(422);
    expect(bodies.length).toBe(0);
  });

  it("needs two known languages", async () => {
    expect((await livePost({ mode: "live", mine: "en" })).status).toBe(400);
    expect((await livePost({ mode: "live", mine: "en", theirs: "zz" })).status).toBe(400);
  });

  it("summarize returns title, summary and points for the reader", async () => {
    content = JSON.stringify({ title: "Cena", summary: "Hablamos de la cena.", points: ["Viernes a las 8"] });
    const res = await post(
      new NextRequest("http://localhost/api/dictate", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
        body: JSON.stringify({ mode: "summarize", reader: "es", raw: "Dinner Friday at 8." })
      })
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ mode: "summarize", title: "Cena", summary: "Hablamos de la cena.", points: ["Viernes a las 8"] });
    expect((JSON.parse(bodies[0]) as { messages: { content: string }[] }).messages[0].content).toContain("Write the notes in Spanish");
    expect(logLine()).toContain("mode=summary");
  });
});
