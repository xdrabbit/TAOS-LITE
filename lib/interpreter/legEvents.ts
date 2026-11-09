// What a leg's provider events MEAN, with no browser in it. A leg is one
// provider session of an Interpreter-mode table (lib/interpreter/plan.ts);
// its transport (WebRTC data channel, Gemini socket — lib/interpreter/
// client.ts) hands every parsed server event to a reader from this file, and
// the reader turns them into the five things the table cares about: captions,
// "somebody is talking", usage, barge-ins and errors.
//
// Pure on purpose. The transports cannot run under vitest; these can, and
// this is where the mistakes would be — which event carries the transcript,
// which response belongs to which utterance, when a caption is finished.
//
// Three dialects:
//   realtime   the GA Realtime API (gpt-realtime-2.1): turns, items,
//              responses, per-response token usage.
//   stream     gpt-realtime-translate and gpt-live-1: `session.*` transcript
//              deltas with no turn boundaries at all; usage in seconds.
//   gemini     Gemini Live: serverContent transcriptions, turnComplete,
//              interrupted, usageMetadata deltas.
// The last two share one reader behind a small normaliser.

import type { RealtimeUsage } from "@/lib/call/cost";
import {
  hasWords,
  looksLikeEcho,
  spokenWords,
  stripControlMarkers,
  withoutLeadingRepeat
} from "./captionFilter";
import type { CaptionUpdate } from "./captions";
import type { GeminiUsageMetadata } from "./cost";

export interface LegIdentity {
  index: number;
  /** Null on a one-session table. */
  source: string | null;
  target: string | null;
}

export interface LegSink {
  caption: (update: CaptionUpdate) => void;
  /** Someone spoke, or the interpreter did. Feeds the idle clock. */
  activity: () => void;
  usage: (usage: RealtimeUsage) => void;
  geminiUsage: (usage: GeminiUsageMetadata) => void;
  /** Seconds the caption transcriber billed for one utterance. */
  transcribed: (seconds: number) => void;
  /** Provider-reported session seconds for this leg — CUMULATIVE. */
  billed: (seconds: number) => void;
  /** The interpreter was cut off mid-speech by someone talking. */
  bargeIn: () => void;
  /**
   * Should this leg be audible right now? A leg told to keep silent still
   * returns a short run of wordless audio frames (measured, see engine.ts);
   * it is opened only once a response has WORDS and closed when that
   * response's audio has finished playing.
   */
  gate: (open: boolean) => void;
  /** Playback already queued must be dropped (Gemini's `interrupted`). */
  flushAudio: () => void;
  /**
   * A response (or a streamed turn) has ended without a single word. Audio a
   * transport was holding back for it — see `gate` — is thrown away, unplayed.
   */
  responseSilent: () => void;
  error: (message: string) => void;
  /** The provider says the session is over. */
  closed: () => void;
}

