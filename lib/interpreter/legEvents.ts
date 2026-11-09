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
export function createRealtimeReader(
  leg: LegIdentity,
  sink: LegSink,
  now: () => number = Date.now
): LegReader {
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

  const emit = (responseId: string, live: boolean) => {
    const said = saidByResponse.get(responseId) ?? "";
    if (!said.trim()) return;
    const heard = (itemsOfResponse.get(responseId) ?? [])
      .map((item) => heardByItem.get(item) ?? "")
      .filter(Boolean)
      .join(" ");
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
        if (!item || !/[\p{L}\p{N}]/u.test(transcript)) return;
        heardByItem.set(item, transcript);
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
        const hadWords = !!(saidByResponse.get(id) ?? "").trim();
        const said = (saidByResponse.get(id) ?? "") + delta;
        saidByResponse.set(id, said);
        if (!said.trim()) return;
        // Its utterances are being interpreted now — no later response owns them.
        if (!hadWords) consume(id);
        if (gatedOpenFor !== id) {
          gatedOpenFor = id;
          sink.gate(true);
        }
        sink.activity();
        emit(id, true);
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
        if (response.usage) sink.usage(response.usage as RealtimeUsage);
        liveResponses.delete(id);
        const spoke = !!(saidByResponse.get(id) ?? "").trim();
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

  const emit = (live: boolean) => {
    if (!open) return;
    sink.caption({
      id: open.id,
      source: leg.source,
      target: leg.target,
      // A caption that opens mid-sentence inherits the tail of the last
      // one's punctuation ("." then the next clause); drop it.
      heard: shared.text.replace(/^[\s.,;:!?…]+/u, "").trim(),
      said: open.said,
      live,
      at: open.at
    });
  };
  const onHeard = () => emit(true);

  const close = () => {
    if (!open) return;
    emit(false);
    open = null;
    shared.listeners.delete(onHeard);
    shared.open = Math.max(0, shared.open - 1);
    // Those words have their interpretation now.
    if (shared.open === 0) shared.text = "";
  };

  return {
    push: (ev) => {
      if (ev.kind === "heard") {
        if (!ownsHeard || !ev.delta) return;
        shared.text += ev.delta;
        shared.lastAtMs = now();
        sink.activity();
        for (const listener of shared.listeners) listener();
        return;
      }
      if (ev.kind === "said") {
        if (!ev.delta) return;
        if (!open) {
          if (!ev.delta.trim()) return;
          open = { id: `${leg.index}:s${seq++}`, said: "", at: now(), lastOutMs: now() };
          shared.open += 1;
          shared.listeners.add(onHeard);
        }
        open.said += ev.delta;
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
