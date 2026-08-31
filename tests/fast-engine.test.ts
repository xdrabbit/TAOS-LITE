// The /fast engine: which provider takes a pair, what the literal prompt says,
// and how the catalog maps onto Azure's language list.
//
// The measured bake-off that decided all of this lives in
// tests/live-fire/fast-engine.measure.ts and docs/fast-engine.md; this file
// fences the conclusions so the next edit cannot quietly undo them.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AZURE_CODE_OVERRIDES,
  AZURE_UNSUPPORTED,
  azureCode,
  azureCredentials,
  sideForDetected
} from "@/lib/fast/azure";
import { fastEngineFor, getFastModel } from "@/lib/fast/engine";
import {
  buildLiteralAutoInstructions,
  buildLiteralInstructions,
  LITERAL_RULE,
  PARTIAL_INPUT_RULE
} from "@/lib/fast/prompt";
import { readFileSync } from "node:fs";
import { LANGUAGES } from "@/lib/languages/catalog";

const KEY = process.env.AZURE_TRANSLATOR_KEY;
const REGION = process.env.AZURE_TRANSLATOR_REGION;
const MODEL = process.env.OPENAI_FAST_MODEL;

function withAzure(): void {
  process.env.AZURE_TRANSLATOR_KEY = "az-test";
  process.env.AZURE_TRANSLATOR_REGION = "westus2";
}

beforeEach(() => {
  delete process.env.AZURE_TRANSLATOR_KEY;
  delete process.env.AZURE_TRANSLATOR_REGION;
  delete process.env.OPENAI_FAST_MODEL;
});

afterEach(() => {
  if (KEY === undefined) delete process.env.AZURE_TRANSLATOR_KEY;
  else process.env.AZURE_TRANSLATOR_KEY = KEY;
  if (REGION === undefined) delete process.env.AZURE_TRANSLATOR_REGION;
  else process.env.AZURE_TRANSLATOR_REGION = REGION;
  if (MODEL === undefined) delete process.env.OPENAI_FAST_MODEL;
  else process.env.OPENAI_FAST_MODEL = MODEL;
});

describe("the Azure credentials are a PAIR, not a key", () => {
  it("is not configured with neither, nor with only one of the two", () => {
    expect(azureCredentials()).toBeNull();
    process.env.AZURE_TRANSLATOR_KEY = "az-test";
    // A Translator key is scoped to its resource's region and the API rejects
    // it without the region header, so half the credential is none of it.
    expect(azureCredentials()).toBeNull();
    delete process.env.AZURE_TRANSLATOR_KEY;
    process.env.AZURE_TRANSLATOR_REGION = "westus2";
    expect(azureCredentials()).toBeNull();
  });

  it("is configured with both", () => {
    withAzure();
    expect(azureCredentials()).toEqual({ key: "az-test", region: "westus2" });
  });

  it("does NOT read the Speech resource's key — a different resource entirely", () => {
    // AZURE_SPEECH_KEY belongs to the tutor's pronunciation scoring. Reusing
    // it here would turn "Tom has not created the Translator resource" into a
    // 401 nobody can read.
    process.env.AZURE_SPEECH_KEY = "speech-key";
    process.env.AZURE_SPEECH_REGION = "eastus";
    expect(azureCredentials()).toBeNull();
    delete process.env.AZURE_SPEECH_KEY;
    delete process.env.AZURE_SPEECH_REGION;
  });
});

describe("catalog → Azure language codes", () => {
  it("maps every catalog language to an Azure code, or to nothing on purpose", () => {
    const unsupported = new Set<string>(AZURE_UNSUPPORTED);
    for (const language of LANGUAGES) {
      const mapped = azureCode(language.code);
      if (unsupported.has(language.code)) expect(mapped).toBeNull();
      else expect(mapped).toBeTruthy();
    }
  });

  it("covers ninety of the hundred — the ten are named, not discovered", () => {
    const mapped = LANGUAGES.filter((l) => azureCode(l.code) !== null);
    expect(mapped).toHaveLength(LANGUAGES.length - AZURE_UNSUPPORTED.length);
    expect(AZURE_UNSUPPORTED).toHaveLength(10);
  });

  it("renames only the five that genuinely differ, by script or register", () => {
    expect(AZURE_CODE_OVERRIDES).toEqual({
      zh: "zh-Hans",
      tl: "fil",
      no: "nb",
      mn: "mn-Cyrl",
      sr: "sr-Cyrl"
    });
    expect(azureCode("zh")).toBe("zh-Hans");
    expect(azureCode("yue")).toBe("yue"); // Cantonese is its own row in both
    expect(azureCode("la")).toBeNull();
  });

  it("reads Azure's detected language back onto the right side of the pair", () => {
    expect(sideForDetected("en", ["en", "es"])).toBe("en");
    expect(sideForDetected("es", ["en", "es"])).toBe("es");
    // Detection answers "zh" where the target codes are "zh-Hans": the base
    // code has to match, or Chinese would never resolve.
    expect(sideForDetected("zh", ["en", "zh"])).toBe("zh");
    expect(sideForDetected("zh-Hant", ["en", "zh"])).toBe("zh");
    // A third language is not a direction this screen has, so it reads as the
    // phone owner's side and the answer stays inside the pair.
    expect(sideForDetected("fr", ["en", "es"])).toBe("en");
    expect(sideForDetected("", ["en", "es"])).toBe("en");
  });
});

