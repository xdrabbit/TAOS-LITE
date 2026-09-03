"use client";

import { supabase } from "@/lib/supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";
import {
  fetchIceServers,
  readMediaFlow,
  readTransport,
  type CallMediaFlow,
  type CallTransport
} from "./ice";
import { closeCallAudioContext, ensureCallAudioContext } from "./audioBridge";

// 1:1 WebRTC call between Tom and Liz, signaled over a Supabase Realtime
// broadcast channel (no extra infra: the app's existing Supabase project
// relays only tiny SDP/ICE JSON blobs — media flows peer-to-peer). Uses the
// MDN "perfect negotiation" pattern so glare (both sides offering at once)
// and mid-call renegotiation (camera on/off) just work.
//
// ── Connectivity, after the 2026-08-31 field report ────────────────────────
// Tom and Liz, both founders, both seeing the screen, the call initiating —
// and no connection between two real phones. Three things were wrong, and the
// first was the one that mattered:
//
//   1. There was no relay. This file asked for one public STUN server, and
//      STUN cannot carry a packet — it only tells a phone its own public
//      address. Two phones behind carrier-grade NAT (both on cellular) have
//      no direct path to discover, so ICE exhausts its candidate pairs and
//      the call sits in "connecting" forever. ICE servers now come from
//      /api/call/ice, which mints short-lived Cloudflare TURN credentials.
//
//   2. A failed connection retried forever, silently. `restartIce()` does not
//      throw when the restart is doomed — it succeeds, ICE fails again, and
//      the handler restarted it again. The catch block holding the only error
//      message was unreachable, so the screen said "reconnecting…" until
//      somebody gave up. There is now one restart and then an honest failure.
//
//   3. Trickled candidates arriving before the remote description were
//      DROPPED. `addIceCandidate` throws if there is no remote description
//      yet and the throw was swallowed as "stale candidate". The answerer's
//      candidates race its answer over the broadcast channel, so this quietly
//      threw away real candidates — including, once there is one, the relay
//      candidate that would have connected the call. They are queued now.
//
// The diagnostics below (states, candidate types, the selected pair) are not
// temporary. They are how the next connection failure gets read instead of
// guessed at, and they are what the on-screen "connected · relay" indicator
// is telling the truth from.

export type CallState =
  | "idle"
  | "media" // acquiring mic/camera
  | "waiting" // in the room, alone — waiting for the partner
  | "connecting"
  | "connected"
  | "reconnecting"
  | "ended"
  | "error";

export interface CallConfig {
  room: string;
  /** Start with the camera on (video call) or off (audio-only). */
  video: boolean;
  /**
   * The language THIS phone's owner speaks and reads — the `mine` half of the
   * shared pair (lib/translate/useLanguagePair.ts).
   *
   * A call is the only screen where the two ends each hold their own pair and
   * neither can see the other's, which is what ENHANCEMENTS.md meant by "the
   * handshake is the actual work, not the picker". So it travels: each phone
   * announces its own language on the signaling channel, and the partner uses
   * it as the SOURCE its interpreter listens for. Without it, /call would
   * still be guessing — which is precisely how it spent the catalog era
   * interpreting Italian into Spanish.
   */
  language: string;
}

