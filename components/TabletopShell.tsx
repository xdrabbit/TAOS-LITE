"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { startTabletopLive, type ActiveTabletopLive } from "@/lib/tabletop/live";
import type { TabletopDirection } from "@/lib/tabletop/instructions";
import { fetchWithRetry } from "@/lib/net";

// ── /tabletop: the phone lies flat between two people ───────────────────────
// Party mode. One phone on the table: the TOP half renders rotated 180° so it
// reads right-side-up for the person across the table; the BOTTOM half faces
// the phone's owner. One end is English, the other Spanish (swappable).
// Turn-taking is explicit, chess-style: TAP to start talking, TAP again when
// done. Two engines:
//  • "live" (default) — a persistent GA Realtime session translates the turn
//    AS THE PERSON SPEAKS: text streams onto the listener's pane phrase by
//    phrase (lib/tabletop/live.ts), and the whole turn is spoken aloud via
//    /api/tts when the turn ends.
//  • "classic" — the proven batch path: record the turn, then one
//    /api/translate round-trip. Fallback for flaky rooms.

type Lang = "en" | "es";
type Engine = "live" | "classic";
type TurnState =
  | { kind: "idle" }
  | { kind: "connecting"; side: Lang }
  | { kind: "recording"; side: Lang }
  | { kind: "processing"; side: Lang };

interface Exchange {
  /** Language the speaker used. */
  from: Lang;
  original: string;
  translation: string;
  at: number;
}

const MAX_TURN_SEC_CLASSIC = 60;
const MAX_TURN_SEC_LIVE = 120;

const L: Record<
  Lang,
  {
    label: string;
    tapToTalk: string;
    tapDone: string;
    listening: string;
    translating: string;
    connecting: string;
    theySaid: string;
    youSaid: string;
    idleHint: string;
  }
> = {
  en: {
    label: "English",
    tapToTalk: "TAP TO TALK",
    tapDone: "TAP WHEN DONE",
    listening: "Listening to the other side…",
    translating: "Translating…",
    connecting: "Connecting…",
    theySaid: "They said",
    youSaid: "You said",
    idleHint: "Lay the phone flat between you"
  },
  es: {
    label: "Español",
    tapToTalk: "TOCA PARA HABLAR",
    tapDone: "TOCA AL TERMINAR",
    listening: "Escuchando al otro lado…",
    translating: "Traduciendo…",
    connecting: "Conectando…",
    theySaid: "Dijo",
    youSaid: "Dijiste",
    idleHint: "Pon el teléfono entre ustedes"
  }
};

function pickRecordingMime(): string {
  if (typeof MediaRecorder === "undefined") return "";
  for (const m of ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"]) {
    if (MediaRecorder.isTypeSupported(m)) return m;
  }
  return "";
}

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

