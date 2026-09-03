// The arithmetic behind the number on the /call screen.
//
// This is the answer to a question that went unanswered for six weeks: the
// July 14/22 OpenAI spikes were noticed on a bill, and nobody could say which
// call, at what rate, or why. The meter exists so the next spike is a line on
// a screen while it happens rather than an invoice afterwards.
//
// Which makes accuracy the whole point, and it is easy to be wrong here in a
// direction that flatters the change: cached tokens arrive as a SUBSET of the
// input tokens, so pricing them on top would overstate a long call by exactly
// the amount the truncation cap is saving. Every field below was read off a
// real gpt-realtime response on 2026-08-27; the fixture is that payload.
import { describe, expect, it } from "vitest";
import {
  addResponseUsage,
  addTranscribedSeconds,
  addTtsCharacters,
  AUDIO_TOKENS_PER_SECOND,
  costLogLine,
  ELEVENLABS_USD_PER_1K_CHARS,
  emptySpend,
  formatUsd,
  formatUsdPerMinute,
  REALTIME_RATES_USD_PER_MTOK,
  spendUsd,
  usdPerMinute,
  type RealtimeUsage
} from "@/lib/call/cost";

/**
 * A real `response.done` usage payload, captured from a live gpt-realtime
 * session translating "Oye, ¿me escuchas bien?" into English.
 *
 * The 21 audio input tokens are the measurement the whole cost model rests
 * on: the utterance was 2.1 seconds long, and the API bills 1 token per
 * 100 ms of COMMITTED speech. The session had been streaming for far longer
 * than 2.1 seconds by then — the silence in between was not billed, which is
 * why /call has no client-side speech gate.
 */
const TEXT_MODE_USAGE: RealtimeUsage = {
  input_tokens: 148,
  output_tokens: 10,
  input_token_details: {
    text_tokens: 127,
    audio_tokens: 21,
    cached_tokens: 0,
    cached_tokens_details: { text_tokens: 0, audio_tokens: 0 }
  },
  output_token_details: { text_tokens: 10, audio_tokens: 0 }
};

/** The same utterance, same session settings, with the model speaking. */
const AUDIO_MODE_USAGE: RealtimeUsage = {
  input_tokens: 148,
  output_tokens: 59,
  input_token_details: {
    text_tokens: 127,
    audio_tokens: 21,
    cached_tokens: 0,
    cached_tokens_details: { text_tokens: 0, audio_tokens: 0 }
  },
  output_token_details: { text_tokens: 16, audio_tokens: 43 }
};

/** A later turn, where the cache has warmed up. Cached is a SUBSET of input. */
const CACHED_USAGE: RealtimeUsage = {
  input_tokens: 386,
  input_token_details: {
    text_tokens: 337,
    audio_tokens: 49,
    cached_tokens: 320,
    cached_tokens_details: { text_tokens: 320, audio_tokens: 0 }
  },
  output_token_details: { text_tokens: 9, audio_tokens: 0 }
};

describe("the rate table matches what the providers charge", () => {
  it("prices realtime audio at what OpenAI lists", () => {
    // Read 2026-08-27. If these move, the meter lies quietly — which is worse
    // than no meter, because someone will act on it.
    expect(REALTIME_RATES_USD_PER_MTOK.audioIn).toBe(32);
    expect(REALTIME_RATES_USD_PER_MTOK.audioOut).toBe(64);
    expect(REALTIME_RATES_USD_PER_MTOK.textIn).toBe(4);
    expect(REALTIME_RATES_USD_PER_MTOK.textOut).toBe(16);
  });

  it("knows audio is billed at one token per 100ms", () => {
    // Measured, not assumed: a 2.1-second utterance came back as 21 tokens.
    expect(AUDIO_TOKENS_PER_SECOND).toBe(10);
    expect(TEXT_MODE_USAGE.input_token_details?.audio_tokens).toBe(21);
  });
});

describe("folding real usage payloads", () => {
  it("adds up the fields the API actually sends", () => {
    const spend = addResponseUsage(emptySpend(), TEXT_MODE_USAGE);
    expect(spend.responses).toBe(1);
    expect(spend.audioInTokens).toBe(21);
    expect(spend.textInTokens).toBe(127);
    expect(spend.textOutTokens).toBe(10);
    expect(spend.audioOutTokens).toBe(0);
  });

  it("treats cached tokens as a subset, never as an extra charge", () => {
    // 337 text in, of which 320 cached: 17 at $4/Mtok and 320 at $0.40/Mtok.
    // Counting the cached ones twice would price this turn at nearly the full
    // rate and hide the saving the cache is making.
    const spend = addResponseUsage(emptySpend(), CACHED_USAGE);
    const expected =
      (17 * 4 + 320 * 0.4 + 49 * 32 + 9 * 16) / 1e6;
    expect(spendUsd(spend)).toBeCloseTo(expected, 10);
  });

  it("survives a payload with the details missing", () => {
    // A model or API version that stops sending token details must produce a
    // conservative zero, not a NaN that renders as "$NaN" mid-call.
    const spend = addResponseUsage(emptySpend(), { input_tokens: 100 });
    expect(spend.responses).toBe(1);
    expect(Number.isFinite(spendUsd(spend))).toBe(true);
    expect(spendUsd(spend)).toBe(0);
    expect(spendUsd(addResponseUsage(emptySpend(), null))).toBe(0);
  });
});

