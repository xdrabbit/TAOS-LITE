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
//
// Added 2026-11-09, after the first table test (Tom's go, same day) — both
// verified against the providers' docs and probed live the same morning
// (tests/live-fire/interpreter-engines.measure.ts):
//
//   grok-voice           grok-voice-3.0 — xAI's flagship speech-to-speech
//                        model (grok-voice-2.0 is deprecated; -latest is an
//                        alias). Speaks the OpenAI Realtime wire protocol,
//                        but over a WebSocket only — there is no WebRTC
//                        endpoint — and its client secret can lock only the
//                        model, so the briefing rides in the browser's first
//                        `session.update`. Flat $0.08 per minute PER LEG —
//                        $0.16 for a two-leg table.
//   elevenlabs-realtime  eleven_realtime_v1_mini — ElevenLabs' Realtime tier
//                        (a cascaded ASR → LLM → TTS pipeline they manage; the
//                        LLM is theirs and cannot be chosen — Mini or Max is
//                        the whole choice, and Mini is "lowest latency and
//                        cost" in their words). Being a cascade is also its
//                        latency floor: 0.8–1.7 s from the speaker's last
//                        word to the first audio frame, measured 2026-11-09,
//                        and no session setting moves it (session.ts). $0.08
//                        per minute PER LEG. The point of this arm is the
//                        VOICE: it speaks in the founders' own ElevenLabs
//                        clones, by the same voice-follows-speaker rule as
//                        every other screen (lib/tts/voice.ts). Also the
//                        OpenAI Realtime wire protocol over a WebSocket, with
//                        the whole session locked into the client secret.
//
// Every model ID below is a DEFAULT behind an env knob. Nothing else in the
// app names one.

import { elevenLabsVoiceId, speakerClone } from "@/lib/tts/voice";
import type { InterpreterDirection, InterpreterPair } from "./briefing";

export type InterpreterEngine =
  | "openai-realtime"
  | "openai-live"
  | "openai-translate"
  | "gemini-live"
  | "grok-voice"
  | "elevenlabs-realtime";

export const INTERPRETER_ENGINES: readonly InterpreterEngine[] = [
  "openai-realtime",
  "openai-live",
  "openai-translate",
  "gemini-live",
  "grok-voice",
  "elevenlabs-realtime"
];

/** Short labels for the founder picker. Brand names; not translated. */
export const ENGINE_LABEL: Record<InterpreterEngine, string> = {
  "openai-realtime": "Realtime 2.1",
  "openai-live": "GPT-Live",
  "openai-translate": "Translate",
  "gemini-live": "Gemini",
  "grok-voice": "Grok",
  "elevenlabs-realtime": "ElevenLabs"
};

/** Per-device founder choice — so Tom and Liz can A/B at the table. */
export const ENGINE_STORAGE_KEY = "taos.interpreter.engine";

export function parseEngine(raw: unknown): InterpreterEngine | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return (INTERPRETER_ENGINES as readonly string[]).includes(v) ? (v as InterpreterEngine) : null;
}

// ── Experimental engines (Tom, 2026-11-09, the day the mode shipped) ────────
// After an afternoon of A/B at the table: Realtime 2.1 and GPT-Live are the
// keepers; Grok and ElevenLabs — the two engines on our own WebSocket PCM
// playback path — degrade into a rapidly repeating "folding" sound. They stay
// OUT of production until that is fixed: hidden unless the deployment names
// them, in a SERVER-ONLY comma list:
//
//     TAOS_INTERPRETER_EXPERIMENTAL_ENGINES=grok-voice,elevenlabs-realtime
//
// Unset (the production default) → neither chip is rendered, a device that
// stored one of them opens on the deployment default instead, and the mint
// route will not mint one whatever the request says. Unknown names in the
// list are ignored; naming a non-experimental engine changes nothing.
export const EXPERIMENTAL_ENGINES: readonly InterpreterEngine[] = [
  "grok-voice",
  "elevenlabs-realtime"
];

/** The experimental engines this deployment has switched on. */
export function experimentalEnginesShown(
  raw: string | undefined = process.env.TAOS_INTERPRETER_EXPERIMENTAL_ENGINES
): InterpreterEngine[] {
  const named = new Set(
    (raw ?? "")
      .split(",")
      .map((v) => v.trim().toLowerCase())
      .filter(Boolean)
  );
  return EXPERIMENTAL_ENGINES.filter((e) => named.has(e));
}

