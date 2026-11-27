// The silence guard (2026-11-27): the transcriber must never hand back a
// sentence for audio that had no speech in it. Found building Dictate — two
// seconds of silence came back "I need a doctor." and went on as a normal
// turn. These pin:
//
//   1. the judgement, against REAL provider responses captured from this
//      repo's prompts (tests/fixtures/stt-silence/provider-payloads.json —
//      what gpt-4o-transcribe, gpt-4o-mini-transcribe and whisper-1 actually
//      returned for the clips beside it). Silence and room tone are dropped;
//      quiet speech, one-word turns and normal speech are kept.
//   2. low confidence alone is a suspicion: a second model is asked, and the
//      transcript is dropped only when that model hears nothing either
//   3. the level: digital silence and room tone under −60 dBFS are silence
//      whatever the transcriber wrote; quiet speech is not
//   4. the request: confidence is asked for in the SAME call, only of models
//      that were measured, and TAOS_STT_SILENCE_GUARD=0 puts the request back
//      exactly as it was
//   5. the route: silence through /api/translate is the existing 422 and no
//      translation is ever requested
//   6. every transcription call in the app goes through the guard
//   7. the phone's check blocks only a clip it decoded and found empty
//
// The live half — the same clips through the real API — is
// tests/live-fire/silence-guard.measure.ts.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { STT_NO_GUESS_RULE } from "@/lib/translate/prompts";
import {
  ECHO_MIN_WORDS,
  MIN_MEAN_LOGPROB,
  MIN_NO_SPEECH_PROB,
  SILENT_PEAK_DB,
  confidenceRequestFor,
  guardLogLine,
  hasNoWords,
  isPromptEcho,
  judgeTranscript,
  minMeanLogprob,
  resolveSuspect,
  secondOpinionModelFor,
  silenceGuardEnabled
} from "@/lib/translate/silenceGuard";
import { measurePeakDb, wavPeakDb } from "@/lib/translate/signalLevel";
import {
  CLIP_SILENCE_MAX_MS,
  CLIP_SILENCE_PEAK,
  bufferPeak,
  isClipSilent,
  isSilentLevel,
  measureClipLevel
} from "@/lib/translate/clipSilence";

const FIXTURES = join(process.cwd(), "tests", "fixtures", "stt-silence");
const FFMPEG = join(process.cwd(), "node_modules", "ffmpeg-static", "ffmpeg");

interface Captured {
  id: string;
  clip: string;
  model: string;
  sourceLabel: string | null;
  payload: Record<string, unknown> & { text: string };
}
const CAPTURED = JSON.parse(readFileSync(join(FIXTURES, "provider-payloads.json"), "utf8")) as Captured[];

/** The prompt transcribeAudio() sends, rebuilt the way it builds it. */
function promptFor(sourceLabel: string | null): string {
  return sourceLabel
    ? `Spoken ${sourceLabel}. Transcribe verbatim with natural punctuation. ${STT_NO_GUESS_RULE}`
    : `Transcribe verbatim with natural punctuation. ${STT_NO_GUESS_RULE}`;
}

function judge(row: Captured) {
  return judgeTranscript({ text: row.payload.text, payload: row.payload, prompt: promptFor(row.sourceLabel) });
}

const byId = (id: string) => {
  const row = CAPTURED.find((r) => r.id === id);
  if (!row) throw new Error(`no fixture ${id}`);
  return row;
};

/** A 16 kHz mono 16-bit WAV from samples in −1..1. */
function wav(samples: Float32Array | number[]): File {
  const n = samples.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + n * 2, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16000, true);
  v.setUint32(28, 32000, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i += 1) v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  return new File([buf], "clip.wav", { type: "audio/wav" });
}

/** Deterministic noise at a peak given in dBFS — "room tone" without a room. */
function noise(seconds: number, peakDb: number): Float32Array {
  const amp = 10 ** (peakDb / 20);
  const out = new Float32Array(Math.round(seconds * 16000));
  let seed = 12345;
  for (let i = 0; i < out.length; i += 1) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (seed / 0x7fffffff) * 2 * amp - amp;
  }
  return out;
}

function tone(seconds: number, peakDb: number): Float32Array {
  const amp = 10 ** (peakDb / 20);
  const out = new Float32Array(Math.round(seconds * 16000));
  for (let i = 0; i < out.length; i += 1) out[i] = Math.sin((2 * Math.PI * 220 * i) / 16000) * amp;
  return out;
}

describe("the numbers", () => {
  it("pins the thresholds", () => {
    expect(MIN_MEAN_LOGPROB).toBe(-0.85);
    expect(MIN_NO_SPEECH_PROB).toBe(0.85);
    expect(SILENT_PEAK_DB).toBe(-60);
    expect(ECHO_MIN_WORDS).toBe(2);
    expect(CLIP_SILENCE_PEAK).toBe(0.001);
  });

  it("the logprob threshold is tunable, and nonsense falls back to the default", () => {
    expect(minMeanLogprob(undefined)).toBe(-0.85);
    expect(minMeanLogprob("-1.2")).toBe(-1.2);
    expect(minMeanLogprob("0.5")).toBe(-0.85);
    expect(minMeanLogprob("loud")).toBe(-0.85);
  });

  it("is on unless TAOS_STT_SILENCE_GUARD is exactly 0", () => {
    expect(silenceGuardEnabled(undefined)).toBe(true);
    expect(silenceGuardEnabled("")).toBe(true);
    expect(silenceGuardEnabled("1")).toBe(true);
    expect(silenceGuardEnabled("0")).toBe(false);
  });
});

