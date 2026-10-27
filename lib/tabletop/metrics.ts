// Measurement for the /tabletop brain A/B (Tom, 2026-10-21): Gemini Live
// Translate against gpt-realtime, same table, same voice. Cost was measured a
// wash on the Sept-28 spike (3.68¢ vs 3.88¢ a minute), so this is a
// PERFORMANCE test and these numbers are the deliverable.
//
// Pure functions only — no clock, no DOM — so the arithmetic Tom reads off
// the phone is the arithmetic the tests pin.
//
// ── What a latency number means here ───────────────────────────────────────
// Both are measured ON THE PHONE, from the end of a spoken segment:
//
//   first_partial_ms   segment end → the first translated text for it
//   segment_done_ms    segment end → the last translated text for it
//
// "Segment end" is the moment the speaker's voice stopped, and each brain has
// to find it differently, because only one of them has a VAD:
//
//   openai   server VAD's `input_audio_buffer.speech_stopped`, as received,
//            minus the session's silence_duration_ms (550). That is when the
//            voice stopped give or take one network hop — so OpenAI's numbers
//            read ~one-way-latency FASTER than the truth.
//   gemini   Live Translate has no turns and no VAD events at all. The phone
//            marks a segment end itself, from the PCM it is already sending:
//            the last voiced 100 ms chunk followed by 550 ms of unvoiced ones
//            (the same silence the OpenAI session waits for).
//
// A translation that starts BEFORE the voice stops (Gemini does this on long
// sentences — it interprets while you talk) records first_partial_ms = 0, not
// a negative number. "Already streaming when you stopped" is the honest
// reading of it.

/** One brain's half of the A/B. */
export type TabletopBrainKind = "openai" | "gemini";

/** One finished segment's timing, as the brain measured it. */
export interface SegmentTiming {
  firstPartialMs: number;
  doneMs: number;
}

/** Everything one table session accumulated, before summarising. */
export interface TabletopSessionTally {
  brain: TabletopBrainKind;
  startedAt: number;
  firstPartialMs: number[];
  segmentDoneMs: number[];
  errors: number;
  reconnects: number;
  estUsd: number;
  /** Did any turn of this session run in auto-detect mode? */
  auto: boolean;
  /** Auto-detect responses whose language tag was missing or off-pair. */
  detectMiss: number;
}

/** The numbers on the log line and the lobby card. No text, ever. */
export interface TabletopSessionSummary {
  brain: TabletopBrainKind;
  seconds: number;
  segments: number;
  first_partial_ms_p50: number;
  first_partial_ms_p95: number;
  segment_done_ms_p50: number;
  segment_done_ms_p95: number;
  errors: number;
  reconnects: number;
  est_usd: number;
  /** When the session ended, epoch ms — the card's "how long ago". */
  ended_at: number;
  /** 1 if any turn ran in auto-detect mode (lib/tabletop/autoDetect.ts). */
  auto: 0 | 1;
  /** Auto-detect responses with no usable language tag. */
  detect_miss: number;
}

export function emptyTally(brain: TabletopBrainKind, startedAt: number): TabletopSessionTally {
  return {
    brain,
    startedAt,
    firstPartialMs: [],
    segmentDoneMs: [],
    errors: 0,
    reconnects: 0,
    estUsd: 0,
    auto: false,
    detectMiss: 0
  };
}

export function addSegment(tally: TabletopSessionTally, timing: SegmentTiming): TabletopSessionTally {
  return {
    ...tally,
    firstPartialMs: [...tally.firstPartialMs, clampMs(timing.firstPartialMs)],
    segmentDoneMs: [...tally.segmentDoneMs, clampMs(timing.doneMs)]
  };
}

function clampMs(ms: number): number {
  return Number.isFinite(ms) && ms > 0 ? Math.round(ms) : 0;
}

