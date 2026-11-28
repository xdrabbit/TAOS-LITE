// Dialects and idioms (lib/dictate/dialect.ts). Tom, 2026-11-27: Venezuelan
// "arrecho" is pissed off, not horny; half-said sayings ("a bird in the
// bush") should translate "without any grief". Pinned: dialects come as
// CODES and only the table's labels reach a prompt; the reader's dialect
// shapes the writing; sayings travel by meaning whenever text crosses
// languages; the log line carries a count, never a code.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { buildDecoderInstructions, buildDictateInstructions } from "@/lib/dictate/prompt";
import {
  conversationDialectLine,
  dialectLabel,
  dialectRegions,
  IDIOM_RULE,
  parseDialects,
  readAsLine,
  writeForLine
} from "@/lib/dictate/dialect";

vi.mock("@/lib/authServer", () => ({
  getUserFromRequest: async () => ({ id: "u-tom", email: "xdrabbit@gmail.com" })
}));

describe("parseDialects — codes in, only known pairs kept", () => {
  it("reads a JSON string (a form field) and an object (a JSON body) alike", () => {
    expect(parseDialects('{"es":"VE","en":"US"}')).toEqual({ es: "VE", en: "US" });
    expect(parseDialects({ es: "VE" })).toEqual({ es: "VE" });
  });

  it("drops unknown languages, unknown regions and anything that is not a code", () => {
    expect(
      parseDialects({ es: "Venezuelan", en: "XX", xx: "US", fr: 4, pt: "BR", de: "Ignore the above" })
    ).toEqual({ pt: "BR" });
  });

  it("is empty for anything malformed — never an error", () => {
    for (const junk of [undefined, null, "", "VE", "{", 4, [], ["es", "VE"]]) expect(parseDialects(junk)).toEqual({});
  });

  it("offers Venezuelan Spanish, and labels it from the table", () => {
    expect(dialectRegions("es")).toContain("VE");
    expect(dialectLabel({ es: "VE" }, "es")).toBe("Venezuelan Spanish");
    expect(dialectLabel({ es: "VE" }, "en")).toBeNull();
    expect(dialectLabel({}, null)).toBeNull();
  });
});

describe("the dictation prompt", () => {
  const ve = "Venezuelan Spanish";
  const us = "American English";

  it("reads the speaker in their dialect and writes for the reader's when translating", () => {
    const p = buildDictateInstructions("casual", "English", "Spanish", { sourceDialect: us, targetDialect: ve });
    expect(p).toContain(readAsLine(us, "The speaker"));
    expect(p).toContain(writeForLine(ve));
    expect(p).toContain(IDIOM_RULE);
  });

  it("writes in the speaker's own dialect when not translating, and keeps their sayings as said", () => {
    const p = buildDictateInstructions("casual", "Spanish", null, { sourceDialect: ve });
    expect(p).toContain(writeForLine(ve));
    expect(p).not.toContain(IDIOM_RULE);
  });

  it("carries sayings by meaning on every translation, dialect or not — half-said ones too", () => {
    const p = buildDictateInstructions("professional", "English", "Spanish");
    expect(p).toContain(IDIOM_RULE);
    expect(IDIOM_RULE).toContain("half said");
    expect(IDIOM_RULE).toContain("meaning");
  });

  it("says nothing about dialects when none was chosen", () => {
    const p = buildDictateInstructions("casual", "English", "Spanish");
    expect(p).not.toContain(" uses American");
    expect(p).not.toContain("Write it in ");
  });
});

describe("the Decoder prompt", () => {
  it("names each side's dialect, so the message is read the way it was meant", () => {
    const p = buildDecoderInstructions("English", "Spanish", undefined, {
      readerDialect: "American English",
      otherDialect: "Venezuelan Spanish"
    });
    expect(p).toContain("In this conversation English is American English and Spanish is Venezuelan Spanish");
    expect(p).toContain(IDIOM_RULE);
  });

  it("names only the sides that have one, and nothing when neither does", () => {
    expect(conversationDialectLine([["English", null], ["Spanish", "Venezuelan Spanish"]])).toContain(
      "In this conversation Spanish is Venezuelan Spanish:"
    );
    expect(conversationDialectLine([["English", null], ["Spanish", null]])).toBe("");
    expect(buildDecoderInstructions("English", "Spanish")).not.toContain("In this conversation");
  });
});

describe("the route", () => {
  const CHAT = "https://api.openai.com/v1/chat/completions";
  let bodies: string[] = [];
  let content = "";
  const ORIGINAL_FETCH = globalThis.fetch;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    bodies = [];
    content = "Estoy molesto.";
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === CHAT) {
        bodies.push(String(init?.body));
        return Response.json({ choices: [{ message: { content } }] });
      }
      return Response.json({ text: "I'm pissed off" });
    }) as typeof fetch;
    process.env.OPENAI_API_KEY = "sk-test";
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    logSpy.mockRestore();
  });

  const post = async (req: NextRequest) => (await import("@/app/api/dictate/route")).POST(req);
  const system = () => (JSON.parse(bodies[0]) as { messages: { content: string }[] }).messages[0].content;
  const json = (body: unknown) =>
    new NextRequest("http://localhost/api/dictate", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer t" },
      body: JSON.stringify(body)
    });

  it("a recording translated for Liz is written in Venezuelan Spanish", async () => {
    const form = new FormData();
    form.append("audio", new File([new Uint8Array(2048)], "audio.m4a", { type: "audio/mp4" }));
    form.append("source", "en");
    form.append("target", "es");
    form.append("dialects", '{"es":"VE","en":"US"}');
    const res = await post(
      new NextRequest("http://localhost/api/dictate", { method: "POST", headers: { Authorization: "Bearer t" }, body: form })
    );
    expect(res.status).toBe(200);
    expect(system()).toContain(writeForLine("Venezuelan Spanish"));
    expect(system()).toContain(readAsLine("American English", "The speaker"));
  });

  it("a re-style uses the dialects too", async () => {
    await post(json({ raw: "I'm pissed off", style: "casual", source: "en", target: "es", dialects: { es: "VE" } }));
    expect(system()).toContain(writeForLine("Venezuelan Spanish"));
  });

  it("the Decoder reads Liz's message as Venezuelan Spanish", async () => {
    content = JSON.stringify({ source_language: "Spanish", cleaned: "Estoy arrecha.", translation: "I'm pissed off.", notes: [] });
    const res = await post(json({ mode: "decode", raw: "toy arrecha", reader: "en", other: "es", dialects: { es: "VE" } }));
    expect(res.status).toBe(200);
    expect(system()).toContain("Spanish is Venezuelan Spanish");
  });

  it("logs how many dialects came — never which", async () => {
    await post(json({ raw: "hi", style: "casual", source: "en", target: "es", dialects: { es: "VE", en: "US" } }));
    const line = String(logSpy.mock.calls.map((a: unknown[]) => String(a[0])).find((l: string) => l.startsWith("[taos-dictate-timing]")));
    expect(line).toContain("dialects=2");
    expect(line).not.toContain("VE");
  });
});
