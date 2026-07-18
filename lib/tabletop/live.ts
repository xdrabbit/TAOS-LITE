"use client";

import { buildTurnInstructions, type TabletopDirection } from "./instructions";

// WebRTC client for /tabletop "live" mode. One persistent GA Realtime session
// (minted by POST /api/tabletop/realtime) translates push-to-talk turns as
// text WHILE the person speaks. Between turns the mic track is detached from
// the sender entirely (replaceTrack(null)) so idle table time streams — and
// bills — nothing. Each turn: session.update flips the direction, the mic
// reattaches, VAD chunks the speech into phrases, and each phrase's
// translation streams to the listener's pane. Turn end: a short grace keeps
// silence flowing so VAD closes the last phrase, then the mic detaches and
// the caller gets the assembled turn once in-flight responses drain.

export type TabletopLiveState =
  | "idle"
  | "requesting_mic"
  | "minting"
  | "connecting"
  | "ready"
  | "error";

export interface TabletopLiveEvents {
  onState?: (s: TabletopLiveState) => void;
  onError?: (msg: string) => void;
  /** Running transcript of what the mic heard this turn (speaker's language). */
  onHeard?: (text: string) => void;
  /** Streaming chunk of translated text for the current turn. */
  onTranslationDelta?: (delta: string) => void;
}

export interface TurnResult {
  heard: string;
  translation: string;
}

export interface ActiveTabletopLive {
  /** Point the interpreter at a direction and open the mic. False = not ready. */
  beginTurn: (direction: TabletopDirection) => boolean;
  /** Close the mic, wait for in-flight phrases, resolve the whole turn. */
  endTurn: () => Promise<TurnResult>;
  stop: () => void;
}

interface MintResponse {
  clientSecret: string;
  callUrl: string;
  error?: string;
  details?: string;
}

// After the button ends a turn, keep streaming (silent) audio briefly so
// server VAD sees the pause and closes the final phrase.
const ENDTURN_VAD_GRACE_MS = 900;
// Hard ceiling on waiting for the last translations after a turn ends.
const ENDTURN_DRAIN_TIMEOUT_MS = 8000;
// Auto-disconnect after this long with no turn — caps cost if the phone is
// left on the table. The next tap reconnects transparently.
const IDLE_DISCONNECT_MS = 5 * 60 * 1000;

