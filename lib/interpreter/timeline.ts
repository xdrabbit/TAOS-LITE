// A per-leg EVENT TIMELINE for one Interpreter-mode session — the thing to
// read after a table test when an engine "went quiet" and the screen cannot
// say why (Tom's Grok test, 2026-11-09: one fragment, then silence, with the
// cost meter still running).
//
// ── SHAPE ONLY, NEVER CONTENT ──────────────────────────────────────────────
// A row is: when, which leg, which way, the event's TYPE, how many, and how
// big. Nothing in this file can hold a word anybody said or a sample of
// anybody's voice:
//
//   · a transcript or a delta is recorded as its LENGTH (`chars`);
//   · audio is recorded as its BYTE COUNT (`audioBytes`);
//   · provider ids become ordinals (`r` = 1st, 2nd … response of that leg);
//   · the only strings kept are protocol tokens — an event type, a response
//     status, an error CODE — and each must pass safeToken(): one short run of
//     [A-Za-z0-9_.-]. A sentence cannot pass it (it has spaces), so nothing
//     that reads `ev.transcript`, `ev.delta` or `error.message` is ever
//     assigned to a row. Those fields are only ever measured.
//
// Pure and isomorphic: the browser transports record with it
// (lib/interpreter/client.ts), the live-fire probe records with it
// (tests/live-fire/interpreter-engines.measure.ts), the usage route re-parses
// its digest (parseTimelineDigest), and tests/tabletop-interpreter.test.ts
// pins the no-content rule.

/** One protocol token, or "?" — the only way a string gets into a row. */
export function safeToken(value: unknown, max = 64): string {
  if (typeof value === "number" && Number.isFinite(value)) return String(Math.trunc(value));
  if (typeof value !== "string") return "?";
  return value.length > 0 && value.length <= max && /^[A-Za-z0-9_.\-]+$/.test(value) ? value : "?";
}

export type TimelineDir = "in" | "out" | "note";

export interface TimelineRow {
  /** Milliseconds since the timeline began. */
  t: number;
  /** For a folded run: when its LAST event arrived. */
  t2?: number;
  leg: number;
  /** in = from the provider · out = sent by us · note = a local transport fact. */
  dir: TimelineDir;
  type: string;
  /** Events folded into this row (runs of deltas / mic appends). */
  n: number;
  /** Wire bytes — the frames' own length. */
  bytes: number;
  /** Decoded PCM bytes, for audio deltas and mic appends. */
  audioBytes?: number;
  /** LENGTH of a transcript or text delta. Never the text. */
  chars?: number;
  /** Ordinal of the response this belongs to (1 = the leg's first). */
  r?: number;
  /** Ordinal of the conversation item this belongs to. */
  i?: number;
  /** response.done: completed | cancelled | incomplete | failed. */
  status?: string;
  /** response.done status_details.reason, or a socket close code. */
  reason?: string;
  /** error.code / error.type. Never error.message. */
  code?: string;
  /**
   * speech_started only — what became of it (see "Phantom speech" below):
   * committed | peer | phantom | open.
   */
  speech?: SpeechOutcome;
  /** speech_started only: 1 = it arrived while OUR speaker was playing (or its tail). */
  spk?: 1;
  /**
   * session.created / session.updated: what the provider says the session IS
   * — protocol tokens and numbers only (see sessionConfigTokens). Never the
   * instructions, never a voice id.
   */
  cfg?: Record<string, string>;
}

// ── Phantom speech ─────────────────────────────────────────────────────────
// A provider's `speech_started` is a guess that somebody began to talk. At
// Tom and Liz's table (2026-11-09) a good half of them were the interpreter's
// own voice coming back in through the microphone. Every speech_started row
// is therefore tagged with what became of it:
//
//   committed  this leg went on to commit a turn — a person, heard.
//   peer       this leg committed nothing, but ANOTHER leg that started
//              hearing at the same moment did: the other person's language,
//              which this leg is briefed to leave alone. Normal.
//   phantom    nobody committed anything. Noise — or, with `spk: 1` beside
//              it, our own playback. After the half-duplex fix a healthy
//              table shows few of these and none with `spk`.
//   open       the session ended (or it is under PHANTOM_AFTER_MS old) before
//              it could be told.
export type SpeechOutcome = "committed" | "peer" | "phantom" | "open";
/** Two legs hear one voice within ~60 ms; this is "the same moment". */
export const PEER_SPEECH_WINDOW_MS = 2000;
/** An unanswered speech_started this old at export is called a phantom. */
export const PHANTOM_AFTER_MS = 15_000;

