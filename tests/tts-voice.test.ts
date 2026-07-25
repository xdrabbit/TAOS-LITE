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
