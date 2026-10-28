// Mixed-language turns on the home screen (Tom + Liz, 2026-10-27).
//
// One recording can hold English and then a Spanish interruption. The model
// now returns ordered segments, each in its speaker's language, and:
//   * a one-language turn is ONE segment, and one segment is today's response
//     exactly — same fields, one TTS call, no join;
//   * a bad segment code is folded into a neighbour, never guessed;
//   * a reply with no usable segments falls back to the old single-source shape;
//   * the readout asks /api/tts once per segment with THAT segment's source
//     language (voice-follows-speaker picks the clone) and joins ONCE;
//   * the joined blob is what Play caches and what Share hands over.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAutoDetectInstructions } from "@/lib/translate/prompts";
import {
  joinMp3Blobs,
  parseAutoSegments,
  segmentsFromPayload,
  speechForSegments,
  topLevelFromSegments,
  type TranslatedSegment
} from "@/lib/translate/segments";
import { audioFrames } from "@/lib/tts/mp3";

const EN = { code: "en", label: "English" };
const ES = { code: "es", label: "Spanish" };

// ── The prompt ──────────────────────────────────────────────────────────────
describe("auto-detect prompt: segments", () => {
  for (const tone of ["casual", "detailed"] as const) {
    const p = buildAutoDetectInstructions(ES, EN, tone);

    it(`names both languages of the pair (${tone})`, () => {
      expect(p).toContain("either Spanish or English");
      expect(p).toContain("each Spanish segment into English, each English segment into Spanish");
    });

    it(`splits only on a whole clause or sentence, never a borrowed word (${tone})`, () => {
      expect(p).toContain("ONLY where the language changes for a whole clause or sentence");
      expect(p).toContain("Never split on a single borrowed word, a name, a number, or an interjection");
      expect(p).toContain(`"okay", "sí" or "hola"`);
    });

    it(`keeps a one-language text as exactly one segment (${tone})`, () => {
      expect(p).toContain("Text in one language is EXACTLY ONE segment");
    });

    it(`asks for ordered segments in JSON, with the unambiguous field name (${tone})`, () => {
      expect(p).toContain("Respond ONLY with JSON");
      expect(p).toContain(`{"segments":[{"source_lang":"es"|"en","original":`);
      expect(p).toContain("in the order they were said");
      expect(p).toContain("NOT the language you translated into");
      expect(p).not.toContain(`"lang":`);
    });

    it(`keeps every existing rule (${tone})`, () => {
      expect(p).toContain("FIRST-PERSON");
      expect(p).toContain(`never narrate "he says"`);
      expect(p).toContain("a question gets translated, never answered");
      expect(p).toContain(`put "…" where it breaks off`);
      expect(p).toContain("NEVER fill a gap with a guessed word");
      expect(p).toContain("closest to the original meaning");
      expect(p).toContain("use the familiar form (tú)");
    });
  }

  it("keeps the casual fence in casual", () => {
    expect(buildAutoDetectInstructions(EN, ES, "casual")).toContain(
      "NEVER ADD anything the speaker did not say"
    );
  });
});