/**
 * Nearest-rank percentile: the smallest sample that at least p% of the
 * samples are at or below. With five sessions of a dozen segments each, an
 * interpolating percentile would invent latencies nobody experienced; this
 * one only ever reports a segment that happened. Empty → 0.
 */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((Math.min(100, Math.max(0, p)) / 100) * sorted.length);
  return sorted[Math.max(0, rank - 1)];
}

export function summarize(tally: TabletopSessionTally, endedAt: number): TabletopSessionSummary {
  return {
    brain: tally.brain,
    seconds: Math.max(0, Math.round((endedAt - tally.startedAt) / 1000)),
    segments: tally.segmentDoneMs.length,
    first_partial_ms_p50: percentile(tally.firstPartialMs, 50),
    first_partial_ms_p95: percentile(tally.firstPartialMs, 95),
    segment_done_ms_p50: percentile(tally.segmentDoneMs, 50),
    segment_done_ms_p95: percentile(tally.segmentDoneMs, 95),
    errors: tally.errors,
    reconnects: tally.reconnects,
    est_usd: tally.estUsd,
    ended_at: endedAt,
    auto: tally.auto ? 1 : 0,
    detect_miss: tally.detectMiss
  };
}

/**
 * The line Tom greps for in the Vercel runtime logs, in the order he asked
 * for it. Flat key=value, like [taos-call-cost].
 */
export function tabletopLogLine(s: TabletopSessionSummary): string {
  return [
    "[taos-tabletop]",
    `brain=${s.brain}`,
    `seconds=${s.seconds}`,
    `segments=${s.segments}`,
    `first_partial_ms_p50=${s.first_partial_ms_p50}`,
    `first_partial_ms_p95=${s.first_partial_ms_p95}`,
    `segment_done_ms_p50=${s.segment_done_ms_p50}`,
    `segment_done_ms_p95=${s.segment_done_ms_p95}`,
    `errors=${s.errors}`,
    `reconnects=${s.reconnects}`,
    `est_usd=${s.est_usd.toFixed(4)}`,
    // Auto-detect (2026-10-27), appended so every field before it keeps its
    // place for anyone already grepping the line.
    `auto=${s.auto}`,
    `detect_miss=${s.detect_miss}`
  ].join(" ");
}

/**
 * What the log route accepts from a phone: the summary's numbers and nothing
 * else. Anything that is not a finite, non-negative number of the right name
 * is refused, so a string — a transcript, say — can never reach the log.
 */
export function parseSummary(raw: unknown): TabletopSessionSummary | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.brain !== "openai" && o.brain !== "gemini") return null;
  const n = (k: string, max: number): number | null => {
    const v = o[k];
    return typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= max ? v : null;
  };
  const DAY_S = 86_400;
  const MAX_MS = 600_000;
  const fields = {
    seconds: n("seconds", DAY_S),
    segments: n("segments", 100_000),
    first_partial_ms_p50: n("first_partial_ms_p50", MAX_MS),
    first_partial_ms_p95: n("first_partial_ms_p95", MAX_MS),
    segment_done_ms_p50: n("segment_done_ms_p50", MAX_MS),
    segment_done_ms_p95: n("segment_done_ms_p95", MAX_MS),
    errors: n("errors", 100_000),
    reconnects: n("reconnects", 100_000),
    est_usd: n("est_usd", 1_000),
    ended_at: n("ended_at", Number.MAX_SAFE_INTEGER)
  };
  for (const v of Object.values(fields)) if (v === null) return null;
  const f = fields as Record<keyof typeof fields, number>;
  // The auto-detect fields are newer than the line: a phone still running the
  // previous build posts without them, and that is a 0, not a refusal. Present
  // but not a number is still refused, like every other field.
  const optional = (k: string, max: number): number | null =>
    o[k] === undefined ? 0 : n(k, max);
  const auto = optional("auto", 1);
  const detectMiss = optional("detect_miss", 100_000);
  if (auto === null || detectMiss === null) return null;
  return {
    brain: o.brain,
    seconds: Math.round(f.seconds),
    segments: Math.round(f.segments),
    first_partial_ms_p50: Math.round(f.first_partial_ms_p50),
    first_partial_ms_p95: Math.round(f.first_partial_ms_p95),
    segment_done_ms_p50: Math.round(f.segment_done_ms_p50),
    segment_done_ms_p95: Math.round(f.segment_done_ms_p95),
    errors: Math.round(f.errors),
    reconnects: Math.round(f.reconnects),
    est_usd: f.est_usd,
    ended_at: Math.round(f.ended_at),
    auto: auto >= 1 ? 1 : 0,
    detect_miss: Math.round(detectMiss)
  };
}

