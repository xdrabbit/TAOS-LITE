// Where the /call interpreter's lag comes from, one line per translated turn.
//
// ── The 2026-09-13 field report ────────────────────────────────────────────
// Tom and Liz, 90–120 minutes on /call. Translation quality stayed excellent;
// latency grew monotonically from roughly the 20-minute mark, in the CAPTIONS
// as well as the voice, and only a rejoin reset it — to zero, on both phones.
//
// Code reading ruled out playback drift (there is no playback scheduler),
// sample-rate mismatch, and caption-queue growth (capped at 100, and it
// survives a rejoin). Two candidates are left, and a rejoin resets both:
//
//   1. The input bridge (audioBridge.ts) accumulates delay, so the partner's
//      audio reaches OpenAI late and everything downstream is late with it.
//   2. The conversation on OpenAI's side keeps growing — items are never
//      deleted; `truncation` only limits what the model re-reads.
//
// This module does not fix either. It exists so that an ORDINARY call says
// which one it is, in the Vercel log, with no special test:
//
//     vercel logs taos-lite | grep taos-call-lag
//
// ── How to read a line ─────────────────────────────────────────────────────
// Every duration is a `performance.now()` difference — never `Date.now()`,
// which jumps when a phone corrects its clock mid-call.
//
//   audio_arrival_ms  how far the bridge's AudioContext clock has fallen
//                     behind wall time since the bridge was built. Climbing
//                     = candidate 1. Flat = the graph is keeping time.
//   vad_lag_ms        when speech_stopped ARRIVED, minus where OpenAI's own
//                     audio clock says the speech ended. The end-to-end input
//                     delay: bridge + sender + network + ingest. Constant
//                     offset is normal (VAD's 500ms silence window); growth
//                     is audio arriving late, wherever it was held.
//   transcription_ms  speech_stopped → transcription completed.
//   heard_ms          end of speech (on the audio clock) → the faint "heard"
//                     line was on screen. See the note on heardRendered.
//   gate_ms           transcription → response.create was sent. The client
//                     holds a turn until the previous translation finished
//                     generating AND playing; growth here is a backlog of
//                     speech, not a slow model, and must not be read as 2.
//   wait_ms           transcription → first token of the translation.
//   generation_ms     first token → response.done.
//
// audio_arrival_ms climbing = bridge. audio_arrival_ms flat while wait_ms
// climbs (and gate_ms does not) = history. heard_ms late = bridge.

/** What a line is about. */
export type LagKind = "turn" | "session_reset" | "manual_resync";

/**
 * Why a new interpreter session opened, carried on `session_reset`. A rejoin
 * is the natural before/after in this data, so every one says what caused it.
 */
export type LagReason =
  | "start"
  | "restart"
  | "manual_resync"
  | "auto_end_idle"
  | "auto_end_max_duration";

export const LAG_TAG = "[taos-call-lag]";

const LAG_KINDS: readonly LagKind[] = ["turn", "session_reset", "manual_resync"];
const LAG_REASONS: readonly LagReason[] = [
  "start",
  "restart",
  "manual_resync",
  "auto_end_idle",
  "auto_end_max_duration"
];

/** Which numbers each kind of line carries, in the order they print. */
const KIND_FIELDS = {
  turn: [
    "session",
    "turn",
    "session_age_ms",
    "call_age_ms",
    "audio_arrival_ms",
    "vad_lag_ms",
    "transcription_ms",
    // Not redundant with transcription_ms. See heardRendered below.
    "heard_ms",
    "gate_ms",
    "wait_ms",
    "generation_ms",
    "segments"
  ],
  session_reset: ["session", "prev_turns", "prev_session_age_ms", "call_age_ms"],
  manual_resync: ["session", "turn", "session_age_ms", "call_age_ms"]
} as const satisfies Record<LagKind, readonly string[]>;

export type LagField = (typeof KIND_FIELDS)[LagKind][number];

export interface LagRecord {
  kind: LagKind;
  /** "es->en" — which phone's interpreter this is, without naming anyone. */
  pair: string;
  reason?: LagReason;
  values: Partial<Record<LagField, number | null>>;
}

/** A day. Anything outside it is a broken clock, not a measurement. */
const LAG_MAX_MS = 86_400_000;