// ── The parser ──────────────────────────────────────────────────────────────
describe("parseAutoSegments", () => {
  const warn = vi.fn();
  beforeEach(() => warn.mockClear());

  it("reads one segment as today's turn: the full transcript as the original", () => {
    const content = JSON.stringify({
      segments: [{ source_lang: "en", original: "where's the car", translation: "¿dónde está el carro?" }]
    });
    const out = parseAutoSegments(content, "Where's the car?", "en", "es", warn);
    expect(out.segments).toEqual([
      { sourceLanguage: "en", targetLanguage: "es", original: "Where's the car?", translation: "¿dónde está el carro?" }
    ]);
    expect(out.fallback).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps two segments in order, each with its own direction", () => {
    const content = JSON.stringify({
      segments: [
        { source_lang: "en", original: "Let's leave at five.", translation: "Vámonos a las cinco." },
        { source_lang: "es", original: "No, a las seis.", translation: "No, at six." }
      ]
    });
    const { segments } = parseAutoSegments(content, "Let's leave at five. No, a las seis.", "en", "es", warn);
    expect(segments.map((s) => [s.sourceLanguage, s.targetLanguage])).toEqual([
      ["en", "es"],
      ["es", "en"]
    ]);
    expect(segments[0].original).toBe("Let's leave at five.");
    expect(segments[1].translation).toBe("No, at six.");
  });

  // Live probe 2026-10-26: "Can you grab the charger from the kitchen? Okay,
  // gracias." came back 3/3 as TWO English segments. Same-language neighbours
  // merge, so a one-language turn is still one segment, one clone, today's shape.
  it("merges neighbouring segments in the same language back into one", () => {
    const content = JSON.stringify({
      segments: [
        { source_lang: "en", original: "Can you grab the charger?", translation: "¿Puedes agarrar el cargador?" },
        { source_lang: "en", original: "Okay, gracias.", translation: "Vale, gracias." }
      ]
    });
    const out = parseAutoSegments(content, "Can you grab the charger? Okay, gracias.", "en", "es", warn);
    expect(out.segments).toEqual([
      {
        sourceLanguage: "en",
        targetLanguage: "es",
        original: "Can you grab the charger? Okay, gracias.",
        translation: "¿Puedes agarrar el cargador? Vale, gracias."
      }
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("folds a segment with a code outside the pair into its neighbour, and logs no text", () => {
    const content = JSON.stringify({
      segments: [
        { source_lang: "en", original: "We need milk.", translation: "Necesitamos leche." },
        { source_lang: "pt", original: "And bread.", translation: "Y pan." },
        { source_lang: "es", original: "Ya compré.", translation: "I already bought it." }
      ]
    });
    const out = parseAutoSegments(content, "x", "en", "es", warn);
    expect(out.folded).toBe(1);
    // Folded into the segment before it, and merged — one clone per language run.
    expect(out.segments).toHaveLength(2);
    expect(out.segments[0]).toMatchObject({
      sourceLanguage: "en",
      original: "We need milk. And bread.",
      translation: "Necesitamos leche. Y pan."
    });
    expect(out.segments[1].sourceLanguage).toBe("es");
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls[0][0] as string;
    expect(line).toMatch(/^\[translate\] auto-detect segment 2 returned no usable source_lang \(got "pt"\); folded into en$/);
    expect(line).not.toContain("bread");
  });

  it("folds a bad FIRST segment into the one after it", () => {
    const content = JSON.stringify({
      segments: [
        { source_lang: null, original: "Mira.", translation: "Look." },
        { source_lang: "es", original: "Ahí está.", translation: "There it is." }
      ]
    });
    const out = parseAutoSegments(content, "Mira. Ahí está.", "en", "es", warn);
    expect(out.segments).toHaveLength(1);
    expect(out.segments[0].sourceLanguage).toBe("es");
    // One segment left: the original is the transcript, as in a one-language turn.
    expect(out.segments[0].original).toBe("Mira. Ahí está.");
    expect(out.segments[0].translation).toBe("Look. There it is.");
  });

  it("never logs a long bogus code in full", () => {
    const content = JSON.stringify({
      segments: [{ source_lang: "this is somebody's private sentence", original: "a", translation: "b" }]
    });
    parseAutoSegments(content, "a", "en", "es", warn);
    expect(warn.mock.calls[0][0]).not.toContain("private sentence");
  });

  it("falls back to today's single-source shape when the reply has no segments", () => {
    const out = parseAutoSegments(
      JSON.stringify({ source_lang: "es", translation: "Let's go." }),
      "Vámonos.",
      "en",
      "es",
      warn
    );
    expect(out.fallback).toBe(true);
    expect(out.segments).toEqual([
      { sourceLanguage: "es", targetLanguage: "en", original: "Vámonos.", translation: "Let's go." }
    ]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("garbage: logs the old coin-flip line and still throws on no translation", () => {
    expect(() => parseAutoSegments("not json at all", "hola", "en", "es", warn)).toThrow(
      "Translation response was empty."
    );
    expect(warn.mock.calls[0][0]).toBe(
      "[translate] auto-detect returned no usable source_lang (got null); defaulting to en"
    );
    expect(() =>
      parseAutoSegments(JSON.stringify({ segments: [{ source_lang: "en" }] }), "hola", "en", "es", warn)
    ).toThrow("Translation response was empty.");
  });
});

describe("topLevelFromSegments", () => {
  it("joins several segments with a newline and takes direction from the first", () => {
    expect(
      topLevelFromSegments([
        { sourceLanguage: "en", targetLanguage: "es", original: "A.", translation: "Uno." },
        { sourceLanguage: "es", targetLanguage: "en", original: "Dos.", translation: "Two." }
      ])
    ).toEqual({ original: "A.\nDos.", translation: "Uno.\nTwo.", sourceLanguage: "en", targetLanguage: "es" });
  });
});

// ── The route ───────────────────────────────────────────────────────────────
vi.mock("@/lib/spendGuard", () => ({
  guardSpend: async () => ({ ok: true, user: { id: "u1", email: "t@example.com" }, anonymous: false })
}));
let transcript = "";
vi.mock("@/lib/translate/transcribe", () => ({
  transcribeAudio: async () => transcript,
  autoTranscribeModel: () => "gpt-4o-transcribe"
}));

let modelReply = "";
const fetchSpy = vi.fn(
  async () =>
    new Response(JSON.stringify({ choices: [{ message: { content: modelReply } }] }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    })
);

const { POST } = await import("@/app/api/translate/route");

function autoRequest(fields: Record<string, string> = {}) {
  const form = new FormData();
  form.append("audio", new File([new Uint8Array([1, 2, 3])], "turn.webm", { type: "audio/webm" }));
  form.append("sourceLanguage", "auto");
  form.append("targetLanguage", "auto");
  form.append("tone", "casual");
  form.append("pairA", "en");
  form.append("pairB", "es");
  for (const [k, v] of Object.entries(fields)) form.set(k, v);
  return new Request("http://localhost/api/translate", { method: "POST", body: form });
}

describe("/api/translate auto response", () => {
  let logSpy: { mock: { calls: unknown[][] }; mockRestore: () => void };
  beforeEach(() => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.stubGlobal("fetch", fetchSpy);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    logSpy.mockRestore();
  });

  it("one segment: exactly today's fields, in today's order, no segments array", async () => {
    transcript = "Where's the car?";
    modelReply = JSON.stringify({
      segments: [{ source_lang: "en", original: "Where's the car?", translation: "¿Dónde está el carro?" }]
    });
    const res = await POST(autoRequest() as never);
    const body = await res.json();
    expect(Object.keys(body)).toEqual([
      "original",
      "translation",
      "sourceLanguage",
      "targetLanguage",
      "tone",
      "autoDetected"
    ]);
    expect(body).toEqual({
      original: "Where's the car?",
      translation: "¿Dónde está el carro?",
      sourceLanguage: "en",
      targetLanguage: "es",
      tone: "casual",
      autoDetected: true
    });
  });

  it("two segments: joined top-level fields from the first, plus the ordered segments", async () => {
    transcript = "Let's leave at five. No, a las seis.";
    modelReply = JSON.stringify({
      segments: [
        { source_lang: "en", original: "Let's leave at five.", translation: "Vámonos a las cinco." },
        { source_lang: "es", original: "No, a las seis.", translation: "No, at six." }
      ]
    });
    const body = await (await POST(autoRequest() as never)).json();
    expect(body.original).toBe("Let's leave at five.\nNo, a las seis.");
    expect(body.translation).toBe("Vámonos a las cinco.\nNo, at six.");
    expect(body.sourceLanguage).toBe("en");
    expect(body.targetLanguage).toBe("es");
    expect(body.autoDetected).toBe(true);
    expect(body.segments).toEqual([
      { sourceLanguage: "en", targetLanguage: "es", original: "Let's leave at five.", translation: "Vámonos a las cinco." },
      { sourceLanguage: "es", targetLanguage: "en", original: "No, a las seis.", translation: "No, at six." }
    ]);
  });

  it("logs one body-less [taos-translate] line per auto turn", async () => {
    transcript = "Let's leave at five. No, a las seis.";
    modelReply = JSON.stringify({
      segments: [
        { source_lang: "en", original: "Let's leave at five.", translation: "Vámonos a las cinco." },
        { source_lang: "es", original: "No, a las seis.", translation: "No, at six." }
      ]
    });
    await POST(autoRequest() as never);
    const lines = logSpy.mock.calls.map((c) => String(c[0])).filter((l) => l.startsWith("[taos-translate]"));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      new RegExp(`^\\[taos-translate\\] auto=1 segments=2 detected=en,es src_chars=${transcript.length} ctx=0 transcriber=gpt-4o-transcribe ms=\\d+$`)
    );
    expect(lines[0]).not.toMatch(/five|seis|example\.com/);
  });

  it("the old single-source reply still works (fallback)", async () => {
    transcript = "Vámonos.";
    modelReply = JSON.stringify({ source_lang: "es", translation: "Let's go." });
    const body = await (await POST(autoRequest() as never)).json();
    expect(body).toMatchObject({ original: "Vámonos.", translation: "Let's go.", sourceLanguage: "es", targetLanguage: "en" });
    expect(body.segments).toBeUndefined();
  });
});

// ── The client ──────────────────────────────────────────────────────────────
describe("segmentsFromPayload", () => {
  const pair = ["es", "en"] as const;
  it("keeps two or more segments of the pair's languages", () => {
    const out = segmentsFromPayload(
      [
        { sourceLanguage: "en", targetLanguage: "es", original: "a", translation: "uno" },
        { sourceLanguage: "es", targetLanguage: "en", original: "dos", translation: "two" }
      ],
      pair
    );
    expect(out?.map((s) => s.targetLanguage)).toEqual(["es", "en"]);
  });
  it("is null for one segment, a missing array, or a language outside the pair", () => {
    expect(segmentsFromPayload(undefined, pair)).toBeNull();
    expect(segmentsFromPayload([{ sourceLanguage: "en", translation: "x" }], pair)).toBeNull();
    expect(
      segmentsFromPayload(
        [
          { sourceLanguage: "en", translation: "x" },
          { sourceLanguage: "fr", translation: "y" }
        ],
        pair
      )
    ).toBeNull();
  });
});

const TWO: TranslatedSegment[] = [
  { sourceLanguage: "en", targetLanguage: "es", original: "Let's go.", translation: "Vámonos." },
  { sourceLanguage: "es", targetLanguage: "en", original: "Ya voy.", translation: "Coming." }
];

describe("speechForSegments", () => {
  it("asks once per segment with THAT segment's languages, and joins once", async () => {
    const speakOne = vi.fn(async (seg: TranslatedSegment) => new Blob([seg.sourceLanguage]));
    const joined = new Blob(["joined"]);
    const join = vi.fn(async () => joined);
    const out = await speechForSegments(TWO, speakOne, join);
    expect(speakOne.mock.calls.map(([seg]) => [seg.sourceLanguage, seg.targetLanguage, seg.translation])).toEqual([
      ["en", "es", "Vámonos."],
      ["es", "en", "Coming."]
    ]);
    expect(join).toHaveBeenCalledTimes(1);
    expect(await Promise.all((join.mock.calls[0] as unknown as [Blob[]])[0].map((b) => b.text()))).toEqual([
      "en",
      "es"
    ]);
    expect(out).toBe(joined);
  });

  it("never joins for one segment", async () => {
    const blob = new Blob(["only"]);
    const join = vi.fn();
    const out = await speechForSegments([TWO[0]], async () => blob, join);
    expect(out).toBe(blob);
    expect(join).not.toHaveBeenCalled();
  });

  it("leaves out a text-only segment, and is null when none can be spoken", async () => {
    const join = vi.fn();
    const blob = new Blob(["es"]);
    expect(await speechForSegments(TWO, async (s) => (s.sourceLanguage === "es" ? blob : null), join)).toBe(blob);
    expect(await speechForSegments(TWO, async () => null, join)).toBeNull();
    expect(join).not.toHaveBeenCalled();
  });
});

// Two tiny valid MPEG-1 Layer III streams (44.1 kHz, 128 kbps, mono frames of
// 417 bytes), the format ElevenLabs returns.
function mp3(frames: number, fill: number): Uint8Array {
  const header = [0xff, 0xfb, 0x90, 0xc4];
  const len = 417;
  const out = new Uint8Array(len * frames).fill(fill);
  for (let i = 0; i < frames; i += 1) out.set(header, i * len);
  return out;
}

describe("joinMp3Blobs", () => {
  it("joins through the one joiner: [Xing][first][gap][second]", async () => {
    const out = new Uint8Array(await (await joinMp3Blobs([new Blob([mp3(10, 1) as BlobPart]), new Blob([mp3(6, 2) as BlobPart])], 300)).arrayBuffer());
    const frames = audioFrames(out); // the Xing frame is skipped as metadata
    const gap = Math.ceil(0.3 * (44100 / 1152));
    expect(frames).toHaveLength(10 + gap + 6);
    expect(String.fromCharCode(...out.subarray(4 + 17, 4 + 17 + 4))).toBe("Xing");
  });
});

describe("the home screen wiring", () => {
  const shell = readFileSync(join(process.cwd(), "components/TranslatorShell.tsx"), "utf8");
  const audio = shell.slice(shell.indexOf("async function audioForResult"), shell.indexOf("async function speak("));
  const share = shell.slice(shell.indexOf("async function audioForShare"), shell.indexOf("async function shareTranslationAudio"));

  it("speaks a mixed turn per segment with each segment's source language", () => {
    expect(audio).toContain("speechForSegments(mixed");
    expect(audio).toContain("sourceLanguage: seg.sourceLanguage");
    expect(audio).toContain("targetLanguage: seg.targetLanguage");
  });

  it("caches whatever came back — the joined blob for a mixed turn — as the result's audio", () => {
    expect(audio).toMatch(/const request = speech\.then\(\(blob\) => \{/);
    expect(audio).toContain("resultAudioRef.current = blob;");
  });

  it("Share hands over the cached (joined) audio, never a fresh single-voice line", () => {
    expect(share).toContain("if (existing && (subscriber || !offered)) return { blob: existing, signed: false };");
    expect(share).toContain("if (!existing && (subscriber || segmentsRef.current)) {");
    expect(audio).toContain("signoffOfferRef.current = { generation, available: false };");
  });

  it("saves a mixed turn as one row per segment, each with its own direction", () => {
    expect(shell).toContain("source_lang: seg.sourceLanguage");
    expect(shell).toContain("target_lang: seg.targetLanguage");
  });
});
