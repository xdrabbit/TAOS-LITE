"use client";

import { supabase } from "@/lib/supabase";
import type { RealtimeChannel } from "@supabase/supabase-js";

// 1:1 WebRTC call between Tom and Liz, signaled over a Supabase Realtime
// broadcast channel (no extra infra: the app's existing Supabase project
// relays only tiny SDP/ICE JSON blobs — media flows peer-to-peer). Uses the
// MDN "perfect negotiation" pattern so glare (both sides offering at once)
// and mid-call renegotiation (camera on/off) just work.
//
// Connectivity: STUN by default, which covers most wifi/cellular pairings.
// For carrier NATs where P2P fails, set NEXT_PUBLIC_TURN_URL /
// NEXT_PUBLIC_TURN_USERNAME / NEXT_PUBLIC_TURN_CREDENTIAL to add a TURN relay.

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

function getIceServers(): RTCIceServer[] {
  const servers: RTCIceServer[] = [{ urls: "stun:stun.l.google.com:19302" }];
  const turnUrl = process.env.NEXT_PUBLIC_TURN_URL?.trim();
  if (turnUrl) {
    servers.push({
      urls: turnUrl,
      username: process.env.NEXT_PUBLIC_TURN_USERNAME?.trim() || undefined,
      credential: process.env.NEXT_PUBLIC_TURN_CREDENTIAL?.trim() || undefined
    });
  }
  return servers;
}

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
  let remoteAudioCtx: AudioContext | null = null;
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

  const setState = (s: CallState) => {
    if (!ended || s === "ended") events.onState?.(s);
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
    if (pc) {
      try {
        pc.onnegotiationneeded = null;
        pc.onicecandidate = null;
        pc.ontrack = null;
        pc.onconnectionstatechange = null;
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
    if (remoteAudioCtx) {
      void remoteAudioCtx.close().catch(() => {
        /* already closed */
      });
      remoteAudioCtx = null;
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
      const Ctor =
        window.AudioContext ??
        (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      const ctx = new Ctor();
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      const gain = ctx.createGain();
      gain.gain.value = 0;
      source.connect(analyser);
      analyser.connect(gain);
      gain.connect(ctx.destination);
      remoteAudioCtx = ctx;
      remoteGain = gain;
      void ctx.resume().catch(() => {
        /* resumes on the next gesture; the element covers the gap */
      });

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
      remoteAudioCtx = null;
      remoteGain = null;
    }
  };

  const buildPeer = () => {
    teardownPeer();
    if (ended || !localStream) return;

    pc = new RTCPeerConnection({ iceServers: getIceServers() });

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
      if (ev.candidate) sendSignal({ kind: "candidate", data: ev.candidate.toJSON() });
    };

    pc.onconnectionstatechange = () => {
      if (!pc || ended) return;
      if (pc.connectionState === "connected") setState("connected");
      if (pc.connectionState === "disconnected") setState("reconnecting");
      if (pc.connectionState === "failed") {
        // One ICE restart attempt before giving up — flaky cellular handoffs
        // often recover; a hard NAT block will fail again immediately.
        setState("reconnecting");
        try {
          pc.restartIce();
        } catch {
          events.onError?.("Connection failed. If this keeps happening, both switch to wifi.");
          setState("error");
        }
      }
    };

    setState("connecting");
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
      if (description.type === "offer") {
        await pc.setLocalDescription();
        sendSignal({ kind: "description", data: pc.localDescription });
      }
    } catch {
      settingRemoteAnswer = false;
      events.onError?.("Call negotiation failed.");
    }
  };

  const handleCandidate = async (data: unknown) => {
    if (!pc) return;
    try {
      await pc.addIceCandidate(data as RTCIceCandidateInit);
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
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "Failed to start the call.";
    events.onError?.(message);
    setState("error");
    await hangUp();
    throw error;
  }
}
