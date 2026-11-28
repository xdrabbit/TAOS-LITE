// The home screen's long turn: ten minutes, recorded in pieces.
//
// ── Why ────────────────────────────────────────────────────────────────────
// A home turn was capped at five minutes because /api/translate has
// maxDuration=300 (the Vercel Pro ceiling) and one clip longer than that
// cannot be transcribed and translated inside it. Field data, 2026-11-15:
// Tom and Liz ran into that cap seven-plus times in one day of deep
// conversation (the average turn is 88 s, so most people never see it).
// Tom's decision the same day: ten minutes on the HOME page, chunked, with a
// hard stop — "we don't want to go 13 minutes and lose 13 minutes of a side".
//
// ── How ────────────────────────────────────────────────────────────────────
// The phone records in chunks of at most HOME_CHUNK_MS, rolling from one
// MediaRecorder to the next on the same mic stream
// (lib/translate/chunkedRecorder.ts). Each chunk that closes mid-turn goes to
// /api/translate as a PART — transcription only, while the speaker is still
// talking. When the speaker stops, the last chunk goes up with the earlier
// transcripts beside it; the server stitches them in order and runs ONE
// translation over the whole text, because a long thought translated in
// pieces is not the same thought.
//
// A chunk whose transcription failed does not end the turn. It becomes a
// marker — "[audio lost 4:30]" — at the place it was lost, in the transcript
// and in the translation, and everything else goes through. That is the
// bounded loss Tom asked for: the worst case is one chunk, never the turn.
//
// A turn that fits in one chunk (nearly all of them) is sent exactly as it
// was before any of this existed.
//
// Pure: no React, no DOM, no network. Shared by the phone and the route.

/** The PAID home turn's cap when TAOS_HOME_MAX_TURN_MS is unset: ten minutes. */
export const HOME_MAX_TURN_MS_DEFAULT = 600000;
/**
 * The override's floor and ceiling. The ceiling is not a preference: a kept
 * turn is stored as one file and Redo decodes it to 16 kHz mono WAV for the
 * transcriber (32 kB/s), whose upload limit is 25 MB — 13 minutes. Twelve
 * leaves room.
 */
export const HOME_MAX_TURN_MS_FLOOR = 60000;
export const HOME_MAX_TURN_MS_CEILING = 720000;

/**
 * One chunk's longest recording: 4.5 minutes. Under the route's 300 s by
 * enough that a chunk's upload, normalize, transcription and one retry all
 * fit, and small enough that a ten-minute turn is three requests.
 */
export const HOME_CHUNK_MS = 270000;

/** The most chunks one turn can have at the ceiling, with room for a short tail. */
export const HOME_MAX_CHUNKS = Math.ceil(HOME_MAX_TURN_MS_CEILING / HOME_CHUNK_MS) + 1;

/** TAOS_HOME_MAX_TURN_MS → a usable cap. Anything unreadable is the default. */
export function homeMaxTurnMs(raw: string | undefined | null): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  if (!Number.isFinite(n) || n <= 0) return HOME_MAX_TURN_MS_DEFAULT;
  return Math.min(HOME_MAX_TURN_MS_CEILING, Math.max(HOME_MAX_TURN_MS_FLOOR, n));
}

// ── Who gets the ten minutes ───────────────────────────────────────────────
// Tom and Liz, 2026-11-15 (20:32 MT), on this PR: the ten-minute turn is a
// PAID benefit. A free or trial user keeps the five-minute cap the home
// screen has always had; a paying subscriber, a comped account and a founder
// get ten. Nothing else about a turn differs by tier — a free turn past 4.5
// minutes rolls into a second chunk like anyone's.
//
// "Paying" is not decided here. The home screen asks lib/supabase.ts's
// isSubscriber() — the profile's subscription_status/tier, the fields the
// Stripe webhook writes — and lib/release.ts's isFounder(), and hands the
// answer to homeTurnCapMs() below.

/** A free user's cap when TAOS_HOME_MAX_TURN_FREE_MS is unset: five minutes. */
export const HOME_MAX_TURN_FREE_MS_DEFAULT = 300000;

/**
 * TAOS_HOME_MAX_TURN_FREE_MS → a usable free cap. Anything unreadable is the
 * default, the floor is the paid cap's floor, and it is never ABOVE the paid
 * cap: lowering TAOS_HOME_MAX_TURN_MS under five minutes lowers this too, so
 * a knob cannot make paying the worse deal.
 */