export function TabletopShell(): JSX.Element {
  // Which language faces the TOP (rotated) end; the bottom end is the other.
  const [topLang, setTopLang] = useState<Lang>("es");
  const [engine, setEngine] = useState<Engine>("live");
  const [turn, setTurn] = useState<TurnState>({ kind: "idle" });
  const [voiceOn, setVoiceOn] = useState(true);
  const [recordSec, setRecordSec] = useState(0);
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  // Live-engine streaming text for the CURRENT turn.
  const [liveHeard, setLiveHeard] = useState("");
  const [liveTranslation, setLiveTranslation] = useState("");
  const [error, setError] = useState<string | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const timerRef = useRef<number | null>(null);
  const cancelledRef = useRef(false);
  const playerRef = useRef<HTMLAudioElement | null>(null);
  const wakeLockRef = useRef<ScreenWakeSentinel | null>(null);
  const voiceOnRef = useRef(true);
  const liveRef = useRef<ActiveTabletopLive | null>(null);
  const turnRef = useRef<TurnState>({ kind: "idle" });

  useEffect(() => {
    turnRef.current = turn;
  }, [turn]);

  useEffect(() => {
    voiceOnRef.current = voiceOn;
    if (!voiceOn) {
      playerRef.current?.pause();
      playerRef.current = null;
    }
  }, [voiceOn]);

  // Wake lock while the page is open — a tabletop session dies if the screen
  // sleeps. Re-acquired when the tab becomes visible again (same as /live).
  useEffect(() => {
    const acquire = () => {
      getWakeLock()
        ?.request("screen")
        .then((s) => {
          wakeLockRef.current = s;
        })
        .catch(() => {});
    };
    acquire();
    const onVisible = () => {
      if (document.visibilityState === "visible") acquire();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      document.removeEventListener("visibilitychange", onVisible);
      void wakeLockRef.current?.release().catch(() => {});
      wakeLockRef.current = null;
    };
  }, []);

  const startTimer = useCallback((capSec: number) => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    setRecordSec(0);
    timerRef.current = window.setInterval(() => {
      setRecordSec((s) => s + 1);
    }, 1000);
    void capSec; // cap handled by the effect below so it sees fresh state
  }, []);

  const stopTimer = useCallback(() => {
    if (timerRef.current !== null) window.clearInterval(timerRef.current);
    timerRef.current = null;
    setRecordSec(0);
  }, []);

  const cleanupRecording = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    recorderRef.current = null;
    chunksRef.current = [];
    stopTimer();
  }, [stopTimer]);

  useEffect(() => {
    return () => {
      cleanupRecording();
      liveRef.current?.stop();
      liveRef.current = null;
    };
  }, [cleanupRecording]);

  const speak = useCallback(async (ex: Exchange) => {
    if (!voiceOnRef.current || !ex.translation) return;
    try {
      const res = await fetchWithRetry(
        "/api/tts",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: ex.translation,
            sourceLanguage: ex.from,
            targetLanguage: ex.from === "en" ? "es" : "en",
            // Tabletop pairing is the reverse of the shared voice-follows-speaker
            // mapping: spoken Spanish reads out in Tom's voice, spoken English
            // in Liz's.
            voice: ex.from === "es" ? "tom" : "liz"
          })
        },
        { retries: 1, timeoutMs: 30000 }
      );
      if (!res.ok) return;
      const url = URL.createObjectURL(await res.blob());
      playerRef.current?.pause();
      const el = new Audio(url);
      playerRef.current = el;
      el.onended = () => {
        URL.revokeObjectURL(url);
        if (playerRef.current === el) playerRef.current = null;
      };
      await el.play();
    } catch {
      /* voice is best-effort; the text is already on screen */
    }
  }, []);

  const pushExchange = useCallback(
    (ex: Exchange) => {
      setExchanges((prev) => [...prev.slice(-19), ex]);
      void speak(ex);
    },
    [speak]
  );

  // ── Live engine ───────────────────────────────────────────────────────────

  const startLiveTurn = useCallback(
    async (side: Lang) => {
      setError(null);
      playerRef.current?.pause();
      playerRef.current = null;
      setLiveHeard("");
      setLiveTranslation("");
      const direction: TabletopDirection = side === "en" ? "en-es" : "es-en";
      try {
        if (!liveRef.current) {
          setTurn({ kind: "connecting", side });
          liveRef.current = await startTabletopLive({
            onError: (msg) => setError(msg),
            onState: (s) => {
              // The session auto-disconnects after long idle; reflect nothing
              // in the UI unless a turn is active (next tap reconnects).
              if (s === "idle") liveRef.current = null;
            },
            onHeard: (text) => setLiveHeard(text),
            onTranslationDelta: (d) => setLiveTranslation((t) => t + d)
          });
        }
        if (!liveRef.current.beginTurn(direction)) {
          // Session went stale (e.g. idle disconnect raced us) — drop it so
          // the next tap reconnects fresh.
          liveRef.current.stop();
          liveRef.current = null;
          setTurn({ kind: "idle" });
          return;
        }
        setTurn({ kind: "recording", side });
        startTimer(MAX_TURN_SEC_LIVE);
      } catch {
        liveRef.current = null;
        setTurn({ kind: "idle" });
        stopTimer();
        setError((prev) => prev ?? "Live mode failed — try classic mode.");
      }
    },
    [startTimer, stopTimer]
  );

  const endLiveTurn = useCallback(
    async (side: Lang) => {
      const session = liveRef.current;
      if (!session) {
        setTurn({ kind: "idle" });
        return;
      }
      setTurn({ kind: "processing", side });
      stopTimer();
      try {
        const result = await session.endTurn();
        if (result.translation || result.heard) {
          pushExchange({
            from: side,
            original: result.heard,
            translation: result.translation,
            at: Date.now()
          });
        }
      } finally {
        setLiveHeard("");
        setLiveTranslation("");
        setTurn({ kind: "idle" });
      }
    },
    [stopTimer, pushExchange]
  );

  // ── Classic engine (batch /api/translate) ─────────────────────────────────

  const finishClassicTurn = useCallback(
    async (side: Lang, blob: Blob) => {
      setTurn({ kind: "processing", side });
      try {
        const form = new FormData();
        form.append("audio", new File([blob], "turn", { type: blob.type || "audio/webm" }));
        form.append("sourceLanguage", side);
        form.append("targetLanguage", side === "en" ? "es" : "en");
        form.append("tone", "casual");
        const res = await fetch("/api/translate", { method: "POST", body: form });
        const payload = (await res.json().catch(() => ({}))) as {
          original?: string;
          translation?: string;
          error?: string;
        };
        if (!res.ok || !payload.translation) {
          throw new Error(payload.error || "Translation failed. Try again.");
        }
        setError(null);
        pushExchange({
          from: side,
          original: payload.original ?? "",
          translation: payload.translation,
          at: Date.now()
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Translation failed. Try again.");
      } finally {
        setTurn({ kind: "idle" });
      }
    },
    [pushExchange]
  );

  const startClassicTurn = useCallback(
    async (side: Lang) => {
      setError(null);
      playerRef.current?.pause();
      playerRef.current = null;
      try {
        if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
          throw new Error("Recording is not supported in this browser.");
        }
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        const mime = pickRecordingMime();
        const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        streamRef.current = stream;
        recorderRef.current = recorder;
        chunksRef.current = [];
        cancelledRef.current = false;
        const startedAt = performance.now();

        recorder.ondataavailable = (ev) => {
          if (ev.data.size > 0) chunksRef.current.push(ev.data);
        };
        recorder.onstop = () => {
          const chunks = chunksRef.current;
          const type = recorder.mimeType || mime || "audio/webm";
          const cancelled = cancelledRef.current;
          cleanupRecording();
          // A sub-second turn is an accidental double-tap: the clip has no
          // usable speech (the shortest ones get rejected upstream as
          // corrupted), so drop it quietly instead of erroring at the party.
          if (cancelled || !chunks.length || performance.now() - startedAt < 600) {
            setTurn({ kind: "idle" });
            return;
          }
          void finishClassicTurn(side, new Blob(chunks, { type }));
        };

        recorder.start(250);
        setTurn({ kind: "recording", side });
        startTimer(MAX_TURN_SEC_CLASSIC);
      } catch (e) {
        cleanupRecording();
        setTurn({ kind: "idle" });
        setError(
          e instanceof Error && e.name === "NotAllowedError"
            ? "Microphone access was denied."
            : e instanceof Error
              ? e.message
              : "Could not start recording."
        );
      }
    },
    [cleanupRecording, finishClassicTurn, startTimer]
  );

  // Turn caps, engine-appropriate.
  useEffect(() => {
    if (turn.kind !== "recording") return;
    const cap = engine === "live" ? MAX_TURN_SEC_LIVE : MAX_TURN_SEC_CLASSIC;
    if (recordSec < cap) return;
    if (engine === "live") void endLiveTurn(turn.side);
    else recorderRef.current?.stop();
  }, [recordSec, turn, engine, endLiveTurn]);

  const tap = useCallback(
    (side: Lang) => {
      const t = turnRef.current;
      if (t.kind === "idle") {
        if (engine === "live") void startLiveTurn(side);
        else void startClassicTurn(side);
      } else if (t.kind === "recording" && t.side === side) {
        if (engine === "live") void endLiveTurn(side);
        else {
          cancelledRef.current = false;
          recorderRef.current?.stop();
        }
      }
    },
    [engine, startLiveTurn, startClassicTurn, endLiveTurn]
  );

  const switchEngine = useCallback(() => {
    if (turnRef.current.kind !== "idle") return;
    setEngine((e) => {
      if (e === "live") {
        liveRef.current?.stop();
        liveRef.current = null;
        return "classic";
      }
      return "live";
    });
  }, []);

  // Latest lines relevant to a pane, in ITS language.
  const paneLines = useCallback(
    (lang: Lang): { theirs: Exchange | null; mine: Exchange | null } => {
      const theirs = [...exchanges].reverse().find((e) => e.from !== lang) ?? null;
      const mine = [...exchanges].reverse().find((e) => e.from === lang) ?? null;
      return { theirs, mine };
    },
    [exchanges]
  );

  const renderPane = (lang: Lang, rotated: boolean): JSX.Element => {
    const t = L[lang];
    const { theirs, mine } = paneLines(lang);
    const isConnecting = turn.kind === "connecting" && turn.side === lang;
    const isRecording = turn.kind === "recording" && turn.side === lang;
    const isProcessing = turn.kind === "processing" && turn.side === lang;
    const otherBusy = turn.kind !== "idle" && turn.side !== lang;
    // Live streaming: while the OTHER side talks, this pane streams the
    // translation as it is generated.
    const streamingIn = engine === "live" && otherBusy && liveTranslation;
    const cap = engine === "live" ? MAX_TURN_SEC_LIVE : MAX_TURN_SEC_CLASSIC;

    return (
      <section
        className={`flex flex-1 flex-col gap-2 overflow-hidden p-4 ${rotated ? "rotate-180" : ""}`}
      >
        <div className="flex items-center justify-between">
          <span className="text-xs uppercase tracking-[0.25em] text-amber-100/50">{t.label}</span>
          {isRecording ? (
            <span className="flex items-center gap-2 text-xs text-red-300">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-red-400" />
              {recordSec}s / {cap}s
            </span>
          ) : null}
        </div>

        {/* What the other person said (or is saying), in MY language. */}
        <div className="flex-1 overflow-y-auto">
          {streamingIn ? (
            <>
              <div className="text-[11px] uppercase tracking-widest text-emerald-300/70">
                {t.theySaid} · live
              </div>
              <div className="mt-1 text-2xl font-medium leading-snug text-amber-50">
                {liveTranslation}
                <span className="animate-pulse text-emerald-300">▍</span>
              </div>
            </>
          ) : theirs ? (
            <>
              <div className="text-[11px] uppercase tracking-widest text-amber-100/40">
                {t.theySaid}
              </div>
              <div className="mt-1 text-2xl font-medium leading-snug text-amber-50">
                {theirs.translation}
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center text-center text-sm text-amber-100/30">
              {t.idleHint}
            </div>
          )}
          {isRecording && engine === "live" && liveHeard ? (
            <div className="mt-3 border-t border-white/10 pt-2">
              <div className="text-[11px] uppercase tracking-widest text-amber-100/30">
                {t.youSaid}
              </div>
              <div className="text-sm text-amber-100/60">{liveHeard}</div>
            </div>
          ) : !streamingIn && mine ? (
            <div className="mt-3 border-t border-white/10 pt-2">
              <div className="text-[11px] uppercase tracking-widest text-amber-100/30">
                {t.youSaid}
              </div>
              <div className="text-sm text-amber-100/60">{mine.original}</div>
            </div>
          ) : null}
        </div>

        <button
          type="button"
          onClick={() => tap(lang)}
          disabled={otherBusy || isProcessing || isConnecting}
          className={`rounded-2xl px-4 py-5 text-lg font-bold tracking-wide transition ${
            isRecording
              ? "animate-pulse bg-red-500 text-stone-50"
              : isProcessing || isConnecting
                ? "bg-white/10 text-amber-100/60"
                : otherBusy
                  ? "bg-white/5 text-amber-100/30"
                  : "bg-emerald-400 text-stone-950"
          }`}
        >
          {isConnecting
            ? t.connecting
            : isRecording
              ? t.tapDone
              : isProcessing
                ? t.translating
                : otherBusy
                  ? t.listening
                  : t.tapToTalk}
        </button>
      </section>
    );
  };

  const bottomLang: Lang = topLang === "en" ? "es" : "en";

  return (
    <main className="flex h-[100dvh] flex-col overflow-hidden">
      {renderPane(topLang, true)}

      {/* Middle bar — readable from the bottom end (the phone owner). */}
      <div className="flex items-center justify-center gap-2 border-y border-white/10 bg-white/5 px-3 py-1.5">
        <a href="/" className="rounded-full px-2 py-1 text-xs text-amber-100/50">
          ← TAOS
        </a>
        <button
          type="button"
          onClick={() => setTopLang((l) => (l === "en" ? "es" : "en"))}
          disabled={turn.kind !== "idle"}
          className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-amber-100/70 disabled:opacity-40"
        >
          ⇅ swap ends
        </button>
        <button
          type="button"
          onClick={switchEngine}
          disabled={turn.kind !== "idle"}
          className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-amber-100/70 disabled:opacity-40"
        >
          {engine === "live" ? "⚡ live" : "📼 classic"}
        </button>
        <button
          type="button"
          onClick={() => setVoiceOn((v) => !v)}
          className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-xs text-amber-100/70"
        >
          {voiceOn ? "🔊 voice on" : "🔇 voice off"}
        </button>
        {error ? <span className="max-w-[40%] truncate text-xs text-red-300">{error}</span> : null}
      </div>

      {renderPane(bottomLang, false)}
    </main>
  );
}
