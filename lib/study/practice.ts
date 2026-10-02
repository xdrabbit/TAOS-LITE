// Reading a pronunciation score so a learner can act on it.
//
// Azure hands back four numbers and a word list. Shown raw, a 61 under a row
// of all-green words looks like a bug; the viewer prototype learned to NAME
// what pulled the overall down (flow, completeness, or the words themselves)
// and to hide the one kind of word that is not the learner's fault. Those
// readings live here, pure and client-safe, so the card can render them and
// the tests can pin them.

export interface ScoredWord {
  word: string;
  accuracy: number | null;
  errorType: string | null;
}

/** The subset of /api/tutor/assess's answer that the readings below use. */
export interface ScoreLike {
  pron?: number | null;
  accuracy?: number | null;
  fluency?: number | null;
  completeness?: number | null;
  words?: ScoredWord[];
}

/**
 * A recording whose loudest sample is under this is silence: a muted mic, the
 * wrong mic, or iOS handing over a live-but-empty graph. Caught in the browser
 * so Azure is never paid to score nothing.
 */
export const SILENCE_PEAK = 0.01;

export type Band = "good" | "ok" | "poor";

export function band(n: number | null | undefined): Band | null {
  if (typeof n !== "number") return null;
  if (n >= 80) return "good";
  if (n >= 60) return "ok";
  return "poor";
}

/** Microsoft's weighted overall, or accuracy when it is absent. Rounded. */
export function overallOf(r: ScoreLike): number | null {
  const n = r.pron ?? r.accuracy;
  return typeof n === "number" ? Math.round(n) : null;
}

/**
 * The words to show. An "Insertion" is a word the learner said that is not in
 * the phrase — Azure lists it, but the phrase did not ask for it, and painting
 * it red teaches nothing. "Omission" is kept and marked: those ARE the miss.
 */
export function visibleWords(words: ScoredWord[] | undefined): ScoredWord[] {
  return (words ?? []).filter((w) => w.errorType !== "Insertion");
}

export function isMissed(w: ScoredWord): boolean {
  return w.errorType === "Omission";
}

type Cost = "pronunciation" | "flow" | "completeness";

/** Which of the three sub-scores pulled the overall down. */
export function lowestOf(r: ScoreLike): Cost {
  const rows: Array<[Cost, number]> = [
    ["pronunciation", Math.round(r.accuracy ?? 0)],
    ["flow", Math.round(r.fluency ?? 0)],
    ["completeness", Math.round(r.completeness ?? 0)]
  ];
  return rows.sort((a, b) => a[1] - b[1])[0][0];
}

const HINTS: Record<string, Record<"nice" | Cost, string>> = {
  en: {
    nice: "Nice.",
    flow: "Flow is what cost you: say it in one go, without pauses or restarts.",
    completeness: "Some words were missed — the crossed-out ones.",
    pronunciation: "Pronunciation: listen to the red and amber words again."
  },
  es: {
    nice: "Bien.",
    flow: "Lo que te costó fue la fluidez: dilo de un tirón, sin pausas ni reinicios.",
    completeness: "Faltaron palabras — las tachadas.",
    pronunciation: "Pronunciación: vuelve a escuchar las palabras en rojo y ámbar."
  }
};

/** One sentence naming what to fix, in the lesson's own language. */
export function costHint(r: ScoreLike, lang: string): string {
  const L = HINTS[lang] ?? HINTS.en;
  const overall = overallOf(r);
  if (overall !== null && overall >= 80) return L.nice;
  return L[lowestOf(r)];
}

/** The best of a learner's scores on one phrase, or null before any. */
export function bestOf(scores: Array<number | null | undefined>): number | null {
  const real = scores.filter((n): n is number => typeof n === "number");
  return real.length ? Math.round(Math.max(...real)) : null;
}