export interface LegTimelineMeta {
  source: string | null;
  target: string | null;
  transport: string;
}

/** What one leg did, in numbers — the part that fits in a log line. */
export interface LegDigest {
  leg: number;
  transport: string;
  /** Inbound events by type. */
  counts: Record<string, number>;
  speechStarted: number;
  /** speech_started by outcome (see "Phantom speech"), and how many came during our own playback. */
  speechCommitted: number;
  speechPeer: number;
  speechPhantom: number;
  speechInPlayback: number;
  committed: number;
  responsesCreated: number;
  /** response.done by status. */
  responsesDone: Record<string, number>;
  /** Responses that carried at least one audio frame / one transcript char. */
  responsesWithAudio: number;
  responsesWithWords: number;
  heardTranscripts: number;
  audioOutBytes: number;
  saidChars: number;
  micBytes: number;
  /** Mic chunks NOT sent because the socket was backed up. */
  micDropped: number;
  /** Speaker gate: opened / audio thrown away unplayed (bytes). */
  gateOpens: number;
  heldDroppedBytes: number;
  /** Half-duplex: how long the mic was sent as silence because we were speaking. */
  micMutedMs: number;
  /** The speaker was cut off because the PROVIDER cancelled a reply for a new turn. */
  speakerCuts: number;
  errors: number;
  /** ms from each response.created to its first audio frame. */
  firstAudioMs: number[];
  /** ms from each turn's commit to the next response's first audio frame. */
  turnToAudioMs: number[];
  /** The last thing the provider sent, and how long before the end. */
  lastInType: string;
  lastInAgoMs: number;
  /** Longest gap between two inbound events, and when it began. */
  longestInGapMs: number;
  longestInGapAtMs: number;
  /** Socket close code, if it closed underneath the session. */
  closeCode: string;
  /** From the provider's own echo of the session: is reasoning really off? */
  reasoning: string;
  /** …and which turn detection is really on. */
  vad: string;
}

export interface TimelineExport {
  v: 1;
  engine: string;
  model: string;
  startedAt: string;
  durationMs: number;
  legs: (LegTimelineMeta & { leg: number })[];
  /** Rows dropped from the FRONT because the session outgrew the buffer. */
  dropped: number;
  digest: LegDigest[];
  rows: TimelineRow[];
}

export interface LegTimeline {
  /**
   * A parsed provider event and the length of the frame it came in.
   * `speaker`: our own voice was playing (or in its tail) when it arrived.
   */
  recv: (msg: Record<string, unknown>, wireBytes: number, ctx?: { speaker?: boolean }) => void;
  /** Something we sent. `audioBytes` for a mic append. */
  sent: (type: string, wireBytes: number, audioBytes?: number) => void;
  /**
   * A local fact: socket-open, socket-close, gate-open, held-dropped,
   * mic-dropped, mic-muted, speaker-cut, mic-settings … `cfg` values must be
   * protocol tokens (safeToken) like everything else.
   */
  note: (
    type: string,
    detail?: { bytes?: number; reason?: string | number; ms?: number; cfg?: Record<string, unknown> }
  ) => void;
}

export interface SessionTimeline {
  leg: (index: number, meta: LegTimelineMeta) => LegTimeline;
  export: (nowMs?: number) => TimelineExport;
}

// ── The founder's switch ───────────────────────────────────────────────────
// Per device, like the engine choice. ON unless this device turned it off:
// the mode is founders-only and unreleased, the recorder holds no content,
// and the point of it is that the NEXT table test explains itself without
// anybody having remembered to arm it first. `?diag=0` / `?diag=1` on
// /tabletop sets it (and is remembered); so does the chip on the screen.
export const DIAG_STORAGE_KEY = "taos.interpreter.diag";

export function resolveDiagnostics(opts: { stored: unknown; query?: unknown }): boolean {
  if (opts.query === "1") return true;
  if (opts.query === "0") return false;
  return opts.stored !== "0";
}