describe("the judgement, on real provider responses", () => {
  it("the fixture holds every kind of clip the brief names", () => {
    const clips = new Set(CAPTURED.map((r) => r.clip));
    for (const clip of ["sil2.webm", "room50.webm", "en_q45.webm", "es_q45.webm", "en_norm.webm"]) {
      expect(clips.has(clip)).toBe(true);
    }
  });

  it("silence: every gpt-4o-transcribe response had words in it, and none survives", () => {
    const rows = CAPTURED.filter((r) => r.id.startsWith("silence-"));
    expect(rows.length).toBeGreaterThanOrEqual(7);
    for (const row of rows) {
      // The bug, in one line: silence in, a non-empty transcript out.
      expect(row.payload.text.trim()).not.toBe("");
      const v = judge(row);
      expect(v.noSpeech || v.suspect, `${row.id} ${JSON.stringify(row.payload.text)}`).toBe(true);
    }
  });

  it("room tone and hum: none survives", () => {
    const rows = CAPTURED.filter((r) => r.id.startsWith("room-tone") || r.id.startsWith("hum"));
    expect(rows.length).toBeGreaterThanOrEqual(10);
    for (const row of rows) {
      const v = judge(row);
      expect(v.noSpeech || v.suspect, `${row.id} ${JSON.stringify(row.payload.text)}`).toBe(true);
    }
  });

  it("quiet speech passes — 45 dB down, peak −50 dBFS, English and Spanish, with and without room tone", () => {
    for (const id of ["quiet-speech-en", "quiet-speech-es", "quiet-speech-room"]) {
      const v = judge(byId(id));
      expect(v, id).toMatchObject({ noSpeech: false, suspect: false, reason: null, signal: "logprobs" });
      expect(v.meanLogprob).toBeGreaterThan(-0.2);
    }
  });

  it("normal speech passes, on both gpt-4o transcribers", () => {
    for (const id of ["normal-speech-en", "normal-speech-es", "mini-normal-speech"]) {
      expect(judge(byId(id)), id).toMatchObject({ noSpeech: false, suspect: false });
    }
  });

  it("a one-word turn passes ('Mhm.' is the least confident real speech measured)", () => {
    for (const row of CAPTURED.filter((r) => r.id.startsWith("one-word-mhm"))) {
      expect(judge(row), row.id).toMatchObject({ noSpeech: false, suspect: false });
    }
  });

  it("a real quiet 'Sí' that came back as the unlikely spelling is SUSPECT, never dropped outright", () => {
    // The case that made low confidence a suspicion: real speech, one token,
    // −2.97. Dropping it on the logprob alone would have rejected real words.
    const v = judge(byId("quiet-one-word"));
    expect(v).toMatchObject({ noSpeech: false, suspect: true, reason: "low_confidence" });
    expect(resolveSuspect(v, "speech")).toMatchObject({ noSpeech: false, suspect: false, second: "speech" });
    expect(resolveSuspect(v, "no_speech")).toMatchObject({ noSpeech: true, second: "no_speech" });
    // Unsure and unconfirmed is "try again", never a sentence.
    expect(resolveSuspect(v, "error")).toMatchObject({ noSpeech: true, second: "error" });
  });

  it("whisper-1: its own no_speech_prob drops silence and room tone, and keeps quiet speech", () => {
    expect(judge(byId("whisper-silence"))).toMatchObject({ noSpeech: true, reason: "no_speech_prob", signal: "segments" });
    expect(judge(byId("whisper-room-tone"))).toMatchObject({ noSpeech: true, reason: "no_speech_prob" });
    for (const id of ["whisper-quiet-one-word", "whisper-quiet-speech", "whisper-normal-speech"]) {
      expect(judge(byId(id)), id).toMatchObject({ noSpeech: false, suspect: false });
    }
  });

  it("the reasons are the measured ones", () => {
    expect(judge(byId("silence-8s#2"))).toMatchObject({ suspect: true, reason: "low_confidence" }); // "He shrugged."
    expect(judge(byId("silence-8s#3"))).toMatchObject({ noSpeech: true, reason: "prompt_echo" }); // "context:"
    expect(judge(byId("room-tone#1"))).toMatchObject({ noSpeech: true, reason: "prompt_echo" }); // "Spoken English."
    expect(judge(byId("room-tone-auto#1"))).toMatchObject({ noSpeech: true, reason: "prompt_echo" });
    expect(judge(byId("room-tone-auto#2"))).toMatchObject({ noSpeech: true, reason: "no_words" }); // "."
  });
});

