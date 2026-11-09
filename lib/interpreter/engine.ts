// Which realtime speech-to-speech engine Interpreter mode runs on, and which
// model, voice and knobs each one gets. Isomorphic: the kinds, the parser and
// the selection rule are read by the shell; the model and voice knobs are read
// only on the server (they are not NEXT_PUBLIC_, so in a browser they are
// always the defaults — and the browser never uses them, the mint route does).
//
// Verified against the providers' docs AND Tom's account on 2026-11-09 (the PR
// body has the table):
//
//   openai-realtime   gpt-realtime-2.1 — OpenAI's flagship speech-to-speech
//                     model, the named successor to gpt-realtime (which
//                     retires 2027-01-20). Takes a briefing. DEFAULT.
//   openai-live       gpt-live-1 — NOT in the brief; found while verifying. GA
//                     since 2026-09-10 and what OpenAI's audio guide now says
//                     to "start with" for conversational voice: full-duplex,
//                     decides for itself when to speak, flat per minute.
//                     Takes a briefing; its prompting guide carries an
//                     interpreter recipe.
//   openai-translate  gpt-realtime-translate — a dedicated streaming
//                     interpreter, flat per minute, on its own endpoint. Takes
//                     NO briefing and NO voice: its session accepts a target
//                     language, a transcriber and noise reduction, nothing
//                     else. One output language per session.
//   gemini-live       gemini-3.8-live — Google's current Live model. Takes a
//                     briefing (systemInstruction).
//
// Every model ID below is a DEFAULT behind an env knob. Nothing else in the
// app names one.

import { speakerClone } from "@/lib/tts/voice";
import type { InterpreterDirection, InterpreterPair } from "./briefing";

export type InterpreterEngine =
  | "openai-realtime"
  | "openai-live"
  | "openai-translate"
  | "gemini-live";

export const INTERPRETER_ENGINES: readonly InterpreterEngine[] = [
  "openai-realtime",
  "openai-live",
  "openai-translate",
  "gemini-live"
];

/** Short labels for the founder picker. Brand names; not translated. */
export const ENGINE_LABEL: Record<InterpreterEngine, string> = {
  "openai-realtime": "Realtime 2.1",
  "openai-live": "GPT-Live",
  "openai-translate": "Translate",
  "gemini-live": "Gemini"
};

/** Per-device founder choice — so Tom and Liz can A/B at the table. */
export const ENGINE_STORAGE_KEY = "taos.interpreter.engine";

export function parseEngine(raw: unknown): InterpreterEngine | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return (INTERPRETER_ENGINES as readonly string[]).includes(v) ? (v as InterpreterEngine) : null;
}

/**
 * The deployment's default: TAOS_INTERPRETER_ENGINE. Anything else — unset, a
 * typo — is the flagship. Tom asked for cutting-edge; that is the default.
 */
export function engineEnvDefault(
  raw: string | undefined = process.env.TAOS_INTERPRETER_ENGINE
): InterpreterEngine {
  return parseEngine(raw) ?? "openai-realtime";
}

/** THE selection rule: the device's stored choice wins, then the env default. */
export function resolveEngine(opts: {
  stored: unknown;
  envDefault: InterpreterEngine;
}): InterpreterEngine {
  return parseEngine(opts.stored) ?? opts.envDefault;
}

/** Does this engine's session accept the briefing at all? */
export function engineTakesBriefing(engine: InterpreterEngine): boolean {
  return engine !== "openai-translate";
}

// ── Models ─────────────────────────────────────────────────────────────────

function knob(raw: string | undefined, fallback: string): string {
  const v = raw?.trim();
  return v ? v : fallback;
}

export const INTERPRETER_MODEL_DEFAULTS: Record<InterpreterEngine, string> = {
  "openai-realtime": "gpt-realtime-2.1",
  "openai-live": "gpt-live-1",
  "openai-translate": "gpt-realtime-translate",
  "gemini-live": "gemini-3.8-live"
};