/** Characters that cannot forge a second log line out of one. */
export function lagLabel(value: unknown, max = 12): string {
  return typeof value === "string"
    ? value.replace(/[^0-9A-Za-z>-]/g, "").slice(0, max) || "?"
    : "?";
}

/**
 * The line, flat key=value like `[taos-call-cost]`. Shared by the phone's
 * console and the server log so the two can never disagree about a field.
 * A value that was not measured prints `?` rather than disappearing — a
 * missing `heard_ms` is itself information.
 */
export function lagLogLine(record: LagRecord, room: string): string {
  const parts = [LAG_TAG, record.kind, `room=${lagLabel(room)}`, `pair=${lagLabel(record.pair)}`];
  if (record.kind === "session_reset") parts.push(`reason=${record.reason ?? "?"}`);
  for (const field of KIND_FIELDS[record.kind]) {
    const v = record.values[field];
    parts.push(`${field}=${typeof v === "number" && Number.isFinite(v) ? Math.round(v) : "?"}`);
  }
  return parts.join(" ");
}

/**
 * Rebuild a record the phone posted, field by field. Same rule as the cost
 * route: this lands in a log Tom reads as fact, so nothing is trusted whole.
 */
export function sanitizeLagRecord(raw: unknown): LagRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const kind = LAG_KINDS.find((k) => k === r.kind);
  if (!kind) return null;
  const reason = LAG_REASONS.find((x) => x === r.reason);
  const src =
    r.values && typeof r.values === "object" ? (r.values as Record<string, unknown>) : {};
  const values: LagRecord["values"] = {};
  for (const field of KIND_FIELDS[kind]) {
    const v = src[field];
    values[field] =
      typeof v === "number" && Number.isFinite(v)
        ? Math.min(Math.max(Math.round(v), -LAG_MAX_MS), LAG_MAX_MS)
        : null;
  }
  return { kind, pair: lagLabel(r.pair), ...(reason ? { reason } : {}), values };
}

// ── The phone's side ───────────────────────────────────────────────────────

/**
 * One interpreter session's measurements. The interpreter feeds it events as
 * they arrive; it never reads a clock of its own.
 */
export interface LagSession {
  /** The session's peer connection reached `connected`. */
  opened: () => void;
  /**
   * VAD closed a segment. `audioEndMs` is the event's `audio_end_ms` (OpenAI's
   * audio clock); `audioArrivalMs` is the bridge's drift at this moment.
   */
  speechStopped: (itemId: string | null, audioEndMs: number | null, audioArrivalMs: number | null) => void;
  /** A transcription with real words — the ones that become turns. */
  transcribed: (itemId: string | null) => void;
  /** `response.create` went out. */
  requested: () => void;
  /** A delta of the translation arrived. Only the first one counts. */
  token: () => void;
  /** `response.done`. Emits the turn line. */
  done: () => void;
  /** The session was stopped, for whatever reason. */
  closed: () => void;
}

export interface CallLagLog {
  /** A handle for the next interpreter session. Inert until `opened()`. */
  session: () => LagSession;
  /**
   * The faint untranslated "heard" line is on screen.
   *
   * THE diagnostic this whole module was built around — do not remove it as
   * redundant with transcription_ms. The heard line waits behind nothing: not
   * the response gate, not the model, not the conversation history. So if it
   * is late too, the delay is upstream of OpenAI's model, which is candidate 1;
   * if it is on time while wait_ms grows, candidate 2. transcription_ms cannot
   * answer that, because it starts from an event that is ITSELF late when the
   * audio is — which is why heard_ms is measured from where OpenAI's audio
   * clock says the speech ended, not from when speech_stopped arrived.
   */
  heardRendered: () => void;
  /** The Resync button was pressed. Emits `manual_resync`. */
  manualResync: () => void;
  /** What the NEXT session_reset should give as its cause. */
  nextReason: (reason: LagReason) => void;
  /** Post whatever is buffered. */
  flush: () => void;
  /** Hang-up: final flush, stop the timer, ignore everything after. */
  end: () => void;
}