describe("the structural rules", () => {
  it("no letter or digit, or one bracketed stage direction, is not speech", () => {
    for (const t of [".", "###", "...", "…", "-", "--", '"', "[silence]", "[Inaudible]", "[static]", "(inaudible).", "【無聲】"]) {
      expect(hasNoWords(t), t).toBe(true);
    }
    for (const t of ["No.", "Sí", "500", "我想買止痛藥", "(whispering) Where is the bathroom?", "[laughs] okay"]) {
      expect(hasNoWords(t), t).toBe(false);
    }
  });

  it("a prompt echo is two or more consecutive words of the prompt that was SENT", () => {
    const prompt = promptFor("English");
    expect(isPromptEcho("Transcribe verbatim with natural punctuation.", prompt)).toBe(true);
    expect(isPromptEcho("If any part", prompt)).toBe(true);
    expect(isPromptEcho("Spoken English.", prompt)).toBe(true);
    expect(isPromptEcho("context:", prompt)).toBe(true);
    expect(isPromptEcho("context", undefined)).toBe(true);
    // One word of the prompt is ordinary speech.
    for (const t of ["Never.", "Silent", "Audio", "Part"]) expect(isPromptEcho(t, prompt), t).toBe(false);
    // Words of the prompt in another order, or with others between, are speech.
    expect(isPromptEcho("The audio part is silent", prompt)).toBe(false);
    expect(isPromptEcho("Take one tablet twice a day with food", prompt)).toBe(false);
    // "Spoken English" is only an echo when the prompt said it.
    expect(isPromptEcho("Spoken English.", promptFor(null))).toBe(false);
    expect(isPromptEcho("Spoken English.", undefined)).toBe(false);
  });

  it("an empty transcript is not a drop — it is already 'nothing heard'", () => {
    expect(judgeTranscript({ text: "  ", payload: { text: "" } })).toMatchObject({ noSpeech: false, suspect: false, reason: null });
  });

  it("no signal at all keeps the transcript: the guard only drops on evidence", () => {
    // A successor model's response: text and nothing else.
    const v = judgeTranscript({ text: "Hola.", payload: { text: "Hola.", languages: [{ code: "es" }] }, prompt: promptFor("Spanish") });
    expect(v).toMatchObject({ noSpeech: false, suspect: false, signal: "none" });
  });

  it("one whisper segment without no_speech_prob means 'every segment' cannot be claimed", () => {
    const v = judgeTranscript({
      text: "Hello there.",
      payload: { text: "Hello there.", segments: [{ no_speech_prob: 0.99 }, { text: "x" }] }
    });
    expect(v).toMatchObject({ noSpeech: false, signal: "none" });
  });

  it("a long clip is silent to whisper only when EVERY segment says so", () => {
    const mixed = { text: "Hello. Thanks for watching.", segments: [{ no_speech_prob: 0.02 }, { no_speech_prob: 0.97 }] };
    expect(judgeTranscript({ text: mixed.text, payload: mixed })).toMatchObject({ noSpeech: false, noSpeechProb: 0.02 });
  });

  it("the log line carries numbers and never the words", () => {
    const row = byId("silence-8s#2");
    const line = guardLogLine("gpt-4o-transcribe", row.payload.text, resolveSuspect(judge(row), "no_speech"));
    expect(line).toMatch(/^\[taos-stt-guard\] dropped=1 reason=low_confidence model=gpt-4o-transcribe signal=logprobs /);
    expect(line).toContain("second=no_speech");
    expect(line).toContain("words=2");
    expect(line).not.toContain("shrugged");
  });
});

