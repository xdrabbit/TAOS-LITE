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
  fetchRelayStatus,
  type CallMediaFlow,
  type CallTransport
} from "@/lib/call/ice";
import { relayCopy, type RelayStatusReport, type RelayTone } from "@/lib/call/relay";
import {
  captionsExpected,
  interpreterCopy,
  type InterpreterStatus
} from "@/lib/call/interpreterStatus";
import { probeCopy, probeRelay, type RelayProbeResult } from "@/lib/call/relayProbe";
import {
  startCallInterpreter,
  type ActiveInterpreter,
  type InterpreterEndReason,
  type InterpreterInputStats,
  type InterpreterVoiceMode
} from "@/lib/call/interpreter";
import { resolveCallDirection, type CallDirection } from "@/lib/call/instructions";
import { ensureCallAudioContext } from "@/lib/call/audioBridge";
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

// The connection labels are BILINGUAL, on one line, for the same reason the
// failure message in lib/call/session.ts is: the two people on a call read
// different languages, they are looking at their own phones, and a status
// only one of them can read is a status that gets described out loud over a
// call that is not working yet.
function stateLabel(s: CallState): string {
  switch (s) {
    case "media":
      return "camera/mic… · cámara/micro…";
    case "waiting":
      return "waiting… · esperando…";
    case "connecting":
      return "connecting… · conectando…";
    case "connected":
      return "connected · conectado";
    case "reconnecting":
      return "reconnecting… · reconectando…";
    case "error":
      // Reachable for the first time as of 8/31. The old code had no path to
      // it for a connection failure — a doomed call retried until somebody
      // gave up — so the pill sat blank on the one state that most needed a
      // word on it.
      return "not connected · sin conexión";
    default:
      return "";
  }
}

/**
 * How the media is actually flowing — the honest half of "Connected".
 *
 * Worth showing rather than hiding: `relay` means the call is going through
 * Cloudflare and spending relay bandwidth, and `direct` means it is free. It
 * is also the single value Tom and Liz's three-row network matrix is there to
 * collect, so it has to be readable on the phone that is on the call.
 */
function transportLabel(t: CallTransport): string {
  switch (t) {
    case "direct":
      return "direct · directo";
    case "relay":
      return "relay · retransmitido";
    default:
      return "linked · enlazado";
  }
}

/** Lobby / probe indicator colours, by the tone lib/call/relay.ts assigns. */
const TONE_CLASS: Record<RelayTone, string> = {
  ok: "border-emerald-400/30 bg-emerald-400/10 text-emerald-200",
  warn: "border-amber-400/30 bg-amber-400/10 text-amber-100/80",
  bad: "border-red-400/30 bg-red-400/10 text-red-200"
};

/**
 * One direction of the media, as a tick or a cross and a rate.
 *
 * The whole point is that the two directions are printed SEPARATELY. "Is
 * audio flowing?" is true on the sending side of a one-way call, which is
 * exactly what Liz's phone was on 8/31 — connected, relayed, heard, and
 * hearing nothing. `sending ✓ 148/s · receiving ✗ 0/s` is that call, said in
 * numbers, on the screen of the person it is happening to.
 *
 * The rate needs two samples; until the second one lands it falls back to
 * "has anything ever arrived", which is weaker (a direction that carried
 * audio and then stopped still shows a total) and is why it is only the
 * first two seconds.
 */