export interface CallLagLogOptions {
  room: string;
  /** Read at each line, because either phone can change language mid-call. */
  pair: () => string;
  /** Deliver a batch to the server. Rejections are counted as dropped. */
  send: (records: LagRecord[], dropped: number) => Promise<void>;
  now?: () => number;
  /** Where each line is echoed on the phone. Defaults to console.info. */
  echo?: (line: string) => void;
  /** Post once this many records are waiting. */
  flushEvery?: number;
  /** Never hold more than this; the oldest go first and are counted. */
  maxBuffered?: number;
  /** Also post on this cadence, so a quiet call still reports. 0 disables. */
  flushIntervalMs?: number;
}

interface Segment {
  itemId: string | null;
  stoppedAt: number | null;
  audioEndMs: number | null;
  audioArrivalMs: number | null;
  transcribedAt: number | null;
  heardAt: number | null;
}

interface SessionState {
  id: number;
  openedAt: number | null;
  closedAt: number | null;
  turns: number;
  /** Stopped segments waiting for their transcription, by item id. Capped. */
  stopped: Map<string, Segment>;
  lastStopped: Segment | null;
  /** The newest transcribed segment — the one the heard line shows. */
  latest: Segment | null;
  /** Transcribed segments not yet covered by a response. */
  pendingSegments: number;
  inFlight: {
    segment: Segment | null;
    segments: number;
    requestedAt: number;
    firstTokenAt: number | null;
  } | null;
}

/** Segments that never become a turn (noise, junk) age out of this. */
const MAX_STOPPED_SEGMENTS = 8;

