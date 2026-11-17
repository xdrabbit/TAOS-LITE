"use client";

import type { LanguageCode } from "@/lib/languages/catalog";
import { jsonAuthHeaders } from "@/lib/authClient";
import { nextResponse, type PendingTurn } from "@/lib/live/respond";
import { audioDrainTimeoutMs, DEFAULT_LIVE_STYLE, type LiveStyle } from "@/lib/live/style";
import { otherOfPair, type LiveLine } from "@/lib/live/auto";
import { createTagStream, parseTag, type TagVerdict } from "@/lib/tabletop/autoDetect";

// WebRTC client for /live "Ambient AI" mode. Streams the mic continuously to a
// GA Realtime session (minted by POST /api/live/realtime) whose only job is to
// speak/write micro-summaries of the surrounding conversation in the target
// language. Connection pattern mirrors lib/tutor/conversation.ts (the proven
// path); differences: no greeting, no steering, output audio is mutable
// ("voice off" = text-only), and the idle window is long enough for a quiet
// stretch of a movie.

export type AmbientState =
  | "idle"
  | "requesting_mic"
  | "minting"
  | "connecting"
  | "connected"
  | "stopping"
  | "error";

// Any catalog language, not the old "en" | "es". The session's instructions
// are minted server-side from these two codes (app/api/live/realtime) — the
// WebRTC plumbing below neither knows nor cares which languages they are, and
// nothing about the response gate, the VAD settings or the freshness rules
// moves with them.
export type AmbientTarget = LanguageCode;
export type AmbientStopReason = "user" | "cap" | "idle" | "error";

export interface AmbientConfig {
  /** What the listener reads and hears — their own language. */
  target: AmbientTarget;
  /** What is being spoken around them, so the prompt can name it. */
  source: AmbientTarget;
  /** Summary (the default) or word-for-word. Changeable while live: setStyle. */
  style?: LiveStyle;
  /**
   * Two-way Auto (lib/live/auto.ts): either of the pair is heard and rendered
   * into the other, word for word, as tagged TEXT. The session is minted that
   * way and stays that way — flipping Auto is a restart, not a patch — and
   * `style` is not consulted while it is on.
   */
  auto?: boolean;
  /**
   * Auto's second echo fence: asked for every heard segment before it is
   * queued. True = that was this phone's own readout coming back; it is not
   * rendered, and onEchoDropped says so.
   */
  isEcho?: (heard: string) => boolean;
  /** Start with output audio muted (text-only). */
  muted?: boolean;
  /** Hard session cap; default 2 h — a long dinner. */
  maxDurationMs?: number;
  /** Auto-off after this long with no detected speech; default 5 min. */
  idleTimeoutMs?: number;
}

export interface AmbientEvents {
  onState?: (s: AmbientState) => void;
  onError?: (msg: string) => void;
  /** Finalized transcription of what the mic picked up (source language). */
  onHeard?: (text: string) => void;
  /** Streaming chunk of the current micro-summary. */
  onSummaryDelta?: (delta: string) => void;
  /** The micro-summary finished; `text` is the full transcript of it. */
  onSummaryDone?: (text: string) => void;
  /**
   * Word-for-word fell too far behind and left `count` heard segments
   * unrendered rather than guess at them (lib/live/respond.ts). The screen
   * says so; a gap nobody was told about is the thing this style promises
   * not to have.
   */
  onSkipped?: (count: number) => void;
  /**
   * One finished line, in every mode: what was heard and what it became. In
   * Auto this is the feed (both languages, labelled by the tag); outside it,
   * it is what "Save this conversation" stores. Fires after onSummaryDone.
   */
  onLine?: (line: LiveLine) => void;
  /** Auto dropped a heard segment that was its own voice (config.isEcho). */
  onEchoDropped?: () => void;
  onTick?: (elapsedSec: number) => void;
  /**
   * The session is about to close itself. `secondsLeft` counts down; null
   * clears a warning that no longer applies (somebody spoke).
   *
   * /live used to explain the idle stop and the 2-hour cap only AFTER they
   * happened — the earpiece simply went quiet mid-dinner and the screen said
   * so afterwards. /call has warned for 30 seconds since it shipped; this is
   * the same courtesy on the surface that actually runs for two hours.
   */
  onEndingSoon?: (reason: "idle" | "cap", secondsLeft: number) => void;
  onWarningCleared?: () => void;
  onStopped?: (reason: AmbientStopReason, elapsedSec: number) => void;
}