describe("the two voice modes, priced against each other", () => {
  // The whole argument for making the clone the default, in one assertion.
  const clone = addTtsCharacters(
    addResponseUsage(emptySpend("elevenlabs"), TEXT_MODE_USAGE),
    "Hey, can you hear me well?".length
  );
  const instant = addResponseUsage(emptySpend("elevenlabs"), AUDIO_MODE_USAGE);

  it("prices the same sentence cheaper through the app's own voices", () => {
    expect(spendUsd(clone)).toBeLessThan(spendUsd(instant));
  });

  it("shows the model's own speech is the largest line item", () => {
    // 43 audio output tokens at $64/Mtok is more than everything else in the
    // instant-mode response put together.
    const audioOutOnly = (43 * 64) / 1e6;
    expect(audioOutOnly).toBeGreaterThan(spendUsd(instant) - audioOutOnly);
  });

  it("prices ElevenLabs by the character, at its published rate", () => {
    const spend = addTtsCharacters(emptySpend("elevenlabs"), 1000);
    expect(spendUsd(spend)).toBeCloseTo(ELEVENLABS_USD_PER_1K_CHARS, 10);
  });

  it("prices the OpenAI engine by audio token instead", () => {
    // A phone with no personal-voice unlock falls back to OpenAI's voice, and
    // that engine bills by generated audio, not by character.
    const el = addTtsCharacters(emptySpend("elevenlabs"), 3400);
    const oa = addTtsCharacters(emptySpend("openai"), 3400);
    expect(spendUsd(oa)).toBeLessThan(spendUsd(el));
    expect(spendUsd(oa)).toBeGreaterThan(0);
  });
});

describe("the per-minute number Tom asked for", () => {
  it("stays at zero until there is enough call to divide by", () => {
    const spend = addResponseUsage(emptySpend(), AUDIO_MODE_USAGE);
    expect(usdPerMinute(spend, 0)).toBe(0);
    expect(usdPerMinute(spend, 3)).toBe(0);
    expect(usdPerMinute(spend, 60)).toBeGreaterThan(0);
  });

  it("divides by call time, not by speech time", () => {
    // Dollars per minute of CALL is the number that decides whether /call can
    // ever be sold. Per minute of speech would flatter it by however long the
    // two people spent listening to each other.
    let spend = addResponseUsage(emptySpend(), AUDIO_MODE_USAGE);
    spend = addTranscribedSeconds(spend, 2.1);
    expect(usdPerMinute(spend, 120)).toBeCloseTo(spendUsd(spend) / 2, 10);
  });

  it("bills transcription on committed speech, not on wall clock", () => {
    const quiet = addTranscribedSeconds(emptySpend(), 0);
    const talky = addTranscribedSeconds(emptySpend(), 240);
    expect(spendUsd(quiet)).toBe(0);
    expect(spendUsd(talky)).toBeCloseTo((240 / 60) * 0.003, 10);
  });
});

describe("what the meter and the log say", () => {
  it("never shows a bare zero for a call that has spent something", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(0.004)).toBe("<$0.01");
    expect(formatUsd(0.42)).toBe("$0.42");
    expect(formatUsdPerMinute(0.058)).toBe("$0.058/min");
  });

  it("writes one greppable line with the dollars on it", () => {
    let spend = addResponseUsage(emptySpend("elevenlabs"), TEXT_MODE_USAGE);
    spend = addTranscribedSeconds(spend, 2.1);
    spend = addTtsCharacters(spend, 26);
    const line = costLogLine({
      room: "AB123",
      mode: "clone",
      direction: "es->en",
      seconds: 600,
      spend
    });
    expect(line.startsWith("[taos-call-cost]")).toBe(true);
    expect(line).toContain("room=AB123");
    expect(line).toContain("pair=es->en");
    expect(line).toContain("speech_s=2.1");
    expect(line).toContain("audio_in_tok=21");
    expect(line).toContain("tts_chars=26");
    expect(line).toMatch(/usd=0\.\d{4}/);
    expect(line.split("\n")).toHaveLength(1);
  });

  it("names the transport and the speech count, and defaults them honestly", async () => {
    const spend = emptySpend("elevenlabs");
    const measured = costLogLine({
      room: "AB123",
      mode: "clone",
      direction: "es->en",
      seconds: 180,
      spend,
      transport: "relay",
      speechStarted: 12
    });
    expect(measured).toContain("transport=relay");
    expect(measured).toContain("speech_started=12");

    // A phone on an older build sends neither. "?" is not "direct", and 0 is
    // the truth about how many segments were REPORTED — the reader can tell
    // an absent field from a measured zero by the transport next to it.
    const silent = costLogLine({
      room: "AB123",
      mode: "clone",
      direction: "es->en",
      seconds: 180,
      spend
    });
    expect(silent).toContain("transport=?");
    expect(silent).toContain("speech_started=0");
  });
});