/** `taos-interpreter-grok-voice-2026-11-09T18-02-11.json` */
export function timelineFileName(exported: TimelineExport): string {
  const stamp = exported.startedAt.replace(/\.\d+Z$/, "").replace(/:/g, "-");
  return `taos-interpreter-${safeToken(exported.engine, 32)}-${safeToken(stamp, 32)}.json`;
}

/** ~30 minutes of a two-leg table once runs are folded; the tail is what matters. */
export const TIMELINE_MAX_ROWS = 8000;
/** A folded run never spans more than this. */
export const FOLD_WINDOW_MS = 5000;
/** Mic chunks are 100 ms apart; a longer gap ends a `mic-muted` run. */
const MUTED_RUN_GAP_MS = 500;
const MAX_ORDINALS = 4000;
const MAX_SAMPLES = 400;

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

/** base64 length → decoded byte count, without decoding. */
export function base64Bytes(b64: string): number {
  const len = b64.length;
  if (!len) return 0;
  const pad = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((len * 3) / 4) - pad);
}

/** Event types that arrive in bursts and are folded into one row per run. */
function folds(type: string): boolean {
  return (
    type.endsWith(".delta") ||
    type === "input_audio_buffer.append" ||
    type === "mic-dropped" ||
    type === "mic-muted"
  );
}

const AUDIO_DELTAS = new Set(["response.output_audio.delta", "response.audio.delta"]);
const SAID_DELTAS = new Set([
  "response.output_audio_transcript.delta",
  "response.audio_transcript.delta",
  "response.output_text.delta",
  "response.text.delta",
  "session.output_transcript.delta"
]);

function emptyDigest(leg: number, transport: string): LegDigest {
  return {
    leg,
    transport,
    counts: {},
    speechStarted: 0,
    speechCommitted: 0,
    speechPeer: 0,
    speechPhantom: 0,
    speechInPlayback: 0,
    committed: 0,
    responsesCreated: 0,
    responsesDone: {},
    responsesWithAudio: 0,
    responsesWithWords: 0,
    heardTranscripts: 0,
    audioOutBytes: 0,
    saidChars: 0,
    micBytes: 0,
    micDropped: 0,
    gateOpens: 0,
    heldDroppedBytes: 0,
    micMutedMs: 0,
    speakerCuts: 0,
    errors: 0,
    firstAudioMs: [],
    turnToAudioMs: [],
    lastInType: "",
    lastInAgoMs: 0,
    longestInGapMs: 0,
    longestInGapAtMs: 0,
    closeCode: "",
    reasoning: "",
    vad: ""
  };
}

/**
 * The CONFIGURATION a provider echoes in session.created / session.updated,
 * as protocol tokens: the model, the reasoning effort, the turn detection, the
 * audio rates, the transcriber. Deliberately a pick-list — `instructions` (the
 * briefing and the founders' context block) and `voice` (a clone's id) are in
 * that same object and are never read here.
 */
export function sessionConfigTokens(session: unknown): Record<string, string> {
  const s = obj(session);
  const audio = obj(s.audio);
  const input = obj(audio.input);
  const output = obj(audio.output);
  // xAI keeps turn detection at the top; OpenAI and ElevenLabs under audio.input.
  const vadAt = s.turn_detection !== undefined ? s.turn_detection : input.turn_detection;
  const vad = vadAt === null ? "null" : safeToken(obj(vadAt).type, 24);
  const picked: Record<string, unknown> = {
    model: s.model,
    reasoning: obj(s.reasoning).effort,
    vad,
    eagerness: obj(vadAt).eagerness,
    in_rate: obj(input.format).rate,
    out_rate: obj(output.format).rate,
    transcribe: obj(input.transcription).model,
    max_s: s.max_duration_seconds
  };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(picked)) {
    const token = safeToken(value, 48);
    if (token !== "?") out[key] = token;
  }
  return out;
}

