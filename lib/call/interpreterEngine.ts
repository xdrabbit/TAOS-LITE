// The contract a /call interpreter engine satisfies, whichever provider is
// behind it.
//
// Extracted 2026-09-28 for Tom's Gemini bake-off. These types lived inside
// lib/call/interpreter.ts, which is the OpenAI engine; they were already
// nearly engine-neutral, so the extraction is a MOVE, not a redesign. What an
// engine does:
//
//   start/stop      startX(config, events) → ActiveInterpreter; stop()
//   input audio     config.inputTrack — the remote partner's track, and
//                   ONLY theirs. One session per phone, fed one speaker.
//   captions        onHeard / onTranslationDelta / onTranslationDone
//   diagnostics     onDiagnostic / onHearing / onInputSilent / inputStats()
//   spend           onSpend / spend(), in lib/call/cost.ts's CallSpend
//
// The OpenAI engine (interpreter.ts) is the first implementation and did not
// change. The Gemini engine (interpreterGemini.ts) is the second. Nothing
// here is shaped for a third that does not exist.

import type { CallSpend } from "./cost";
import type { CallDirection } from "./instructions";
import type { LagSession } from "./lag";

/** Which provider interprets. Chosen per call, in the lobby, by a founder. */
export type InterpreterEngine = "openai" | "gemini";

/** What a call gets when nobody chose: the engine that has shipped. */
export const DEFAULT_INTERPRETER_ENGINE: InterpreterEngine = "openai";

export function parseInterpreterEngine(value: unknown): InterpreterEngine {
  return value === "gemini" ? "gemini" : DEFAULT_INTERPRETER_ENGINE;
}

export type InterpreterState =
  | "idle"
  | "minting"
  | "connecting"
  | "connected"
  | "stopping"
  | "error";

/** How the translation reaches the listener's ear. See the note above. */
export type InterpreterVoiceMode = "clone" | "instant";

/** Why a session ended on its own, when it did. */
export type InterpreterEndReason = "idle" | "max_duration";

export interface InterpreterConfig {
  /** Which language becomes which. `target` is what this phone's owner hears. */
  direction: CallDirection;
  /** The remote call partner's audio track (from the call peer connection). */
  inputTrack: MediaStreamTrack;
  /** Start with translated audio muted (captions only). */
  muted?: boolean;
  /** OpenAI only. Gemini always speaks in its own voice. */
  voiceMode?: InterpreterVoiceMode;
  /** Hard session cap. Defaults to 60 min — the API's own ceiling. */
  maxDurationMs?: number;
  /** Hang up after this long with nothing said. Defaults to 2 min. */
  idleTimeoutMs?: number;
  /**
   * Where this session's per-turn timings go (lib/call/lag.ts). Measurement
   * only — nothing here changes what the interpreter does.
   */
  lag?: LagSession;
}

/**
 * What the session is actually HEARING, as numbers rather than as an absence.
 *
 * The 2026-09-03 field report was two connected interpreters that translated
 * nothing, and there was no way to tell "the audio is silent" from "the model
 * is quiet" from "the events are not arriving" — all three look like dead
 * air. These are the three measurements that separate them.
 */
export interface InterpreterInputStats {
  /** VAD segments the session started hearing. Zero is the whole symptom. */
  speechStarted: number;
  /** Segments VAD closed and committed for transcription. */
  speechCommitted: number;
  /** Latest instantaneous level on the outbound track, or null if unreported. */
  level: number | null;
  /** Cumulative audio energy on the outbound track, or null if unreported. */
  energy: number | null;
  /** Whether the track reached the session through the WebAudio bridge. */
  bridged: boolean;
}

export interface InterpreterEvents {
  onState?: (s: InterpreterState) => void;
  onError?: (msg: string) => void;
  /** Finalized transcription of what the remote partner said (source language). */
  onHeard?: (text: string) => void;
  /** Streaming chunk of the current translation. */
  onTranslationDelta?: (delta: string) => void;
  /** The translation finished; `text` is its full transcript. */
  onTranslationDone?: (text: string) => void;
  /**
   * The interpreter's translated AUDIO started/stopped playing on THIS phone.
   * Relay it to the partner: they are the one who can talk over it (they
   * can't hear this side), so their phone shows the "hold on" indicator.
   */
  onSpeaking?: (speaking: boolean) => void;
  /** The running bill for this phone, after every response and every readout. */
  onSpend?: (spend: CallSpend) => void;
  /**
   * Nothing has been said for a while and the session will end soon unless
   * someone speaks. `secondsLeft` counts down; null clears the warning.
   */
  onIdleWarning?: (secondsLeft: number | null) => void;
  /** The session closed itself rather than being hung up. */
  onAutoEnd?: (reason: InterpreterEndReason) => void;
  /**
   * Whether the partner's audio is actually REACHING the session.
   *
   * "Connected" is not the same question. The interpreter is fed the remote
   * call partner's WebRTC track, forwarded out of the call's own peer
   * connection into this one, and a forwarded track that carries silence
   * looks identical to a healthy one from every angle the client can see:
   * the peer connection is connected, the data channel is open, no error is
   * ever raised, and nothing happens for the rest of the call. This flips
   * true the first time server VAD reports speech, which is the only proof
   * available that the far end's voice arrived — and it stays false, visibly,
   * when it does not.
   */
  onHearing?: (hearing: boolean) => void;
  /**
   * One line of interpreter trail — the input level, the speech-segment count.
   * Same surface as the call's own diagnostics, and for the same reason: the
   * next silent interpreter should be readable, not guessable.
   */
  onDiagnostic?: (line: string) => void;
  /**
   * Connected for a while, hearing nothing, and the numbers agree. Distinct
   * from the idle warning: idle means nobody spoke, this means somebody may
   * well have and none of it reached the session.
   */
  onInputSilent?: () => void;
  /** See InterpreterSessionReport. The OpenAI engine never calls this. */
  onSessionReport?: (report: InterpreterSessionReport) => void;
}

export interface ActiveInterpreter {
  stop: () => Promise<void>;
  setMuted: (muted: boolean) => void;
  /**
   * Re-point the interpreter without tearing the session down — either phone
   * can change its language mid-call, and the partner's phone finds out over
   * the call's signaling channel.
   */
  setDirection: (direction: CallDirection) => void;
  /** The bill so far, for the hang-up report. */
  spend: () => CallSpend;
  /** What the session heard, for the hang-up report and the log line. */
  inputStats: () => InterpreterInputStats;
}

/**
 * One interpreter session's closing numbers, reported by the ENGINE rather
 * than read by the screen at hang-up.
 *
 * Only the Gemini engine fires it, and it fires it unconditionally for every
 * session that reached "connected". E8 found that a call which ends badly
 * posts no usage record at all — CallShell's endCall/reportSpend has three
 * gates, and a session that auto-ended, lost its partner, or was replaced by
 * a Resync slips through all of them. A bake-off cannot afford a missing
 * arm, so the evaluation arm does not go through those gates.
 */
export interface InterpreterSessionReport {
  spend: CallSpend;
  /** Seconds from "connected" to stop. */
  seconds: number;
  inputStats: InterpreterInputStats;
  /** Why it stopped: "hangup", "idle", "max_duration", "error", … */
  endedBy: string;
}

export type StartInterpreter = (
  config: InterpreterConfig,
  events: InterpreterEvents
) => Promise<ActiveInterpreter>;