/** Every engine this deployment offers, in picker order. */
export function availableEngines(
  raw: string | undefined = process.env.TAOS_INTERPRETER_EXPERIMENTAL_ENGINES
): InterpreterEngine[] {
  const shown = experimentalEnginesShown(raw);
  return INTERPRETER_ENGINES.filter((e) => !EXPERIMENTAL_ENGINES.includes(e) || shown.includes(e));
}

/** What the picker shows when nobody passed it a list: no experimental engine. */
export const STABLE_ENGINES: readonly InterpreterEngine[] = availableEngines("");

/**
 * The deployment's default: TAOS_INTERPRETER_ENGINE. Anything else — unset, a
 * typo, an experimental engine the deployment has not switched on — is the
 * flagship. Tom asked for cutting-edge; that is the default.
 *
 * This is also THE one-variable switch Tom asked for on 2026-11-09 ("keep the
 * flagship as default for now; add gemini-live as a one-env-var switch"):
 *
 *     TAOS_INTERPRETER_ENGINE=gemini-live
 *
 * and every phone that has not picked an engine for itself opens on Gemini at
 * the next deploy. Nothing else has to change with it. A device that HAS
 * picked keeps its pick (resolveEngine, below) — that is the table A/B.
 */
export function engineEnvDefault(
  raw: string | undefined = process.env.TAOS_INTERPRETER_ENGINE,
  experimentalRaw: string | undefined = process.env.TAOS_INTERPRETER_EXPERIMENTAL_ENGINES
): InterpreterEngine {
  const parsed = parseEngine(raw);
  return parsed && availableEngines(experimentalRaw).includes(parsed) ? parsed : "openai-realtime";
}

/**
 * THE selection rule: the device's stored choice wins, then the env default —
 * and neither may be an engine this deployment does not offer (`available`,
 * from availableEngines(); omitted = every engine, for callers that have
 * already filtered).
 */
export function resolveEngine(opts: {
  stored: unknown;
  envDefault: InterpreterEngine;
  available?: readonly InterpreterEngine[];
}): InterpreterEngine {
  const offered = opts.available ?? INTERPRETER_ENGINES;
  const stored = parseEngine(opts.stored);
  if (stored && offered.includes(stored)) return stored;
  if (offered.includes(opts.envDefault)) return opts.envDefault;
  return offered[0] ?? "openai-realtime";
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
  "gemini-live": "gemini-3.8-live",
  "grok-voice": "grok-voice-3.0",
  "elevenlabs-realtime": "eleven_realtime_v1_mini"
};

/**
 *     TAOS_INTERPRETER_OPENAI_MODEL      (e.g. gpt-realtime-2.1-mini)
 *     TAOS_INTERPRETER_LIVE_MODEL
 *     TAOS_INTERPRETER_TRANSLATE_MODEL
 *     TAOS_INTERPRETER_GEMINI_MODEL      (e.g. gemini-3.8-live-extended-thinking)
 *     TAOS_INTERPRETER_GROK_MODEL        (e.g. grok-voice-latest)
 *     TAOS_INTERPRETER_ELEVENLABS_MODEL  (eleven_realtime_v1_mini = cheaper, faster)
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
  if (engine === "grok-voice") {
    return knob(env.TAOS_INTERPRETER_GROK_MODEL, INTERPRETER_MODEL_DEFAULTS[engine]);
  }
  if (engine === "elevenlabs-realtime") {
    return knob(env.TAOS_INTERPRETER_ELEVENLABS_MODEL, INTERPRETER_MODEL_DEFAULTS[engine]);
  }
  return knob(env.TAOS_INTERPRETER_OPENAI_MODEL, INTERPRETER_MODEL_DEFAULTS[engine]);
}

// ── Keys ───────────────────────────────────────────────────────────────────
// Which environment variable each provider's key is read from. NAMES only —
// the missing-key answer of the mint route quotes the name so that whoever
// reads it knows exactly what to add in Vercel, and nothing here (or there)
// ever holds a value.

/**
 * xAI's key. `XAI_API_KEY` is the name xAI's own docs and SDK use and is what
 * a new key should be saved as; `GROK_API_KEY` is the name already on this
 * Vercel project (added 2026-06, before anything read it) and is honoured so
 * that key works without a second copy of it.
 */