export function createSessionTimeline(opts: {
  engine: string;
  model: string;
  now?: () => number;
}): SessionTimeline {
  const now = opts.now ?? Date.now;
  const t0 = now();
  let rows: TimelineRow[] = [];
  let dropped = 0;
  const metas: (LegTimelineMeta & { leg: number })[] = [];
  const digests = new Map<number, LegDigest>();
  /** The open run of each (leg, direction, type) — what the next delta folds into. */
  const lastRow = new Map<string, TimelineRow>();
  const lastInAt = new Map<number, number>();
  /** Each leg's most recent speech_started that has not been told yet. */
  const openSpeech = new Map<number, TimelineRow>();
  const settle = (row: TimelineRow, outcome: Exclude<SpeechOutcome, "open">) => {
    row.speech = outcome;
    const digest = digests.get(row.leg);
    if (!digest) return;
    if (outcome === "committed") digest.speechCommitted += 1;
    else if (outcome === "peer") digest.speechPeer += 1;
    else digest.speechPhantom += 1;
  };

  const push = (row: TimelineRow) => {
    // Audio and transcript deltas of one response arrive interleaved, so a run
    // is "the same type on the same leg for the same response" — not "the
    // previous row". A run is also cut every FOLD_WINDOW_MS, so the mic's row
    // still shows WHEN audio was flowing, five seconds at a time.
    const key = `${row.leg}:${row.dir}:${row.type}`;
    const prev = lastRow.get(key);
    // A muted run is one stretch of our own playback: a new stretch is a new row.
    const sameStretch = row.type !== "mic-muted" || row.t - (prev?.t2 ?? prev?.t ?? 0) < MUTED_RUN_GAP_MS;
    if (prev && folds(row.type) && prev.r === row.r && row.t - prev.t < FOLD_WINDOW_MS && sameStretch) {
      prev.n += row.n;
      prev.bytes += row.bytes;
      if (row.audioBytes !== undefined) prev.audioBytes = (prev.audioBytes ?? 0) + row.audioBytes;
      if (row.chars !== undefined) prev.chars = (prev.chars ?? 0) + row.chars;
      prev.t2 = row.t;
      return;
    }
    rows.push(row);
    if (folds(row.type)) lastRow.set(key, row);
    if (rows.length > TIMELINE_MAX_ROWS) {
      const cut = Math.ceil(TIMELINE_MAX_ROWS / 10);
      rows = rows.slice(cut);
      dropped += cut;
    }
  };

  const sample = (list: number[], value: number) => {
    if (list.length < MAX_SAMPLES) list.push(Math.max(0, Math.round(value)));
  };

  return {
    leg: (index, meta) => {
      const safeMeta = {
        leg: index,
        source: meta.source === null ? null : safeToken(meta.source, 12),
        target: meta.target === null ? null : safeToken(meta.target, 12),
        transport: safeToken(meta.transport, 32)
      };
      metas.push(safeMeta);
      const digest = emptyDigest(index, safeMeta.transport);
      digests.set(index, digest);

      const ordinals = { r: new Map<string, number>(), i: new Map<string, number>() };
      const ordinal = (kind: "r" | "i", id: string): number | undefined => {
        if (!id) return undefined;
        const map = ordinals[kind];
        const known = map.get(id);
        if (known !== undefined) return known;
        if (map.size >= MAX_ORDINALS) return undefined;
        const next = map.size + 1;
        map.set(id, next);
        return next;
      };
      /** Per response ordinal: created at, and whether audio / words were seen. */
      const createdAt = new Map<number, number>();
      const hadAudio = new Set<number>();
      const hadWords = new Set<number>();
      /** The commit that the next first-audio answers. */
      let pendingCommitAt: number | null = null;

      return {
        recv: (msg, wireBytes, ctx) => {
          const t = now() - t0;
          const type = safeToken(msg.type);
          const response = obj(msg.response);
          const r = ordinal("r", str(msg.response_id) || str(response.id));
          const i = ordinal("i", str(msg.item_id) || str(obj(msg.item).id));
          const row: TimelineRow = { t, leg: index, dir: "in", type, n: 1, bytes: Math.max(0, wireBytes) };
          if (r !== undefined) row.r = r;
          if (i !== undefined) row.i = i;

          digest.counts[type] = (digest.counts[type] ?? 0) + 1;
          const prevIn = lastInAt.get(index);
          if (prevIn !== undefined && t - prevIn > digest.longestInGapMs) {
            digest.longestInGapMs = t - prevIn;
            digest.longestInGapAtMs = prevIn;
          }
          lastInAt.set(index, t);
          digest.lastInType = type;

          // A socket engine's audio arrives as delta events; a WebRTC engine's
          // arrives on a track, and `output_audio_buffer.started` is the only
          // word the data channel has about it. Either one is "first audio".
          if (AUDIO_DELTAS.has(type) || type === "output_audio_buffer.started") {
            if (AUDIO_DELTAS.has(type)) {
              // MEASURED, never kept: the delta is audio.
              const audioBytes = base64Bytes(str(msg.delta));
              row.audioBytes = audioBytes;
              digest.audioOutBytes += audioBytes;
            }
            if (r !== undefined && !hadAudio.has(r)) {
              hadAudio.add(r);
              digest.responsesWithAudio += 1;
              const created = createdAt.get(r);
              if (created !== undefined) sample(digest.firstAudioMs, t - created);
              if (pendingCommitAt !== null) {
                sample(digest.turnToAudioMs, t - pendingCommitAt);
                pendingCommitAt = null;
              }
            }
          } else if (SAID_DELTAS.has(type)) {
            // MEASURED, never kept: the delta is somebody's words.
            const chars = str(msg.delta).length;
            row.chars = chars;
            digest.saidChars += chars;
            if (r !== undefined && chars > 0 && !hadWords.has(r)) {
              hadWords.add(r);
              digest.responsesWithWords += 1;
            }
          } else if (type.endsWith(".delta")) {
            row.chars = str(msg.delta).length;
          } else if (
            type === "conversation.item.input_audio_transcription.completed" ||
            type === "conversation.item.input_audio_transcription.updated"
          ) {
            row.chars = str(msg.transcript).length;
            if (type.endsWith(".completed")) digest.heardTranscripts += 1;
          } else if (type === "input_audio_buffer.speech_started") {
            digest.speechStarted += 1;
            // The one before it never led anywhere.
            const before = openSpeech.get(index);
            if (before) settle(before, "phantom");
            row.speech = "open";
            if (ctx?.speaker) {
              row.spk = 1;
              digest.speechInPlayback += 1;
            }
            openSpeech.set(index, row);
          } else if (type === "input_audio_buffer.committed") {
            digest.committed += 1;
            pendingCommitAt = t;
            const mine = openSpeech.get(index);
            if (mine) {
              settle(mine, "committed");
              openSpeech.delete(index);
              // The other legs heard the same voice start and left it to this one.
              for (const [other, theirs] of openSpeech) {
                if (Math.abs(theirs.t - mine.t) > PEER_SPEECH_WINDOW_MS) continue;
                settle(theirs, "peer");
                openSpeech.delete(other);
              }
            }
          } else if (type === "response.created") {
            digest.responsesCreated += 1;
            if (r !== undefined) createdAt.set(r, t);
          } else if (type === "response.done") {
            const status = safeToken(response.status, 24);
            row.status = status;
            const reason = safeToken(obj(response.status_details).reason, 32);
            if (reason !== "?") row.reason = reason;
            digest.responsesDone[status] = (digest.responsesDone[status] ?? 0) + 1;
            if (r !== undefined) createdAt.delete(r);
          } else if (type === "session.created" || type === "session.updated") {
            const cfg = sessionConfigTokens(msg.session);
            if (Object.keys(cfg).length) row.cfg = cfg;
            if (cfg.reasoning) digest.reasoning = cfg.reasoning;
            if (cfg.vad) digest.vad = cfg.vad;
          } else if (type === "error") {
            const err = obj(msg.error);
            const code = safeToken(err.code, 48);
            row.code = code !== "?" ? code : safeToken(err.type, 48);
            digest.errors += 1;
          }
          push(row);
        },
        sent: (type, wireBytes, audioBytes) => {
          const row: TimelineRow = {
            t: now() - t0,
            leg: index,
            dir: "out",
            type: safeToken(type),
            n: 1,
            bytes: Math.max(0, wireBytes)
          };
          if (audioBytes !== undefined) {
            row.audioBytes = Math.max(0, audioBytes);
            digest.micBytes += row.audioBytes;
          }
          push(row);
        },
        note: (type, detail) => {
          const row: TimelineRow = {
            t: now() - t0,
            leg: index,
            dir: "note",
            type: safeToken(type),
            n: 1,
            bytes: Math.max(0, detail?.bytes ?? 0)
          };
          if (detail?.reason !== undefined) row.reason = safeToken(detail.reason, 32);
          if (detail?.cfg) {
            const cfg: Record<string, string> = {};
            for (const [key, value] of Object.entries(detail.cfg).slice(0, 12)) {
              const token = safeToken(typeof value === "boolean" ? String(value) : value, 24);
              if (token !== "?" && safeToken(key, 24) !== "?") cfg[key] = token;
            }
            if (Object.keys(cfg).length) row.cfg = cfg;
          }
          if (row.type === "mic-dropped") digest.micDropped += 1;
          else if (row.type === "mic-muted") digest.micMutedMs += Math.max(0, Math.round(detail?.ms ?? 0));
          else if (row.type === "speaker-cut") digest.speakerCuts += 1;
          else if (row.type === "gate-open") digest.gateOpens += 1;
          else if (row.type === "held-dropped") digest.heldDroppedBytes += row.bytes;
          else if (row.type === "socket-close") digest.closeCode = row.reason ?? "?";
          push(row);
        }
      };
    },
    export: (nowMs) => {
      const end = (nowMs ?? now()) - t0;
      // A speech_started nobody answered and old enough to say so: a phantom —
      // in the COPY, so a later export can still be told otherwise.
      const stale = new Set<TimelineRow>();
      const stalePerLeg = new Map<number, number>();
      for (const row of openSpeech.values()) {
        if (end - row.t < PHANTOM_AFTER_MS) continue;
        stale.add(row);
        stalePerLeg.set(row.leg, (stalePerLeg.get(row.leg) ?? 0) + 1);
      }
      return {
        v: 1,
        engine: safeToken(opts.engine, 32),
        model: safeToken(opts.model, 64),
        startedAt: new Date(t0).toISOString(),
        durationMs: Math.max(0, Math.round(end)),
        legs: metas.slice(),
        dropped,
        digest: [...digests.values()].map((d) => ({
          ...d,
          speechPhantom: d.speechPhantom + (stalePerLeg.get(d.leg) ?? 0),
          counts: { ...d.counts },
          responsesDone: { ...d.responsesDone },
          firstAudioMs: d.firstAudioMs.slice(),
          turnToAudioMs: d.turnToAudioMs.slice(),
          lastInAgoMs: Math.max(0, Math.round(end - (lastInAt.get(d.leg) ?? end)))
        })),
        rows: rows.map((row) => (stale.has(row) ? { ...row, speech: "phantom" as const } : { ...row }))
      };
    }
  };
}