describe("which engine takes a pair", () => {
  it("falls to the LLM, and says why, when the resource does not exist", () => {
    expect(fastEngineFor("en", "es")).toEqual({
      engine: "openai",
      fallback: "azure_not_configured"
    });
  });

  it("prefers Azure once the resource is configured", () => {
    withAzure();
    expect(fastEngineFor("en", "es")).toEqual({ engine: "azure", fallback: null });
  });

  it("falls to the LLM for the ten languages Azure cannot do at all", () => {
    withAzure();
    // /fast is wired to the whole catalog. A screen that worked for ninety
    // languages and died on ten would not be.
    expect(fastEngineFor("en", "la")).toEqual({
      engine: "openai",
      fallback: "azure_unsupported_language"
    });
    expect(fastEngineFor("yi", "en")).toEqual({
      engine: "openai",
      fallback: "azure_unsupported_language"
    });
  });
});

describe("the literal model is chosen for /fast, not inherited", () => {
  it("defaults to gpt-4.1-nano", () => {
    // Measured 2026-08-30: the most literal of the three candidates AND a
    // quarter the price of gpt-4.1-mini, which drifted idiomatic on exactly
    // the inputs this screen exists for. docs/fast-engine.md has the table.
    expect(getFastModel()).toBe("gpt-4.1-nano");
  });

  it("does not follow OPENAI_PARAPHRASE_MODEL", () => {
    // That var is the app's "fast mini tier" knob for the CONVERSATIONAL
    // routes. A screen whose brand is the literal register must not move when
    // somebody retunes the register of a different one.
    process.env.OPENAI_PARAPHRASE_MODEL = "gpt-4.1";
    expect(getFastModel()).toBe("gpt-4.1-nano");
    delete process.env.OPENAI_PARAPHRASE_MODEL;
  });

  it("is overridable on its own var", () => {
    process.env.OPENAI_FAST_MODEL = "gpt-5.4-nano";
    expect(getFastModel()).toBe("gpt-5.4-nano");
  });
});

describe("the literal prompt", () => {
  it("names both languages", () => {
    const p = buildLiteralInstructions("English", "Polish");
    expect(p).toContain("English");
    expect(p).toContain("Polish");
  });

  it("asks for the plain, dictionary sense and forbids idiomatic substitution", () => {
    expect(LITERAL_RULE).toContain("PLAINLY and DIRECTLY");
    expect(LITERAL_RULE).toContain("dictionary sense");
    expect(LITERAL_RULE).toContain("Do NOT substitute an idiomatic equivalent");
  });

  // The measured regression this rule exists for (2026-08-30). The first
  // draft said "word for word, keeping the original word order" and produced
  // "jak ja dostanę się do the" — an English article standing in a Polish
  // sentence — plus "ile to to kosztuje" and the wrong gender on "dwie kawy".
  // Literal is a REGISTER, not permission to break the target language.
  it("states the grammar floor out loud — literal never means broken", () => {
    expect(LITERAL_RULE).toContain("GRAMMATICAL");
    expect(LITERAL_RULE).toContain("never leave a source word untranslated");
  });

  // The rule this surface needed that no other one does: on an as-you-type
  // box most inputs are half-typed, and a model handed a partial phrase will
  // finish the thought unless told not to.
  it("tells the model to stop where the typing stopped", () => {
    expect(PARTIAL_INPUT_RULE).toContain("still be being typed");
    expect(PARTIAL_INPUT_RULE).toContain("never continue, complete, or guess the rest");
    // Worded as an instruction, never as a warning about incompleteness —
    // naming the failure mode primes it (the 7/27 dropout fence).
    expect(PARTIAL_INPUT_RULE).not.toMatch(/cut off|missing words|incomplete/i);
  });

  it("carries the house translate-only fence, in both modes", () => {
    for (const p of [
      buildLiteralInstructions("English", "Spanish"),
      buildLiteralAutoInstructions("en", "es")
    ]) {
      expect(p).toContain("translate the question — never answer it");
      expect(p).toContain("NEVER ADD anything the writer did not say");
    }
  });

  it("carries the literal, partial and output rules in auto mode too", () => {
    const p = buildLiteralAutoInstructions("en", "pl");
    expect(p).toContain(LITERAL_RULE);
    expect(p).toContain(PARTIAL_INPUT_RULE);
    expect(p).toContain("no preamble");
  });

  it("scopes auto-detect to the pair's two languages, by name and by code", () => {
    const p = buildLiteralAutoInstructions("en", "pl");
    expect(p).toContain("either English or Polish");
    expect(p).toContain('"sourceLang":"en"|"pl"');
  });

  // The 7/27 inversion: an auto-detect prompt whose field read as "the
  // language of this response" made the model report the OUTPUT language and
  // inverted every turn. Say INPUT, twice.
  it("names the field for the INPUT's language, never the translation's", () => {
    const p = buildLiteralAutoInstructions("en", "es");
    expect(p).toContain("Detect the language of the ORIGINAL INPUT");
    expect(p).toContain("sourceLang is the language the INPUT was written in");
  });
});

describe("the /fast speaker button and tier 2", () => {
  it("asks the catalog before drawing a speaker, not after tapping it", () => {
    // requestSpeech answers `null` for a text-only language rather than
    // failing, which is right for a caller that already committed to asking.
    // But on a screen this bare an icon that silently does nothing is worse
    // than no icon — so the gate is `isTextOnlyLanguage`, checked before the
    // button renders. Asserted by source read because there is no DOM here;
    // what matters is that the question is asked at all.
    const src = readFileSync(new URL("../components/FastShell.tsx", import.meta.url), "utf8");
    expect(src).toContain("isTextOnlyLanguage");
    const gate = src.slice(src.indexOf("const speakable"), src.indexOf("const speakable") + 220);
    expect(gate).toContain("!isTextOnlyLanguage(target)");
  });

  it("has tier-2 languages to hide it for — this is not a hypothetical", () => {
    const textOnly = LANGUAGES.filter((l) => !l.tts);
    expect(textOnly.length).toBeGreaterThan(0);
  });
});