describe("the level", () => {
  it("digital silence is −120 dBFS and is dropped whatever the transcriber wrote", async () => {
    const peak = await measurePeakDb(wav(new Float32Array(32000)));
    expect(peak).toBe(-120);
    // Even a perfectly confident transcript: nothing was there to transcribe.
    const confident = { text: "I need a doctor.", logprobs: [{ logprob: -0.01 }, { logprob: -0.02 }] };
    expect(judgeTranscript({ text: confident.text, payload: confident, peakDb: peak })).toMatchObject({
      noSpeech: true,
      reason: "silent_level",
      peakDb: -120
    });
  });

  it("low room tone (peak −70 dBFS) is silence", async () => {
    const peak = await measurePeakDb(wav(noise(2, -70)));
    expect(peak).toBeLessThan(SILENT_PEAK_DB);
    expect(judgeTranscript({ text: "You never know.", payload: { text: "You never know." }, peakDb: peak })).toMatchObject({
      noSpeech: true,
      reason: "silent_level"
    });
  });

  it("quiet speech level (peak −50 dBFS) is NOT silence — the level rule leaves it to the transcript", async () => {
    const peak = await measurePeakDb(wav(tone(2, -50)));
    expect(peak).toBeGreaterThan(SILENT_PEAK_DB);
    expect(peak).toBeCloseTo(-50, 0);
    const row = byId("quiet-speech-en");
    expect(judgeTranscript({ text: row.payload.text, payload: row.payload, peakDb: peak })).toMatchObject({ noSpeech: false, suspect: false });
  });

  it("reads a WAV whose data chunk is not at byte 44, and refuses what is not PCM16", async () => {
    // ffmpeg writes a LIST chunk between `fmt ` and `data`.
    const plain = new Uint8Array(await wav(tone(0.1, -20)).arrayBuffer());
    const list = new Uint8Array([0x4c, 0x49, 0x53, 0x54, 6, 0, 0, 0, 1, 2, 3, 4, 5, 6]); // "LIST", 6 bytes
    const withList = new Uint8Array(plain.length + list.length);
    withList.set(plain.subarray(0, 36));
    withList.set(list, 36);
    withList.set(plain.subarray(36), 36 + list.length);
    expect(wavPeakDb(plain)).toBeCloseTo(-20, 0);
    expect(wavPeakDb(withList)).toBeCloseTo(-20, 0);
    // A streamed WAV declares a data length of 0xFFFFFFFF.
    const streamed = plain.slice();
    new DataView(streamed.buffer).setUint32(40, 0xffffffff, true);
    expect(wavPeakDb(streamed)).toBeCloseTo(-20, 0);
    // 8-bit, float, or not a WAV at all: null, and ffmpeg (if any) is asked.
    const float = plain.slice();
    new DataView(float.buffer).setUint16(20, 3, true);
    expect(wavPeakDb(float)).toBeNull();
    expect(wavPeakDb(new Uint8Array(8))).toBeNull();
    expect(wavPeakDb(new Uint8Array(200))).toBeNull();
  });

  it("an unknown level is null, never a throw, and never a verdict", async () => {
    // Not a WAV, and no binary to decode it with.
    const webm = new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3])], "a.webm", { type: "audio/webm" });
    expect(await measurePeakDb(webm, { binary: null })).toBeNull();
    expect(await measurePeakDb(new File([], "empty.webm"), { binary: null })).toBeNull();
    expect(await measurePeakDb(webm, { binary: "/nonexistent/ffmpeg" })).toBeNull();
    expect(judgeTranscript({ text: "Hola.", payload: { text: "Hola." }, peakDb: null })).toMatchObject({ noSpeech: false, peakDb: null });
  });

  it.skipIf(!existsSync(FFMPEG))("the real clips, decoded by ffmpeg: silence under the floor, quiet speech over it", async () => {
    const level = async (name: string, type: string) =>
      measurePeakDb(new File([readFileSync(join(FIXTURES, name))], name, { type }), { binary: FFMPEG });
    expect(await level("silence-2s.webm", "audio/webm")).toBeLessThan(SILENT_PEAK_DB);
    // iPhone's container: AAC in MP4.
    expect(await level("silence-2s.m4a", "audio/mp4")).toBeLessThan(SILENT_PEAK_DB);
    const quiet = await level("quiet-speech-en.webm", "audio/webm");
    expect(quiet).toBeGreaterThan(SILENT_PEAK_DB);
    expect(quiet).toBeLessThan(-45); // it really is quiet
    expect(await level("quiet-one-word-es.webm", "audio/webm")).toBeGreaterThan(SILENT_PEAK_DB);
    expect(await level("normal-speech-en.webm", "audio/webm")).toBeGreaterThan(-15);
    // Room tone at −53 dBFS peak is over the floor on purpose: that is a
    // phone's noise floor, and the transcript rules — not the level — decide.
    expect(await level("room-tone.webm", "audio/webm")).toBeGreaterThan(SILENT_PEAK_DB);
  });

  it.skipIf(!existsSync(FFMPEG))("ffmpeg is not asked about a WAV", () => {
    // The WAV path must not need a binary at all.
    const r = spawnSync(FFMPEG, ["-version"]);
    expect(r.status).toBe(0);
    return expect(measurePeakDb(wav(tone(0.5, -30)), { binary: null })).resolves.toBeCloseTo(-30, 0);
  });
});

describe("the request", () => {
  it("asks only the models that were measured", () => {
    expect(confidenceRequestFor("gpt-4o-transcribe")).toBe("logprobs");
    expect(confidenceRequestFor("gpt-4o-mini-transcribe")).toBe("logprobs");
    expect(confidenceRequestFor("gpt-4o-mini-transcribe-2025-12-15")).toBe("logprobs");
    expect(confidenceRequestFor("whisper-1")).toBe("verbose_json");
    // An unsupported `include` is a 400, and a 400 here is a dead microphone.
    expect(confidenceRequestFor("gpt-transcribe")).toBeNull();
    expect(confidenceRequestFor("gpt-4o-transcribe-diarize")).toBeNull();
    expect(confidenceRequestFor("gpt-live-transcribe")).toBeNull();
  });

  it("the second opinion is never the model that just answered", () => {
    expect(secondOpinionModelFor("gpt-4o-transcribe", undefined)).toBe("gpt-4o-mini-transcribe");
    expect(secondOpinionModelFor("whisper-1", undefined)).toBe("gpt-4o-mini-transcribe");
    expect(secondOpinionModelFor("gpt-4o-mini-transcribe", undefined)).toBe("whisper-1");
    expect(secondOpinionModelFor("gpt-4o-transcribe", "gpt-transcribe")).toBe("gpt-transcribe");
  });
});

