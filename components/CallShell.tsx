"use client";

import { useCallback, useEffect, useRef, useState } from "react";
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
  type InterpreterTarget
} from "@/lib/call/interpreter";

// ── /call: translated 1:1 calls ─────────────────────────────────────────────
// Use case: Tom (EN) and Liz (ES) call each other over wifi or cellular —
// video or audio-only. Each phone hears the other person's real voice AND an
// AI interpreter speaking in the listener's own language, with live captions.
// The call itself is peer-to-peer WebRTC (signaled through Supabase); each
// side runs its own interpreter session on the partner's incoming audio, so
// each person independently chooses captions/voice/volume for their ear.

interface CaptionLine {
  id: number;
  heard: string | null;
  text: string;
  at: number;
}

const MAX_FEED = 100;

const TARGET_LABEL: Record<InterpreterTarget, string> = {
  en: "I want to hear English",
  es: "Quiero escuchar Español"
};

// Original-voice volume steps the ducking button cycles through.
const VOLUME_STEPS: Array<{ value: number; label: string }> = [
  { value: 1, label: "Original voice: full" },
  { value: 0.25, label: "Original voice: quiet" },
  { value: 0, label: "Original voice: off" }
];

interface ScreenWakeSentinel {
  release(): Promise<void>;
}
function getWakeLock(): { request(type: "screen"): Promise<ScreenWakeSentinel> } | null {
  if (typeof navigator === "undefined") return null;
  const nav = navigator as Navigator & {
    wakeLock?: { request(type: "screen"): Promise<ScreenWakeSentinel> };
  };
  return nav.wakeLock ?? null;
}

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
  const [target, setTarget] = useState<InterpreterTarget>("en");
  const [withVideo, setWithVideo] = useState(true);
  const [callState, setCallState] = useState<CallState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const [micMuted, setMicMuted] = useState(false);
  const [cameraOn, setCameraOn] = useState(true);
  const [voiceOn, setVoiceOn] = useState(true);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [volumeStep, setVolumeStep] = useState(1); // start on "quiet": duck under translation
  const [elapsed, setElapsed] = useState(0);
  const [remoteHasVideo, setRemoteHasVideo] = useState(false);

  const [feed, setFeed] = useState<CaptionLine[]>([]);
  const [liveText, setLiveText] = useState("");
  const [liveHeard, setLiveHeard] = useState<string | null>(null);

  const callRef = useRef<ActiveCall | null>(null);
  const interpreterRef = useRef<ActiveInterpreter | null>(null);
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const wakeLockRef = useRef<ScreenWakeSentinel | null>(null);
  const inCallRef = useRef(false);
  const voiceOnRef = useRef(true);
  const targetRef = useRef<InterpreterTarget>("en");
  const nextIdRef = useRef(1);
  const timerRef = useRef<number | null>(null);
  const heardQueueRef = useRef<string[]>([]);

  // Prefill the room code from a shared /call?room=XYZ link.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("room");
    if (q) setRoom(normalizeRoomCode(q));
  }, []);

  useEffect(() => {
    voiceOnRef.current = voiceOn;
  }, [voiceOn]);
  useEffect(() => {
    targetRef.current = target;
  }, [target]);

  // Screen wake lock for the duration of the call (re-acquired when the tab
  // becomes visible again — same pattern as /live).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible" && inCallRef.current) {
        getWakeLock()
          ?.request("screen")
          .then((sentinel) => {
            if (inCallRef.current) wakeLockRef.current = sentinel;
            else void sentinel.release().catch(() => {});
          })
          .catch(() => {});
      }
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, []);

  const stopInterpreter = useCallback(() => {
    const it = interpreterRef.current;
    interpreterRef.current = null;
    if (it) void it.stop();
  }, []);

  const startInterpreterFor = useCallback(
    (track: MediaStreamTrack) => {
      stopInterpreter();
      setNotice(null); // clears the "partner left" banner on rejoin
      startCallInterpreter(
        { target: targetRef.current, inputTrack: track, muted: !voiceOnRef.current },
        {
          onError: (msg) => setNotice(`Interpreter: ${msg}`),
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
        });
    },
    [stopInterpreter]
  );

  const endCall = useCallback(() => {
    inCallRef.current = false;
    stopInterpreter();
    const call = callRef.current;
    callRef.current = null;
    if (call) void call.hangUp();
    if (timerRef.current !== null) {
      window.clearInterval(timerRef.current);
      timerRef.current = null;
    }
    void wakeLockRef.current?.release().catch(() => {});
    wakeLockRef.current = null;
    setPhase("lobby");
    setCallState("idle");
    setElapsed(0);
    setRemoteHasVideo(false);
    setLiveText("");
    setLiveHeard(null);
  }, [stopInterpreter]);

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
    inCallRef.current = true;
    setPhase("call");
    setCameraOn(withVideo);
    setMicMuted(false);

    getWakeLock()
      ?.request("screen")
      .then((sentinel) => {
        if (inCallRef.current) wakeLockRef.current = sentinel;
        else void sentinel.release().catch(() => {});
      })
      .catch(() => {});

    try {
      const call = await startCall(
        { room: code, video: withVideo },
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
          onRemoteAudioTrack: (track) => startInterpreterFor(track),
          onPeerLeft: () => {
            stopInterpreter();
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
  }, [room, withVideo, startInterpreterFor, stopInterpreter, endCall]);

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

  const toggleMic = useCallback(() => {
    setMicMuted((m) => {
      callRef.current?.setMicMuted(!m);
      return !m;
    });
  }, []);

  const toggleCamera = useCallback(() => {
    setCameraOn((on) => {
      void callRef.current?.setVideo(!on).catch(() => setNotice("Could not switch the camera."));
      return !on;
    });
  }, []);

  const toggleVoice = useCallback(() => {
    setVoiceOn((v) => {
      interpreterRef.current?.setMuted(v);
      return !v;
    });
  }, []);

  const cycleVolume = useCallback(() => {
    setVolumeStep((s) => {
      const next = (s + 1) % VOLUME_STEPS.length;
      callRef.current?.setRemoteVolume(VOLUME_STEPS[next].value);
      return next;
    });
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

            {/* What do I want to hear? */}
            <div className="grid grid-cols-1 gap-2 rounded-2xl border border-white/10 bg-white/5 p-1">
              {(Object.keys(TARGET_LABEL) as InterpreterTarget[]).map((t) => (
                <button
                  key={t}
                  type="button"
                  onClick={() => setTarget(t)}
                  className={`rounded-xl px-3 py-2 text-sm font-medium transition ${
                    target === t ? "bg-emerald-400 text-stone-950" : "text-amber-100/70"
                  }`}
                >
                  {TARGET_LABEL[t]}
                </button>
              ))}
            </div>

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
            </div>

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
                {voiceOn ? "🗣️ Voice on" : "💬 Text only"}
              </button>
              <button type="button" onClick={() => setCaptionsOn((c) => !c)} className={btn(captionsOn)}>
                {captionsOn ? "💬 Captions" : "💬 Hidden"}
              </button>
              <button type="button" onClick={cycleVolume} className={`${btn(false)} col-span-2`}>
                {VOLUME_STEPS[volumeStep].label}
              </button>
            </div>

            <button
              type="button"
              onClick={endCall}
              className="rounded-2xl bg-red-500 px-4 py-3 text-base font-semibold text-stone-50 transition"
            >
              Hang up
            </button>
          </>
        )}
      </div>
    </main>
  );
}