// ── The digest as a log line ───────────────────────────────────────────────

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

/** The flat, numbers-only summary of one leg that the phone posts. */
export interface LegDigestSummary {
  leg: number;
  transport: string;
  speech_started: number;
  committed: number;
  responses: number;
  done_completed: number;
  done_cancelled: number;
  done_other: number;
  with_audio: number;
  with_words: number;
  heard: number;
  audio_out_bytes: number;
  said_chars: number;
  mic_bytes: number;
  mic_dropped: number;
  gate_opens: number;
  held_dropped_bytes: number;
  errors: number;
  first_audio_p50_ms: number;
  first_audio_max_ms: number;
  turn_audio_p50_ms: number;
  turn_audio_max_ms: number;
  last_in: string;
  last_in_ago_ms: number;
  longest_gap_ms: number;
  longest_gap_at_ms: number;
  close: string;
  reasoning: string;
  vad: string;
  /** Added 2026-11-09 (half-duplex). A phone on an older build posts none of them: read as 0. */
  speech_committed: number;
  speech_peer: number;
  speech_phantom: number;
  speech_in_playback: number;
  mic_muted_ms: number;
  speaker_cuts: number;
}

export function summarizeLegDigest(d: LegDigest): LegDigestSummary {
  const done = d.responsesDone;
  const completed = done.completed ?? 0;
  const cancelled = done.cancelled ?? 0;
  const all = Object.values(done).reduce((a, b) => a + b, 0);
  return {
    leg: d.leg,
    transport: d.transport,
    speech_started: d.speechStarted,
    committed: d.committed,
    responses: d.responsesCreated,
    done_completed: completed,
    done_cancelled: cancelled,
    done_other: Math.max(0, all - completed - cancelled),
    with_audio: d.responsesWithAudio,
    with_words: d.responsesWithWords,
    heard: d.heardTranscripts,
    audio_out_bytes: d.audioOutBytes,
    said_chars: d.saidChars,
    mic_bytes: d.micBytes,
    mic_dropped: d.micDropped,
    gate_opens: d.gateOpens,
    held_dropped_bytes: d.heldDroppedBytes,
    errors: d.errors,
    first_audio_p50_ms: median(d.firstAudioMs),
    first_audio_max_ms: d.firstAudioMs.length ? Math.max(...d.firstAudioMs) : 0,
    turn_audio_p50_ms: median(d.turnToAudioMs),
    turn_audio_max_ms: d.turnToAudioMs.length ? Math.max(...d.turnToAudioMs) : 0,
    last_in: d.lastInType || "none",
    last_in_ago_ms: d.lastInAgoMs,
    longest_gap_ms: d.longestInGapMs,
    longest_gap_at_ms: d.longestInGapAtMs,
    close: d.closeCode || "none",
    reasoning: d.reasoning || "unset",
    vad: d.vad || "unset",
    speech_committed: d.speechCommitted,
    speech_peer: d.speechPeer,
    speech_phantom: d.speechPhantom,
    speech_in_playback: d.speechInPlayback,
    mic_muted_ms: d.micMutedMs,
    speaker_cuts: d.speakerCuts
  };
}