export const XAI_KEY_ENVS = ["XAI_API_KEY", "GROK_API_KEY"] as const;

export function xaiApiKey(env: Record<string, string | undefined> = process.env): string | null {
  for (const name of XAI_KEY_ENVS) {
    const v = env[name]?.trim();
    if (v) return v;
  }
  return null;
}

/** The variable a founder is told to add when an engine's key is missing. */
export const ENGINE_KEY_ENV: Record<InterpreterEngine, string> = {
  "openai-realtime": "OPENAI_API_KEY",
  "openai-live": "OPENAI_API_KEY",
  "openai-translate": "OPENAI_API_KEY",
  "gemini-live": "GEMINI_API_KEY",
  "grok-voice": XAI_KEY_ENVS[0],
  "elevenlabs-realtime": "ELEVENLABS_API_KEY"
};

export function engineApiKey(
  engine: InterpreterEngine,
  env: Record<string, string | undefined> = process.env
): string | null {
  if (engine === "grok-voice") return xaiApiKey(env);
  return env[ENGINE_KEY_ENV[engine]]?.trim() || null;
}

/**
 * Grok Voice is a reasoning model whose default effort is `high`. xAI's own
 * live-interpreter recipe turns it OFF ("repeating a sentence in another
 * language does not need it"), and so does this — an interpreter mostly has
 * to be quick.
 *
 *     TAOS_INTERPRETER_GROK_REASONING=none|high
 */
export function grokReasoning(
  raw: string | undefined = process.env.TAOS_INTERPRETER_GROK_REASONING
): "none" | "high" {
  return (raw ?? "").trim().toLowerCase() === "high" ? "high" : "none";
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
//     TAOS_INTERPRETER_GROK_VOICE_1     Grok, default rex
//     TAOS_INTERPRETER_GROK_VOICE_2     Grok, default ara
//
// cedar and marin are the two voices OpenAI's own reference recommends for
// realtime models, and they are the pair furthest apart by ear. rex and ara
// are two of xAI's original five ("confident and clear" / "warm and
// friendly"); xAI's docs do not state a voice's gender, so that pair is a
// first guess for Tom's ears, not a finding.
//
// ElevenLabs Realtime is the exception to "stock voices", and the reason the
// arm exists: its two voices are the founders' CLONES, resolved by
// lib/tts/voice.ts (the source of truth for the IDs and for whose voice a
// direction is read in) and never restated here. There is no knob — a retrain
// is already an env edit there (ELEVENLABS_LIZ_VOICE_ID).
export const INTERPRETER_VOICE_DEFAULTS = {
  openai: ["cedar", "marin"],
  gemini: ["Charon", "Aoede"],
  grok: ["rex", "ara"]
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
  if (engine === "elevenlabs-realtime") {
    // Tom's words in Tom's clone, Liz's in Liz's — elevenLabsVoiceId() is the
    // rule every other screen plays by. A pair neither of them speaks gets
    // the account's stock multilingual voice, exactly as /api/tts would.
    return elevenLabsVoiceId(
      direction.source as Parameters<typeof elevenLabsVoiceId>[0],
      direction.target as Parameters<typeof elevenLabsVoiceId>[1]
    );
  }
  const slot = voiceSlot(direction);
  if (engine === "grok-voice") {
    return slot === 1
      ? knob(env.TAOS_INTERPRETER_GROK_VOICE_1, INTERPRETER_VOICE_DEFAULTS.grok[0])
      : knob(env.TAOS_INTERPRETER_GROK_VOICE_2, INTERPRETER_VOICE_DEFAULTS.grok[1]);
  }
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

/**
 * Does this engine bill the CLOCK — a flat rate per minute a leg is
 * connected — rather than tokens? (lib/interpreter/cost.ts has the rates;
 * the client reads a leg's seconds from the provider where it reports them
 * and from the wall clock where it does not.)
 */
export function engineBillsByTheMinute(engine: InterpreterEngine): boolean {
  return (
    engine === "openai-translate" ||
    engine === "openai-live" ||
    engine === "grok-voice" ||
    engine === "elevenlabs-realtime"
  );
}