function flowLine(name: string, total: number, previous: number | null, seconds: number): string {
  const rate = previous === null || seconds <= 0 ? null : Math.round((total - previous) / seconds);
  const moving = rate === null ? total > 0 : rate > 0;
  return `${name} ${moving ? "✓" : "✗"} ${total} pkt${rate === null ? "" : ` · ${rate}/s`}`;
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
  // Connection diagnostics. These stay after the 8/31 fix — they are the
  // founders' debugging tool, and the first version of a support surface.
  const [transport, setTransport] = useState<CallTransport | null>(null);
  const [relayAvailable, setRelayAvailable] = useState<boolean | null>(null);
  // The lobby preflight: what the server says about the keys, and what a
  // one-tap loopback proved about the path. See the panel below Join.
  const [relayReport, setRelayReport] = useState<RelayStatusReport | null>(null);
  const [probing, setProbing] = useState(false);
  const [probe, setProbe] = useState<RelayProbeResult | null>(null);
  // Two samples, so cumulative packet counters can be read as rates. A total
  // alone cannot tell audio that is flowing from audio that stopped.
  const [flow, setFlow] = useState<CallMediaFlow | null>(null);
  const [prevFlow, setPrevFlow] = useState<CallMediaFlow | null>(null);
  const [trail, setTrail] = useState<string[]>([]);
  const [idleSecondsLeft, setIdleSecondsLeft] = useState<number | null>(null);
  // Why the interpreter stopped on its own, or null while it is running. The
  // notice used to say "tap Rejoin" at a screen that had no Rejoin on it —
  // the only control was Hang up, which drops the CALL too. This is what
  // draws the button the copy was already promising.
  const [autoEnded, setAutoEnded] = useState<InterpreterEndReason | null>(null);
  const [spend, setSpend] = useState<CallSpend>(() => emptySpend("elevenlabs"));

  // What the interpreter is doing, as a thing the SCREEN knows. Before 8/31
  // this existed only inside lib/call/interpreter.ts, which is why a session
  // could fail, or run deaf, without anybody being told.
  const [interpreterStatus, setInterpreterStatus] = useState<InterpreterStatus>("off");
  const [interpreterReason, setInterpreterReason] = useState<string | null>(null);

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
  // How many captions this screen actually put up, for the hang-up report.
  // `feed` is state and the hang-up path reads refs; a caption count that
  // arrives one render late is a caption count that lies about the last one.
  const feedCountRef = useRef(0);
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
  // Read at hang-up, when the state itself is already being reset.
  const transportRef = useRef<CallTransport | null>(null);

  // The pair, exactly as every other screen holds it. Changing it mid-call
  // re-points the live interpreter and tells the partner, rather than
  // dropping the session: the languages are a setting, not a restart.
  //
  // `lockMine` is what /call does DIFFERENTLY, and it is the 9/3 field report:
  // at a table, tapping your own outlined pill flips the pair, and one tap
  // undoes it. On a call that same tap re-points the live interpreter, tells
  // the partner's phone to follow, and persists — so Tom, wanting to hear the
  // language his own pill was labelled with, heard the other one and moved his
  // partner's side too. In a call your own side is a LABEL. In the lobby,
  // before anyone is listening, it is still the flip it has always been.
  const { mine, theirs, pills, sheetOpen, setSheetOpen, selectLanguage, mineLocked } =
    useLanguagePair({ lockMine: phase === "call" });

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

  // The interpreter's status, as words. Same shape as the relay preflight's
  // (lib/call/relay.ts) because they answer the same kind of question and a
  // founder should not have to learn two vocabularies on one screen.
  const interpreterWords = interpreterCopy(interpreterStatus, interpreterReason);
  const interpreterTone = interpreterWords.tone;

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
  useEffect(() => {
    transportRef.current = transport;
  }, [transport]);

  // Prefill the room code from a shared /call?room=XYZ link.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search).get("room");
    if (q) setRoom(normalizeRoomCode(q));
  }, []);

  // ── The preflight ────────────────────────────────────────────────────────
  // Ask the server whether Cloudflare will mint for the keys it holds, the
  // moment the lobby is on screen. This is the answer that used to require
  // placing a real call to Liz and watching it fail: `relay: false` was the
  // only signal /call had, and it meant "no keys", "wrong keys" and
  // "Cloudflare is down" indistinguishably. Re-run on every return to the
  // lobby, because the interesting case is Tom fixing a key in Vercel and
  // wanting to know whether it took.
  useEffect(() => {
    if (phase !== "lobby") return;
    let cancelled = false;
    setRelayReport(null);
    void fetchRelayStatus().then((report) => {
      if (!cancelled) setRelayReport(report);
    });
    return () => {
      cancelled = true;
    };
  }, [phase]);

  // ── The breadcrumb for one-way audio ─────────────────────────────────────
  // Liz, 5G behind CGNAT, 2026-08-31: connected, and audio in ONE direction.
  // Nothing on the screen could tell that call from a working one — the pill
  // said `connected` and the transport said `relay`, and both were true. Two
  // counters, two seconds apart, make the missing direction a number.
  useEffect(() => {
    if (phase !== "call" || callState !== "connected") return;
    let cancelled = false;
    const sample = async () => {
      const next = await callRef.current?.readMediaFlow();
      if (cancelled || !next) return;
      setFlow((current) => {
        setPrevFlow(current);
        return next;
      });
    };
    void sample();
    const id = window.setInterval(() => void sample(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [phase, callState]);

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

  // Bounded exactly as the call's own diagnostics are: a long call must not
  // grow this array until the phone slows down.
  const pushTrail = useCallback((line: string) => {
    setTrail((lines) => [...lines.slice(-39), `${new Date().toLocaleTimeString()} ${line}`]);
  }, []);

  const stopInterpreter = useCallback(() => {
    const it = interpreterRef.current;
    interpreterRef.current = null;
    if (it) void it.stop();
    // Deliberately NOT clearing a `failed` status here: the teardown that
    // follows a failure must not erase the reason for it, which is the same
    // mistake lib/call/interpreter.ts's own `stop()` used to make.
    setInterpreterStatus((s) => (s === "failed" ? s : "off"));
  }, []);

  /**
   * Hand the finished call's bill to the server log.
   *
   * Best-effort and deliberately unawaited at the call site: the phone is
   * hanging up and nothing on screen depends on the answer. A dropped report
   * costs a log line, not a call.
   */
  const reportSpend = useCallback(
    async (
      finalSpend: CallSpend,
      seconds: number,
      mode: InterpreterVoiceMode,
      dir: CallDirection,
      captions: number,
      stats: InterpreterInputStats | null,
      transportUsed: CallTransport | null
    ) => {
      // A call that spent nothing is normally a call nobody spoke on — but it
      // is ALSO what the silent interpreter looks like, and that one has to
      // reach the log. `speech_started=0 seconds=180` is the whole diagnosis.
      const heardNothing = Boolean(stats) && stats?.speechStarted === 0 && seconds >= 10;
      if (finalSpend.responses === 0 && finalSpend.transcribedSeconds === 0 && !heardNothing) {
        return;
      }
      try {
        await fetch("/api/call/usage", {
          method: "POST",
          headers: await jsonAuthHeaders(),
          body: JSON.stringify({
            room: roomRef.current,
            mode,
            direction: `${dir.source}->${dir.target}`,
            seconds,
            spend: finalSpend,
            captions,
            transport: transportUsed ?? "unknown",
            speechStarted: stats?.speechStarted ?? 0
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
      setAutoEnded(null);
      const dir = directionRef.current;
      // Two people who already share a language have nothing to interpret,
      // and an interpreter pointed at its own output language either parrots
      // or sits silent. Either way it bills, so it simply doesn't start.
      if (dir.source === dir.target) {
        setInterpreterStatus("not_needed");
        setInterpreterReason(null);
        setNotice(
          `You and your partner are both on ${languageLabel(dir.target)} — no interpreter needed.`
        );
        return;
      }

      startingRef.current = true;
      setInterpreterStatus("starting");
      setInterpreterReason(null);
      startCallInterpreter(
        {
          direction: dir,
          inputTrack: track,
          muted: !voiceOnRef.current,
          voiceMode: voiceModeRef.current
        },
        {
          // Every one of these is a state the screen had no word for before
          // 8/31, and the reason a dead interpreter looked exactly like a
          // working one.
          onState: (state) => {
            if (state === "minting" || state === "connecting") setInterpreterStatus("starting");
            else if (state === "connected") setInterpreterStatus((s) => (s === "hearing" ? s : "on"));
            else if (state === "error") setInterpreterStatus("failed");
            else if (state === "idle") setInterpreterStatus((s) => (s === "failed" ? s : "off"));
          },
          // The partner's forwarded audio demonstrably arrived. "Connected"
          // never proved that, and a session fed silence is the one failure
          // that produces no error of any kind.
          onHearing: () => setInterpreterStatus("hearing"),
          onError: (msg) => {
            setInterpreterReason(msg);
            setNotice(`Interpreter: ${msg}`);
          },
          // This phone's interpreter speaks translations of the PARTNER's
          // words — so it's the partner who must not talk over it. Relay the
          // state so their phone can show the hold-on indicator.
          onSpeaking: (speaking) => callRef.current?.sendInterpreterSpeaking(speaking),
          onSpend: (next) => setSpend(next),
          onDiagnostic: (line) => pushTrail(line),
          // Connected, and hearing nothing. Deliberately worded apart from the
          // idle message: idle means nobody spoke, this means the audio never
          // reached the session — which is the 2026-09-03 failure exactly.
          onInputSilent: () =>
            setNotice(
              "Interpreter is connected but hearing nothing — try Rejoin, and check the trail below."
            ),
          onIdleWarning: (secondsLeft) => setIdleSecondsLeft(secondsLeft),
          onAutoEnd: (reason: InterpreterEndReason) => {
            setAutoEnded(reason);
            setNotice(
              reason === "idle"
                ? "The interpreter stopped after two minutes of quiet — tap Rejoin to bring it back. You are still on the call."
                : "The interpreter hit its one-hour limit — tap Rejoin to start a fresh hour. You are still on the call."
            );
          },
          onHeard: (text) => {
            heardQueueRef.current.push(text);
            setLiveHeard(text);
          },
          onTranslationDelta: (delta) => setLiveText((t) => t + delta),
          onTranslationDone: (text) => {
            // Counted HERE and not inside the setFeed updater below: React may
            // invoke an updater more than once for a single change (it does in
            // StrictMode), and a counter that runs twice reports captions that
            // were never on the screen. Same rule the controls follow.
            feedCountRef.current += 1;
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
        .catch((error: unknown) => {
          // onError has normally already run inside the module. This is the
          // backstop for a rejection that never reached it — the status must
          // never be left reading "starting…" forever.
          const message =
            error instanceof Error ? error.message : "The interpreter could not start.";
          setInterpreterStatus("failed");
          setInterpreterReason((r) => r ?? message);
        })
        .finally(() => {
          startingRef.current = false;
        });
    },
    [stopInterpreter, pushTrail]
  );

  /**
   * Bring the interpreter back after it stopped itself.
   *
   * The notice has said "tap Rejoin" since the idle timer was added; there has
   * never been a Rejoin. The only button on the screen was Hang up, which ends
   * the CALL — so the copy was asking for something a person could not do, and
   * the cheapest way out of two minutes of quiet was to drop a working call
   * and dial again.
   *
   * The call itself is untouched by an auto-end: the peer connection, the
   * remote track and the wake lock are all still in hand. So this restarts one
   * realtime session on the audio that is already arriving, and nothing else.
   * `startInterpreterFor` stops whatever is left and clears the notice.
   */
  const rejoinInterpreter = useCallback(() => {
    const track = remoteTrackRef.current;
    if (!inCallRef.current || !track || track.readyState !== "live") {
      // No partner audio to interpret — a rejoin here would mint a session
      // against a dead track and bill for it. Say what IS true instead.
      setAutoEnded(null);
      setNotice("Waiting for your partner's audio — the interpreter starts when it arrives.");
      return;
    }
    setIdleSecondsLeft(null);
    startInterpreterFor(track);
  }, [startInterpreterFor]);

  // Keep the live session pointed at the current pair. Either phone changing
  // its language lands here — mine through the picker, theirs over the wire.
  useEffect(() => {
    directionRef.current = direction;
    const it = interpreterRef.current;
    if (!it) return;
    if (direction.source === direction.target) {
      // Gone doubled mid-call: stop paying for a session with no job.
      stopInterpreter();
      setInterpreterStatus("not_needed");
      setInterpreterReason(null);
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
    const finalInput = it?.inputStats() ?? null;
    const finalTransport = transportRef.current;
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
        directionRef.current,
        feedCountRef.current,
        finalInput,
        finalTransport
      );
    }
    wakeHoldRef.current?.ensure(); // inCallRef is false now → holder releases
    remoteTrackRef.current = null;
    transportRef.current = null;
    setPhase("lobby");
    setCallState("idle");
    setElapsed(0);
    setRemoteHasVideo(false);
    setLiveText("");
    setLiveHeard(null);
    setIdleSecondsLeft(null);
    setAutoEnded(null);
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
    feedCountRef.current = 0;
    setElapsed(0);
    setSpend(emptySpend("elevenlabs"));
    setPeerLanguage(null);
    setTransport(null);
    setRelayAvailable(null);
    setFlow(null);
    setPrevFlow(null);
    setTrail([]);
    // A fresh call starts on a clean slate, including a failure left over from
    // the last one — this is the ONE place a `failed` status is allowed to
    // clear, so a dead interpreter can never be mistaken for a new one.
    setInterpreterStatus("off");
    setInterpreterReason(null);
    // Captions are the point of the screen. They come back ON for every call
    // regardless of how the last one ended.
    setCaptionsOn(true);
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
    // Same tap, same reason: iOS will not START an AudioContext outside a
    // gesture, and both the ducking graph and the interpreter's input bridge
    // hang off this one. Created here, it is running before either asks.
    ensureCallAudioContext();

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
          onPeerLanguage: (code) => {
            // Point the ref BEFORE the state update, not only from the effect
            // that follows it. The partner's announcement and their audio
            // track arrive in the same tick, React batches both, and the
            // effect runs after — so `startInterpreterFor` read the previous
            // direction and minted a session for a pair that turned out to be
            // doubled, which the effect then immediately stopped. A session
            // that exists for one tick is still a session that was created.
            directionRef.current = resolveCallDirection(mine, code, theirs);
            setPeerLanguage(code);
          },
          onTransport: (t) => setTransport(t),
          onRelayAvailable: (available) => setRelayAvailable(available),
          // Bounded: a call that reconnects repeatedly must not grow this
          // array until the phone slows down. The last 40 lines are the
          // ones that explain a failure anyway.
          onDiagnostic: (line) => pushTrail(line),
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
  }, [
    room,
    withVideo,
    mine,
    theirs,
    startInterpreterFor,
    stopInterpreter,
    endCall,
    setPeerSpeaking,
    pushTrail
  ]);

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

  /**
   * The "Test connection" tap.
   *
   * One button, ~1s, and it answers the question two people with two phones
   * in two rooms used to have to answer by dialling each other. Traced into
   * the same trail the call itself writes, so a screenshot of a failed probe
   * carries the same detail as a screenshot of a failed call.
   */
  const runProbe = useCallback(async () => {
    if (probing) return;
    setProbing(true);
    setProbe(null);
    setTrail([]);
    try {
      const result = await probeRelay((line) => setTrail((t) => [...t.slice(-60), `probe ${line}`]));
      setProbe(result);
    } finally {
      setProbing(false);
    }
  }, [probing]);

  const btn = (active: boolean) =>
    `rounded-xl px-3 py-2 text-xs font-medium transition ${
      active ? "bg-amber-400 text-stone-950" : "border border-white/10 bg-white/5 text-amber-100/70"
    }`;

  return (
    <main
      className={`px-4 pb-[calc(env(safe-area-inset-bottom)+1rem)] pt-[calc(env(safe-area-inset-top)+1rem)] ${
        // In a CALL the page is exactly one screen tall, and the height is set
        // HERE rather than on the column inside — `box-sizing: border-box` is
        // global (Tailwind preflight), so 100svh here has the safe-area
        // padding INSIDE it. Subtracting a guessed "2rem" on the column
        // instead would come up short by the notch and the home indicator on
        // an installed PWA, which is ~81px of controls back off the bottom of
        // the screen — the bug this whole PR is about, in a smaller size.
        phase === "call" ? "h-[100svh] overflow-hidden" : "min-h-screen"
      }`}
    >
      {/* In the LOBBY the page may grow and scroll; in a CALL it may not.
          The 8/31 field report ("no captions") was this line. The call screen
          was a 1055px column poured into a 659px phone: the caption panel
          began 591px down and the button that toggles it sat at 811px — off
          the bottom of an iPhone, on a screen nobody thinks to scroll because
          they are looking at a face. `svh` rather than `vh` because iOS
          measures `vh` against the browser WITHOUT its toolbars, a viewport
          that only exists while you are already scrolling. */}
      <div
        className={`mx-auto flex max-w-md flex-col ${
          phase === "call"
            ? "h-full gap-3 overflow-hidden"
            : "min-h-[calc(100vh-2rem)] gap-4"
        }`}
      >
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
              pairedLocked={mineLocked}
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

            {/* ── Preflight ──────────────────────────────────────────────
                Founders only, and quiet: two lines and a button, below the
                room code and above Join, so it is read on the way past.

                It exists because until 2026-08-31 the only instrument for
                "does the relay work" was a call between Tom and Liz on two
                real phones — an instrument that fails for five reasons and
                reports one word. The top line is the server's answer (will
                Cloudflare MINT for these keys) and the button is the
                client's (will the relay ALLOCATE and carry a packet). They
                fail independently, which is why both are here. */}
            <div className="rounded-2xl border border-white/10 bg-white/5 p-3">
              <div className="text-xs uppercase tracking-[0.2em] text-amber-100/50">
                Before you dial · Antes de llamar
              </div>

              {(() => {
                const copy = relayCopy(relayReport?.status ?? null);
                return (
                  <>
                    <div
                      className={`mt-2 rounded-xl border px-3 py-2 text-sm ${TONE_CLASS[copy.tone]}`}
                    >
                      {copy.label}
                    </div>
                    {copy.hint ? (
                      <p className="mt-2 text-[11px] leading-relaxed text-amber-100/50">
                        {copy.hint}
                      </p>
                    ) : null}
                    {/* Cloudflare's own status code and words. Kept because
                        "rejected" is the state that needs a human, and the
                        human needs to know WHICH refusal it was. */}
                    {relayReport && relayReport.status !== "ready" && relayReport.detail ? (
                      <p className="mt-1 font-mono text-[10px] text-amber-100/35">
                        {relayReport.httpStatus ? `HTTP ${relayReport.httpStatus} · ` : ""}
                        {relayReport.detail}
                      </p>
                    ) : null}
                  </>
                );
              })()}

              <div className="mt-3 flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => void runProbe()}
                  disabled={probing}
                  className={`${btn(false)} disabled:opacity-40`}
                >
                  {probing ? "Testing… · probando…" : "Test connection · Probar conexión"}
                </button>
                <span className="text-[11px] text-amber-100/40">
                  Forces a relay-only connection to this phone. ~1s.
                </span>
              </div>

              {probe ? (
                (() => {
                  const copy = probeCopy(probe);
                  return (
                    <div
                      className={`mt-2 rounded-xl border px-3 py-2 text-xs ${TONE_CLASS[copy.tone]}`}
                    >
                      {copy.text}
                      {probe.status !== "ok" && probe.detail ? (
                        <div className="mt-1 font-mono text-[10px] opacity-70">{probe.detail}</div>
                      ) : null}
                    </div>
                  );
                })()
              ) : null}

              {/* The probe writes the same trail a call does, so a founder can
                  screenshot a failed test instead of describing it. */}
              {trail.length > 0 ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[11px] text-amber-100/40">
                    Test details · Detalles de la prueba
                  </summary>
                  <div className="mt-1 max-h-32 overflow-y-auto font-mono text-[10px] text-amber-100/35">
                    {trail.map((line, i) => (
                      <div key={`${i}-${line}`}>{line}</div>
                    ))}
                  </div>
                </details>
              ) : null}
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
            {/* Video area. `min-h-0 flex-1` is what makes the rest of the
                column reachable: the tile takes whatever is left after the
                captions and the controls have had their height, instead of
                claiming a fixed 4:3 portrait block and pushing them off the
                bottom of the screen. */}
            <div className="relative min-h-[7rem] flex-[2_1_0%] overflow-hidden rounded-2xl border border-white/10 bg-stone-950/80">
              <video
                ref={remoteVideoRef}
                playsInline
                autoPlay
                muted /* original audio plays via the call's ducked audio element */
                className={`h-full w-full object-cover ${remoteHasVideo ? "" : "hidden"}`}
              />
              {!remoteHasVideo ? (
                <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-amber-100/50">
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
                {/* The honest half of "connected": which path the media took.
                    `relay` is the one that spends Cloudflare bandwidth, and
                    it is the value Tom and Liz's network matrix collects. */}
                {callState === "connected" && transport ? (
                  <span
                    className={transport === "relay" ? "text-sky-300/80" : "text-emerald-300/80"}
                    title={
                      transport === "relay"
                        ? "Relayed through Cloudflare — one of you is on a network with no direct path."
                        : "Peer-to-peer. No relay bandwidth is being spent."
                    }
                  >
                    · {transportLabel(transport)}
                  </span>
                ) : null}
                {/* Only while it still matters: before a connection exists,
                    knowing there is no fallback is what explains a failure. */}
                {callState !== "connected" && relayAvailable === false ? (
                  <span
                    className="text-amber-300/70"
                    title="No TURN relay is configured, so this call can only connect if a direct path exists."
                  >
                    · no relay
                  </span>
                ) : null}
              </div>
              {/* The interpreter, on the video, where the face is.
                  Before 8/31 this screen had no word for the interpreter at
                  all: it could mint, connect, translate, spend money and hang
                  up without ever saying so, and a session that never started
                  looked exactly like one that started and said nothing. */}
              <div
                className={`absolute bottom-2 left-2 right-2 flex items-center gap-2 rounded-full px-3 py-1 text-xs ${
                  interpreterTone === "ok"
                    ? "bg-stone-950/70 text-emerald-200/90"
                    : interpreterTone === "bad"
                      ? "bg-red-950/80 text-red-200"
                      : "bg-stone-950/80 text-amber-200/90"
                }`}
                title={interpreterWords.hint}
              >
                <span
                  className={`inline-block h-2 w-2 shrink-0 rounded-full ${
                    interpreterTone === "ok"
                      ? "bg-emerald-400"
                      : interpreterTone === "bad"
                        ? "bg-red-400"
                        : "animate-pulse bg-amber-300"
                  }`}
                />
                <span className="truncate">{interpreterWords.label}</span>
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

            {/* Captions.
                An empty panel used to read "Captions appear here…" whatever
                was happening behind it — while the session was starting,
                while it was dead, and while it was quietly being fed silence.
                It says which one now, because "no captions" is a symptom with
                four causes and the screen is the only thing in a position to
                tell them apart. */}
            {captionsOn ? (
              <div className="shrink-0 rounded-2xl border border-white/10 bg-white/5 p-3">
                {liveHeard ? (
                  <div className="text-xs italic text-amber-100/40">“{liveHeard}”</div>
                ) : null}
                <div className="min-h-[3rem] text-lg leading-snug text-amber-50">
                  {liveText ||
                    feed[0]?.text ||
                    (captionsExpected(interpreterStatus) ? (
                      <span className="text-amber-100/40">
                        {interpreterStatus === "hearing"
                          ? "Listening… captions appear as they speak."
                          : "Captions appear here as soon as they speak."}
                      </span>
                    ) : (
                      <span className={interpreterTone === "bad" ? "text-red-300" : "text-amber-300/80"}>
                        {interpreterWords.hint}
                      </span>
                    ))}
                </div>
                {feed.length > (liveText ? 0 : 1) ? (
                  <div className="mt-2 max-h-24 space-y-2 overflow-y-auto border-t border-white/10 pt-2">
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
            ) : (
              /* Captions OFF is a choice, and it must never be mistakable for
                 captions BROKEN — which is the whole of the 8/31 report read
                 the other way round. It leaves a mark that says so, and the
                 mark is the button. */
              <button
                type="button"
                onClick={() => setCaptionsOn(true)}
                className="shrink-0 rounded-2xl border border-dashed border-white/20 bg-white/[0.03] p-3 text-left text-sm text-amber-100/60"
              >
                Captions are OFF · Subtítulos apagados — tap to show them.
              </button>
            )}

            {notice ? (
              <div className="rounded-2xl border border-amber-300/20 bg-amber-400/10 p-3 text-xs text-amber-100/80">
                {notice}
                {/* The button the copy above has been promising since the
                    idle timer landed. Only here, because this is the only
                    state it does anything in: the call is still up, the
                    partner's audio is still arriving, and the one thing that
                    stopped is the realtime session. */}
                {autoEnded ? (
                  <button
                    type="button"
                    onClick={rejoinInterpreter}
                    className="mt-2 inline-flex min-h-[44px] items-center justify-center rounded-xl bg-amber-400 px-4 py-2 text-sm font-semibold text-stone-950 transition active:scale-95"
                  >
                    ↻ Rejoin · Reanudar
                  </button>
                ) : null}
              </div>
            ) : null}
            {error ? (
              <div className="rounded-2xl border border-red-400/30 bg-red-400/10 p-3 text-sm text-red-200">
                {error}
              </div>
            ) : null}

            {/* Controls */}
            <div className="grid shrink-0 grid-cols-3 gap-2">
              <button type="button" onClick={toggleMic} className={btn(micMuted)}>
                {micMuted ? "🔇 Mic off" : "🎙️ Mic on"}
              </button>
              <button type="button" onClick={toggleCamera} className={btn(cameraOn)}>
                {cameraOn ? "📹 Cam on" : "📷 Cam off"}
              </button>
              {/* These two used to read "💬 Captions only" and "💬 Captions",
                  side by side, governing DIFFERENT things — the interpreter's
                  VOICE and the text panel. One of them turned captions off
                  and the other turned the voice off, and both looked like the
                  way to get captions. They no longer share a word or an icon. */}
              <button
                type="button"
                onClick={toggleVoice}
                className={btn(voiceOn)}
                title="The interpreter's spoken translation, in your ear."
              >
                {voiceOn ? "🗣️ Voice on" : "🔇 Voice off"}
              </button>
              <button
                type="button"
                onClick={() => setCaptionsOn((c) => !c)}
                className={btn(captionsOn)}
                title="The translated text on this screen."
              >
                {captionsOn ? "💬 Captions on" : "💬 Captions off"}
              </button>
              <button type="button" onClick={cycleVolume} className={`${btn(false)} col-span-2`}>
                {VOLUME_STEPS[volumeStep].label}
              </button>
            </div>
            <button
              type="button"
              onClick={endCall}
              className="shrink-0 rounded-2xl bg-red-500 px-4 py-3 text-base font-semibold text-stone-50 transition"
            >
              Hang up
            </button>

            {/* Everything below here is secondary — an explanation, a language
                change, a diagnostic trail — and it scrolls INSIDE this box.
                That is the guarantee: no amount of copy down here can push the
                captions or the controls off the bottom of a phone again, which
                is the whole of the 8/31 report. */}
            <div className="min-h-0 flex-[1_1_0%] space-y-3 overflow-y-auto">
            {/* Two voices, two controls, and until 8/28 nothing on the screen
                said which was which. */}
            <p className="text-[11px] leading-snug text-amber-100/40">
              {voiceOn
                ? "You hear the interpreter speaking their words in your language."
                : captionsOn
                  ? "The interpreter's voice is off — the captions above are still running."
                  : "The interpreter's voice is off AND captions are off, so nothing is being translated to you."}{" "}
              {VOLUME_STEPS[volumeStep].value === 0
                ? "Their own voice is muted underneath."
                : VOLUME_STEPS[volumeStep].value < 1
                  ? "Their own voice plays quietly underneath, so you can hear them talking."
                  : "Their own voice plays at full volume underneath."}
            </p>

            {/* Mid-call language change: re-points the live session and tells
                the partner's phone, without either of you rejoining.

                Captioned, which it was not until 9/3. The lobby row carries
                "They speak · Ellos hablan" and this one carried nothing, so
                mid-call the only thing saying what the two pill styles meant
                was a `title` — and a phone has no hover, so on the device
                where this row is actually used it said nothing at all. Tom
                read the outlined pill as the language he would hear and
                tapped it. Same caption as the lobby now, and the sentence
                under it spells out both sides in words rather than styling. */}
            <LanguagePillRow
              pills={pills}
              selected={theirs}
              paired={mine}
              pairedTitle="You hear this · Tú escuchas esto"
              pairedLocked={mineLocked}
              caption="They speak · Ellos hablan"
              sheetOpen={sheetOpen}
              onSelect={selectLanguage}
              onOpenSheet={() => setSheetOpen(true)}
            />
            <p className="-mt-2 text-xs text-amber-100/50">
              You hear <span className="text-amber-200">{languageLabel(mine)}</span> — the outlined
              pill, and it stays put while you are on a call. Tap another pill to change what your
              partner speaks.
            </p>

            {/* The connection trail, collapsed.
                Kept rather than removed once the 8/31 fix landed: "the call
                initiates and never connects" was un-diagnosable from a phone
                in another room, and the whole reason it took a code-reading
                session to find three separate causes. Closed by default so it
                costs a customer nothing if /call is ever promoted; open, it is
                the first thing to screenshot when a call misbehaves. Same
                lines go to the browser console under [taos-call-ice]. */}
            {trail.length > 0 ? (
              <details className="rounded-2xl border border-white/10 bg-white/5 p-3">
                <summary className="cursor-pointer text-xs text-amber-100/50">
                  Connection details · Detalles de conexión
                  {relayAvailable === false ? " — no relay" : ""}
                </summary>
                <div className="mt-2 space-y-1 text-[11px] text-amber-100/40">
                  <div>
                    relay available: {relayAvailable === null ? "…" : relayAvailable ? "yes" : "no"}
                    {transport ? ` · path: ${transport}` : ""}
                  </div>

                  {/* ── Per direction ───────────────────────────────────────
                      The 8/31 field report's second symptom: connected, and
                      audio one way only. Everything else on this panel was
                      true during that call — which is why "connected" and a
                      candidate pair were not enough, and these two lines are
                      here. A ✗ next to `receiving` is the complaint, before
                      anybody has to make it out loud. */}
                  {flow ? (
                    (() => {
                      const seconds = prevFlow ? (flow.at - prevFlow.at) / 1000 : 0;
                      return (
                        <>
                          <div>
                            audio{" "}
                            {flowLine(
                              "sending",
                              flow.audioPacketsSent,
                              prevFlow?.audioPacketsSent ?? null,
                              seconds
                            )}{" "}
                            ·{" "}
                            {flowLine(
                              "receiving",
                              flow.audioPacketsReceived,
                              prevFlow?.audioPacketsReceived ?? null,
                              seconds
                            )}
                          </div>
                          {flow.videoPacketsSent > 0 || flow.videoPacketsReceived > 0 ? (
                            <div>
                              video{" "}
                              {flowLine(
                                "sending",
                                flow.videoPacketsSent,
                                prevFlow?.videoPacketsSent ?? null,
                                seconds
                              )}{" "}
                              ·{" "}
                              {flowLine(
                                "receiving",
                                flow.videoPacketsReceived,
                                prevFlow?.videoPacketsReceived ?? null,
                                seconds
                              )}
                            </div>
                          ) : null}
                          <div>
                            pair: {flow.localCandidate ?? "?"}/{flow.remoteCandidate ?? "?"}
                            {flow.roundTripSeconds !== null
                              ? ` · rtt ${Math.round(flow.roundTripSeconds * 1000)}ms`
                              : ""}
                          </div>
                        </>
                      );
                    })()
                  ) : null}
                  <div className="max-h-40 overflow-y-auto font-mono">
                    {trail.map((line, i) => (
                      <div key={`${i}-${line}`}>{line}</div>
                    ))}
                  </div>
                </div>
              </details>
            ) : null}
            </div>
          </>
        )}

        <LanguageSheet
          open={sheetOpen}
          selected={theirs}
          paired={mine}
          pairedLabel="You hear this"
          pairedLocked={mineLocked}
          caption="What they speak · Lo que ellos hablan"
          onSelect={selectLanguage}
          onClose={() => setSheetOpen(false)}
        />
      </div>
    </main>
  );
}
