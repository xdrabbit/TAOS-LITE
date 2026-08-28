"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  generateRoomCode,
  normalizeRoomCode,
  startCall,
  type ActiveCall,
  type CallState
} from "@/lib/call/session";
import {
  startCallInterpreter,
  type ActiveInterpreter,
  type InterpreterEndReason,
  type InterpreterVoiceMode
} from "@/lib/call/interpreter";
import { resolveCallDirection, type CallDirection } from "@/lib/call/instructions";
import {
  emptySpend,
  formatUsd,
  formatUsdPerMinute,
  spendUsd,
  usdPerMinute,
  type CallSpend
} from "@/lib/call/cost";
import { LanguagePillRow, LanguageSheet } from "./LanguagePicker";
import { languageLabel } from "@/lib/languages/catalog";
import { useLanguagePair } from "@/lib/translate/useLanguagePair";
import { isTextOnlyLanguage, TEXT_ONLY_TITLE } from "@/lib/tts/speech";
import { jsonAuthHeaders } from "@/lib/authClient";
import { createWakeLockHold, type WakeLockHold } from "@/lib/wakeLock";

// ── /call: translated 1:1 calls ─────────────────────────────────────────────
// Use case: Tom and Liz call each other over wifi or cellular — video or
// audio-only. Each phone hears the other person's real voice AND an AI
// interpreter speaking in the listener's own language, with live captions.
// The call itself is peer-to-peer WebRTC (signaled through Supabase, media
// never touches a server); each side runs its own interpreter session on the
// partner's incoming audio, so each person independently chooses
// captions/voice/volume for their ear.
//
// ── The pair, and the handshake ────────────────────────────────────────────
// This screen used to hold `useState<"en" | "es">` and ask for "English" or
// "Spanish" in so many words. It reads the shared pair now, like /translate,
// /live and /tabletop — but a call is the one screen where the two ends hold
// SEPARATE pairs on separate phones, so the picker alone was never going to
// be enough. `mine` is announced to the partner over the call's own signaling
// channel and their `mine` arrives back; each interpreter then listens for
// THEIR language and speaks MINE. Until their announcement lands (the first
// second of a call), `theirs` from the local pair stands in — this phone's
// standing guess about who it is talking to, and usually right.
//
// So a phone left on [en, it] after ordering dinner is already correct for a
// call to the Italian side of the family, with no taps.

interface CaptionLine {
  id: number;
  heard: string | null;
  text: string;
  at: number;
}

const MAX_FEED = 100;

/**
 * How loud the partner's OWN voice plays, under the interpreter's translation
 * of it. Three steps rather than a slider because a slider is unusable on a
 * phone held to a face.
 *
 * "Quiet" is the default and the reason this control exists: hearing the
 * partner's real voice underneath tells you they are still there and still
 * talking, which a translation alone does not — but at full volume it fights
 * the translation for the same ear. It is a duck, not a mute.
 *
 * This is a DIFFERENT voice from the "Translation / Captions only" button
 * next to it, which governs the interpreter. The labels say whose voice each
 * one is, because "voice off" appearing twice on one screen with two meanings
 * is how a control ends up reported as broken when it is merely the other one.
 */
const VOLUME_STEPS: Array<{ value: number; label: string }> = [
  { value: 1, label: "🔊 Their real voice: full" },
  { value: 0.25, label: "🔉 Their real voice: quiet" },
  { value: 0, label: "🔈 Their real voice: off" }
];