export async function startTabletopLive(
  events: TabletopLiveEvents
): Promise<ActiveTabletopLive> {
  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let micStream: MediaStream | null = null;
  let stopped = false;
  let idleTimer: number | null = null;

  // Per-turn accumulators.
  let heardParts: string[] = [];
  let translationParts: string[] = [];
  let currentDelta = "";
  let streamedAnyThisTurn = false;
  let activeResponses = 0;
  let turnOpen = false;
  let drainResolve: (() => void) | null = null;

  const setState = (s: TabletopLiveState) => events.onState?.(s);

  const clearIdle = () => {
    if (idleTimer !== null) window.clearTimeout(idleTimer);
    idleTimer = null;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearIdle();
    try {
      if (dc && dc.readyState !== "closed") dc.close();
    } catch {
      /* ignore */
    }
    try {
      pc?.close();
    } catch {
      /* ignore */
    }
    micStream?.getTracks().forEach((t) => t.stop());
    micStream = null;
    setState("idle");
  };

  const bumpIdle = () => {
    clearIdle();
    idleTimer = window.setTimeout(() => {
      // Only auto-disconnect between turns, never mid-turn.
      if (!turnOpen) stop();
    }, IDLE_DISCONNECT_MS);
  };

  const maybeResolveDrain = () => {
    if (drainResolve && activeResponses === 0) {
      const r = drainResolve;
      drainResolve = null;
      r();
    }
  };

  try {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      !window.isSecureContext
    ) {
      throw new Error(
        "Microphone is unavailable here. Open the app over HTTPS and allow mic access."
      );
    }

    setState("requesting_mic");
    // noiseSuppression ON here (unlike /live ambient): the speaker is close to
    // the phone on the table, and the enemy is the party around them.
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true
      }
    });

    setState("minting");
    const mintRes = await fetch("/api/tabletop/realtime", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ direction: "en-es" })
    });
    const mint = (await mintRes.json().catch(() => ({}))) as MintResponse;
    if (!mintRes.ok || !mint.clientSecret) {
      throw new Error(mint.details || mint.error || "Could not start live mode.");
    }

    pc = new RTCPeerConnection();
    // Attach the mic BEFORE the offer, exactly like the proven /live path —
    // a trackless sendonly transceiver negotiated dead on the first field
    // test (audio never flowed even though the session connected). The track
    // starts muted; beginTurn/endTurn toggle track.enabled. Between turns
    // this streams (cheap) silence, bounded by the 5-min idle disconnect.
    const upfrontTrack = micStream.getAudioTracks()[0] ?? null;
    if (!upfrontTrack) throw new Error("No microphone track.");
    upfrontTrack.enabled = false;
    pc.addTrack(upfrontTrack, micStream);

    pc.onconnectionstatechange = () => {
      if (!pc || stopped) return;
      if (pc.connectionState === "connected") {
        setState("ready");
        bumpIdle();
      }
      if (pc.connectionState === "failed") {
        events.onError?.("Live connection failed.");
        stop();
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

      if (type === "conversation.item.input_audio_transcription.completed") {
        const t = typeof ev.transcript === "string" ? ev.transcript.trim() : "";
        if (t && /[\p{L}\p{N}]{2,}/u.test(t) && turnOpen) {
          heardParts.push(t);
          events.onHeard?.(heardParts.join(" "));
        }
        return;
      }
      if (type === "response.created") {
        activeResponses += 1;
        // Phrase responses arrive back-to-back with no separator; keep the
        // streamed pane readable ("love. I'm", not "love.I'm").
        if (streamedAnyThisTurn) events.onTranslationDelta?.(" ");
        return;
      }
      if (type === "response.output_text.delta" || type === "response.text.delta") {
        const d = typeof ev.delta === "string" ? ev.delta : "";
        if (d) {
          currentDelta += d;
          streamedAnyThisTurn = true;
          events.onTranslationDelta?.(d);
        }
        return;
      }
      if (type === "response.done") {
        activeResponses = Math.max(0, activeResponses - 1);
        if (currentDelta.trim()) translationParts.push(currentDelta.trim());
        currentDelta = "";
        maybeResolveDrain();
        return;
      }
      if (type === "error") {
        const err = ev.error as Record<string, unknown> | undefined;
        const msg = (err && typeof err.message === "string" && err.message) || "Realtime error.";
        events.onError?.(msg);
      }
    };
    dc.onerror = () => events.onError?.("Live data channel error.");

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

    // Do NOT resolve until the data channel is actually open: beginTurn's
    // first session.update must not race the handshake. (First field test:
    // the first turn silently no-oped because dc was still "connecting".)
    await new Promise<void>((resolve, reject) => {
      const channel = dc;
      if (!channel) {
        reject(new Error("No data channel."));
        return;
      }
      if (channel.readyState === "open") {
        resolve();
        return;
      }
      const timeout = window.setTimeout(
        () => reject(new Error("Live connection timed out — try again or use classic mode.")),
        15000
      );
      channel.addEventListener(
        "open",
        () => {
          window.clearTimeout(timeout);
          resolve();
        },
        { once: true }
      );
      pc?.addEventListener("connectionstatechange", () => {
        if (pc && (pc.connectionState === "failed" || pc.connectionState === "closed")) {
          window.clearTimeout(timeout);
          reject(new Error("Live connection failed — try again or use classic mode."));
        }
      });
    });

    const micTrack = micStream.getAudioTracks()[0] ?? null;

    const beginTurn = (direction: TabletopDirection): boolean => {
      if (stopped || !dc || dc.readyState !== "open" || !micTrack) {
        // Never fail silently: the UI shows "recording" the moment this is
        // called, so a no-op here looks like a dead feature.
        events.onError?.("Not connected yet — tap again in a second.");
        return false;
      }
      clearIdle();
      turnOpen = true;
      heardParts = [];
      translationParts = [];
      currentDelta = "";
      streamedAnyThisTurn = false;
      dc.send(
        JSON.stringify({
          type: "session.update",
          session: { type: "realtime", instructions: buildTurnInstructions(direction) }
        })
      );
      micTrack.enabled = true;
      return true;
    };

    const endTurn = async (): Promise<TurnResult> => {
      turnOpen = false;
      // Mute — silence frames keep flowing so VAD closes the last phrase, and
      // the track stays attached (detaching is what broke audio flow).
      if (micTrack) micTrack.enabled = false;
      await new Promise((r) => setTimeout(r, ENDTURN_VAD_GRACE_MS));
      // Wait for in-flight phrase translations to finish.
      if (activeResponses > 0) {
        await Promise.race([
          new Promise<void>((r) => {
            drainResolve = r;
          }),
          new Promise<void>((r) => setTimeout(r, ENDTURN_DRAIN_TIMEOUT_MS))
        ]);
        drainResolve = null;
      }
      bumpIdle();
      const result: TurnResult = {
        heard: heardParts.join(" "),
        translation: (currentDelta.trim()
          ? [...translationParts, currentDelta.trim()]
          : translationParts
        ).join(" ")
      };
      currentDelta = "";
      return result;
    };

    return { beginTurn, endTurn, stop };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start live mode.";
    setState("error");
    events.onError?.(message);
    stop();
    throw error;
  }
}