export interface ActiveAmbientSession {
  stop: (reason?: AmbientStopReason) => Promise<void>;
  setMuted: (muted: boolean) => void;
  /**
   * Switch style on the open session. No restart: the other style's settings
   * go down the data channel as a `session.update`, and the next response —
   * the next thing anyone says — comes out in the new style. A response
   * already being spoken finishes in the old one.
   */
  setStyle: (style: LiveStyle) => void;
  /**
   * Send the microphone as silence (true) or as the room (false). Auto's
   * half-duplex: held while this phone reads a line aloud, so the session
   * cannot hear, transcribe or translate its own voice. `track.enabled`, so
   * the stream stays continuous and VAD still sees a pause as a pause.
   */
  setMicHeld: (held: boolean) => void;
  /** Is somebody mid-sentence right now, by the server's VAD? */
  speechActive: () => boolean;
}

const DEFAULT_MAX_MS = 2 * 60 * 60 * 1000;
const DEFAULT_IDLE_MS = 5 * 60 * 1000;
/** How long before an idle stop the earpiece says so. Matches /call. */
const IDLE_WARNING_MS = 30 * 1000;
/**
 * How long before the hard cap the screen says so. Two minutes rather than
 * /call's thirty seconds because this cap arrives after two HOURS — long
 * enough that nobody is watching the timer, and a dinner is a bad place to
 * find out you have half a minute to react.
 */
const CAP_WARNING_MS = 2 * 60 * 1000;

interface MintResponse {
  clientSecret: string;
  callUrl: string;
  model: string;
  voice: string;
  /**
   * What each style changes about the session, built by the server
   * (buildLiveStylePatch) so the prompt and the two spend limits are never
   * assembled in the browser.
   */
  styles?: Partial<Record<LiveStyle, Record<string, unknown>>>;
  error?: string;
  details?: string;
}