const DIGEST_NUMBERS = [
  "leg",
  "speech_started",
  "committed",
  "responses",
  "done_completed",
  "done_cancelled",
  "done_other",
  "with_audio",
  "with_words",
  "heard",
  "audio_out_bytes",
  "said_chars",
  "mic_bytes",
  "mic_dropped",
  "gate_opens",
  "held_dropped_bytes",
  "errors",
  "first_audio_p50_ms",
  "first_audio_max_ms",
  "turn_audio_p50_ms",
  "turn_audio_max_ms",
  "last_in_ago_ms",
  "longest_gap_ms",
  "longest_gap_at_ms"
] as const;
/** Numbers a phone on an older build does not send; absent reads as 0. */
const DIGEST_LATER_NUMBERS = [
  "speech_committed",
  "speech_peer",
  "speech_phantom",
  "speech_in_playback",
  "mic_muted_ms",
  "speaker_cuts"
] as const;
const DIGEST_TOKENS = ["transport", "last_in", "close", "reasoning", "vad"] as const;

/**
 * Read the digests a phone posted. Rebuilt field by field: a number where a
 * number belongs, a protocol token where a token belongs, at most four legs —
 * or nothing at all. The same rule as parseInterpreterSummary: this is the
 * only way a client's words could reach the log, and they cannot.
 */
