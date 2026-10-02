// The "lessons from your own history" breakdown prototype
// (tools/translations-viewer/lib/lesson.mjs). No network: the OpenAI call is
// a fake fetch that returns a recorded-shape response.
import { describe, expect, it } from "vitest";

import {
  LESSON_SCHEMA,
  buildLessonPrompt,
  generateLesson,
  parseLesson,
  capChunks,
  cleanTrap,
  targetSide
} from "@/tools/translations-viewer/lib/lesson.mjs";

const record = (over: Record<string, unknown> = {}) => ({
  key: 1,
  source_lang: "es",
  target_lang: "en",
  original_text: "Ya te lo dije ayer",
  translation_text: "I already told you yesterday",
  ...over
});

const goodLesson = {
  target_language: "es",
  caveats: "",
  sentences: [
    {
      target: "Ya te lo dije ayer.",
      as_said: "",
      english: "I already told you yesterday.",
      words: [
        { text: "Ya", literal: "Already", lemma: "ya", gloss: "already", role: "adverb", note: "" },
        { text: "te", literal: "to-you", lemma: "te", gloss: "to you", role: "object pronoun", note: "" },
        { text: "lo", literal: "it", lemma: "lo", gloss: "it", role: "object pronoun", note: "" },
        { text: "dije", literal: "I-told", lemma: "decir", gloss: "I told", role: "verb", note: "the I is inside the verb" },
        { text: "ayer", literal: "yesterday", lemma: "ayer", gloss: "yesterday", role: "adverb", note: "" }
      ],
      english_order_trap: "Yo dije lo te ayer",
      order_points: [
        { rule: "Object pronouns before the verb", explanation: "te and lo sit in front of dije.", example: "Lo compré." }
      ],
      context_meaning: "Mild exasperation.",
      register: "tú, casual",
      chunks: ["ayer", "dije ayer", "te lo dije ayer", "Ya te lo dije ayer."]
    }
  ]
};

describe("targetSide — which side is being learned", () => {
  it("is the Spanish side whichever way the record ran", () => {
    expect(targetSide(record())?.text).toBe("Ya te lo dije ayer");
    const enToEs = record({
      source_lang: "en",
      target_lang: "es",
      original_text: "I already told you",
      translation_text: "Ya te lo dije"
    });
    expect(targetSide(enToEs)).toMatchObject({ lang: "es", text: "Ya te lo dije", other: "I already told you" });
  });

  it("picks the side in a chosen language, and says null when the record has none", () => {
    // Liz learning English from the same message Tom learns Spanish from.
    expect(targetSide(record(), "en")).toMatchObject({
      lang: "en",
      text: "I already told you yesterday",
      other: "Ya te lo dije ayer",
      otherLang: "es"
    });
    expect(targetSide(record(), "it")).toBeNull();
  });

  it("falls back to Spanish in the translation when a record names no languages", () => {
    const bare = record({ source_lang: null, target_lang: null, original_text: "hi", translation_text: "hola" });
    expect(targetSide(bare)).toMatchObject({ lang: "es", text: "hola" });
  });
});

describe("buildLessonPrompt — learning and explanation languages", () => {
  it("defaults to teaching Spanish to an English speaker, in English", () => {
    const { system, lang, explain } = buildLessonPrompt({ records: [record()] });
    expect(lang).toBe("es");
    expect(explain).toBe("en");
    expect(system).toMatch(/Spanish teacher for an adult native English speaker/);
    expect(system).toMatch(/WRITE THE LESSON IN ENGLISH/);
    expect(system).toMatch(/dije te/);
  });

  it("teaches English to a Spanish speaker, written in Spanish, with a Spanish speaker's mistakes", () => {
    const { system, user, lang } = buildLessonPrompt({ records: [record()], target: "en", explain: "es" });
    expect(lang).toBe("en");
    expect(system).toMatch(/English teacher for an adult native Spanish speaker/);
    expect(system).toMatch(/WRITE THE LESSON IN SPANISH/);
    expect(system).toMatch(/"Is raining"/);
    expect(system).toMatch(/"I have 30 years"/);
    expect(system).not.toMatch(/dije te/); // the English speaker's mistakes don't belong here
    // The English side is what gets taught.
    expect(user).toContain("English: I already told you yesterday");
    expect(user).toContain("Spanish: Ya te lo dije ayer");
  });

  it("describes any other pair generically", () => {
    const { system } = buildLessonPrompt({ records: [record()], target: "es", explain: "it" });
    expect(system).toMatch(/native Italian speaker/);
    expect(system).toMatch(/WRITE THE LESSON IN ITALIAN/);
  });
});