describe("transcribeAudio(), with the provider's real answers", () => {
  const ORIGINAL_FETCH = globalThis.fetch;
  let calls: FormData[];
  let answers: Record<string, unknown>;

  async function load() {
    vi.resetModules();
    return import("@/lib/translate/transcribe");
  }

  beforeEach(() => {
    calls = [];
    answers = {};
    delete process.env.TAOS_STT_SILENCE_GUARD;
    delete process.env.TAOS_STT_SILENCE_CHECK_MODEL;
    delete process.env.OPENAI_TRANSCRIBE_MODEL;
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const form = init?.body as FormData;
      calls.push(form);
      const answer = answers[String(form.get("model"))];
      if (answer instanceof Error) throw answer;
      return Response.json(answer ?? { text: "" });
    }) as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    delete process.env.TAOS_STT_SILENCE_GUARD;
    vi.restoreAllMocks();
  });

  // Not a WAV and (in this file) never decodable: the level is unknown, so
  // these tests are about the transcript rules alone.
  const clip = () => new File([new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 9, 9, 9])], "audio.webm", { type: "audio/webm" });

  it("THE REPRO: silence that the transcriber wrote a sentence for comes back empty", async () => {
    const { transcribeAudioDetailed, transcribeAudio } = await load();
    answers["gpt-4o-transcribe"] = byId("silence-2s#3").payload; // "I can't."
    answers["gpt-4o-mini-transcribe"] = { text: "" }; // what it returned 64 of 64 times
    const out = await transcribeAudioDetailed("k", clip(), { sourceLabel: "English" });
    expect(out.text).toBe("");
    expect(out.guard).toMatchObject({ noSpeech: true, reason: "low_confidence", second: "no_speech" });
    expect(await transcribeAudio("k", clip(), { sourceLabel: "English" })).toBe("");
  });

  it("every captured silence and room-tone response comes back empty", async () => {
    const { transcribeAudio } = await load();
    answers["gpt-4o-mini-transcribe"] = { text: "" };
    const rows = CAPTURED.filter((r) => r.model === "gpt-4o-transcribe" && /^(silence|room-tone|hum)/.test(r.id));
    expect(rows.length).toBeGreaterThanOrEqual(17);
    for (const row of rows) {
      answers["gpt-4o-transcribe"] = row.payload;
      const text = await transcribeAudio("k", clip(), { sourceLabel: row.sourceLabel ?? undefined });
      expect(text, `${row.id} ${JSON.stringify(row.payload.text)}`).toBe("");
    }
  });

  it("quiet and normal speech come back word for word, with ONE provider call", async () => {
    const { transcribeAudio } = await load();
    for (const id of ["quiet-speech-en", "quiet-speech-es", "quiet-speech-room", "normal-speech-en", "normal-speech-es", "one-word-mhm#1"]) {
      const row = byId(id);
      calls = [];
      answers["gpt-4o-transcribe"] = row.payload;
      expect(await transcribeAudio("k", clip(), { sourceLabel: row.sourceLabel ?? undefined }), id).toBe(row.payload.text.trim());
      expect(calls, id).toHaveLength(1);
    }
  });

  it("a suspect real word is KEPT when the second model hears speech too", async () => {
    const { transcribeAudioDetailed } = await load();
    answers["gpt-4o-transcribe"] = byId("quiet-one-word").payload; // "Si", −2.97
    answers["gpt-4o-mini-transcribe"] = { text: "See.", logprobs: [{ logprob: -0.4 }, { logprob: -0.1 }] };
    const out = await transcribeAudioDetailed("k", clip());
    // The primary's transcript, not the second model's.
    expect(out.text).toBe("Si");
    expect(out.guard).toMatchObject({ noSpeech: false, second: "speech" });
    expect(calls.map((f) => f.get("model"))).toEqual(["gpt-4o-transcribe", "gpt-4o-mini-transcribe"]);
  });

  it("the second opinion is asked once, never a third model, even when it is unsure itself", async () => {
    const { transcribeAudioDetailed } = await load();
    answers["gpt-4o-transcribe"] = byId("quiet-one-word").payload;
    answers["gpt-4o-mini-transcribe"] = { text: "Flask.", logprobs: [{ logprob: -3.9 }, { logprob: -0.5 }] };
    const out = await transcribeAudioDetailed("k", clip());
    expect(out.text).toBe("Si");
    expect(calls).toHaveLength(2);
  });

  it("a second opinion that fails drops the turn: unsure and unconfirmed is 'try again'", async () => {
    const { transcribeAudioDetailed } = await load();
    answers["gpt-4o-transcribe"] = byId("silence-8s#2").payload; // "He shrugged."
    answers["gpt-4o-mini-transcribe"] = new Error("socket hang up");
    const out = await transcribeAudioDetailed("k", clip());
    expect(out.text).toBe("");
    expect(out.guard).toMatchObject({ noSpeech: true, second: "error" });
  });

  it("a prompt echo and a wordless transcript are dropped with no second call", async () => {
    const { transcribeAudio } = await load();
    for (const id of ["room-tone-auto#1", "silence-8s#3", "room-tone-auto#2", "room-tone#1"]) {
      const row = byId(id);
      calls = [];
      answers["gpt-4o-transcribe"] = row.payload;
      expect(await transcribeAudio("k", clip(), { sourceLabel: row.sourceLabel ?? undefined }), id).toBe("");
      expect(calls, id).toHaveLength(1);
    }
  });

  it("whisper-1 (the short-transcript retry): its invented line for silence comes back empty", async () => {
    const { transcribeAudio } = await load();
    answers["whisper-1"] = byId("whisper-silence").payload; // "Learn English for free www.engvid.com"
    expect(await transcribeAudio("k", clip(), { model: "whisper-1", languageCode: "es", omitPrompt: true })).toBe("");
    answers["whisper-1"] = byId("whisper-quiet-speech").payload;
    expect(await transcribeAudio("k", clip(), { model: "whisper-1", languageCode: "es", omitPrompt: true })).toContain("Tome una tableta");
  });

  it("when the mini is the primary, whisper-1 is the second opinion — with a language hint and no prompt", async () => {
    const { transcribeAudioDetailed } = await load();
    answers["gpt-4o-mini-transcribe"] = { text: "Never", logprobs: [{ logprob: -6.59 }] };
    answers["whisper-1"] = byId("whisper-silence").payload;
    const out = await transcribeAudioDetailed("k", clip(), { model: "gpt-4o-mini-transcribe", languageCode: "es" });
    expect(out.text).toBe("");
    expect(calls.map((f) => f.get("model"))).toEqual(["gpt-4o-mini-transcribe", "whisper-1"]);
    expect(calls[1].get("prompt")).toBeNull();
    expect(calls[1].get("language")).toBe("es");
    expect(calls[1].get("response_format")).toBe("verbose_json");
  });

  it("a silent WAV is dropped on its level even when the transcriber is confident", async () => {
    const { transcribeAudioDetailed } = await load();
    answers["gpt-4o-transcribe"] = { text: "I need a doctor.", logprobs: [{ logprob: -0.01 }, { logprob: -0.02 }, { logprob: -0.01 }] };
    const out = await transcribeAudioDetailed("k", wav(new Float32Array(32000)));
    expect(out.text).toBe("");
    expect(out.guard).toMatchObject({ noSpeech: true, reason: "silent_level", peakDb: -120 });
    expect(calls).toHaveLength(1);
  });

  it("confidence rides in the same request: logprobs for gpt-4o, verbose_json for whisper, nothing for a successor", async () => {
    const { transcribeAudio } = await load();
    await transcribeAudio("k", clip(), { sourceLabel: "Spanish" });
    expect(calls[0].get("response_format")).toBe("json");
    expect(calls[0].getAll("include[]")).toEqual(["logprobs"]);
    await transcribeAudio("k", clip(), { model: "whisper-1" });
    expect(calls[1].get("response_format")).toBe("verbose_json");
    expect(calls[1].getAll("include[]")).toEqual([]);
    answers["gpt-transcribe"] = { text: "Hola." };
    expect(await transcribeAudio("k", clip(), { model: "gpt-transcribe", languageCode: "es" })).toBe("Hola.");
    expect(calls[2].get("response_format")).toBeNull();
    expect(calls[2].getAll("include[]")).toEqual([]);
  });

  it("TAOS_STT_SILENCE_GUARD=0: the request is what it was before, and so is the answer", async () => {
    process.env.TAOS_STT_SILENCE_GUARD = "0";
    const { transcribeAudioDetailed } = await load();
    answers["gpt-4o-transcribe"] = byId("silence-2s#3").payload;
    const out = await transcribeAudioDetailed("k", clip(), { sourceLabel: "English" });
    expect(out).toEqual({ text: byId("silence-2s#3").payload.text.trim(), guard: null });
    expect(calls).toHaveLength(1);
    expect([...calls[0].keys()].sort()).toEqual(["file", "model", "prompt"]);
  });

  it("a dropped transcript is logged as numbers, and the words are not", async () => {
    const { transcribeAudio } = await load();
    const row = byId("room-tone#3"); // "I love you."
    answers["gpt-4o-transcribe"] = row.payload;
    await transcribeAudio("k", clip(), { sourceLabel: "English" });
    const lines = vi.mocked(console.log).mock.calls.map((c) => c.map(String).join(" "));
    const line = lines.find((l) => l.startsWith("[taos-stt-guard]"));
    expect(line).toBeDefined();
    expect(line).toContain("reason=low_confidence");
    expect(line).not.toMatch(/love/i);
  });
});