export function homeMaxTurnFreeMs(raw: string | undefined | null, paidCapMs: number = HOME_MAX_TURN_MS_DEFAULT): number {
  const n = Number.parseInt((raw ?? "").trim(), 10);
  const wanted = !Number.isFinite(n) || n <= 0 ? HOME_MAX_TURN_FREE_MS_DEFAULT : Math.max(HOME_MAX_TURN_MS_FLOOR, n);
  return Math.min(wanted, paidCapMs);
}

/** This user's cap: the paid one for a subscriber or founder, the free one otherwise. */
export function homeTurnCapMs(paid: boolean, paidCapMs: number, freeCapMs: number): number {
  return paid ? paidCapMs : Math.min(freeCapMs, paidCapMs);
}

// ── The cap, robustly ──────────────────────────────────────────────────────
// 2026-11-10: one home turn recorded 2,236 s — 37 minutes — because the cap
// was a single setTimeout and it never fired (the tab was backgrounded or the
// phone suspended it; a timer that is lost is lost for good). The cap is now
// a question asked over and over — on a one-second interval, on every
// animation frame, and whenever the page becomes visible again — and the
// answer comes from two clocks, because each one can stall where the other
// does not: performance.now() may stop while a phone sleeps, and Date.now()
// can be moved by the system clock.

export interface TurnClock {
  /** performance.now() at the start of the turn. */
  perf: number;
  /** Date.now() at the start of the turn. */
  wall: number;
}

/** How long the turn has run, by whichever clock says longer. */
export function turnElapsedMs(start: TurnClock, now: TurnClock): number {
  return Math.max(now.perf - start.perf, now.wall - start.wall, 0);
}

/** Has the turn reached its cap? */
export function turnCapReached(start: TurnClock, now: TurnClock, capMs: number): boolean {
  return turnElapsedMs(start, now) >= capMs;
}

// ── Stitching ──────────────────────────────────────────────────────────────

/** One chunk as the stitcher sees it: what was heard, or how much was lost. */
export interface ChunkResult {
  /** The transcript; "" when the chunk held no speech. Null when it FAILED. */
  text: string | null;
  /** How long the chunk recorded, ms — what a lost marker reports. */
  ms: number;
}

/** `4:30` — minutes and zero-padded seconds, rounded to the second. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// The marker's words. English and Spanish only: lib/chrome/copy.ts's rule is
// that nobody invents a translation in a language nobody here can check, and
// an absent language falls back to English.
const LOST_WORDS: Record<string, string> = {
  en: "audio lost",
  es: "audio perdido" // pendiente de revisión por Liz
};

/** `[audio lost 4:30]` / `[audio perdido 4:30]`. */
export function lostMarker(lang: string | null | undefined, ms: number): string {
  const words = LOST_WORDS[(lang ?? "").toLowerCase()] ?? LOST_WORDS.en;
  return `[${words} ${formatClock(ms)}]`;
}

/** Anything shaped like a lost marker, in any language: `[… 4:30]`. */
export const LOST_MARKER_PATTERN = /\[[^[\]]*\d+:\d{2}\]/g;

export function countLostMarkers(text: string): number {
  return text.match(LOST_MARKER_PATTERN)?.length ?? 0;
}

/**
 * The turn as runs of speech and the holes between them: consecutive chunks
 * that were heard are one run of text (a quiet chunk adds nothing), and a
 * chunk that failed is a hole of its length.
 */
export type TurnPiece = { kind: "text"; text: string } | { kind: "lost"; ms: number };

export function turnPieces(parts: ChunkResult[]): TurnPiece[] {
  const pieces: TurnPiece[] = [];
  for (const part of parts) {
    if (part.text === null) {
      pieces.push({ kind: "lost", ms: part.ms });
      continue;
    }
    const text = part.text.trim();
    if (!text) continue;
    const last = pieces[pieces.length - 1];
    if (last?.kind === "text") last.text = `${last.text} ${text}`;
    else pieces.push({ kind: "text", text });
  }
  return pieces;
}

export interface Stitched {
  /** The whole turn's transcript, in order, markers where chunks were lost. */
  text: string;
  pieces: TurnPiece[];
  chunks: number;
  failed: number;
  /** Whether any chunk carried words at all. */
  heard: boolean;
}

/** Join the chunks' transcripts in order; a failed chunk becomes its marker. */
export function stitchTranscripts(parts: ChunkResult[], markerLang: string | null | undefined): Stitched {
  const pieces = turnPieces(parts);
  return {
    text: pieces.map((p) => (p.kind === "text" ? p.text : lostMarker(markerLang, p.ms))).join(" "),
    pieces,
    chunks: parts.length,
    failed: pieces.filter((p) => p.kind === "lost").length,
    heard: pieces.some((p) => p.kind === "text")
  };
}

