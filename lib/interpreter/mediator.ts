// The interpreter's STYLE (Tom, 2026-11-09, after the first table test):
//
//   interpreter   what the mode has been from the start — faithful, and
//                 silent otherwise. THE DEFAULT.
//   mediator      EXPERIMENTAL, off unless a founder turns it on for their
//                 device. "Not just an interpreter but a third party at the
//                 table": it still interprets everything, but may *briefly*
//                 speak up, in both languages, ONLY when meaning is at risk —
//                 a likely misunderstanding, a regional word with two
//                 meanings, a pronoun it cannot resolve — and it answers a
//                 question put to it directly ("mediator, what did she
//                 mean?").
//
// Where the idea came from: at that table GPT-Live rendered "I'm pissed off"
// as "Estoy arrecha" — angry in Venezuela and Colombia, aroused in Mexico and
// Central America. An interpreter cannot say so. A mediator can.
//
// This file is the style's vocabulary and the reading of what a mediator
// said; the PROMPT is in lib/interpreter/briefing.ts. Isomorphic and pure.
//
// ── How a note is told apart from an interpretation ────────────────────────
// The model speaks; what reaches the captions is the transcript of its voice.
// There is no side channel that works on every engine, so the mark is SPOKEN:
// every note begins with a fixed phrase in the language it is given in
// ("Mediator note: …" / "Nota del mediador: …"). The people at the table hear
// that it is the mediator and not the other person talking, and the captions
// split on the same words. The phrase comes from the chrome copy table, so a
// language somebody adds there gets its own; every other language uses the
// English one.

import { copyFor } from "@/lib/chrome/copy";

/**
 * Mediator v2 (Tom, 2026-11-10): the mediator has PERSONAS. All of them are
 * mediators — same hard rules, same spoken marker, same captions — and differ
 * only in what they notice and restate (the persona blocks in briefing.ts):
 *
 *   mediator        meaning at risk, and nothing else. The original.
 *   entendimiento   "understanding": also a reply that answered a different
 *                   question, one word carrying two meanings, a request that
 *                   was phrased as an accusation. Descriptive only.
 *   deal            also interests under positions — and the TERMS LEDGER:
 *                   on request it reads back what was explicitly agreed.
 */
export type InterpreterStyle = "interpreter" | "mediator" | "entendimiento" | "deal";

export const INTERPRETER_STYLES: readonly InterpreterStyle[] = ["interpreter", "mediator", "entendimiento", "deal"];

/** Every style that may speak for itself — everything but the interpreter. */
export type MediatorStyle = Exclude<InterpreterStyle, "interpreter">;

export function isMediatorStyle(style: InterpreterStyle | null | undefined): style is MediatorStyle {
  return style === "mediator" || style === "entendimiento" || style === "deal";
}

/** OFF by default: nothing but an explicit choice makes a mediator. */
export const DEFAULT_INTERPRETER_STYLE: InterpreterStyle = "interpreter";

/** Per-device founder choice, beside the engine's. */
export const STYLE_STORAGE_KEY = "taos.interpreter.style";

export function parseStyle(raw: unknown): InterpreterStyle | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().toLowerCase();
  return (INTERPRETER_STYLES as readonly string[]).includes(v) ? (v as InterpreterStyle) : null;
}

/** Anything that is not exactly a style's name — unset, a typo — is the interpreter. */
export function resolveStyle(stored: unknown): InterpreterStyle {
  return parseStyle(stored) ?? DEFAULT_INTERPRETER_STYLE;
}

// ── The self-introduction ──────────────────────────────────────────────────
// Tom's first Mediator table (2026-11-10): four ordinary turns, not one note —
// correct, and he could not tell it was running. So a mediator session opens
// by saying who it is, once, in both languages.
//
// A realtime model does not speak until it is given a turn, so the screen
// gives it one: when every leg is connected it sends ONE leg this line as a
// system message and asks for a response (lib/interpreter/client.ts). The
// SCRIPT is not here — it is in the briefing, locked into the session
// server-side (lib/interpreter/briefing.ts, introSection). This line is only
// the cue, and it carries nothing about anybody.
export const INTRO_TRIGGER = "SESSION START";

const INTRO_KEY = {
  mediator: "interpreterMediatorIntro",
  entendimiento: "interpreterMediatorIntroEntendimiento",
  deal: "interpreterMediatorIntroDeal"
} as const;

/**
 * What a mediator of this style says to introduce itself, in `lang`, AFTER
 * the marker — from the chrome copy table, beside the marker itself. A
 * language nobody has written the line for gets the English one (and the
 * briefing asks the model to say it in that language).
 */
export function mediatorIntroLine(style: MediatorStyle, lang: string): string {
  return copyFor(lang)[INTRO_KEY[style]];
}

/**
 * The whole introduction as it is meant to be heard: marker and line in
 * `first`, then marker and line in `second`. The briefing quotes these same
 * halves; GPT-Live, which has no "respond now" and is cued with words to say
 * (lib/interpreter/client.ts), is handed this.
 */