function formatElapsed(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function stateLabel(s: CallState): string {
  switch (s) {
    case "media":
      return "camera/mic…";
    case "waiting":
      return "waiting for partner…";
    case "connecting":
      return "connecting…";
    case "connected":
      return "connected";
    case "reconnecting":
      return "reconnecting…";
    default:
      return "";
  }
}

export function CallShell(): JSX.Element {
  const [phase, setPhase] = useState<"lobby" | "call">("lobby");
  const [room, setRoom] = useState("");
  const [withVideo, setWithVideo] = useState(true);
  const [voiceMode, setVoiceMode] = useState<InterpreterVoiceMode>("clone");
  const [callState, setCallState] = useState<CallState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [micMuted, setMicMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(true);
  const [voiceOn, setVoiceOn] = useState(true);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [volumeStep, setVolumeStep] = useState(1);
  const [elapsed, setElapsed] = useState(0);
  const [remoteHasVideo, setRemoteHasVideo] = useState(false);
  const [idleSecondsLeft, setIdleSecondsLeft] = useState<number | null>(null);
  const [spend, setSpend] = useState<CallSpend>(() => emptySpend("elevenlabs"));

  const [feed, setFeed] = useState<CaptionLine[]>([]);
  const [liveText, setLiveText] = useState("");
  const [liveHeard, setLiveHeard] = useState<string | null>(null);
  // True while the PARTNER's phone is playing a translation of what was said
  // here — speaking now would talk over it and clip it for them.
  const [peerInterpreterSpeaking, setPeerInterpreterSpeaking] = useState(false);
  // What the partner's phone says THEY speak. Null until their announcement
  // lands; `theirs` from the local pair stands in until then.
  const [peerLanguage, setPeerLanguage] = useState<string | null>(null);

  const callRef = useRef<ActiveCall | null>(null);
  const interpreterRef = useRef<ActiveInterpreter | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const wakeHoldRef = useRef<WakeLockHold | null>(null);
  const inCallRef = useRef(false);
  const voiceOnRef = useRef(true);
  const micMutedRef = useRef(false);
  const cameraOnRef = useRef(true);
  const volumeStepRef = useRef(1);
  const voiceModeRef = useRef<InterpreterVoiceMode>("clone");
  const remoteTrackRef = useRef<MediaStreamTrack | null>(null);
  const nextIdRef = useRef(1);
  const timerRef = useRef<number | null>(null);
  const heardQueueRef = useRef<string[]>([]);
  const peerSpeakingGuardRef = useRef<number | null>(null);
  // True from the moment a session is asked for until it is in hand. Without
  // it, anything that re-points the interpreter during the ~1s mint window
  // sees `interpreterRef.current === null`, decides there is nothing running,
  // and starts a SECOND billing session alongside the first.
  const startingRef = useRef(false);
  const elapsedRef = useRef(0);
  const roomRef = useRef("");

  // The pair, exactly as every other screen holds it. Changing it mid-call
  // re-points the live interpreter and tells the partner, rather than
  // dropping the session: the languages are a setting, not a restart.
  const { mine, theirs, pills, sheetOpen, setSheetOpen, selectLanguage } = useLanguagePair();

  // Seeded from the pair rather than from two literal codes — a call that
  // starts before the first effect runs still starts on the catalog's answer,
  // not on this file's opinion about which two languages exist.
  const directionRef = useRef<CallDirection>({ source: theirs, target: mine });

  // What this phone's interpreter is doing right now: listen for the
  // partner's language, speak the owner's.
  const direction = useMemo(
    () => resolveCallDirection(mine, peerLanguage, theirs),
    [mine, peerLanguage, theirs]
  );

  const spendNow = spendUsd(spend);
  const perMinute = usdPerMinute(spend, elapsed);
  const noVoiceForMe = isTextOnlyLanguage(mine);

  useEffect(() => {
    voiceOnRef.current = voiceOn;
  }, [voiceOn]);
  useEffect(() => {
    voiceModeRef.current = voiceMode;
  }, [voiceMode]);
  useEffect(() => {
    elapsedRef.current = elapsed;
  }, [elapsed]);
  useEffect(() => {
    roomRef.current = room;
  }, [room]);

  // Prefill the room code from a shared /call?room=XYZ link.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("room");
    if (q) setRoom(normalizeRoomCode(q));
  }, []);

  // A lost "stopped" broadcast must never strand the hold-on indicator, so
  // every "speaking" signal re-arms a generous auto-clear.
  const setPeerSpeaking = useCallback((speaking: boolean) => {
    if (peerSpeakingGuardRef.current !== null) {
      window.clearTimeout(peerSpeakingGuardRef.current);
      peerSpeakingGuardRef.current = null;
    }
    setPeerInterpreterSpeaking(speaking);
    if (speaking) {
      peerSpeakingGuardRef.current = window.setTimeout(
        () => setPeerInterpreterSpeaking(false),
        25_000
      );
    }
  }, []);

  // Screen wake lock for the duration of the call. Shared holder
  // (lib/wakeLock.ts): re-acquires on visibility return AND on the sentinel's
  // "release" event — iOS drops the lock without a visibilitychange under Low
  // Power Mode / pressure (8/2 field report on /translate; same gap here).
  useEffect(() => {
    const hold = createWakeLockHold(() => inCallRef.current);
    wakeHoldRef.current = hold;
    return () => {
      wakeHoldRef.current = null;
      hold.stop();
    };
  }, []);

  const stopInterpreter = useCallback(() => {
    const it = interpreterRef.current;
    interpreterRef.current = null;
    if (it) void it.stop();
  }, []);

  /**
   * Hand the finished call's bill to the server log.
   *
   * Best-effort and deliberately unawaited at the call site: the phone is
   * hanging up and nothing on screen depends on the answer. A dropped report
   * costs a log line, not a call.
   */
  const reportSpend = useCallback(
    async (finalSpend: CallSpend, seconds: number, mode: InterpreterVoiceMode, dir: CallDirection) => {
      if (finalSpend.responses === 0 && finalSpend.transcribedSeconds === 0) return;
      try {
        await fetch("/api/call/usage", {
          method: "POST",
          headers: await jsonAuthHeaders(),
          body: JSON.stringify({
            room: roomRef.current,
            mode,
            direction: `${dir.source}->${dir.target}`,
            seconds,
            spend: finalSpend
          })
        });
      } catch {
        /* the meter on screen already said it */
      }
    },
    []
  );

  const startInterpreterFor = useCallback(
    (track: MediaStreamTrack) => {
      if (startingRef.current) return;
      stopInterpreter();
      setNotice(null); // clears the "partner left" banner on rejoin
      const dir = directionRef.current;
      // Two people who already share a language have nothing to interpret,
      // and an interpreter pointed at its own output language either parrots
      // or sits silent. Either way it bills, so it simply doesn't start.
      if (dir.source === dir.target) {
        setNotice(
          `You and your partner are both on ${languageLabel(dir.target)} — no interpreter needed.`
        );
        return;
      }

      startingRef.current = true;
      startCallInterpreter(
        {
          direction: dir,
          inputTrack: track,
          muted: !voiceOnRef.current,
          voiceMode: voiceModeRef.current
        },
        {
          onError: (msg) => setNotice(`Interpreter: ${msg}`),
          // This phone's interpreter speaks translations of the PARTNER's
          // words — so it's the partner who must not talk over it. Relay the
          // state so their phone can show the hold-on indicator.
          onSpeaking: (speaking) => callRef.current?.sendInterpreterSpeaking(speaking),
          onSpend: (next) => setSpend(next),
          onIdleWarning: (secondsLeft) => setIdleSecondsLeft(secondsLeft),
          onAutoEnd: (reason: InterpreterEndReason) => {
            setNotice(
              reason === "idle"
                ? "The interpreter stopped after two minutes of quiet — tap Rejoin to bring it back."
                : "The interpreter hit its one-hour limit — tap Rejoin to start a fresh hour."
            );
          },
          onHeard: (text) => {
            heardQueueRef.current.push(text);
            setLiveHeard(text);
          },
          onTranslationDelta: (delta) => setLiveText((t) => t + delta),
          onTranslationDone: (text) => {
            const heard = heardQueueRef.current.splice(0).join(" · ") || null;
            setLiveText("");
            setLiveHeard(null);
            setFeed((f) => {
              const entry: CaptionLine = {
                id: nextIdRef.current++,
                heard,
                text,
                at: Date.now()
              };
              return [entry, ...f].slice(0, MAX_FEED);
            });
          }
        }
      )
        .then((it) => {
          if (inCallRef.current) interpreterRef.current = it;
          else void it.stop();
        })
        .catch(() => {
          /* onError already surfaced it */
        })
        .finally(() => {
          startingRef.current = false;
        });
    },
    [stopInterpreter]
  );

  // Keep the live session pointed at the current pair. Either phone changing
  // its language lands here — mine through the picker, theirs over the wire.
  useEffect(() => {
    directionRef.current = direction;
    const it = interpreterRef.current;
    if (!it) return;
    if (direction.source === direction.target) {
      // Gone doubled mid-call: stop paying for a session with no job.
      stopInterpreter();
      setNotice(
        `You and your partner are both on ${languageLabel(direction.target)} — no interpreter needed.`
      );
      return;
    }
    it.setDirection(direction);
  }, [direction, stopInterpreter]);

  // A doubled pair that comes back apart deserves its interpreter back, and
  // the remote track is already in hand.
  useEffect(() => {
    if (!inCallRef.current || interpreterRef.current || startingRef.current) return;
    if (direction.source === direction.target) return;
    const track = remoteTrackRef.current;
    if (track && track.readyState === "live") startInterpreterFor(track);
  }, [direction, startInterpreterFor]);

  // Tell the partner when this phone's own language changes, so their
  // interpreter follows without either of us re-joining.
  useEffect(() => {
    callRef.current?.sendLanguage(mine);
  }, [mine]);

  const endCall = useCallback(() => {
    inCallRef.current = false;
    const it = interpreterRef.current;
    const finalSpend = it?.spend() ?? null;
    startingRef.current = false;
    stopInterpreter();
    const call = callRef.current;
    callRef.current = null;
    if (call) void call.hangUp();
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    if (finalSpend) {
      void reportSpend(
        finalSpend,
        elapsedRef.current,
        voiceModeRef.current,
        directionRef.current
      );
    }
    wakeHoldRef.current?.ensure(); // inCallRef is false now → holder releases
    remoteTrackRef.current = null;
    setPhase("lobby");
    setCallState("idle");
    setElapsed(0);
    setRemoteHasVideo(false);
    setLiveText("");
    setLiveHeard(null);
    setIdleSecondsLeft(null);
    setPeerLanguage(null);
    setPeerSpeaking(false);
  }, [stopInterpreter, setPeerSpeaking, reportSpend]);

  useEffect(() => {
    return () => {
      if (peerSpeakingGuardRef.current !== null) {
        window.clearTimeout(peerSpeakingGuardRef.current);
      }
    };
  }, []);

  const join = useCallback(async () => {
    const code = normalizeRoomCode(room);
    if (!code) {
      setError("Enter or create a room code first.");
      return;
    }
    setError(null);
    setNotice(null);
    setFeed([]);
    setElapsed(0);
    setSpend(emptySpend("elevenlabs"));
    setPeerLanguage(null);
    inCallRef.current = true;
    setPhase("call");
    setCameraOn(withVideo);
    cameraOnRef.current = withVideo;
    setMicMuted(false);
    micMutedRef.current = false;
    // Every call opens with the partner's own voice ducked under the
    // interpreter — the same value join() pushes into the call below.
    setVolumeStep(1);
    volumeStepRef.current = 1;

    // Acquire inside the Join tap (a user gesture — best context if a prior
    // request was denied).
    wakeHoldRef.current?.ensure();

    try {
      const call = await startCall(
        { room: code, video: withVideo, language: mine },
        {
          onState: (s) => {
            setCallState(s);
            if (s === "connected" && timerRef.current === null) {
              timerRef.current = window.setInterval(() => setElapsed((e) => e + 1), 1000);
            }
          },
          onError: (msg) => setError(msg),
          onLocalStream: (stream) => {
            if (localVideoRef.current) {
              localVideoRef.current.srcObject = stream;
              void localVideoRef.current.play().catch(() => {});
            }
          },
          onRemoteStream: (stream) => {
            setRemoteHasVideo(Boolean(stream?.getVideoTracks().length));
            if (remoteVideoRef.current) {
              remoteVideoRef.current.srcObject = stream;
              if (stream) void remoteVideoRef.current.play().catch(() => {});
            }
          },
          onRemoteAudioTrack: (track) => {
            remoteTrackRef.current = track;
            startInterpreterFor(track);
          },
          onPeerLanguage: (code) => setPeerLanguage(code),
          onPeerInterpreterSpeaking: (speaking) => setPeerSpeaking(speaking),
          onPeerLeft: () => {
            stopInterpreter();
            remoteTrackRef.current = null;
            setPeerLanguage(null);
            setNotice("Your partner left the call. Waiting for them to rejoin…");
          }
        }
      );
      if (!inCallRef.current) {
        void call.hangUp();
        return;
      }
      callRef.current = call;
      call.setRemoteVolume(VOLUME_STEPS[1].value);
    } catch {
      endCall();
    }
  }, [room, withVideo, mine, startInterpreterFor, stopInterpreter, endCall, setPeerSpeaking]);

  const createRoom = useCallback(() => {
    setRoom(generateRoomCode());
    setCopied(false);
  }, []);

  const shareLink = useCallback(async () => {
    const code = normalizeRoomCode(room);
    if (!code) return;
    const url = `${window.location.origin}/call?room=${code}`;
    const nav = navigator as Navigator & { share?: (d: { url: string; title?: string }) => Promise<void> };
    try {
      if (nav.share) {
        await nav.share({ url, title: "TAOS call" });
      } else {
        await navigator.clipboard.writeText(url);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 2000);
      }
    } catch {
      /* user canceled the share sheet */
    }
  }, [room]);

  // Every control below reads the current value from a ref and does its work
  // OUTSIDE the state updater.
  //
  // They used to reach into the call and the interpreter from inside
  // `setState(prev => …)`, which React is allowed to invoke more than once for
  // a single tap — it does so in StrictMode, and may under concurrent
  // rendering. A pure updater survives that; one that hangs up a track, starts
  // a camera renegotiation, or clears an audio buffer does not. The bug this
  // fixes is not theoretical for the camera in particular: two renegotiations
  // for one tap is a visibly stuck video tile.
  const toggleMic = useCallback(() => {
    const next = !micMutedRef.current;
    micMutedRef.current = next;
    setMicMuted(next);
    callRef.current?.setMicMuted(next);
  }, []);

  const toggleCamera = useCallback(() => {
    const next = !cameraOnRef.current;
    cameraOnRef.current = next;
    setCameraOn(next);
    void callRef.current?.setVideo(next).catch(() => setNotice("Could not switch the camera."));
  }, []);

  const toggleVoice = useCallback(() => {
    const next = !voiceOnRef.current;
    voiceOnRef.current = next;
    setVoiceOn(next);
    // Immediately: lib/call/interpreter.ts stops the sentence in the air
    // rather than letting it finish. Tom's report was that this control
    // "appeared not to work or lagged", and finishing the current utterance is
    // most of that — six seconds is a long time to watch a button you pressed.
    interpreterRef.current?.setMuted(!next);
  }, []);

  const cycleVolume = useCallback(() => {
    const next = (volumeStepRef.current + 1) % VOLUME_STEPS.length;
    volumeStepRef.current = next;
    setVolumeStep(next);
    callRef.current?.setRemoteVolume(VOLUME_STEPS[next].value);
  }, []);

  // Clean up everything if the component unmounts mid-call.
  useEffect(() => {
    return () => {
      if (inCallRef.current) endCall();
    };
  }, [endCall]);

  const btn = (active: boolean) =>
    `rounded-xl px-3 py-2 text-xs font-medium transition ${
      active ? "bg-amber-400 text-stone-950" : "border border-white/10 bg-white/5 text-amber-100/70"
    }`;

  return (
    <main className="min-h-screen px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-[calc(env(safe-area-inset-top)+1rem)]">
      <div className="mx-auto flex min-h-[calc(100vh-2rem)] max-w-md flex-col gap-4">
        <header className="flex items-center justify-between gap-2">
          <h1 className="text-lg font-semibold tracking-tight text-amber-200">TAOS·LITE</h1>
          <a
            href="/"
            className="rounded-full border border-white/10 bg-white/5 px-4 py-1.5 text-sm text-amber-100/80"
          >
            ← Home
          </a>
        </header>

        {phase === "lobby" ? (
          <>
            <div>
              <div className="text-xs uppercase tracking-[0.2em] text-amber-100/50">
                Translated call
              </div>
              <p className="mt-1 text-sm text-amber-50/70">
                Call each other over wifi or cellular — video or voice-only. Each of you hears the
                other person plus an interpreter in your own language, with live captions.
              </p>
            </div>

            {/* The shared pair, drawn the way every screen draws it. The solid
                pill is THEIRS — who you expect to be talking to — and it is
                only a guess until their phone says otherwise on connect. */}
            <LanguagePillRow
              pills={pills}
              selected={theirs}
              paired={mine}
              pairedTitle="You hear this · Tú escuchas esto"
              caption="They speak · Ellos hablan"
              sheetOpen={sheetOpen}
              onSelect={selectLanguage}
              onOpenSheet={() => setSheetOpen(true)}
            />
            <p className="-mt-2 text-xs text-amber-100/50">
              You hear <span className="text-amber-200">{languageLabel(mine)}</span>. Their phone
              announces what they speak when the call connects.
              {noVoiceForMe ? ` ${TEXT_ONLY_TITLE}.` : ""}
            </p>

            {/* Video or audio-only */}
            <div className="grid grid-cols-2 gap-2 rounded-2xl border border-white/10 bg-white/5 p-1">
              {(
                [
                  [true, "📹 Video call"],
                  [false, "🎧 Voice only"]
                ] as [boolean, string][]
              ).map(([v, label]) => (
                <button
                  key={label}
                  type="button"
                  onClick={() => setWithVideo(v)}
                  className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                    withVideo === v ? "bg-amber-400 text-stone-950" : "text-amber-100/70"
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            {/* Which voice reads the translation. See lib/call/interpreter.ts:
                the clone is cheaper AND it is the partner's own voice, at the
                price of about a second. */}
            <div className="rounded-2xl border border-white/10 bg-white/5 p-1">
              <div className="grid grid-cols-2 gap-2">
                {(
                  [
                    ["clone", "🎙️ Their voice"],
                    ["instant", "⚡ Fastest"]
                  ] as [InterpreterVoiceMode, string][]
                ).map(([m, label]) => (
                  <button
                    key={m}
                    type="button"
                    onClick={() => setVoiceMode(m)}
                    className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                      voiceMode === m ? "bg-amber-400 text-stone-950" : "text-amber-100/70"
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <p className="px-2 pb-1 pt-2 text-[11px] text-amber-100/50">
                {voiceMode === "clone"
                  ? "The translation is read in their own voice — about a second behind."
                  : "The model speaks it the moment it can. A stock voice, and the priciest way to run a call."}
              </p>
            </div>

            {/* Room */}
            <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
              <div className="text-xs uppercase tracking-[0.2em] text-amber-100/50">Room</div>
              <div className="mt-2 flex gap-2">
                <input
                  value={room}
                  onChange={(e) => setRoom(normalizeRoomCode(e.target.value))}
                  placeholder="Room code"
                  autoCapitalize="characters"
                  autoCorrect="off"
                  spellCheck={false}
                  className="min-w-0 flex-1 rounded-xl border border-white/10 bg-stone-950/60 px-3 py-2 text-base tracking-[0.15em] text-amber-50 placeholder:text-amber-100/30"
                />
                <button type="button" onClick={createRoom} className={btn(false)}>
                  New code
                </button>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void shareLink()}
                  disabled={!room}
                  className={`${btn(false)} disabled:opacity-40`}
                >
                  {copied ? "Link copied ✓" : "Share link"}
                </button>
                <span className="text-xs text-amber-100/50">
                  Same code on both phones = same call.
                </span>
              </div>
            </div>

            {error ? (
              <div className="rounded-2xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">
                {error}
              </div>
            ) : null}

            <button
              type="button"
              onClick={() => void join()}
              disabled={!room}
              className="rounded-2xl bg-emerald-400 px-4 py-3 text-base font-semibold text-stone-950 transition disabled:opacity-40"
            >
              Join call
            </button>
          </>
        ) : (
          <>
            {/* Video area */}
            <div className="relative overflow-hidden rounded-2xl border border-white/10 bg-stone-950/80">
              <video
                ref={remoteVideoRef}
                playsInline
                autoPlay
                muted /* original audio plays via the call's ducked audio element */
                className={`aspect-[3/4] w-full object-cover ${remoteHasVideo ? "" : "hidden"}`}
              />
              {!remoteHasVideo ? (
                <div className="flex aspect-[3/4] w-full flex-col items-center justify-center gap-2 text-amber-100/50">
                  <div className="text-5xl">🎧</div>
                  <div className="text-sm">{stateLabel(callState) || "voice call"}</div>
                </div>
              ) : null}
              <video
                ref={localVideoRef}
                playsInline
                autoPlay
                muted
                className={`absolute bottom-2 right-2 w-24 rounded-xl border border-white/20 object-cover ${
                  cameraOn ? "" : "hidden"
                }`}
              />
              <div className="absolute left-2 top-2 flex items-center gap-2 rounded-full bg-stone-950/70 px-3 py-1 text-xs text-amber-100/80">
                <span
                  className={`inline-block h-2 w-2 rounded-full ${
                    callState === "connected"
                      ? "bg-emerald-400"
                      : callState === "error"
                        ? "bg-red-400"
                        : "animate-pulse bg-amber-300"
                  }`}
                />
                {callState === "connected" ? formatElapsed(elapsed) : stateLabel(callState)}
                <span className="text-amber-100/50">· {room}</span>
              </div>
              {/* The meter. /call was pulled partly because nobody could say
                  what a minute of it cost; now it says so while it spends. */}
              <div
                className="absolute right-2 top-2 rounded-full bg-stone-950/70 px-3 py-1 text-xs text-amber-100/70"
                title="This phone's share of the call. Your partner's phone spends its own."
              >
                {formatUsd(spendNow)}
                {perMinute > 0 ? (
                  <span className="text-amber-100/40"> · {formatUsdPerMinute(perMinute)}</span>
                ) : null}
              </div>
            </div>

            {/* Who is being interpreted into what, once their phone has said. */}
            <div className="flex items-center justify-between gap-2 text-xs text-amber-100/50">
              <span>
                {languageLabel(direction.source)} → {languageLabel(direction.target)}
                {peerLanguage ? "" : " (assumed)"}
              </span>
              <span>{voiceMode === "clone" ? "their voice" : "fastest voice"}</span>
            </div>

            {idleSecondsLeft !== null ? (
              <div className="rounded-2xl border border-amber-300/40 bg-amber-300/10 px-3 py-2 text-sm text-amber-200">
                Quiet for a while — the interpreter stops in about {idleSecondsLeft}s to save
                money. Say anything to keep it.
              </div>
            ) : null}

            {/* Hold-on indicator: the partner's phone is still speaking the
                translation of what was said here — talking now clips it. */}
            {peerInterpreterSpeaking ? (
              <div className="flex items-center gap-2 rounded-2xl border border-amber-300/40 bg-amber-300/10 px-3 py-2 text-sm text-amber-200">
                <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-300" />
                Interpreter is still speaking to them — one sec…
              </div>
            ) : null}

            {/* Captions */}
            {captionsOn ? (
              <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
                {liveHeard ? (
                  <div className="text-xs italic text-amber-100/40">“{liveHeard}”</div>
                ) : null}
                <div className="min-h-[3rem] text-lg leading-snug text-amber-50">
                  {liveText || feed[0]?.text || (
                    <span className="text-amber-100/40">Captions appear here…</span>
                  )}
                </div>
                {feed.length > (liveText ? 0 : 1) ? (
                  <div className="mt-2 max-h-40 space-y-2 overflow-y-auto border-t border-white/10 pt-2">
                    {(liveText ? feed : feed.slice(1)).map((line) => (
                      <div key={line.id}>
                        {line.heard ? (
                          <div className="text-[11px] italic text-amber-100/30">“{line.heard}”</div>
                        ) : null}
                        <div className="text-sm text-amber-100/70">{line.text}</div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
            ) : null}

            {notice ? (
              <div className="rounded-2xl border border-amber-300/20 bg-amber-400/10 p-3 text-xs text-amber-100/80">
                {notice}
              </div>
            ) : null}
            {error ? (
              <div className="rounded-2xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">
                {error}
              </div>
            ) : null}

            {/* Controls */}
            <div className="grid grid-cols-3 gap-2">
              <button type="button" onClick={toggleMic} className={btn(micMuted)}>
                {micMuted ? "🔇 Mic off" : "🎙️ Mic on"}
              </button>
              <button type="button" onClick={toggleCamera} className={btn(cameraOn)}>
                {cameraOn ? "📹 Cam on" : "📷 Cam off"}
              </button>
              <button type="button" onClick={toggleVoice} className={btn(voiceOn)}>
                {voiceOn ? "🗣️ Translation" : "💬 Captions only"}
              </button>
              <button type="button" onClick={() => setCaptionsOn((c) => !c)} className={btn(captionsOn)}>
                {captionsOn ? "💬 Captions" : "💬 Hidden"}
              </button>
              <button type="button" onClick={cycleVolume} className={`${btn(false)} col-span-2`}>
                {VOLUME_STEPS[volumeStep].label}
              </button>
            </div>
            {/* Two voices, two controls, and until 8/28 nothing on the screen
                said which was which. */}
            <p className="text-[11px] leading-snug text-amber-100/40">
              {voiceOn
                ? "You hear the interpreter speaking their words in your language."
                : "The interpreter is silent — the captions below are still running."}{" "}
              {VOLUME_STEPS[volumeStep].value === 0
                ? "Their own voice is muted underneath."
                : VOLUME_STEPS[volumeStep].value < 1
                  ? "Their own voice plays quietly underneath, so you can hear them talking."
                  : "Their own voice plays at full volume underneath."}
            </p>

            {/* Mid-call language change: re-points the live session and tells
                the partner's phone, without either of you rejoining. */}
            <LanguagePillRow
              pills={pills}
              selected={theirs}
              paired={mine}
              pairedTitle="You hear this · Tú escuchas esto"
              sheetOpen={sheetOpen}
              onSelect={selectLanguage}
              onOpenSheet={() => setSheetOpen(true)}
            />

            <button
              type="button"
              onClick={endCall}
              className="rounded-2xl bg-red-500 px-4 py-3 text-base font-semibold text-stone-50 transition"
            >
              Hang up
            </button>
          </>
        )}

        <LanguageSheet
          open={sheetOpen}
          selected={theirs}
          paired={mine}
          pairedLabel="You hear this"
          caption="What they speak · Lo que ellos hablan"
          onSelect={selectLanguage}
          onClose={() => setSheetOpen(false)}
        />
      </div>
    </main>
  );
}