// ── Translating a turn with a hole in it ───────────────────────────────────
// A whole turn is ONE translation — that is the point of stitching. A turn
// that LOST a chunk is different, and the difference was measured, not
// guessed (tests/live-fire/home-long-turn.measure.ts, 2026-11-15): handed
// "… [audio lost 0:19] …" inside the text, the translator dropped the marker
// three times out of three in manual mode. A marker put back at the end says
// THAT something was lost but not WHERE, and the listener is left with two
// halves of a thought spliced together as if they were one.
//
// So when — and only when — a chunk was lost, each run of speech is
// translated on its own and the marker is placed between the translations
// by this code, in the listener's language, exactly where the hole is. The
// thought was already broken there, by minutes of missing audio.

/** A manual turn: each run's translation, the holes marked between them. */
export function weaveTranslations(
  pieces: TurnPiece[],
  translations: string[],
  targetLang: string | null | undefined
): string {
  let next = 0;
  return pieces
    .map((p) => (p.kind === "text" ? (translations[next++] ?? "").trim() : lostMarker(targetLang, p.ms)))
    .filter(Boolean)
    .join(" ");
}

interface WovenSegment {
  sourceLanguage: string;
  targetLanguage: string;
  original: string;
  translation: string;
}

/**
 * An auto turn: each run's segments, in order, with every hole marked on
 * the segment before it (after it, when the turn opens with a hole) — on
 * the transcript in the owner's language, on the translation in that
 * segment's target language. Runs that meet across a hole in the SAME
 * direction become one segment, so a one-language turn is still one
 * segment, one saved row, and one voice.
 */
export function weaveSegments<S extends WovenSegment>(
  pieces: TurnPiece[],
  runs: S[][],
  markerLang: string | null | undefined
): S[] {
  const out: S[] = [];
  let next = 0;
  let opening: number[] = [];
  let afterHole = false;
  for (const piece of pieces) {
    if (piece.kind === "lost") {
      const last = out[out.length - 1];
      if (last) {
        out[out.length - 1] = {
          ...last,
          original: `${last.original} ${lostMarker(markerLang, piece.ms)}`,
          translation: `${last.translation} ${lostMarker(last.targetLanguage, piece.ms)}`
        };
      } else {
        opening.push(piece.ms);
      }
      afterHole = true;
      continue;
    }
    const run = runs[next++] ?? [];
    run.forEach((segment, i) => {
      let seg = segment;
      if (opening.length > 0) {
        seg = {
          ...seg,
          original: `${opening.map((ms) => lostMarker(markerLang, ms)).join(" ")} ${seg.original}`,
          translation: `${opening.map((ms) => lostMarker(seg.targetLanguage, ms)).join(" ")} ${seg.translation}`
        };
        opening = [];
      }
      const last = out[out.length - 1];
      if (i === 0 && afterHole && last && last.sourceLanguage === seg.sourceLanguage) {
        out[out.length - 1] = {
          ...last,
          original: `${last.original} ${seg.original}`,
          translation: `${last.translation} ${seg.translation}`
        };
      } else {
        out.push(seg);
      }
    });
    afterHole = false;
  }
  return out;
}

// ── The request's `prior` field ────────────────────────────────────────────

/** The longest stitched transcript the route will take from earlier chunks. */
export const PRIOR_MAX_CHARS = 24000;

/**
 * The earlier chunks, as the phone reports them on the final request:
 * `[{ "text": "…", "ms": 270000 }, { "lost": true, "ms": 270000 }]`.
 * Null on anything malformed — the route then answers 400 rather than
 * translate half a turn as though it were whole. `maxChunks` is the whole
 * turn's limit (the earlier chunks plus the final one); /api/dictate passes
 * its own.
 */
export function parsePriorField(raw: unknown, maxChunks: number = HOME_MAX_CHUNKS): ChunkResult[] | null {
  if (typeof raw !== "string" || !raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length >= maxChunks) return null;
  const out: ChunkResult[] = [];
  let chars = 0;
  for (const item of parsed) {
    if (!item || typeof item !== "object") return null;
    const { text, lost, ms } = item as { text?: unknown; lost?: unknown; ms?: unknown };
    const length = typeof ms === "number" && Number.isFinite(ms) && ms >= 0 ? Math.round(ms) : 0;
    if (lost === true) {
      out.push({ text: null, ms: length });
    } else if (typeof text === "string") {
      chars += text.length;
      out.push({ text, ms: length });
    } else {
      return null;
    }
  }
  return chars <= PRIOR_MAX_CHARS ? out : null;
}