describe("buildLessonPrompt", () => {
  it("teaches word ORDER against English, fixes transcription slips, and asks for build-up chunks", () => {
    const { system } = buildLessonPrompt({ records: [record()] });
    expect(system).toMatch(/put them in English order/);
    expect(system).toMatch(/english_order_trap/);
    expect(system).toMatch(/Never teach an error as correct/);
    expect(system).toMatch(/from the END of the sentence/);
    expect(system).toMatch(/tú by default/);
  });

  it("keeps colloquial speech, warns on regional/vulgar words, and skips trivial fixes", () => {
    // Each line answers a failure seen in the 2026-09-26 stress run: "le dije
    // que si quería" rewritten to textbook "le pregunté si", "arrecho" taught
    // with no warning, and "I added the final period" reported as a caveat.
    const { system } = buildLessonPrompt({ records: [record()] });
    expect(system).toMatch(/COLLOQUIAL speech is not an/);
    expect(system).toMatch(/or vulgar/);
    expect(system).toMatch(/capital letter or a final period alone is not worth reporting/);
    expect(system).toMatch(/Only the sentence itself — no\s+commentary/);
  });

  it("carries the selection, the record, and context marked as not-to-teach", () => {
    const { user } = buildLessonPrompt({
      selection: "te lo dije",
      records: [record()],
      context: [record({ key: 2, original_text: "¿Qué pasó?", translation_text: "What happened?" })]
    });
    expect(user).toContain('"""te lo dije"""');
    expect(user).toContain("Spanish: Ya te lo dije ayer");
    expect(user).toContain("English: I already told you yesterday");
    expect(user).toMatch(/for context only — do not teach these/);
    expect(user).toContain("¿Qué pasó?");
  });
});

describe("parseLesson", () => {
  it("accepts a well-formed lesson", () => {
    const lesson = parseLesson(JSON.stringify(goodLesson));
    expect(lesson.sentences[0].words).toHaveLength(5);
    expect(lesson.sentences[0].chunks.at(-1)).toBe("Ya te lo dije ayer.");
  });

  it("assembles the word-for-word line in Spanish order from the words themselves", () => {
    // Asked for as one line, the model drifted back into English order. Built
    // from the per-word stand-ins, the order is the Spanish order by construction.
    const lesson = parseLesson(JSON.stringify(goodLesson));
    expect(lesson.sentences[0].literal).toBe("Already to-you it I-told yesterday");
  });

  it("strips commentary and quotes from the struck-through English-order line", () => {
    // Real outputs from the stress run.
    expect(cleanTrap("Espero que sientas mejor pronto. — This leaves out te because")).toBe(
      "Espero que sientas mejor pronto."
    );
    expect(cleanTrap("“Entonces yo pregunté a ella si quería venir” — English pushes you")).toBe(
      "Entonces yo pregunté a ella si quería venir"
    );
    expect(cleanTrap("*Vediamo ci domani alle otto.")).toBe("Vediamo ci domani alle otto.");
    expect(cleanTrap("¿Puedes recoger me en el aeropuerto?")).toBe("¿Puedes recoger me en el aeropuerto?");
    expect(cleanTrap(undefined)).toBe("");
  });

  it("caps the build-up at six steps, keeping the shortest first and the whole sentence last", () => {
    const ten = Array.from({ length: 10 }, (_, i) => `step ${i}`);
    const capped = capChunks(ten);
    expect(capped).toHaveLength(6);
    expect(capped[0]).toBe("step 0");
    expect(capped.at(-1)).toBe("step 9");
    expect(capChunks(["a", "b"])).toEqual(["a", "b"]);
  });

  it("refuses non-JSON and a lesson with nothing to teach", () => {
    expect(() => parseLesson("not json")).toThrow(/other than JSON/);
    expect(() => parseLesson(JSON.stringify({ sentences: [] }))).toThrow(/without any sentences/);
    expect(() =>
      parseLesson(JSON.stringify({ sentences: [{ target: "Hola", words: [] }] }))
    ).toThrow(/without any sentences/);
  });
});

describe("generateLesson", () => {
  it("sends the strict schema and returns the parsed lesson", async () => {
    let sent: Record<string, unknown> | null = null;
    const fakeFetch = (async (_url: string, init: { body: string }) => {
      sent = JSON.parse(init.body);
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: JSON.stringify(goodLesson) } }],
          usage: { prompt_tokens: 500, completion_tokens: 400 }
        }),
        { status: 200 }
      );
    }) as unknown as typeof fetch;

    const prompt = buildLessonPrompt({ records: [record()] });
    const { lesson, usage } = await generateLesson({ apiKey: "k", model: "gpt-4.1", prompt, fetchImpl: fakeFetch });
    expect(lesson.sentences[0].target).toBe("Ya te lo dije ayer.");
    expect(usage).toMatchObject({ prompt_tokens: 500 });
    expect(sent).toMatchObject({
      model: "gpt-4.1",
      response_format: { type: "json_schema", json_schema: { name: LESSON_SCHEMA.name, strict: true } }
    });
  });

  it("sends no temperature to a reasoning model, which rejects one", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    const fakeFetch = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(goodLesson) } }] }), {
        status: 200
      });
    }) as unknown as typeof fetch;
    const prompt = buildLessonPrompt({ records: [record()] });
    await generateLesson({ apiKey: "k", model: "gpt-5.5", prompt, fetchImpl: fakeFetch });
    await generateLesson({ apiKey: "k", model: "gpt-4.1", prompt, fetchImpl: fakeFetch });
    expect(bodies[0]).not.toHaveProperty("temperature");
    expect(bodies[1]).toHaveProperty("temperature", 0.3);
  });

  it("turns an API error into a readable message", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: { message: "Incorrect API key" } }), { status: 401 })) as unknown as typeof fetch;
    const prompt = buildLessonPrompt({ records: [record()] });
    await expect(generateLesson({ apiKey: "bad", model: "m", prompt, fetchImpl: fakeFetch })).rejects.toThrow(
      /Incorrect API key/
    );
  });
});