export async function startAmbientLive(
  config: AmbientConfig,
  events: AmbientEvents
): Promise<ActiveAmbientSession> {
  const maxMs = config.maxDurationMs ?? DEFAULT_MAX_MS;
  const idleMs = config.idleTimeoutMs ?? DEFAULT_IDLE_MS;

  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let localStream: MediaStream | null = null;
  let audioEl: HTMLAudioElement | null = null;
  let tickTimer: number | null = null;
  let idleTimer: number | null = null;
  let stopped = false;
  // Accumulates transcript deltas so onSummaryDone can fall back to them if the
  // done event ever arrives without a transcript payload.
  let summaryBuffer = "";
  // Response gating (the session is minted with create_response: false).
  // Server-auto-created responses overlapped: a new summary's audio started
  // while the previous one was still draining out of the WebRTC buffer. So WE
  // create responses: a turn increments `pendingTurns` only once its input
  // transcription confirms real words (VAD noise-triggers must not spawn
  // hallucinated summaries), and the next response fires when the previous one
  // has finished BOTH generating (response.done) and playing
  // (output_audio_buffer.stopped). Everything pending is coalesced into one
  // fresh summary.
  //
  // In word-for-word style nothing is coalesced: each pending segment gets a
  // response of its own, oldest first. Which of the two happens is decided in
  // one place, lib/live/respond.ts — read its header before changing this.
  let pending: PendingTurn[] = [];
  // Commit order and time per conversation item, kept from
  // `input_audio_buffer.committed` until that item's transcription arrives.
  const committed = new Map<string, { seq: number; at: number }>();
  let commitSeq = 0;
  // The style the listener wants, and the one the open session is running.
  const auto = Boolean(config.auto);
  const pair: readonly [string, string] = [config.target, config.source];
  // Auto is word-for-word, whatever the chip says (lib/live/auto.ts).
  let style: LiveStyle = auto ? "verbatim" : (config.style ?? DEFAULT_LIVE_STYLE);
  let sessionStyle: LiveStyle = style;
  // What each waiting segment's transcript was, until its response is asked for.
  const heardText = new Map<string, string>();
  // The response being answered right now: what it covers and, in Auto, the
  // tag reader for its text.
  let currentHeard = "";
  let tagStream: ReturnType<typeof createTagStream> | null = null;
  let tagVerdict: TagVerdict | null = null;
  let textBuffer = "";
  let lineSeq = 0;
  let speechNow = false;
  let micHeld = false;
  let stylePatches: MintResponse["styles"] = undefined;
  let responseActive = false;
  let audioPlaying = false;
  let audioStuckTimer: number | null = null;
  let idleWarnTimer: number | null = null;
  // Latches so each warning is announced once per approach rather than every
  // second the tick timer fires.
  let idleWarned = false;
  let capWarned = false;
  const startMs = Date.now();

  const setState = (s: AmbientState) => events.onState?.(s);
  const elapsedSec = () => Math.round((Date.now() - startMs) / 1000);

  const clearTimers = () => {
    if (tickTimer !== null) window.clearInterval(tickTimer);
    if (idleTimer !== null) window.clearTimeout(idleTimer);
    if (idleWarnTimer !== null) window.clearTimeout(idleWarnTimer);
    if (audioStuckTimer !== null) window.clearTimeout(audioStuckTimer);
    tickTimer = null;
    idleTimer = null;
    idleWarnTimer = null;
    audioStuckTimer = null;
  };

  const stop = async (reason: AmbientStopReason = "user") => {
    if (stopped) return;
    stopped = true;
    setState("stopping");
    clearTimers();
    try {
      if (dc && dc.readyState !== "closed") dc.close();
    } catch {
      /* ignore */
    }
    try {
      if (pc) {
        pc.getSenders().forEach((sn) => sn.track?.stop());
        pc.close();
      }
    } catch {
      /* ignore */
    }
    localStream?.getTracks().forEach((t) => t.stop());
    if (audioEl) {
      audioEl.pause();
      audioEl.srcObject = null;
      audioEl.remove();
    }
    setState("idle");
    events.onStopped?.(reason, elapsedSec());
  };

  // Any real speech means the room is still alive. Resets the countdown and
  // takes the warning back down if one was showing.
  const bumpIdle = () => {
    if (stopped) return;
    if (idleTimer !== null) window.clearTimeout(idleTimer);
    if (idleWarnTimer !== null) window.clearTimeout(idleWarnTimer);
    if (idleWarned) {
      idleWarned = false;
      events.onWarningCleared?.();
    }
    idleWarnTimer = window.setTimeout(
      () => {
        idleWarned = true;
        events.onEndingSoon?.("idle", Math.round(IDLE_WARNING_MS / 1000));
      },
      Math.max(0, idleMs - IDLE_WARNING_MS)
    );
    idleTimer = window.setTimeout(() => void stop("idle"), idleMs);
  };

  const setMuted = (muted: boolean) => {
    if (audioEl) audioEl.muted = muted;
  };

  const setMicHeld = (held: boolean) => {
    micHeld = held;
    localStream?.getTracks().forEach((t) => {
      t.enabled = !held;
    });
    // A held mic is silence: whatever VAD thought it was hearing is over.
    if (held) speechNow = false;
  };

  // One finished response → one line. `raw` is everything the model wrote or
  // said for it; in Auto that still has the tag on the front.
  const finishLine = (raw: string) => {
    const heard = currentHeard;
    currentHeard = "";
    let text = raw.trim();
    let line: LiveLine | null = null;
    if (auto) {
      // The whole text, parsed again: the stream decided the same thing delta
      // by delta, but this is the one place both are in hand.
      const parsed = parseTag(raw, pair);
      const verdict = tagVerdict ?? parsed.verdict;
      text = parsed.text;
      tagStream = null;
      tagVerdict = null;
      if (text) {
        line =
          verdict.kind === "hit"
            ? {
                seq: (lineSeq += 1),
                heard,
                heardLang: otherOfPair(pair, verdict.code),
                text,
                textLang: verdict.code,
                detect: "hit"
              }
            : { seq: (lineSeq += 1), heard, heardLang: null, text, textLang: null, detect: "miss" };
      }
    } else if (text) {
      line = {
        seq: (lineSeq += 1),
        heard,
        heardLang: config.source,
        text,
        textLang: config.target,
        detect: null
      };
    }
    if (!text) return;
    events.onSummaryDone?.(text);
    if (line) events.onLine?.(line);
  };

  const clearAudioStuckTimer = () => {
    if (audioStuckTimer !== null) window.clearTimeout(audioStuckTimer);
    audioStuckTimer = null;
  };

  // Fire the next micro-summary if there is committed speech waiting and the
  // previous summary is fully finished. Called from every gate-state change.
  const maybeRespond = () => {
    if (stopped || pending.length === 0 || responseActive || audioPlaying) return;
    if (!dc || dc.readyState !== "open") return;
    // Ask in the style the SESSION is in, not the one the toggle shows: the
    // two only differ for the instant before the patch below is sent.
    const before = pending;
    const next = nextResponse(sessionStyle, pending, Date.now());
    pending = next.remaining;
    if (next.skipped > 0) events.onSkipped?.(next.skipped);
    // What this response covers: the one segment it references, or (summary)
    // everything that was waiting.
    const input = (next.event?.response as { input?: Array<{ id?: string }> } | undefined)?.input;
    const refId = input?.[0]?.id;
    const covered = !next.event ? [] : refId ? before.filter((t) => t.itemId === refId) : before;
    const stillWaiting = new Set(pending.map((t) => t.itemId));
    currentHeard = covered
      .map((t) => heardText.get(t.itemId) ?? "")
      .filter(Boolean)
      .join(" ");
    for (const t of before) if (!stillWaiting.has(t.itemId)) heardText.delete(t.itemId);
    if (!next.event) return;
    responseActive = true;
    if (auto) {
      tagStream = createTagStream(pair);
      tagVerdict = null;
      textBuffer = "";
    }
    dc.send(JSON.stringify(next.event));
  };

  // Bring the open session into line with the chosen style. A no-op until the
  // data channel is open (dc.onopen calls it again) and whenever they already
  // agree. Data-channel messages are ordered, so a `response.create` sent
  // after this is answered under the new settings.
  const syncStyle = () => {
    if (auto || stopped || style === sessionStyle) return;
    if (!dc || dc.readyState !== "open") return;
    const patch = stylePatches?.[style];
    if (!patch) return;
    dc.send(JSON.stringify({ type: "session.update", session: patch }));
    sessionStyle = style;
  };

  const setStyle = (next: LiveStyle) => {
    // An Auto session has one style and no patch to switch to.
    if (auto) return;
    style = next;
    syncStyle();
    // Anything already waiting is answered the new way, now.
    maybeRespond();
  };

  try {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      !window.isSecureContext
    ) {
      throw new Error(
        "Microphone is unavailable here. Open the app over HTTPS in Safari/Chrome and allow mic access."
      );
    }

    setState("requesting_mic");
    // noiseSuppression OFF: it's tuned to isolate one near-field voice and
    // eats the far-side dinner/TV audio we actually want. echoCancellation
    // stays ON — it only subtracts what this device plays, so it stops the
    // session from hearing (and re-summarizing) its own voice on speaker
    // without touching external audio. autoGainControl boosts quiet speakers.
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: false
      }
    });

    setState("minting");
    // Read at the moment of asking, not from `config`: the toggle may have
    // moved while the mic prompt was up.
    const mintedStyle = style;
    const mintRes = await fetch("/api/live/realtime", {
      method: "POST",
      headers: await jsonAuthHeaders(),
      body: JSON.stringify({
        target: config.target,
        source: config.source,
        style: mintedStyle,
        // Only ever sent when on, so a request without Auto is byte-for-byte
        // the one /live has always made.
        ...(auto ? { auto: true } : {})
      })
    });
    const mint = (await mintRes.json().catch(() => ({}))) as MintResponse;
    if (!mintRes.ok || !mint.clientSecret) {
      throw new Error(mint.details || mint.error || "Could not start the live session.");
    }
    stylePatches = mint.styles;
    // What the server actually minted. A toggle flipped during the round trip
    // is caught up by syncStyle the moment the channel opens.
    sessionStyle = mintedStyle;

    pc = new RTCPeerConnection();

    audioEl = document.createElement("audio");
    audioEl.autoplay = true;
    audioEl.muted = Boolean(config.muted);
    (audioEl as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
    audioEl.style.display = "none";
    document.body.appendChild(audioEl);
    pc.ontrack = (ev) => {
      if (audioEl) {
        audioEl.srcObject = ev.streams[0] ?? new MediaStream([ev.track]);
        audioEl.play().catch(() => {
          /* user gesture already happened on START; a failure here is benign */
        });
      }
      bumpIdle();
    };

    for (const track of localStream.getTracks()) pc.addTrack(track, localStream);

    pc.onconnectionstatechange = () => {
      if (!pc) return;
      if (pc.connectionState === "connected") {
        setState("connected");
        if (tickTimer === null) {
          tickTimer = window.setInterval(() => {
            events.onTick?.(elapsedSec());
            const remainingMs = maxMs - (Date.now() - startMs);
            if (remainingMs <= 0) {
              void stop("cap");
              return;
            }
            if (!capWarned && remainingMs <= CAP_WARNING_MS) {
              capWarned = true;
              events.onEndingSoon?.("cap", Math.round(remainingMs / 1000));
            }
          }, 1000);
        }
        bumpIdle();
      }
      if (pc.connectionState === "failed") {
        events.onError?.("Live connection failed.");
        void stop("error");
      }
    };

    dc = pc.createDataChannel("oai-events");
    dc.onmessage = ({ data }) => {
      let ev: Record<string, unknown>;
      try {
        ev = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = typeof ev.type === "string" ? ev.type : "";

      if (type === "input_audio_buffer.speech_started") {
        // Not while the mic is held: that is a turn the silence is closing.
        if (!micHeld) speechNow = true;
        bumpIdle();
        return;
      }
      if (type === "input_audio_buffer.speech_stopped") {
        speechNow = false;
        return;
      }
      // VAD finished a turn and committed its audio to the conversation. Do
      // NOT count it as pending yet — wait for its transcription below. VAD
      // false-triggers (coughs, clinks, room noise) commit audio whose
      // transcript comes back empty, and summarizing those made the model
      // hallucinate content into the silence.
      if (type === "input_audio_buffer.committed") {
        if (typeof ev.item_id === "string") {
          committed.set(ev.item_id, { seq: (commitSeq += 1), at: Date.now() });
        }
        bumpIdle();
        return;
      }
      if (type === "response.done") {
        responseActive = false;
        // Auto: a response that ended without a text.done (cancelled, or the
        // tag was all it wrote) still closes its line here.
        if (auto && tagStream) {
          const rest = tagStream.end();
          if (rest.verdict) tagVerdict = rest.verdict;
          const raw = textBuffer;
          textBuffer = "";
          finishLine(raw);
        }
        // Over WebRTC the audio can still be draining; output_audio_buffer
        // events release that side of the gate. Belt-and-braces: if the
        // "stopped" event never arrives, unstick after 12s (summaries are
        // capped well below that; a word-for-word rendering gets longer —
        // audioDrainTimeoutMs).
        if (audioPlaying) {
          clearAudioStuckTimer();
          audioStuckTimer = window.setTimeout(() => {
            audioPlaying = false;
            maybeRespond();
          }, audioDrainTimeoutMs(sessionStyle));
        }
        maybeRespond();
        return;
      }
      if (type === "output_audio_buffer.started") {
        audioPlaying = true;
        bumpIdle();
        return;
      }
      if (type === "output_audio_buffer.stopped" || type === "output_audio_buffer.cleared") {
        audioPlaying = false;
        clearAudioStuckTimer();
        maybeRespond();
        bumpIdle();
        return;
      }
      if (type === "conversation.item.input_audio_transcription.completed") {
        const t = typeof ev.transcript === "string" ? ev.transcript.trim() : "";
        // Only turns with real words become pending summaries. Requiring some
        // letters/digits filters the "…"/"[inaudible]"-style junk transcripts
        // that noise-triggered turns produce.
        const itemId = typeof ev.item_id === "string" ? ev.item_id : "";
        const commit = committed.get(itemId);
        committed.delete(itemId);
        if (t && /[\p{L}\p{N}]{2,}/u.test(t)) {
          // Auto, voice on: this phone's own readout, heard back. Not shown as
          // heard, not rendered, counted.
          if (auto && config.isEcho?.(t)) {
            events.onEchoDropped?.();
            bumpIdle();
            return;
          }
          events.onHeard?.(t);
          heardText.set(itemId, t);
          pending.push({
            itemId,
            seq: commit?.seq ?? (commitSeq += 1),
            at: commit?.at ?? Date.now()
          });
          maybeRespond();
        }
        bumpIdle();
        return;
      }
      if (
        type === "response.output_audio_transcript.delta" ||
        type === "response.audio_transcript.delta"
      ) {
        const d = typeof ev.delta === "string" ? ev.delta : "";
        if (d) {
          summaryBuffer += d;
          events.onSummaryDelta?.(d);
        }
        bumpIdle();
        return;
      }
      if (
        type === "response.output_audio_transcript.done" ||
        type === "response.audio_transcript.done"
      ) {
        const t =
          (typeof ev.transcript === "string" && ev.transcript.trim()) || summaryBuffer.trim();
        summaryBuffer = "";
        finishLine(t);
        bumpIdle();
        return;
      }
      // Auto writes instead of speaking (lib/live/auto.ts), so its words
      // arrive as text events — the table's (lib/tabletop/openaiBrain.ts) —
      // with the `[xx]` tag on the front. The tag never reaches the screen.
      if (type === "response.output_text.delta" || type === "response.text.delta") {
        const d = typeof ev.delta === "string" ? ev.delta : "";
        if (d && tagStream) {
          textBuffer += d;
          const out = tagStream.push(d);
          if (out.verdict) tagVerdict = out.verdict;
          if (out.text) events.onSummaryDelta?.(out.text);
        }
        bumpIdle();
        return;
      }
      if (type === "response.output_text.done" || type === "response.text.done") {
        if (tagStream) {
          const rest = tagStream.end();
          if (rest.verdict) tagVerdict = rest.verdict;
          const raw = (typeof ev.text === "string" && ev.text) || textBuffer;
          textBuffer = "";
          finishLine(raw);
        }
        bumpIdle();
        return;
      }
      if (type === "error") {
        const err = ev.error as Record<string, unknown> | undefined;
        const msg = (err && typeof err.message === "string" && err.message) || "Realtime error.";
        events.onError?.(msg);
      }
    };
    dc.onerror = () => events.onError?.("Live data channel error.");
    // The toggle can move between the mint and the channel opening.
    dc.onopen = () => syncStyle();

    setState("connecting");
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const sdpRes = await fetch(mint.callUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${mint.clientSecret}`, "Content-Type": "application/sdp" },
      body: offer.sdp ?? ""
    });
    if (!sdpRes.ok) {
      const details = await sdpRes.text().catch(() => "");
      throw new Error(`Live SDP exchange failed (${sdpRes.status}). ${details}`);
    }
    await pc.setRemoteDescription({ type: "answer", sdp: await sdpRes.text() });

    return { stop, setMuted, setStyle, setMicHeld, speechActive: () => speechNow };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start live mode.";
    setState("error");
    events.onError?.(message);
    await stop("error");
    throw error;
  }
}