describe("/api/translate: silence is the existing 422, and nothing is translated", () => {
  const ORIGINAL_FETCH = globalThis.fetch;
  const ORIGINAL_KEY = process.env.OPENAI_API_KEY;
  let urls: string[];
  let sttAnswers: Record<string, unknown>;

  beforeEach(() => {
    urls = [];
    sttAnswers = {};
    process.env.OPENAI_API_KEY = "sk-test";
    delete process.env.TAOS_STT_SILENCE_GUARD;
    delete process.env.OPENAI_TRANSCRIBE_MODEL;
    delete process.env.OPENAI_AUTO_TRANSCRIBE_MODEL;
    vi.doMock("@/lib/spendGuard", () => ({
      guardSpend: async () => ({ ok: true, user: { id: "u1" }, anonymous: false })
    }));
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      urls.push(String(url));
      if (String(url).includes("/audio/transcriptions")) {
        return Response.json(sttAnswers[String((init?.body as FormData).get("model"))] ?? { text: "" });
      }
      return Response.json({ choices: [{ message: { content: "Tome una tableta." } }] });
    }) as unknown as typeof fetch;
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    globalThis.fetch = ORIGINAL_FETCH;
    if (ORIGINAL_KEY === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = ORIGINAL_KEY;
    vi.doUnmock("@/lib/spendGuard");
    vi.restoreAllMocks();
  });

  function request(file: File): NextRequest {
    const form = new FormData();
    form.append("audio", file);
    form.append("sourceLanguage", "en");
    form.append("targetLanguage", "es");
    form.append("tone", "detailed");
    form.append("rec_ms", "2000");
    return new NextRequest("http://localhost/api/translate", { method: "POST", body: form });
  }

  async function post(file: File) {
    vi.resetModules();
    const { POST } = await import("@/app/api/translate/route");
    const res = await POST(request(file));
    return { status: res.status, body: (await res.json()) as { error?: string; original?: string; translation?: string } };
  }

  const silentClip = () => new File([readFileSync(join(FIXTURES, "silence-2s.webm"))], "audio.webm", { type: "audio/webm" });
  const quietClip = () => new File([readFileSync(join(FIXTURES, "quiet-speech-en.webm"))], "audio.webm", { type: "audio/webm" });

  it("two seconds of silence → 422 'Nothing was heard · No se escuchó nada', and no chat completion", async () => {
    sttAnswers["gpt-4o-transcribe"] = byId("silence-2s#3").payload;
    const { status, body } = await post(silentClip());
    expect(status).toBe(422);
    expect(body.error).toBe("Nothing was heard — try again. · No se escuchó nada — intenta de nuevo.");
    expect(body.original).toBeUndefined();
    expect(urls.every((u) => u.includes("/audio/transcriptions"))).toBe(true);
    expect(urls.some((u) => u.includes("/chat/completions"))).toBe(false);
  });

  it("quiet real speech → 200, transcribed and translated", async () => {
    sttAnswers["gpt-4o-transcribe"] = byId("quiet-speech-en").payload;
    const { status, body } = await post(quietClip());
    expect(status).toBe(200);
    expect(body.original).toBe(byId("quiet-speech-en").payload.text);
    expect(body.translation).toBe("Tome una tableta.");
    expect(urls.filter((u) => u.includes("/audio/transcriptions"))).toHaveLength(1);
  });
});