export interface LegReader {
  handle: (event: Record<string, unknown>) => void;
  /** Called a few times a second; closes captions that have gone quiet. */
  tick: (nowMs: number) => void;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" ? (v as Record<string, unknown>) : {};

function errorMessage(ev: Record<string, unknown>): string {
  const err = obj(ev.error);
  return (str(err.message) || str(ev.message) || "Realtime error.").slice(0, 200);
}

// ── realtime ───────────────────────────────────────────────────────────────

/**
 * The GA Realtime dialect. One caption per RESPONSE that has words; the words
 * the speaker said are attached from the input item that response answered.
 * A response with no words — the silent leg's — makes no caption at all, so
 * two legs hearing the same sentence still put ONE entry on the screen.
 */
export interface RealtimeReaderOptions {
  now?: () => number;
  /**
   * ElevenLabs Realtime only (see "An echo is not an interpretation" in
   * captionFilter.ts). With it on, a response is decided ONCE, when its audio
   * starts — by then its words are in — and one that repeats what was heard
   * is never played and never captioned.
   */
  echoGuard?: boolean;
  /**
   * What the table's OTHER legs have heard, so this one can take a sentence
   * they already captioned off the front of its own (a cascade that skipped
   * a turn glues that turn's audio onto the next).
   */
  peers?: PeerHeard;
}

/** Recent "heard" lines per leg index, newest last. Shared by a table's legs. */
export type PeerHeard = Map<number, string[]>;

export function createPeerHeard(): PeerHeard {
  return new Map();
}

export function createRealtimeReader(
  leg: LegIdentity,
  sink: LegSink,
  options: RealtimeReaderOptions | (() => number) = {}
): LegReader {
  const opts: RealtimeReaderOptions = typeof options === "function" ? { now: options } : options;
  const now = opts.now ?? Date.now;
  const echoGuard = opts.echoGuard === true;
  /** echoGuard: the verdict on each response, once its audio has started. */
  const verdict = new Map<string, "play" | "echo">();
  const audioStarted = new Set<string>();
  /**
   * Utterances committed but not yet interpreted, oldest first. Semantic VAD
   * splits "So how was your day? … Did you get to rest?" into two items; the
   * speaker's second half cancels the response to the first, and the next
   * response interprets BOTH — so its caption must show both. An item leaves
   * this list when a response to it has words, or finishes on purpose with
   * none (the leg that is meant to keep quiet).
   */
  let pendingItems: string[] = [];
  const heardByItem = new Map<string, string>();
  const itemsOfResponse = new Map<string, string[]>();
  const saidByResponse = new Map<string, string>();
  const startedAt = new Map<string, number>();
  /** The response whose words are currently allowed out of the speaker. */
  let gatedOpenFor: string | null = null;

  const liveResponses = new Set<string>();
  const captionId = (responseId: string) => `${leg.index}:${responseId}`;
  const consume = (responseId: string) => {
    const mine = new Set(itemsOfResponse.get(responseId) ?? []);
    if (mine.size) pendingItems = pendingItems.filter((item) => !mine.has(item));
  };

  /**
   * What a response has SAID, once control markers are out of it — "" until
   * there is a word. A silence token, a `<no speech>`, a lone "…" are not
   * speech: they open no caption and no speaker (lib/interpreter/
   * captionFilter.ts).
   */
  const words = (responseId: string) => spokenWords(saidByResponse.get(responseId) ?? "");

  const heardOf = (responseId: string): string => {
    let heard = (itemsOfResponse.get(responseId) ?? [])
      .map((item) => heardByItem.get(item) ?? "")
      .filter(Boolean)
      .join(" ");
    for (const [index, lines] of opts.peers ?? []) {
      if (index === leg.index) continue;
      for (const line of lines) heard = withoutLeadingRepeat(heard, line);
    }
    return heard;
  };

  /** May this response be heard and shown? (Always, without the echo guard.) */
  const playing = (responseId: string) => !echoGuard || verdict.get(responseId) === "play";

  /**
   * Open the speaker for a response that has words — at once, or, with the
   * echo guard, only when its audio has started and its words are not a
   * repetition of what it heard.
   */
  const decide = (responseId: string) => {
    if (!words(responseId)) return;
    if (echoGuard && !verdict.has(responseId)) {
      if (!audioStarted.has(responseId)) return;
      // Judged against everything this leg has just heard, not only what is
      // left after the other leg's sentence is taken off the front.
      const heardRaw = (itemsOfResponse.get(responseId) ?? [])
        .map((item) => heardByItem.get(item) ?? "")
        .join(" ");
      const echo = looksLikeEcho(words(responseId), heardRaw);
      verdict.set(responseId, echo ? "echo" : "play");
      if (echo) return;
      consume(responseId);
    }
    if (!playing(responseId)) return;
    if (gatedOpenFor !== responseId) {
      gatedOpenFor = responseId;
      sink.gate(true);
    }
  };

  const emit = (responseId: string, live: boolean) => {
    const said = words(responseId);
    if (!said || !playing(responseId)) return;
    const heard = heardOf(responseId);
    sink.caption({
      id: captionId(responseId),
      source: leg.source,
      target: leg.target,
      heard,
      said,
      live,
      at: startedAt.get(responseId) ?? now()
    });
  };

  return {
    tick: () => {},
    handle: (ev) => {
      const type = str(ev.type);

      if (type === "input_audio_buffer.speech_started") {
        sink.activity();
        return;
      }
      if (type === "input_audio_buffer.committed") {
        const item = str(ev.item_id);
        if (item) pendingItems = [...pendingItems, item].slice(-6);
        return;
      }
      if (type === "conversation.item.input_audio_transcription.completed") {
        const item = str(ev.item_id);
        const transcript = str(ev.transcript).trim();
        const usage = obj(ev.usage);
        if (usage.type === "duration" && typeof usage.seconds === "number") {
          sink.transcribed(usage.seconds);
        }
        const heardWords = spokenWords(transcript);
        if (!item || !heardWords) return;
        heardByItem.set(item, heardWords);
        if (opts.peers) {
          const mine = [...(opts.peers.get(leg.index) ?? []), heardWords].slice(-6);
          opts.peers.set(leg.index, mine);
        }
        // The transcript often lands AFTER the interpretation has started.
        for (const [responseId, items] of itemsOfResponse) {
          if (items.includes(item) && saidByResponse.has(responseId)) emit(responseId, liveResponses.has(responseId));
        }
        return;
      }
      if (type === "response.created") {
        const id = str(obj(ev.response).id);
        if (id) {
          itemsOfResponse.set(id, pendingItems.slice());
          startedAt.set(id, now());
          liveResponses.add(id);
        }
        return;
      }
      if (type === "response.output_audio_transcript.delta" || type === "response.audio_transcript.delta") {
        const id = str(ev.response_id);
        const delta = str(ev.delta);
        if (!id || !delta) return;
        const hadWords = !!words(id);
        saidByResponse.set(id, (saidByResponse.get(id) ?? "") + delta);
        if (!words(id)) return;
        // Its utterances are being interpreted now — no later response owns them.
        if (!hadWords && !echoGuard) consume(id);
        decide(id);
        if (!playing(id)) return;
        sink.activity();
        emit(id, true);
        return;
      }
      if (type === "response.output_audio.delta" || type === "response.audio.delta") {
        // Only the socket engines send audio as events (WebRTC carries it on
        // a track). The first frame is the moment the echo guard decides.
        const id = str(ev.response_id);
        if (!id || audioStarted.has(id)) return;
        audioStarted.add(id);
        if (echoGuard && words(id)) {
          decide(id);
          if (playing(id)) {
            sink.activity();
            emit(id, true);
          }
        }
        return;
      }
      if (type === "output_audio_buffer.stopped" || type === "output_audio_buffer.cleared") {
        // Only the response that opened the gate may close it: a wordless
        // response finishing must not mute the real one that follows it.
        const id = str(ev.response_id);
        if (gatedOpenFor !== null && (!id || id === gatedOpenFor)) {
          gatedOpenFor = null;
          sink.gate(false);
        }
        return;
      }
      if (type === "response.done") {
        const response = obj(ev.response);
        const id = str(response.id);
        if (response.usage) {
          sink.usage(response.usage as RealtimeUsage);
          // Grok Voice bills the clock and says so here: "the seconds billed
          // so far" for this session, cumulative (xAI's live-interpreter
          // recipe). No other provider of this dialect sends the field.
          const billed = obj(response.usage).billable_audio_seconds;
          if (typeof billed === "number" && Number.isFinite(billed)) sink.billed(billed);
        }
        liveResponses.delete(id);
        // Words that never got an audio frame (text-only tail, or a response
        // cut off first) are judged now, so the caption is not lost.
        if (echoGuard && words(id) && !verdict.has(id)) {
          audioStarted.add(id);
          decide(id);
        }
        const spoke = !!words(id) && playing(id);
        audioStarted.delete(id);
        // A response that ended without a word — the quiet leg's, or one cut
        // off before it began — must leave the speaker shut for the next.
        if (!spoke) sink.responseSilent();
        // Finished on purpose with nothing to say: those utterances are done
        // with. Cut off before its first word: they wait for the next response.
        if (!spoke && str(response.status) !== "cancelled") consume(id);
        if (spoke) {
          emit(id, false);
          // Cut off by someone speaking — the barge-in the brief asks to count.
          const reason = str(obj(response.status_details).reason);
          if (str(response.status) === "cancelled" && reason === "turn_detected") sink.bargeIn();
        }
        // Keep the maps from growing all dinner.
        if (saidByResponse.size > 40) {
          const drop = saidByResponse.keys().next().value as string;
          saidByResponse.delete(drop);
          for (const item of itemsOfResponse.get(drop) ?? []) heardByItem.delete(item);
          itemsOfResponse.delete(drop);
          startedAt.delete(drop);
          verdict.delete(drop);
        }
        return;
      }
      if (type === "error") {
        sink.error(errorMessage(ev));
      }
    }
  };
}

// ── stream + gemini ────────────────────────────────────────────────────────

/**
 * What every leg of a table has heard, kept ONCE. The streaming engines give
 * no turn boundaries and every leg transcribes the same microphone, so only
 * the first leg's "heard" text is read and all legs caption against it.
 */
export interface SharedHeard {
  text: string;
  lastAtMs: number;
  /** Captions currently being written, across all legs. */
  open: number;
  /** Called when `text` grows, so an open caption can show it. */
  listeners: Set<() => void>;
}

export function createSharedHeard(): SharedHeard {
  return { text: "", lastAtMs: 0, open: 0, listeners: new Set() };
}

/** The interpreter has said nothing for this long → that caption is done. */
export const STREAM_QUIET_MS = 1500;
/** Heard text nobody interpreted (noise, a cough) is dropped after this. */
export const HEARD_STALE_MS = 8000;

type StreamEvent =
  | { kind: "heard"; delta: string }
  | { kind: "said"; delta: string }
  | { kind: "turn-end" }
  | { kind: "interrupted" };

function createStreamCore(
  leg: LegIdentity,
  sink: LegSink,
  shared: SharedHeard,
  ownsHeard: boolean,
  now: () => number
): { push: (ev: StreamEvent) => void; tick: (nowMs: number) => void } {
  let seq = 0;
  let open: { id: string; said: string; at: number; lastOutMs: number } | null = null;
  /**
   * Output the leg has sent that is not words YET. The transcript arrives in
   * fragments and a control marker can be cut anywhere ("<no" + " speech>" +
   * "{pause}"), so fragments wait here until what they add up to, with the
   * markers taken out, has a word in it. Gemini's quiet leg sends nothing
   * else all evening (Tom's table, 2026-11-09) — it must never open a caption,
   * never open the speaker, and never count as "the interpreter spoke".
   */
  let pending = "";
  let pendingAtMs = 0;

  const emit = (live: boolean) => {
    if (!open) return;
    sink.caption({
      id: open.id,
      source: leg.source,
      target: leg.target,
      // A caption that opens mid-sentence inherits the tail of the last
      // one's punctuation ("." then the next clause); drop it.
      heard: stripControlMarkers(shared.text).replace(/^[\s.,;:!?…]+/u, "").trim(),
      said: stripControlMarkers(open.said),
      live,
      at: open.at
    });
  };
  const onHeard = () => emit(true);

  const close = () => {
    pending = "";
    if (!open) {
      // A turn that ended with nothing but markers: drop any audio that was
      // being held for it.
      sink.responseSilent();
      return;
    }
    emit(false);
    open = null;
    sink.gate(false);
    shared.listeners.delete(onHeard);
    shared.open = Math.max(0, shared.open - 1);
    // Those words have their interpretation now.
    if (shared.open === 0) shared.text = "";
  };

  return {
    push: (ev) => {
      if (ev.kind === "heard") {
        if (!ownsHeard || !ev.delta) return;
        const before = stripControlMarkers(shared.text);
        shared.text += ev.delta;
        // `<noise>` from the transcriber is not somebody speaking.
        if (stripControlMarkers(shared.text) === before) return;
        shared.lastAtMs = now();
        sink.activity();
        for (const listener of shared.listeners) listener();
        return;
      }
      if (ev.kind === "said") {
        if (!ev.delta) return;
        if (!open) {
          if (!pending) pendingAtMs = now();
          pending += ev.delta;
          if (!hasWords(stripControlMarkers(pending))) return;
          open = { id: `${leg.index}:s${seq++}`, said: pending, at: now(), lastOutMs: now() };
          pending = "";
          shared.open += 1;
          shared.listeners.add(onHeard);
          sink.gate(true);
          sink.activity();
          emit(true);
          return;
        }
        const before = stripControlMarkers(open.said);
        open.said += ev.delta;
        // A marker tacked onto a finished sentence must not hold it open.
        if (stripControlMarkers(open.said) === before) return;
        open.lastOutMs = now();
        sink.activity();
        emit(true);
        return;
      }
      if (ev.kind === "interrupted") {
        if (open) sink.bargeIn();
        sink.flushAudio();
        close();
        return;
      }
      close();
    },
    tick: (nowMs) => {
      if (open && nowMs - open.lastOutMs >= STREAM_QUIET_MS) close();
      // Markers that never became words do not wait for a turn boundary the
      // streaming engines never send.
      if (!open && pending && nowMs - pendingAtMs >= STREAM_QUIET_MS) close();
      if (
        ownsHeard &&
        shared.open === 0 &&
        shared.text &&
        nowMs - shared.lastAtMs >= HEARD_STALE_MS
      ) {
        shared.text = "";
      }
    }
  };
}

/** gpt-realtime-translate and gpt-live-1: `session.*` events. */
export function createStreamReader(
  leg: LegIdentity,
  sink: LegSink,
  shared: SharedHeard,
  opts: { ownsHeard: boolean; now?: () => number }
): LegReader {
  const now = opts.now ?? Date.now;
  const core = createStreamCore(leg, sink, shared, opts.ownsHeard, now);
  return {
    tick: core.tick,
    handle: (ev) => {
      const type = str(ev.type);
      if (type === "session.input_transcript.delta") {
        core.push({ kind: "heard", delta: str(ev.delta) });
      } else if (type === "session.output_transcript.delta") {
        core.push({ kind: "said", delta: str(ev.delta) });
      } else if (type === "session.usage.updated" || type === "session.closed") {
        const seconds = obj(ev.usage).seconds;
        if (typeof seconds === "number" && Number.isFinite(seconds)) sink.billed(seconds);
        if (type === "session.closed") {
          core.push({ kind: "turn-end" });
          sink.closed();
        }
      } else if (type === "error") {
        sink.error(errorMessage(ev));
      }
    }
  };
}

/** Gemini Live: one parsed server message per call. */
export function createGeminiReader(
  leg: LegIdentity,
  sink: LegSink,
  shared: SharedHeard,
  opts: { ownsHeard: boolean; now?: () => number }
): LegReader {
  const now = opts.now ?? Date.now;
  const core = createStreamCore(leg, sink, shared, opts.ownsHeard, now);
  return {
    tick: core.tick,
    handle: (msg) => {
      if (msg.usageMetadata) sink.geminiUsage(msg.usageMetadata as GeminiUsageMetadata);
      const content = msg.serverContent ? obj(msg.serverContent) : null;
      if (!content) return;
      const heard = str(obj(content.inputTranscription).text);
      if (heard) core.push({ kind: "heard", delta: heard });
      const said = str(obj(content.outputTranscription).text);
      if (said) core.push({ kind: "said", delta: said });
      if (content.interrupted === true) core.push({ kind: "interrupted" });
      else if (content.turnComplete === true) core.push({ kind: "turn-end" });
    }
  };
}