/**
 *     TAOS_INTERPRETER_OPENAI_MODEL      (e.g. gpt-realtime-2.1-mini)
 *     TAOS_INTERPRETER_LIVE_MODEL
 *     TAOS_INTERPRETER_TRANSLATE_MODEL
 *     TAOS_INTERPRETER_GEMINI_MODEL      (e.g. gemini-3.8-live-extended-thinking)
 */
export function interpreterModel(
  engine: InterpreterEngine,
  env: Record<string, string | undefined> = process.env
): string {
  if (engine === "openai-translate") {
    return knob(env.TAOS_INTERPRETER_TRANSLATE_MODEL, INTERPRETER_MODEL_DEFAULTS[engine]);
  }
  if (engine === "gemini-live") {
    return knob(env.TAOS_INTERPRETER_GEMINI_MODEL, INTERPRETER_MODEL_DEFAULTS[engine]);
  }
  if (engine === "openai-live") {
    return knob(env.TAOS_INTERPRETER_LIVE_MODEL, INTERPRETER_MODEL_DEFAULTS[engine]);
  }
  return knob(env.TAOS_INTERPRETER_OPENAI_MODEL, INTERPRETER_MODEL_DEFAULTS[engine]);
}

/**
 * The transcriber behind the captions of what each person SAID (the captions
 * of what the interpreter said come from the model itself).
 *
 *     TAOS_INTERPRETER_TRANSCRIBE_MODEL
 *
 * `gpt-transcribe`, not the app's older gpt-4o-mini-transcribe: that one
 * retires 2027-02-26 with whisper-1, and this spike is the first step off the
 * retiring realtime stack. It also takes a `languages` hint, which is exactly
 * what a two-language table has to give it.
 */
export const INTERPRETER_TRANSCRIBE_DEFAULT = "gpt-transcribe";

export function interpreterTranscribeModel(
  env: Record<string, string | undefined> = process.env
): string {
  return knob(env.TAOS_INTERPRETER_TRANSCRIBE_MODEL, INTERPRETER_TRANSCRIBE_DEFAULT);
}

/** Transcribers that accept the `languages` hint (OpenAI reference, 2026-11). */
export function transcriberTakesLanguagesHint(model: string): boolean {
  return model === "gpt-transcribe" || model === "gpt-live-transcribe";
}

/**
 * gpt-realtime-translate's own caption transcriber — a different list from
 * the realtime API's; its reference uses gpt-realtime-whisper.
 *
 *     TAOS_INTERPRETER_TRANSLATE_TRANSCRIBE_MODEL
 */
export const INTERPRETER_TRANSLATE_TRANSCRIBE_DEFAULT = "gpt-realtime-whisper";

export function interpreterTranslateTranscribeModel(
  env: Record<string, string | undefined> = process.env
): string {
  return knob(env.TAOS_INTERPRETER_TRANSLATE_TRANSCRIBE_MODEL, INTERPRETER_TRANSLATE_TRANSCRIBE_DEFAULT);
}

// ── Voices ─────────────────────────────────────────────────────────────────
// Stock voices: a realtime model speaks in its own voices, not in our
// ElevenLabs clones. Two CLEARLY different ones, one per direction, so the ear
// can tell whose words are being carried without looking at the phone.
//
// WHO gets which follows the rule in lib/tts/voice.ts (speakerClone) — the
// same voice-follows-speaker rule every other screen uses, asked rather than
// restated: the direction that would have been read in Tom's clone gets
// voice 1, the one that would have been read in Liz's gets voice 2.
//
//     TAOS_INTERPRETER_VOICE_1          OpenAI, default cedar
//     TAOS_INTERPRETER_VOICE_2          OpenAI, default marin
//     TAOS_INTERPRETER_GEMINI_VOICE_1   Gemini, default Charon
//     TAOS_INTERPRETER_GEMINI_VOICE_2   Gemini, default Aoede
//
// cedar and marin are the two voices OpenAI's own reference recommends for
// realtime models, and they are the pair furthest apart by ear.
export const INTERPRETER_VOICE_DEFAULTS = {
  openai: ["cedar", "marin"],
  gemini: ["Charon", "Aoede"]
} as const;