describe("every transcription call in the app is behind the guard", () => {
  function sources(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) sources(full, out);
      else if (/\.tsx?$/.test(name)) out.push(full);
    }
    return out;
  }
  const root = process.cwd();
  const callers = [...sources(join(root, "app")), ...sources(join(root, "lib")), ...sources(join(root, "components"))]
    .filter((f) => readFileSync(f, "utf8").includes("/v1/audio/transcriptions"))
    .map((f) => f.slice(root.length + 1))
    .sort();

  it("only three files call the transcription API", () => {
    // A fourth hand-rolled call is a fourth exposure. Add it here only with
    // the guard in it — or, better, call transcribeAudio().
    expect(callers).toEqual([
      "app/api/chat/voice/route.ts",
      // Subtitles, not turns: whisper-1 segments on a timeline, with its own
      // "no speech was heard in that video" answer. Not a spoken sentence.
      "app/api/video/process/route.ts",
      "lib/translate/transcribe.ts"
    ]);
  });

  it("the shared transcriber and the chat voice route both judge what comes back", () => {
    const shared = readFileSync(join(root, "lib/translate/transcribe.ts"), "utf8");
    expect(shared).toContain("applyConfidenceRequest(form, model)");
    expect(shared).toContain("judgeTranscript({ text, payload, prompt, peakDb })");
    const chat = readFileSync(join(root, "app/api/chat/voice/route.ts"), "utf8");
    expect(chat).toContain("applyConfidenceRequest(form, model)");
    expect(chat).toContain("if (guard.noSpeech || guard.suspect)");
  });

  it("every route on the shared transcriber answers an empty transcript with a bilingual 'nothing heard'", () => {
    for (const route of ["app/api/translate/route.ts", "app/api/fast/listen/route.ts", "app/api/walkie/turn/route.ts", "app/api/voz/line/route.ts"]) {
      const src = readFileSync(join(root, route), "utf8");
      expect(src, route).toContain("transcribeAudio");
      expect(src, route).toMatch(/Nothing was heard — try again/);
      expect(src, route).toMatch(/No se escuchó nada — intenta de nuevo/);
      expect(src, route).toContain("422");
    }
  });
});