export function createCallLagLog(options: CallLagLogOptions): CallLagLog {
  const now = options.now ?? (() => performance.now());
  const echo = options.echo ?? ((line: string) => console.info(line));
  const flushEvery = options.flushEvery ?? 10;
  const maxBuffered = options.maxBuffered ?? 40;
  const flushIntervalMs = options.flushIntervalMs ?? 60_000;

  const callStartedAt = now();
  let sessionCount = 0;
  let current: SessionState | null = null;
  let previous: { turns: number; ageMs: number } | null = null;
  let reason: LagReason = "start";
  let buffer: LagRecord[] = [];
  let dropped = 0;
  let ended = false;

  const flush = () => {
    if (buffer.length === 0 && dropped === 0) return;
    const batch = buffer;
    const lost = dropped;
    buffer = [];
    dropped = 0;
    // A failed post is counted, not retried: a retry queue on a phone with
    // no signal is exactly the unbounded buffer this must not become.
    void Promise.resolve()
      .then(() => options.send(batch, lost))
      .catch(() => {
        dropped += batch.length + lost;
      });
  };

  const timer =
    flushIntervalMs > 0 ? setInterval(flush, flushIntervalMs) : null;

  const record = (kind: LagKind, values: LagRecord["values"], why?: LagReason) => {
    if (ended) return;
    const entry: LagRecord = { kind, pair: options.pair(), ...(why ? { reason: why } : {}), values };
    echo(lagLogLine(entry, options.room));
    if (buffer.length >= maxBuffered) {
      buffer.shift();
      dropped += 1;
    }
    buffer.push(entry);
    if (buffer.length >= flushEvery) flush();
  };

  const closeOut = (s: SessionState, at: number) => {
    if (s.openedAt === null || s.closedAt !== null) return;
    s.closedAt = at;
    previous = { turns: s.turns, ageMs: at - s.openedAt };
    if (current === s) current = null;
  };

  const session = (): LagSession => {
    const s: SessionState = {
      id: 0,
      openedAt: null,
      closedAt: null,
      turns: 0,
      stopped: new Map(),
      lastStopped: null,
      latest: null,
      pendingSegments: 0,
      inFlight: null
    };
    // Only the open session may write. A handle that was replaced, closed, or
    // never connected is silent, so a straggling event from a session being
    // torn down cannot land in its successor's numbers.
    const live = () => !ended && current === s && s.closedAt === null;

    return {
      opened: () => {
        if (ended || s.openedAt !== null) return;
        const at = now();
        if (current) closeOut(current, at);
        sessionCount += 1;
        s.id = sessionCount;
        s.openedAt = at;
        current = s;
        // `turn` and `session_age_ms` start again from zero here. That is the
        // honest reading — a fresh session IS a fresh conversation and fresh
        // bridge nodes — and this line is what keeps it from being misread as
        // a call that went quiet.
        record(
          "session_reset",
          {
            session: s.id,
            prev_turns: previous?.turns ?? 0,
            prev_session_age_ms: previous?.ageMs ?? 0,
            call_age_ms: at - callStartedAt
          },
          reason
        );
        reason = "restart";
      },
      speechStopped: (itemId, audioEndMs, audioArrivalMs) => {
        if (!live()) return;
        const segment: Segment = {
          itemId,
          stoppedAt: now(),
          audioEndMs,
          audioArrivalMs,
          transcribedAt: null,
          heardAt: null
        };
        if (itemId) {
          if (s.stopped.size >= MAX_STOPPED_SEGMENTS) {
            const oldest = s.stopped.keys().next().value;
            if (oldest !== undefined) s.stopped.delete(oldest);
          }
          s.stopped.set(itemId, segment);
        }
        s.lastStopped = segment;
      },
      transcribed: (itemId) => {
        if (!live()) return;
        let segment = itemId ? s.stopped.get(itemId) : undefined;
        if (itemId && segment) s.stopped.delete(itemId);
        // No id to match on: the most recent stop is the best available guess.
        if (!segment && !itemId && s.lastStopped && s.lastStopped.transcribedAt === null) {
          segment = s.lastStopped;
        }
        const found: Segment = segment ?? {
          itemId,
          stoppedAt: null,
          audioEndMs: null,
          audioArrivalMs: null,
          transcribedAt: null,
          heardAt: null
        };
        found.transcribedAt = now();
        s.latest = found;
        s.pendingSegments += 1;
      },
      requested: () => {
        if (!live()) return;
        // One response covers every segment committed so far (the gate in
        // interpreter.ts), so it is timed against the newest of them — the
        // same one the heard line is showing.
        s.inFlight = {
          segment: s.latest,
          segments: s.pendingSegments,
          requestedAt: now(),
          firstTokenAt: null
        };
        s.pendingSegments = 0;
      },
      token: () => {
        if (!live() || !s.inFlight || s.inFlight.firstTokenAt !== null) return;
        s.inFlight.firstTokenAt = now();
      },
      done: () => {
        if (!live() || !s.inFlight || s.openedAt === null) return;
        const at = now();
        const flight = s.inFlight;
        s.inFlight = null;
        s.turns += 1;
        const seg = flight.segment;
        const diff = (later: number | null | undefined, earlier: number | null | undefined) =>
          typeof later === "number" && typeof earlier === "number" ? later - earlier : null;
        // Where the speech ended, on THIS phone's clock, according to OpenAI's
        // audio timeline: the session's audio clock starts at connect, so
        // connect + audio_end_ms is the moment the last of those samples was
        // live on this phone. Audio held in a queue arrives late but keeps its
        // place on that timeline, which is what makes this the reference that
        // can see candidate 1.
        const spokenEnd =
          seg && seg.audioEndMs !== null ? s.openedAt + seg.audioEndMs : null;
        record("turn", {
          session: s.id,
          turn: s.turns,
          session_age_ms: at - s.openedAt,
          call_age_ms: at - callStartedAt,
          audio_arrival_ms: seg?.audioArrivalMs ?? null,
          vad_lag_ms: diff(seg?.stoppedAt, spokenEnd),
          transcription_ms: diff(seg?.transcribedAt, seg?.stoppedAt),
          heard_ms: diff(seg?.heardAt, spokenEnd),
          gate_ms: diff(flight.requestedAt, seg?.transcribedAt),
          wait_ms: diff(flight.firstTokenAt, seg?.transcribedAt),
          generation_ms: diff(at, flight.firstTokenAt),
          segments: flight.segments
        });
      },
      closed: () => {
        if (ended) return;
        closeOut(s, now());
      }
    };
  };

  return {
    session,
    heardRendered: () => {
      const latest = current?.latest;
      if (ended || !latest || latest.heardAt !== null) return;
      latest.heardAt = now();
    },
    manualResync: () => {
      const at = now();
      const open = current;
      record("manual_resync", {
        session: open?.id ?? sessionCount,
        turn: open?.turns ?? previous?.turns ?? 0,
        session_age_ms: open?.openedAt != null ? at - open.openedAt : null,
        call_age_ms: at - callStartedAt
      });
      reason = "manual_resync";
    },
    nextReason: (next) => {
      reason = next;
    },
    flush,
    end: () => {
      if (ended) return;
      if (timer !== null) clearInterval(timer);
      flush();
      ended = true;
      current = null;
    }
  };
}