export interface CallEvents {
  onState?: (s: CallState) => void;
  onError?: (msg: string) => void;
  onLocalStream?: (stream: MediaStream) => void;
  /** Remote A/V arrived or changed; null when the partner disconnects. */
  onRemoteStream?: (stream: MediaStream | null) => void;
  /**
   * The partner's audio track is live — feed this to the interpreter. Fires
   * again with a fresh track if the peer connection is rebuilt (reconnect).
   */
  onRemoteAudioTrack?: (track: MediaStreamTrack) => void;
  /** The partner hung up or dropped. The room stays open for a rejoin. */
  onPeerLeft?: () => void;
  /**
   * The PARTNER's interpreter started/stopped speaking a translation on their
   * phone. While true, anything said here talks over that translation — the
   * UI shows a "hold on" indicator.
   */
  onPeerInterpreterSpeaking?: (speaking: boolean) => void;
  /**
   * The partner told us what language they speak. Fires on pair-up and again
   * any time they change it mid-call, so this phone's interpreter can be
   * re-pointed without dropping the session.
   */
  onPeerLanguage?: (code: string) => void;
  /**
   * How the media is actually flowing, once it is: peer-to-peer or through
   * the relay. Fires on connect and again after a reconnect, because a call
   * that starts direct and hands over to a new cell tower can end up relayed.
   */
  onTransport?: (transport: CallTransport) => void;
  /**
   * Whether this call has a relay to fall back on at all. Fires once, before
   * the connection is attempted. False means /api/call/ice had no Cloudflare
   * credentials to mint from — the call will still work anywhere STUN works,
   * and the screen says so rather than implying a safety net it lacks.
   */
  onRelayAvailable?: (available: boolean) => void;
  /**
   * One line of connection trail — gathering states, candidate types, the
   * selected pair. Also written to the console. Founders' debugging tool and
   * the beginning of a support surface; not swept up after this fix.
   */
  onDiagnostic?: (line: string) => void;
}

export interface ActiveCall {
  hangUp: () => Promise<void>;
  setMicMuted: (muted: boolean) => void;
  /** Turn the camera on/off mid-call (renegotiates automatically). */
  setVideo: (on: boolean) => Promise<void>;
  /** Adjust how loud the partner's ORIGINAL voice plays (0..1). */
  setRemoteVolume: (volume: number) => void;
  /** Tell the partner whether THIS phone's interpreter is speaking right now. */
  sendInterpreterSpeaking: (speaking: boolean) => void;
  /** Announce a language change on this phone, so their interpreter follows. */
  sendLanguage: (code: string) => void;
  /**
   * A sample of what is actually moving, per direction, off the live
   * connection. Null before the peer connection exists or after it is gone.
   *
   * The screen polls this so that one-way audio — the second half of the
   * 2026-08-31 field report, and a state /call previously had no word for —
   * shows up as two numbers rather than as a person saying "I can't hear
   * you" into a call that says `connected`.
   */
  readMediaFlow: () => Promise<CallMediaFlow | null>;
}

interface SignalMessage {
  from: string;
  kind: "description" | "candidate" | "bye" | "interpreter" | "language";
  data?: unknown;
}

// Unambiguous room-code alphabet (no 0/O, 1/I/L).
const CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

export function generateRoomCode(len = 5): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  let code = "";
  for (const b of bytes) code += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return code;
}

export function normalizeRoomCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^0-9A-Z-]/g, "");
}