export type VoiceSlot = 1 | 2;

/**
 * Which of the two voices a direction speaks in. Never the same slot for both
 * directions of one pair.
 */
export function voiceSlot(direction: InterpreterDirection): VoiceSlot {
  const who = speakerClone(
    direction.source as Parameters<typeof speakerClone>[0],
    direction.target as Parameters<typeof speakerClone>[1]
  );
  if (who === "tom") return 1;
  if (who === "liz") return 2;
  // Neither founder's language is the source. The REVERSE direction may still
  // belong to one of them — take the other slot, so the pair never doubles.
  const reverse = speakerClone(
    direction.target as Parameters<typeof speakerClone>[0],
    direction.source as Parameters<typeof speakerClone>[1]
  );
  if (reverse === "tom") return 2;
  if (reverse === "liz") return 1;
  // A pair with neither: stable by code order.
  return direction.source < direction.target ? 1 : 2;
}

export function interpreterVoice(
  engine: InterpreterEngine,
  direction: InterpreterDirection,
  env: Record<string, string | undefined> = process.env
): string {
  const slot = voiceSlot(direction);
  if (engine === "gemini-live") {
    return slot === 1
      ? knob(env.TAOS_INTERPRETER_GEMINI_VOICE_1, INTERPRETER_VOICE_DEFAULTS.gemini[0])
      : knob(env.TAOS_INTERPRETER_GEMINI_VOICE_2, INTERPRETER_VOICE_DEFAULTS.gemini[1]);
  }
  return slot === 1
    ? knob(env.TAOS_INTERPRETER_VOICE_1, INTERPRETER_VOICE_DEFAULTS.openai[0])
    : knob(env.TAOS_INTERPRETER_VOICE_2, INTERPRETER_VOICE_DEFAULTS.openai[1]);
}

/** The two directions of a table, owner's language first. */
export function pairDirections(pair: InterpreterPair): [InterpreterDirection, InterpreterDirection] {
  return [
    { source: pair.a, target: pair.b },
    { source: pair.b, target: pair.a }
  ];
}

// ── One session, or one per direction ──────────────────────────────────────
// A realtime session's voice is FIXED once it has spoken (OpenAI: "Voice
// cannot be changed during the session once the model has responded with
// audio"; GPT-Live: "cannot change after startup"; Gemini: setup is the first
// message and only the first). So two voices means two sessions — one LEG per
// direction, each told to interpret one way and keep silent for the other.
//
// That is also the only shape gpt-realtime-translate has ("for a two-person
// call, create one translation session per direction"), and it buys the
// captions their sides for free: a leg knows which way it is interpreting, so
// nothing has to guess a language from a transcript.
//
// Measured before it was chosen (tests/live-fire/interpreter.measure.ts,
// 2026-11-09, gpt-realtime-2.1): the leg that should keep quiet said no WORDS
// in 12 of 12 turns. It does return a short run of wordless audio frames,
// which is why the client only un-mutes a leg once its transcript has words
// (lib/interpreter/client.ts). gpt-realtime-translate returns pure digital
// silence for speech already in its output language (peak 0.000).
//
//     TAOS_INTERPRETER_LEGS=1    one session both ways, ONE voice (voice 1),
//                                captions without sides. The fallback if two
//                                legs ever talk over each other at the table.
//                                Ignored by openai-translate, which cannot.
export function interpreterLegCount(
  engine: InterpreterEngine,
  raw: string | undefined = process.env.TAOS_INTERPRETER_LEGS
): 1 | 2 {
  if (engine === "openai-translate") return 2;
  return (raw ?? "").trim() === "1" ? 1 : 2;
}
