// Pins the cloned-voice rule after the 7/24 flip-flop (PR #5 reversed it for
// an afternoon; PR #6 restored it). If a change makes these fail, STOP and
// re-read Tom's words below before "fixing" the test.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_ELEVENLABS_VOICE,
  ELEVENLABS_LIZ_VOICE_ENV,
  ELEVENLABS_TOM_VOICE,
  elevenLabsVoiceId,
  lizElevenLabsVoiceId
} from "@/lib/tts/voice";

// Liz's id lives in the environment now (see the block comment in
// lib/tts/voice.ts). The rule tests below only care that her SLOT is chosen,
// so they use an obvious stand-in rather than whatever production is set to —
// the real value is one dashboard edit away and must not need a code change.
const LIZ = "liz-voice-id-from-env";
const savedLizEnv = process.env[ELEVENLABS_LIZ_VOICE_ENV];
beforeEach(() => {
  process.env[ELEVENLABS_LIZ_VOICE_ENV] = LIZ;
});
afterEach(() => {
  if (savedLizEnv === undefined) delete process.env[ELEVENLABS_LIZ_VOICE_ENV];
  else process.env[ELEVENLABS_LIZ_VOICE_ENV] = savedLizEnv;
  vi.restoreAllMocks();
});

describe("the clone IDs themselves (verified against the ElevenLabs account, 7/27)", () => {
  // Every earlier test checked the constants SYMBOLICALLY, so when the two
  // values were swapped (day one through 7/27) the suite stayed green while
  // production played the wrong person. This pins Tom's raw id to the
  // account's own voice name — GET /v1/voices says uOQZ… is named "tom". If it
  // fails, re-list the account's voices before touching anything.
  it("ELEVENLABS_TOM_VOICE is the account clone named 'tom'", () => {
    expect(ELEVENLABS_TOM_VOICE).toBe("uOQZaXDzEW5WoyNfLPne");
  });
});

describe("Liz's voice is configuration, not code (8/23 rollback)", () => {
  // 8/23 shipped atyoq… ("lizma5") as Liz and it was the wrong voice — an
  // ElevenLabs Voice DESIGN built from an accent prompt, which resolves, names
  // itself and returns 200 audio exactly like a clone does. No API check can
  // catch that; only Tom's ears did. So the id moved out of the repo, and what
  // is pinned here is the SHAPE of the lookup, not a value we cannot verify.

  it("reads Liz's id from ELEVENLABS_LIZ_VOICE_ID", () => {
    process.env[ELEVENLABS_LIZ_VOICE_ENV] = "some-retrained-voice";
    expect(lizElevenLabsVoiceId()).toBe("some-retrained-voice");
    expect(elevenLabsVoiceId("es", "en")).toBe("some-retrained-voice");
  });

  it("falls back LOUDLY to the stock voice when the variable is unset", () => {
    // Never silently to a hardcoded id: a stale constant sounds like a person,
    // so nothing downstream can flag it. The stock multilingual voice is
    // obviously not Liz to anyone listening, and this log says why.
    delete process.env[ELEVENLABS_LIZ_VOICE_ENV];
    delete process.env.ELEVENLABS_VOICE_ID;
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(lizElevenLabsVoiceId()).toBe(DEFAULT_ELEVENLABS_VOICE);
    expect(err).toHaveBeenCalledTimes(1);
    expect(String(err.mock.calls[0]?.[0])).toContain(ELEVENLABS_LIZ_VOICE_ENV);
  });

  it("has no personal voice id hardcoded in the resolution path", () => {
    // The two ids Liz's slot has ever held. If either reappears as a literal
    // in this module, the env indirection has been quietly undone.
    const src = readFileSync("lib/tts/voice.ts", "utf8");
    expect(src).not.toContain("tpOaz7u8rY4nup9rRUmh"); // "lizma2" — live value
    expect(src).not.toContain("atyoqJH9EPANrjf6QNDX"); // "lizma5" — the wrong one
  });
});