describe("the phone's check: only a clip it decoded and found empty", () => {
  const buffer = (channels: number[][]) => ({
    numberOfChannels: channels.length,
    getChannelData: (c: number) => Float32Array.from(channels[c])
  });

  it("the floor is −60 dBFS, a tenth of the tutor's", () => {
    expect(20 * Math.log10(CLIP_SILENCE_PEAK)).toBeCloseTo(-60, 5);
    expect(CLIP_SILENCE_MAX_MS).toBe(30000);
  });

  it("peak is the loudest sample on ANY channel, either sign", () => {
    expect(bufferPeak(buffer([[0, 0.0002, -0.0004], [0, 0, 0]]))).toBeCloseTo(0.0004, 6);
    expect(bufferPeak(buffer([[0, 0], [0, -0.3]]))).toBeCloseTo(0.3, 6);
    expect(bufferPeak(buffer([[0, 0, 0]]))).toBe(0);
  });

  it("silent: digital zeros, and a noise floor under −60", () => {
    expect(isSilentLevel({ known: true, peak: 0, seconds: 2 })).toBe(true);
    expect(isSilentLevel({ known: true, peak: 0.0005, seconds: 2 })).toBe(true);
  });

  it("not silent: quiet speech (peak −50 dBFS), a phone's room tone, anything at the floor", () => {
    expect(isSilentLevel({ known: true, peak: 10 ** (-50 / 20), seconds: 2 })).toBe(false);
    expect(isSilentLevel({ known: true, peak: 10 ** (-53 / 20), seconds: 4 })).toBe(false);
    expect(isSilentLevel({ known: true, peak: CLIP_SILENCE_PEAK, seconds: 2 })).toBe(false);
  });

  it("every doubt sends the clip", async () => {
    for (const why of ["too_long", "no_decoder", "decode_failed", "timeout", "length_mismatch"] as const) {
      expect(isSilentLevel({ known: false, why })).toBe(false);
    }
    const blob = new Blob([new Uint8Array(100)], { type: "audio/mp4" });
    // No window, no decoder (this is node): unknown, so not silent.
    expect(await measureClipLevel(blob, 2000)).toEqual({ known: false, why: "no_decoder" });
    expect(await isClipSilent(blob, 2000)).toBe(false);
    // A long turn is never decoded on the phone.
    expect(await measureClipLevel(blob, CLIP_SILENCE_MAX_MS + 1)).toEqual({ known: false, why: "too_long" });
    expect(await measureClipLevel(blob, 0)).toEqual({ known: false, why: "too_long" });
  });

  it("decoded on an OfflineAudioContext: a decoder that throws, stalls or comes back short sends the clip", async () => {
    const blob = new Blob([new Uint8Array(100)], { type: "audio/mp4" });
    const withDecoder = async (decodeAudioData: (b: ArrayBuffer) => Promise<unknown>) => {
      vi.stubGlobal("window", { OfflineAudioContext: class { decodeAudioData = decodeAudioData; } });
      try {
        return await measureClipLevel(blob, 2000);
      } finally {
        vi.unstubAllGlobals();
      }
    };
    const decoded = (peak: number, duration: number) => ({ duration, ...buffer([[0, peak, 0]]) });
    expect(await withDecoder(async () => decoded(0, 2))).toEqual({ known: true, peak: 0, seconds: 2 });
    expect(isSilentLevel(await withDecoder(async () => decoded(0, 2)))).toBe(true);
    expect(isSilentLevel(await withDecoder(async () => decoded(0.02, 2)))).toBe(false);
    expect(await withDecoder(async () => Promise.reject(new Error("EncodingError")))).toEqual({ known: false, why: "decode_failed" });
    // Zeros, but only 0.4 s of a 2 s clip: the decoder did not read the clip.
    expect(await withDecoder(async () => decoded(0, 0.4))).toEqual({ known: false, why: "length_mismatch" });
    expect(await withDecoder(() => new Promise(() => undefined))).toEqual({ known: false, why: "timeout" });
  });

  it("nothing in the check touches the live microphone", () => {
    const src = readFileSync(join(process.cwd(), "lib/translate/clipSilence.ts"), "utf8");
    const code = src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
    expect(code).not.toMatch(/createMediaStreamSource|createAnalyser|getUserMedia|new AudioContext|webkitAudioContext\b/);
    expect(code).toContain("OfflineAudioContext");
  });

  it("home and Taokie ask after the recorder has stopped, and say 'no audio' in the owner's language", () => {
    const home = readFileSync(join(process.cwd(), "components/TranslatorShell.tsx"), "utf8");
    const stop = home.slice(home.indexOf("async function handleRecordingStopped("), home.indexOf("async function translateBlob("));
    expect(stop).toContain("if (parts.length === 0 && (await isClipSilent(blob, turnMs))) {");
    expect(stop.indexOf("isClipSilent")).toBeGreaterThan(stop.indexOf("turnMs < MIN_TURN_DURATION_MS"));
    const walkie = readFileSync(join(process.cwd(), "components/walkie/WalkieShell.tsx"), "utf8");
    expect(walkie).toContain("if (await isClipSilent(blob, turnMs)) {\n      setError(s.noAudio);");
    const copy = readFileSync(join(process.cwd(), "lib/chrome/copy.ts"), "utf8");
    expect(copy).toContain('noAudio: "No audio was captured. Check the mic and try again."');
    expect(copy).toContain('noAudio: "No se captó audio. Revisa el micrófono e inténtalo de nuevo."');
  });
});