// ── Gemini's money ─────────────────────────────────────────────────────────

/**
 * gemini-3.5-live-translate-preview, dollars per 1M tokens, as the spike
 * recorded them (lib/call/cost.ts on spike/gemini-live-translate @ a2faa41):
 * audio in $3.50, audio out $21.00, 25 tokens per second each way. The table
 * prices what `usageMetadata` reports (summed — each message is a DELTA),
 * counting promptTokenCount and responseTokenCount only, exactly as the spike
 * did. If Google's invoice runs higher, the spike's first suspect still
 * stands: the TEXT tokens in promptTokensDetails that promptTokenCount omits.
 */
export const GEMINI_RATES_USD_PER_MTOK = { audioIn: 3.5, audioOut: 21 } as const;

export function geminiUsd(promptTokens: number, responseTokens: number): number {
  const G = GEMINI_RATES_USD_PER_MTOK;
  return (Math.max(0, promptTokens) * G.audioIn + Math.max(0, responseTokens) * G.audioOut) / 1e6;
}

// ── Where a segment ends, when the brain will not say ──────────────────────

/** The OpenAI session's own silence_duration_ms (lib/tabletop/session.ts). */
export const SEGMENT_SILENCE_MS = 550;

/**
 * A segment-end clock for a brain with no VAD (Gemini).
 *
 * `chunk(at, voiced)` is fed every 100 ms chunk of mic audio sent during a
 * turn; a voiced run followed by SEGMENT_SILENCE_MS of unvoiced chunks is a
 * segment end, stamped at the END of its last voiced chunk. `flush()` closes
 * a run still open when the turn ends.
 *
 * `claim(firstAt, doneAt)` pairs one output segment with the speech it
 * translated: the LATEST unclaimed segment end at or before `doneAt`, which
 * also retires every earlier unclaimed one (Gemini can fold two of our
 * pauses into one burst of output). An output burst with no unclaimed end
 * before it — a second burst for speech already claimed — measures from the
 * most recent end there is, because that is the wait the listener had.
 */
export function createSegmentClock(silenceMs: number = SEGMENT_SILENCE_MS) {
  const ends: number[] = [];
  let claimedUpTo = -1;
  let lastVoicedEnd: number | null = null;

  const closeRun = () => {
    if (lastVoicedEnd !== null) ends.push(lastVoicedEnd);
    lastVoicedEnd = null;
  };

  return {
    /** `at` is when the chunk finished being captured. */
    chunk(at: number, voiced: boolean): void {
      if (voiced) {
        lastVoicedEnd = at;
        return;
      }
      if (lastVoicedEnd !== null && at - lastVoicedEnd >= silenceMs) closeRun();
    },
    flush(): void {
      closeRun();
    },
    claim(firstAt: number, doneAt: number): SegmentTiming | null {
      let pick = -1;
      for (let i = claimedUpTo + 1; i < ends.length; i++) {
        if (ends[i] <= doneAt) pick = i;
      }
      let ref: number | null = null;
      if (pick >= 0) {
        ref = ends[pick];
        claimedUpTo = pick;
      } else if (claimedUpTo >= 0) {
        ref = ends[claimedUpTo];
      }
      if (ref === null) return null;
      return { firstPartialMs: firstAt - ref, doneMs: doneAt - ref };
    },
    /** Test seam: the segment ends found so far. */
    ends: (): readonly number[] => ends
  };
}