describe("cloned voice rule: the voice follows the SPEAKER (Tom, 7/24)", () => {
  it("Liz speaks Spanish -> her English translation plays in LIZ's clone", () => {
    // "English spoken is always Liz because Liz speaks Spanish and gets
    //  translated into English and I Tom the English speaker want to hear
    //  Liz's English."
    expect(elevenLabsVoiceId("es", "en")).toBe(LIZ);
  });

  it("Tom speaks English -> his Spanish translation plays in TOM's clone", () => {
    // "If I Tom speak English, it gets translated into Spanish and Liz wants
    //  to hear my voice speak Spanish."
    expect(elevenLabsVoiceId("en", "es")).toBe(ELEVENLABS_TOM_VOICE);
  });

  it("an explicit override beats the direction mapping", () => {
    expect(elevenLabsVoiceId("es", "en", "tom")).toBe(ELEVENLABS_TOM_VOICE);
    expect(elevenLabsVoiceId("en", "es", "liz")).toBe(LIZ);
  });

  describe("new language pairs (7/25, Mandarin) keep following the speaker", () => {
    it("Tom's English -> Mandarin plays in TOM's clone (multilingual TTS)", () => {
      expect(elevenLabsVoiceId("en", "zh")).toBe(ELEVENLABS_TOM_VOICE);
    });

    it("Liz's Spanish -> Mandarin plays in LIZ's clone", () => {
      expect(elevenLabsVoiceId("es", "zh")).toBe(LIZ);
    });

    it("a Mandarin guest has no clone — their translations use the default voice", () => {
      delete process.env.ELEVENLABS_VOICE_ID;
      expect(elevenLabsVoiceId("zh", "en")).toBe(DEFAULT_ELEVENLABS_VOICE);
      expect(elevenLabsVoiceId("zh", "es")).toBe(DEFAULT_ELEVENLABS_VOICE);
    });

    it("the trip languages follow the same rule (8/17: Bosnian, Italian)", () => {
      delete process.env.ELEVENLABS_VOICE_ID;
      // Tom orders dinner in Italy: his English plays to the waiter in HIS
      // voice speaking Italian (the multilingual model renders the clone).
      expect(elevenLabsVoiceId("en", "it")).toBe(ELEVENLABS_TOM_VOICE);
      expect(elevenLabsVoiceId("en", "bs")).toBe(ELEVENLABS_TOM_VOICE);
      // Liz's Spanish does the same through her clone.
      expect(elevenLabsVoiceId("es", "it")).toBe(LIZ);
      expect(elevenLabsVoiceId("es", "bs")).toBe(LIZ);
      // The waiter has no clone — their reply reads in the stock multilingual
      // voice. Do NOT add per-language voice IDs here: the rule is that the
      // voice follows the SPEAKER, not the output language (see the header).
      expect(elevenLabsVoiceId("it", "en")).toBe(DEFAULT_ELEVENLABS_VOICE);
      expect(elevenLabsVoiceId("bs", "es")).toBe(DEFAULT_ELEVENLABS_VOICE);
    });

    it("Cantonese behaves the same: Tom's English -> yue in his clone; a yue guest gets default", () => {
      delete process.env.ELEVENLABS_VOICE_ID;
      expect(elevenLabsVoiceId("en", "yue")).toBe(ELEVENLABS_TOM_VOICE);
      expect(elevenLabsVoiceId("yue", "en")).toBe(DEFAULT_ELEVENLABS_VOICE);
      expect(elevenLabsVoiceId("yue", "zh")).toBe(DEFAULT_ELEVENLABS_VOICE);
    });
  });

  describe("unmapped directions fall back to the configured/default voice", () => {
    const saved = process.env.ELEVENLABS_VOICE_ID;
    afterEach(() => {
      if (saved === undefined) delete process.env.ELEVENLABS_VOICE_ID;
      else process.env.ELEVENLABS_VOICE_ID = saved;
    });

    it("uses ELEVENLABS_VOICE_ID when set", () => {
      process.env.ELEVENLABS_VOICE_ID = "custom-voice-id";
      expect(elevenLabsVoiceId(undefined, undefined)).toBe("custom-voice-id");
    });

    it("uses the built-in default when env is unset", () => {
      delete process.env.ELEVENLABS_VOICE_ID;
      expect(elevenLabsVoiceId(undefined, undefined)).toBe(DEFAULT_ELEVENLABS_VOICE);
      // Same-language pairs are unmapped too — never guess a clone.
      expect(elevenLabsVoiceId("en", "en")).toBe(DEFAULT_ELEVENLABS_VOICE);
    });
  });
});
