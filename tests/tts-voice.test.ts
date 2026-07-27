// Pins the cloned-voice rule after the 7/24 flip-flop (PR #5 reversed it for
// an afternoon; PR #6 restored it). If a change makes these fail, STOP and
// re-read Tom's words below before "fixing" the test.
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_ELEVENLABS_VOICE,
  ELEVENLABS_LIZ_VOICE,
  ELEVENLABS_TOM_VOICE,
  elevenLabsVoiceId
} from "@/lib/tts/voice";

describe("the clone IDs themselves (verified against the ElevenLabs account, 7/27)", () => {
  // Every earlier test checked the constants SYMBOLICALLY, so when the two
  // values were swapped (day one through 7/27) the suite stayed green while
  // production played the wrong person. These pin the raw IDs to the account's
  // own voice names — GET /v1/voices says uOQZ… is named "tom" and tpOaz… is
  // named "lizma2". If these fail, re-list the account's voices before
  // touching anything.
  it("ELEVENLABS_TOM_VOICE is the account clone named 'tom'", () => {
    expect(ELEVENLABS_TOM_VOICE).toBe("uOQZaXDzEW5WoyNfLPne");
  });

  it("ELEVENLABS_LIZ_VOICE is the account clone named 'lizma2'", () => {
    expect(ELEVENLABS_LIZ_VOICE).toBe("tpOaz7u8rY4nup9rRUmh");
  });
});

describe("cloned voice rule: the voice follows the SPEAKER (Tom, 7/24)", () => {
  it("Liz speaks Spanish -> her English translation plays in LIZ's clone", () => {
    // "English spoken is always Liz because Liz speaks Spanish and gets
    //  translated into English and I Tom the English speaker want to hear
    //  Liz's English."
    expect(elevenLabsVoiceId("es", "en")).toBe(ELEVENLABS_LIZ_VOICE);
  });

  it("Tom speaks English -> his Spanish translation plays in TOM's clone", () => {
    // "If I Tom speak English, it gets translated into Spanish and Liz wants
    //  to hear my voice speak Spanish."
    expect(elevenLabsVoiceId("en", "es")).toBe(ELEVENLABS_TOM_VOICE);
  });

  it("an explicit override beats the direction mapping", () => {
    expect(elevenLabsVoiceId("es", "en", "tom")).toBe(ELEVENLABS_TOM_VOICE);
    expect(elevenLabsVoiceId("en", "es", "liz")).toBe(ELEVENLABS_LIZ_VOICE);
  });

  describe("new language pairs (7/25, Mandarin) keep following the speaker", () => {
    it("Tom's English -> Mandarin plays in TOM's clone (multilingual TTS)", () => {
      expect(elevenLabsVoiceId("en", "zh")).toBe(ELEVENLABS_TOM_VOICE);
    });

    it("Liz's Spanish -> Mandarin plays in LIZ's clone", () => {
      expect(elevenLabsVoiceId("es", "zh")).toBe(ELEVENLABS_LIZ_VOICE);
    });

    it("a Mandarin guest has no clone — their translations use the default voice", () => {
      delete process.env.ELEVENLABS_VOICE_ID;
      expect(elevenLabsVoiceId("zh", "en")).toBe(DEFAULT_ELEVENLABS_VOICE);
      expect(elevenLabsVoiceId("zh", "es")).toBe(DEFAULT_ELEVENLABS_VOICE);
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
