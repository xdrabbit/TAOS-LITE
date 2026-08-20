// The personal-voice gate (8/17): cloned voices belong to Tom and Liz only.
// TAOS is about to be handed to strangers by QR code on the trip, and their
// translations must come back in the stock multilingual voice.
//
// tests/tts-voice.test.ts pins the rule this gate sits IN FRONT of — the voice
// follows the SPEAKER. Nothing here changes that rule: an unlocked device is
// expected to behave EXACTLY as TAOS did before this gate existed, which is
// what the first describe block below asserts pair by pair.
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ELEVENLABS_VOICE,
  ELEVENLABS_LIZ_VOICE,
  ELEVENLABS_TOM_VOICE,
  elevenLabsVoiceId,
  gatedElevenLabsVoiceId
} from "@/lib/tts/voice";
import { personalVoiceUnlocked } from "@/lib/tts/personalVoice";

const savedVoiceEnv = process.env.ELEVENLABS_VOICE_ID;
afterEach(() => {
  if (savedVoiceEnv === undefined) delete process.env.ELEVENLABS_VOICE_ID;
  else process.env.ELEVENLABS_VOICE_ID = savedVoiceEnv;
});

describe("unlocked (Tom's and Liz's phones) — the speaker rule, untouched", () => {
  it("resolves identically to the ungated rule for every mapped direction", () => {
    delete process.env.ELEVENLABS_VOICE_ID;
    const pairs = [
      ["en", "es"],
      ["es", "en"],
      ["en", "zh"],
      ["es", "zh"],
      ["en", "it"],
      ["en", "bs"],
      ["es", "it"],
      ["en", "yue"],
      ["it", "en"],
      ["yue", "en"],
      ["en", "en"]
    ] as const;
    for (const [src, tgt] of pairs) {
      expect(gatedElevenLabsVoiceId(true, src, tgt)).toBe(elevenLabsVoiceId(src, tgt));
    }
  });

  it("Tom speaking English still plays his clone; Liz's Spanish still plays hers", () => {
    expect(gatedElevenLabsVoiceId(true, "en", "es")).toBe(ELEVENLABS_TOM_VOICE);
    expect(gatedElevenLabsVoiceId(true, "es", "en")).toBe(ELEVENLABS_LIZ_VOICE);
  });

  it("the explicit override still wins on an unlocked device", () => {
    expect(gatedElevenLabsVoiceId(true, "es", "en", "tom")).toBe(ELEVENLABS_TOM_VOICE);
    expect(gatedElevenLabsVoiceId(true, "en", "es", "liz")).toBe(ELEVENLABS_LIZ_VOICE);
  });
});

describe("locked (every phone that scanned the QR) — no clone is reachable", () => {
  it("directions that WOULD map to a clone get the default voice instead", () => {
    delete process.env.ELEVENLABS_VOICE_ID;
    expect(gatedElevenLabsVoiceId(false, "en", "es")).toBe(DEFAULT_ELEVENLABS_VOICE);
    expect(gatedElevenLabsVoiceId(false, "es", "en")).toBe(DEFAULT_ELEVENLABS_VOICE);
    expect(gatedElevenLabsVoiceId(false, "en", "it")).toBe(DEFAULT_ELEVENLABS_VOICE);
    expect(gatedElevenLabsVoiceId(false, "es", "bs")).toBe(DEFAULT_ELEVENLABS_VOICE);
    expect(gatedElevenLabsVoiceId(false, "en", "yue")).toBe(DEFAULT_ELEVENLABS_VOICE);
  });

  it("an explicit voice override does NOT get past the gate", () => {
    // The one request shape that names a person outright. If this ever returns
    // a clone id, a stranger can ask for Liz's voice by hand.
    delete process.env.ELEVENLABS_VOICE_ID;
    expect(gatedElevenLabsVoiceId(false, "es", "en", "tom")).toBe(DEFAULT_ELEVENLABS_VOICE);
    expect(gatedElevenLabsVoiceId(false, "en", "es", "liz")).toBe(DEFAULT_ELEVENLABS_VOICE);
  });

  it("never returns either clone id, whatever the arguments", () => {
    const clones = new Set([ELEVENLABS_TOM_VOICE, ELEVENLABS_LIZ_VOICE]);
    const langs = ["en", "es", "zh", "yue", "it", "bs", undefined] as const;
    const overrides = ["tom", "liz", undefined] as const;
    for (const src of langs) {
      for (const tgt of langs) {
        for (const voice of overrides) {
          expect(clones.has(gatedElevenLabsVoiceId(false, src, tgt, voice))).toBe(false);
        }
      }
    }
  });

  it("still honours a configured stock voice via ELEVENLABS_VOICE_ID", () => {
    process.env.ELEVENLABS_VOICE_ID = "custom-voice-id";
    expect(gatedElevenLabsVoiceId(false, "en", "es")).toBe("custom-voice-id");
  });
});

describe("personalVoiceUnlocked — the header check /api/tts runs per request", () => {
  it("unlocks on an exact match", () => {
    expect(personalVoiceUnlocked("trip-2026", "trip-2026")).toBe(true);
  });

  it("tolerates the whitespace a phone keyboard adds", () => {
    expect(personalVoiceUnlocked("  trip-2026  ", "trip-2026\n")).toBe(true);
  });

  it("rejects a wrong code, including near misses and prefixes", () => {
    expect(personalVoiceUnlocked("trip-2027", "trip-2026")).toBe(false);
    expect(personalVoiceUnlocked("trip-202", "trip-2026")).toBe(false);
    expect(personalVoiceUnlocked("trip-2026x", "trip-2026")).toBe(false);
    expect(personalVoiceUnlocked("TRIP-2026", "trip-2026")).toBe(false);
  });

  it("rejects a missing or blank header", () => {
    expect(personalVoiceUnlocked(null, "trip-2026")).toBe(false);
    expect(personalVoiceUnlocked(undefined, "trip-2026")).toBe(false);
    expect(personalVoiceUnlocked("", "trip-2026")).toBe(false);
    expect(personalVoiceUnlocked("   ", "trip-2026")).toBe(false);
  });

  it("fails CLOSED when TAOS_PERSONAL_VOICE_CODE is unset", () => {
    // A preview deploy missing the env var must lock everyone out, not let
    // everyone in — including a client that sends an empty header to match.
    expect(personalVoiceUnlocked("anything", undefined)).toBe(false);
    expect(personalVoiceUnlocked("anything", "")).toBe(false);
    expect(personalVoiceUnlocked("", "")).toBe(false);
    expect(personalVoiceUnlocked(null, null)).toBe(false);
  });
});