export function parseTimelineDigest(raw: unknown): LegDigestSummary[] | null {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 4) return null;
  const out: LegDigestSummary[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return null;
    const r = entry as Record<string, unknown>;
    const parsed = {} as Record<string, number | string>;
    for (const key of DIGEST_NUMBERS) {
      const v = r[key];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
      parsed[key] = Math.min(1e12, Math.round(v));
    }
    for (const key of DIGEST_LATER_NUMBERS) {
      const v = r[key] === undefined ? 0 : r[key];
      if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
      parsed[key] = Math.min(1e12, Math.round(v));
    }
    for (const key of DIGEST_TOKENS) {
      const token = safeToken(r[key]);
      if (token === "?") return null;
      parsed[key] = token;
    }
    out.push(parsed as unknown as LegDigestSummary);
  }
  return out;
}

/** One greppable line per leg: `[taos-interpreter-diag] engine=… leg=0 …`. */
export function timelineLogLine(engine: string, summary: LegDigestSummary): string {
  const parts = [`[taos-interpreter-diag]`, `engine=${safeToken(engine, 32)}`];
  for (const key of ["leg", "transport"] as const) parts.push(`${key}=${summary[key]}`);
  for (const key of DIGEST_NUMBERS) if (key !== "leg") parts.push(`${key}=${summary[key]}`);
  for (const key of DIGEST_LATER_NUMBERS) parts.push(`${key}=${summary[key]}`);
  parts.push(
    `last_in=${summary.last_in}`,
    `close=${summary.close}`,
    `reasoning=${summary.reasoning}`,
    `vad=${summary.vad}`
  );
  return parts.join(" ");
}