// crypto.randomUUID is secure-context-only; getRandomValues is not. The
// fallback keeps startCall from crashing BEFORE its own "use HTTPS" error can
// be raised (e.g. on a plain-HTTP LAN address during dev).
function randomPeerId(): string {
  const c = crypto as Crypto & { randomUUID?: () => string };
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const bytes = new Uint8Array(16);
  c.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * How long a connection attempt may sit unconnected before it is called a
 * failure, in milliseconds.
 *
 * ICE on two healthy phones settles in about two seconds; a relay allocation
 * adds a round trip to Cloudflare. Fifteen seconds is long enough that a slow
 * cellular handshake is not cut off, and short enough that nobody stares at
 * "connecting…" wondering whether to hang up — which is precisely what Tom
 * and Liz were left doing, because before this there was no timeout at all.
 */
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * How many ICE restarts to spend before admitting defeat.
 *
 * One. A flaky cellular handoff recovers on the first restart; a NAT with no
 * path through it fails identically every time, and the old code retried that
 * case forever because `restartIce()` reports success for a restart that is
 * about to fail.
 */
const MAX_ICE_RESTARTS = 1;

/**
 * What a founder sees when the call genuinely cannot be made.
 *
 * Bilingual because the two people on this call read different languages and
 * neither should have to be handed the other's — Liz reads the Spanish, Tom
 * reads the English, on the same screen at the same time. Concrete, because
 * "connection failed" tells nobody what to do next: the useful instruction is
 * that switching a phone to wifi usually fixes it.
 */
const CONNECT_FAILED_MESSAGE =
  "Could not connect the call. One of you is on a network that blocks a direct link — try wifi on both phones. · " +
  "No se pudo conectar la llamada. Uno de los dos está en una red que bloquea la conexión directa — prueben wifi en ambos teléfonos.";

export async function startCall(config: CallConfig, events: CallEvents): Promise<ActiveCall> {
  const peerId = randomPeerId();
  let channel: RealtimeChannel | null = null;
  let pc: RTCPeerConnection | null = null;
  let localStream: MediaStream | null = null;
  let remoteAudioEl: HTMLAudioElement | null = null;
  let otherPeerId: string | null = null;
  let micMuted = false;
  let remoteVolume = 1;
  // The ducking control's real output stage. See attachRemoteGain() below:
  // HTMLMediaElement.volume is READ-ONLY on iOS, so on an iPhone the element
  // alone can only ever be all-or-nothing, and "quiet" did nothing at all.
  let remoteGain: GainNode | null = null;
  // Only true once the graph has been SEEN carrying audio. Until then the
  // element is still the thing making sound and the graph is held at zero, so
  // a browser that refuses to route a remote WebRTC stream into WebAudio
  // degrades to today's behaviour instead of to silence.
  let remoteGainVerified = false;
  let ended = false;
  let myLanguage = config.language;
  // Broadcast has no retention: a language announced before the partner
  // subscribed is simply gone. So whoever hears one first echoes theirs back,
  // once per pairing — enough for both ends to converge, few enough that two
  // phones cannot volley announcements at each other forever.
  let languageEchoedTo: string | null = null;

  // Perfect-negotiation state. `polite` is decided per-pairing by comparing
  // random peer ids — both sides deterministically pick opposite roles.
  let polite = false;
  let makingOffer = false;
  let ignoreOffer = false;
  let settingRemoteAnswer = false;

  // The ICE servers this call was minted with, and whether a relay is among
  // them. Fetched once at join: the credential outlives the call, and asking
  // again per peer rebuild would spend a round trip on every reconnect.
  let iceServers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
  let relayAvailable = false;

  // Candidates that arrived before there was a remote description to hang
  // them on. See handleCandidate() — dropping these is how a relay candidate
  // goes missing and a connectable call fails to connect.
  let pendingCandidates: RTCIceCandidateInit[] = [];

  // Failure bookkeeping. `connectTimer` is the 15-second watchdog; without it
  // a doomed connection has no terminal state at all and the UI waits forever.
  let iceRestarts = 0;
  let connectTimer: number | null = null;

  const setState = (s: CallState) => {
    if (!ended || s === "ended") events.onState?.(s);
  };

  /** One line of connection trail, to the console and to the screen. */
  const diagnose = (line: string) => {
    if (ended) return;
    // Greppable, and the same prefix the server route logs under, so a
    // browser console and a Vercel log read as one story.
    console.info(`[taos-call-ice] ${line}`);
    events.onDiagnostic?.(line);
  };

  const clearConnectTimer = () => {
    if (connectTimer !== null) {
      window.clearTimeout(connectTimer);
      connectTimer = null;
    }
  };

  /**
   * Give up, out loud.
   *
   * The whole point of the 8/31 fix: there is now a path that ends in a
   * message. Before, every failure route either retried forever or was
   * unreachable, so the call had exactly two outcomes — connected, or a
   * spinner nobody could interpret.
   */
  const failConnection = (why: string) => {
    if (ended) return;
    clearConnectTimer();
    diagnose(
      `connect_failed why=${why} restarts=${iceRestarts} relay_available=${relayAvailable}`
    );
    events.onError?.(CONNECT_FAILED_MESSAGE);
    setState("error");
  };

  /** Start (or restart) the watchdog on an attempt that is not yet connected. */
  const armConnectTimer = () => {
    clearConnectTimer();
    connectTimer = window.setTimeout(() => {
      connectTimer = null;
      if (ended || !pc) return;
      if (pc.connectionState === "connected") return;
      failConnection(`timeout_${pc.connectionState}_ice_${pc.iceConnectionState}`);
    }, CONNECT_TIMEOUT_MS);
  };

  const sendSignal = (msg: Omit<SignalMessage, "from">) => {
    void channel?.send({
      type: "broadcast",
      event: "signal",
      payload: { ...msg, from: peerId } satisfies SignalMessage
    });
  };

  const announceLanguage = () => {
    if (!ended && otherPeerId) sendSignal({ kind: "language", data: { lang: myLanguage } });
  };

  const teardownPeer = () => {
    clearConnectTimer();
    pendingCandidates = [];
    if (pc) {
      try {
        pc.onnegotiationneeded = null;
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.onconnectionstatechange = null;
        pc.oniceconnectionstatechange = null;
        pc.onicegatheringstatechange = null;
        pc.onicecandidateerror = null;
        pc.close();
      } catch {
        /* ignore */
      }
      pc = null;
    }
    if (remoteAudioEl) {
      remoteAudioEl.pause();
      remoteAudioEl.srcObject = null;
      remoteAudioEl.remove();
      remoteAudioEl = null;
    }
    if (remoteGain) {
      // The NODES go; the context does not. It belongs to the call, not to
      // this peer connection — a reconnect rebuilds the graph, and on iOS a
      // context rebuilt outside the Join tap would never start again.
      try {
        remoteGain.disconnect();
      } catch {
        /* ignore */
      }
      remoteGain = null;
      remoteGainVerified = false;
    }
    events.onRemoteStream?.(null);
  };

  const hangUp = async () => {
    if (ended) return;
    ended = true;
    sendSignal({ kind: "bye" });
    teardownPeer();
    // The last thing on the call to hold the context. The interpreter's own
    // bridge is released before this by CallShell.endCall().
    closeCallAudioContext();
    localStream?.getTracks().forEach((t) => t.stop());
    localStream = null;
    if (channel) {
      try {
        // removeChannel, not unsubscribe: unsubscribe closes the socket
        // subscription but leaves the channel on the client, and the next
        // join of the same room then finds it and throws. /chat has always
        // torn down this way (lib/chat.ts).
        await supabase.removeChannel(channel);
      } catch {
        /* ignore */
      }
      channel = null;
    }
    setState("ended");
  };

  const applyMicMute = () => {
    localStream?.getAudioTracks().forEach((t) => {
      t.enabled = !micMuted;
    });
  };

  // Build (or rebuild) the peer connection once a partner is present.
  /**
   * Push `remoteVolume` to whichever stage is actually making sound.
   *
   * Two stages, because one of them does not work on half the phones this
   * app runs on. `HTMLMediaElement.volume` is read-only on iOS — WebKit
   * gives volume to the hardware buttons and silently ignores the
   * assignment — so on an iPhone the three-step ducking control ("full",
   * "quiet", "off") did nothing whatsoever, which is exactly the field
   * report. `muted` IS honoured there, and a WebAudio gain node is honoured
   * there, so between them the control becomes real on every device.
   */
  const applyRemoteVolume = () => {
    if (remoteGain) remoteGain.gain.value = remoteGainVerified ? remoteVolume : 0;
    if (!remoteAudioEl) return;
    if (remoteGainVerified) {
      // The graph is provably carrying the partner's voice; the element is
      // now just the sink WebKit requires it to be, and must stay silent or
      // they are heard twice.
      remoteAudioEl.muted = true;
      return;
    }
    // No graph, or not proven yet: the element is still the speaker.
    // `.volume` is honoured on Android and desktop; `.muted` is honoured
    // everywhere, so "off" is real even where "quiet" cannot be.
    remoteAudioEl.muted = remoteVolume === 0;
    remoteAudioEl.volume = remoteVolume;
  };

  /**
   * Route the partner's audio through a gain node, and do not trust it until
   * it has been observed working.
   *
   * The analyser sits BEFORE the gain so the check still sees signal while
   * the gain is held at zero — otherwise the two stages would both be
   * audible during the trial and the partner would echo.
   */
  const attachRemoteGain = (stream: MediaStream) => {
    if (remoteGain) return;
    try {
      // Shared with the interpreter's input bridge (lib/call/audioBridge.ts),
      // and created inside the Join tap so WebKit will actually start it.
      const ctx = ensureCallAudioContext();
      if (!ctx) return;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(analyser);
      analyser.connect(gain);
      gain.connect(ctx.destination);
      remoteGain = gain;

      // Watch for the first real sample. Silence proves nothing either way —
      // nobody may have spoken yet — so this only ever flips to "working",
      // and gives up quietly after twenty seconds of nothing.
      const buf = new Uint8Array(analyser.fftSize);
      let tries = 0;
      const probe = () => {
        if (ended || remoteGainVerified || !remoteGain) return;
        analyser.getByteTimeDomainData(buf);
        // 128 is the zero line of a byte time-domain buffer.
        if (buf.some((v) => v > 132 || v < 124)) {
          remoteGainVerified = true;
          applyRemoteVolume();
          return;
        }
        if (++tries > 100) return;
        window.setTimeout(probe, 200);
      };
      window.setTimeout(probe, 200);
    } catch {
      // No WebAudio here. The element keeps the job it already had.
      remoteGain = null;
    }
  };

  const buildPeer = () => {
    teardownPeer();
    if (ended || !localStream) return;

    iceRestarts = 0;
    pc = new RTCPeerConnection({ iceServers });
    const self = pc;

    for (const track of localStream.getTracks()) {
      pc.addTrack(track, localStream);
    }

    // Remote ORIGINAL audio plays through a dedicated element so its volume
    // can be ducked under the interpreter's translation. Video (if any) is
    // attached by the UI via onRemoteStream; its element stays muted.
    remoteAudioEl = document.createElement("audio");
    remoteAudioEl.autoplay = true;
    remoteAudioEl.volume = remoteVolume;
    (remoteAudioEl as HTMLAudioElement & { playsInline?: boolean }).playsInline = true;
    remoteAudioEl.style.display = "none";
    document.body.appendChild(remoteAudioEl);

    pc.ontrack = (ev) => {
      const stream = ev.streams[0] ?? new MediaStream([ev.track]);
      events.onRemoteStream?.(stream);
      if (ev.track.kind === "audio") {
        if (remoteAudioEl) {
          const audioOnly = new MediaStream([ev.track]);
          remoteAudioEl.srcObject = audioOnly;
          remoteAudioEl.play().catch(() => {
            /* user gesture already happened on join */
          });
          attachRemoteGain(audioOnly);
          applyRemoteVolume();
        }
        events.onRemoteAudioTrack?.(ev.track);
      }
    };

    pc.onnegotiationneeded = async () => {
      if (!pc) return;
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        sendSignal({ kind: "description", data: pc.localDescription });
      } catch {
        /* a failed offer is retried on the next negotiationneeded */
      } finally {
        makingOffer = false;
      }
    };

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        // `type` is host / srflx (found via STUN) / relay (allocated on the
        // TURN server). A gathering run with no `relay` line in it while
        // relay_available=true is the signature of a credential Cloudflare
        // refused — which is otherwise completely invisible.
        diagnose(`local_candidate type=${ev.candidate.type ?? "?"}`);
        sendSignal({ kind: "candidate", data: ev.candidate.toJSON() });
      } else {
        diagnose("local_candidate end-of-candidates");
      }
    };

    // A TURN server that rejects the credential reports it HERE and nowhere
    // else; ICE just quietly proceeds without a relay candidate. A 401 in
    // this line is the difference between "the relay is broken" and "this
    // network has no path", which are the two failures that look identical
    // from the outside.
    pc.onicecandidateerror = (ev) => {
      const e = ev as RTCPeerConnectionIceErrorEvent;
      diagnose(`candidate_error code=${e.errorCode} url=${e.url ?? "?"} text=${e.errorText ?? ""}`);
    };

    pc.onicegatheringstatechange = () => {
      if (self.iceGatheringState) diagnose(`gathering=${self.iceGatheringState}`);
    };

    pc.oniceconnectionstatechange = () => {
      diagnose(`ice=${self.iceConnectionState}`);
    };

    pc.onconnectionstatechange = () => {
      if (!pc || ended || pc !== self) return;
      diagnose(`connection=${pc.connectionState}`);

      if (pc.connectionState === "connected") {
        clearConnectTimer();
        setState("connected");
        // Which path won, read off the live connection rather than assumed.
        // This is what puts "direct" or "relay" on the screen, and it is the
        // one number Tom's three-row network matrix is actually collecting.
        void readTransport(pc).then((transport) => {
          if (ended) return;
          diagnose(`transport=${transport}`);
          events.onTransport?.(transport);
        });
        return;
      }

      if (pc.connectionState === "disconnected") {
        // Not yet a failure — WebRTC reports this for a stall that usually
        // heals itself. But arm the watchdog, because if it does not heal
        // there is otherwise nothing to end the wait.
        setState("reconnecting");
        armConnectTimer();
        return;
      }

      if (pc.connectionState === "failed") {
        if (iceRestarts >= MAX_ICE_RESTARTS) {
          // The bug this replaces: restartIce() does NOT throw on a restart
          // that is about to fail, so the old catch block never ran and this
          // branch retried forever with the UI stuck on "reconnecting…".
          failConnection("ice_failed");
          return;
        }
        iceRestarts += 1;
        diagnose(`ice_restart attempt=${iceRestarts}`);
        setState("reconnecting");
        armConnectTimer();
        try {
          pc.restartIce();
        } catch {
          failConnection("restart_threw");
        }
      }
    };

    setState("connecting");
    armConnectTimer();
  };

  const drainCandidates = async () => {
    if (!pc?.remoteDescription || pendingCandidates.length === 0) return;
    const queued = pendingCandidates;
    pendingCandidates = [];
    diagnose(`candidates_drained count=${queued.length}`);
    for (const candidate of queued) {
      try {
        await pc.addIceCandidate(candidate);
      } catch {
        /* genuinely stale, e.g. after a rollback — safe to drop now */
      }
    }
  };

  const handleDescription = async (data: unknown) => {
    if (!pc) buildPeer();
    if (!pc) return;
    const description = data as RTCSessionDescriptionInit;
    const readyForOffer =
      !makingOffer && (pc.signalingState === "stable" || settingRemoteAnswer);
    const offerCollision = description.type === "offer" && !readyForOffer;
    ignoreOffer = !polite && offerCollision;
    if (ignoreOffer) return;
    try {
      settingRemoteAnswer = description.type === "answer";
      await pc.setRemoteDescription(description);
      settingRemoteAnswer = false;
      // There is a remote description now, so anything that arrived early is
      // finally addable. Drain before answering: these are the partner's
      // candidates, and on a hard network one of them is the relay.
      await drainCandidates();
      if (description.type === "offer") {
        await pc.setLocalDescription();
        sendSignal({ kind: "description", data: pc.localDescription });
      }
    } catch {
      settingRemoteAnswer = false;
      events.onError?.("Call negotiation failed.");
    }
  };

  /**
   * Take a candidate from the partner — or hold it until it can be taken.
   *
   * `addIceCandidate` throws if the peer connection has no remote description
   * yet, and this used to swallow that as "stale candidate after a rollback".
   * It usually was not stale. The answerer applies the offer and immediately
   * starts trickling, so its candidates race its answer down the same
   * broadcast channel, and any that won the race were thrown away for good.
   * On an easy network nobody noticed; on a hard one the discarded candidate
   * is the relay, and the call fails with every part of it working.
   */
  const handleCandidate = async (data: unknown) => {
    const candidate = data as RTCIceCandidateInit;
    if (!pc || !pc.remoteDescription) {
      pendingCandidates.push(candidate);
      return;
    }
    try {
      await pc.addIceCandidate(candidate);
    } catch {
      if (!ignoreOffer) {
        /* stale candidate after a rollback — safe to drop */
      }
    }
  };

  const handlePeerGone = () => {
    if (ended) return;
    otherPeerId = null;
    languageEchoedTo = null;
    teardownPeer();
    // Their interpreter can't be speaking to us anymore — never strand the
    // "hold on" indicator across a drop/rejoin.
    events.onPeerInterpreterSpeaking?.(false);
    events.onPeerLeft?.();
    setState("waiting");
  };

  try {
    if (
      typeof navigator === "undefined" ||
      !navigator.mediaDevices?.getUserMedia ||
      !window.isSecureContext
    ) {
      throw new Error(
        "Camera/microphone are unavailable here. Open the app over HTTPS in Safari/Chrome and allow access."
      );
    }

    setState("media");
    // echoCancellation ON is essential: the speaker plays both the partner's
    // voice and the interpreter's translation, and neither may loop back into
    // the mic (the partner would hear themselves; the far interpreter would
    // re-translate its own output's source).
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        autoGainControl: true,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true
      },
      video: config.video ? { facingMode: "user", width: { ideal: 640 } } : false
    });
    applyMicMute();
    events.onLocalStream?.(localStream);

    const room = normalizeRoomCode(config.room);
    if (!room) throw new Error("Enter a room code first.");

    // Mint the relay BEFORE joining the room, because the peer connection is
    // built the moment a partner appears — a presence sync is synchronous and
    // has nowhere to await this. One mint per join: the credential outlives
    // the call, so a reconnect reuses it rather than paying a round trip.
    //
    // fetchIceServers() never throws and never returns empty; a failure here
    // degrades to the STUN-only call /call was already making, which is why
    // this is not guarded. What must not happen is a founder being unable to
    // place a call at all because Cloudflare had a bad minute.
    const ice = await fetchIceServers();
    iceServers = ice.iceServers;
    relayAvailable = ice.relay;
    diagnose(
      `ice_servers count=${iceServers.length} relay_available=${relayAvailable} ` +
        `mint=${ice.status}`
    );
    events.onRelayAvailable?.(relayAvailable);

    // A channel per room, and never two.
    //
    // supabase-js keeps subscribed channels on the client by topic, and a
    // second `.on("presence", …)` against one that is already subscribed
    // throws "cannot add presence callbacks after subscribe()". The call then
    // dies at "camera/mic…" with an error about a word nobody on this screen
    // has heard of.
    //
    // The way in is a double tap on Join. Nothing disables that button while
    // the first join is in flight, so an impatient thumb on a slow phone
    // starts two calls into the same room and the second one poisons both.
    // Verified 2026-08-27 by driving this file from two browser tabs: two
    // taps 250ms apart failed every time before this loop, and connect
    // cleanly after it. (A sequential hang-up-then-rejoin was always fine —
    // it is the OVERLAP that breaks, which is why nobody hit it by hand.)
    const topic = `taos-call-${room}`;
    for (const stale of supabase.getChannels()) {
      if (stale.topic === topic || stale.topic === `realtime:${topic}`) {
        await supabase.removeChannel(stale);
      }
    }

    channel = supabase.channel(topic, {
      config: { broadcast: { self: false }, presence: { key: peerId } }
    });

    channel.on("broadcast", { event: "signal" }, ({ payload }) => {
      const msg = payload as SignalMessage;
      if (!msg || msg.from === peerId) return;
      if (otherPeerId === null) {
        // A signal can arrive before our presence sync sees the partner (their
        // sync fired first). Pair up here so `polite` is set before the offer
        // is processed — otherwise both sides could end up impolite (glare
        // deadlock).
        otherPeerId = msg.from;
        polite = peerId < msg.from;
        announceLanguage();
      }
      if (msg.from !== otherPeerId) return; // room is strictly 1:1
      if (msg.kind === "bye") handlePeerGone();
      else if (msg.kind === "description") void handleDescription(msg.data);
      else if (msg.kind === "candidate") void handleCandidate(msg.data);
      else if (msg.kind === "interpreter") {
        const speaking = Boolean((msg.data as { speaking?: boolean } | undefined)?.speaking);
        events.onPeerInterpreterSpeaking?.(speaking);
      } else if (msg.kind === "language") {
        const lang = (msg.data as { lang?: unknown } | undefined)?.lang;
        if (typeof lang === "string" && lang) events.onPeerLanguage?.(lang);
        if (languageEchoedTo !== msg.from) {
          languageEchoedTo = msg.from;
          announceLanguage();
        }
      }
    });

    channel.on("presence", { event: "sync" }, () => {
      if (ended || !channel) return;
      const others = Object.keys(channel.presenceState()).filter((k) => k !== peerId);
      if (others.length > 1) {
        // Crowded room. If we're already paired with one of them, keep the
        // call alive and ignore the extra (a 3rd tap on a shared link must not
        // kill the original call). Only bail if we haven't paired yet — we're
        // the intruder.
        if (otherPeerId && others.includes(otherPeerId)) return;
        events.onError?.("This room already has two people in it.");
        void hangUp();
        return;
      }
      const partner = others[0] ?? null;
      if (partner && partner !== otherPeerId) {
        otherPeerId = partner;
        languageEchoedTo = null;
        // Both sides compare the same two random ids and pick opposite roles.
        polite = peerId < partner;
        announceLanguage();
        buildPeer();
      } else if (!partner && otherPeerId) {
        handlePeerGone();
      } else if (!partner) {
        setState("waiting");
      }
    });

    await new Promise<void>((resolve, reject) => {
      channel!.subscribe((status) => {
        if (status === "SUBSCRIBED") {
          void channel!.track({ joined_at: new Date().toISOString() });
          resolve();
        }
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          reject(new Error("Could not reach the call room. Check your connection."));
        }
      });
    });

    setState("waiting");

    return {
      hangUp,
      setMicMuted: (muted: boolean) => {
        micMuted = muted;
        applyMicMute();
      },
      setVideo: async (on: boolean) => {
        if (!localStream) return;
        const existing = localStream.getVideoTracks()[0];
        if (on) {
          if (existing) {
            existing.enabled = true;
            return;
          }
          const cam = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: "user", width: { ideal: 640 } }
          });
          const track = cam.getVideoTracks()[0];
          if (!track) return;
          localStream.addTrack(track);
          // addTrack on the live pc triggers onnegotiationneeded → the perfect
          // negotiation machinery renegotiates the call with video added.
          pc?.addTrack(track, localStream);
          events.onLocalStream?.(localStream);
        } else if (existing) {
          existing.enabled = false;
        }
      },
      setRemoteVolume: (volume: number) => {
        remoteVolume = Math.min(1, Math.max(0, volume));
        applyRemoteVolume();
      },
      sendInterpreterSpeaking: (speaking: boolean) => {
        if (!ended && otherPeerId) sendSignal({ kind: "interpreter", data: { speaking } });
      },
      sendLanguage: (code: string) => {
        myLanguage = code;
        announceLanguage();
      },
      readMediaFlow: async () => (pc && !ended ? readMediaFlow(pc) : null)
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start the call.";
    events.onError?.(message);
    setState("error");
    await hangUp();
    throw error;
  }
}