export function mediatorIntroSpoken(style: MediatorStyle, first: string, second: string): string {
  return [first, second].map((lang) => `${mediatorMarker(lang)}: ${mediatorIntroLine(style, lang)}`).join(" ");
}

/** The `event_id` of every frame the introduction cue sends. */
const INTRO_EVENT_ID = "taos_intro";

/**
 * Is this provider error about the introduction cue itself? Someone already
 * talking when the session opens makes `response.create` collide with the
 * response to THEM ("conversation already has an active response") — which
 * is the right outcome, not a failure: they are interpreted and the
 * introduction is skipped. It must not put an error on the screen.
 */
export function isIntroCueError(msg: Record<string, unknown>): boolean {
  if (msg.type !== "error") return false;
  const err = (msg.error && typeof msg.error === "object" ? msg.error : {}) as Record<string, unknown>;
  const id = typeof err.event_id === "string" ? err.event_id : typeof msg.event_id === "string" ? msg.event_id : "";
  return id.startsWith(INTRO_EVENT_ID);
}

/**
 * The frames that cue an introduction, per transport. Pure, so the tests pin
 * exactly what goes on the wire.
 *
 *   openai-webrtc      (gpt-realtime-2.1) the cue as a SYSTEM message, then
 *                      `response.create`. The script is in the briefing.
 *   openai-live-relay  (gpt-live-1) has no "respond now": OpenAI's documented
 *                      way to greet first is `session.commentary.append` —
 *                      "information for the model to say aloud" — so this one
 *                      carries the words (they are the copy table's, the same
 *                      ones the briefing quotes; nothing personal).
 */
export function introCueFrames(
  transport: "openai-webrtc" | "openai-live-relay",
  spoken: string
): Record<string, unknown>[] {
  if (transport === "openai-live-relay") {
    return [{ type: "session.commentary.append", event_id: `${INTRO_EVENT_ID}_say`, delegation_id: null, content: spoken }];
  }
  return [
    {
      type: "conversation.item.create",
      event_id: `${INTRO_EVENT_ID}_item`,
      item: { type: "message", role: "system", content: [{ type: "input_text", text: INTRO_TRIGGER }] }
    },
    { type: "response.create", event_id: `${INTRO_EVENT_ID}_go` }
  ];
}

/** The words a mediator note begins with, in `lang` (English where unknown). */
export function mediatorMarker(lang: string): string {
  return copyFor(lang).interpreterMediatorNote;
}

// ── Reading a mediator's transcript ────────────────────────────────────────

export interface MediatorNote {
  /** The language of the marker it began with. */
  lang: string;
  text: string;
}

export interface MediatorSplit {
  /** What was interpreted — everything before the first note. */
  interpretation: string;
  notes: MediatorNote[];
}

/**
 * Lower-case and accent-free, ONE code unit per code unit — so an index into
 * the folded text is an index into the original.
 */
function fold(text: string): string {
  let out = "";
  for (const unit of text.normalize("NFC").split("")) {
    const base = unit.normalize("NFD")[0] ?? unit;
    const lower = base.toLowerCase();
    out += lower.length === 1 ? lower : base;
  }
  return out;
}

function markerPattern(marker: string): string {
  return fold(marker)
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    // "Mediator's note" is the same mark as "Mediator note".
    .join("(?:['’]s)?[\\s\\u00a0]+");
}

/**
 * Split what a mediator said into the interpretation and its notes. `langs`
 * are the table's languages; text with no marker in it comes back whole, as
 * the interpretation, with no notes — which is every line an interpreter (as
 * opposed to a mediator) ever says.
 */
export function splitMediatorNotes(said: string, langs: readonly string[]): MediatorSplit {
  const text = said.normalize("NFC");
  if (!text.trim()) return { interpretation: text, notes: [] };

  // Longest marker first, so "Nota del mediador" is never read as a shorter one.
  const markers = [...new Set(langs)]
    .map((lang) => ({ lang, pattern: markerPattern(mediatorMarker(lang)) }))
    .filter((m) => m.pattern)
    .sort((a, b) => b.pattern.length - a.pattern.length);
  if (!markers.length) return { interpretation: text, notes: [] };

  const folded = fold(text);
  const hits: { at: number; end: number; lang: string }[] = [];
  for (const { lang, pattern } of markers) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${pattern}(?![\\p{L}\\p{N}])[\\s:,.;—–-]*`, "gu");
    for (const m of folded.matchAll(re)) {
      const at = m.index ?? 0;
      // Two languages may share a marker (the English fallback): first wins.
      if (hits.some((h) => at < h.end && at + m[0].length > h.at)) continue;
      hits.push({ at, end: at + m[0].length, lang });
    }
  }
  if (!hits.length) return { interpretation: text, notes: [] };
  hits.sort((a, b) => a.at - b.at);

  const tidy = (s: string) => s.replace(/^[\s:,.;—–-]+/u, "").trim();
  const notes: MediatorNote[] = [];
  hits.forEach((hit, i) => {
    const body = tidy(text.slice(hit.end, hits[i + 1]?.at ?? text.length));
    if (body) notes.push({ lang: hit.lang, text: body });
  });
  return { interpretation: text.slice(0, hits[0].at).trim(), notes };
}