/** The phone's side of the same field. */
export function serializePrior(parts: ChunkResult[]): string {
  return JSON.stringify(
    parts.map((p) => (p.text === null ? { lost: true, ms: Math.round(p.ms) } : { text: p.text, ms: Math.round(p.ms) }))
  );
}

// ── Time for a long translation ────────────────────────────────────────────
// The one translation of a ten-minute turn writes a few thousand tokens. The
// 60 s the chat completion has always had is right for a five-minute turn
// and not for twice that, so the allowance grows with the text — and stops
// well short of the route's 300 s.

export const LONG_TRANSLATE_FROM_CHARS = 4000;
export const LONG_TRANSLATE_TIMEOUT_MS = 150000;

/** How long the translation may take for a transcript this long. */
export function translateTimeoutFor(chars: number, baseMs: number): number {
  if (chars <= LONG_TRANSLATE_FROM_CHARS) return baseMs;
  const scaled = Math.round(baseMs * (chars / LONG_TRANSLATE_FROM_CHARS));
  return Math.min(LONG_TRANSLATE_TIMEOUT_MS, Math.max(baseMs, scaled));
}

// ── Saying a long translation ──────────────────────────────────────────────
// One /api/tts call synthesizes one line and gives the provider 45 s to do
// it. A ten-minute turn's translation can run past nine thousand characters,
// which no engine here returns in that time (and one refuses outright), so a
// long line is spoken in sentence-aligned pieces and joined — the same join
// a mixed-language turn already uses. A line short enough for one call is
// one call, exactly as before.

/** Longer than this and the line is spoken in pieces. Above any 5-minute turn's usual length. */
export const LONG_SPEECH_FROM_CHARS = 4500;
/** The most one piece carries. */
export const SPEECH_PIECE_MAX_CHARS = 3000;

/** Split a long line at sentence ends (then at spaces) into pieces of at most `max` chars. */
export function splitForSpeech(
  text: string,
  from: number = LONG_SPEECH_FROM_CHARS,
  max: number = SPEECH_PIECE_MAX_CHARS
): string[] {
  const whole = text.trim();
  if (whole.length <= from) return whole ? [whole] : [];
  // A sentence: everything up to and including its closing punctuation.
  const sentences = whole.match(/[^.!?。！？…\n]+[.!?。！？…]*["'”’)\]]*\s*|\n+/g) ?? [whole];
  const pieces: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) pieces.push(current.trim());
    current = "";
  };
  for (const sentence of sentences) {
    if (sentence.length > max) {
      // One enormous sentence: break it at spaces.
      push();
      let rest = sentence;
      while (rest.length > max) {
        const cut = rest.lastIndexOf(" ", max);
        const at = cut > max / 2 ? cut : max;
        pieces.push(rest.slice(0, at).trim());
        rest = rest.slice(at);
      }
      current = rest;
      continue;
    }
    if (current.length + sentence.length > max) push();
    current += sentence;
  }
  push();
  return pieces;
}

// ── Test knobs (founders only) ─────────────────────────────────────────────
// A six-minute monologue is a slow way to find out whether a seam works. A
// FOUNDER can shorten the chunk and force one to fail from the address bar:
//
//   /?chunk=30          chunks of 30 s instead of 4.5 min (5 s – 4.5 min)
//   /?failchunk=2       the 2nd chunk's transcription is treated as failed
//                       (the phone never sends it), so the lost marker and
//                       the rest of the flow can be seen on a real turn
//
// Nobody else's phone reads these, and the turn cap is not one of them.

export interface LongTurnKnobs {
  chunkMs: number;
  /** 0-based index of the chunk to fail, or null. */
  failIndex: number | null;
}

export const TEST_CHUNK_MIN_MS = 5000;

export function longTurnKnobs(search: string | null | undefined, founder: boolean): LongTurnKnobs {
  const knobs: LongTurnKnobs = { chunkMs: HOME_CHUNK_MS, failIndex: null };
  if (!founder || !search) return knobs;
  const q = new URLSearchParams(search);
  const seconds = Number(q.get("chunk"));
  if (Number.isFinite(seconds) && seconds * 1000 >= TEST_CHUNK_MIN_MS && seconds * 1000 <= HOME_CHUNK_MS) {
    knobs.chunkMs = Math.round(seconds * 1000);
  }
  const fail = Number.parseInt(q.get("failchunk") ?? "", 10);
  if (Number.isFinite(fail) && fail >= 1 && fail <= HOME_MAX_CHUNKS) knobs.failIndex = fail - 1;
  return knobs;
}
